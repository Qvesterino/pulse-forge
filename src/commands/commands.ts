import type { Command } from "./types";
import type { DrumPad, DrumTrack, PatternAssist, ProjectDocument, StepMeta } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { withPad } from "../project-model/transform";
import { createPatternForDoc } from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import type { Pattern } from "../project-model/types";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { type EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";

// The command engine lives in this folder, split by domain. `core` holds
// snapshot() and the dev-freeze guard; every domain module sits above it.
// This file stays the single public entry point, so the ~199 modules that
// import it keep working against an unchanged surface.
import { snapshot } from "./core";
// The effect/intent layers below still drive the master bus; the command itself lives in ./master.
// The intent/production layer below still drives project-level settings and pads from their own
// module now; the commands themselves live in ./project.
import { type PadSlice, sliceToPads } from "./project";
// The intent layer below still applies groove settings; the command itself lives in ./groove.
// docOps is plumbing shared by several domains and is NOT re-exported wholesale; only the one
// name that was already public goes back out, so the barrel's surface is unchanged.
import { trackEffectsOf, withTrackEffects } from "./docOps";
export { __resetSnapshotVerificationFallbacks, __snapshotVerificationFallbacks, snapshot } from "./core";
export { trackEffectsOf } from "./docOps";

export * from "./freeze";
export * from "./instrument";
export * from "./automation";
export * from "./master";
export * from "./notes";
export * from "./quantize";
export * from "./plugins";
export * from "./project";
export * from "./groove";
export * from "./patterns";
export * from "./arrangement";
export * from "./markers";
export * from "./metadata";
// The clip layers below read the project key when they rebuild a stem set, so this one needs a
// local binding — a re-export would not give the barrel body the name.
export * from "./clipPlayback";
export * from "./sceneAutomation";
export * from "./effectInstances";
// NOT `export *`: foldProductionIntent is exported from ./intentRouting for the barrel body and for
// effectParams, and a star re-export would publish it — the surface would be 234 names, not 233.
export {
  applyExactIntentCommand,
  applyProductionIntentCommand,
  applyProductionIntentToTrackCommand,
  exactReadback,
  foldFxIntoDoc,
  resolveExactTargetTracks,
} from "./intentRouting";
// The clip layers below fold production FX chains onto a ghost document, so this one needs a local
// binding — and it is imported, not re-exported, because it was internal before the split.
export * from "./effectParams";
export * from "./audioClips";
export * from "./drumContent";
// NOT `export *`: splitAudioClipAtTickWithMinimumFragment is exported from ./clipEditing because
// ./timeRange calls it, but it was internal before the split — a star re-export would publish it
// and the surface would be 234 names instead of 233.
export {
  updateAudioClip,
  fittedLoopPlacement,
  fitAudioClipTempo,
  sliceAudioClipToArrangement,
  duplicateAudioClip,
  bounceStemsToAudioClip,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  consolidateAudioClips,
} from "./clipEditing";
export type { FittedLoopPlacement } from "./clipEditing";
export * from "./timeRange";
export * from "./arrangementShapes";
export * from "./aiPattern";
// The clip layers below read the transition list between neighbours, so this one needs a local
// binding — a re-export would not give the barrel body the name.
// NOT `export *`: makeSceneVariation is exported from ./scenes for the arrangement layer, and a
// star re-export would publish it — the surface would be 234 names instead of 233.
export {
  createScene,
  deleteScene,
  duplicateSceneAsVariation,
  renameScene,
  reorderScenes,
  setScenePattern,
  setSceneRole,
} from "./scenes";
// The arrangement layer below builds a scene variation and places it on the timeline, so it needs
// a local binding — a re-export would not give the barrel body the name either way.
// The arrangement/clip layers below resize patterns directly, so this one needs a local binding —
// a bare re-export would not give the barrel body the name.
export {
  addEffect,
  addEffectToTracks,
  addToGroup,
  clearAllMutes,
  clearAllSolos,
  countReferenceCleanups,
  createDrumTrack,
  createGenerativeTrack,
  createGroupTrack,
  createInstrumentTrack,
  createReturnTrack,
  deleteReturnTrack,
  deleteTrack,
  duplicateTrack,
  removeEffectFromTracks,
  removeFromGroup,
  setEffectBypassOnTracks,
  setGenerativeTrackConfig,
  setGroupCollapsed,
  setGroupMute,
  setGroupSolo,
  setPadColor,
  setPadLoop,
  setTrackColor,
} from "./tracks";
// Type-only re-export: isolatedModules forbids smiešanie typov do hodnotového zozname vyššie.
export type { GenerativeTrackConfigPatch } from "./tracks";

/* ---------------- Pattern assist (iteration on your idea) ---------------- */

function drumPadsOf(doc: ProjectDocument): DrumPad[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  return track ? track.pads : [];
}

export function setEffectSidechainSource(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  sourceTrackId: string | null,
): Command {
  const targetTrack = doc.tracks.find((track) => track.id === trackId);
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!targetTrack || !target) throw new Error(`Effect ${fxId} not found`);
  if (sourceTrackId !== null) {
    if (sourceTrackId === trackId) throw new Error("A track cannot sidechain itself");
    if (!doc.tracks.some((track) => track.id === sourceTrackId))
      throw new Error(`Sidechain source ${sourceTrackId} not found`);
  }
  const previous = target.sidechainTrackId ?? null;
  const apply = (d: ProjectDocument, source: string | null): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => (fx.id === fxId ? { ...fx, sidechainTrackId: source } : fx)),
    );
  return {
    type: "setEffectSidechainSource",
    label: sourceTrackId ? "Set sidechain source" : "Clear sidechain source",
    execute: (d) => apply(d, sourceTrackId),
    undo: (d) => apply(d, previous),
  };
}

