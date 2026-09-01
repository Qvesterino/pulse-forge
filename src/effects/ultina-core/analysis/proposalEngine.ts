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
// ═══════════════════════════════════════════════════════════
// Ultina — Proposal Engine (v1)
//
// Generates deterministic module toggles + parameter proposals
// from extracted features, instrument classification, character,
// and intensity targets. First release uses deterministic signal
// features and rules. No ML model.
//
// Determinism guarantee:
//   - generateProposal() is a pure function — no side effects
//   - Same (features, instrument, character, intensity) always
//     produces the same output
//   - ANALYSIS_VERSION is a constant — bumping is a breaking change
//
// Architecture:
//   generateProposal()
//     ├── applyProblemDetectionRules()  — feature-driven fixes
//     ├── applyInstrumentRules()        — instrument chain template
//     ├── applyCharacterRules()         — tonal shaping
//     ├── applyDynamicEqRules()         — per-band dynamic EQ
//     └── clampProposals()              — safe bounds
// ═══════════════════════════════════════════════════════════

import type {
  UltinaFeatures,
  ClassificationResult,
  InstrumentType,
  AssistantCharacter,
  AssistantIntensity,
  ParameterProposal,
  ModuleToggleProposal,
  ReasonCode,
} from "./assistant.js";
import {
  PARAM_BY_ID,
  clampParam,
} from "../contracts/parameterSchema.js";
import * as P from "../contracts/parameterIds.js";

// ── Analysis version ─────────────────────────────────────────

export const ANALYSIS_VERSION = 1;

// ── Intensity multipliers ────────────────────────────────────

const INTENSITY_MULTIPLIERS: Record<AssistantIntensity, number> = {
  subtle: 0.5,
  balanced: 1.0,
  strong: 1.5,
};

// ── Detection thresholds ─────────────────────────────────────

const THRESHOLDS = {
  rumbleTrigger: -50,
  subBassTrigger: 0.15,
  noiseFloorTrigger: -60,
  sibilanceTrigger: 0.12,
  dynamicRangeTrigger: 14,
  crestFactorTrigger: 12,
  harshnessTrigger: 0.10,
  spectralTiltDark: -0.3,
  spectralTiltBright: 0.3,
  boxinessTrigger: 0.25, // low-mid ratio
  narrowStereoTrigger: -20,
  wideStereoTrigger: 3,
  lowPunchTrigger: 1.0, // transient density
  highPunchTrigger: 4.0,
  clippingTrigger: 1,
  lowLevelTrigger: -24, // LUFS
};

// ── Helper functions ─────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function addParam(
  changes: ParameterProposal[],
  parameterId: string,
  value: number,
  confidence: number,
  reasonCode: ReasonCode,
  explanation: string,
): void {
  const def = PARAM_BY_ID.get(parameterId);
  if (!def) return;
  changes.push({
    parameterId,
    value: clampParam(parameterId, value),
    confidence: clamp(confidence, 0, 1),
    reasonCode,
    explanation,
  });
}

function addToggle(
  toggles: ModuleToggleProposal[],
  moduleType: string,
  enabled: boolean,
  confidence: number,
  reasonCode: ReasonCode,
  explanation: string,
): void {
  toggles.push({
    moduleType,
    enabled,
    confidence: clamp(confidence, 0, 1),
    reasonCode,
    explanation,
  });
}

// ── EQ band helper ───────────────────────────────────────────

function eqBandId(bandIndex: number, param: string): string {
  return P.eqBandParamId(bandIndex, param);
}

// ── Problem detection rules ──────────────────────────────────

