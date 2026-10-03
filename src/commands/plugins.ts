import type { Command } from "./types";
import type { DeviceState, ProjectDocument } from "../project-model/types";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { buildSchema as buildFxEqSchema } from "../effects/fxeq-core/core/parameterSchema";
import {
  tryGetParamDef as tryGetUltinaParamDef,
  clampParam as clampUltinaParam,
  buildDefaultParams as buildUltinaDefaults,
} from "../effects/ultina-core/contracts/parameterSchema";
import {
  tryGetParamDef as tryGetMorphParamDef,
  clampParam as clampMorphParam,
  buildDefaultParams as buildMorphDefaults,
} from "../effects/morph-dynamics-core/contracts/parameterSchema";
import { sanitizeDeviceState } from "../project-model/schema";
import { trackEffectsOf, withTrackEffects } from "./docOps";

/**
 * Per-plugin command panels: FXEQ, Ultina and MORPH DYNAMICS.
 *
 * Each of these edits a single device's parameters in place on a track's effect
 * chain, which is why they all reach for the same two docOps helpers.
 */
/* ---------------- FXEQ per-band editing + presets ---------------- */

/** Set any fxeq param — including dotted per-band ids ("band2.satDriveDb"). */
export function setFxEqParam(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  fullId: string,
  value: number,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "fxeq") throw new Error(`PRISM effect ${fxId} not found`);
  const schema = buildFxEqSchema(Math.round(target.params.bandCount ?? 6));
  const def = schema.defs.find((d) => d.id === fullId);
  if (!def) throw new Error(`PRISM param ${fullId} not defined for ${Math.round(target.params.bandCount ?? 6)} bands`);
  const previous = target.params[fullId] ?? schema.defaultParams[fullId] ?? def.defaultValue;
  const safeValue = Number.isFinite(value) ? value : previous;
  const clamped =
    fullId === "crossoverOrder" || fullId === "crossoverEqualize"
      ? clampEffectParam("fxeq", fullId, safeValue)
      : Math.max(def.minValue, Math.min(def.maxValue, safeValue));
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, ...values } } : f)),
    );
  return {
    type: "setFxEqParam",
    label: `PRISM ${fullId}`,
    execute: (d) => apply(d, { [fullId]: clamped }),
    undo: (d) => apply(d, { [fullId]: previous }),
  };
}

/** Apply an FXEQ preset in ONE undoable gesture: schema defaults + preset params. */
export function applyFxEqPreset(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  presetName: string,
  presetParams: Record<string, number>,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "fxeq") throw new Error(`PRISM effect ${fxId} not found`);
  const schema = buildFxEqSchema(Math.round(target.params.bandCount ?? 6));
  // Validate preset values against the band-aware schema: presets are data,
  // and an out-of-range or unknown id must never reach the DSP or the
  // persisted doc verbatim.
  const nextParams: Record<string, number> = { ...schema.defaultParams };
  for (const [id, value] of Object.entries(presetParams)) {
    const def = schema.defs.find((d) => d.id === id);
    if (!def || typeof value !== "number" || !Number.isFinite(value)) continue;
    nextParams[id] =
      id === "crossoverOrder" || id === "crossoverEqualize"
        ? clampEffectParam("fxeq", id, value)
        : Math.max(def.minValue, Math.min(def.maxValue, value));
  }
  const previousParams = { ...target.params };
  // Undo must restore a CANONICAL full map, not the raw partial previous
  // one: the engine's syncFxParams only pushes doc-present keys, so a
  // shrunken undo map would leave every preset-written deep param stuck in
  // the DSP at its preset value while the document claims the default.
  const undoSchema = buildFxEqSchema(Math.round(previousParams.bandCount ?? 6));
  const undoParams: Record<string, number> = { ...undoSchema.defaultParams, ...previousParams };
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...values } } : f)),
    );
  return {
    type: "applyFxEqPreset",
    label: `PRISM preset ${presetName}`,
    execute: (d) => apply(d, nextParams),
    undo: (d) => apply(d, undoParams),
  };
}

/* ---------------- Ultina per-module editing + presets ---------------- */

