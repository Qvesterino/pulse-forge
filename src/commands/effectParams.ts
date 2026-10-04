/**
 * Effect parameters and step sequences: scalar params, macros, output trim, the Beat Mangler and
 * gate step patterns, chain presets, bypass and ordering.
 *
 * Every value goes through the shared effect clamp rather than its own range, so the UI, the
 * offline renderer and a collab peer cannot disagree about what a parameter may hold.
 */
import type { Command } from "./types";
import type { EffectInstance, ProjectDocument } from "../project-model/types";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import { clampEffectParam, defaultParamsOf, EFFECT_META } from "../effects/definitions";
import { targetParamDef } from "../project-model/targets";
import { CORE_EFFECT_PRESETS } from "../effects/presets";
import type { BeatmakingEffectChain } from "../effects/chains";
import { clampFxOutputTrimDb, factoryFxChainGainDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { trackEffectsOf, withTrackEffects } from "./docOps";

/* ---------------- effect params & steps ---------------- */
/**
 * Beat Mangler envelope edit (FX expansion): replace `volumeSteps` and/or
/**
 * Beat Mangler envelope edit (FX expansion): replace `volumeSteps` and/or
 * `pitchSteps` on a beatMangler instance. Sanitized to 16/32 steps with the
 * field-specific ranges; fields the caller omits stay untouched.
 */
export function setBeatManglerSteps(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  patch: { volume?: number[]; pitch?: number[] },
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const prevVolume = target.volumeSteps ? [...target.volumeSteps] : undefined;
  const prevPitch = target.pitchSteps ? [...target.pitchSteps] : undefined;
  const nextVolume = patch.volume !== undefined ? sanitizeManglerSteps(patch.volume, 0, 1, 1) : prevVolume;
  const nextPitch = patch.pitch !== undefined ? sanitizeManglerSteps(patch.pitch, -24, 24, 0) : prevPitch;
  const apply = (d: ProjectDocument, volume: number[] | undefined, pitch: number[] | undefined): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, volumeSteps: volume, pitchSteps: pitch } : f)),
    );
  return {
    type: "setBeatManglerSteps",
    label: "Edit mangler envelopes",
    execute: (d) => apply(d, nextVolume, nextPitch),
    undo: (d) => apply(d, prevVolume, prevPitch),
    // No applyToYDoc: without the fast path, YDocStore falls back to the
    // generic whole-document diff — correct (and rare) for envelope edits.
  };
}

export function setEffectSteps(doc: ProjectDocument, trackId: string, fxId: string, steps: number[]): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const prev = target.steps ? [...target.steps] : undefined;
  const next = sanitizeGateSteps(steps);
  const apply = (d: ProjectDocument, values: number[] | undefined): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) => effects.map((f) => (f.id === fxId ? { ...f, steps: values } : f)));
  return {
    type: "setEffectSteps",
    label: "Edit step pattern",
    execute: (d) => apply(d, next),
    undo: (d) => apply(d, prev),
  };
}

