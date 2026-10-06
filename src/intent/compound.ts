import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { snapshot } from "../commands/commands";
import { applyExactIntentCommand, exactReadback } from "../commands/intentRouting";
import {
  applyFaderIntents,
  applyTempoIntent,
  faderReadback,
  parseFaderIntent,
  parseTempoIntent,
  splitIntentClauses,
  type FaderIntent,
  type TempoIntent,
} from "./conversation";
import {
  applyBypassIntent,
  applyEffectIntent,
  applySendIntent,
  bypassReadback,
  effectReadback,
  parseBypassIntent,
  parseEffectIntent,
  parseSendIntent,
  sendReadback,
  type BypassIntent,
  type EffectIntent,
  type SendIntent,
} from "./mix";
import { parseExactIntent, type ExactIntentPlan } from "./exact";
import { applyPresetIntentCommand, parsePresetIntent, presetReadback, type PresetIntent } from "./preset-intent";

/**
 * CROSS-EXECUTOR COMPOUND INTENTS — several asks in one sentence, executed in
 * ONE undoable command ("zníž tempo a zvýš lead", "viac delayu na leade a
 * zníž basu", "mute the drums and zníž basu").
 *
 * Bounded to the cheap, synchronous, command-emitting executors: FADER
 * (track/pad/master gain), TEMPO (project BPM), targeted EFFECT (primary
 * knob add/turn) and EXACT (single-op doc commands — mute/pan/tempo/track
 * CRUD). Each CLAUSE must parse on its own — the compound is all-or-nothing,
 * so a half-understood sentence never silently drops the clause it did not
 * understand. All-tempo compounds are excluded: tempo clauses all mutate the
 * SAME scalar, and "tempo na 128 a pomalší" chains into 122 instead of the
 * asked 128 — the whole-text tempo route's first-match-wins stays the
 * honest reading there.
 */

export type CompoundPart =
  | { kind: "fader"; intent: FaderIntent }
  | { kind: "tempo"; intent: TempoIntent }
  | { kind: "effect"; intent: EffectIntent }
  | { kind: "send"; intent: SendIntent }
  | { kind: "bypass"; intent: BypassIntent }
  | { kind: "exact"; plan: ExactIntentPlan }
  | { kind: "preset"; intent: PresetIntent };

function parseCompoundClause(clause: string): CompoundPart | null {
  const fader = parseFaderIntent(clause);
  if (fader) return { kind: "fader", intent: fader };
  const tempo = parseTempoIntent(clause);
  if (tempo) return { kind: "tempo", intent: tempo };
  // send/bypass BEFORE the greedy effect parse — "more reverb send on the
  // lead" is a send-level ask, not a return-mix knob ask.
  const send = parseSendIntent(clause);
  if (send) return { kind: "send", intent: send };
  const bypass = parseBypassIntent(clause);
  if (bypass) return { kind: "bypass", intent: bypass };
  const effect = parseEffectIntent(clause);
  if (effect) return { kind: "effect", intent: effect };
  const exact = parseExactIntent(clause);
  if (exact) return { kind: "exact", plan: exact };
  const preset = parsePresetIntent(clause);
  if (preset?.ok) return { kind: "preset", intent: preset.intent };
  return null;
}

/**
 * Parse a multi-clause compound ask. Null unless there are ≥2 clauses and
 * EVERY clause resolves to a compoundable part and they are not all tempo.
 *
 * Two split strategies, tried in order: the full clause split (includes the
 * SK conjunction "a") and a strong-delimiter split that never cuts on the
 * ARTICLE "a" — "add a keys track and zníž basu" must not become "add" +
 * "keys track" + "zníž basu". The first strategy that fully parses wins.
 */
const STRONG_SPLIT = /\s+(?:and|alebo|but|potom)\s+|,\s*|\s*;\s*/i;

export function parseCompoundIntent(text: string): CompoundPart[] | null {
  const strategies: string[][] = [
    splitIntentClauses(text),
    text
      .split(STRONG_SPLIT)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0),
  ];
  for (const clauses of strategies) {
    if (clauses.length < 2) continue;
    const parts: CompoundPart[] = [];
    let allParsed = true;
    for (const clause of clauses) {
      const part = parseCompoundClause(clause);
      if (!part) {
        allParsed = false;
        break;
      }
      parts.push(part);
    }
    if (allParsed && parts.length >= 2 && !parts.every((part) => part.kind === "tempo")) return parts;
  }
  return null;
}

/**
 * Execute compound parts against a cursor and wrap the result in ONE
 * snapshot — one Ctrl+Z undoes the whole sentence. A clause whose ask is
 * already satisfied ("changed nothing") is skipped honestly; a real clause
 * failure (no matching track, unknown effect) fails the whole compound with
 * that error. Returns null when every clause was a no-op.
 */
export function applyCompoundIntent(doc: ProjectDocument, parts: CompoundPart[]): Command | null {
  let next = doc;
  const labels: string[] = [];
  for (const part of parts) {
    try {
      const command =
        part.kind === "fader"
          ? applyFaderIntents(next, [part.intent])
          : part.kind === "tempo"
            ? applyTempoIntent(next, part.intent)
            : part.kind === "exact"
              ? applyExactIntentCommand(next, part.plan)
              : part.kind === "preset"
                ? applyPresetIntentCommand(next, part.intent)
                : part.kind === "send"
                  ? applySendIntent(next, part.intent)
                  : part.kind === "bypass"
                    ? applyBypassIntent(next, part.intent)
                    : applyEffectIntent(next, part.intent);
      if (!command) continue; // fader clause clamped to a no-op
      next = command.execute(next);
      labels.push(command.label);
    } catch (err) {
      if (!(err instanceof Error && /changed nothing/.test(err.message))) throw err;
      // the clause's ask is already satisfied — skip, keep the rest
    }
  }
  if (labels.length === 0) return null;
  return snapshot("applyCompoundIntent", labels.join(" · "), doc, next);
}

/**
 * VERIFICATION READ-BACK for compounds — one verified entry per part
 * (fader gains, effect knob landings, preset ✓, exact state), all read from
 * the post-execution document. Tempo parts report the bpm move.
 */
export function compoundReadback(before: ProjectDocument, after: ProjectDocument, parts: CompoundPart[]): string {
  const entries: string[] = [];
  for (const part of parts) {
    if (part.kind === "fader") {
      const entry = faderReadback(before, after, part.intent);
      if (entry) entries.push(entry);
    } else if (part.kind === "tempo") {
      if (before.bpm !== after.bpm) entries.push(`bpm ${before.bpm}→${after.bpm}`);
    } else if (part.kind === "effect") {
      const entry = effectReadback(before, after, part.intent);
      if (entry) entries.push(entry);
    } else if (part.kind === "preset") {
      const entry = presetReadback(after, part.intent);
      if (entry) entries.push(entry);
    } else if (part.kind === "send") {
      const entry = sendReadback(after, part.intent);
      if (entry) entries.push(entry);
    } else if (part.kind === "bypass") {
      const entry = bypassReadback(after, part.intent);
      if (entry) entries.push(entry);
    } else {
      const entry = exactReadback(before, after, part.plan);
      if (entry) entries.push(entry);
    }
  }
  if (entries.length > 4) return `${entries.slice(0, 4).join(" · ")} +${entries.length - 4}`;
  return entries.join(" · ");
}