/** Set any ultina param — schema-validated and clamped ("comp.thresholdDb", "eq.band3.gainDb"…). */
export function setUltinaParam(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  paramId: string,
  value: number,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "ultina") throw new Error(`VLYX effect ${fxId} not found`);
  const def = tryGetUltinaParamDef(paramId);
  if (!def) throw new Error(`VLYX param ${paramId} not defined`);
  const previous = target.params[paramId] ?? def.defaultValue;
  const clamped = clampUltinaParam(paramId, Number.isFinite(value) ? value : previous);
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, ...values } } : f)),
    );
  return {
    type: "setUltinaParam",
    label: `VLYX ${paramId}`,
    execute: (d) => apply(d, { [paramId]: clamped }),
    undo: (d) => apply(d, { [paramId]: previous }),
  };
}

/** Apply an Ultina module preset in ONE undoable gesture (defaults + preset overrides). */
export function applyUltinaPreset(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  presetName: string,
  presetParams: Record<string, number>,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "ultina") throw new Error(`VLYX effect ${fxId} not found`);
  // Validate preset values against the vendored schema (same discipline as
  // setUltinaParam): presets are data — out-of-range values and unknown ids
  // from older schemas must be clamped/dropped, not written verbatim into
  // the doc and forwarded to the DSP.
  const nextParams: Record<string, number> = { ...buildUltinaDefaults() };
  for (const [id, value] of Object.entries(presetParams)) {
    if (!tryGetUltinaParamDef(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    nextParams[id] = clampUltinaParam(id, value);
  }
  const previousParams = { ...target.params };
  // Undo must restore a CANONICAL full map: the engine syncs only doc-
  // present keys to the DSP, so restoring the raw (possibly rack-only)
  // previous map would leave every preset deep param stuck in the worklet
  // while the document shows defaults.
  const undoParams: Record<string, number> = { ...buildUltinaDefaults(), ...previousParams };
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...values } } : f)),
    );
  return {
    type: "applyUltinaPreset",
    label: `VLYX preset ${presetName}`,
    execute: (d) => apply(d, nextParams),
    undo: (d) => apply(d, undoParams),
  };
}

/* ---------------- MORPH DYNAMICS editing + presets ---------------- */

/** Set any MORPH DYNAMICS param — schema-validated and clamped ("macro.pressure", "dyn.ratio", "routes.0.amount"…). */
export function setMorphDynamicsParam(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  paramId: string,
  value: number,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "morphdynamics") throw new Error(`MORPH effect ${fxId} not found`);
  const def = tryGetMorphParamDef(paramId);
  if (!def) throw new Error(`MORPH param ${paramId} not defined`);
  const previous = target.params[paramId] ?? def.defaultValue;
  const clamped = clampMorphParam(paramId, Number.isFinite(value) ? value : previous);
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, ...values } } : f)),
    );
  return {
    type: "setMorphDynamicsParam",
    label: `MORPH ${paramId}`,
    execute: (d) => apply(d, { [paramId]: clamped }),
    undo: (d) => apply(d, { [paramId]: previous }),
  };
}

/** Apply a MORPH DYNAMICS factory preset in ONE undoable gesture (defaults + preset overrides). */
export function applyMorphDynamicsPreset(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  presetName: string,
  presetParams: Record<string, number>,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "morphdynamics") throw new Error(`MORPH effect ${fxId} not found`);
  // Presets are data: unknown ids / non-finite values are dropped and every
  // survivor clamped through the schema (same discipline as setMorphDynamicsParam).
  const nextParams: Record<string, number> = { ...buildMorphDefaults() };
  for (const [id, value] of Object.entries(presetParams)) {
    if (!tryGetMorphParamDef(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    nextParams[id] = clampMorphParam(id, value);
  }
  const previousParams = { ...target.params };
  // Undo restores a CANONICAL full map (defaults + previous) so the doc and
  // the worklet cannot disagree after an undo across a preset boundary.
  const undoParams: Record<string, number> = { ...buildMorphDefaults(), ...previousParams };
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...values } } : f)),
    );
  return {
    type: "applyMorphDynamicsPreset",
    label: `MORPH preset ${presetName}`,
    execute: (d) => apply(d, nextParams),
    undo: (d) => apply(d, undoParams),
  };
}

