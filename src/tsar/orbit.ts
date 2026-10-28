/**
 * TSAR ORBIT — the 2-D performance surface (roadmap wave 5, ADR 0074).
 *
 * A performer wants ONE thing: a surface under the hand that changes the
 * sound. ORBIT is a square X/Y pad whose two axes drive two TSAR parameters.
 * Three rules shape this module:
 *
 *  1. **The target is a STABLE ID, never an index.** `srcACutoff` survives an
 *     engine rewrite, a parameter added later, and a preset reordered. The
 *     mapping therefore lives in the project (`InstrumentTrack.orbit`) and
 *     travels with the patch — the same gesture means the same thing on
 *     another machine.
 *
 *  2. **The POSITION is not stored here.** The surface's position IS the two
 *     parameters' values, held in the track's ordinary `params`. One number,
 *     one truth: the value the producer sees, the value the engine plays and
 *     the value an automation lane writes are the same number. What the
 *     mapping adds is what a value cannot say — which parameter, over which
 *     range.
 *
 *  3. **An axis the engine cannot hear is not an axis.** The catalogue is
 *     curated (never "all 76 parameters"), and every target carries the
 *     live condition read off the DSP. `isMutationAxisLive` already encodes
 *     those rules for the mutation engine (wave 4) — this module REUSES them
 *     instead of growing a second set of rules that could drift apart.
 */

import type { OrbitAxis, OrbitMapping } from "../project-model/types";
import { TSAR_PARAM_DEFS } from "./params";
import { isMutationAxisLive } from "./mutations";
import { ratioToTaper, taperToRatio, type SliderTaper } from "../shared/taper";

/** One assignable target of the surface. */
export interface OrbitTarget {
  /** The stable TSAR parameter id (the axis stores exactly this). */
  id: string;
  /** Short human label for the picker. */
  label: string;
  /** The parameter's own limits (the axis range defaults to these). */
  min: number;
  max: number;
  /** The parameter's default value — where the axis sits before any move. */
  default: number;
  /** Why the axis is silent right now, when it is (see `isOrbitAxisLive`). */
  silentBecause?: string;
}

/**
 * The catalogue of assignable targets — a DELIBERATE subset of TSAR's
 * parameters, not "all of them".
 *
 * The exclusions are as deliberate as the inclusions:
 *
 *  - **Discrete and enum parameters are out.** The automation bridge does
 *    not interpolate an enum or a toggle (it writes raw point events for
 *    them), so an interpolated axis over `srcAEngine` would sweep through
 *    engine indices that do not exist.
 *  - **Grain and scan parameters are out.** Their audibility depends on the
 *    source engine being granular/wavetable, and the liveness rules the
 *    mutation engine encodes do not model that yet. An axis whose silence
 *    cannot be predicted is an axis that lies.
 *  - **Level-ish parameters of the track itself are out** (`gain`, `pan` on
 *    the track): ORBIT drives the INSTRUMENT, never the mix.
 */
const ORBIT_TARGET_IDS = [
  // Source A — timbre
  "srcAMorph",
  "srcACoarse",
  "srcAFine",
  "srcASpread",
  "srcACutoff",
  "srcAQ",
  "srcAFilterEnv",
  "srcAAtk",
  "srcADec",
  "srcASus",
  // Source B — timbre
  "srcBMorph",
  "srcBCoarse",
  "srcBFine",
  "srcBSpread",
  "srcBCutoff",
  "srcBQ",
  "srcBFilterEnv",
  "srcBAtk",
  "srcBDec",
  "srcBSus",
  // Shared — blend, noise, colour, movement
  "morph",
  "sub",
  "noise",
  "noiseColor",
  "drift",
  "tone",
  "drive",
  "width",
  "lfoRate",
  // Mod-matrix intensity (the modulation depth a slot applies)
  "mod1Amt",
  "mod2Amt",
  "mod3Amt",
  "mod4Amt",
] as const;

/**
 * Why a target can be silent with the current patch. The text is short and
 * factual: it names the condition, not a verdict.
 */
const SILENT_REASONS: Record<string, string> = {
  srcAMorph: "wavetable engine only",
  srcBMorph: "wavetable engine only",
  srcASpread: "needs unison above 1",
  srcBSpread: "needs unison above 1",
  srcAQ: "the filter is open",
  srcBQ: "the filter is open",
  srcAFilterEnv: "the filter is open",
  srcBFilterEnv: "the filter is open",
  srcACutoff: "source A is silent",
  srcBCutoff: "source B is silent",
  morph: "needs both sources audible",
  noiseColor: "needs noise",
  width: "needs a source off centre",
  lfoRate: "no mod slot uses the LFO",
  mod1Amt: "mod slot 1 is off",
  mod2Amt: "mod slot 2 is off",
  mod3Amt: "mod slot 3 is off",
  mod4Amt: "mod slot 4 is off",
};

