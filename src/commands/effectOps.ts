/**
 * Per-device effect operations: point a device at a sidechain source, apply a preset to it, or put
 * it back to its factory state.
 *
 * All three address a single effect inside a track rather than the track's chain, and all three go
 * through withTrackEffects so the chain is rebuilt from one place instead of each command reshaping
 * it its own way. The sidechain case refuses a track as its own source, because a device that ducks
 * to itself is a feedback loop with a musical cause nobody asked for. Reset and preset-apply both
 * route the value back through the shared effect clamp, so a preset cannot install a parameter the
 * engine would not accept.
 */
import { trackEffectsOf, withTrackEffects } from "./docOps";
import type { Command } from "./types";
import type { ProjectDocument } from "../project-model/types";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { type EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";

/* ---------------- effect ops ---------------- */

export function setEffectSidechainSource(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  sourceTrackId: string | null,
): Command {
  const targetExists =
    trackId === MASTER_EFFECT_OWNER_ID ||
    doc.tracks.some((track) => track.id === trackId) ||
    doc.returns.some((r) => r.id === trackId);
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!targetExists || !target) throw new Error(`Effect ${fxId} not found`);
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
