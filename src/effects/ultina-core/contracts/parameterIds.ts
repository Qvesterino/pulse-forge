/* eslint-disable */
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
// ═══════════════════════════════════════════════════════════
// Ultina — Stable Parameter IDs
//
// Every public parameter has an immutable string ID and a
// checked-in VST3 ParamID mapping.
//
// RULES:
//   1. IDs are dot-namespaced: global.*, eq.*, comp.*, etc.
//   2. VST3 ParamIDs are allocated in contiguous ranges per module.
//   3. Once assigned, an ID or ParamID must never change meaning.
//   4. New parameters in a minor version get new IDs; removed
//      parameters are deprecated, not renumbered.
//   5. Meter values are NOT automatable parameters.
// ═══════════════════════════════════════════════════════════

// ── VST3 ParamID allocation ranges ─────────────────────────
//
// Module              Range       Count
// ─────────────── ─────────── ──────
// Global              0–63        64
// Equalizer           64–255      192
// Compressor          256–319     64
// Gate                320–383     64
// Exciter             384–447     64
// Transient Shaper    448–511     64
// Clipper             512–575     64
// Density             576–639     64
// Sculptor            640–703     64
// Phase               704–767     64
// Unmask              768–831     64
// Reserved            832–1023    192

// ═══════════════════════════════════════════════════════════
// GLOBAL PARAMETERS (VST3: 0–63)
// ═══════════════════════════════════════════════════════════

export const GLOBAL_BYPASS_ID            = "global.bypass"             as const;  // 0
export const GLOBAL_INPUT_GAIN_DB_ID     = "global.inputGainDb"        as const;  // 1
export const GLOBAL_OUTPUT_GAIN_DB_ID    = "global.outputGainDb"       as const;  // 2
export const GLOBAL_MIX_ID               = "global.mix"                as const;  // 3
export const GLOBAL_QUALITY_MODE_ID      = "global.qualityMode"        as const;  // 4
export const GLOBAL_DELTA_LISTEN_ID      = "global.deltaListen"        as const;  // 5
export const GLOBAL_GAIN_MATCH_ENABLED_ID = "global.gainMatchEnabled"  as const;  // 6
export const GLOBAL_AB_SLOT_ID           = "global.abSlot"             as const;  // 7
export const GLOBAL_AUTOGAIN_TARGET_LUFS_ID = "global.autogainTargetLufs" as const; // 8

// ═══════════════════════════════════════════════════════════
// EQUALIZER PARAMETERS (VST3: 64–255)
// ═══════════════════════════════════════════════════════════

export const EQ_ENABLED_ID               = "eq.enabled"                as const;  // 64
export const EQ_CHANNEL_MODE_ID          = "eq.channelMode"            as const;  // 65
export const EQ_SOFT_SATURATION_ID       = "eq.softSaturation"         as const;  // 66
export const EQ_LEARN_ACTIVE_ID          = "eq.learnActive"            as const;  // 67
export const EQ_MASKING_METER_ENABLED_ID = "eq.maskingMeterEnabled"    as const;  // 68
export const EQ_SIDECHAIN_ENABLED_ID     = "eq.sidechainEnabled"       as const;  // 69

// 12 bands × 14 params each = 168 params (IDs 70–237)
// Each band: enabled, freqHz, gainDb, q, shape, mode,
//            dynamicRangeDb, dynamicThresholdDb, sidechainEnabled, solo,
//            dynamicAttackMs, dynamicReleaseMs, dynamicRatio, dynamicKneeDb
export const EQ_MAX_BANDS = 12;
export const EQ_BAND_PARAM_COUNT = 14;

/** Build EQ band parameter ID. */
export function eqBandParamId(bandIndex: number, param: string): string {
  return `eq.band${bandIndex}.${param}`;
}

