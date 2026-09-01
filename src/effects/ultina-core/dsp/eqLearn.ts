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
// Ultina — EQ Learn
//
// Automatic resonance detection and EQ suggestion utility.
// Analyzes incoming audio through multiple narrow band-pass
// filters, tracks per-band energy, and identifies narrow
// resonances/peaks that are abnormally loud relative to the
// spectral average. Returns suggestions for EQ cuts to tame
// these problem frequencies.
//
// Algorithm:
// 1. Split signal into N analysis bands using band-pass filters
// 2. Track per-band smoothed energy (dB)
// 3. Compute spectral centroid and average level
// 4. Identify bands where energy exceeds average + threshold
// 5. Suggest bell cuts proportional to the excess
// ═══════════════════════════════════════════════════════════

import {
  createBiquad,
  setBandPass,
  processBiquadChannel,
  resetBiquad,
  type BiquadState,
} from "./primitives.js";

/** Sanitize a numeric value, returning 0 for NaN/Infinity. */
function safeNum(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// ── Constants ───────────────────────────────────────────────

/** Number of EQ Learn analysis bands (finer than masking meter). */
export const EQ_LEARN_BANDS = 16;

/** Center frequencies for analysis (logarithmically spaced, 60 Hz – 16 kHz). */
export const EQ_LEARN_FREQS = [
  60, 100, 150, 250, 350, 500, 700, 1000,
  1500, 2500, 3500, 5000, 7000, 10000, 12000, 16000,
];

/** Default Q factor for suggested bell cuts. */
const DEFAULT_SUGGEST_Q = 3.0;

/** Maximum suggested cut depth (dB). */
const MAX_CUT_DB = 12;

/** Minimum detection threshold above average (dB). */
const DETECTION_THRESHOLD_DB = 6;

/**
 * A band counts as "active" when it is within this range of the
 * loudest band. A fixed energy floor (1e-8 ≈ −160 dB) is useless in
 * practice: analysis-filter skirts lift nominally silent bands to
 * −30…−90 dB, so they still poison the average.
 */
const ACTIVE_RANGE_DB = 40;

/**
 * A resonance must poke above BOTH neighbours by this margin. Shallow
 * 1–2 dB crests from filter-skirt interference are spectral shape,
 * not resonances.
 */
const LOCAL_PEAK_MARGIN_DB = 3;

// ── Types ───────────────────────────────────────────────────

export interface EqLearnSuggestion {
  /** Center frequency for the EQ band (Hz). */
  freqHz: number;
  /** Recommended gain (dB, negative for cut). */
  gainDb: number;
  /** Recommended Q. */
  q: number;
  /** Severity: 0–1, where 1 is the most problematic. */
  severity: number;
}

export interface EqLearnResult {
  /** Detected resonances with suggested cuts, sorted by severity descending. */
  suggestions: EqLearnSuggestion[];
  /** Per-band energy levels (dB). */
  bandLevels: number[];
  /** Overall spectral centroid (Hz). */
  spectralCentroid: number;
  /** Average energy level (dB). */
  averageLevel: number;
  /** Whether enough data has been accumulated to trust results. */
  isReady: boolean;
}

// ── EQ Learn ────────────────────────────────────────────────

export class EqLearn {
  private filters: BiquadState[] = [];
  private bandEnergy: number[] = new Array(EQ_LEARN_BANDS).fill(0);
  private tempBuf: Float32Array = new Float32Array(0);
  private blockCount = 0;
  private smoothCoef = 0.01;

  /** Minimum blocks before results are considered reliable. */
  private static readonly MIN_BLOCKS = 20;

  prepare(sampleRate: number, maxBlockSize: number): void {
    this.tempBuf = new Float32Array(maxBlockSize);
    // Per-block smoothing coefficient: for a 100ms time constant,
    // compute how many samples that is, then derive the per-block coef
    // based on the expected block size. We assume ~maxBlockSize per block.
    const samplesPerBlock = Math.max(1, maxBlockSize);
    const tauSamples = (100 / 1000) * sampleRate;
    this.smoothCoef = 1 - Math.exp(-samplesPerBlock / tauSamples);

    this.filters = [];
    for (let i = 0; i < EQ_LEARN_BANDS; i++) {
      const bq = createBiquad(1);
      setBandPass(bq.coeffs, EQ_LEARN_FREQS[i], 4, sampleRate);
      this.filters.push(bq);
    }

    this.reset();
  }

  reset(): void {
    this.bandEnergy.fill(0);
    this.blockCount = 0;
    for (const bq of this.filters) resetBiquad(bq);
  }

  /**
   * Process a block of audio and update internal analysis state.
   * Call repeatedly with audio blocks, then call `getResult()` to
   * retrieve EQ suggestions.
   */
  process(input: Float32Array, frameCount: number): void {
    this.ensureBuffers(frameCount);

    for (let b = 0; b < EQ_LEARN_BANDS; b++) {
      const bq = this.filters[b];

      // Copy input and filter through this band
      this.tempBuf.set(input.subarray(0, frameCount));
      processBiquadChannel(bq, this.tempBuf, 0, frameCount);

      // Measure RMS energy of filtered band
      let sumSq = 0;
      for (let i = 0; i < frameCount; i++) {
        const s = this.tempBuf[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, frameCount));

      // Smooth the energy
      this.bandEnergy[b] += this.smoothCoef * (rms - this.bandEnergy[b]);
    }

    this.blockCount++;
  }

  /**
   * Compute the current EQ learn analysis result.
   */
  getResult(): EqLearnResult {
    const bandLevels: number[] = new Array(EQ_LEARN_BANDS);
    let totalWeighted = 0;
    let totalEnergy = 0;

    for (let b = 0; b < EQ_LEARN_BANDS; b++) {
      const db = 20 * Math.log10(Math.max(1e-10, this.bandEnergy[b]));
      bandLevels[b] = safeNum(db);

      const lin = Math.max(1e-10, this.bandEnergy[b]);
      totalWeighted += EQ_LEARN_FREQS[b] * lin;
      totalEnergy += lin;
    }

    const spectralCentroid = totalEnergy > 1e-10
      ? totalWeighted / totalEnergy
      : 1000;

    // Compute average level over ACTIVE bands only, where "active" is
    // dynamic: within ACTIVE_RANGE_DB of the loudest band. Bands far
    // below the peak contribute nothing musically — including them
    // dragged the average toward silence and flagged real content
    // (bass, kick…) as resonances.
    const peakBandLevel = Math.max(...bandLevels);
    const activeLevels = bandLevels.filter((v) => v > peakBandLevel - ACTIVE_RANGE_DB);
    const averageLevel = activeLevels.length > 0
      ? activeLevels.reduce((a, b) => a + b, 0) / activeLevels.length
      : 0;

    // Identify resonance suggestions
    const suggestions: EqLearnSuggestion[] = [];

    for (let b = 0; b < EQ_LEARN_BANDS; b++) {
      const excess = bandLevels[b] - averageLevel;

      if (excess > DETECTION_THRESHOLD_DB) {
        // Local-peak check with margin: a narrow resonance pokes above
        // its NEIGHBOURS by more than filter-skirt interference crests.
        // Broad bulges/tilts are deliberately NOT flagged — a narrow
        // bell cut is the wrong tool for a broad spectral problem.
        const isLocalPeak =
          (b === 0 || bandLevels[b] > bandLevels[b - 1] + LOCAL_PEAK_MARGIN_DB) &&
          (b === EQ_LEARN_BANDS - 1 || bandLevels[b] > bandLevels[b + 1] + LOCAL_PEAK_MARGIN_DB);
        if (!isLocalPeak) continue;

        // Suggested cut proportional to excess, capped at MAX_CUT_DB
        const cutDb = Math.min(MAX_CUT_DB, excess * 0.7);

        // Severity: how much above threshold, normalized
        const severity = Math.min(1, excess / (DETECTION_THRESHOLD_DB * 3));

        suggestions.push({
          freqHz: EQ_LEARN_FREQS[b],
          gainDb: -cutDb,
          q: DEFAULT_SUGGEST_Q,
          severity,
        });
      }
    }

    // Sort by severity descending
    suggestions.sort((a, b) => b.severity - a.severity);

    const isReady = this.blockCount >= EqLearn.MIN_BLOCKS;

    return {
      suggestions,
      bandLevels,
      spectralCentroid: safeNum(spectralCentroid),
      averageLevel: safeNum(averageLevel),
      isReady,
    };
  }

  private ensureBuffers(requiredSize: number): void {
    if (this.tempBuf.length < requiredSize) {
      this.tempBuf = new Float32Array(requiredSize);
    }
  }
}
