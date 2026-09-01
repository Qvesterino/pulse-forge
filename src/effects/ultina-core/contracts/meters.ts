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
// Ultina — Meter Types
//
// Meter snapshots are read-only data pushed from the audio
// thread to the UI at a throttled rate. They are NOT
// automatable parameters.
// ═══════════════════════════════════════════════════════════

import type { ModuleType } from "./moduleTypes.js";

// ── Global meters ──────────────────────────────────────────

export interface GlobalMeters {
  inputPeakL: number;
  inputPeakR: number;
  inputRmsL: number;
  inputRmsR: number;
  outputPeakL: number;
  outputPeakR: number;
  outputRmsL: number;
  outputRmsR: number;
  /** Short-term LUFS (approximation). */
  outputShortTermLufs: number;
  /** True peak dBFS (when enabled). */
  outputTruePeakDb: number;
  /** Auto-Gain correction in dB (0 = inactive). */
  autoGainCorrectionDb: number;
  /** Auto-Gain error in dB (target - actual). */
  autoGainErrorDb: number;
  /** Whether Auto-Gain is actively engaged. */
  autoGainActive: boolean;
  /** Current quality mode (0=tracking, 1=mix, 2=hq). */
  qualityMode: number;
  /** Timestamp in samples. */
  timestamp: number;
  /** Decimated output waveform for oscilloscope (256 samples, mono). */
  outputWaveform: Float32Array | null;
  /** Spectrum data for display (64 bins, dBFS). Populated by FFT analyzer. */
  inputSpectrumDb: Float32Array | null;
}

// ── Per-band meters (for multiband modules) ────────────────

export interface BandMeters {
  /** Peak level at module input (dBFS). */
  inputPeakDb: number;
  /** Peak level at module output (dBFS). */
  outputPeakDb: number;
  /** Gain reduction (dB, positive = reduction). */
  gainReductionDb: number;
  /** RMS level at module output (dBFS). */
  outputRmsDb: number;
}

// ── Module-specific meters ─────────────────────────────────

export interface CompressorMeters {
  bands: BandMeters[];
  /** Current envelope follower level (dBFS). */
  envelopeDb: number;
  /** Compressor gain reduction (smoothed). */
  gainReductionDb: number;
}

export interface GateMeters {
  bands: BandMeters[];
  /** Gate state per band (0=closed, 1=open). */
  gateState: number[];
}

export interface EqMeters {
  /** Per-band gain reduction for dynamic bands (dB). */
  bandGainReductionDb: number[];
  /** Spectrum data for display (64 bins, dBFS). */
  spectrumDb: Float32Array | null;
  /** Masking meter data (if sidechain active). */
  maskingMeter: MaskingMeterData | null;
}

export interface MaskingMeterData {
  /** Per-frequency-bin masking level (dB). Positive = conflict. */
  maskingDb: Float32Array;
  /** Frequency labels for each bin (Hz). */
  freqHz: Float32Array;
}

export interface ExciterMeters {
  bands: BandMeters[];
  /** Harmonic content increase (dB, for visualization). */
  harmonicContentDb: number;
}

export interface TransientMeters {
  bands: BandMeters[];
  /** Transient detection level (0-1). */
  transientLevel: number[];
}

export interface ClipperMeters {
  bands: BandMeters[];
  /** Amount of clipping (dB reduction). */
  clippingReductionDb: number[];
}

export interface DensityMeters {
  bands: BandMeters[];
  /** Upward gain applied (dB). */
  upwardGainDb: number[];
}

export interface SculptorMeters {
  /** Current spectral curve (dB per band, for display). */
  spectralCurveDb: Float32Array | null;
  /** Target curve (dB per band, for display). */
  targetCurveDb: Float32Array | null;
  /** Measured input band levels (dB per band, for display). */
  bandLevelDb: Float32Array | null;
  /** Amount of correction actively applied (0-1). */
  amountActive: number;
}

export interface PhaseMeters {
  /** Detected asymmetry (0-1). */
  asymmetry: number;
  /** Phase correlation (-1 to 1). */
  correlation: number;
  /** Time offset detected (ms). */
  detectedOffsetMs: number;
}

export interface UnmaskMeters {
  /** Per-band masking level (dB). 32 bands. */
  maskingPerBandDb: Float32Array;
  /** Per-band gain reduction (dB). */
  gainReductionPerBandDb: Float32Array;
  /** Overall masking score (0-1). */
  maskingScore: number;
  /** Threshold auto-calibrated by learn mode (dB); valid while learning. */
  learnedThresholdDb: number;
}

// ── Learn analysis (processor → editor round-trip) ──────────

/** EQ Learn result flowing to the editor while eq.learnActive is on. */
export interface EqLearnMeters {
  /** Detected resonances with suggested cuts, sorted by severity. */
  suggestions: Array<{
    freqHz: number;
    /** Suggested cut (negative dB). */
    gainDb: number;
    q: number;
    severity: number;
  }>;
  /** True once enough audio was analyzed to trust the suggestions. */
  isReady: boolean;
}

/** Crossover Learn result flowing to the editor while learning is on. */
export interface CrossoverLearnMeters {
  /** Suggested split points (Hz); freqHz2 is null in 2-band mode. */
  freqHz1: number;
  freqHz2: number | null;
  /** Confidence of the primary suggestion (0–1). */
  confidence: number;
  /** True once enough audio was analyzed. */
  isReady: boolean;
}

export interface LearnMeters {
  /** Present while eq.learnActive is on. */
  eq: EqLearnMeters | null;
  /** Present while any *.crossoverLearn param is on. */
  crossover: CrossoverLearnMeters | null;
}

// ── Full meter snapshot ────────────────────────────────────

export interface ModuleMeterEntry {
  moduleType: ModuleType;
  meters: unknown; // One of the module-specific meter types
}

export interface UltinaMeters {
  global: GlobalMeters;
  modules: Record<string, unknown>;
  /** Learn-analysis results (null fields when not learning). */
  learn: LearnMeters;
}

// ── Default meter values ───────────────────────────────────

export function createDefaultGlobalMeters(): GlobalMeters {
  return {
    inputPeakL: -100,
    inputPeakR: -100,
    inputRmsL: -100,
    inputRmsR: -100,
    outputPeakL: -100,
    outputPeakR: -100,
    outputRmsL: -100,
    outputRmsR: -100,
    outputShortTermLufs: -70,
    outputTruePeakDb: -100,
    autoGainCorrectionDb: 0,
    autoGainErrorDb: 0,
    autoGainActive: false,
    qualityMode: 1,
    timestamp: 0,
    outputWaveform: null,
    inputSpectrumDb: null,
  };
}

export function createDefaultMeters(): UltinaMeters {
  return {
    global: createDefaultGlobalMeters(),
    modules: {},
    learn: { eq: null, crossover: null },
  };
}
