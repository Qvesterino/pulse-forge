import type { EffectType } from "../project-model/types";
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import {
  addEffectWithLandingCommand,
  applyProductionIntentToTrackCommand,
  snapshot,
  trackEffectsOf,
} from "../commands/commands";
import { applyEffectIntentProposal } from "../effect-intent/apply";
import { planEffectIntent } from "../effect-intent/planner";
import { EFFECT_INTENT_PILOT_TYPES, effectIntentMappingsForGoal } from "../effect-intent/capabilities";
import { parseEffectIntent } from "../effect-intent/parser";
import type { EffectIntentSpec } from "../effect-intent/types";
import { parseProductionIntent } from "../intent/production";
import { roleOfTrack, rolePresetFor } from "../effects/role-presets";

/**
 * WAVE D — one text entry at the track: run the ASSISTANT's effect-intent
 * (SK/EN goal language: "teplejšie", "more space") against ONE track.
 *
 * Unlike the per-device assistant (which tunes an EXISTING device), this
 * path resolves the best device for the parsed goals itself: it prefers a
 * pilot-capable device already on the track (best goal coverage, first in
 * pilot order as the deterministic tie-break) and otherwise ADDS the best
 * candidate — landed with the track's role preset (Wave B) — before the
 * planner tunes it. Add + tune + apply compose into ONE undoable snapshot.
 *
 * Lives at the UI-glue layer: it composes existing commands and the
 * assistant's pure plan/apply pipeline; no new engine surface.
 */
export function applyEffectIntentOnTrack(doc: ProjectDocument, trackId: string, intent: EffectIntentSpec): Command {
  const goals = [...new Set(intent.goals.map((goal) => goal.goal))];

  // Pilot-capable devices, best goal coverage first (stable pilot order on ties).
  const scored = EFFECT_INTENT_PILOT_TYPES.map((type) => ({
    type,
    covered: goals.filter((goal) => effectIntentMappingsForGoal(type, goal).length > 0).length,
  }))
    .filter((candidate) => candidate.covered > 0)
    .sort((a, b) => b.covered - a.covered);
  if (scored.length === 0) {
    throw new Error(`Assistant goals (${goals.join(", ")}) have no supported device — pick one from the grid`);
  }

  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track not found`);

  const effects = trackEffectsOf(doc, trackId);
  let target: { trackId: string; fxId: string; effectType: EffectType } | null = null;
  let working = doc;
  let deviceAdded = false;
  for (const candidate of scored) {
    const existing = effects.find((fx) => fx.type === candidate.type);
    if (existing) {
      target = { trackId, fxId: existing.id, effectType: existing.type };
      break;
    }
  }
  if (!target) {
    const type = scored[0].type;
    const landing = rolePresetFor(type, roleOfTrack(track));
    const add = addEffectWithLandingCommand(doc, trackId, type, landing ?? {});
    working = add.execute(doc);
    const created = trackEffectsOf(working, trackId).find((fx) => fx.type === type);
    if (!created) throw new Error(`Could not add a device for goals (${goals.join(", ")})`);
    target = { trackId, fxId: created.id, effectType: type };
    deviceAdded = true;
  }

  const plan = planEffectIntent(working, target, intent);
  if (plan.status !== "ready") {
    throw new Error(plan.diagnostics.join(" ") || "Assistant could not build a proposal for this track");
  }
  const next = applyEffectIntentProposal(working, plan.proposal).execute(working);
  const via = deviceAdded ? " — device added" : "";
  return snapshot("applyEffectIntentOnTrack", `FX assistant: ${plan.proposal.summary}${via}`, doc, next);
}

/**
 * FX INTENT BAR routing (the persistent idea input in the rack header).
 *
 * One text field, the two existing interpreters in a fixed precedence:
 *
 *   1. ASSISTANT — `parseEffectIntent` (goal language: "teplejšie", "more
 *      space"): finds or adds the best device on THIS track and tunes it
 *      through their plan/apply pipeline. Preferred because it lands
 *      precise, reviewable parameter values.
 *   2. PRODUCTION — `parseProductionIntent` (concept language: "wobbly",
 *      "deeper bass"): the concept planner scoped to this track. Covers the
 *      concepts the assistant catalog has no mapping for (and vice versa).
 *
 * Everything composes into ONE undoable command before it ever touches the
 * store — the caller just executes it. Pure glue: no engine surface.
 */
export type FxIdeaOutcome =
  | { kind: "command"; command: Command; interpreter: "assistant" | "production"; summary: string }
  | { kind: "unparsed"; message: string };

const FX_IDEA_TOO_SHORT = "Napíš aspoň pár znakov — napr. „teplejšie“, „more space“, „wobbly bass“.";
const FX_IDEA_HINT =
  "Nerozumel som tejto formulácii. Skús slová ako teplejšie / hlbšie / viac priestoru / wobbly — alebo pridaj device ručne cez ✚ ADD FX.";

export function applyFxIdea(doc: ProjectDocument, trackId: string, text: string): FxIdeaOutcome {
  const trimmed = text.trim();
  if (trimmed.length < 3) return { kind: "unparsed", message: FX_IDEA_TOO_SHORT };

  let assistantError: string | null = null;
  const assistant = parseEffectIntent(trimmed);
  if (assistant.status === "ready") {
    try {
      const command = applyEffectIntentOnTrack(doc, trackId, assistant.intent);
      // The command label carries the plan summary ("FX assistant: …").
      return { kind: "command", command, interpreter: "assistant", summary: command.label };
    } catch (error) {
      // Goals understood but no device can carry them on this track — the
      // production interpreter may still know what to do with the sentence.
      assistantError = error instanceof Error ? error.message : String(error);
    }
  }

  const production = parseProductionIntent(trimmed);
  if (production) {
    const concepts = [...new Set(production.goals.map((goal) => goal.concept))].join(" + ");
    return {
      kind: "command",
      command: applyProductionIntentToTrackCommand(doc, trackId, production),
      interpreter: "production",
      summary: `♪ ${concepts} — production plan na tomto tracku`,
    };
  }

  const diagnostics = assistant.status !== "ready" ? assistant.diagnostics.join(" ") : "";
  return { kind: "unparsed", message: [assistantError, diagnostics].filter(Boolean).join(" ") || FX_IDEA_HINT };
}
