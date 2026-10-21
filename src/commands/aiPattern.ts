/**
 * Installing a generated pattern: apply an already-generated result, apply it together with the
 * FX its intent asked for, or generate and apply in one step.
 *
 * The rule the module exists to hold is that a command never generates. Generation carries hidden
 * nondeterminism, so running it inside execute() would make undo meaningless and two identical
 * applies would produce two different documents. Generation happens once through the Intent
 * Engine, outside the command, and these install the result. The pattern is copied, never
 * mutated, so the caller keeps owning the object it previewed.
 *
 * generatePatternCommand is the one deliberate exception: it is the synchronous heuristic path,
 * for direct generate-and-apply flows that have no preview to protect. A preview surface must use
 * applyGenerationResultCommand on the result the caller already holds.
 */
import { foldProductionIntent } from "./intentRouting";
import type { Command } from "./types";
import type { GrooveSettings, ProjectDocument, Scene } from "../project-model/types";
import { meterBarClause, meterSignatureChanged } from "../project-model/meter-disclosure";
import { uid } from "../shared/ids";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { snapshot } from "./core";

/* ---------------- AI pattern generation ---------------- */

/**
 * Build the one-coherent-undo-step command that installs an ALREADY GENERATED,
 * already validated GenerationResult proposal into the project.
 *
 * Commands must never generate (async work / hidden nondeterminism inside
 * execute would break undo semantics), so product preview/apply flows
 * generate once through the Intent Engine and apply THAT result here. The
 * pattern is copied, never mutated — callers keep owning the previewed
 * object (React state, dice sessions).
 */
export function applyGenerationResultCommand(
  doc: ProjectDocument,
  result: GenerationResult,
  patternName?: string,
): Command {
  const proposal = result.proposal;
  if (!proposal) throw new Error(result.diagnostics.errors.join(", ") || "Intent generation was rejected");
  const options = result.plan.options;
  let pattern = proposal.pattern;
  const name = patternName ?? (pattern.name || `${options.genre} ${options.seed.slice(0, 4)}`.trim());
  if (name !== pattern.name) pattern = { ...pattern, name };

  // Apply groove settings from the resolved groove if requested
  let grooveUpdate: Partial<GrooveSettings> | undefined;
  if (options.applyGrooveSettings) {
    // Reuse the exact source-aware resolution path used by the generator.
    const groove = resolveGrooveForGeneration(doc, options);
    grooveUpdate = { swing: groove.swing };
  }
  const bpmUpdate = result.plan.resolvedBpm;
  const projectUpdates = {
    ...(grooveUpdate ? { groove: { ...doc.groove, ...grooveUpdate } } : {}),
    ...(bpmUpdate !== null && bpmUpdate !== undefined ? { bpm: bpmUpdate } : {}),
    // The REQUESTED meter (ADR 0057 Stage 2f): "make me a beat in 6/8" leaves
    // the project in 6/8. Without this the 6/8 beat would land in a 4/4
    // project — twelve steps in a sixteen-step bar, three quarters of a bar.
    ...(result.plan.intent.timeSignature ? { timeSignature: result.plan.intent.timeSignature } : {}),
  };
  // The meter is NOT changed silently (ADR 0056). This path writes
  // `doc.timeSignature` directly, so it never goes through the `setTimeSignature`
  // command and never inherits the command's disclosure — it has to ask the
  // one owner itself. Only the BAR clause is used here: the generated
  // pattern is built IN the requested metre, so a clause about the OLD
  // pattern's length would be describing material that no longer exists.
  const requestedMeter = result.plan.intent.timeSignature;
  const meterDetail =
    requestedMeter && meterSignatureChanged(doc.timeSignature, requestedMeter)
      ? meterBarClause(requestedMeter)
      : undefined;

  if (options.replaceMode === "replace") {
    const activeId = doc.activePatternId;
    const next: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === activeId
          ? {
              ...p,
              rows: pattern.rows,
              notes: pattern.notes,
              stepMeta: pattern.stepMeta,
              stepCount: pattern.stepCount,
              name: pattern.name || p.name,
              generation: pattern.generation,
            }
          : p,
      ),
      ...projectUpdates,
    };
    return { ...snapshot("generatePattern", `Replace with ${pattern.name}`, doc, next), detail: meterDetail };
  }

  const scene: Scene = {
    id: uid("scene"),
    name: pattern.name,
    patternId: pattern.id,
    intensity: 0.7,
  };

  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
    activePatternId: pattern.id,
    ...projectUpdates,
  };
  return { ...snapshot("generatePattern", `Generate ${pattern.name}`, doc, next), detail: meterDetail };
}

/**
 * Wave 1 — apply a generation result TOGETHER with the FX requests riding
 * its intent (`result.plan.intent.fx`, e.g. "wobbly drill"): pattern fold +
 * production fold in ONE undoable snapshot. Preview parity holds — the
 * candidate carries the same fx field the USE path applies.
 */
export function applyGenerationResultWithFxCommand(
  doc: ProjectDocument,
  result: GenerationResult,
  patternName?: string,
): Command {
  const patternCmd = applyGenerationResultCommand(doc, result, patternName);
  const fx = result.plan.intent.fx ?? null;
  if (!fx) return patternCmd;
  const next = foldProductionIntent(patternCmd.execute(doc), fx);
  return {
    ...snapshot(
      "applyGenerationWithFx",
      `${patternCmd.label} + ${fx.goals.map((g) => g.concept).join(", ")}`,
      doc,
      next,
    ),
    // The metre disclosure survives the FX fold — a generation that also
    // changed the metre must still say so.
    detail: patternCmd.detail,
  };
}

/**
 * Generate (synchronously, heuristic ranking) and apply in one step.
 *
 * Direct generate-and-apply flows without a preview (e.g. AI Flip in the
 * arrangement panel) — there is no previewed result to protect, so the
 * generation is the single source. Preview/apply surfaces must NOT use this:
 * generate once via the Intent Engine and apply the previewed result with
 * {@link applyGenerationResultCommand} instead.
 */
export function generatePatternCommand(doc: ProjectDocument, options: GenerateOptions, patternName?: string): Command {
  const result = generateLocalResultFromOptions(doc, options, "apply");
  return applyGenerationResultCommand(doc, result, patternName);
}
