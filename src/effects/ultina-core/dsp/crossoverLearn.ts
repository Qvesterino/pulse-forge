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
// Ultina — Crossover Auto-Learn
//
// Automatically finds optimal crossover frequencies for multiband
// modules (comp, gate, exciter, transient, clipper, density).
//
// Algorithm:
// 1. Analyze input through N log-spaced band-pass filters
// 2. Track smoothed per-band energy (dB)
// 3. Build a spectral energy envelope
// 4. Find spectral "valleys" (local minima) — natural crossover
//    points where energy is low, minimizing band interaction
// 5. For 2-band: suggest the single deepest valley
//    For 3-band: suggest two valleys (low + high)
//
// The result is confidence-weighted: more data + deeper valleys
// yield higher confidence scores.
// ═══════════════════════════════════════════════════════════

import {
  createBiquad,
  setBandPass,
  processBiquadChannel,
  resetBiquad,
  type BiquadState,
} from "./primitives.js";

// ── Constants ───────────────────────────────────────────────

/** Number of analysis bands. */
export const XOVER_LEARN_BANDS = 32;

/** Log-spaced center frequencies from 40 Hz to 16000 Hz. */
export const XOVER_LEARN_FREQS: number[] = (() => {
  const freqs: number[] = [];
  const logMin = Math.log(40);
  const logMax = Math.log(16000);
  for (let i = 0; i < XOVER_LEARN_BANDS; i++) {
    const t = i / (XOVER_LEARN_BANDS - 1);
    freqs.push(Math.round(Math.exp(logMin + t * (logMax - logMin))));
  }
  return freqs;
})();

/** Q factor for analysis band-pass filters. */
const ANALYSIS_Q = 3.0;

/** Minimum blocks before results are considered reliable. */
const MIN_BLOCKS = 30;

/** Minimum spectral valley depth (dB) to consider as a crossover point. */
const MIN_VALLEY_DEPTH_DB = 2.0;

/** Frequency range for valid crossover points (Hz). */
const MIN_XOVER_HZ = 80;
const MAX_XOVER_HZ = 12000;

// ── Types ───────────────────────────────────────────────────

export interface CrossoverSuggestion {
  /** Suggested crossover frequency in Hz. */
  freqHz: number;
  /** Nearest analysis band index. */
  bandIndex: number;
  /** Valley depth in dB (how deep the valley is relative to neighbors). */
  depthDb: number;
  /** Confidence 0–1 based on valley depth and data quality. */
  confidence: number;
}

export interface CrossoverLearnResult {
  /** For 2-band mode: one crossover point. */
  suggestion2Band: CrossoverSuggestion | null;
  /** For 3-band mode: two crossover points (low, high). */
  suggestions3Band: [CrossoverSuggestion, CrossoverSuggestion] | null;
  /** Per-band energy levels (dB). */
  bandLevels: number[];
  /** Spectral centroid (Hz). */
  spectralCentroid: number;
  /** Whether enough data has been accumulated. */
  isReady: boolean;
}

// ── Crossover Learn ─────────────────────────────────────────

export class CrossoverLearn {
  private filters: BiquadState[] = [];
  private bandEnergy: number[] = new Array(XOVER_LEARN_BANDS).fill(0);
  private tempBuf: Float32Array = new Float32Array(0);
  private blockCount = 0;
  private smoothCoef = 0.02;