function applyProblemDetectionRules(
  changes: ParameterProposal[],
  toggles: ModuleToggleProposal[],
  features: UltinaFeatures,
  intensity: number,
): void {
  // ── Clipping → Clipper ──
  if (features.clipCount > THRESHOLDS.clippingTrigger) {
    addToggle(toggles, "clipper", true, 0.95,
      "CLIPPING_DETECTED", `${features.clipCount} clipped samples detected. Clipper recommended.`);
    addParam(changes, P.CLIPPER_ENABLED_ID, 1, 0.95,
      "CLIPPING_DETECTED", "Clipper enabled to catch peaks.");
    addParam(changes, P.CLIPPER_CEILING_DB_ID, -0.3, 0.9,
      "CLIPPING_DETECTED", "Ceiling at -0.3 dBFS to prevent digital clipping.");
  }

  // ── Low-frequency rumble → EQ highpass ──
  if (features.rumbleLevelDb > THRESHOLDS.rumbleTrigger) {
    addToggle(toggles, "eq", true, 0.9,
      "LOW_FREQUENCY_RUMBLE", "Low-frequency rumble detected.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.9,
      "LOW_FREQUENCY_RUMBLE", "EQ enabled for rumble filtering.");
    addParam(changes, eqBandId(0, "enabled"), 1, 0.88,
      "LOW_FREQUENCY_RUMBLE", "Band 1 enabled as high-pass filter.");
    const hpfFreq = Math.round(clamp(60 + (features.rumbleLevelDb + 96) * 0.3, 40, 120));
    addParam(changes, eqBandId(0, "freqHz"), hpfFreq, 0.85,
      "LOW_FREQUENCY_RUMBLE", `High-pass filter at ${hpfFreq} Hz.`);
    addParam(changes, eqBandId(0, "shape"), 3, 0.85, // highPass
      "LOW_FREQUENCY_RUMBLE", "High-pass shape selected.");
  }

  // ── Sub-bass buildup → EQ low-cut ──
  if (features.subBassRatio > THRESHOLDS.subBassTrigger) {
    addToggle(toggles, "eq", true, 0.85,
      "SUB_BASS_BUILDUP", "Excessive sub-bass energy detected.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.85,
      "SUB_BASS_BUILDUP", "EQ enabled for sub-bass control.");
    addParam(changes, eqBandId(0, "enabled"), 1, 0.8,
      "SUB_BASS_BUILDUP", "Band 1 enabled for sub-bass reduction.");
    const cutFreq = 60;
    addParam(changes, eqBandId(0, "freqHz"), cutFreq, 0.8,
      "SUB_BASS_BUILDUP", `Low cut at ${cutFreq} Hz.`);
    addParam(changes, eqBandId(0, "gainDb"), -6 * intensity, 0.75,
      "SUB_BASS_BUILDUP", "Sub-bass reduction.");
  }

  // ── Noise floor → Gate ──
  if (features.noiseFloorDb > THRESHOLDS.noiseFloorTrigger) {
    addToggle(toggles, "gate", true, 0.85,
      "NOISE_FLOOR_DETECTED", "Background noise detected. Gate recommended.");
    addParam(changes, P.GATE_ENABLED_ID, 1, 0.85,
      "NOISE_FLOOR_DETECTED", "Gate enabled.");
    const openThreshold = clamp(features.noiseFloorDb + 10, -70, -10);
    addParam(changes, P.gateBandParamId(0, "openThresholdDb"), openThreshold, 0.8,
      "NOISE_FLOOR_DETECTED", `Gate opens at ${openThreshold} dB.`);
    addParam(changes, P.gateBandParamId(0, "closeThresholdDb"), openThreshold - 8, 0.75,
      "NOISE_FLOOR_DETECTED", "Gate closes below threshold.");
    addParam(changes, P.GATE_ATTACK_MS_ID, 2, 0.7,
      "NOISE_FLOOR_DETECTED", "Fast gate attack.");
    addParam(changes, P.GATE_RELEASE_MS_ID, 100, 0.7,
      "NOISE_FLOOR_DETECTED", "Moderate gate release.");
  }

  // ── Excessive dynamic range → Compressor ──
  if (features.dynamicRangeDb > THRESHOLDS.dynamicRangeTrigger) {
    addToggle(toggles, "comp", true, 0.85,
      "EXCESSIVE_DYNAMIC_RANGE", "Wide dynamic range detected.");
    addParam(changes, P.COMP_ENABLED_ID, 1, 0.85,
      "EXCESSIVE_DYNAMIC_RANGE", "Compressor enabled for dynamic control.");
    const threshold = clamp(-15 - features.crestFactorDb * 0.5, -40, -5);
    addParam(changes, P.COMP_THRESHOLD_DB_ID, threshold, 0.8,
      "EXCESSIVE_DYNAMIC_RANGE", `Threshold at ${threshold.toFixed(1)} dB.`);
    const ratio = clamp(2 + features.dynamicRangeDb * 0.08 * intensity, 1.5, 8);
    addParam(changes, P.COMP_RATIO_ID, ratio, 0.75,
      "EXCESSIVE_DYNAMIC_RANGE", `Ratio ${ratio.toFixed(1)}:1.`);
    addParam(changes, P.COMP_ATTACK_MS_ID, 10, 0.7,
      "EXCESSIVE_DYNAMIC_RANGE", "Fast attack for dynamic control.");
    addParam(changes, P.COMP_RELEASE_MS_ID, 150, 0.7,
      "EXCESSIVE_DYNAMIC_RANGE", "Moderate release for natural compression.");
    addParam(changes, P.COMP_MAKEUP_AUTO_ID, 1, 0.65,
      "EXCESSIVE_DYNAMIC_RANGE", "Auto makeup gain enabled.");
  }

  // ── Uneven level / high crest factor → Compression ──
  if (features.crestFactorDb > THRESHOLDS.crestFactorTrigger
      && features.dynamicRangeDb <= THRESHOLDS.dynamicRangeTrigger) {
    addToggle(toggles, "comp", true, 0.75,
      "UNEVEN_LEVEL", "High crest factor indicates uneven dynamics.");
    addParam(changes, P.COMP_ENABLED_ID, 1, 0.75,
      "UNEVEN_LEVEL", "Compressor enabled for consistent level.");
  }

  // ── Insufficient level → Input gain ──
  if (features.lufsIntegrated < THRESHOLDS.lowLevelTrigger && features.rmsLevel > 0) {
    const gainDb = clamp(THRESHOLDS.lowLevelTrigger - features.lufsIntegrated, 0, 12);
    addParam(changes, P.GLOBAL_INPUT_GAIN_DB_ID, gainDb, 0.7,
      "INSUFFICIENT_LEVEL", `Input gain +${gainDb.toFixed(1)} dB to raise level.`);
  }

  // ── Mud buildup (low-mid energy) → EQ cut ──
  if (features.lowMidRatio > THRESHOLDS.boxinessTrigger) {
    addToggle(toggles, "eq", true, 0.75,
      "BOXINESS", "Boxy low-mid buildup detected.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.75,
      "BOXINESS", "EQ enabled for boxiness reduction.");
    addParam(changes, eqBandId(2, "enabled"), 1, 0.72,
      "BOXINESS", "Band 3 enabled for boxiness control.");
    addParam(changes, eqBandId(2, "freqHz"), 300, 0.7,
      "BOXINESS", "Target frequency at 300 Hz.");
    addParam(changes, eqBandId(2, "gainDb"), -5 * intensity, 0.7,
      "BOXINESS", "Reduction to remove boxiness.");
  }

  // ── Harshness → EQ cut ──
  if (features.harshnessIndicator > THRESHOLDS.harshnessTrigger) {
    addToggle(toggles, "eq", true, 0.8,
      "HARSH_FREQUENCY", "Harsh frequency energy detected.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.8,
      "HARSH_FREQUENCY", "EQ enabled for harshness reduction.");
    addParam(changes, eqBandId(6, "enabled"), 1, 0.78,
      "HARSH_FREQUENCY", "Band 7 enabled for harshness control.");
    addParam(changes, eqBandId(6, "freqHz"), 4000, 0.75,
      "HARSH_FREQUENCY", "Target frequency at 4 kHz.");
    addParam(changes, eqBandId(6, "gainDb"), -4 * intensity, 0.72,
      "HARSH_FREQUENCY", "Reduction to tame harshness.");
  }

  // ── Sibilance → Dynamic EQ ──
  if (features.sibilanceRatio > THRESHOLDS.sibilanceTrigger) {
    addToggle(toggles, "eq", true, 0.85,
      "HIGH_SIBILANCE", "High sibilance detected.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.85,
      "HIGH_SIBILANCE", "EQ enabled for de-essing.");
    addParam(changes, eqBandId(7, "enabled"), 1, 0.82,
      "HIGH_SIBILANCE", "Band 8 enabled for sibilance control.");
    const sibFreq = features.spectralTilt > 0 ? 7000 : 6000;
    addParam(changes, eqBandId(7, "freqHz"), sibFreq, 0.78,
      "HIGH_SIBILANCE", `Target frequency at ${sibFreq} Hz.`);
    addParam(changes, eqBandId(7, "mode"), 1, 0.8, // dynamic mode
      "HIGH_SIBILANCE", "Dynamic mode for frequency-selective de-essing.");
    addParam(changes, eqBandId(7, "dynamicThresholdDb"), -24, 0.75,
      "HIGH_SIBILANCE", "Dynamic threshold for sibilance detection.");
    addParam(changes, eqBandId(7, "dynamicRangeDb"), 6, 0.7,
      "HIGH_SIBILANCE", "Dynamic range for de-essing depth.");
  }

  // ── Dull spectrum → Exciter ──
  if (features.spectralTilt < THRESHOLDS.spectralTiltDark) {
    addToggle(toggles, "exciter", true, 0.75,
      "DULL_SPECTRUM", "Dull spectral balance detected.");
    addParam(changes, P.EXCITER_ENABLED_ID, 1, 0.75,
      "DULL_SPECTRUM", "Exciter enabled for brightness.");
    addParam(changes, P.EXCITER_TUBE_AMOUNT_ID, 20 * intensity, 0.7,
      "DULL_SPECTRUM", "Tube saturation for harmonic richness.");
    addParam(changes, P.EXCITER_TONE_SLIDER_ID, 30, 0.65,
      "DULL_SPECTRUM", "Tone biased toward high frequencies.");
  }

  // ── Bright spectrum → EQ high cut ──
  if (features.spectralTilt > THRESHOLDS.spectralTiltBright) {
    addToggle(toggles, "eq", true, 0.7,
      "BRIGHT_SPECTRUM", "Overly bright spectral balance.");
    addParam(changes, P.EQ_ENABLED_ID, 1, 0.7,
      "BRIGHT_SPECTRUM", "EQ enabled for high-frequency taming.");
    addParam(changes, eqBandId(10, "enabled"), 1, 0.68,
      "BRIGHT_SPECTRUM", "Band 11 enabled for high-shelf cut.");
    addParam(changes, eqBandId(10, "freqHz"), 10000, 0.65,
      "BRIGHT_SPECTRUM", "High shelf at 10 kHz.");
    addParam(changes, eqBandId(10, "gainDb"), -3 * intensity, 0.62,
      "BRIGHT_SPECTRUM", "Gentle high-shelf reduction.");
  }

  // ── Lack of punch → Transient shaper ──
  if (features.transientDensity < THRESHOLDS.lowPunchTrigger && features.crestFactorDb > 10) {
    addToggle(toggles, "transient", true, 0.7,
      "LACK_OF_PUNCH", "Low transient activity detected.");
    addParam(changes, P.TRANSIENT_ENABLED_ID, 1, 0.7,
      "LACK_OF_PUNCH", "Transient shaper enabled for punch.");
    addParam(changes, P.TRANSIENT_ATTACK_AMOUNT_ID, 30 * intensity, 0.65,
      "LACK_OF_PUNCH", "Attack boost for transient emphasis.");
  }

  // ── Excessive transient → Transient shaper sustain ──
  if (features.transientDensity > THRESHOLDS.highPunchTrigger) {
    addToggle(toggles, "transient", true, 0.7,
      "EXCESSIVE_TRANSIENT", "High transient activity detected.");
    addParam(changes, P.TRANSIENT_ENABLED_ID, 1, 0.7,
      "EXCESSIVE_TRANSIENT", "Transient shaper enabled for smoothing.");
    addParam(changes, P.TRANSIENT_SUSTAIN_AMOUNT_ID, 20 * intensity, 0.65,
      "EXCESSIVE_TRANSIENT", "Sustain boost to balance transients.");
  }

  // ── Breath noise (high voiced ratio with audible noise) ──
  if (features.voicedRatio > 0.8 && features.noiseFloorDb > -55) {
    addToggle(toggles, "gate", true, 0.7,
      "BREATH_NOISE", "Breath noise detected.");
    addParam(changes, P.GATE_ENABLED_ID, 1, 0.7,
      "BREATH_NOISE", "Gate recommended to reduce breath sounds.");
  }

  // ── Needs density (low RMS with moderate crest) ──
  if (features.rmsLevel < 0.05 && features.crestFactorDb < 14 && features.rmsLevel > 0.001) {
    addToggle(toggles, "density", true, 0.65,
      "NEEDS_DENSITY", "Signal may benefit from density enhancement.");
    addParam(changes, P.DENSITY_ENABLED_ID, 1, 0.65,
      "NEEDS_DENSITY", "Density module enabled.");
    addParam(changes, P.DENSITY_THRESHOLD_DB_ID, -30, 0.6,
      "NEEDS_DENSITY", "Threshold to catch quiet passages.");
    addParam(changes, P.DENSITY_RANGE_DB_ID, 4 * intensity, 0.6,
      "NEEDS_DENSITY", "Gentle upward compression range.");
  }

  // ── Phase issues (low correlation) ──
  if (features.correlation < 0.3) {
    addToggle(toggles, "phase", true, 0.65,
      "PHASE_ISSUES", "Low stereo correlation detected.");
    addParam(changes, P.PHASE_ENABLED_ID, 1, 0.65,
      "PHASE_ISSUES", "Phase module enabled for alignment.");
  }

  // ── Stereo width ──
  if (features.stereoWidthDb < THRESHOLDS.narrowStereoTrigger) {
    // Nearly mono material. Ultina has no dedicated stereo widener,
    // so the actionable treatment is a gentle high-shelf air lift —
    // it improves perceived separation without touching the image.
    addParam(changes, eqBandId(10, "freqHz"), 10000, 0.6,
      "NARROW_STEREO", "Air band at 10 kHz.");
    addParam(changes, eqBandId(10, "shape"), 1, 0.6,
      "NARROW_STEREO", "High shelf.");
    addParam(changes, eqBandId(10, "gainDb"), 2 * intensity, 0.6,
      "NARROW_STEREO", "Gentle air lift for separation (image is near mono).");
  } else if (features.stereoWidthDb > THRESHOLDS.wideStereoTrigger) {
    // Excessively wide / unstable image (often out-of-phase content):
    // recommend the Phase module rather than widening further.
    addToggle(toggles, "phase", true, 0.55,
      "WIDE_STEREO_INSTABILITY", "Very wide stereo image — possible phase issues.");
    addParam(changes, P.PHASE_ENABLED_ID, 1, 0.55,
      "WIDE_STEREO_INSTABILITY", "Phase module enabled for correlation check.");
  }
}

