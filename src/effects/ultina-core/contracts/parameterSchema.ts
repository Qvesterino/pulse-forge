/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: preEmphasisMode enum rotated (0=Flat legacy no-op); FIR-friendly crossovers unchanged.)
// ═══════════════════════════════════════════════════════════
// Ultina — Parameter Schema
//
// Full parameter definitions with ranges, defaults, units,
// and automation eligibility. Single source of truth for
// parameter metadata. The native C++ core, the TypeScript
// reference processors, the editor, and the VST3 wrapper all
// derive from this schema.
//
// Rules:
//   1. Plain-unit ↔ normalized conversion has one canonical
//      implementation and round-trip tests.
//   2. Continuous audio parameters are smoothed.
//   3. Discrete mode/routing changes use click-free transition.
//   4. Meter values are NOT automatable parameters.
// ═══════════════════════════════════════════════════════════

import * as P from "./parameterIds.js";

// ── Parameter definition ───────────────────────────────────

export type ParamUnit = "db" | "hz" | "ms" | "ratio" | "percent" | "degrees" | "enum" | "boolean" | "generic";

export interface UltinaParamDef {
  readonly id: string;
  readonly name: string;
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly unit: ParamUnit;
  readonly automatable: boolean;
  readonly step?: number;
  readonly enumValues?: readonly string[];
}

// ── Helper to build a param def concisely ──────────────────

function p(
  id: string,
  name: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  unit: ParamUnit,
  automatable = true,
  extra?: Partial<UltinaParamDef>,
): UltinaParamDef {
  return { id, name, defaultValue, minValue, maxValue, unit, automatable, ...extra };
}

// ═══════════════════════════════════════════════════════════
// GLOBAL PARAMETERS
// ═══════════════════════════════════════════════════════════

const GLOBAL_PARAMS: UltinaParamDef[] = [
  p(P.GLOBAL_BYPASS_ID, "Bypass", 0, 0, 1, "boolean"),
  p(P.GLOBAL_INPUT_GAIN_DB_ID, "Input Gain", 0, -24, 24, "db"),
  p(P.GLOBAL_OUTPUT_GAIN_DB_ID, "Output Gain", 0, -24, 24, "db"),
  p(P.GLOBAL_MIX_ID, "Mix", 100, 0, 100, "percent"),
  p(P.GLOBAL_QUALITY_MODE_ID, "Quality", 1, 0, 2, "enum", false, { enumValues: ["tracking", "mix", "hq"] }),
  p(P.GLOBAL_DELTA_LISTEN_ID, "Delta Listen", 0, 0, 1, "boolean", false),
  p(P.GLOBAL_GAIN_MATCH_ENABLED_ID, "Gain Match", 0, 0, 1, "boolean", false),
  p(P.GLOBAL_AB_SLOT_ID, "A/B Slot", 0, 0, 1, "enum", false, { enumValues: ["A", "B"] }),
  p(P.GLOBAL_AUTOGAIN_TARGET_LUFS_ID, "Autogain Target LUFS", -14, -30, 0, "db", false),
];

// ═══════════════════════════════════════════════════════════
// EQUALIZER PARAMETERS
// ═══════════════════════════════════════════════════════════

