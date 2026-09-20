/**
 * MORPH DYNAMICS — Parameter Schema
 *
 * Single source of truth for every parameter (ranges, defaults, units,
 * automation eligibility). The worklet processor, the node wrapper, the
 * editor panel, presets and project-load validation all derive from this
 * schema — plain-unit ↔ normalized conversion and clamping have exactly
 * one implementation each.
 *
 * First-party core (not vendored): the schema is written against the
 * MorphDynamicsProcessor in ../dsp, unlike the vendored ultina/fxeq
 * oracle cores.
 */

import * as P from "./parameterIds.js";
import { MOD_DESTINATIONS, MOD_SOURCES } from "./modulation.js";

export type MorphParamUnit = "db" | "hz" | "ms" | "ratio" | "percent" | "sec" | "enum" | "boolean" | "generic";

export interface MorphParamDef {
  readonly id: string;
  readonly name: string;
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly unit: MorphParamUnit;
  /** Continuous lanes only — booleans/enums are stepped by nature. */
  readonly automatable: boolean;
  /** Display taper hint for editors (log for Hz-domain params). */
  readonly taper?: "linear" | "log";
}

function p(
  id: string,
  name: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  unit: MorphParamUnit,
  automatable = true,
  extra?: Partial<Pick<MorphParamDef, "taper">>,
): MorphParamDef {
  return { id, name, defaultValue, minValue, maxValue, unit, automatable, ...extra };
}

// ── Sections ────────────────────────────────────────────────

const GLOBAL_PARAMS: MorphParamDef[] = [
  p(P.GLOBAL_INPUT_GAIN_DB_ID, "Input Gain", 0, -24, 24, "db"),
  p(P.GLOBAL_OUTPUT_GAIN_DB_ID, "Output Gain", 0, -24, 24, "db"),
  p(P.GLOBAL_MIX_ID, "Mix", 100, 0, 100, "percent"),
  p(P.GLOBAL_QUALITY_ID, "Quality", 1, 0, 2, "enum", false),
];

const MACRO_PARAMS: MorphParamDef[] = [
  p(P.MACRO_PRESSURE_ID, "Pressure", 35, 0, 100, "percent"),
  p(P.MACRO_PUNCH_ID, "Punch", 20, -100, 100, "percent"),
  p(P.MACRO_BODY_ID, "Body", 50, 0, 100, "percent"),
  p(P.MACRO_TEXTURE_ID, "Texture", 50, 0, 100, "percent"),
  p(P.MACRO_MOTION_ID, "Motion", 35, 0, 100, "percent"),
  p(P.MACRO_SPACE_ID, "Space", 30, 0, 100, "percent"),
];

const ANALYSIS_PARAMS: MorphParamDef[] = [
  p(P.ANALYSIS_TRANSIENT_SENSITIVITY_ID, "Transient Sensitivity", 100, 0, 200, "percent"),
  p(P.ANALYSIS_BODY_SENSITIVITY_ID, "Body Sensitivity", 100, 0, 200, "percent"),
  p(P.ANALYSIS_TEXTURE_SENSITIVITY_ID, "Texture Sensitivity", 100, 0, 200, "percent"),
];

const DYN_PARAMS: MorphParamDef[] = [
  p(P.DYN_THRESHOLD_DB_ID, "Threshold", -24, -60, 0, "db"),
  p(P.DYN_RATIO_ID, "Ratio", 2.5, 1, 20, "ratio"),
  p(P.DYN_ATTACK_MS_ID, "Attack", 12, 0.1, 100, "ms"),
  p(P.DYN_RELEASE_MS_ID, "Release", 180, 5, 1000, "ms"),
  p(P.DYN_KNEE_DB_ID, "Knee", 6, 0, 24, "db"),
  p(P.DYN_DETECTOR_BLEND_ID, "Detector", 50, 0, 100, "percent"),
  p(P.DYN_SIDECHAIN_HPF_HZ_ID, "SC HPF", 60, 20, 500, "hz", true, { taper: "log" }),
  p(P.DYN_MAKEUP_DB_ID, "Makeup", 0, -12, 24, "db"),
  p(P.DYN_MAKEUP_AUTO_ID, "Auto Makeup", 1, 0, 1, "boolean"),
];

const CHAR_PARAMS: MorphParamDef[] = [
  // Stages default ON: at default macro values the character/motion/space
  // engines sit at (near-)identity, so "on" costs nothing audibly but lets
  // PRESSURE reveal reactive behavior immediately (the thesis demands a
  // meaningful result seconds after loading — a fresh device must not be
  // three toggles away from it).
  p(P.CHAR_ENABLED_ID, "Character", 1, 0, 1, "boolean"),
  p(P.CHAR_DRIVE_ID, "Drive", 0, 0, 100, "percent"),
  p(P.CHAR_TONE_ID, "Tone", 0, -100, 100, "percent"),
  p(P.CHAR_ASYM_ID, "Harmonics", 0, 0, 100, "percent"),
  p(P.CHAR_CLIP_ID, "Clip", 0, 0, 100, "percent"),
];