/**
 * Store plugin EDITOR state (A/B snapshots, active slot…) on an effect.
 * Generic device-state slot: `null` clears. The payload is validated again
 * on load by the schema sanitizer, so a stale/corrupt blob can never leak
 * into the doc. One undo step per call.
 */
export function setDeviceState(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  state: import("../project-model/types").DeviceState | null,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  const nextState = state ? sanitizeDeviceState(state) : undefined;
  if (state && !nextState) throw new Error("Invalid device state " + state.kind);
  if (nextState) state = nextState;
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const prev = target.deviceState ? { kind: target.deviceState.kind, data: { ...target.deviceState.data } } : null;
  const apply = (d: ProjectDocument): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) =>
        f.id === fxId ? { ...f, deviceState: state ? { kind: state.kind, data: { ...state.data } } : undefined } : f,
      ),
    );
  return {
    type: "setDeviceState",
    label: state ? `Device state ${state.kind}` : "Clear device state",
    execute: (d) => apply(d),
    undo: (d) =>
      prev
        ? withTrackEffects(d, trackId, (effects) =>
            effects.map((f) => (f.id === fxId ? { ...f, deviceState: prev } : f)),
          )
        : withTrackEffects(d, trackId, (effects) =>
            effects.map((f) => (f.id === fxId ? { ...f, deviceState: undefined } : f)),
          ),
  };
}

/**
 * Activate a generic flagship A/B slot. The snapshot is restored against the
 * effect's authoritative schema and the active slot flips in the same
 * undoable command, matching Ultina's compare workflow.
 */
export function loadEffectAbSlot(doc: ProjectDocument, trackId: string, fxId: string, slot: "A" | "B"): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error("Effect " + fxId + " not found");
  const state = target.deviceState?.kind === "effect-ab-v1" ? target.deviceState : null;
  const snapshot = (state?.data.slots as Record<string, Record<string, number>> | undefined)?.[slot];
  if (!snapshot) throw new Error("A/B slot " + slot + " is empty");

  // FXEQ's schema depends on bandCount. Retain only the current shape hint;
  // every other value must come from the persisted snapshot, then normalize
  // from plugin defaults so stale values from the opposite slot cannot leak.
  const shapeSource: Record<string, unknown> = {
    ...(target.type === "fxeq" && target.params.bandCount !== undefined ? { bandCount: target.params.bandCount } : {}),
    ...snapshot,
  };
  const pluginParams = normalizePluginParams(target.type, shapeSource);
  const restored: Record<string, number> = pluginParams ?? { ...defaultParamsOf(target.type) };
  if (!pluginParams) {
    for (const [id, value] of Object.entries(snapshot)) {
      const def = EFFECT_META[target.type].params.find((param) => param.id === id);
      if (def && typeof value === "number" && Number.isFinite(value)) {
        restored[id] = clampEffectParam(target.type, id, value);
      }
    }
  }
  const nextDeviceState: DeviceState = {
    kind: "effect-ab-v1",
    data: { ...state!.data, active: slot },
  };
  const previousParams = { ...target.params };
  // Canonical undo (see applyUltinaPreset): overlay the previous partial
  // map on plugin defaults so every execute-written deep key reverts in
  // the DSP, not just the ones the previous doc map happened to contain.
  const undoParams = normalizePluginParams(target.type, previousParams) ?? previousParams;
  const previousState = target.deviceState ?? null;
  const apply = (d: ProjectDocument): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: restored, deviceState: nextDeviceState } : f)),
    );
  const restore = (d: ProjectDocument): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: undoParams, deviceState: previousState ?? undefined } : f)),
    );
  return {
    type: "loadEffectAbSlot",
    label: "A/B -> slot " + slot,
    execute: (d) => apply(d),
    undo: (d) => restore(d),
  };
}

/** Activate an Ultina A/B slot: restores the snapshot into real params
 * (exact restore — defaults + clamped snapshot) AND flips the active flag,
 * as ONE undoable gesture so an A/B compare is a single Ctrl+Z away.
 */
