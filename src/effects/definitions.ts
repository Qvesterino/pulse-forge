/**
 * Effect DEFINITIONS — pure parameter metadata for the 47 effect
 * types, split verbatim from registry.ts (cross-platform campaign GOAL 02/03).
 *
 * Node-pure by contract: no React, no Web Audio, no worklet loaders, no
 * storage. The project model (schema, targets) consumes this module so param
 * metadata never drags the audio runtime graph. The runtime `factory`
 * implementations stay in registry.ts; `EFFECT_DEFS` there merges this
 * metadata with the factories and re-exports keep the historical import path
 * stable. Vendored parameter schemas (fxeq/ultina/ozvena/morph cores) are
 * imported for defaults/normalization — they are DSP-oracle data, browser-free.
 */
import type { EffectType } from "../project-model/types";
import type { ParamDef } from "./types";
import { buildSchema as buildFxEqSchema } from "./fxeq-core/core/parameterSchema";
import {
  PARAM_BY_ID as ULTINA_PARAM_BY_ID,
  clampParam as clampUltinaParam,
  buildDefaultParams as buildUltinaDefaultParams,
} from "./ultina-core/contracts/parameterSchema";
import {
  PARAM_BY_ID as MORPH_PARAM_BY_ID,
  clampParam as clampMorphParam,
  buildDefaultParams as buildMorphDefaultParams,
} from "./morph-dynamics-core/contracts/parameterSchema";
import { snapCrossoverOrder } from "./fxeq-core/dsp/crossoverStage";
import { defaultOzvenaStateV1 } from "./ozvena-core/v2/types";
import { OZVENA_AUDIO_PARAM_SECTIONS, OZVENA_ENUM_VALUES, clampOzvenaParam } from "./ozvena-params";
import { LFO_SYNC_DIVISIONS } from "./tempo-sync";
import { CHARACTER_MODE_LABELS } from "./characterCurve";

export const formatDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

export const formatHz = (v: number) => `${Math.round(v)} Hz`;

export const formatMs = (v: number) => `${Math.round(v)} ms`;
/**
 * Seconds-stored params display in ms — scale ×1000 (GOAL 08/A2: the old
 * shared formatMs displayed raw seconds, so every dynamics attack/release
 * knob read "0 ms" for typical settings).
 */
export const formatSecMs = (v: number) => `${Math.round(v * 1000)} ms`;

export const formatPct = (v: number) => `${Math.round(v * 100)}%`;

export const formatSec = (v: number) => `${v.toFixed(2)} s`;

export const VOWEL_OPTIONS = [
  { value: 0, label: "A" },
  { value: 1, label: "E" },
  { value: 2, label: "I" },
  { value: 3, label: "O" },
  { value: 4, label: "U" },
];

export const OZVENA_QUALITY_OPTIONS = OZVENA_ENUM_VALUES["global.quality"].map((label, value) => ({ value, label }));

export const AUTOWAH_MODES = [
  { value: 0, label: "BP" },
  { value: 1, label: "LP" },
];

export const BEATMANGLER_MODES = [
  { value: 0, label: "NORM" },
  { value: 1, label: "HALF" },
  { value: 2, label: "2X" },
  { value: 3, label: "REV" },
];

export const GATE_DIVISIONS = [
  { value: 0, label: "1/1" },
  { value: 1, label: "1/2" },
  { value: 2, label: "1/4" },
  { value: 3, label: "1/8" },
  { value: 4, label: "1/16" },
  { value: 5, label: "1/32" },
];

export const MULTITAP_DIVISIONS = [
  { value: 0, label: "1/2" },
  { value: 1, label: "1/2T" },
  { value: 2, label: "1/4" },
  { value: 3, label: "1/4T" },
  { value: 4, label: "1/8" },
  { value: 5, label: "1/8T" },
  { value: 6, label: "1/16" },
  { value: 7, label: "1/16T" },
];

export const STUTTER_DIVISIONS = [
  { value: 0, label: "1/1" },
  { value: 1, label: "1/2" },
  { value: 2, label: "1/4" },
  { value: 3, label: "1/8" },
  { value: 4, label: "1/16" },
  { value: 5, label: "1/32" },
];

export const SVF_MODES = [
  { value: 0, label: "LP" },
  { value: 1, label: "HP" },
  { value: 2, label: "BP" },
  { value: 3, label: "Notch" },
];

export const TREMOLO_MODES = [
  { value: 0, label: "AM" },
  { value: 1, label: "Auto-Pan" },
];

export const PHASER_STAGE_COUNTS = [2, 4, 6, 8];

export const STOCK_DELAY_DIVISIONS = [
  { value: 0, label: "OFF" },
  { value: 1, label: "1/4" },
  { value: 2, label: "1/8" },
  { value: 3, label: "1/8T" },
  { value: 4, label: "1/16" },
  { value: 5, label: "1/16T" },
];

export const PUMP_DIVISIONS = [
  { value: 0, label: "1/1", mult: 1 / 4 },
  { value: 1, label: "1/2", mult: 1 / 2 },
  { value: 2, label: "1/4", mult: 1 },
  { value: 3, label: "1/8", mult: 2 },
  { value: 4, label: "1/16", mult: 4 },
];

export function collectStateLeafPaths(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (value === null || value === undefined || Array.isArray(value)) return out;
  if (typeof value !== "object") {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    collectStateLeafPaths(child, prefix ? prefix + "." + key : key, out);
  }
  return out;
}

export function flattenNumericState(
  value: unknown,
  prefix = "",
  out: Record<string, number> = {},
): Record<string, number> {
  if (value === null || value === undefined || Array.isArray(value)) return out;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  if (typeof value === "boolean") {
    if (prefix) out[prefix] = value ? 1 : 0;
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    flattenNumericState(child, prefix ? prefix + "." + key : key, out);
  }
  return out;
}

export const OZVENA_PARAM_SECTIONS = OZVENA_AUDIO_PARAM_SECTIONS;

export const OZVENA_DEFAULT_STATE = defaultOzvenaStateV1();

export const OZVENA_PARAM_PATHS = new Set(
  OZVENA_PARAM_SECTIONS.flatMap((section) => Array.from(collectStateLeafPaths(OZVENA_DEFAULT_STATE[section], section))),
);

export const OZVENA_DEFAULT_DEEP_PARAMS = OZVENA_PARAM_SECTIONS.reduce(
  (out, section) => flattenNumericState(OZVENA_DEFAULT_STATE[section], section, out),
  {} as Record<string, number>,
);

export const FXEQ_PARAM_DEFAULTS: Record<string, number> = {
  inputGainDb: 0,
  bandCount: 6,
  crossoverOrder: 4,
  crossoverEqualize: 1,
  mix: 100,
  outputGainDb: 0,
  limiterEnabled: 1,
  limiterCeilDb: -0.3,
};

export const ULTINA_PARAM_DEFAULTS: Record<string, number> = {
  "global.inputGainDb": 0,
  "global.mix": 100,
  "global.outputGainDb": 0,
  "comp.enabled": 0,
  "transient.enabled": 0,
  "unmask.enabled": 0,
  "exciter.enabled": 0,
};

export const MORPH_PARAM_DEFAULTS: Record<string, number> = {
  "global.inputGainDb": 0,
  "global.outputGainDb": 0,
  "global.mix": 100,
  "macro.pressure": 35,
  "macro.punch": 20,
  "macro.body": 50,
  "macro.texture": 50,
  "macro.motion": 35,
  "macro.space": 30,
};

