/**
 * INTENT MUTATION BOUNDARY — the ONE place that tells the prior-adjustment
 * ledger what just happened.
 *
 * Before this module the rule was implemented at every call site: the UI
 * cleared on non-recordable routes and recorded after three branches, the MCP
 * executor repeated the same switch, `kyx_undo` cleared separately, and the
 * MCP tool wrapper cleared for every other mutation. A new route or tool could
 * silently skip one of those copies and leave a stale "last time" pointing at
 * a change that is no longer the last one.
 *
 * The classification is a Record over EVERY RoutedIntent kind, so adding a new
 * route is a compile error until its ledger effect is declared. The rule:
 *
 *   fader        → record the measured relative move
 *   effectIntent → clear (outside the fader-only ledger's replay vocabulary)
 *   paramIntent  → clear (same)
 *   other        → clear (a different mutation supersedes the remembered move)
 *   none         → keep (no document mutation: clarify/query/transport/select…)
 *
 * `noteAppliedRoute` is called only when the document identity actually
 * changed, so a no-op command cannot erase a valid reference. Undo/redo and
 * non-intent mutations have their own entry points.
 */
import type { ProjectDocument } from "../project-model/types";
import type { RoutedIntent } from "./route";
import {
  clearAdjustmentLedger,
  recordEffectAdjustment,
  recordFaderAdjustment,
  recordParamAdjustment,
} from "./adjustment-recording";

export type AdjustmentKind = "fader" | "effect" | "param" | "other" | "none";

/**
 * Every route kind, classified. The Record is deliberate: a new kind in the
 * RoutedIntent union fails typecheck here until someone decides whether it
 * invalidates, records, or leaves the remembered move alone.
 */
export const ROUTE_ADJUSTMENT: Readonly<Record<RoutedIntent["kind"], AdjustmentKind>> = {
  fader: "fader",
  effectIntent: "effect",
  paramIntent: "param",

  // No document mutation — the remembered move is still the last one.
  clarify: "none",
  queryIntent: "none",
  automationPlan: "none",
  complaintIntent: "none",
  transport: "none",
  select: "none",
  save: "none",
  export: "none",
  record: "none",
  checkpointIntent: "none",
  presetUnknown: "none",

  // A different mutation (or a generation) supersedes the remembered move.
  arrange: "other",
  clips: "other",
  exact: "other",
  compound: "other",
  undoIntent: "other",
  grooveIntent: "other",
  sectionGrooveIntent: "other",
  automateIntent: "other",
  markerIntent: "other",
  stepEditIntent: "other",
  selectedStepAssist: "other",
  selectedClipArrange: "other",
  selectedRangeArrange: "other",
  soundSwapIntent: "other",
  sceneIntensity: "other",
  preset: "other",
  sendIntent: "other",
  bypassIntent: "other",
  tempo: "other",
  loudness: "other",
  production: "other",
  mix: "other",
  sectionFlow: "other",
  sectionTransition: "other",
  sectionProduction: "other",
  revise: "other",
  pattern: "other",
};

/**
 * Report a route that executed against a CHANGED document. Callers pass the
 * before/after documents; the recorder measures what actually landed.
 */
export function noteAppliedRoute(route: RoutedIntent, before: ProjectDocument, after: ProjectDocument): void {
  if (route.kind === "fader") {
    recordFaderAdjustment(before.id, route.intent, before, after);
    return;
  }
  if (route.kind === "effectIntent") {
    recordEffectAdjustment(before.id, route.intent, before, after);
    return;
  }
  if (route.kind === "paramIntent") {
    recordParamAdjustment(before.id, route.intent, before, after);
    return;
  }
  if (ROUTE_ADJUSTMENT[route.kind] === "none") return;
  clearAdjustmentLedger();
}

/** Undo/redo invalidates only when it actually moved the document. */
export function noteUndoRedo(stepsUndone: number): void {
  if (stepsUndone > 0) clearAdjustmentLedger();
}

/** A mutation that did not come through the routed-intent executor. */
export function noteExternalMutation(): void {
  clearAdjustmentLedger();
}
