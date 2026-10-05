/**
 * Assist: iterating on a pattern that already exists - vary its feel, build it out, replace one pad
 * family's groove with a style, or drop a fill over its last bar.
 *
 * The four commands are thin and they share one body, because what makes an assist run auditable is
 * the provenance record rather than the operation: every run stamps the pattern with the engine id
 * and version, the normalized request including its seed, and the content hashes before and after.
 * A later surface can then tell "the generator wrote this" from "I edited this", and re-running the
 * same seed is verifiable rather than merely likely. The two private helpers exist for that record:
 * applyRowsPatch prunes step metadata down to the steps that still carry a hit, so an assist run
 * cannot leave velocity or accent data pointing at silence, and it re-chains the generation hashes
 * so the pattern's recorded quality is dropped when its content changes underneath it.
 */
import type { Command } from "./types";
import type { DrumPad, DrumTrack, PatternAssist, ProjectDocument, StepMeta } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import type { Pattern } from "../project-model/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";

/* ---------------- pattern assist (iteration on your idea) ---------------- */

function drumPadsOf(doc: ProjectDocument): DrumPad[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  return track ? track.pads : [];
}

function applyRowsPatch(
  doc: ProjectDocument,
  patternId: string,
  patch: import("../assist/patternOps").RowsPatch,
): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const stepCount = patch.stepCount ?? p.stepCount;
      const sourceRows = { ...p.rows, ...patch.rows };
      const rows = Object.fromEntries(
        Object.entries(sourceRows).map(([padId, row]) => [
          padId,
          new Array<number>(stepCount).fill(0).map((_, step) => row[step] ?? 0),
        ]),
      );
      const mergedMeta: NonNullable<Pattern["stepMeta"]> = Object.fromEntries(
        Object.entries(p.stepMeta ?? {}).map(([padId, padMeta]) => [padId, { ...padMeta }]),
      );
      if (patch.clearStepMeta) {
        const padIds = patch.clearStepMeta.padIds
          ? new Set(patch.clearStepMeta.padIds)
          : new Set(Object.keys(mergedMeta));
        for (const padId of padIds) {
          const padMeta = mergedMeta[padId];
          if (!padMeta) continue;
          for (const stepKey of Object.keys(padMeta)) {
            const step = Number(stepKey);
            if (step >= patch.clearStepMeta.from && step < patch.clearStepMeta.to) delete padMeta[step];
          }
        }
      }
      for (const [padId, padMeta] of Object.entries(patch.stepMeta ?? {})) {
        mergedMeta[padId] = { ...(mergedMeta[padId] ?? {}), ...padMeta };
      }
      const cleanedMeta: NonNullable<Pattern["stepMeta"]> = {};
      for (const [padId, padMeta] of Object.entries(mergedMeta)) {
        const row = rows[padId];
        if (!row) continue;
        const cleanSteps: Record<number, StepMeta> = {};
        for (const [stepKey, meta] of Object.entries(padMeta)) {
          const step = Number(stepKey);
          if (Number.isInteger(step) && step >= 0 && step < stepCount && row[step] > 0) {
            cleanSteps[step] = { ...meta };
          }
        }
        if (Object.keys(cleanSteps).length > 0) cleanedMeta[padId] = cleanSteps;
      }
      const notes = patch.notes
        ? Object.fromEntries(
            Object.entries(patch.notes).map(([trackId, noteList]) => [
              trackId,
              noteList
                .map((note) => ({ ...note }))
                .filter((note) => note.start >= 0 && note.start + note.duration <= stepCount * STEP_TICKS),
            ]),
          )
        : p.notes;
      return {
        ...p,
        rows,
        notes,
        stepCount,
        stepMeta: Object.keys(cleanedMeta).length > 0 ? cleanedMeta : undefined,
        phrasePlan: patch.phrasePlan ?? p.phrasePlan,
      };
    }),
  };
}

function assistCommand(
  type: string,
  label: string,
  doc: ProjectDocument,
  patternId: string,
  input: AssistInput,
): Command {
  const sourcePattern = doc.patterns.find((pattern) => pattern.id === patternId);
  if (!sourcePattern) throw new Error(`Pattern ${patternId} not found`);
  const request = normalizeAssistRequest(input);
  const patch = buildAssistPatch(sourcePattern, drumPadsOf(doc), request);
  const patchedDoc = applyRowsPatch(doc, patternId, patch);
  const patchedPattern = patchedDoc.patterns.find((pattern) => pattern.id === patternId);
  if (!patchedPattern) throw new Error(`Pattern ${patternId} disappeared during Assist operation`);
  const sourceContentHash = contentHash(canonicalizePattern(doc, sourcePattern));
  const outputContentHash = contentHash(canonicalizePattern(patchedDoc, patchedPattern));
  const assist: PatternAssist = {
    engineId: ASSIST_ENGINE_ID,
    engineVersion: ASSIST_ENGINE_VERSION,
    operation: request.operation,
    seed: request.seed,
    sourceContentHash,
    outputContentHash,
    ...(request.operation === "vary" ? { amount: request.amount } : {}),
    ...(request.operation === "build" ? { bars: request.bars } : {}),
    ...(request.operation === "replace" ? { target: request.target, style: request.style } : {}),
  };
  const next: ProjectDocument = {
    ...patchedDoc,
    patterns: patchedDoc.patterns.map((pattern) => {
      if (pattern.id !== patternId) return pattern;
      if (!pattern.generation) return { ...pattern, assist };
      const generation = {
        ...pattern.generation,
        inputContentHash: sourceContentHash,
        outputContentHash,
      };
      delete generation.quality;
      return { ...pattern, assist, generation };
    }),
  };
  return snapshot(type, label, doc, next);
}

/** Vary the active pattern: velocity humanization + ghost notes + micro feel. */
export function assistVary(doc: ProjectDocument, patternId: string, seed: string, amount: number): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistVary", `Vary ${pattern.name} (${seed})`, doc, patternId, {
    operation: "vary",
    seed,
    amount,
  });
}

/** Expand the pattern to `bars` with a progressive element + energy build. */
export function assistBuild(doc: ProjectDocument, patternId: string, bars: number, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistBuild", `Build ${pattern.name} to ${bars} bars`, doc, patternId, {
    operation: "build",
    bars,
    seed,
  });
}

/** Replace one pad family's groove with a style (hats → house, kicks → trap…). */
export function assistReplace(
  doc: ProjectDocument,
  patternId: string,
  target: import("../assist/patternOps").ReplaceTarget,
  style: string,
  seed: string,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistReplace", `${target} → ${style}`, doc, patternId, {
    operation: "replace",
    target,
    style,
    seed,
  });
}

/** Crescendo snare fill over the pattern's last bar. */
export function assistFill(doc: ProjectDocument, patternId: string, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistFill", `Fill ${pattern.name} (${seed})`, doc, patternId, { operation: "fill", seed });
}