// ── Instrument-specific module chains ────────────────────────

function applyInstrumentRules(
  changes: ParameterProposal[],
  toggles: ModuleToggleProposal[],
  instrument: InstrumentType,
  intensity: number,
): void {
  switch (instrument) {
    case "vocalMale":
    case "vocalFemale": {
      // Chain: Gate → EQ → Comp → (Exciter)
      addToggle(toggles, "eq", true, 0.8,
        "SUGGESTED_STARTING_POINT", "EQ recommended for vocal clarity.");
      addToggle(toggles, "comp", true, 0.8,
        "SUGGESTED_STARTING_POINT", "Compression for consistent vocal level.");
      addParam(changes, P.COMP_THRESHOLD_DB_ID, -20 * intensity, 0.7,
        "SUGGESTED_STARTING_POINT", "Vocal compression threshold.");
      addParam(changes, P.COMP_RATIO_ID, 3 * intensity, 0.7,
        "SUGGESTED_STARTING_POINT", "Vocal compression ratio.");
      // Presence boost for vocal definition
      addParam(changes, eqBandId(6, "enabled"), 1, 0.65,
        "LACK_OF_PRESENCE", "Presence band enabled for vocal clarity.");
      addParam(changes, eqBandId(6, "gainDb"), 2 * intensity, 0.6,
        "LACK_OF_PRESENCE", "Gentle presence boost.");
      break;
    }

    case "bass": {
      // Chain: EQ → Comp → Clipper
      addToggle(toggles, "eq", true, 0.85,
        "SUGGESTED_STARTING_POINT", "EQ recommended for bass definition.");
      addToggle(toggles, "comp", true, 0.85,
        "SUGGESTED_STARTING_POINT", "Compression for consistent bass.");
      addParam(changes, P.COMP_THRESHOLD_DB_ID, -18, 0.75,
        "SUGGESTED_STARTING_POINT", "Bass compression threshold.");
      addParam(changes, P.COMP_RATIO_ID, 4 * intensity, 0.7,
        "SUGGESTED_STARTING_POINT", "Bass compression ratio.");
      addParam(changes, P.COMP_ATTACK_MS_ID, 20, 0.65,
        "SUGGESTED_STARTING_POINT", "Moderate attack to preserve bass transient.");
      // Sub-bass control
      addParam(changes, eqBandId(0, "enabled"), 1, 0.7,
        "SUB_BASS_BUILDUP", "Sub-bass band enabled for control.");
      addParam(changes, eqBandId(0, "freqHz"), 50, 0.65,
        "SUB_BASS_BUILDUP", "Sub-bass frequency at 50 Hz.");
      break;
    }

    case "guitar": {
      // Chain: EQ → Comp → (Transient)
      addToggle(toggles, "eq", true, 0.8,
        "SUGGESTED_STARTING_POINT", "EQ recommended for guitar tone.");
      addToggle(toggles, "comp", true, 0.75,
        "SUGGESTED_STARTING_POINT", "Compression for guitar sustain.");
      addParam(changes, P.COMP_RATIO_ID, 2.5 * intensity, 0.65,
        "SUGGESTED_STARTING_POINT", "Guitar compression ratio.");
      addToggle(toggles, "transient", true, 0.6,
        "SUGGESTED_STARTING_POINT", "Transient shaper for guitar attack.");
      addParam(changes, P.TRANSIENT_ATTACK_AMOUNT_ID, 15 * intensity, 0.55,
        "SUGGESTED_STARTING_POINT", "Gentle attack enhancement.");
      break;
    }

    case "keys": {
      // Chain: EQ → Comp
      addToggle(toggles, "eq", true, 0.8,
        "SUGGESTED_STARTING_POINT", "EQ recommended for keys clarity.");
      addToggle(toggles, "comp", true, 0.75,
        "SUGGESTED_STARTING_POINT", "Compression for consistent keys level.");
      addParam(changes, P.COMP_RATIO_ID, 2 * intensity, 0.6,
        "SUGGESTED_STARTING_POINT", "Gentle compression ratio for keys.");
      break;
    }

    case "drums": {
      // Chain: Gate → EQ → Comp → Transient
      addToggle(toggles, "gate", true, 0.8,
        "SUGGESTED_STARTING_POINT", "Gate for drum cleanup.");
      addToggle(toggles, "eq", true, 0.85,
        "SUGGESTED_STARTING_POINT", "EQ for drum tone shaping.");
      addToggle(toggles, "comp", true, 0.8,
        "SUGGESTED_STARTING_POINT", "Compression for drum punch.");
      addParam(changes, P.COMP_MODE_ID, 0, 0.7, // punch mode
        "SUGGESTED_STARTING_POINT", "Punch compressor mode for drums.");
      addParam(changes, P.COMP_RATIO_ID, 3 * intensity, 0.65,
        "SUGGESTED_STARTING_POINT", "Drum compression ratio.");
      addToggle(toggles, "transient", true, 0.75,
        "SUGGESTED_STARTING_POINT", "Transient shaper for drum impact.");
      addParam(changes, P.TRANSIENT_ATTACK_AMOUNT_ID, 25 * intensity, 0.7,
        "LACK_OF_PUNCH", "Attack boost for drum punch.");
      break;
    }

    case "bus": {
      // Chain: EQ → Comp → Density
      addToggle(toggles, "eq", true, 0.75,
        "SUGGESTED_STARTING_POINT", "EQ for bus tone balancing.");
      addToggle(toggles, "comp", true, 0.8,
        "SUGGESTED_STARTING_POINT", "Glue compression for bus cohesion.");
      addParam(changes, P.COMP_RATIO_ID, 2 * intensity, 0.7,
        "SUGGESTED_STARTING_POINT", "Gentle glue ratio.");
      addParam(changes, P.COMP_ATTACK_MS_ID, 30, 0.65,
        "SUGGESTED_STARTING_POINT", "Slower attack for bus glue.");
      addParam(changes, P.COMP_RELEASE_MS_ID, 250, 0.65,
        "SUGGESTED_STARTING_POINT", "Slower release for natural glue.");
      addToggle(toggles, "density", true, 0.6,
        "NEEDS_DENSITY", "Density for bus fullness.");
      addParam(changes, P.DENSITY_RANGE_DB_ID, 3 * intensity, 0.55,
        "NEEDS_DENSITY", "Gentle density range.");
      break;
    }

    case "master": {
      // Chain: EQ → Comp → Clipper
      addToggle(toggles, "eq", true, 0.7,
        "SUGGESTED_STARTING_POINT", "EQ for master tonal balance.");
      addToggle(toggles, "comp", true, 0.75,
        "SUGGESTED_STARTING_POINT", "Compression for master loudness.");
      addParam(changes, P.COMP_RATIO_ID, 2 * intensity, 0.65,
        "SUGGESTED_STARTING_POINT", "Master compression ratio.");
      addParam(changes, P.COMP_KNEE_DB_ID, 6, 0.6,
        "SUGGESTED_STARTING_POINT", "Soft knee for transparent compression.");
      addToggle(toggles, "clipper", true, 0.7,
        "SUGGESTED_STARTING_POINT", "Clipper for master ceiling.");
      addParam(changes, P.CLIPPER_CEILING_DB_ID, -1, 0.7,
        "SUGGESTED_STARTING_POINT", "Master ceiling at -1 dBFS.");
      addParam(changes, P.CLIPPER_KNEE_DB_ID, 3, 0.6,
        "SUGGESTED_STARTING_POINT", "Soft clipper knee.");
      break;
    }
  }
}

