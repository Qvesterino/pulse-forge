import type { EffectInstance, ProjectDocument, ReturnTrack, Track, AutomationTarget } from "./types";
import type { ParamDef } from "../effects/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import { buildSchema as buildFxEqSchema } from "../effects/fxeq-core/core/parameterSchema";
import { ALL_PARAMS, clampParam as clampUltinaParam } from "../effects/ultina-core/contracts/parameterSchema";
import { INSTRUMENT_DEFS, clampInstrumentParam } from "../instruments/registry";
import { defaultOzvenaStateV1 } from "../effects/ozvena-core/v2/types";
import { ozvenaParamRange } from "../effects/ozvena-params";

/** UI/engine-neutral parameter metadata for every valid modulation target. */
export interface TargetParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  format?: (value: number) => string;
}

function fromRackDef(def: ParamDef): TargetParamDef {
  return {
    id: def.id,
    label: def.label,
    min: def.min,
    max: def.max,
    default: def.default,
    unit: def.unit,
    format: def.format,
  };
}

function fromUltinaDef(def: (typeof ALL_PARAMS)[number]): TargetParamDef {
  return {
    id: def.id,
    label: def.name,
    min: def.minValue,
    max: def.maxValue,
    default: def.defaultValue,
    unit: def.unit,
  };
}

function fromFxEqDef(def: {
  id: string;
  name: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  unit?: string;
}): TargetParamDef {
  return {
    id: def.id,
    label: def.name,
    min: def.minValue,
    max: def.maxValue,
    default: def.defaultValue,
    unit: def.unit,
  };
}

function collectOzvenaTargetDefs(value: unknown, prefix = "", out: TargetParamDef[] = []): TargetParamDef[] {
  if (value === null || value === undefined || Array.isArray(value)) return out;
  if (typeof value === "number" || typeof value === "boolean") {
    if (!prefix) return out;
    const range = ozvenaParamRange(prefix, value);
    out.push({
      id: prefix,
      label: prefix.split(".").slice(-1)[0],
      min: range.min,
      max: range.max,
      default: typeof value === "boolean" ? (value ? 1 : 0) : value,
    });
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    collectOzvenaTargetDefs(child, prefix ? prefix + "." + key : key, out);
  }
  return out;
}

const OZVENA_TARGET_DEFS = [
  "global",
  "blendPad",
  "engines",
  "preDelay",
  "smoother",
  "preEq",
  "reverbEq",
  "mod",
  "duck",
  "convolution",
].flatMap((section) =>
  collectOzvenaTargetDefs(defaultOzvenaStateV1()[section as keyof ReturnType<typeof defaultOzvenaStateV1>], section),
);

// Enum paths are strings in the canonical Ozvena state, while the rack/UI
// transports them as numeric indices. Keep them explicit so the same target
// catalog validates UI edits, automation and MIDI without exposing analysis
// bookkeeping fields.
OZVENA_TARGET_DEFS.push(
  { id: "engines.e2.algo", label: "E2 Algorithm", min: 0, max: 2, default: 0 },
  { id: "engines.e3.algo", label: "E3 Algorithm", min: 0, max: 1, default: 1 },
  { id: "blendPad.engine2Algo", label: "Blend Algorithm", min: 0, max: 2, default: 0 },
  { id: "mod.mode", label: "Modulation Mode", min: 0, max: 1, default: 0 },
  { id: "convolution.mode", label: "Convolution Mode", min: 0, max: 2, default: 0 },
);

/** Return the track or return bus that owns a target id. */
export function targetOwner(doc: ProjectDocument, trackId: string): Track | ReturnTrack | undefined {
  return doc.tracks?.find((track) => track.id === trackId) ?? doc.returns?.find((ret) => ret.id === trackId);
}

export function targetEffectsOf(doc: ProjectDocument, trackId: string): EffectInstance[] {
  return targetOwner(doc, trackId)?.effects ?? [];
}

/**
 * Full parameter catalog for one effect instance.
 *
 * The rack registry remains the authority for ordinary effects. Flagship
 * plugins additionally expose their vendored schemas so deep editor params
 * are selectable by macros and automation instead of becoming dangling
 * strings that only the panel understands.
 */
export function effectTargetParamDefs(effect: EffectInstance): TargetParamDef[] {
  const seen = new Set<string>();
  const out: TargetParamDef[] = [];
  const push = (def: TargetParamDef) => {
    if (seen.has(def.id)) return;
    seen.add(def.id);
    out.push(def);
  };

  for (const def of EFFECT_DEFS[effect.type].params) push(fromRackDef(def));

  if (effect.type === "ultina") {
    for (const def of ALL_PARAMS) {
      if (def.automatable) push(fromUltinaDef(def));
    }
  } else if (effect.type === "fxeq") {
    const rawBandCount = effect.params.bandCount;
    const bandCount = Math.max(2, Math.min(6, Math.round(Number.isFinite(rawBandCount) ? rawBandCount : 6)));
    const schema = buildFxEqSchema(bandCount);
    for (const def of schema.defs) {
      if (def.automatable) push(fromFxEqDef(def));
    }
  } else if (effect.type === "ozvena") {
    for (const def of OZVENA_TARGET_DEFS) push(def);
  }

  return out;
}

export function instrumentTargetParamDefs(track: Extract<Track, { kind: "instrument" }>): TargetParamDef[] {
  return INSTRUMENT_DEFS[track.instrument].params.map(fromRackDef);
}

/** Resolve the legal metadata for one fully-qualified AutomationTarget. */
export function targetParamDef(doc: ProjectDocument, target: AutomationTarget): TargetParamDef | null {
  const owner = targetOwner(doc, target.trackId);
  if (!owner) return null;
  if (target.kind === "trackGain") return { id: "gain", label: "Volume", min: 0, max: 1.5, default: 1 };
  if (target.kind === "trackPan")
    return owner.kind === "return" ? null : { id: "pan", label: "Pan", min: -1, max: 1, default: 0 };
  if (target.kind === "instParam") {
    if (owner.kind !== "instrument" || !target.paramId) return null;
    return instrumentTargetParamDefs(owner).find((def) => def.id === target.paramId) ?? null;
  }
  if (!target.fxId || !target.paramId) return null;
  const effect = owner.effects.find((fx) => fx.id === target.fxId);
  if (!effect) return null;
  return effectTargetParamDefs(effect).find((def) => def.id === target.paramId) ?? null;
}

/** Strict target validation shared by commands, schema normalization and UI. */
export function isAutomationTargetValid(doc: ProjectDocument, target: AutomationTarget): boolean {
  return targetParamDef(doc, target) !== null;
}

/** Clamp at the target's authoritative range before values reach audio DSP. */
export function clampTargetValue(doc: ProjectDocument, target: AutomationTarget, value: number): number {
  const def = targetParamDef(doc, target);
  if (!def) return value;
  if (!Number.isFinite(value)) return def.default;
  if (target.kind === "fxParam") {
    const effect = targetEffectsOf(doc, target.trackId).find((fx) => fx.id === target.fxId);
    if (effect?.type === "ultina" && target.paramId) return clampUltinaParam(target.paramId, value);
    if (
      effect?.type &&
      target.paramId &&
      EFFECT_DEFS[effect.type].params.some((param) => param.id === target.paramId)
    ) {
      return clampEffectParam(effect.type, target.paramId, value);
    }
  }
  if (target.kind === "instParam") {
    const owner = targetOwner(doc, target.trackId);
    if (owner?.kind === "instrument" && target.paramId) {
      return clampInstrumentParam(owner.instrument, target.paramId, value);
    }
  }
  return Math.min(def.max, Math.max(def.min, value));
}
