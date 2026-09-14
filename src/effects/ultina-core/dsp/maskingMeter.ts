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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: sidechain shorter than frameCount is zero-padded, not read OOB.)
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
  private sampleRate = 48000;

  /** Pooled result — analyze() runs per audio block on the audio thread;
   * consumers (eqModule) copy out what they need immediately. */
  private readonly pooledResult: MaskingResult = {
    levels: new Array(MASKING_BANDS).fill(0),
    isMasking: new Array(MASKING_BANDS).fill(false),
    mainLevels: new Array(MASKING_BANDS).fill(0),
    sidechainLevels: new Array(MASKING_BANDS).fill(0),
  };

  prepare(sampleRate: number, maxBlockSize: number): void {
    this.sampleRate = sampleRate;
    this.mainBuf = new Float32Array(maxBlockSize);
    this.scBuf = new Float32Array(maxBlockSize);
    // Fresh filters must not inherit stale envelopes from a previous
    // prepare() — reset() is the single source of truth for state.
    this.reset();

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
   * Returns per-band masking data. The result object is POOLED — copy out
   * what you need; the next call overwrites every field.
   */
  analyze(
    main: Float32Array,
    sidechain: Float32Array,
    frameCount: number,
  ): MaskingResult {
    this.ensureBuffers(frameCount);

    // smoothCoef is a PER-SAMPLE coefficient; it is applied once per block,
    // so scale it to the actual block length — otherwise the 50 ms envelope
    // becomes ~50 ms × (samples per block) (≈6.4 s at 128-frame blocks).
    const blockCoef = 1 - Math.exp(-frameCount / ((50 / 1000) * this.sampleRate));

    const result = this.pooledResult;
    const levels = result.levels;
    const isMasking = result.isMasking;
    const mainLevels = result.mainLevels;
    const scLevels = result.sidechainLevels;

    // A sidechain buffer shorter than frameCount would read undefined → NaN
    // into scBuf (garbling this block's masking measurement). Bound the copy
    // like unmaskModule does and zero-fill the remainder.
    const scAvail = Math.min(frameCount, sidechain.length);

    for (let b = 0; b < MASKING_BANDS; b++) {
      const mainBq = this.mainFilters[b];
      const scBq = this.scFilters[b];

      // Filter main signal through this band. Scalar copy (not subarray —
      // a fresh TypedArray view per band is 8 heap objects per block on the
      // audio thread) and pristine per band: processBiquadChannel filters
      // the buffer in place.
      for (let i = 0; i < frameCount; i++) {
        this.mainBuf[i] = main[i];
      }
      processBiquadChannel(mainBq, this.mainBuf, 0, frameCount);

      // Measure peak of filtered main
      let mainPeak = 0;
      for (let i = 0; i < frameCount; i++) {
        const a = Math.abs(this.mainBuf[i]);
        if (a > mainPeak) mainPeak = a;
      }

      // Filter sidechain signal through the same band (independent filter state)
      for (let i = 0; i < scAvail; i++) {
        this.scBuf[i] = sidechain[i];
      }
      for (let i = scAvail; i < frameCount; i++) {
        this.scBuf[i] = 0;
      }
      processBiquadChannel(scBq, this.scBuf, 0, frameCount);

      // Measure peak of filtered sidechain
      let scPeak = 0;
      for (let i = 0; i < frameCount; i++) {
        const a = Math.abs(this.scBuf[i]);
        if (a > scPeak) scPeak = a;
      }

      // Smooth envelopes
      this.mainEnv[b] += blockCoef * (mainPeak - this.mainEnv[b]);
      this.scEnv[b] += blockCoef * (scPeak - this.scEnv[b]);

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

    return result;
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