// ── Character-specific adjustments ───────────────────────────

function applyCharacterRules(
  changes: ParameterProposal[],
  toggles: ModuleToggleProposal[],
  character: AssistantCharacter,
  intensity: number,
): void {
  switch (character) {
    case "clean":
      // Minimal processing — disable optional modules
      addToggle(toggles, "exciter", false, 0.5,
        "SUGGESTED_STARTING_POINT", "Clean character: exciter disabled.");
      addToggle(toggles, "density", false, 0.5,
        "SUGGESTED_STARTING_POINT", "Clean character: density disabled.");
      break;

    case "warm":
      // Body boost, gentle exciter tube, slight presence cut
      addToggle(toggles, "exciter", true, 0.65,
        "NEEDS_WARMTH", "Exciter enabled for harmonic warmth.");
      addParam(changes, P.EXCITER_ENABLED_ID, 1, 0.65,
        "NEEDS_WARMTH", "Exciter enabled.");
      addParam(changes, P.EXCITER_TUBE_AMOUNT_ID, 30 * intensity, 0.7,
        "NEEDS_WARMTH", "Tube saturation for warmth.");
      addParam(changes, P.EXCITER_WARM_AMOUNT_ID, 40 * intensity, 0.7,
        "NEEDS_WARMTH", "Warm saturation for harmonic richness.");
      addParam(changes, P.EXCITER_TONE_SLIDER_ID, -20, 0.6,
        "NEEDS_WARMTH", "Tone biased toward low frequencies.");
      // Body boost
      addParam(changes, eqBandId(3, "enabled"), 1, 0.6,
        "NEEDS_WARMTH", "Body band enabled.");
      addParam(changes, eqBandId(3, "gainDb"), 2 * intensity, 0.55,
        "NEEDS_WARMTH", "Body boost for warmth.");
      break;

    case "forward":
      // Presence boost, slight body cut
      addParam(changes, eqBandId(6, "enabled"), 1, 0.7,
        "LACK_OF_PRESENCE", "Presence band enabled for forward character.");
      addParam(changes, eqBandId(6, "gainDb"), 4 * intensity, 0.65,
        "LACK_OF_PRESENCE", "Presence boost.");
      addParam(changes, eqBandId(7, "enabled"), 1, 0.6,
        "LACK_OF_PRESENCE", "Air band enabled.");
      addParam(changes, eqBandId(7, "gainDb"), 2 * intensity, 0.55,
        "LACK_OF_PRESENCE", "Air boost for clarity.");
      break;

    case "punchy":
      // More transient attack, punch compressor mode
      addToggle(toggles, "transient", true, 0.7,
        "LACK_OF_PUNCH", "Transient shaper enabled for punchy character.");
      addParam(changes, P.TRANSIENT_ENABLED_ID, 1, 0.7,
        "LACK_OF_PUNCH", "Transient shaper enabled.");
      addParam(changes, P.TRANSIENT_ATTACK_AMOUNT_ID, 35 * intensity, 0.7,
        "LACK_OF_PUNCH", "Strong attack boost.");
      addParam(changes, P.COMP_MODE_ID, 0, 0.65, // punch
        "LACK_OF_PUNCH", "Punch compressor mode.");
      addParam(changes, P.COMP_ATTACK_MS_ID, 5, 0.6,
        "LACK_OF_PUNCH", "Fast compressor attack for punch.");
      break;

    case "wide":
      // Phase/stereo enhancement
      addToggle(toggles, "phase", true, 0.6,
        "SUGGESTED_STARTING_POINT", "Phase module for stereo enhancement.");
      addParam(changes, P.PHASE_ENABLED_ID, 1, 0.6,
        "SUGGESTED_STARTING_POINT", "Phase module enabled.");
      break;

    case "aggressive":
      // More compression, drive, presence
      addToggle(toggles, "exciter", true, 0.7,
        "NEEDS_BRIGHTNESS", "Exciter enabled for aggressive character.");
      addParam(changes, P.EXCITER_ENABLED_ID, 1, 0.7,
        "NEEDS_BRIGHTNESS", "Exciter enabled.");
      addParam(changes, P.EXCITER_OVERDRIVE_AMOUNT_ID, 30 * intensity, 0.65,
        "NEEDS_BRIGHTNESS", "Overdrive for aggressive edge.");
      addParam(changes, P.EXCITER_TRASH_MODE_ID, 1, 0.6,
        "NEEDS_BRIGHTNESS", "Trash mode enabled for aggressive distortion.");
      addParam(changes, P.COMP_RATIO_ID, 5 * intensity, 0.7,
        "SUGGESTED_STARTING_POINT", "Higher compression ratio.");
      addParam(changes, eqBandId(6, "gainDb"), 3 * intensity, 0.6,
        "LACK_OF_PRESENCE", "Presence boost for aggression.");
      break;
  }
}