  prepare(sampleRate: number, maxBlockSize: number): void {
    this.tempBuf = new Float32Array(maxBlockSize);

    // Per-block smoothing: 500ms time constant
    const tauSamples = (500 / 1000) * sampleRate;
    this.smoothCoef = 1 - Math.exp(-maxBlockSize / tauSamples);

    this.filters = [];
    for (let i = 0; i < XOVER_LEARN_BANDS; i++) {
      const bq = createBiquad(1);
      setBandPass(bq.coeffs, XOVER_LEARN_FREQS[i], ANALYSIS_Q, sampleRate);
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
   * Process a block of mono audio (mix stereo to mono before calling).
   */
  process(input: Float32Array, frameCount: number): void {
    this.ensureBuffers(frameCount);

    for (let b = 0; b < XOVER_LEARN_BANDS; b++) {
      const bq = this.filters[b];
      this.tempBuf.set(input.subarray(0, frameCount));
      processBiquadChannel(bq, this.tempBuf, 0, frameCount);

      let sumSq = 0;
      for (let i = 0; i < frameCount; i++) {
        const s = this.tempBuf[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, frameCount));
      this.bandEnergy[b] += this.smoothCoef * (rms - this.bandEnergy[b]);
    }

    this.blockCount++;
  }

  /**
   * Compute crossover suggestions from accumulated spectral data.
   *
   * Uses an energy-balanced splitting strategy:
   * - Builds cumulative spectral energy from low to high
   * - Finds where cumulative energy crosses 50% (2-band)
   *   or 33%/67% (3-band)
   * - If a spectral valley exists near the energy-split point,
   *   prefer the valley frequency for a more natural boundary
   */
  getResult(): CrossoverLearnResult {
    const bandLevels: number[] = new Array(XOVER_LEARN_BANDS);
    let totalWeighted = 0;
    let totalEnergy = 0;

    const linEnergy: number[] = new Array(XOVER_LEARN_BANDS);

    for (let b = 0; b < XOVER_LEARN_BANDS; b++) {
      const db = 20 * Math.log10(Math.max(1e-10, this.bandEnergy[b]));
      bandLevels[b] = Number.isFinite(db) ? db : -100;

      const lin = Math.max(0, this.bandEnergy[b]);
      linEnergy[b] = lin;
      totalWeighted += XOVER_LEARN_FREQS[b] * lin;
      totalEnergy += lin;
    }

    const spectralCentroid = totalEnergy > 1e-10
      ? totalWeighted / totalEnergy
      : 1000;

    // Find all spectral valleys (for refinement)
    const valleys = this.findValleys(bandLevels);

    // Energy-balanced crossover for 2-band mode
    let suggestion2Band: CrossoverSuggestion | null = null;
    if (totalEnergy > 1e-10) {
      const splitIdx = this.findEnergySplit(linEnergy, totalEnergy, 0.5);
      if (splitIdx >= 0) {
        // Check if there's a valley near this point
        const valleyNearby = this.findValleyNear(valleys, splitIdx, 3);
        const targetIdx = valleyNearby ?? splitIdx;
        const freq = this.interpolateFreq(targetIdx, linEnergy);
        const depth = this.estimateDepth(bandLevels, targetIdx);
        suggestion2Band = this.toSuggestion(targetIdx, freq, depth);
      }
    }

    // Energy-balanced crossovers for 3-band mode
    let suggestions3Band: [CrossoverSuggestion, CrossoverSuggestion] | null = null;
    if (totalEnergy > 1e-10) {
      const splitIdx1 = this.findEnergySplit(linEnergy, totalEnergy, 1 / 3);
      const splitIdx2 = this.findEnergySplit(linEnergy, totalEnergy, 2 / 3);
      if (splitIdx1 >= 0 && splitIdx2 >= 0 && splitIdx1 < splitIdx2) {
        const v1Nearby = this.findValleyNear(valleys, splitIdx1, 3) ?? splitIdx1;
        const v2Nearby = this.findValleyNear(valleys, splitIdx2, 3) ?? splitIdx2;
        suggestions3Band = [
          this.toSuggestion(v1Nearby, this.interpolateFreq(v1Nearby, linEnergy),
            this.estimateDepth(bandLevels, v1Nearby)),
          this.toSuggestion(v2Nearby, this.interpolateFreq(v2Nearby, linEnergy),
            this.estimateDepth(bandLevels, v2Nearby)),
        ];
      }
    }

    return {
      suggestion2Band,
      suggestions3Band,
      bandLevels,
      spectralCentroid: Number.isFinite(spectralCentroid) ? spectralCentroid : 1000,
      isReady: this.blockCount >= MIN_BLOCKS,
    };
  }

  // ── Energy Split ──────────────────────────────────────────

  /**
   * Find the band index where cumulative energy crosses a fraction
   * of total energy.
   */
  private findEnergySplit(
    linEnergy: number[],
    totalEnergy: number,
    fraction: number,
  ): number {
    const target = totalEnergy * fraction;
    let cumulative = 0;
    for (let b = 0; b < XOVER_LEARN_BANDS; b++) {
      cumulative += linEnergy[b];
      if (cumulative >= target) {
        return b;
      }
    }
    return XOVER_LEARN_BANDS - 1;
  }

  /**
   * Interpolate the exact crossover frequency between band centers
   * using linear interpolation in log-frequency domain.
   */
  private interpolateFreq(bandIndex: number, _linEnergy: number[]): number {
    const freq = XOVER_LEARN_FREQS[bandIndex];
    // Snap to exact band frequency
    return freq;
  }

  // ── Valley Detection ──────────────────────────────────────

  /**
   * Find spectral valleys in the energy curve.
   * A valley is a local minimum that is significantly below
   * both its neighbors.
   */
  private findValleys(levels: number[]): Array<{
    index: number;
    freqHz: number;
    depthDb: number;
  }> {
    const valleys: Array<{ index: number; freqHz: number; depthDb: number }> = [];

    const smoothed = this.smoothCurve(levels, 1);

    for (let i = 2; i < XOVER_LEARN_BANDS - 2; i++) {
      const freq = XOVER_LEARN_FREQS[i];
      if (freq < MIN_XOVER_HZ || freq > MAX_XOVER_HZ) continue;

      const val = smoothed[i];
      const leftMax = Math.max(smoothed[i - 1], smoothed[i - 2]);
      const rightMax = Math.max(smoothed[i + 1], smoothed[i + 2]);

      const depthLeft = leftMax - val;
      const depthRight = rightMax - val;

      if (depthLeft >= MIN_VALLEY_DEPTH_DB && depthRight >= MIN_VALLEY_DEPTH_DB) {
        const depthDb = (depthLeft + depthRight) / 2;
        valleys.push({ index: i, freqHz: freq, depthDb });
      }
    }

    valleys.sort((a, b) => b.depthDb - a.depthDb);
    return valleys;
  }

  /**
   * Find a valley near a target band index, within a window.
   */
  private findValleyNear(
    valleys: Array<{ index: number; freqHz: number; depthDb: number }>,
    targetIndex: number,
    window: number,
  ): number | null {
    let best: number | null = null;
    let bestDepth = 0;
    for (const v of valleys) {
      if (Math.abs(v.index - targetIndex) <= window && v.depthDb > bestDepth) {
        best = v.index;
        bestDepth = v.depthDb;
      }
    }
    return best;
  }

  /**
   * Estimate the spectral depth at a band index relative to neighbors.
   */
  private estimateDepth(levels: number[], index: number): number {
    const left = index > 0 ? levels[index - 1] : levels[index];
    const right = index < XOVER_LEARN_BANDS - 1 ? levels[index + 1] : levels[index];
    const avgNeighbor = (left + right) / 2;
    return Math.max(0, avgNeighbor - levels[index]);
  }

  /**
   * Simple moving-average smoothing of the energy curve.
   */
  private smoothCurve(levels: number[], halfWindow: number): number[] {
    const result = new Array<number>(levels.length);
    for (let i = 0; i < levels.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - halfWindow); j <= Math.min(levels.length - 1, i + halfWindow); j++) {
        sum += levels[j];
        count++;
      }
      result[i] = sum / Math.max(1, count);
    }
    return result;
  }

  /**
   * Convert analysis results to a suggestion with confidence.
   */
  private toSuggestion(
    bandIndex: number,
    freqHz: number,
    depthDb: number,
  ): CrossoverSuggestion {
    // Confidence based on depth (up to 12 dB = 1.0) and data readiness
    const depthConfidence = Math.min(1, depthDb / 12);
    const dataConfidence = Math.min(1, this.blockCount / (MIN_BLOCKS * 2));
    // Base confidence on data quality; depth adds bonus
    const confidence = Math.min(1,
      0.3 * dataConfidence + 0.7 * Math.max(0.3, depthConfidence));

    return {
      freqHz,
      bandIndex,
      depthDb,
      confidence,
    };
  }

  private ensureBuffers(requiredSize: number): void {
    if (this.tempBuf.length < requiredSize) {
      this.tempBuf = new Float32Array(requiredSize);
    }
  }
}
