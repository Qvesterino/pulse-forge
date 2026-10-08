/**
 * TSAR — parameter schema (docs/TSAR-ROADMAP.md, T1).
 *
 * Stable, versioned parameter IDs. The rule that keeps projects loadable for
 * years: an ID describes WHAT the control does, never how the current DSP
 * happens to implement it. `srcALevel` survives an engine rewrite;
 * `oscAgain`/`filter2b` do not.
 *
 * Everything is a `ParamDef` from `src/effects/types.ts` so the automation
 * lane, the mod matrix and the Inspector treat TSAR params like any other
 * device — no parallel parameter system.
 */

import type { ParamDef } from "../effects/types";
import { LFO_SYNC_DIVISIONS } from "../effects/tempo-sync";

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const signed = (value: number): string => `${value > 0 ? "+" : ""}${value.toFixed(0)}`;
const hz = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value.toFixed(0)} Hz`);

/** Source engines a slot can run. Values are stored as numbers (enum). */
export const TSAR_SOURCE_ENGINES = ["sample", "wavetable", "granular"] as const;
export type TsarSourceEngine = (typeof TSAR_SOURCE_ENGINES)[number];
export const TSAR_SOURCE_ENGINE_OPTIONS = [
  { value: 0, label: "SAMPLE" },
  { value: 1, label: "WAVETABLE" },
  { value: 2, label: "GRANULAR" },
] as const;

export const TSAR_FILTER_TYPES = ["lp", "hp", "bp", "notch"] as const;
export const TSAR_FILTER_OPTIONS = [
  { value: 0, label: "LP" },
  { value: 1, label: "HP" },
  { value: 2, label: "BP" },
  { value: 3, label: "NOTCH" },
] as const;

export const TSAR_LFO_SHAPES = ["sine", "tri", "saw", "square"] as const;
export const TSAR_LFO_SHAPE_OPTIONS = [
  { value: 0, label: "SINE" },
  { value: 1, label: "TRI" },
  { value: 2, label: "SAW" },
  { value: 3, label: "SQR" },
] as const;

/**
 * The full TSAR parameter list in UI order. `src*` params exist per source
 * (A and B); the shared section follows.
 */
export const tsarParams: ParamDef[] = [
  // ── Source A ────────────────────────────────────────────────────────────
  { id: "srcAEngine", label: "A ENGINE", min: 0, max: 2, default: 1, options: [...TSAR_SOURCE_ENGINE_OPTIONS] },
  { id: "srcALevel", label: "A LEVEL", min: 0, max: 1, default: 0.8, format: pct },
  { id: "srcAPan", label: "A PAN", min: -1, max: 1, default: 0, format: signed },
  { id: "srcACoarse", label: "A COARSE", min: -24, max: 24, default: 0, unit: "st", format: signed },
  { id: "srcAFine", label: "A FINE", min: -100, max: 100, default: 0, unit: "ct", format: signed },
  { id: "srcARoot", label: "A ROOT", min: 24, max: 84, default: 60, format: (v) => `MIDI ${Math.round(v)}` },
  { id: "srcAMorph", label: "A MORPH", min: 0, max: 1, default: 0, format: pct },
  {
    id: "srcAScan",
    label: "A SCAN",
    min: 0,
    max: 8,
    default: 0,
    unit: "Hz",
    format: (v) => (v < 0.02 ? "OFF" : `${v.toFixed(2)} Hz`),
  },
  {
    id: "srcAUnison",
    label: "A UNISON",
    min: 1,
    max: 8,
    default: 1,
    step: 1,
    kind: "discrete",
    format: (v) => `${Math.round(v)}×`,
  },
  { id: "srcASpread", label: "A SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
  { id: "srcAAtk", label: "A ATTACK", min: 0, max: 4, default: 0.005, unit: "s", taper: "log" },
  { id: "srcADec", label: "A DECAY", min: 0.01, max: 8, default: 0.6, unit: "s", taper: "log" },
  { id: "srcASus", label: "A SUSTAIN", min: 0, max: 1, default: 0.7, format: pct },
  { id: "srcARel", label: "A RELEASE", min: 0.01, max: 12, default: 0.4, unit: "s", taper: "log" },
  { id: "srcAFilter", label: "A FILTER", min: 0, max: 3, default: 0, options: [...TSAR_FILTER_OPTIONS] },
  {
    id: "srcACutoff",
    label: "A CUTOFF",
    min: 30,
    max: 18000,
    default: 18000,
    unit: "Hz",
    taper: "log",
    format: hz,
  },
  { id: "srcAQ", label: "A Q", min: 0.3, max: 12, default: 0.8, taper: "log" },
  { id: "srcAFilterEnv", label: "A F ENV", min: -1, max: 1, default: 0, format: signed },

  // ── Source B ────────────────────────────────────────────────────────────
  { id: "srcBEngine", label: "B ENGINE", min: 0, max: 2, default: 0, options: [...TSAR_SOURCE_ENGINE_OPTIONS] },
  { id: "srcBLevel", label: "B LEVEL", min: 0, max: 1, default: 0, format: pct },
  { id: "srcBPan", label: "B PAN", min: -1, max: 1, default: 0, format: signed },
  { id: "srcBCoarse", label: "B COARSE", min: -24, max: 24, default: 0, unit: "st", format: signed },
  { id: "srcBFine", label: "B FINE", min: -100, max: 100, default: 0, unit: "ct", format: signed },
  { id: "srcBRoot", label: "B ROOT", min: 24, max: 84, default: 60, format: (v) => `MIDI ${Math.round(v)}` },
  { id: "srcBMorph", label: "B MORPH", min: 0, max: 1, default: 0, format: pct },
  {
    id: "srcBScan",
    label: "B SCAN",
    min: 0,
    max: 8,
    default: 0,
    unit: "Hz",
    format: (v) => (v < 0.02 ? "OFF" : `${v.toFixed(2)} Hz`),
  },
  {
    id: "srcBUnison",
    label: "B UNISON",
    min: 1,
    max: 8,
    default: 1,
    step: 1,
    kind: "discrete",
    format: (v) => `${Math.round(v)}×`,
  },
  { id: "srcBSpread", label: "B SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
  { id: "srcBAtk", label: "B ATTACK", min: 0, max: 4, default: 0.005, unit: "s", taper: "log" },
  { id: "srcBDec", label: "B DECAY", min: 0.01, max: 8, default: 0.6, unit: "s", taper: "log" },
  { id: "srcBSus", label: "B SUSTAIN", min: 0, max: 1, default: 0.7, format: pct },
  { id: "srcBRel", label: "B RELEASE", min: 0.01, max: 12, default: 0.4, unit: "s", taper: "log" },
  { id: "srcBFilter", label: "B FILTER", min: 0, max: 3, default: 0, options: [...TSAR_FILTER_OPTIONS] },
  {
    id: "srcBCutoff",
    label: "B CUTOFF",
    min: 30,
    max: 18000,
    default: 18000,
    unit: "Hz",
    taper: "log",
    format: hz,
  },
  { id: "srcBQ", label: "B Q", min: 0.3, max: 12, default: 0.8, taper: "log" },
  { id: "srcBFilterEnv", label: "B F ENV", min: -1, max: 1, default: 0, format: signed },

  // ── Morph + shared source ───────────────────────────────────────────────
  { id: "morph", label: "MORPH", min: 0, max: 1, default: 0, format: pct },
  { id: "sub", label: "SUB", min: 0, max: 1, default: 0, format: pct },
  {
    id: "subOct",
    label: "SUB OCT",
    min: -2,
    max: -1,
    default: -1,
    step: 1,
    kind: "discrete",
    format: (v) => `${Math.abs(Math.round(v))} OCT`,
  },
  { id: "noise", label: "NOISE", min: 0, max: 1, default: 0, format: pct },
  { id: "noiseColor", label: "N COLOR", min: 0, max: 1, default: 0.5, format: pct },

  // ── Voice ───────────────────────────────────────────────────────────────
  { id: "glide", label: "GLIDE", min: 0, max: 2, default: 0, unit: "s", taper: "log" },
  { id: "velocity", label: "VELOCITY", min: 0, max: 1, default: 0.7, format: pct },
  { id: "drift", label: "DRIFT", min: 0, max: 1, default: 0.15, format: pct },

  // ── Mod matrix (8 slots, same numeric contract as the wtvoice worklet) ──
  // src: 0 ENV, 1 LFO, 2 VEL, 3 PRESS
  // dst: 0 A MORPH, 1 A CUTOFF, 2 B MORPH, 3 B CUTOFF, 4 MORPH, 5 AMP, 6 PAN
  ...Array.from({ length: 4 }, (_, i): ParamDef[] => {
    const n = i + 1;
    return [
      { id: `mod${n}Src`, label: `M${n} SRC`, min: -1, max: 3, default: -1, step: 1, kind: "discrete" },
      { id: `mod${n}Dst`, label: `M${n} DST`, min: -1, max: 6, default: -1, step: 1, kind: "discrete" },
      { id: `mod${n}Amt`, label: `M${n} AMT`, min: -1, max: 1, default: 0, format: signed },
    ];
  }).flat(),

  // ── LFO (shared global modulator) ───────────────────────────────────────
  { id: "lfoRate", label: "LFO RATE", min: 0.01, max: 24, default: 2, unit: "Hz", taper: "log" },
  { id: "lfoShape", label: "LFO SHAPE", min: 0, max: 3, default: 0, options: [...TSAR_LFO_SHAPE_OPTIONS] },
  {
    id: "lfoSync",
    label: "LFO SYNC",
    min: 0,
    max: LFO_SYNC_DIVISIONS.length - 1,
    default: 0,
    step: 1,
    kind: "discrete",
    options: LFO_SYNC_DIVISIONS.map(({ value, label }) => ({ value, label })),
  },

  // ── Tone / output ───────────────────────────────────────────────────────
  { id: "tone", label: "TONE", min: -1, max: 1, default: 0, format: signed },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: pct },
  { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.5, format: pct },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },

  // ── Arpeggiator (T6) ────────────────────────────────────────────────────
  { id: "arpOn", label: "ARP", min: 0, max: 1, default: 0, kind: "toggle" },
  {
    id: "arpMode",
    label: "A MODE",
    min: 0,
    max: 4,
    default: 0,
    options: [
      { value: 0, label: "UP" },
      { value: 1, label: "DOWN" },
      { value: 2, label: "UPDN" },
      { value: 3, label: "ORDER" },
      { value: 4, label: "RANDOM" },
    ],
  },
  { id: "arpRate", label: "A RATE", min: 1, max: 16, default: 8, step: 1, kind: "discrete" },
  { id: "arpOctaves", label: "A OCT", min: 1, max: 4, default: 1, step: 1, kind: "discrete" },
  { id: "arpGate", label: "A GATE", min: 0.05, max: 1, default: 0.5, format: pct },
  { id: "arpSwing", label: "A SWING", min: 0, max: 0.75, default: 0, format: pct },
];

/** Fast id → ParamDef lookup (built once; the schema is static). */
export const TSAR_PARAM_DEFS: Record<string, ParamDef> = Object.fromEntries(
  tsarParams.map((param) => [param.id, param]),
);

/** Every param id the engine understands (used by tests + the panel). */
export const TSAR_PARAM_IDS: string[] = tsarParams.map((param) => param.id);

/** Mod-matrix source/destination labels shared by the panel and the DSP. */
export const TSAR_MOD_SOURCES = ["ENV", "LFO", "VEL", "PRESS"] as const;
export const TSAR_MOD_DESTINATIONS = ["A MORPH", "A CUTOFF", "B MORPH", "B CUTOFF", "MORPH", "AMP", "PAN"] as const;