const EQ_GLOBAL_PARAMS: UltinaParamDef[] = [
  p(P.EQ_ENABLED_ID, "EQ Enabled", 0, 0, 1, "boolean"),
  p(P.EQ_CHANNEL_MODE_ID, "EQ Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.EQ_SOFT_SATURATION_ID, "EQ Soft Saturation", 0, 0, 1, "boolean"),
  p(P.EQ_LEARN_ACTIVE_ID, "EQ Learn", 0, 0, 1, "boolean", false),
  p(P.EQ_MASKING_METER_ENABLED_ID, "Masking Meter", 0, 0, 1, "boolean", false),
  p(P.EQ_SIDECHAIN_ENABLED_ID, "EQ Sidechain", 0, 0, 1, "boolean"),
];

/** EQ band default frequencies spread across the spectrum. */
export const EQ_DEFAULT_FREQS = [80, 200, 350, 800, 1500, 3000, 5000, 7000, 10000, 12000, 15000, 18000];

/** EQ band shapes. */
export const EQ_SHAPES = [
  "bell",
  "highShelf",
  "lowShelf",
  "highPass",
  "lowPass",
  "notch",
  "tilt",
  "bandPass",
  "flat",
  "dynamicBell",
  "dynamicShelf",
  "dynamicTilt",
] as const;

/** EQ band modes. */
export const EQ_BAND_MODES = ["static", "dynamic", "sidechain"] as const;

function eqBandParams(bandIndex: number): UltinaParamDef[] {
  const prefix = `eq.band${bandIndex}`;
  return [
    p(`${prefix}.enabled`, `Band ${bandIndex + 1} Enabled`, 0, 0, 1, "boolean"),
    p(`${prefix}.freqHz`, `Band ${bandIndex + 1} Frequency`, EQ_DEFAULT_FREQS[bandIndex], 20, 20000, "hz"),
    p(`${prefix}.gainDb`, `Band ${bandIndex + 1} Gain`, 0, -18, 18, "db"),
    p(`${prefix}.q`, `Band ${bandIndex + 1} Q`, 1, 0.1, 24, "ratio"),
    p(`${prefix}.shape`, `Band ${bandIndex + 1} Shape`, 0, 0, 11, "enum", true, { enumValues: EQ_SHAPES }),
    p(`${prefix}.mode`, `Band ${bandIndex + 1} Mode`, 0, 0, 2, "enum", true, { enumValues: EQ_BAND_MODES }),
    p(`${prefix}.dynamicRangeDb`, `Band ${bandIndex + 1} Dyn Range`, 6, 0, 18, "db"),
    p(`${prefix}.dynamicThresholdDb`, `Band ${bandIndex + 1} Dyn Threshold`, -24, -60, 0, "db"),
    p(`${prefix}.sidechainEnabled`, `Band ${bandIndex + 1} Sidechain`, 0, 0, 1, "boolean"),
    p(`${prefix}.solo`, `Band ${bandIndex + 1} Solo`, 0, 0, 1, "boolean", false),
    // Dynamic EQ per-band compressor parameters
    p(`${prefix}.dynamicAttackMs`, `Band ${bandIndex + 1} Dyn Attack`, 15, 0.1, 200, "ms"),
    p(`${prefix}.dynamicReleaseMs`, `Band ${bandIndex + 1} Dyn Release`, 150, 5, 2000, "ms"),
    p(`${prefix}.dynamicRatio`, `Band ${bandIndex + 1} Dyn Ratio`, 3, 1, 20, "ratio"),
    p(`${prefix}.dynamicKneeDb`, `Band ${bandIndex + 1} Dyn Knee`, 0, 0, 24, "db"),
  ];
}

const EQ_BAND_PARAMS_ALL: UltinaParamDef[] = [];
for (let i = 0; i < P.EQ_MAX_BANDS; i++) {
  EQ_BAND_PARAMS_ALL.push(...eqBandParams(i));
}

// ═══════════════════════════════════════════════════════════
// COMPRESSOR PARAMETERS
// ═══════════════════════════════════════════════════════════

const COMP_PARAMS: UltinaParamDef[] = [
  p(P.COMP_ENABLED_ID, "Compressor Enabled", 0, 0, 1, "boolean"),
  p(P.COMP_MODE_ID, "Comp Mode", 1, 0, 4, "enum", true, { enumValues: ["punch", "modern", "vintage", "opto", "fet"] }),
  p(P.COMP_DETECTION_MODE_ID, "Detection", 1, 0, 2, "enum", true, { enumValues: ["peak", "rms", "trueEnvelope"] }),
  p(P.COMP_THRESHOLD_DB_ID, "Threshold", -20, -60, 0, "db"),
  p(P.COMP_RATIO_ID, "Ratio", 3, 1, 20, "ratio"),
  p(P.COMP_ATTACK_MS_ID, "Attack", 10, 0.1, 200, "ms"),
  p(P.COMP_RELEASE_MS_ID, "Release", 100, 5, 2000, "ms"),
  p(P.COMP_KNEE_DB_ID, "Knee", 0, 0, 24, "db"),
  p(P.COMP_MAKEUP_DB_ID, "Makeup", 0, 0, 24, "db"),
  p(P.COMP_MAKEUP_AUTO_ID, "Auto Makeup", 0, 0, 1, "boolean", false),
  p(P.COMP_AUTO_RELEASE_ID, "Auto Release", 0, 0, 1, "boolean"),
  p(P.COMP_MIX_ID, "Comp Mix", 100, 0, 100, "percent"),
  p(P.COMP_SIDECHAIN_ENABLED_ID, "Comp Sidechain", 0, 0, 1, "boolean"),
  p(P.COMP_SIDECHAIN_HPF_HZ_ID, "SC HPF", 20, 20, 2000, "hz"),
  p(P.COMP_DETECTOR_HPF_HZ_ID, "Det HPF", 20, 20, 1000, "hz"),
  p(P.COMP_BAND_COUNT_ID, "Comp Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.COMP_CROSSOVER_HZ1_ID, "Comp Xover 1", 250, 20, 20000, "hz"),
  p(P.COMP_CROSSOVER_HZ2_ID, "Comp Xover 2", 2500, 20, 20000, "hz"),
  p(P.COMP_CROSSOVER_MODE_ID, "Comp Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.COMP_CHANNEL_MODE_ID, "Comp Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.COMP_CROSSOVER_LEARN_ID, "Comp Xover Learn", 0, 0, 1, "boolean", false),
  p(P.COMP_DELTA_ID, "Comp Delta", 0, 0, 1, "boolean", false),
  p(P.COMP_AUTO_LEARN_THRESHOLD_ID, "Auto-Learn Threshold", 0, 0, 1, "boolean", false),
  // Per-band threshold overrides
  p("comp.band0.thresholdDb", "Band 1 Threshold", -20, -60, 0, "db"),
  p("comp.band1.thresholdDb", "Band 2 Threshold", -20, -60, 0, "db"),
  p("comp.band2.thresholdDb", "Band 3 Threshold", -20, -60, 0, "db"),
];

// ═══════════════════════════════════════════════════════════
// GATE PARAMETERS
// ═══════════════════════════════════════════════════════════

const GATE_PARAMS: UltinaParamDef[] = [
  p(P.GATE_ENABLED_ID, "Gate Enabled", 0, 0, 1, "boolean"),
  p(P.GATE_RANGE_DB_ID, "Gate Range", -20, -80, 0, "db"),
  p(P.GATE_ATTACK_MS_ID, "Gate Attack", 1, 0.1, 100, "ms"),
  p(P.GATE_HOLD_MS_ID, "Gate Hold", 50, 0, 1000, "ms"),
  p(P.GATE_RELEASE_MS_ID, "Gate Release", 100, 5, 5000, "ms"),
  p(P.GATE_HYSTERESIS_DB_ID, "Gate Hysteresis", 6, 0, 24, "db"),
  p(P.GATE_SIDECHAIN_HPF_HZ_ID, "Gate SC HPF", 20, 20, 2000, "hz"),
  p(P.GATE_BAND_COUNT_ID, "Gate Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.GATE_CROSSOVER_HZ1_ID, "Gate Xover 1", 250, 20, 20000, "hz"),
  p(P.GATE_CROSSOVER_HZ2_ID, "Gate Xover 2", 2500, 20, 20000, "hz"),
  p(P.GATE_CROSSOVER_MODE_ID, "Gate Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.GATE_CHANNEL_MODE_ID, "Gate Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.GATE_CROSSOVER_LEARN_ID, "Gate Xover Learn", 0, 0, 1, "boolean", false),
  p(P.GATE_DELTA_ID, "Gate Delta", 0, 0, 1, "boolean", false),
  // Per-band open/close thresholds
  p("gate.band0.openThresholdDb", "Band 1 Open", -40, -80, 0, "db"),
  p("gate.band0.closeThresholdDb", "Band 1 Close", -50, -80, 0, "db"),
  p("gate.band1.openThresholdDb", "Band 2 Open", -40, -80, 0, "db"),
  p("gate.band1.closeThresholdDb", "Band 2 Close", -50, -80, 0, "db"),
  p("gate.band2.openThresholdDb", "Band 3 Open", -40, -80, 0, "db"),
  p("gate.band2.closeThresholdDb", "Band 3 Close", -50, -80, 0, "db"),
  p("gate.mix", "Gate Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// EXCITER PARAMETERS
// ═══════════════════════════════════════════════════════════

const EXCITER_PARAMS: UltinaParamDef[] = [
  p(P.EXCITER_ENABLED_ID, "Exciter Enabled", 0, 0, 1, "boolean"),
  p(P.EXCITER_TRASH_MODE_ID, "Trash Mode", 0, 0, 1, "boolean"),
  p(P.EXCITER_TUBE_AMOUNT_ID, "Tube", 0, 0, 100, "percent"),
  p(P.EXCITER_TUBE_ASYM_AMOUNT_ID, "Tube+", 0, 0, 100, "percent"),
  p(P.EXCITER_WARM_AMOUNT_ID, "Warm", 30, 0, 100, "percent"),
  p(P.EXCITER_TAPE_AMOUNT_ID, "Tape", 0, 0, 100, "percent"),
  p(P.EXCITER_RETRO_AMOUNT_ID, "Retro", 0, 0, 100, "percent"),
  p(P.EXCITER_OVERDRIVE_AMOUNT_ID, "Overdrive", 0, 0, 100, "percent"),
  p(P.EXCITER_SCREAM_AMOUNT_ID, "Scream", 0, 0, 100, "percent"),
  p(P.EXCITER_CLIPPER_AMOUNT_ID, "Clipper", 0, 0, 100, "percent"),
  p(P.EXCITER_SCRATCH_AMOUNT_ID, "Scratch", 0, 0, 100, "percent"),
  p(P.EXCITER_TONE_SLIDER_ID, "Tone", 0, -100, 100, "generic"),
  // Value 0 was the historical default while the DSP ignored this reserved
  // parameter. Keep it flat so existing projects retain their v1 sound;
  // active emphasis depths are intentionally additive at values 1..3.
  p(P.EXCITER_PRE_EMPHASIS_MODE_ID, "Pre-Emphasis", 0, 0, 3, "enum", true, {
    enumValues: ["flat", "clean", "defined", "full"],
  }),
  p(P.EXCITER_BAND_COUNT_ID, "Exciter Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.EXCITER_CROSSOVER_HZ1_ID, "Exciter Xover 1", 2000, 20, 20000, "hz"),
  p(P.EXCITER_CROSSOVER_HZ2_ID, "Exciter Xover 2", 8000, 20, 20000, "hz"),
  p(P.EXCITER_CROSSOVER_MODE_ID, "Exciter Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.EXCITER_CHANNEL_MODE_ID, "Exciter Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.EXCITER_CROSSOVER_LEARN_ID, "Exciter Xover Learn", 0, 0, 1, "boolean", false),
  p(P.EXCITER_OVERSAMPLING_ID, "Exciter Oversampling", 1, 0, 1, "boolean"),
  p(P.EXCITER_MIX_ID, "Exciter Mix", 50, 0, 100, "percent"),
  p(P.EXCITER_DELTA_ID, "Exciter Delta", 0, 0, 1, "boolean", false),
];

// ═══════════════════════════════════════════════════════════
// TRANSIENT SHAPER PARAMETERS
// ═══════════════════════════════════════════════════════════

const TRANSIENT_PARAMS: UltinaParamDef[] = [
  p(P.TRANSIENT_ENABLED_ID, "Transient Enabled", 0, 0, 1, "boolean"),
  p(P.TRANSIENT_GLOBAL_MODE_ID, "Global Mode", 1, 0, 2, "enum", true, { enumValues: ["precise", "balanced", "loose"] }),
  p(P.TRANSIENT_CONTOUR_SHAPE_ID, "Contour Shape", 1, 0, 2, "enum", true, {
    enumValues: ["sharp", "medium", "smooth"],
  }),
  p(P.TRANSIENT_ATTACK_AMOUNT_ID, "Attack", 0, -100, 100, "generic"),
  p(P.TRANSIENT_SUSTAIN_AMOUNT_ID, "Sustain", 0, -100, 100, "generic"),
  p(P.TRANSIENT_BAND_COUNT_ID, "Transient Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.TRANSIENT_CROSSOVER_HZ1_ID, "Transient Xover 1", 250, 20, 20000, "hz"),
  p(P.TRANSIENT_CROSSOVER_HZ2_ID, "Transient Xover 2", 2500, 20, 20000, "hz"),
  p(P.TRANSIENT_CROSSOVER_MODE_ID, "Transient Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.TRANSIENT_CHANNEL_MODE_ID, "Transient Channel Mode", 0, 0, 2, "enum", true, {
    enumValues: ["stereo", "mid", "side"],
  }),
  p(P.TRANSIENT_CROSSOVER_LEARN_ID, "Transient Xover Learn", 0, 0, 1, "boolean", false),
  p(P.TRANSIENT_DELTA_ID, "Transient Delta", 0, 0, 1, "boolean", false),
  p("transient.mix", "Transient Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// CLIPPER PARAMETERS
// ═══════════════════════════════════════════════════════════

const CLIPPER_PARAMS: UltinaParamDef[] = [
  p(P.CLIPPER_ENABLED_ID, "Clipper Enabled", 0, 0, 1, "boolean"),
  p(P.CLIPPER_CEILING_DB_ID, "Ceiling", -1, -24, 0, "db"),
  p(P.CLIPPER_KNEE_DB_ID, "Knee", 2, 0, 12, "db"),
  p(P.CLIPPER_DRIVE_DB_ID, "Drive", 0, 0, 24, "db"),
  p(P.CLIPPER_BAND_COUNT_ID, "Clipper Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.CLIPPER_CROSSOVER_HZ1_ID, "Clipper Xover 1", 250, 20, 20000, "hz"),
  p(P.CLIPPER_CROSSOVER_HZ2_ID, "Clipper Xover 2", 2500, 20, 20000, "hz"),
  p(P.CLIPPER_CROSSOVER_MODE_ID, "Clipper Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.CLIPPER_CHANNEL_MODE_ID, "Clipper Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.CLIPPER_CROSSOVER_LEARN_ID, "Clipper Xover Learn", 0, 0, 1, "boolean", false),
  p(P.CLIPPER_OVERSAMPLING_ID, "Clipper Oversampling", 1, 0, 1, "boolean"),
  p(P.CLIPPER_DELTA_ID, "Clipper Delta", 0, 0, 1, "boolean", false),
  p("clipper.mix", "Clipper Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// DENSITY PARAMETERS
// ═══════════════════════════════════════════════════════════

const DENSITY_PARAMS: UltinaParamDef[] = [
  p(P.DENSITY_ENABLED_ID, "Density Enabled", 0, 0, 1, "boolean"),
  p(P.DENSITY_THRESHOLD_DB_ID, "Threshold", -30, -60, 0, "db"),
  p(P.DENSITY_RANGE_DB_ID, "Range", 6, 0, 24, "db"),
  p(P.DENSITY_RATIO_ID, "Ratio", 2, 1, 10, "ratio"),
  p(P.DENSITY_ATTACK_MS_ID, "Attack", 10, 0.5, 200, "ms"),
  p(P.DENSITY_RELEASE_MS_ID, "Release", 150, 10, 2000, "ms"),
  p(P.DENSITY_BAND_COUNT_ID, "Density Bands", 1, 1, 3, "enum", false, { enumValues: ["1", "2", "3"] }),
  p(P.DENSITY_CROSSOVER_HZ1_ID, "Density Xover 1", 250, 20, 20000, "hz"),
  p(P.DENSITY_CROSSOVER_HZ2_ID, "Density Xover 2", 2500, 20, 20000, "hz"),
  p(P.DENSITY_CROSSOVER_MODE_ID, "Density Xover Mode", 0, 0, 1, "enum", true, { enumValues: ["analog", "hybrid"] }),
  p(P.DENSITY_CHANNEL_MODE_ID, "Density Channel Mode", 0, 0, 2, "enum", true, {
    enumValues: ["stereo", "mid", "side"],
  }),
  p(P.DENSITY_CROSSOVER_LEARN_ID, "Density Xover Learn", 0, 0, 1, "boolean", false),
  p(P.DENSITY_DELTA_ID, "Density Delta", 0, 0, 1, "boolean", false),
  p("density.mix", "Density Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// SCULPTOR PARAMETERS
// ═══════════════════════════════════════════════════════════

const SCULPTOR_PARAMS: UltinaParamDef[] = [
  p(P.SCULPTOR_ENABLED_ID, "Sculptor Enabled", 0, 0, 1, "boolean"),
  p(P.SCULPTOR_TARGET_PROFILE_ID, "Target", 5, 0, 5, "enum", true, {
    enumValues: ["guitar", "bass", "kick", "piano", "snare", "speech"],
  }),
  p(P.SCULPTOR_AMOUNT_ID, "Amount", 50, 0, 100, "percent"),
  p(P.SCULPTOR_LOW_FREQ_BOUNDARY_HZ_ID, "Low Boundary", 20, 20, 1000, "hz"),
  p(P.SCULPTOR_HIGH_FREQ_BOUNDARY_HZ_ID, "High Boundary", 16000, 1000, 20000, "hz"),
  p(P.SCULPTOR_DRY_WET_ID, "Dry/Wet", 100, 0, 100, "percent"),
  p(P.SCULPTOR_CHANNEL_MODE_ID, "Sculptor Channel Mode", 0, 0, 2, "enum", true, {
    enumValues: ["stereo", "mid", "side"],
  }),
  p(P.SCULPTOR_DELTA_ID, "Sculptor Delta", 0, 0, 1, "boolean", false),
];

// ═══════════════════════════════════════════════════════════
// PHASE PARAMETERS
// ═══════════════════════════════════════════════════════════

const PHASE_PARAMS: UltinaParamDef[] = [
  p(P.PHASE_ENABLED_ID, "Phase Enabled", 0, 0, 1, "boolean"),
  p(P.PHASE_LEARN_ACTIVE_ID, "Phase Learn", 0, 0, 1, "boolean", false),
  p(P.PHASE_ROTATION_DEGREES_ID, "Rotation", 0, -180, 180, "degrees"),
  p(P.PHASE_TIME_SHIFT_MS_ID, "Time Shift", 0, -50, 50, "ms"),
  p(P.PHASE_SIDECHAIN_ENABLED_ID, "Phase Sidechain", 0, 0, 1, "boolean"),
  p(P.PHASE_AUTO_ALIGN_ACTIVE_ID, "Auto Align", 0, 0, 1, "boolean", false),
  p(P.PHASE_DELTA_ID, "Phase Delta", 0, 0, 1, "boolean", false),
  p("phase.mix", "Phase Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// UNMASK PARAMETERS
// ═══════════════════════════════════════════════════════════

const UNMASK_PARAMS: UltinaParamDef[] = [
  p(P.UNMASK_ENABLED_ID, "Unmask Enabled", 0, 0, 1, "boolean"),
  p(P.UNMASK_AMOUNT_ID, "Amount", 50, 0, 100, "percent"),
  p(P.UNMASK_SIDECHAIN_ENABLED_ID, "Unmask Sidechain", 0, 0, 1, "boolean"),
  p(P.UNMASK_MASKING_THRESHOLD_DB_ID, "Masking Threshold", -15, -40, 0, "db"),
  p(P.UNMASK_RESPONSE_SPEED_HZ_ID, "Response Speed", 5, 0.5, 50, "hz"),
  p(P.UNMASK_CHANNEL_MODE_ID, "Unmask Channel Mode", 0, 0, 4, "enum", true, {
    enumValues: ["stereo", "mid", "side", "transient", "sustain"],
  }),
  p(P.UNMASK_LEARN_ACTIVE_ID, "Unmask Learn", 0, 0, 1, "boolean", false),
  p(P.UNMASK_DELTA_ID, "Unmask Delta", 0, 0, 1, "boolean", false),
  p(P.UNMASK_ECOSYSTEM_ENABLED_ID, "Unmask Ecosystem", 0, 0, 1, "boolean", false),
  p("unmask.mix", "Unmask Mix", 100, 0, 100, "percent"),
];

// ═══════════════════════════════════════════════════════════
// COMBINED SCHEMA
// ═══════════════════════════════════════════════════════════

export const ALL_PARAMS: readonly UltinaParamDef[] = [
  ...GLOBAL_PARAMS,
  ...EQ_GLOBAL_PARAMS,
  ...EQ_BAND_PARAMS_ALL,
  ...COMP_PARAMS,
  ...GATE_PARAMS,
  ...EXCITER_PARAMS,
  ...TRANSIENT_PARAMS,
  ...CLIPPER_PARAMS,
  ...DENSITY_PARAMS,
  ...SCULPTOR_PARAMS,
  ...PHASE_PARAMS,
  ...UNMASK_PARAMS,
];

/** Quick lookup: param ID → param def. */
export const PARAM_BY_ID: ReadonlyMap<string, UltinaParamDef> = new Map(ALL_PARAMS.map((d) => [d.id, d]));

/** Get parameter definition by ID. Throws if not found. */
export function getParamDef(id: string): UltinaParamDef {
  const def = PARAM_BY_ID.get(id);
  if (!def) throw new Error(`Unknown parameter: ${id}`);
  return def;
}

/** Get parameter definition by ID, or null if not found. */
export function tryGetParamDef(id: string): UltinaParamDef | null {
  return PARAM_BY_ID.get(id) ?? null;
}

// ── Default parameter map ──────────────────────────────────

/** Build the default parameter map (all params at their default values). */
export function buildDefaultParams(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const def of ALL_PARAMS) {
    result[def.id] = def.defaultValue;
  }
  return result;
}

// ── Normalization helpers ──────────────────────────────────

/** Convert plain-unit value to normalized [0,1]. */
export function toNormalized(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return 0;
  const range = def.maxValue - def.minValue;
  if (range <= 0) return 0;
  return (value - def.minValue) / range;
}

/** Convert normalized [0,1] to plain-unit value. */
export function fromNormalized(id: string, normalized: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return 0;
  const range = def.maxValue - def.minValue;
  return def.minValue + normalized * range;
}

/** Clamp a value to a parameter's range. */
export function clampParam(id: string, value: number): number {
  const def = PARAM_BY_ID.get(id);
  if (!def) return Number.isFinite(value) ? value : 0;
  // NaN/Infinity must never reach the audio path: Math.min/max silently PASS
  // non-finite values through (Math.min(max, NaN) === NaN), and a NaN
  // parameter would flow into coefficient math (filters/limits) and poison
  // the module. Bad automation frames or a corrupted stored state land here.
  if (!Number.isFinite(value)) return def.defaultValue;
  return Math.max(def.minValue, Math.min(def.maxValue, value));
}

/** Total parameter count. */
export function getParamCount(): number {
  return ALL_PARAMS.length;
}

/** Get all automatable parameter IDs. */
export function getAutomatableParamIds(): string[] {
  return ALL_PARAMS.filter((d) => d.automatable).map((d) => d.id);
}