/**
 * The assignable targets, in picker order.
 *
 * Every entry is checked against the real parameter schema when the module
 * loads: an id that TSAR does not know, or a parameter that is discrete,
 * would be a target the automation bridge cannot honour. A broken entry is
 * DROPPED, not shipped — the catalogue can never promise a target the
 * engine cannot play.
 */
export const ORBIT_TARGETS: OrbitTarget[] = ORBIT_TARGET_IDS.map((id): OrbitTarget | null => {
  const def = TSAR_PARAM_DEFS[id];
  if (!def) return null;
  if (def.kind === "discrete" || def.kind === "enum" || def.kind === "toggle" || def.options) return null;
  return {
    id: def.id,
    label: def.label,
    min: def.min,
    max: def.max,
    default: def.default,
    silentBecause: SILENT_REASONS[id],
  };
}).filter((target): target is OrbitTarget => target !== null);

/** Target lookup by id. */
export const ORBIT_TARGET_BY_ID: Record<string, OrbitTarget> = Object.fromEntries(
  ORBIT_TARGETS.map((target) => [target.id, target]),
);

/** Is this id an assignable target? */
export function isOrbitTarget(paramId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ORBIT_TARGET_BY_ID, paramId);
}

/**
 * Is the axis audible with the current patch?
 *
 * The mutation engine already knows which axes reach no ear (wave 4's rule
 * set, read off the DSP). ORBIT reuses it and adds ONE rule the mutation
 * engine does not need: a mod slot with no source or no destination is off,
 * so its amount reaches no ear either.
 */
export function isOrbitAxisLive(paramId: string, base: Record<string, number>): boolean {
  const modAmount = /^mod([1-4])Amt$/.exec(paramId);
  if (modAmount) {
    const slot = `mod${modAmount[1]}`;
    const source = base[`${slot}Src`] ?? -1;
    const destination = base[`${slot}Dst`] ?? -1;
    return source >= 0 && destination >= 0;
  }
  return isMutationAxisLive(paramId, base);
}

/** The axis' taper — the parameter's own (a cutoff knob tapers logarithmically). */
function taperOf(paramId: string): SliderTaper {
  return TSAR_PARAM_DEFS[paramId]?.taper === "log" ? "log" : "linear";
}

/**
 * The position of the surface along one axis, 0..1.
 *
 * The inverse of `orbitAxisValue` — the position is derived from the value
 * that is actually stored, so the handle on the pad and the parameter can
 * never drift apart.
 */
export function orbitAxisPosition(axis: OrbitAxis, value: number): number {
  if (!(axis.max > axis.min)) return 0;
  return Math.min(1, Math.max(0, taperToRatio(axis.min, axis.max, value, taperOf(axis.paramId))));
}

/**
 * The parameter value a surface position stands for.
 *
 * The position is mapped through the parameter's own taper, so a cutoff
 * axis spends its travel musically (the geometric mean in the middle)
 * instead of putting 10 kHz in the middle of a 20 Hz–20 kHz range.
 */
export function orbitAxisValue(axis: OrbitAxis, position: number): number {
  const ratio = Math.min(1, Math.max(0, position));
  return ratioToTaper(axis.min, axis.max, ratio, taperOf(axis.paramId));
}

/** The default axis of a target: the parameter's own range. */
export function orbitAxisForTarget(paramId: string): OrbitAxis | null {
  const target = ORBIT_TARGET_BY_ID[paramId];
  if (!target) return null;
  return { paramId: target.id, min: target.min, max: target.max };
}

/**
 * A mapping preset: a NAMED pair of axes.
 *
 * The ranges are part of the preset — "MORPH → BRIGHTNESS" means a cutoff
 * from 200 Hz to 12 kHz, not the cutoff's full 30 Hz–18 kHz. The preset is
 * therefore a complete musical instruction, not just two parameter names.
 */
export interface OrbitPreset {
  id: string;
  name: string;
  /** What the surface is for, in one line. */
  hint: string;
  x: OrbitAxis;
  y: OrbitAxis;
}