export const EQ_BAND_PARAMS = [
  "enabled",
  "freqHz",
  "gainDb",
  "q",
  "shape",
  "mode",
  "dynamicRangeDb",
  "dynamicThresholdDb",
  "sidechainEnabled",
  "solo",
  "dynamicAttackMs",
  "dynamicReleaseMs",
  "dynamicRatio",
  "dynamicKneeDb",
] as const;

// VST3 base for EQ band 0 = 70
export const EQ_BAND_VST3_BASE = 70;
export function eqBandVst3Id(bandIndex: number, paramIndex: number): number {
  return EQ_BAND_VST3_BASE + bandIndex * EQ_BAND_PARAM_COUNT + paramIndex;
}

// ═══════════════════════════════════════════════════════════
// COMPRESSOR PARAMETERS (VST3: 256–319)
// ═══════════════════════════════════════════════════════════

export const COMP_ENABLED_ID             = "comp.enabled"              as const;  // 256
export const COMP_MODE_ID                = "comp.mode"                 as const;  // 257 (0=Punch, 1=Modern, 2=Vintage)
export const COMP_DETECTION_MODE_ID      = "comp.detectionMode"        as const;  // 258 (0=Peak, 1=RMS, 2=TrueEnvelope)
export const COMP_THRESHOLD_DB_ID        = "comp.thresholdDb"          as const;  // 259
export const COMP_RATIO_ID               = "comp.ratio"                as const;  // 260
export const COMP_ATTACK_MS_ID           = "comp.attackMs"             as const;  // 261
export const COMP_RELEASE_MS_ID          = "comp.releaseMs"            as const;  // 262
export const COMP_KNEE_DB_ID             = "comp.kneeDb"               as const;  // 263
export const COMP_MAKEUP_DB_ID           = "comp.makeupDb"             as const;  // 264
export const COMP_MAKEUP_AUTO_ID         = "comp.makeupAuto"           as const;  // 265
export const COMP_AUTO_RELEASE_ID        = "comp.autoRelease"          as const;  // 266
export const COMP_MIX_ID                 = "comp.mix"                  as const;  // 267
export const COMP_SIDECHAIN_ENABLED_ID   = "comp.sidechainEnabled"     as const;  // 268
export const COMP_SIDECHAIN_HPF_HZ_ID    = "comp.sidechainHpfHz"       as const;  // 269
export const COMP_BAND_COUNT_ID          = "comp.bandCount"            as const;  // 270
export const COMP_CROSSOVER_HZ1_ID       = "comp.crossoverHz1"         as const;  // 271
export const COMP_CROSSOVER_HZ2_ID       = "comp.crossoverHz2"         as const;  // 272
export const COMP_CROSSOVER_MODE_ID      = "comp.crossoverMode"        as const;  // 273
export const COMP_CHANNEL_MODE_ID        = "comp.channelMode"          as const;  // 274
export const COMP_CROSSOVER_LEARN_ID     = "comp.crossoverLearn"       as const;  // 275
export const COMP_DELTA_ID               = "comp.delta"                as const;  // 276
export const COMP_AUTO_LEARN_THRESHOLD_ID = "comp.autoLearnThreshold"  as const;  // 277

// Per-band threshold override (up to 3 bands)
export function compBandParamId(bandIndex: number, param: string): string {
  return `comp.band${bandIndex}.${param}`;
}

// ═══════════════════════════════════════════════════════════
// GATE PARAMETERS (VST3: 320–383)
// ═══════════════════════════════════════════════════════════