// ── Dynamic EQ per band (Phase C6) ───────────────────────────
//
// Configures specific EQ bands in dynamic mode for frequency-
// selective compression. Each problem area gets its own band:
//   - Mud (200-300 Hz)     → Band 2
//   - Boxiness (300-500)   → Band 3
//   - Nasal (800-1200)     → Band 4
//   - Presence (2-4 kHz)   → Band 6
//   - Harshness (3-5 kHz)  → Band 6/7
//   - Sibilance (5-8 kHz)  → Band 7
//   - Air (8-12 kHz)       → Band 8/9

function applyDynamicEqRules(
  changes: ParameterProposal[],
  features: UltinaFeatures,
  intensity: number,
): void {
  // Master EQ enable
  addParam(changes, P.EQ_ENABLED_ID, 1, 0.75,
    "SUGGESTED_STARTING_POINT", "EQ enabled for dynamic per-band control.");

  // ── Mud band (Band 2, ~200 Hz) ──
  if (features.lowMidRatio > THRESHOLDS.boxinessTrigger * 0.8) {
    addParam(changes, eqBandId(2, "enabled"), 1, 0.7,
      "MUD_FREQUENCY_BUILDUP", "Mud band enabled in dynamic mode.");
    addParam(changes, eqBandId(2, "freqHz"), 200, 0.68,
      "MUD_FREQUENCY_BUILDUP", "Mud frequency at 200 Hz.");
    addParam(changes, eqBandId(2, "mode"), 1, 0.7, // dynamic
      "MUD_FREQUENCY_BUILDUP", "Dynamic mode for adaptive mud control.");
    addParam(changes, eqBandId(2, "dynamicThresholdDb"), -20 - 5 * intensity, 0.65,
      "MUD_FREQUENCY_BUILDUP", "Dynamic threshold for mud detection.");
    addParam(changes, eqBandId(2, "dynamicRangeDb"), clamp(4 * intensity, 0, 12), 0.6,
      "MUD_FREQUENCY_BUILDUP", "Dynamic range for mud reduction depth.");
  }

  // ── Harshness band (Band 6, ~3 kHz) ──
  if (features.harshnessIndicator > THRESHOLDS.harshnessTrigger * 0.8) {
    addParam(changes, eqBandId(6, "enabled"), 1, 0.72,
      "HARSH_FREQUENCY", "Harshness band enabled in dynamic mode.");
    addParam(changes, eqBandId(6, "freqHz"), 3000, 0.7,
      "HARSH_FREQUENCY", "Harshness frequency at 3 kHz.");
    addParam(changes, eqBandId(6, "mode"), 1, 0.72, // dynamic
      "HARSH_FREQUENCY", "Dynamic mode for adaptive harshness control.");
    addParam(changes, eqBandId(6, "dynamicThresholdDb"), -18 - 5 * intensity, 0.68,
      "HARSH_FREQUENCY", "Dynamic threshold for harshness detection.");
    addParam(changes, eqBandId(6, "dynamicRangeDb"), clamp(5 * intensity, 0, 12), 0.62,
      "HARSH_FREQUENCY", "Dynamic range for harshness reduction depth.");
  }

  // ── Sibilance band (Band 7, ~6-7 kHz) ──
  if (features.sibilanceRatio > THRESHOLDS.sibilanceTrigger * 0.8) {
    const sibFreq = features.spectralTilt > 0 ? 7000 : 6000;
    addParam(changes, eqBandId(7, "enabled"), 1, 0.75,
      "HIGH_SIBILANCE", "Sibilance band enabled in dynamic mode.");
    addParam(changes, eqBandId(7, "freqHz"), sibFreq, 0.72,
      "HIGH_SIBILANCE", `Sibilance frequency at ${sibFreq} Hz.`);
    addParam(changes, eqBandId(7, "mode"), 1, 0.75, // dynamic
      "HIGH_SIBILANCE", "Dynamic mode for frequency-selective de-essing.");
    addParam(changes, eqBandId(7, "dynamicThresholdDb"), -22 - 5 * intensity, 0.7,
      "HIGH_SIBILANCE", "Dynamic threshold for sibilance detection.");
    addParam(changes, eqBandId(7, "dynamicRangeDb"), clamp(6 * intensity, 0, 12), 0.65,
      "HIGH_SIBILANCE", "Dynamic range for de-essing depth.");
  }

  // ── Nasal band (Band 4, ~1 kHz) — only for vocals ──
  if (features.voicedRatio > 0.3 && features.spectralTilt < 0) {
    addParam(changes, eqBandId(4, "enabled"), 1, 0.6,
      "NASAL_RESONANCE", "Nasal band enabled.");
    addParam(changes, eqBandId(4, "freqHz"), 1000, 0.58,
      "NASAL_RESONANCE", "Nasal frequency at 1 kHz.");
    addParam(changes, eqBandId(4, "mode"), 1, 0.6, // dynamic
      "NASAL_RESONANCE", "Dynamic mode for adaptive nasal control.");
    addParam(changes, eqBandId(4, "dynamicThresholdDb"), -20, 0.55,
      "NASAL_RESONANCE", "Dynamic threshold for nasal detection.");
    addParam(changes, eqBandId(4, "dynamicRangeDb"), clamp(3 * intensity, 0, 9), 0.5,
      "NASAL_RESONANCE", "Dynamic range for nasal reduction depth.");
  }

  // ── Air band (Band 9, ~12 kHz) — for dull signals ──
  if (features.spectralTilt < THRESHOLDS.spectralTiltDark) {
    addParam(changes, eqBandId(9, "enabled"), 1, 0.65,
      "LACK_OF_AIR", "Air band enabled.");
    addParam(changes, eqBandId(9, "freqHz"), 12000, 0.62,
      "LACK_OF_AIR", "Air frequency at 12 kHz.");
    addParam(changes, eqBandId(9, "shape"), 1, 0.6, // highShelf
      "LACK_OF_AIR", "High shelf for air boost.");
    addParam(changes, eqBandId(9, "gainDb"), 3 * intensity, 0.58,
      "LACK_OF_AIR", "Air boost for brightness.");
  }
}

