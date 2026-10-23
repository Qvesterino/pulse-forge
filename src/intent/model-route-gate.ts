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
import { installedEffectTrackIds } from "../plugin-catalog";
import type { EffectIntent, BypassIntent } from "./mix";
import type { ParamIntent } from "./param-intent";
import type { CompoundPart } from "./compound";

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

function explicitlyRequestsEffectInsertion(source: string): boolean {
  const normalized = source
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /\b(?:add|insert|apply|put|pridaj|vloz|nasad|zaved)\b/.test(normalized);
}

function bindEffectIntent(doc: ProjectDocument, intent: EffectIntent, source: string): EffectIntent | null {
  const installed = installedEffectTrackIds(
    doc,
    intent.effectType,
    intent.targets,
    intent.trackIds,
    intent.trackOrdinal,
  );
  if (installed.length === 0) {
    return explicitlyRequestsEffectInsertion(source) && (intent.direction === "more" || intent.direction === "set")
      ? intent
      : null;
  }
  // Resolve the model's family choice against the live chains and pin the
  // proposal to only those exact tracks. This prevents add-if-missing from
  // silently inserting an effect on other tracks in that family.
  return { ...intent, targets: [], trackIds: installed, trackOrdinal: undefined };
}

function bindParamIntent(doc: ProjectDocument, intent: ParamIntent, source: string): ParamIntent | null {
  const installed = installedEffectTrackIds(
    doc,
    intent.effectType,
    intent.targets,
    intent.trackIds,
    intent.trackOrdinal,
  );
  if (installed.length === 0) {
    return explicitlyRequestsEffectInsertion(source) ? intent : null;
  }
  return { ...intent, targets: [], trackIds: installed, trackOrdinal: undefined };
}

function bindBypassIntent(doc: ProjectDocument, intent: BypassIntent): BypassIntent | null {
  const installed = installedEffectTrackIds(doc, intent.effectType, [intent.target], intent.trackIds);
  return installed.length > 0 ? { ...intent, trackIds: installed } : null;
}

function bindCompoundPart(doc: ProjectDocument, part: CompoundPart, source: string): CompoundPart | null {
  if (part.kind === "effect") {
    const intent = bindEffectIntent(doc, part.intent, source);
    return intent ? { ...part, intent } : null;
  }
  if (part.kind === "bypass") {
    const intent = bindBypassIntent(doc, part.intent);
    return intent ? { ...part, intent } : null;
  }
  return part;
}

function bindInstalledPluginTargets(doc: ProjectDocument, route: RoutedIntent, source: string): RoutedIntent | null {
  if (route.kind === "effectIntent") {
    const intent = bindEffectIntent(doc, route.intent, source);
    return intent ? { ...route, intent } : null;
  }
  if (route.kind === "paramIntent") {
    const intent = bindParamIntent(doc, route.intent, source);
    return intent ? { ...route, intent } : null;
  }
  if (route.kind === "bypassIntent") {
    const intent = bindBypassIntent(doc, route.intent);
    return intent ? { ...route, intent } : null;
  }
  if (route.kind === "compound") {
    const parts = route.parts.map((part) => bindCompoundPart(doc, part, source));
    return parts.every((part) => part != null) ? { ...route, parts: parts as CompoundPart[] } : null;
  }
  return route;
}

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

  const boundRoute = bindInstalledPluginTargets(doc, modelRoute, source);
  if (!boundRoute) return null;

  // 4. A model mutation must build an executable, actually-changing plan.
  const plan = planIntent(doc, boundRoute);
  if (!plan.executable || !plan.mutates) return null;
  return boundRoute;
}