export const GATE_ENABLED_ID             = "gate.enabled"              as const;  // 320
export const GATE_RANGE_DB_ID            = "gate.rangeDb"              as const;  // 321
export const GATE_ATTACK_MS_ID           = "gate.attackMs"             as const;  // 322
export const GATE_HOLD_MS_ID             = "gate.holdMs"               as const;  // 323
export const GATE_RELEASE_MS_ID          = "gate.releaseMs"            as const;  // 324
export const GATE_HYSTERESIS_DB_ID       = "gate.hysteresisDb"         as const;  // 325
export const GATE_SIDECHAIN_HPF_HZ_ID    = "gate.sidechainHpfHz"       as const;  // 326
export const GATE_BAND_COUNT_ID          = "gate.bandCount"            as const;  // 327
export const GATE_CROSSOVER_HZ1_ID       = "gate.crossoverHz1"         as const;  // 328
export const GATE_CROSSOVER_HZ2_ID       = "gate.crossoverHz2"         as const;  // 329
export const GATE_CROSSOVER_MODE_ID      = "gate.crossoverMode"        as const;  // 330
export const GATE_CHANNEL_MODE_ID        = "gate.channelMode"          as const;  // 331
export const GATE_CROSSOVER_LEARN_ID     = "gate.crossoverLearn"       as const;  // 332
export const GATE_DELTA_ID               = "gate.delta"                as const;  // 333

// Per-band open/close thresholds (3 bands)
export function gateBandParamId(bandIndex: number, param: string): string {
  return `gate.band${bandIndex}.${param}`;
}

// ═══════════════════════════════════════════════════════════
// EXCITER PARAMETERS (VST3: 384–447)
// ═══════════════════════════════════════════════════════════

export const EXCITER_ENABLED_ID          = "exciter.enabled"           as const;  // 384
export const EXCITER_TRASH_MODE_ID       = "exciter.trashMode"         as const;  // 385
// Saturation types (blendable)
export const EXCITER_TUBE_AMOUNT_ID      = "exciter.tubeAmount"        as const;  // 386
export const EXCITER_WARM_AMOUNT_ID      = "exciter.warmAmount"        as const;  // 387
export const EXCITER_TAPE_AMOUNT_ID      = "exciter.tapeAmount"        as const;  // 388
export const EXCITER_RETRO_AMOUNT_ID     = "exciter.retroAmount"       as const;  // 389
// Distortion types (Trash mode)
export const EXCITER_OVERDRIVE_AMOUNT_ID = "exciter.overdriveAmount"   as const;  // 390
export const EXCITER_SCREAM_AMOUNT_ID    = "exciter.screamAmount"      as const;  // 391
export const EXCITER_CLIPPER_AMOUNT_ID   = "exciter.clipperAmount"     as const;  // 392
export const EXCITER_SCRATCH_AMOUNT_ID   = "exciter.scratchAmount"     as const;  // 393
// Tone & emphasis
export const EXCITER_TONE_SLIDER_ID      = "exciter.toneSlider"        as const;  // 394
export const EXCITER_PRE_EMPHASIS_MODE_ID = "exciter.preEmphasisMode"  as const;  // 395 (0=Full,1=Defined,2=Clean,3=Flat)
// Multiband
export const EXCITER_BAND_COUNT_ID       = "exciter.bandCount"         as const;  // 396
export const EXCITER_CROSSOVER_HZ1_ID    = "exciter.crossoverHz1"      as const;  // 397
export const EXCITER_CROSSOVER_HZ2_ID    = "exciter.crossoverHz2"      as const;  // 398
export const EXCITER_CROSSOVER_MODE_ID   = "exciter.crossoverMode"     as const;  // 399
export const EXCITER_CHANNEL_MODE_ID     = "exciter.channelMode"       as const;  // 400
export const EXCITER_CROSSOVER_LEARN_ID  = "exciter.crossoverLearn"    as const;  // 401
export const EXCITER_OVERSAMPLING_ID     = "exciter.oversampling"      as const;  // 402
export const EXCITER_MIX_ID              = "exciter.mix"               as const;  // 403
export const EXCITER_DELTA_ID            = "exciter.delta"             as const;  // 404

// ═══════════════════════════════════════════════════════════
// TRANSIENT SHAPER PARAMETERS (VST3: 448–511)
// ═══════════════════════════════════════════════════════════