export const EFFECT_ORDER: EffectType[] = [
  "eq",
  "msEq",
  "multiband",
  "compressor",
  "saturation",
  "tapeSat",
  "clipper",
  "limiter",
  "stepGate",
  "svFilter",
  "flanger",
  "tremolo",
  "autowah",
  "stutter",
  "comb",
  "vowel",
  "vocoder",
  "reverseSwell",
  "granularFreeze",
  "duckDelay",
  "kaskada",
  "multiTapDelay",
  "reverb",
  "delay",
  "pump",
  "distortion",
  "bitcrusher",
  "chorus",
  "phaser",
  "haasWidener",
  "sidechain",
  "transient",
  "drumBuss",
  "bassBuss",
  "utility",
  "gate",
  "shimmer",
  "fxeq",
  "ultina",
  "ozvena",
  "morphdynamics",
  "ringMod",
  "tapeStop",
  "freqShifter",
  "pitchShift",
  "vinyl",
  "beatMangler",
];

export const CORE_EFFECT_ORDER: EffectType[] = [
  "eq",
  "msEq",
  "multiband",
  "haasWidener",
  "transient",
  "limiter",
  "stepGate",
  "svFilter",
  "flanger",
  "tremolo",
  "autowah",
  "stutter",
  "comb",
  "vowel",
  "duckDelay",
  "multiTapDelay",
  "tapeSat",
  "vocoder",
  "reverseSwell",
  "granularFreeze",
  "drumBuss",
  "bassBuss",
  "utility",
  "gate",
  "sidechain",
  "chorus",
];

export const FLAGSHIP_EFFECT_ORDER: EffectType[] = ["fxeq", "ultina", "ozvena", "kaskada", "morphdynamics"];

export function defaultParamsOf(type: EffectType): Record<string, number> {
  return Object.fromEntries(EFFECT_META[type].params.map((p) => [p.id, p.default]));
}

export function clampEffectParam(type: EffectType, paramId: string, value: number): number {
  const def: ParamDef | undefined = EFFECT_META[type].params.find((p) => p.id === paramId);
  if (!def) return value;
  // A non-finite value must fall back to the default — Math.min/max both
  // return NaN unchanged, and a NaN reaching a factory's smooth() throws
  // TypeError in real browsers (setTargetAtTime), killing the engine sync.
  if (!Number.isFinite(value)) return def.default;
  const clamped = Math.min(def.max, Math.max(def.min, value));
  if (type === "fxeq" && paramId === "crossoverOrder") return snapCrossoverOrder(clamped);
  if (type === "fxeq" && paramId === "crossoverEqualize") return clamped >= 0.5 ? 1 : 0;
  return clamped;
}

