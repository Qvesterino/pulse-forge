import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
// F2 eager diet: intent-surface commands import their home module directly —
// the commands barrel no longer re-exports the intent graph (boot-path seam).
import { applyProductionIntentToTrackCommand } from "../commands/intentRouting";
import { parseEffectIntent } from "../effect-intent/parser";
import { parseProductionIntent } from "../intent/production";
// The track-level effect intent lives in the effect-intent layer: the MCP
// layer routes the same assistant intent, and the architecture layer gate
// forbids `src/mcp` from importing `src/ui`. Re-exported here so the
// component-facing import path stays unchanged.
import { applyEffectIntentOnTrack } from "../effect-intent/applyOnTrack";
export { applyEffectIntentOnTrack };

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