export function setEffectParam(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  paramId: string,
  value: number,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const { type, params } = target;
  const def = EFFECT_META[type].params.find((p) => p.id === paramId);
  const deepDef = !def && type === "ozvena" ? targetParamDef(doc, { kind: "fxParam", trackId, fxId, paramId }) : null;
  if (!def && !deepDef) throw new Error(`Effect param ${paramId} not defined for ${type}`);
  const eqLegacyMap: Record<string, string> = {
    lowGain: "lowShelfGain",
    lowFreq: "lowShelfFreq",
    midGain: "lowMidGain",
    midFreq: "lowMidFreq",
    midQ: "lowMidQ",
    highGain: "highShelfGain",
    highFreq: "highShelfFreq",
  };
  const canonicalId = type === "eq" ? eqLegacyMap[paramId] : undefined;
  const safeValue = Number.isFinite(value) ? value : (def?.default ?? deepDef!.default);
  if (def?.kind === "toggle" && safeValue !== 0 && safeValue !== 1) {
    throw new Error(`Invalid toggle value ${safeValue} for ${type}.${paramId}; expected 0 or 1`);
  }
  if (def?.options?.length && !def.options.some((option) => option.value === safeValue)) {
    throw new Error(`Invalid enum value ${safeValue} for ${type}.${paramId}`);
  }
  const clamped = def
    ? clampEffectParam(type, paramId, safeValue)
    : Math.min(deepDef!.max, Math.max(deepDef!.min, safeValue));
  const nextValues: Record<string, number> = { [paramId]: clamped };
  if (canonicalId) nextValues[canonicalId] = clampEffectParam(type, canonicalId, safeValue);
  const previousValues: Record<string, number> = {
    [paramId]: params[paramId] ?? def?.default ?? deepDef!.default,
  };
  if (canonicalId)
    previousValues[canonicalId] =
      params[canonicalId] ?? EFFECT_META[type].params.find((p) => p.id === canonicalId)?.default ?? 0;
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, ...values } } : f)),
    );
  return {
    type: "setEffectParam",
    label: `Set ${EFFECT_META[type].name} ${paramId}`,
    execute: (d) => apply(d, nextValues),
    undo: (d) => apply(d, previousValues),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          for (let j = 0; j < effects.length; j++) {
            const fx = effects.get(j) as any;
            if (fx.get("id") === fxId) {
              const fxParams = fx.get("params") as any;
              for (const [id, nextValue] of Object.entries(nextValues)) fxParams.set(id, nextValue);
              break;
            }
          }
          break;
        }
      }
    },
  };
}

/** Apply several source-dock macro targets as one undoable gesture. */
export function setEffectMacroParams(
  doc: ProjectDocument,
  trackId: string,
  edits: readonly { fxId: string; paramId: string; value: number }[],
): Command {
  if (edits.length === 0) return snapshot("setEffectMacroParams", "Set source macro", doc, doc);
  let next = doc;
  for (const edit of edits) {
    const command = setEffectParam(next, trackId, edit.fxId, edit.paramId, edit.value);
    next = command.execute(next);
  }
  return snapshot("setEffectMacroParams", "Set source macro", doc, next);
}

/** User-adjustable engine-owned output trim, kept outside the DSP parameter map. */
export function setEffectOutputTrimDb(doc: ProjectDocument, trackId: string, fxId: string, gainDb: number): Command {
  const target = trackEffectsOf(doc, trackId).find((effect) => effect.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const previous = target.outputTrimDb ?? 0;
  const next = Number.isFinite(gainDb) ? clampFxOutputTrimDb(gainDb) : previous;
  const apply = (d: ProjectDocument, value: number): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => {
        if (fx.id !== fxId) return fx;
        const { outputTrimDb: _trim, ...withoutTrim } = fx;
        return value === 0 ? withoutTrim : { ...withoutTrim, outputTrimDb: value };
      }),
    );
  return {
    type: "setEffectOutputTrimDb",
    label: `Set ${EFFECT_META[target.type].name} output trim`,
    execute: (d) => apply(d, next),
    undo: (d) => apply(d, previous),
  };
}