export const TRANSIENT_ENABLED_ID        = "transient.enabled"         as const;  // 448
export const TRANSIENT_GLOBAL_MODE_ID    = "transient.globalMode"      as const;  // 449 (0=Precise,1=Balanced,2=Loose)
export const TRANSIENT_CONTOUR_SHAPE_ID  = "transient.contourShape"    as const;  // 450 (0=Sharp,1=Medium,2=Smooth)
export const TRANSIENT_ATTACK_AMOUNT_ID  = "transient.attackAmount"    as const;  // 451 (-100 to 100)
export const TRANSIENT_SUSTAIN_AMOUNT_ID = "transient.sustainAmount"   as const;  // 452 (-100 to 100)
export const TRANSIENT_BAND_COUNT_ID     = "transient.bandCount"       as const;  // 453
export const TRANSIENT_CROSSOVER_HZ1_ID  = "transient.crossoverHz1"    as const;  // 454
export const TRANSIENT_CROSSOVER_HZ2_ID  = "transient.crossoverHz2"    as const;  // 455
export const TRANSIENT_CROSSOVER_MODE_ID = "transient.crossoverMode"   as const;  // 456
export const TRANSIENT_CHANNEL_MODE_ID   = "transient.channelMode"     as const;  // 457
export const TRANSIENT_CROSSOVER_LEARN_ID = "transient.crossoverLearn" as const;  // 458
export const TRANSIENT_DELTA_ID          = "transient.delta"           as const;  // 459

// ═══════════════════════════════════════════════════════════
// CLIPPER PARAMETERS (VST3: 512–575)
// ═══════════════════════════════════════════════════════════

export const CLIPPER_ENABLED_ID          = "clipper.enabled"           as const;  // 512
export const CLIPPER_CEILING_DB_ID       = "clipper.ceilingDb"         as const;  // 513
export const CLIPPER_KNEE_DB_ID          = "clipper.kneeDb"            as const;  // 514
export const CLIPPER_DRIVE_DB_ID         = "clipper.driveDb"           as const;  // 515
export const CLIPPER_BAND_COUNT_ID       = "clipper.bandCount"         as const;  // 516
export const CLIPPER_CROSSOVER_HZ1_ID    = "clipper.crossoverHz1"      as const;  // 517
export const CLIPPER_CROSSOVER_HZ2_ID    = "clipper.crossoverHz2"      as const;  // 518
export const CLIPPER_CROSSOVER_MODE_ID   = "clipper.crossoverMode"     as const;  // 519
export const CLIPPER_CHANNEL_MODE_ID     = "clipper.channelMode"       as const;  // 520
export const CLIPPER_CROSSOVER_LEARN_ID  = "clipper.crossoverLearn"    as const;  // 521
export const CLIPPER_OVERSAMPLING_ID     = "clipper.oversampling"      as const;  // 522
export const CLIPPER_DELTA_ID            = "clipper.delta"             as const;  // 523

// ═══════════════════════════════════════════════════════════
// DENSITY PARAMETERS (VST3: 576–639)
// ═══════════════════════════════════════════════════════════

export const DENSITY_ENABLED_ID          = "density.enabled"           as const;  // 576
export const DENSITY_THRESHOLD_DB_ID     = "density.thresholdDb"       as const;  // 577
export const DENSITY_RANGE_DB_ID         = "density.rangeDb"           as const;  // 578
export const DENSITY_RATIO_ID            = "density.ratio"             as const;  // 579
export const DENSITY_ATTACK_MS_ID        = "density.attackMs"          as const;  // 580
export const DENSITY_RELEASE_MS_ID       = "density.releaseMs"         as const;  // 581
export const DENSITY_BAND_COUNT_ID       = "density.bandCount"         as const;  // 582
export const DENSITY_CROSSOVER_HZ1_ID    = "density.crossoverHz1"      as const;  // 583
export const DENSITY_CROSSOVER_HZ2_ID    = "density.crossoverHz2"      as const;  // 584
export const DENSITY_CROSSOVER_MODE_ID   = "density.crossoverMode"     as const;  // 585
export const DENSITY_CHANNEL_MODE_ID     = "density.channelMode"       as const;  // 586
export const DENSITY_CROSSOVER_LEARN_ID  = "density.crossoverLearn"    as const;  // 587
export const DENSITY_DELTA_ID            = "density.delta"             as const;  // 588