const MOTION_PARAMS: MorphParamDef[] = [
  p(P.MOTION_ENABLED_ID, "Motion Stage", 1, 0, 1, "boolean"),
  p(P.MOTION_DEPTH_ID, "Depth", 40, 0, 100, "percent"),
  p(P.MOTION_RATE_HZ_ID, "Drift", 0.2, 0, 5, "hz"),
  p(P.MOTION_FEEDBACK_ID, "Feedback", 30, -80, 80, "percent"),
  p(P.MOTION_CENTER_HZ_ID, "Center", 900, 200, 4000, "hz", true, { taper: "log" }),
];

const SPACE_PARAMS: MorphParamDef[] = [
  p(P.SPACE_ENABLED_ID, "Space Stage", 1, 0, 1, "boolean"),
  p(P.SPACE_SEND_ID, "Send", 25, 0, 100, "percent"),
  p(P.SPACE_PREDELAY_MS_ID, "Pre-delay", 12, 0, 80, "ms"),
  p(P.SPACE_DIFFUSION_ID, "Diffusion", 60, 0, 100, "percent"),
  p(P.SPACE_DECAY_S_ID, "Decay", 1.2, 0.1, 5, "sec"),
  p(P.SPACE_DAMPING_ID, "Damping", 45, 0, 100, "percent"),
  p(P.SPACE_WIDTH_ID, "Width", 115, 0, 200, "percent"),
  p(P.SPACE_DUCK_ID, "Transient Duck", 50, 0, 100, "percent"),
];

/** routes.N.* — 8 fixed slots × 5 params (enabled, source, destination, amount, smoothMs). */
function routeParams(): MorphParamDef[] {
  const defs: MorphParamDef[] = [];
  for (let slot = 0; slot < P.ROUTE_COUNT; slot++) {
    defs.push(p(P.routeParamId(slot, "enabled"), `Route ${slot + 1} On`, 0, 0, 1, "boolean"));
    defs.push(
      p(
        P.routeParamId(slot, "source"),
        `Route ${slot + 1} Source`,
        0,
        0,
        MOD_SOURCES.length - 1,
        "enum",
        false,
      ),
    );
    defs.push(
      p(
        P.routeParamId(slot, "destination"),
        `Route ${slot + 1} Destination`,
        0,
        0,
        MOD_DESTINATIONS.length - 1,
        "enum",
        false,
      ),
    );
    defs.push(p(P.routeParamId(slot, "amount"), `Route ${slot + 1} Amount`, 50, -100, 100, "percent"));
    defs.push(p(P.routeParamId(slot, "smoothMs"), `Route ${slot + 1} Smooth`, 40, 5, 300, "ms"));
  }
  return defs;
}

export const ALL_PARAMS: readonly MorphParamDef[] = [
  ...GLOBAL_PARAMS,
  ...MACRO_PARAMS,
  ...ANALYSIS_PARAMS,
  ...DYN_PARAMS,
  ...CHAR_PARAMS,
  ...MOTION_PARAMS,
  ...SPACE_PARAMS,
  ...routeParams(),
];

/** O(1) def lookup — the port message path may touch many params per message. */
export const PARAM_BY_ID: ReadonlyMap<string, MorphParamDef> = new Map(ALL_PARAMS.map((d) => [d.id, d]));

export function tryGetParamDef(id: string): MorphParamDef | undefined {
  return PARAM_BY_ID.get(id);
}

export function getParamDef(id: string): MorphParamDef {
  const def = PARAM_BY_ID.get(id);
  if (!def) throw new Error(`MORPH DYNAMICS param ${id} is not defined`);
  return def;
}

/** Complete default parameter map (fresh device state). */
export function buildDefaultParams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of ALL_PARAMS) out[def.id] = def.defaultValue;
  return out;
}

/**
 * Clamp a value into the parameter's range. Non-finite input falls back to
 * the DEFAULT (Math.min/max both return NaN unchanged — a NaN must never
 * reach the DSP or the document).
 */
export function clampParam(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return value;
  if (!Number.isFinite(value)) return def.defaultValue;
  return Math.min(def.maxValue, Math.max(def.minValue, value));
}

/** Plain unit → normalized [0,1] (canonical round-trip with fromNormalized). */
export function toNormalized(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def || def.maxValue === def.minValue) return 0;
  return Math.min(1, Math.max(0, (value - def.minValue) / (def.maxValue - def.minValue)));
}

/** Normalized [0,1] → plain unit. */
export function fromNormalized(id: string, norm: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return 0;
  const n = Math.min(1, Math.max(0, norm));
  return def.minValue + n * (def.maxValue - def.minValue);
}

export function getAutomatableParamIds(): string[] {
  return ALL_PARAMS.filter((d) => d.automatable).map((d) => d.id);
}
