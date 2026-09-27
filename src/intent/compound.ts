import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { snapshot } from "../commands/commands";
import {
  applyFaderIntents,
  applyTempoIntent,
  parseFaderIntent,
  parseTempoIntent,
  splitIntentClauses,
  type FaderIntent,
  type TempoIntent,
} from "./conversation";
import { applyEffectIntent, parseEffectIntent, type EffectIntent } from "./mix";

/**
 * CROSS-EXECUTOR COMPOUND INTENTS — several asks in one sentence, executed in
 * ONE undoable command ("zníž tempo a zvýš lead", "viac delayu na leade a
 * zníž basu").
 *
 * Bounded to the three cheap, synchronous, command-emitting conversation
 * executors: FADER (track/pad/master gain), TEMPO (project BPM) and targeted
 * EFFECT (primary knob add/turn). Each CLAUSE must parse on its own — the
 * compound is all-or-nothing, so a half-understood sentence never silently
 * drops the clause it did not understand. All-tempo compounds are excluded:
 * tempo clauses all mutate the SAME scalar, and "tempo na 128 a pomalší"
 * chains into 122 instead of the asked 128 — the whole-text tempo route's
 * first-match-wins stays the honest reading there.
 */

export type CompoundPart =
  | { kind: "fader"; intent: FaderIntent }
  | { kind: "tempo"; intent: TempoIntent }
  | { kind: "effect"; intent: EffectIntent };

function parseCompoundClause(clause: string): CompoundPart | null {
  const fader = parseFaderIntent(clause);
  if (fader) return { kind: "fader", intent: fader };
  const tempo = parseTempoIntent(clause);
  if (tempo) return { kind: "tempo", intent: tempo };
  const effect = parseEffectIntent(clause);
  if (effect) return { kind: "effect", intent: effect };
  return null;
}

/**
 * Parse a multi-clause compound ask. Null unless there are ≥2 clauses and
 * EVERY clause resolves to a compoundable part and they are not all tempo.
 */
export function parseCompoundIntent(text: string): CompoundPart[] | null {
  const clauses = splitIntentClauses(text);
  if (clauses.length < 2) return null;
  const parts: CompoundPart[] = [];
  for (const clause of clauses) {
    const part = parseCompoundClause(clause);
    if (!part) return null; // all-or-nothing: no silent partial compound
    parts.push(part);
  }
  if (parts.every((part) => part.kind === "tempo")) return null;
  return parts;
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
