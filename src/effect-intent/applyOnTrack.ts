import type { EffectType, ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { addEffectWithLandingCommand, snapshot, trackEffectsOf } from "../commands/commands";
import { applyEffectIntentProposal } from "./apply";
import { planEffectIntent } from "./planner";
import { EFFECT_INTENT_PILOT_TYPES, effectIntentMappingsForGoal } from "./capabilities";
import type { EffectIntentSpec } from "./types";
import { roleOfTrack, rolePresetFor } from "../effects/role-presets";

/**
 * EFFECT INTENT ON TRACK — resolve the assistant's goal language ("teplejšie",
 * "more space") against ONE track and return the command that lands it.
 *
 * Unlike the per-device assistant (which tunes an EXISTING device), this
 * path resolves the best device for the parsed goals itself: it prefers a
 * pilot-capable device already on the track (best goal coverage, first in
 * pilot order as the deterministic tie-break) and otherwise ADDS the best
 * candidate — landed with the track's role preset — before the planner tunes
 * it. Add + tune + apply compose into ONE undoable snapshot.
 *
 * It composes existing commands and the assistant's pure plan/apply
 * pipeline; no new engine surface.
 *
 * WHY IT LIVES HERE AND NOT IN THE UI: the MCP layer routes the same
 * assistant intent from a text command (kyx_mix_idea), and the architecture
 * layer gate forbids `src/mcp` from importing `src/ui` — a pure command
 * builder has no business in a UI module. The UI keeps re-exporting it, so
 * the component-facing import path is unchanged.
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