// ── Deduplication ────────────────────────────────────────────
//
// Multiple rules may propose different values for the same
// parameter. We keep the one with the highest confidence.
// For toggles, we keep "enabled" if any rule wants it enabled.

function deduplicateChanges(changes: ParameterProposal[]): ParameterProposal[] {
  const map = new Map<string, ParameterProposal>();
  for (const c of changes) {
    const existing = map.get(c.parameterId);
    if (!existing || c.confidence > existing.confidence) {
      map.set(c.parameterId, c);
    }
  }
  return Array.from(map.values());
}

function deduplicateToggles(toggles: ModuleToggleProposal[]): ModuleToggleProposal[] {
  const map = new Map<string, ModuleToggleProposal>();
  for (const t of toggles) {
    const existing = map.get(t.moduleType);
    if (!existing) {
      map.set(t.moduleType, t);
    } else {
      // Prefer enabled=true with highest confidence
      if (t.enabled && !existing.enabled) {
        map.set(t.moduleType, t);
      } else if (t.enabled === existing.enabled && t.confidence > existing.confidence) {
        map.set(t.moduleType, t);
      }
    }
  }
  return Array.from(map.values());
}

// ── Main proposal generator ──────────────────────────────────

/**
 * Generate module toggles + parameter proposals from features,
 * instrument classification, character, and intensity.
 *
 * This is a pure function — no side effects, no randomness.
 * Same inputs always produce the same output.
 */