// ═══════════════════════════════════════════════════════════
// SCULPTOR PARAMETERS (VST3: 640–703)
// ═══════════════════════════════════════════════════════════

export const SCULPTOR_ENABLED_ID         = "sculptor.enabled"          as const;  // 640
export const SCULPTOR_TARGET_PROFILE_ID  = "sculptor.targetProfile"    as const;  // 641 (0=Guitar,1=Bass,2=Kick,3=Piano,4=Snare,5=Speech)
export const SCULPTOR_AMOUNT_ID          = "sculptor.amount"           as const;  // 642
export const SCULPTOR_LOW_FREQ_BOUNDARY_HZ_ID  = "sculptor.lowFreqBoundaryHz"  as const;  // 643
export const SCULPTOR_HIGH_FREQ_BOUNDARY_HZ_ID = "sculptor.highFreqBoundaryHz" as const;  // 644
export const SCULPTOR_DRY_WET_ID         = "sculptor.dryWet"           as const;  // 645
export const SCULPTOR_CHANNEL_MODE_ID    = "sculptor.channelMode"      as const;  // 646
export const SCULPTOR_DELTA_ID           = "sculptor.delta"            as const;  // 647

// ═══════════════════════════════════════════════════════════
// PHASE PARAMETERS (VST3: 704–767)
// ═══════════════════════════════════════════════════════════

export const PHASE_ENABLED_ID            = "phase.enabled"             as const;  // 704
export const PHASE_LEARN_ACTIVE_ID       = "phase.learnActive"         as const;  // 705
export const PHASE_ROTATION_DEGREES_ID   = "phase.rotationDegrees"     as const;  // 706
export const PHASE_TIME_SHIFT_MS_ID      = "phase.timeShiftMs"         as const;  // 707
export const PHASE_SIDECHAIN_ENABLED_ID  = "phase.sidechainEnabled"    as const;  // 708
export const PHASE_AUTO_ALIGN_ACTIVE_ID  = "phase.autoAlignActive"     as const;  // 709
export const PHASE_DELTA_ID              = "phase.delta"               as const;  // 710

// ═══════════════════════════════════════════════════════════
// UNMASK PARAMETERS (VST3: 768–831)
// ═══════════════════════════════════════════════════════════

export const UNMASK_ENABLED_ID           = "unmask.enabled"            as const;  // 768
export const UNMASK_AMOUNT_ID            = "unmask.amount"             as const;  // 769
export const UNMASK_SIDECHAIN_ENABLED_ID = "unmask.sidechainEnabled"   as const;  // 770
export const UNMASK_MASKING_THRESHOLD_DB_ID = "unmask.maskingThresholdDb" as const; // 771
export const UNMASK_RESPONSE_SPEED_HZ_ID = "unmask.responseSpeedHz"    as const;  // 772
export const UNMASK_CHANNEL_MODE_ID      = "unmask.channelMode"        as const;  // 773
export const UNMASK_LEARN_ACTIVE_ID      = "unmask.learnActive"        as const;  // 774
export const UNMASK_DELTA_ID             = "unmask.delta"              as const;  // 775
export const UNMASK_ECOSYSTEM_ENABLED_ID = "unmask.ecosystemEnabled"   as const;  // 776

// ═══════════════════════════════════════════════════════════
// ALL PARAMETER IDs (flat array for iteration)
// ═══════════════════════════════════════════════════════════