/** The mapping presets — a few CLEAR ones, not a catalogue to browse. */
export const ORBIT_PRESETS: OrbitPreset[] = [
  {
    id: "morph-brightness",
    name: "MORPH → BRIGHTNESS",
    hint: "blend the two sources, then open the filter",
    x: { paramId: "morph", min: 0, max: 1 },
    y: { paramId: "srcACutoff", min: 200, max: 12000 },
  },
  {
    id: "timbre-motion",
    name: "TIMBRE → MOTION",
    hint: "the wavetable frame, then the modulation depth",
    x: { paramId: "srcAMorph", min: 0, max: 1 },
    y: { paramId: "mod1Amt", min: 0, max: 1 },
  },
  {
    id: "filter-space",
    name: "FILTER → SPACE",
    hint: "cutoff on one axis, resonance on the other",
    x: { paramId: "srcACutoff", min: 120, max: 16000 },
    y: { paramId: "srcAQ", min: 0.3, max: 12 },
  },
  {
    id: "drift-width",
    name: "DRIFT → WIDTH",
    hint: "pitch drift against stereo width",
    x: { paramId: "drift", min: 0, max: 1 },
    y: { paramId: "width", min: 0, max: 1 },
  },
];

/** The default mapping — the documented original the user can always go back to. */
export const DEFAULT_ORBIT_PRESET_ID = "morph-brightness";

/**
 * The original mapping: the first preset, as a plain mapping.
 *
 * "Restore the original mapping" is a GATE requirement, so the original is
 * a value, not a gesture — one command puts it back.
 */
export function defaultOrbitMapping(): OrbitMapping {
  const preset = ORBIT_PRESETS.find((candidate) => candidate.id === DEFAULT_ORBIT_PRESET_ID) ?? ORBIT_PRESETS[0]!;
  return { x: { ...preset.x }, y: { ...preset.y } };
}

/**
 * Repair a mapping that came from a document.
 *
 * A mapping is only as good as its axes: an unknown parameter id, a range
 * that is not a range, or an axis that points at a discrete parameter would
 * put a value the engine cannot honour onto the surface. Every such axis
 * falls back to the default mapping's axis for the same side, so a damaged
 * document loads as a WORKING surface instead of a silent one.
 */
export function normalizeOrbitMapping(mapping: unknown): OrbitMapping {
  const fallback = defaultOrbitMapping();
  if (!mapping || typeof mapping !== "object") return fallback;
  const source = mapping as Partial<Record<"x" | "y", unknown>>;
  const repair = (axis: unknown, fallbackAxis: OrbitAxis): OrbitAxis => {
    if (!axis || typeof axis !== "object") return { ...fallbackAxis };
    const candidate = axis as Partial<OrbitAxis>;
    if (typeof candidate.paramId !== "string" || !isOrbitTarget(candidate.paramId)) return { ...fallbackAxis };
    const target = ORBIT_TARGET_BY_ID[candidate.paramId]!;
    const min = typeof candidate.min === "number" && Number.isFinite(candidate.min) ? candidate.min : target.min;
    const max = typeof candidate.max === "number" && Number.isFinite(candidate.max) ? candidate.max : target.max;
    if (!(max > min)) return { paramId: target.id, min: target.min, max: target.max };
    // The axis may not leave the parameter's own range.
    const lo = Math.min(Math.max(min, target.min), target.max);
    const hi = Math.min(Math.max(max, target.min), target.max);
    if (!(hi > lo)) return { paramId: target.id, min: target.min, max: target.max };
    return { paramId: target.id, min: lo, max: hi };
  };
  return {
    x: repair(source.x, fallback.x),
    y: repair(source.y, fallback.y),
  };
}

/**
 * Does this mapping drive the same parameter on both axes?
 *
 * Two axes on one parameter would fight: the X write and the Y write would
 * overwrite each other, and the surface would show a position that is not
 * the parameter's value. The UI says so instead of letting it happen.
 */
export function orbitAxesCollide(mapping: OrbitMapping): boolean {
  return mapping.x.paramId === mapping.y.paramId;
}

/** A short description of a mapping — the panel's one-line status. */
export function describeOrbitMapping(mapping: OrbitMapping): string {
  const x = ORBIT_TARGET_BY_ID[mapping.x.paramId]?.label ?? mapping.x.paramId;
  const y = ORBIT_TARGET_BY_ID[mapping.y.paramId]?.label ?? mapping.y.paramId;
  return `${x} × ${y}`;
}