export function loadUltinaAbSlot(doc: ProjectDocument, trackId: string, fxId: string, slot: "A" | "B"): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "ultina") throw new Error(`VLYX effect ${fxId} not found`);
  const state = target.deviceState?.kind === "ultina-ab-v1" ? target.deviceState : null;
  const snapshot = (state?.data.slots as Record<string, Record<string, number>> | undefined)?.[slot];
  if (!snapshot) throw new Error(`A/B slot ${slot} is empty`);
  // Exact restore: defaults first, then every legal snapshot value clamped.
  const restored: Record<string, number> = { ...buildUltinaDefaults() };
  for (const [id, value] of Object.entries(snapshot)) {
    if (!tryGetUltinaParamDef(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    restored[id] = clampUltinaParam(id, value);
  }
  const nextDeviceState: import("../project-model/types").DeviceState = {
    kind: "ultina-ab-v1",
    data: { ...state!.data, active: slot },
  };
  const previousParams = { ...target.params };
  // Canonical undo (see applyUltinaPreset): full schema defaults + previous
  // partial map, so slot-written deep params revert in the DSP on Ctrl+Z.
  const undoParams: Record<string, number> = { ...buildUltinaDefaults(), ...previousParams };
  const previousState = target.deviceState ?? null;
  const apply = (d: ProjectDocument): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...restored }, deviceState: nextDeviceState } : f)),
    );
  const restore = (d: ProjectDocument): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: undoParams, deviceState: previousState ?? undefined } : f)),
    );
  return {
    type: "loadUltinaAbSlot",
    label: `A/B → slot ${slot}`,
    execute: (d) => apply(d),
    undo: (d) => restore(d),
  };
}

/** Apply a Mix Assistant proposal (module toggles + param changes) in ONE undoable gesture. */
export function applyUltinaProposal(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  label: string,
  toggles: { moduleType: string; enabled: boolean }[],
  changes: { parameterId: string; value: number }[],
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "ultina") throw new Error(`VLYX effect ${fxId} not found`);
  const nextParams = { ...target.params };
  // Analyzer output is untrusted input like any other parameter source:
  // route every toggle and change through the schema (clamped, unknown ids
  // dropped) instead of writing raw values into the doc.
  for (const t of toggles) {
    const id = `${t.moduleType}.enabled`;
    if (tryGetUltinaParamDef(id)) nextParams[id] = t.enabled ? 1 : 0;
  }
  for (const c of changes) {
    if (!tryGetUltinaParamDef(c.parameterId)) continue;
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) continue;
    nextParams[c.parameterId] = clampUltinaParam(c.parameterId, c.value);
  }
  const previousParams = { ...target.params };
  // Canonical undo: the proposal ADDS deep keys the doc never had, so the
  // raw previous map would strand those values in the DSP after Ctrl+Z —
  // overlay defaults so every touched key reverts visibly.
  const undoParams: Record<string, number> = { ...buildUltinaDefaults(), ...previousParams };
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...values } } : f)),
    );
  return {
    type: "applyUltinaProposal",
    label,
    execute: (d) => apply(d, nextParams),
    undo: (d) => apply(d, undoParams),
  };
}

/** Apply an Ozvena state patch (flattened dotted params) in ONE undoable gesture. */
export function applyOzvenaStatePatch(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  label: string,
  flatParams: Record<string, number>,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target || target.type !== "ozvena") throw new Error(`VØID effect ${fxId} not found`);
  const normalized = normalizePluginParams("ozvena", { ...target.params, ...flatParams });
  const nextParams = normalized ?? { ...target.params };
  const previousParams = { ...target.params };
  // Canonical undo (see applyUltinaPreset): patch-written deep paths must
  // revert in the DSP, which only sees doc-present keys.
  const undoParams = normalizePluginParams("ozvena", previousParams) ?? previousParams;
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...values } } : f)),
    );
  return {
    type: "applyOzvenaStatePatch",
    label,
    execute: (d) => apply(d, nextParams),
    undo: (d) => apply(d, undoParams),
  };
}
