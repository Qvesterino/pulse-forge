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
// Ultina — Masking Meter
//
// Spectral comparison utility that identifies frequency regions
// where one signal (the "masker") covers another (the "maskee").
// Used by the EQ module's masking meter feature to show where the
// current track might be masking another track (sidechain input).
//
// Algorithm: Split both signals into N frequency bands using
// band-pass filters. Compare energy levels. If the masker is
// louder than the maskee + masking threshold, masking occurs.
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

/** Number of masking analysis bands. */
export const MASKING_BANDS = 8;

/** Default center frequencies for masking bands (logarithmic). */
export const MASKING_FREQS = [
  100, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

/** Psychoacoustic masking offset (dB). Below this difference, no masking. */
const MASKING_THRESHOLD_DB = 3;

// ── Types ───────────────────────────────────────────────────

export interface MaskingResult {
  /** Per-band masking level (dB, positive = masker is louder). */
  levels: number[];
  /** Per-band boolean: true if masking is occurring. */
  isMasking: boolean[];
  /** Per-band energy of the main signal (dB). */
  mainLevels: number[];
  /** Per-band energy of the sidechain signal (dB). */
  sidechainLevels: number[];
}

// ── Masking Meter ───────────────────────────────────────────

export class MaskingMeter {
  private mainFilters: BiquadState[] = [];
  private scFilters: BiquadState[] = [];
  private mainEnv: number[] = new Array(MASKING_BANDS).fill(0);
  private scEnv: number[] = new Array(MASKING_BANDS).fill(0);
  private mainBuf: Float32Array = new Float32Array(0);
  private scBuf: Float32Array = new Float32Array(0);

  /** Smoothing coefficient for envelope tracking. */
  private smoothCoef = 0.01;

  prepare(sampleRate: number, maxBlockSize: number): void {
    this.mainBuf = new Float32Array(maxBlockSize);
    this.scBuf = new Float32Array(maxBlockSize);
    this.smoothCoef = 1 - Math.exp(-1 / ((50 / 1000) * sampleRate));

    // Create two independent filter banks — one for main, one for sidechain.
    // This ensures proper spectral analysis without cross-contamination.
    this.mainFilters = [];
    this.scFilters = [];
    for (let i = 0; i < MASKING_BANDS; i++) {
      const mainBq = createBiquad(1);
      setBandPass(mainBq.coeffs, MASKING_FREQS[i], 4, sampleRate);
      this.mainFilters.push(mainBq);

      const scBq = createBiquad(1);
      setBandPass(scBq.coeffs, MASKING_FREQS[i], 4, sampleRate);
      this.scFilters.push(scBq);
    }
  }

  reset(): void {
    this.mainEnv.fill(0);
    this.scEnv.fill(0);
    for (const bq of this.mainFilters) resetBiquad(bq);
    for (const bq of this.scFilters) resetBiquad(bq);
  }

  /**
   * Analyze masking between main and sidechain signals.
   * Returns per-band masking data.
   */
  analyze(
    main: Float32Array,
    sidechain: Float32Array,
    frameCount: number,
  ): MaskingResult {
    this.ensureBuffers(frameCount);

    const levels: number[] = new Array(MASKING_BANDS).fill(0);
    const isMasking: boolean[] = new Array(MASKING_BANDS).fill(false);
    const mainLevels: number[] = new Array(MASKING_BANDS).fill(0);
    const scLevels: number[] = new Array(MASKING_BANDS).fill(0);

    for (let b = 0; b < MASKING_BANDS; b++) {
      const mainBq = this.mainFilters[b];
      const scBq = this.scFilters[b];

      // Filter main signal through this band
      this.mainBuf.set(main.subarray(0, frameCount));
      processBiquadChannel(mainBq, this.mainBuf, 0, frameCount);

      // Measure peak of filtered main
      let mainPeak = 0;
      for (let i = 0; i < frameCount; i++) {
        const a = Math.abs(this.mainBuf[i]);
        if (a > mainPeak) mainPeak = a;
      }

      // Filter sidechain signal through the same band (independent filter state)
      this.scBuf.set(sidechain.subarray(0, frameCount));
      processBiquadChannel(scBq, this.scBuf, 0, frameCount);

      // Measure peak of filtered sidechain
      let scPeak = 0;
      for (let i = 0; i < frameCount; i++) {
        const a = Math.abs(this.scBuf[i]);
        if (a > scPeak) scPeak = a;
      }

      // Smooth envelopes
      this.mainEnv[b] += this.smoothCoef * (mainPeak - this.mainEnv[b]);
      this.scEnv[b] += this.smoothCoef * (scPeak - this.scEnv[b]);

      // Convert to dB
      const mainDb = 20 * Math.log10(Math.max(1e-10, this.mainEnv[b]));
      const scDb = 20 * Math.log10(Math.max(1e-10, this.scEnv[b]));

      mainLevels[b] = mainDb;
      scLevels[b] = scDb;

      // Masking occurs when main is louder than sidechain + threshold
      const maskingLevel = mainDb - scDb;
      levels[b] = safeNum(maskingLevel);
      isMasking[b] = maskingLevel > MASKING_THRESHOLD_DB;
    }

    return { levels, isMasking, mainLevels, sidechainLevels: scLevels };
  }

  private ensureBuffers(requiredSize: number): void {
    if (this.mainBuf.length < requiredSize) {
      this.mainBuf = new Float32Array(requiredSize);
      this.scBuf = new Float32Array(requiredSize);
    }
  }

  /**
   * Get current smoothed masking levels (for continuous meter display).
   */
  getLevels(): number[] {
    const levels: number[] = new Array(MASKING_BANDS);
    for (let b = 0; b < MASKING_BANDS; b++) {
      const mainDb = 20 * Math.log10(Math.max(1e-10, this.mainEnv[b]));
      const scDb = 20 * Math.log10(Math.max(1e-10, this.scEnv[b]));
      levels[b] = mainDb - scDb;
    }
    return levels;
  }
}