export function normalizePluginParams(
  type: EffectType,
  source: Record<string, unknown>,
): Record<string, number> | null {
  if (type === "ultina") {
    // Vendored parameterSchema is the single source of truth (ranges,
    // defaults) for every ultina param, rack surface included.
    const params: Record<string, number> = {
      ...defaultParamsOf(type),
      ...buildUltinaDefaultParams(),
    };
    for (const [id, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (!ULTINA_PARAM_BY_ID.has(id)) continue; // unknown id from an older schema
      params[id] = clampUltinaParam(id, value);
    }
    return params;
  }
  if (type === "fxeq") {
    // The deep param surface depends on bandCount — read it first (validated
    // through the rack def), then build the band-aware schema.
    const rawBands = source.bandCount;
    const bandCount = Math.round(
      typeof rawBands === "number" && Number.isFinite(rawBands) ? clampEffectParam(type, "bandCount", rawBands) : 6,
    );
    const schema = buildFxEqSchema(bandCount);
    const params: Record<string, number> = { ...defaultParamsOf(type), ...schema.defaultParams };
    for (const def of schema.defs) {
      const value = source[def.id];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      params[def.id] = Math.min(def.maxValue, Math.max(def.minValue, value));
    }
    // The rack surface exposes the global wet/dry as `mix`, but the deep
    // schema (and therefore the DSP) only knows `globalMix`. Without this
    // alias the rack MIX slider was silently dropped on every command:
    // ProjectStore normalizes each execute(), the loop above only copies
    // schema ids, so `mix` reverted to the rack default 100 while a live
    // preview (which maps mix → globalMix in fxeqNode) kept playing the
    // dragged value. Accept the rack id as the source of truth.
    if (typeof source.mix === "number" && Number.isFinite(source.mix)) {
      params.mix = Math.min(100, Math.max(0, source.mix));
      params.globalMix = params.mix;
    }
    // Structural snap: the crossover slope only exists at {2,4,8} — a raw
    // in-between value from persisted state would hold the store and the
    // DSP apart until the next route.
    if (params.crossoverOrder !== undefined) {
      params.crossoverOrder = snapCrossoverOrder(params.crossoverOrder);
    }
    if (params.crossoverEqualize !== undefined) {
      params.crossoverEqualize = params.crossoverEqualize >= 0.5 ? 1 : 0;
    }
    return params;
  }
  if (type === "ozvena") {
    // Dotted paths consumed by the worklet's setPath, which validates at the
    // boundary (drops non-finite, walks only existing state branches, clamps
    // enum indices). Rack ids additionally clamp through the registry def.
    // Start from the complete audio parameter tree so loading an A/B slot is
    // a true restore rather than leaving deep parameters from the other slot.
    const params: Record<string, number> = { ...defaultParamsOf(type), ...OZVENA_DEFAULT_DEEP_PARAMS };
    for (const [id, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (!OZVENA_PARAM_PATHS.has(id)) continue;
      params[id] = clampOzvenaParam(id, value, OZVENA_DEFAULT_DEEP_PARAMS[id] ?? 0);
    }
    return params;
  }
  if (type === "morphdynamics") {
    // First-party parameterSchema is the single source of truth (ranges,
    // defaults) for every MORPH param — macros, engine sections and the 8
    // routes.N.* matrix slots all live in the flat numeric map.
    const params: Record<string, number> = {
      ...defaultParamsOf(type),
      ...buildMorphDefaultParams(),
    };
    for (const [id, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (!MORPH_PARAM_BY_ID.has(id)) continue; // unknown id from an older schema
      params[id] = clampMorphParam(id, value);
    }
    return params;
  }
  return null;
}

export const BEATMANGLE_REPEAT_DIVISIONS = [
  { value: 0, label: "1/1" },
  { value: 6, label: "1/2D" },
  { value: 1, label: "1/2" },
  { value: 7, label: "1/2T" },
  { value: 8, label: "1/4D" },
  { value: 2, label: "1/4" },
  { value: 9, label: "1/4T" },
  { value: 10, label: "1/8D" },
  { value: 3, label: "1/8" },
  { value: 11, label: "1/8T" },
  { value: 12, label: "1/16D" },
  { value: 4, label: "1/16" },
  { value: 13, label: "1/16T" },
  { value: 14, label: "1/32D" },
  { value: 5, label: "1/32" },
  { value: 15, label: "1/32T" },
];

export const BEATMANGLE_OFFSETS = Array.from({ length: 16 }, (_, value) => ({
  value,
  label: (() => {
    if (value === 0) return "0";
    let numerator = value;
    let denominator = 16;
    while (numerator % 2 === 0 && denominator % 2 === 0) {
      numerator /= 2;
      denominator /= 2;
    }
    return `+${numerator}/${denominator}`;
  })(),
}));

export const BEATMANGLE_GATE_DIVISIONS = BEATMANGLE_REPEAT_DIVISIONS;

export const REVERSE_SWELL_MAX_SEC = 8;

export const GRANULAR_FREEZE_MAX_WINDOW_SEC = 8;

export const eqParams: ParamDef[] = [
  { id: "hpFreq", label: "HP FREQ", min: 20, max: 1000, default: 20, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "lpFreq",
    label: "LP FREQ",
    min: 2000,
    max: 20000,
    default: 20000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  {
    id: "lowShelfFreq",
    label: "LOW SHELF FREQ",
    min: 40,
    max: 500,
    default: 120,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "lowShelfGain", label: "LOW SHELF", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  {
    id: "lowMidFreq",
    label: "LOW MID FREQ",
    min: 80,
    max: 2000,
    default: 400,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "lowMidGain", label: "LOW MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  { id: "lowMidQ", label: "LOW MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
  {
    id: "highMidFreq",
    label: "HIGH MID FREQ",
    min: 500,
    max: 8000,
    default: 2500,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "highMidGain", label: "HIGH MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  { id: "highMidQ", label: "HIGH MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
  {
    id: "highShelfFreq",
    label: "HIGH SHELF FREQ",
    min: 1500,
    max: 16000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "highShelfGain", label: "HIGH SHELF", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  // Legacy aliases remain in the registry so old documents and commands keep working.
  { id: "lowGain", label: "LOW", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  { id: "lowFreq", label: "LOW FREQ", min: 40, max: 400, default: 120, unit: "Hz", format: formatHz, taper: "log" },
  { id: "midGain", label: "MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  {
    id: "midFreq",
    label: "MID FREQ",
    min: 200,
    max: 4000,
    default: 1000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "midQ", label: "MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
  { id: "highGain", label: "HIGH", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
  {
    id: "highFreq",
    label: "HIGH FREQ",
    min: 1500,
    max: 12000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
];

export const msEqParams: ParamDef[] = [
  {
    id: "midLowFreq",
    label: "M LOW FREQ",
    min: 40,
    max: 500,
    default: 120,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "midLowGain", label: "M LOW", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  {
    id: "midHighFreq",
    label: "M HIGH FREQ",
    min: 1500,
    max: 12000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "midHighGain", label: "M HIGH", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  {
    id: "sideLowFreq",
    label: "S LOW FREQ",
    min: 40,
    max: 500,
    default: 120,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "sideLowGain", label: "S LOW", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  {
    id: "sideHighFreq",
    label: "S HIGH FREQ",
    min: 1500,
    max: 12000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "sideHighGain", label: "S HIGH", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const haasWidenerParams: ParamDef[] = [
  { id: "delayMs", label: "DELAY", min: 0.5, max: 40, default: 12, unit: "ms", format: formatMs },
  { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.7, format: formatPct },
  { id: "crossfeed", label: "CROSSFEED", min: 0, max: 1, default: 0.4, format: formatPct },
  {
    id: "invert",
    label: "INVERT",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "FLIP" : "NORMAL"),
    kind: "toggle",
  },
  { id: "feedback", label: "FEEDBACK", min: 0, max: 0.6, default: 0, format: formatPct },
];

export const multibandParams: ParamDef[] = [
  { id: "lowFreq", label: "LOW XOVER", min: 80, max: 800, default: 200, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "highFreq",
    label: "HIGH XOVER",
    min: 800,
    max: 8000,
    default: 2000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "lowGain", label: "LOW", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "midGain", label: "MID", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "highGain", label: "HIGH", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "comp", label: "COMP", min: 0, max: 1, default: 0, format: formatPct },
  {
    id: "soloLow",
    label: "SOLO LOW",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "soloMid",
    label: "SOLO MID",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "soloHigh",
    label: "SOLO HIGH",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const compressorParams: ParamDef[] = [
  { id: "threshold", label: "THRESH", min: -60, max: 0, default: -18, unit: "dB", format: formatDb },
  { id: "ratio", label: "RATIO", min: 1, max: 20, default: 3, format: (v) => `${v.toFixed(1)}:1` },
  { id: "attack", label: "ATTACK", min: 0.001, max: 0.5, default: 0.01, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.2, unit: "s", format: formatSecMs },
  { id: "knee", label: "KNEE", min: 0, max: 40, default: 6, unit: "dB", format: formatDb },
  {
    id: "detector",
    label: "DETECTOR",
    min: 0,
    max: 1,
    default: 0,
    options: [
      { value: 0, label: "RMS" },
      { value: 1, label: "PEAK" },
    ],
  },
  { id: "scHpf", label: "SC HPF", min: 20, max: 500, default: 20, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "autoRelease",
    label: "AUTO REL",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "makeup", label: "MAKEUP", min: 0, max: 24, default: 0, unit: "dB", format: formatDb },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const saturationParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.3, format: formatPct },
  {
    id: "character",
    label: "CHARACTER",
    min: 0,
    max: 4,
    default: 0,
    kind: "enum",
    step: 1,
    format: (v) => CHARACTER_MODE_LABELS[Math.max(0, Math.min(4, Math.round(v)))],
  },
  { id: "bias", label: "BIAS", min: -1, max: 1, default: 0, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 12000, default: 8000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "preHpfHz", label: "PRE HPF", min: 20, max: 400, default: 20, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const tapeSatParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.4, format: formatPct },
  { id: "hysteresis", label: "HYST", min: 0, max: 0.95, default: 0.3, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 12000, default: 6500, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const clipperParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  { id: "ceiling", label: "CEILING", min: -24, max: 0, default: -1, unit: "dB", format: formatDb },
  { id: "softness", label: "SOFTNESS", min: 0, max: 1, default: 0.2, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const reverbParams: ParamDef[] = [
  { id: "decay", label: "DECAY", min: 0.1, max: 6, default: 1.8, unit: "s", format: formatSec },
  { id: "predelay", label: "PRE-DLY", min: 0, max: 120, default: 20, unit: "ms", format: formatMs },
  { id: "tone", label: "TONE", min: 500, max: 12000, default: 9000, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "damping",
    label: "DAMPING",
    min: 500,
    max: 12000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "diffusion", label: "DIFFUSION", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "mod", label: "MOD", min: 0, max: 1, default: 0.35, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.3, format: formatPct },
];

export const delayParams: ParamDef[] = [
  { id: "time", label: "TIME", min: 30, max: 1000, default: 375, unit: "ms", format: formatMs },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: STOCK_DELAY_DIVISIONS.length - 1,
    default: 0,
    options: STOCK_DELAY_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },
  {
    id: "pingPong",
    label: "PING-PONG",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0.35, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 8000, default: 4000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.25, format: formatPct },
];

export const pumpParams: ParamDef[] = [
  { id: "amount", label: "AMOUNT", min: 0, max: 1, default: 0.5, format: formatPct },
  {
    id: "rate",
    label: "RATE",
    min: 0,
    max: PUMP_DIVISIONS.length - 1,
    default: 2,
    options: PUMP_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },
  { id: "release", label: "RELEASE", min: 0, max: 1, default: 0.5, format: formatPct },
];

export const distortionParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.4, format: formatPct },
  {
    id: "character",
    label: "CHARACTER",
    min: 0,
    max: 4,
    default: 3,
    kind: "enum",
    step: 1,
    format: (v) => CHARACTER_MODE_LABELS[Math.max(0, Math.min(4, Math.round(v)))],
  },
  { id: "bias", label: "BIAS", min: -1, max: 1, default: 0, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 12000, default: 5000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "preHpfHz", label: "PRE HPF", min: 20, max: 400, default: 20, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const bitcrusherParams: ParamDef[] = [
  {
    id: "bits",
    label: "BITS",
    min: 1,
    max: 16,
    default: 8,
    format: (v) => `${v.toFixed(0)} bit`,
    kind: "discrete",
    step: 1,
  },
  {
    id: "downsample",
    label: "CRUSH",
    min: 1,
    max: 50,
    default: 1,
    format: (v) => `${v.toFixed(0)}x`,
    kind: "discrete",
    step: 1,
  },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 18000, default: 18000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const chorusParams: ParamDef[] = [
  {
    id: "rate",
    label: "RATE",
    min: 0.1,
    max: 8,
    default: 0.6,
    unit: "Hz",
    format: (v) => `${v.toFixed(2)} Hz`,
    taper: "log",
  },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  { id: "depth", label: "DEPTH", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 1, format: formatPct },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.85, default: 0, format: formatPct },
  {
    id: "voices",
    label: "VOICES",
    min: 2,
    max: 4,
    default: 2,
    format: (v) => `${Math.round(v)}`,
    kind: "discrete",
    step: 1,
  },
  {
    id: "lfoShape",
    label: "LFO",
    min: 0,
    max: 2,
    default: 0,
    options: [
      { value: 0, label: "SINE" },
      { value: 1, label: "TRI" },
      { value: 2, label: "S&H" },
    ],
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
];

export const phaserParams: ParamDef[] = [
  {
    id: "rate",
    label: "RATE",
    min: 0.05,
    max: 8,
    default: 0.4,
    unit: "Hz",
    format: (v) => `${v.toFixed(2)} Hz`,
    taper: "log",
  },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  { id: "depth", label: "DEPTH", min: 0, max: 1, default: 0.6, format: formatPct },
  { id: "center", label: "CENTER", min: 200, max: 3000, default: 800, unit: "Hz", format: formatHz, taper: "log" },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0.3, format: formatPct },
  {
    id: "stages",
    label: "STAGES",
    min: 0,
    max: PHASER_STAGE_COUNTS.length - 1,
    default: 1,
    options: PHASER_STAGE_COUNTS.map((c, i) => ({ value: i, label: `${c}` })),
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
];

export const sidechainParams: ParamDef[] = [
  { id: "threshold", label: "THRESH", min: -60, max: 0, default: -18, unit: "dB", format: formatDb },
  { id: "ratio", label: "RATIO", min: 1, max: 20, default: 4, format: (v) => `${v.toFixed(1)}:1` },
  { id: "attack", label: "ATTACK", min: 0.001, max: 0.5, default: 0.005, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.2, unit: "s", format: formatSecMs },
  { id: "amount", label: "AMOUNT", min: 0, max: 1, default: 1, format: formatPct },
  {
    id: "splitFreq",
    label: "SPLIT",
    min: 0,
    max: 500,
    default: 0,
    unit: "Hz",
    format: (v) => (v <= 10 ? "OFF" : `${Math.round(v)} Hz`),
  },
];

export const transientParams: ParamDef[] = [
  { id: "attack", label: "ATTACK", min: -1, max: 1, default: 0.25, format: formatPct },
  { id: "sustain", label: "SUSTAIN", min: -1, max: 1, default: 0, format: formatPct },
  { id: "sensitivity", label: "SENSITIVITY", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
];

export const gateParams: ParamDef[] = [
  { id: "threshold", label: "THRESH", min: -80, max: 0, default: -36, unit: "dB", format: formatDb },
  { id: "hysteresis", label: "HYSTERESIS", min: 0, max: 1, default: 0.15, format: formatPct },
  { id: "attack", label: "ATTACK", min: 0.0001, max: 0.5, default: 0.002, unit: "s", format: formatSecMs },
  { id: "hold", label: "HOLD", min: 0, max: 1, default: 0.02, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.001, max: 2, default: 0.08, unit: "s", format: formatSecMs },
  { id: "range", label: "RANGE", min: -80, max: 0, default: -48, unit: "dB", format: formatDb },
  {
    id: "lookahead",
    label: "LOOKAHEAD",
    min: 0,
    max: 1,
    default: 1,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const shimmerParams: ParamDef[] = [
  { id: "amount", label: "AMOUNT", min: 0, max: 1, default: 0.35, format: formatPct },
  { id: "tone", label: "TONE", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "decay", label: "DECAY", min: 0, max: 1, default: 0.35, format: formatPct },
  {
    id: "shift",
    label: "SHIFT",
    min: -12,
    max: 12,
    default: 12,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} st`,
  },
  { id: "shimmer", label: "SHIMMER", min: 0, max: 1, default: 0.6, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.4, format: formatPct },
];

export const fxeqParams: ParamDef[] = [
  { id: "inputGainDb", label: "IN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  {
    id: "bandCount",
    label: "BANDS",
    min: 2,
    max: 6,
    default: 6,
    format: (v) => `${Math.round(v)}`,
    kind: "discrete",
    step: 1,
  },
  {
    id: "crossoverOrder",
    label: "SLOPE",
    min: 2,
    max: 8,
    default: 4,
    options: [
      { value: 2, label: "LR2 · 12 dB/oct" },
      { value: 4, label: "LR4 · 24 dB/oct" },
      { value: 8, label: "LR8 · 48 dB/oct" },
    ],
    format: (v) => {
      const snapped = snapCrossoverOrder(v);
      return snapped === 2 ? "LR2" : snapped === 8 ? "LR8" : "LR4";
    },
  },
  {
    id: "crossoverEqualize",
    label: "PHASE",
    min: 0,
    max: 1,
    default: 1,
    options: [
      { value: 1, label: "EQ · aligned" },
      { value: 0, label: "RAW · low CPU" },
    ],
    format: (v) => (v >= 0.5 ? "EQ" : "RAW"),
    kind: "toggle",
  },
  { id: "mix", label: "MIX", min: 0, max: 100, default: 100, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  { id: "outputGainDb", label: "OUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  {
    id: "limiterEnabled",
    label: "LIM",
    min: 0,
    max: 1,
    default: 1,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "limiterCeilDb", label: "CEIL", min: -6, max: 0, default: -0.3, unit: "dB", format: formatDb },
];

export const ultinaParams: ParamDef[] = [
  { id: "global.inputGainDb", label: "IN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  { id: "global.mix", label: "MIX", min: 0, max: 100, default: 100, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  { id: "global.outputGainDb", label: "OUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  {
    id: "comp.enabled",
    label: "COMP",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "transient.enabled",
    label: "ATTACK",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "exciter.enabled",
    label: "EDGE",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "unmask.enabled",
    label: "UNMASK",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
];

export const ozvenaParams: ParamDef[] = [
  { id: "global.inputGainDb", label: "IN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  { id: "blendPad.x", label: "PAD X", min: 0, max: 1, default: 0.5, format: (v) => v.toFixed(2) },
  { id: "blendPad.y", label: "PAD Y", min: 0, max: 1, default: 0.5, format: (v) => v.toFixed(2) },
  { id: "global.dryWet", label: "MIX", min: 0, max: 100, default: 25, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  { id: "global.outputGainDb", label: "OUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  {
    id: "engines.e1.enabled",
    label: "E1",
    min: 0,
    max: 1,
    default: 1,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "engines.e2.enabled",
    label: "E2",
    min: 0,
    max: 1,
    default: 1,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "engines.e3.enabled",
    label: "E3",
    min: 0,
    max: 1,
    default: 1,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "global.quality", label: "QUALITY", min: 0, max: 3, default: 1, options: OZVENA_QUALITY_OPTIONS },
];

export const morphdynamicsParams: ParamDef[] = [
  { id: "global.inputGainDb", label: "IN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  { id: "global.mix", label: "MIX", min: 0, max: 100, default: 100, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  {
    id: "macro.pressure",
    label: "PRESSURE",
    min: 0,
    max: 100,
    default: 35,
    unit: "%",
    format: (v) => `${v.toFixed(0)}%`,
  },
  {
    id: "macro.punch",
    label: "PUNCH",
    min: -100,
    max: 100,
    default: 20,
    unit: "%",
    format: (v) => `${v.toFixed(0)}%`,
  },
  { id: "macro.body", label: "BODY", min: 0, max: 100, default: 50, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  {
    id: "macro.texture",
    label: "TEXTURE",
    min: 0,
    max: 100,
    default: 50,
    unit: "%",
    format: (v) => `${v.toFixed(0)}%`,
  },
  {
    id: "macro.motion",
    label: "MOTION",
    min: 0,
    max: 100,
    default: 35,
    unit: "%",
    format: (v) => `${v.toFixed(0)}%`,
  },
  { id: "macro.space", label: "SPACE", min: 0, max: 100, default: 30, unit: "%", format: (v) => `${v.toFixed(0)}%` },
  { id: "global.outputGainDb", label: "OUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
];

export const drumBussParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.22, format: formatPct },
  { id: "transient", label: "TRANSIENT", min: -1, max: 1, default: 0.15, format: formatPct },
  { id: "compressor", label: "COMPRESSOR", min: 0, max: 1, default: 0.25, format: formatPct },
  { id: "tone", label: "TONE", min: 300, max: 16000, default: 9000, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "boomFrequency",
    label: "BOOM FREQ",
    min: 30,
    max: 160,
    default: 60,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "boomAmount", label: "BOOM", min: 0, max: 1, default: 0.12, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -18, max: 18, default: 0, unit: "dB", format: formatDb },
];

export const bassBussParams: ParamDef[] = [
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.16, format: formatPct },
  { id: "subEnhance", label: "SUB", min: 0, max: 1, default: 0.2, format: formatPct },
  { id: "subOsc", label: "SUB OSC", min: 0, max: 1, default: 0, format: formatPct },
  {
    id: "subFrequency",
    label: "SUB FREQ",
    min: 20,
    max: 160,
    default: 70,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "compression", label: "COMPRESSION", min: 0, max: 1, default: 0.25, format: formatPct },
  { id: "attack", label: "ATTACK", min: 0.001, max: 0.2, default: 0.01, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.18, unit: "s", format: formatSecMs },
  {
    id: "monoBassFrequency",
    label: "MONO BASS",
    min: 0,
    max: 160,
    default: 100,
    unit: "Hz",
    format: (v) => (v <= 0 ? "OFF" : formatHz(v)),
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  { id: "output", label: "OUTPUT", min: -18, max: 18, default: 0, unit: "dB", format: formatDb },
];

export const utilityParams: ParamDef[] = [
  { id: "gain", label: "GAIN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  {
    id: "pan",
    label: "PAN",
    min: -1,
    max: 1,
    default: 0,
    format: (v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`),
  },
  { id: "width", label: "WIDTH", min: 0, max: 2, default: 1, format: (v) => `${Math.round(v * 100)}%` },
  {
    id: "monoBassFrequency",
    label: "MONO BASS",
    min: 0,
    max: 200,
    default: 0,
    unit: "Hz",
    format: (v) => (v <= 0 ? "OFF" : formatHz(v)),
  },
  {
    id: "phaseLeft",
    label: "PHASE L",
    min: 0,
    max: 1,
    default: 0,
    options: [
      { value: 0, label: "NORMAL" },
      { value: 1, label: "INVERT" },
    ],
    kind: "toggle",
  },
  {
    id: "phaseRight",
    label: "PHASE R",
    min: 0,
    max: 1,
    default: 0,
    options: [
      { value: 0, label: "NORMAL" },
      { value: 1, label: "INVERT" },
    ],
    kind: "toggle",
  },
  {
    id: "dcBlock",
    label: "DC BLOCK",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
];

export const limiterParams: ParamDef[] = [
  { id: "ceiling", label: "CEILING", min: -12, max: 0, default: -1, unit: "dB", format: formatDb },
  { id: "threshold", label: "THRESHOLD", min: -24, max: 0, default: -6, unit: "dB", format: formatDb },
  { id: "release", label: "RELEASE", min: 0.01, max: 1, default: 0.12, unit: "s", format: formatSecMs },
  { id: "lookaheadMs", label: "LOOKAHEAD", min: 1, max: 20, default: 5, unit: "ms", format: formatMs },
  { id: "link", label: "LINK", min: 0, max: 1, default: 1, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const stepGateParams: ParamDef[] = [
  { id: "division", label: "RATE", min: 0, max: 5, default: 4, options: GATE_DIVISIONS },
  { id: "depth", label: "DEPTH", min: 0, max: 1, default: 1, format: formatPct },
  { id: "smooth", label: "SMOOTH", min: 0, max: 1, default: 0.15, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const svFilterParams: ParamDef[] = [
  { id: "cutoff", label: "CUTOFF", min: 20, max: 20000, default: 2000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "resonance", label: "RESO", min: 0, max: 1, default: 0.3, format: formatPct },
  { id: "mode", label: "MODE", min: 0, max: 3, default: 0, options: SVF_MODES },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const flangerParams: ParamDef[] = [
  {
    id: "rate",
    label: "RATE",
    min: 0.05,
    max: 10,
    default: 0.5,
    unit: "Hz",
    format: (v) => `${v.toFixed(2)} Hz`,
    taper: "log",
  },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  { id: "depth", label: "DEPTH", min: 0, max: 10, default: 3, unit: "ms", format: formatMs },
  { id: "base", label: "BASE", min: 0.5, max: 20, default: 5, unit: "ms", format: formatMs },
  { id: "feedback", label: "FEEDBACK", min: 0, max: 0.95, default: 0.4, format: formatPct },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.7, format: formatPct },
  {
    id: "invert",
    label: "INVERT",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "TZF" : "NORMAL"),
    kind: "toggle",
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
];

export const tremoloParams: ParamDef[] = [
  {
    id: "rate",
    label: "RATE",
    min: 0.1,
    max: 20,
    default: 5,
    unit: "Hz",
    format: (v) => `${v.toFixed(1)} Hz`,
    taper: "log",
  },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  { id: "depth", label: "DEPTH", min: 0, max: 1, default: 0.7, format: formatPct },
  {
    id: "shape",
    label: "SHAPE",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v < 0.3 ? "Sine" : v < 0.7 ? "Blend" : "Square"),
  },
  { id: "mode", label: "MODE", min: 0, max: 1, default: 0, options: TREMOLO_MODES },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const autowahParams: ParamDef[] = [
  { id: "minFreq", label: "MIN FREQ", min: 100, max: 2000, default: 300, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "maxFreq",
    label: "MAX FREQ",
    min: 500,
    max: 8000,
    default: 2500,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "resonance", label: "RESO", min: 0, max: 1, default: 0.7, format: formatPct },
  { id: "attack", label: "ATTACK", min: 0.001, max: 0.1, default: 0.01, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.05, max: 1, default: 0.15, unit: "s", format: formatSecMs },
  { id: "sensitivity", label: "SENSITIVITY", min: 0.5, max: 3, default: 1.5, format: (v) => v.toFixed(2) },
  { id: "mode", label: "MODE", min: 0, max: 1, default: 0, options: AUTOWAH_MODES },
  {
    id: "direction",
    label: "DIRECTION",
    min: 0,
    max: 1,
    default: 0,
    options: [
      { value: 0, label: "UP" },
      { value: 1, label: "DOWN" },
    ],
  },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const stutterParams: ParamDef[] = [
  { id: "division", label: "RATE", min: 0, max: 5, default: 4, options: STUTTER_DIVISIONS },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.8, format: formatPct },
  { id: "feedback", label: "FEEDBACK", min: 0, max: 0.7, default: 0, format: formatPct },
  { id: "smooth", label: "SMOOTH", min: 0, max: 0.02, default: 0.003, unit: "s", format: formatSecMs },
];

export const combParams: ParamDef[] = [
  { id: "delayMs", label: "DELAY", min: 0.5, max: 60, default: 12, unit: "ms", format: formatMs },
  {
    id: "feedback",
    label: "FEEDBACK",
    min: -0.95,
    max: 0.95,
    default: 0.5,
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`,
  },
  { id: "damp", label: "DAMP", min: 500, max: 12000, default: 6500, unit: "Hz", format: formatHz, taper: "log" },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.25, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
];

export const vowelParams: ParamDef[] = [
  {
    id: "vowel",
    label: "VOWEL",
    min: 0,
    max: 4,
    default: 0,
    options: VOWEL_OPTIONS,
    format: (v) => VOWEL_OPTIONS[Math.round(v)]?.label ?? v.toFixed(2),
  },
  { id: "resonance", label: "RESO", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const duckDelayParams: ParamDef[] = [
  { id: "time", label: "TIME", min: 30, max: 1000, default: 375, unit: "ms", format: formatMs },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0.35, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 8000, default: 4000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "duckAmount", label: "DUCK", min: 0, max: 1, default: 0.7, format: formatPct },
  { id: "duckThresh", label: "THRESH", min: -60, max: 0, default: -24, unit: "dB", format: formatDb },
  { id: "duckAttack", label: "DUCK ATK", min: 0.001, max: 0.5, default: 0.005, unit: "s", format: formatSecMs },
  { id: "duckRelease", label: "DUCK REL", min: 0.02, max: 1, default: 0.18, unit: "s", format: formatSecMs },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: 5,
    default: 0,
    options: [
      { value: 0, label: "OFF" },
      { value: 1, label: "1/4" },
      { value: 2, label: "1/8" },
      { value: 3, label: "1/8T" },
      { value: 4, label: "1/16" },
      { value: 5, label: "1/16T" },
    ],
  },
  {
    id: "pingpong",
    label: "PING-PONG",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "loopHpfHz", label: "LOOP HPF", min: 20, max: 400, default: 40, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.3, format: formatPct },
];

export const ringModParams: ParamDef[] = [
  {
    id: "frequency",
    label: "CARRIER",
    min: 0.1,
    max: 2000,
    default: 220,
    unit: "Hz",
    format: (v) => (v >= 100 ? `${Math.round(v)} Hz` : `${v.toFixed(1)} Hz`),
    taper: "log",
  },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0, format: formatPct },
  {
    id: "xmode",
    label: "X-MODE",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v >= 0.5 ? "X" : "RING"),
    kind: "toggle",
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const tapeStopParams: ParamDef[] = [
  {
    id: "engaged",
    label: "ENGAGE",
    min: 0,
    max: 1,
    default: 0,
    kind: "toggle",
    options: [
      { value: 0, label: "Armed" },
      { value: 1, label: "On" },
    ],
    format: (v) => (v > 0.5 ? "ON" : "ARMED"),
  },
  { id: "time", label: "TIME", min: 0.1, max: 8, default: 1.5, unit: "s", format: (v) => `${v.toFixed(1)} s` },
  {
    id: "curve",
    label: "CURVE",
    min: 0,
    max: 1,
    default: 0,
    kind: "enum",
    options: [
      { value: 0, label: "Exponential" },
      { value: 1, label: "Linear" },
    ],
    format: (v) => (v < 0.5 ? "Exp" : "Lin"),
  },
  {
    id: "spin",
    label: "SPIN",
    min: 0,
    max: 1,
    default: 0,
    kind: "enum",
    options: [
      { value: 0, label: "Stop" },
      { value: 1, label: "Reverse" },
    ],
    format: (v) => (v > 0.5 ? "REV" : "STOP"),
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const freqShifterParams: ParamDef[] = [
  {
    id: "shift",
    label: "SHIFT",
    min: -1000,
    max: 1000,
    default: 120,
    unit: "Hz",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} Hz`,
  },
  {
    id: "fine",
    label: "FINE",
    min: -50,
    max: 50,
    default: 0,
    unit: "Hz",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} Hz`,
  },
  {
    id: "side",
    label: "SIDE",
    min: 0,
    max: 2,
    default: 0,
    options: [
      { value: 0, label: "UPPER" },
      { value: 1, label: "LOWER" },
      { value: 2, label: "BOTH" },
    ],
  },
  {
    id: "lfoRate",
    label: "LFO RATE",
    min: 0.01,
    max: 10,
    default: 0.1,
    unit: "Hz",
    taper: "log",
    format: (v) => (v < 1 ? `${v.toFixed(2)} Hz` : `${v.toFixed(1)} Hz`),
  },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  {
    id: "lfoDepth",
    label: "LFO DEPTH",
    min: 0,
    max: 500,
    default: 0,
    unit: "Hz",
    format: (v) => `${Math.round(v)} Hz`,
  },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0, format: formatPct },
  {
    id: "delayTime",
    label: "ECHO",
    min: 1,
    max: 100,
    default: 30,
    unit: "ms",
    format: formatMs,
  },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 16000, default: 16000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const multiTapDelayParams: ParamDef[] = [
  {
    id: "taps",
    label: "TAPS",
    min: 1,
    max: 4,
    default: 3,
    format: (v) => `${Math.round(v)}`,
    kind: "discrete",
    step: 1,
  },
  { id: "t1Div", label: "T1 DIV", min: 0, max: 7, default: 4, options: MULTITAP_DIVISIONS },
  { id: "t2Div", label: "T2 DIV", min: 0, max: 7, default: 6, options: MULTITAP_DIVISIONS },
  { id: "t3Div", label: "T3 DIV", min: 0, max: 7, default: 2, options: MULTITAP_DIVISIONS },
  { id: "t4Div", label: "T4 DIV", min: 0, max: 7, default: 0, options: MULTITAP_DIVISIONS },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.7, format: formatPct },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.85, default: 0.3, format: formatPct },
  { id: "tone", label: "TONE", min: 500, max: 8000, default: 4500, unit: "Hz", format: formatHz, taper: "log" },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.3, format: formatPct },
];

export const pitchShiftParams: ParamDef[] = [
  {
    id: "semitones",
    label: "PITCH",
    min: -12,
    max: 12,
    default: -3,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} st`,
  },
  {
    id: "fine",
    label: "FINE",
    min: -50,
    max: 50,
    default: 0,
    unit: "ct",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`,
  },
  { id: "grainMs", label: "GRAIN", min: 20, max: 120, default: 55, unit: "ms", format: (v) => `${Math.round(v)} ms` },
  { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const vinylParams: ParamDef[] = [
  // Master macro first — the "one knob" path for people who just want AGE.
  { id: "amount", label: "AGE", min: 0, max: 1, default: 0.5, format: formatPct },
  // Crackle module
  { id: "crackle", label: "CRACKLE", min: 0, max: 1, default: 0.5, format: formatPct },
  {
    id: "crackleTone",
    label: "POP TONE",
    min: 400,
    max: 9000,
    default: 2200,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "crackleDecay", label: "POP DECAY", min: 0, max: 1, default: 0.5, format: formatPct },
  // Surface noise module
  { id: "hiss", label: "HISS", min: 0, max: 1, default: 0.35, format: formatPct },
  {
    id: "hissTone",
    label: "HISS TONE",
    min: 1000,
    max: 16000,
    default: 6000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  // Motor rumble module
  { id: "rumble", label: "RUMBLE", min: 0, max: 1, default: 0, format: formatPct },
  {
    id: "rumbleTone",
    label: "RUMBLE FREQ",
    min: 30,
    max: 120,
    default: 60,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  // Pitch wobble module
  {
    id: "wowRate",
    label: "WOW RATE",
    min: 0.2,
    max: 4,
    default: 0.7,
    unit: "Hz",
    format: (v) => `${v.toFixed(2)} Hz`,
    taper: "log",
  },
  { id: "wow", label: "WOW", min: 0, max: 1, default: 0.5, format: formatPct },
  {
    id: "flutterRate",
    label: "FLUTTER RATE",
    min: 4,
    max: 30,
    default: 11,
    unit: "Hz",
    format: (v) => `${v.toFixed(1)} Hz`,
    taper: "log",
  },
  { id: "flutter", label: "FLUTTER", min: 0, max: 1, default: 0.3, format: formatPct },
  // Gear character
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  {
    id: "year",
    label: "YEAR",
    min: 0,
    max: 1,
    default: 0.8,
    format: (v) => `${Math.round(2020 - v * 100)}`,
  },
  {
    id: "toneLp",
    label: "LP TRIM",
    min: 1000,
    max: 16000,
    default: 16000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "toneHp", label: "HP TRIM", min: 10, max: 400, default: 20, unit: "Hz", format: formatHz, taper: "log" },
  { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.6, format: formatPct },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const beatManglerParams: ParamDef[] = [
  {
    id: "playMode",
    label: "MODE",
    min: 0,
    max: 3,
    default: 0,
    options: BEATMANGLER_MODES,
  },
  {
    id: "repeatFill",
    label: "FILL",
    min: 0,
    max: 8,
    default: 0,
    format: (v) => (v < 2 ? "OFF" : `${Math.round(v)}×`),
    kind: "discrete",
    step: 1,
  },
  {
    id: "trigger",
    label: "REPEAT",
    min: 0,
    max: 1,
    default: 0,
    options: [
      { value: 0, label: "OFF" },
      { value: 1, label: "ON" },
    ],
    kind: "toggle",
  },
  {
    id: "interval",
    label: "INTERVAL",
    min: 0,
    max: 15,
    default: 0,
    options: BEATMANGLE_REPEAT_DIVISIONS,
  },
  {
    id: "offset",
    label: "OFFSET",
    min: 0,
    max: 15,
    default: 0,
    options: BEATMANGLE_OFFSETS,
  },
  { id: "chance", label: "CHANCE", min: 0, max: 1, default: 1, format: formatPct },
  {
    id: "gate",
    label: "GATE",
    min: 0,
    max: 15,
    default: 2,
    options: BEATMANGLE_GATE_DIVISIONS,
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const vocoderParams: ParamDef[] = [
  {
    id: "bands",
    label: "BANDS",
    min: 8,
    max: 16,
    default: 16,
    format: (v) => `${Math.round(v)}`,
    kind: "discrete",
    step: 1,
  },
  { id: "loFreq", label: "LO BAND", min: 60, max: 500, default: 120, unit: "Hz", format: formatHz, taper: "log" },
  {
    id: "hiFreq",
    label: "HI BAND",
    min: 2000,
    max: 12000,
    default: 7000,
    unit: "Hz",
    format: formatHz,
    taper: "log",
  },
  { id: "q", label: "SHARPNESS", min: 1, max: 16, default: 4, format: (v) => v.toFixed(1) },
  { id: "attack", label: "ATTACK", min: 0.001, max: 0.2, default: 0.004, unit: "s", format: formatSecMs },
  { id: "release", label: "RELEASE", min: 0.005, max: 1, default: 0.06, unit: "s", format: formatSecMs },
  {
    id: "shift",
    label: "FORMANT",
    min: -24,
    max: 24,
    default: 0,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} st`,
  },
  { id: "sibilance", label: "SIBILANCE", min: 0, max: 1, default: 0.35, format: formatPct },
  { id: "stereo", label: "STEREO", min: 0, max: 1, default: 0.6, format: formatPct },
  { id: "level", label: "LEVEL", min: -24, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const reverseSwellParams: ParamDef[] = [
  { id: "engaged", label: "ENGAGE", min: 0, max: 1, default: 0, format: (v) => (v > 0.5 ? "ON" : "ARMED") },
  {
    id: "time",
    label: "SWELL",
    min: 0.25,
    max: REVERSE_SWELL_MAX_SEC,
    default: 2,
    unit: "s",
    format: (v) => `${v.toFixed(2)} s`,
  },
  {
    id: "reach",
    label: "REACH",
    min: 0.25,
    max: REVERSE_SWELL_MAX_SEC,
    default: 2,
    unit: "s",
    format: (v) => `${v.toFixed(2)} s`,
  },
  {
    id: "curve",
    label: "CURVE",
    min: 0,
    max: 1,
    default: 0.6,
    format: (v) => (v < 0.05 ? "Lin" : `^${(1 + v * 4).toFixed(1)}`),
  },
  { id: "tone", label: "TONE", min: 500, max: 16000, default: 12000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "level", label: "LEVEL", min: -24, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const granularFreezeParams: ParamDef[] = [
  { id: "freeze", label: "FREEZE", min: 0, max: 1, default: 0, format: (v) => (v > 0.5 ? "HELD" : "LIVE") },
  {
    id: "window",
    label: "WINDOW",
    min: 0.2,
    max: GRANULAR_FREEZE_MAX_WINDOW_SEC,
    default: 2,
    unit: "s",
    format: (v) => `${v.toFixed(2)} s`,
  },
  { id: "position", label: "POSITION", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "drift", label: "DRIFT", min: 0, max: 1, default: 0.2, format: formatPct },
  {
    id: "grainMs",
    label: "GRAIN",
    min: 20,
    max: 400,
    default: 90,
    unit: "ms",
    format: (v) => `${Math.round(v)} ms`,
  },
  { id: "scatter", label: "SCATTER", min: 0, max: 1, default: 0.3, format: formatPct },
  {
    id: "pitch",
    label: "PITCH",
    min: -24,
    max: 24,
    default: 0,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} st`,
  },
  { id: "tone", label: "TONE", min: 500, max: 16000, default: 10000, unit: "Hz", format: formatHz, taper: "log" },
  { id: "level", label: "LEVEL", min: -24, max: 12, default: 0, unit: "dB", format: formatDb },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
];

export const kaskadaParams: ParamDef[] = [
  { id: "time", label: "TIME", min: 30, max: 2000, default: 375, unit: "ms", format: formatMs },
  {
    id: "sync",
    label: "SYNC",
    min: 0,
    max: 5,
    default: 0,
    options: [
      { value: 0, label: "OFF" },
      { value: 1, label: "1/4" },
      { value: 2, label: "1/8" },
      { value: 3, label: "1/8T" },
      { value: 4, label: "1/16" },
      { value: 5, label: "1/16T" },
    ],
  },
  {
    id: "pingPong",
    label: "PING-PONG",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "reverse",
    label: "REVERSE",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "feedback", label: "FEEDBK", min: 0, max: 0.95, default: 0.35, format: formatPct },
  { id: "toneLp", label: "TONE LP", min: 500, max: 12000, default: 4500, unit: "Hz", format: formatHz, taper: "log" },
  { id: "toneHp", label: "TONE HP", min: 20, max: 800, default: 150, unit: "Hz", format: formatHz, taper: "log" },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
  {
    id: "modRate",
    label: "MOD RATE",
    min: 0.1,
    max: 8,
    default: 0.6,
    unit: "Hz",
    format: (v) => `${v.toFixed(1)} Hz`,
    taper: "log",
  },
  { id: "modDepth", label: "MOD DEPTH", min: 0, max: 1, default: 0.15, format: formatPct },
  { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.8, format: formatPct },
  {
    id: "freeze",
    label: "FREEZE",
    min: 0,
    max: 2,
    default: 0,
    options: [
      { value: 0, label: "OFF" },
      { value: 1, label: "LOOP" },
      { value: 2, label: "HOLD" },
    ],
  },
  {
    id: "unmaskOn",
    label: "UNMASK",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "unmask", label: "U-AMOUNT", min: 0, max: 1, default: 0.6, format: formatPct },
  { id: "unmaskSens", label: "U-SENS", min: 0, max: 1, default: 0.5, format: formatPct },
  { id: "unmaskAtk", label: "U-ATK", min: 0.1, max: 100, default: 5, unit: "ms", format: formatMs },
  { id: "unmaskRel", label: "U-REL", min: 10, max: 2000, default: 250, unit: "ms", format: formatMs },
  {
    id: "character",
    label: "CHARACTER",
    min: 0,
    max: 4,
    default: 1,
    options: [
      { value: 0, label: "DIGITAL" },
      { value: 1, label: "TAPE" },
      { value: 2, label: "ANALOG" },
      { value: 3, label: "DRUM" },
      { value: 4, label: "DIFFUSE" },
    ],
  },
  { id: "mix", label: "MIX", min: 0, max: 1, default: 0.25, format: formatPct },
  {
    id: "soloWet",
    label: "SOLO W",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  {
    id: "deltaListen",
    label: "DELTA",
    min: 0,
    max: 1,
    default: 0,
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    kind: "toggle",
  },
  { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
];

/* ---------------- pure registry ---------------- */

/** Metadata half of an effect definition (params without the runtime). */
export interface EffectDefinitionMeta {
  type: EffectType;
  name: string;
  category: "tone" | "dynamics" | "character" | "space" | "movement";
  params: ParamDef[];
}

/** type/name/category/params for every effect type — no runtime attached. */
export const EFFECT_META: Record<EffectType, EffectDefinitionMeta> = {
  eq: { type: "eq", name: "EQ", category: "tone", params: eqParams },
  msEq: { type: "msEq", name: "M/S EQ", category: "tone", params: msEqParams },
  haasWidener: { type: "haasWidener", name: "Haas Widener", category: "movement", params: haasWidenerParams },
  multiband: { type: "multiband", name: "Multiband", category: "tone", params: multibandParams },
  compressor: { type: "compressor", name: "Compressor", category: "dynamics", params: compressorParams },
  saturation: { type: "saturation", name: "Saturation", category: "character", params: saturationParams },
  tapeSat: { type: "tapeSat", name: "Tape Sat", category: "character", params: tapeSatParams },
  clipper: { type: "clipper", name: "Clipper", category: "character", params: clipperParams },
  reverb: { type: "reverb", name: "Reverb", category: "space", params: reverbParams },
  delay: { type: "delay", name: "Delay", category: "space", params: delayParams },
  pump: { type: "pump", name: "Pump", category: "movement", params: pumpParams },
  distortion: { type: "distortion", name: "Distortion", category: "character", params: distortionParams },
  bitcrusher: { type: "bitcrusher", name: "Bitcrusher", category: "character", params: bitcrusherParams },
  chorus: { type: "chorus", name: "Chorus", category: "movement", params: chorusParams },
  phaser: { type: "phaser", name: "Phaser", category: "movement", params: phaserParams },
  sidechain: { type: "sidechain", name: "Sidechain", category: "dynamics", params: sidechainParams },
  transient: { type: "transient", name: "Transient Shaper", category: "dynamics", params: transientParams },
  gate: { type: "gate", name: "Gate", category: "dynamics", params: gateParams },
  shimmer: { type: "shimmer", name: "Shimmer", category: "character", params: shimmerParams },
  fxeq: { type: "fxeq", name: "PRISM", category: "character", params: fxeqParams },
  ultina: { type: "ultina", name: "VLYX", category: "dynamics", params: ultinaParams },
  ozvena: { type: "ozvena", name: "VØID", category: "space", params: ozvenaParams },
  morphdynamics: { type: "morphdynamics", name: "MORPH", category: "dynamics", params: morphdynamicsParams },
  drumBuss: { type: "drumBuss", name: "Drum Buss", category: "character", params: drumBussParams },
  bassBuss: { type: "bassBuss", name: "Bass Buss", category: "character", params: bassBussParams },
  utility: { type: "utility", name: "Utility", category: "tone", params: utilityParams },
  limiter: { type: "limiter", name: "Limiter", category: "dynamics", params: limiterParams },
  stepGate: { type: "stepGate", name: "Step Gate", category: "movement", params: stepGateParams },
  svFilter: { type: "svFilter", name: "SV Filter", category: "tone", params: svFilterParams },
  flanger: { type: "flanger", name: "Flanger", category: "movement", params: flangerParams },
  tremolo: { type: "tremolo", name: "Tremolo", category: "movement", params: tremoloParams },
  autowah: { type: "autowah", name: "Autowah", category: "movement", params: autowahParams },
  stutter: { type: "stutter", name: "Stutter", category: "movement", params: stutterParams },
  comb: { type: "comb", name: "Comb", category: "movement", params: combParams },
  vowel: { type: "vowel", name: "Vowel", category: "movement", params: vowelParams },
  duckDelay: { type: "duckDelay", name: "Duck Delay", category: "space", params: duckDelayParams },
  ringMod: { type: "ringMod", name: "Ring Mod", category: "movement", params: ringModParams },
  tapeStop: { type: "tapeStop", name: "Tape Stop", category: "movement", params: tapeStopParams },
  freqShifter: { type: "freqShifter", name: "Freq Shift", category: "movement", params: freqShifterParams },
  multiTapDelay: { type: "multiTapDelay", name: "Multi-Tap", category: "space", params: multiTapDelayParams },
  pitchShift: { type: "pitchShift", name: "Pitch Shift", category: "character", params: pitchShiftParams },
  vinyl: { type: "vinyl", name: "Vinyl Suite", category: "character", params: vinylParams },
  beatMangler: { type: "beatMangler", name: "Beat Mangler", category: "movement", params: beatManglerParams },
  vocoder: { type: "vocoder", name: "Vocoder", category: "character", params: vocoderParams },
  reverseSwell: { type: "reverseSwell", name: "Reverse Swell", category: "movement", params: reverseSwellParams },
  granularFreeze: { type: "granularFreeze", name: "Granular Freeze", category: "space", params: granularFreezeParams },
  kaskada: { type: "kaskada", name: "RYFT", category: "space", params: kaskadaParams },
};