export function applyEffectPreset(doc: ProjectDocument, trackId: string, fxId: string, preset: EffectPreset): Command {
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  if (target.type !== preset.type) throw new Error("Preset does not match effect type");
  const previous = { ...target.params };
  const previousSteps = target.steps ? [...target.steps] : undefined;
  const previousVolume = target.volumeSteps ? [...target.volumeSteps] : undefined;
  const previousPitch = target.pitchSteps ? [...target.pitchSteps] : undefined;
  const previousTrim = target.outputTrimDb ?? 0;
  const nextParams = { ...target.params };
  for (const [id, value] of Object.entries(preset.params)) nextParams[id] = clampEffectParam(target.type, id, value);
  const nextSteps = preset.steps ? sanitizeGateSteps(preset.steps) : target.steps;
  const nextVolume = preset.volumeSteps ? sanitizeManglerSteps(preset.volumeSteps, 0, 1, 1) : target.volumeSteps;
  const nextPitch = preset.pitchSteps ? sanitizeManglerSteps(preset.pitchSteps, -24, 24, 0) : target.pitchSteps;
  const nextTrim = clampFxOutputTrimDb(preset.outputTrimDb ?? factoryFxPresetGainDb(preset.id));
  const apply = (
    d: ProjectDocument,
    params: Record<string, number>,
    steps: number[] | undefined,
    volume: number[] | undefined,
    pitch: number[] | undefined,
    outputTrimDb: number,
  ): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => {
        if (fx.id !== fxId) return fx;
        const { outputTrimDb: _previousTrim, ...withoutTrim } = fx;
        return {
          ...withoutTrim,
          params: { ...params },
          steps,
          volumeSteps: volume,
          pitchSteps: pitch,
          ...(outputTrimDb !== 0 ? { outputTrimDb } : {}),
        };
      }),
    );
  return {
    type: "applyEffectPreset",
    label: `Apply ${preset.name} preset`,
    execute: (d) => apply(d, nextParams, nextSteps, nextVolume, nextPitch, nextTrim),
    undo: (d) => apply(d, previous, previousSteps, previousVolume, previousPitch, previousTrim),
  };
}

/** Reset an effect to its complete schema default in one undoable operation. */
export function resetEffect(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);

  const previousParams = { ...target.params };
  const previousTrim = target.outputTrimDb ?? 0;
  // Flagship plugins expose deep, namespaced DSP parameters in addition to
  // the compact rack surface. normalizePluginParams({}) builds a complete,
  // schema-valid default map so reset cannot leave stale hidden parameters in
  // the worklet after a prior preset or A/B recall.
  const nextParams = normalizePluginParams(target.type, {}) ?? defaultParamsOf(target.type);
  const apply = (d: ProjectDocument, params: Record<string, number>, outputTrimDb: number): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => {
        if (fx.id !== fxId) return fx;
        const { outputTrimDb: _previousTrim, ...withoutTrim } = fx;
        return outputTrimDb === 0
          ? { ...withoutTrim, params: { ...params } }
          : { ...withoutTrim, params: { ...params }, outputTrimDb };
      }),
    );

  return {
    type: "resetEffect",
    label: `Reset ${EFFECT_META[target.type].name}`,
    execute: (d) => apply(d, nextParams, 0),
    undo: (d) => apply(d, previousParams, previousTrim),
  };
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

/** Remove the project-local slice edit from a pad while keeping its asset. */
export function resetPadSlice(doc: ProjectDocument, padId: string): Command {
  const pad = doc.tracks.flatMap((t) => (t.kind === "drum" ? t.pads : [])).find((p) => p.id === padId);
  if (!pad) throw new Error(`Pad ${padId} not found`);
  const next = withPad(doc, padId, (current) => {
    const clean = { ...current };
    delete clean.sliceStart;
    delete clean.sliceEnd;
    delete clean.sliceFadeIn;
    delete clean.sliceFadeOut;
    delete clean.sliceReverse;
    return clean;
  });
  return snapshot("resetPadSlice", `Reset slice on ${pad.name}`, doc, next);
}

export interface ChopSampleOptions {
  trackId: string;
  assetId: string;
  sourceName: string;
  slices: PadSlice[];
  createPattern: boolean;
}

/** Atomically map a source's first 16 slices and optionally create a pattern. */
export function chopSampleToPads(doc: ProjectDocument, options: ChopSampleOptions): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.id === options.trackId && t.kind === "drum");
  if (!track) throw new Error(`Drum track ${options.trackId} not found`);
  const fit = options.slices.slice(0, track.pads.length);
  let next = sliceToPads(doc, options.trackId, options.assetId, fit, options.sourceName).execute(doc);

  if (options.createPattern) {
    const pattern = createPatternForDoc(next, `${options.sourceName} Chop`, 16);
    const rows = { ...pattern.rows };
    fit.forEach((_, index) => {
      const pad = track.pads[index];
      if (!pad) return;
      const row = [...(rows[pad.id] ?? new Array<number>(16).fill(0))];
      row[index] = 0.9;
      rows[pad.id] = row;
    });
    const choppedPattern = { ...pattern, rows };
    next = {
      ...next,
      patterns: [...next.patterns, choppedPattern],
      activePatternId: choppedPattern.id,
    };
  }

  return snapshot(
    "chopSampleToPads",
    options.createPattern ? `Chop ${fit.length} slices + create pattern` : `Chop ${fit.length} slices to pads`,
    doc,
    next,
  );
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