/** Insert a short beatmaking chain as one undoable document change. */
export function applyEffectChainPreset(
  doc: ProjectDocument,
  trackId: string,
  chain: BeatmakingEffectChain,
  insertAt = trackEffectsOf(doc, trackId).length,
): Command & { readonly firstEffectId: string; readonly effectIds: readonly string[] } {
  if (!doc.tracks.some((track) => track.id === trackId)) throw new Error(`Track ${trackId} not found`);
  if (chain.effects.length === 0) throw new Error("Effect chain is empty");
  const factoryById = new Map(CORE_EFFECT_PRESETS.map((preset) => [preset.id, preset]));
  const instances: EffectInstance[] = chain.effects.map((item) => {
    const preset = factoryById.get(item.presetId);
    if (!preset || preset.type !== item.type)
      throw new Error(`Factory preset ${item.presetId} does not match ${item.type}`);
    const params = defaultParamsOf(item.type);
    for (const [id, value] of Object.entries(preset.params)) params[id] = clampEffectParam(item.type, id, value);
    const outputTrimDb = clampFxOutputTrimDb(preset.outputTrimDb ?? factoryFxPresetGainDb(preset.id));
    const instance: EffectInstance = {
      id: uid("fx"),
      type: item.type,
      bypassed: false,
      params,
      ...(preset.steps ? { steps: sanitizeGateSteps(preset.steps) } : {}),
      ...(preset.volumeSteps ? { volumeSteps: sanitizeManglerSteps(preset.volumeSteps, 0, 1, 1) } : {}),
      ...(preset.pitchSteps ? { pitchSteps: sanitizeManglerSteps(preset.pitchSteps, -24, 24, 0) } : {}),
      ...(outputTrimDb !== 0 ? { outputTrimDb } : {}),
    };
    return instance;
  });
  const chainTrim = factoryFxChainGainDb(chain.id);
  if (chainTrim !== 0) {
    const last = instances[instances.length - 1];
    last.outputTrimDb = clampFxOutputTrimDb((last.outputTrimDb ?? 0) + chainTrim);
    if (last.outputTrimDb === 0) delete last.outputTrimDb;
  }
  const insertionIndex = Math.max(0, Math.min(trackEffectsOf(doc, trackId).length, Math.floor(insertAt)));
  const ids = new Set(instances.map((instance) => instance.id));
  return {
    type: "applyEffectChainPreset",
    label: `Insert ${chain.name} chain`,
    firstEffectId: instances[0].id,
    effectIds: instances.map((instance) => instance.id),
    execute: (d) =>
      withTrackEffects(d, trackId, (effects) => {
        const next = [...effects];
        const at = Math.max(0, Math.min(next.length, insertionIndex));
        next.splice(at, 0, ...instances);
        return next;
      }),
    undo: (d) => withTrackEffects(d, trackId, (effects) => effects.filter((effect) => !ids.has(effect.id))),
  };
}

export function toggleEffectBypass(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const prev = trackEffectsOf(doc, trackId).find((f) => f.id === fxId)?.bypassed ?? false;
  const apply = (d: ProjectDocument, bypassed: boolean): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) => effects.map((f) => (f.id === fxId ? { ...f, bypassed } : f)));
  return {
    type: "toggleEffectBypass",
    label: `${prev ? "Enable" : "Bypass"} effect`,
    execute: (d) => apply(d, !prev),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          for (let j = 0; j < effects.length; j++) {
            if (effects.get(j).get("id") === fxId) {
              effects.get(j).set("bypassed", !prev);
              break;
            }
          }
          break;
        }
      }
    },
  };
}

export function moveEffect(doc: ProjectDocument, trackId: string, fxId: string, direction: -1 | 1): Command {
  const effects = trackEffectsOf(doc, trackId);
  const index = effects.findIndex((f) => f.id === fxId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= effects.length) throw new Error("Effect cannot move in that direction");
  return moveEffectToIndex(doc, trackId, fxId, target);
}

/** Move a device to a final zero-based position in its track's effect chain. */
export function moveEffectToIndex(doc: ProjectDocument, trackId: string, fxId: string, toIndex: number): Command {
  const effects = trackEffectsOf(doc, trackId);
  const index = effects.findIndex((f) => f.id === fxId);
  if (index < 0) throw new Error("Effect not found in track chain");
  const target = Math.max(0, Math.min(effects.length - 1, Math.floor(toIndex)));
  if (index === target) {
    return {
      type: "moveEffect",
      label: `Reorder ${EFFECT_META[effects[index].type].name}`,
      execute: (d) => d,
      undo: (d) => d,
    };
  }
  const reordered = [...effects];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(target, 0, moved);
  const next = withTrackEffects(doc, trackId, () => reordered);
  return snapshot("moveEffect", `Reorder ${EFFECT_META[moved.type].name}`, doc, next);
}
