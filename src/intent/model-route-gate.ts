/**
 * MODEL ROUTE GATE — the deterministic layer has the last word.
 *
 * The local intent model is a fallback for sentences the rules do not know.
 * It may propose a route, but it may not:
 *
 *   - overrule a specific deterministic route;
 *   - turn a DESCRIPTION into a mutation;
 *   - propose a mutation that has no executable, non-empty plan;
 *   - choose generation when the deterministic layer asked for a question.
 *
 * This is deliberately a gate, not a second router: it calls the real router
 * and the real plan builder. A model output that cannot produce a verified
 * plan is rejected, and the caller keeps the deterministic clarify/refusal.
 */
import type { ProjectDocument } from "../project-model/types";
import type { RoutedIntent } from "./route";
import { routeIntentText } from "./route";
import { planIntent } from "./semantics/intent-plan";
import { isDescriptiveStatement } from "./declarative";

/** Route kinds that change the project and therefore need a plan. */
const MUTATION_KINDS: ReadonlySet<RoutedIntent["kind"]> = new Set([
  "fader",
  "effectIntent",
  "paramIntent",
  "exact",
  "compound",
  "tempo",
  "sendIntent",
  "bypassIntent",
  "preset",
  "grooveIntent",
  "sectionGrooveIntent",
  "automateIntent",
  "markerIntent",
  "stepEditIntent",
  "soundSwapIntent",
  "clips",
  "arrange",
  "sceneIntensity",
  "production",
  "mix",
  "selectedStepAssist",
  "selectedClipArrange",
  "selectedRangeArrange",
  "undoIntent",
]);

/** Non-mutating model routes that are useful and safe to accept. */
const READ_ONLY_KINDS: ReadonlySet<RoutedIntent["kind"]> = new Set(["clarify", "queryIntent"]);

export function isModelMutation(route: RoutedIntent): boolean {
  return MUTATION_KINDS.has(route.kind);
}

/**
 * The route the caller should execute, or null when the model proposal must be
 * rejected. A returned deterministic route means the model was redundant and
 * the rule layer already knew a more specific answer.
 */
export function gateModelRoute(source: string, modelRoute: RoutedIntent, doc: ProjectDocument): RoutedIntent | null {
  // 1. A specific deterministic route outranks the model.
  const deterministic = routeIntentText(source, doc);
  if (deterministic.kind !== "clarify" && deterministic.kind !== "pattern" && deterministic.kind !== "revise") {
    return deterministic;
  }

  // 2. A description never becomes a mutation, whatever the model said.
  if (isDescriptiveStatement(source) && isModelMutation(modelRoute)) return null;

  // 3. Read-only answers pass; generation does not.
  if (READ_ONLY_KINDS.has(modelRoute.kind)) return modelRoute;
  if (modelRoute.kind === "pattern" || modelRoute.kind === "revise") return null;
  if (!isModelMutation(modelRoute)) return null;

  // 4. A model mutation must build an executable, actually-changing plan.
  const plan = planIntent(doc, modelRoute);
  if (!plan.executable || !plan.mutates) return null;
  return modelRoute;
}