/** All static (non-band-indexed) parameter IDs. */
export const ALL_PARAM_IDS = [
  // Global
  GLOBAL_BYPASS_ID,
  GLOBAL_INPUT_GAIN_DB_ID,
  GLOBAL_OUTPUT_GAIN_DB_ID,
  GLOBAL_MIX_ID,
  GLOBAL_QUALITY_MODE_ID,
  GLOBAL_DELTA_LISTEN_ID,
  GLOBAL_GAIN_MATCH_ENABLED_ID,
  GLOBAL_AB_SLOT_ID,
  GLOBAL_AUTOGAIN_TARGET_LUFS_ID,
  // EQ
  EQ_ENABLED_ID,
  EQ_CHANNEL_MODE_ID,
  EQ_SOFT_SATURATION_ID,
  EQ_LEARN_ACTIVE_ID,
  EQ_MASKING_METER_ENABLED_ID,
  EQ_SIDECHAIN_ENABLED_ID,
  // Compressor
  COMP_ENABLED_ID,
  COMP_MODE_ID,
  COMP_DETECTION_MODE_ID,
  COMP_THRESHOLD_DB_ID,
  COMP_RATIO_ID,
  COMP_ATTACK_MS_ID,
  COMP_RELEASE_MS_ID,
  COMP_KNEE_DB_ID,
  COMP_MAKEUP_DB_ID,
  COMP_MAKEUP_AUTO_ID,
  COMP_AUTO_RELEASE_ID,
  COMP_MIX_ID,
  COMP_SIDECHAIN_ENABLED_ID,
  COMP_SIDECHAIN_HPF_HZ_ID,
  COMP_BAND_COUNT_ID,
  COMP_CROSSOVER_HZ1_ID,
  COMP_CROSSOVER_HZ2_ID,
  COMP_CROSSOVER_MODE_ID,
  COMP_CHANNEL_MODE_ID,
  COMP_CROSSOVER_LEARN_ID,
  COMP_DELTA_ID,
  COMP_AUTO_LEARN_THRESHOLD_ID,
  // Gate
  GATE_ENABLED_ID,
  GATE_RANGE_DB_ID,
  GATE_ATTACK_MS_ID,
  GATE_HOLD_MS_ID,
  GATE_RELEASE_MS_ID,
  GATE_HYSTERESIS_DB_ID,
  GATE_SIDECHAIN_HPF_HZ_ID,
  GATE_BAND_COUNT_ID,
  GATE_CROSSOVER_HZ1_ID,
  GATE_CROSSOVER_HZ2_ID,
  GATE_CROSSOVER_MODE_ID,
  GATE_CHANNEL_MODE_ID,
  GATE_CROSSOVER_LEARN_ID,
  GATE_DELTA_ID,
  // Exciter
  EXCITER_ENABLED_ID,
  EXCITER_TRASH_MODE_ID,
  EXCITER_TUBE_AMOUNT_ID,
  EXCITER_WARM_AMOUNT_ID,
  EXCITER_TAPE_AMOUNT_ID,
  EXCITER_RETRO_AMOUNT_ID,
  EXCITER_OVERDRIVE_AMOUNT_ID,
  EXCITER_SCREAM_AMOUNT_ID,
  EXCITER_CLIPPER_AMOUNT_ID,
  EXCITER_SCRATCH_AMOUNT_ID,
  EXCITER_TONE_SLIDER_ID,
  EXCITER_PRE_EMPHASIS_MODE_ID,
  EXCITER_BAND_COUNT_ID,
  EXCITER_CROSSOVER_HZ1_ID,
  EXCITER_CROSSOVER_HZ2_ID,
  EXCITER_CROSSOVER_MODE_ID,
  EXCITER_CHANNEL_MODE_ID,
  EXCITER_CROSSOVER_LEARN_ID,
  EXCITER_OVERSAMPLING_ID,
  EXCITER_MIX_ID,
  EXCITER_DELTA_ID,
  // Transient Shaper
  TRANSIENT_ENABLED_ID,
  TRANSIENT_GLOBAL_MODE_ID,
  TRANSIENT_CONTOUR_SHAPE_ID,
  TRANSIENT_ATTACK_AMOUNT_ID,
  TRANSIENT_SUSTAIN_AMOUNT_ID,
  TRANSIENT_BAND_COUNT_ID,
  TRANSIENT_CROSSOVER_HZ1_ID,
  TRANSIENT_CROSSOVER_HZ2_ID,
  TRANSIENT_CROSSOVER_MODE_ID,
  TRANSIENT_CHANNEL_MODE_ID,
  TRANSIENT_CROSSOVER_LEARN_ID,
  TRANSIENT_DELTA_ID,
  // Clipper
  CLIPPER_ENABLED_ID,
  CLIPPER_CEILING_DB_ID,
  CLIPPER_KNEE_DB_ID,
  CLIPPER_DRIVE_DB_ID,
  CLIPPER_BAND_COUNT_ID,
  CLIPPER_CROSSOVER_HZ1_ID,
  CLIPPER_CROSSOVER_HZ2_ID,
  CLIPPER_CROSSOVER_MODE_ID,
  CLIPPER_CHANNEL_MODE_ID,
  CLIPPER_CROSSOVER_LEARN_ID,
  CLIPPER_OVERSAMPLING_ID,
  CLIPPER_DELTA_ID,
  // Density
  DENSITY_ENABLED_ID,
  DENSITY_THRESHOLD_DB_ID,
  DENSITY_RANGE_DB_ID,
  DENSITY_RATIO_ID,
  DENSITY_ATTACK_MS_ID,
  DENSITY_RELEASE_MS_ID,
  DENSITY_BAND_COUNT_ID,
  DENSITY_CROSSOVER_HZ1_ID,
  DENSITY_CROSSOVER_HZ2_ID,
  DENSITY_CROSSOVER_MODE_ID,
  DENSITY_CHANNEL_MODE_ID,
  DENSITY_CROSSOVER_LEARN_ID,
  DENSITY_DELTA_ID,
  // Sculptor
  SCULPTOR_ENABLED_ID,
  SCULPTOR_TARGET_PROFILE_ID,
  SCULPTOR_AMOUNT_ID,
  SCULPTOR_LOW_FREQ_BOUNDARY_HZ_ID,
  SCULPTOR_HIGH_FREQ_BOUNDARY_HZ_ID,
  SCULPTOR_DRY_WET_ID,
  SCULPTOR_CHANNEL_MODE_ID,
  SCULPTOR_DELTA_ID,
  // Phase
  PHASE_ENABLED_ID,
  PHASE_LEARN_ACTIVE_ID,
  PHASE_ROTATION_DEGREES_ID,
  PHASE_TIME_SHIFT_MS_ID,
  PHASE_SIDECHAIN_ENABLED_ID,
  PHASE_AUTO_ALIGN_ACTIVE_ID,
  PHASE_DELTA_ID,
  // Unmask
  UNMASK_ENABLED_ID,
  UNMASK_AMOUNT_ID,
  UNMASK_SIDECHAIN_ENABLED_ID,
  UNMASK_MASKING_THRESHOLD_DB_ID,
  UNMASK_RESPONSE_SPEED_HZ_ID,
  UNMASK_CHANNEL_MODE_ID,
  UNMASK_LEARN_ACTIVE_ID,
  UNMASK_DELTA_ID,
  UNMASK_ECOSYSTEM_ENABLED_ID,
] as const;

// ── Module param prefix map ────────────────────────────────

/** Maps a module type to its parameter ID prefix. */
export const MODULE_PARAM_PREFIX: Record<string, string> = {
  eq: "eq.",
  comp: "comp.",
  gate: "gate.",
  exciter: "exciter.",
  transient: "transient.",
  clipper: "clipper.",
  density: "density.",
  sculptor: "sculptor.",
  phase: "phase.",
  unmask: "unmask.",
};

/** Get the module type for a given parameter ID. */
export function getModuleFromParamId(paramId: string): string | null {
  for (const [module, prefix] of Object.entries(MODULE_PARAM_PREFIX)) {
    if (paramId.startsWith(prefix)) return module;
  }
  if (paramId.startsWith("global.")) return "global";
  return null;
}
