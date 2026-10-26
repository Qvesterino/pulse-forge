/**
 * COMMAND FOR ROUTE — the single dry-runnable mapping from a routed intent to
 * a canonical command.
 *
 * It was private to the MCP executor; the intent PLAN needs the same mapping
 * to answer "what would this do?" without touching the store. Keeping one
 * switch means a route cannot execute one way over MCP and preview another way
 * in the UI.
 *
 * Only routes whose command is a pure `execute(doc) → doc` belong here.
 * UI-only lanes (loudness measure/trim, mix profile audition, generation) are
 * intentionally absent: their plan would need runtime services, not a command.
 */
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import type { RoutedIntent } from "./route";
import { applyFaderIntent, applyTempoIntent } from "./conversation";
import { applyExactIntentCommand, applyProductionIntentCommand } from "../commands/intentRouting";
import { applyPresetIntentCommand } from "./preset-intent";
import { applyAutomateIntent, applyGrooveIntent, applyMarkerIntent, applySectionGrooveIntent } from "./studio-words";
import { applyArrangeOps, applyClipArrangeOps } from "./arrangeWords";
import { applySoundSwapIntent, applyStepEditIntent } from "./sound-words";
import { applyBypassIntent, applyEffectIntent, applySendIntent } from "./mix";
import { applyParamIntent } from "./param-intent";
import { applyCompoundIntent } from "./compound";
import { addAutomationRamp } from "../commands/automation";

export function buildIntentCommand(doc: ProjectDocument, route: RoutedIntent): Command | null {
  switch (route.kind) {
    case "fader":
      return applyFaderIntent(doc, route.intent);
    case "tempo":
      return applyTempoIntent(doc, route.intent);
    case "exact":
      return applyExactIntentCommand(doc, route.plan);
    case "grooveIntent":
      return applyGrooveIntent(doc, route.intent);
    case "sectionGrooveIntent":
      return applySectionGrooveIntent(doc, route.intent);
    case "automationPlan":
      if ("error" in route.result) return null;
      return addAutomationRamp(
        doc,
        route.result.plan.target,
        route.result.plan.startTick,
        route.result.plan.fromValue,
        route.result.plan.endTick,
        route.result.plan.toValue,
      );
    case "markerIntent":
      return applyMarkerIntent(doc, route.intent);
    case "automateIntent":
      return applyAutomateIntent(doc, route.intent, null);
    case "clips":
      return applyClipArrangeOps(doc, route.ops);
    case "arrange":
      return applyArrangeOps(doc, route.ops);
    case "preset":
      return applyPresetIntentCommand(doc, route.intent);
    case "effectIntent":
      return applyEffectIntent(doc, route.intent);
    case "paramIntent":
      return applyParamIntent(doc, route.intent);
    case "sendIntent":
      return applySendIntent(doc, route.intent);
    case "bypassIntent":
      return applyBypassIntent(doc, route.intent);
    case "soundSwapIntent":
      return applySoundSwapIntent(doc, route.intent);
    case "stepEditIntent":
      return applyStepEditIntent(doc, route.intent);
    case "compound":
      return applyCompoundIntent(doc, route.parts);
    case "production":
      return applyProductionIntentCommand(doc, route.intent);
    default:
      return null;
  }
}