export function generateProposal(
  features: UltinaFeatures,
  classification: ClassificationResult,
  character: AssistantCharacter,
  intensity: AssistantIntensity,
): { toggles: ModuleToggleProposal[]; changes: ParameterProposal[] } {
  const intensityMult = INTENSITY_MULTIPLIERS[intensity];
  const changes: ParameterProposal[] = [];
  const toggles: ModuleToggleProposal[] = [];

  // Apply feature-based problem detection rules
  applyProblemDetectionRules(changes, toggles, features, intensityMult);

  // Apply instrument-specific chain
  applyInstrumentRules(changes, toggles, classification.instrument, intensityMult);

  // Apply character rules
  applyCharacterRules(changes, toggles, character, intensityMult);

  // Apply dynamic EQ per band
  applyDynamicEqRules(changes, features, intensityMult);

  // Deduplicate (keep highest confidence per parameter)
  return {
    toggles: deduplicateToggles(toggles),
    changes: deduplicateChanges(changes),
  };
}

/**
 * Compute a stable hash of features for regression testing.
 */
export function hashFeatures(features: UltinaFeatures): number {
  let hash = 0;
  const values = [
    features.peakLevel,
    features.clipCount,
    features.rmsLevel,
    features.shortTermLoudness,
    features.lufsIntegrated,
    features.crestFactorDb,
    features.dynamicRangeDb,
    features.noiseFloorDb,
    features.rumbleLevelDb,
    features.subBassRatio,
    features.lowMidRatio,
    features.midRatio,
    features.highMidRatio,
    features.highRatio,
    features.sibilanceRatio,
    features.spectralTilt,
    features.harshnessIndicator,
    features.voicedRatio,
    features.stereoWidthDb,
    features.correlation,
    features.transientDensity,
    features.spectralFlux,
    features.analyzedDuration,
  ];

  for (const v of values) {
    const str = Math.round(v * 10000).toString();
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
  }

  return hash;
}
