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
// Ultina — Tonal Balance Control (v1)
//
// Real-time spectrum analysis vs target curve overlay.
// Compares the current signal's octave-band spectrum against a
// reference target and computes deviation + EQ suggestions.
//
// This is an analysis/display module — it does not modify audio.
// The user sees the deviation overlay and can manually adjust
// EQ bands, or use the Track Enhance feature to auto-apply.
// ═══════════════════════════════════════════════════════════

import type { TonalBalanceReading, TargetCurve } from "./assistant.js";
import { applyHanningWindow, computeMagnitudeSpectrum } from "../dsp/fft.js";

const OCTAVE_CENTER_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const NUM_BANDS = 10;

// ── Running spectrum measurement ─────────────────────────────

export class TonalBalanceMeter {
  private octaveBands: Float32Array[] = [];
  private sampleRate = 44100;
  private maxBlockSize = 1024;
  private windowBuffer: Float32Array | null = null;
  private windowPos = 0;
  private frameSize = 2048;
  private hopSize = 1024;
  private bandEnergies: number[] = new Array(NUM_BANDS).fill(0);
  private bandCounts = 0;
  private smoothingBands: number[] = new Array(NUM_BANDS).fill(-100);
  private smoothingCoef = 0.9;

  prepare(sampleRate: number, maxBlockSize: number): void {
    this.sampleRate = sampleRate;
    this.maxBlockSize = maxBlockSize;
    this.windowBuffer = new Float32Array(this.frameSize);
    this.windowPos = 0;
    this.reset();
  }

  reset(): void {
    this.bandEnergies = new Array(NUM_BANDS).fill(0);
    this.bandCounts = 0;
    this.smoothingBands = new Array(NUM_BANDS).fill(-100);
  }

  /** Process a block of mono audio and update internal spectrum measurement. */
  process(monoInput: Float32Array, frameCount: number): void {
    if (!this.windowBuffer) return;

    for (let i = 0; i < frameCount; i++) {
      this.windowBuffer[this.windowPos] = monoInput[i];
      this.windowPos++;

      if (this.windowPos >= this.frameSize) {
        this.analyzeWindow();
        // Shift by hop size (overlap)
        this.windowBuffer.copyWithin(0, this.hopSize);
        this.windowPos = this.frameSize - this.hopSize;
      }
    }
  }

  private analyzeWindow(): void {
    if (!this.windowBuffer) return;

    const windowed = this.windowBuffer.slice();
    applyHanningWindow(windowed);
    const magnitudes = computeMagnitudeSpectrum(windowed);

    const half = magnitudes.length;
    const binSize = this.sampleRate / (this.frameSize);

    for (let o = 0; o < NUM_BANDS; o++) {
      const center = OCTAVE_CENTER_FREQS[o];
      const lowBin = Math.max(0, Math.floor((center / Math.SQRT2) / binSize));
      const highBin = Math.min(half - 1, Math.ceil((center * Math.SQRT2) / binSize));
      let energy = 0;
      for (let b = lowBin; b <= highBin; b++) {
        energy += magnitudes[b] * magnitudes[b];
      }
      this.bandEnergies[o] += energy;
    }
    this.bandCounts++;
  }

  /** Get the current smoothed spectrum in dB per octave band. */
  getCurrentSpectrum(): number[] {
    if (this.bandCounts === 0) {
      return new Array(NUM_BANDS).fill(-100);
    }

    const totalEnergy = this.bandEnergies.reduce((a, b) => a + b, 0);
    if (totalEnergy <= 0) {
      return new Array(NUM_BANDS).fill(-100);
    }

    const _avgEnergy = totalEnergy / NUM_BANDS;
    const result: number[] = [];

    for (let i = 0; i < NUM_BANDS; i++) {
      const ratio = this.bandEnergies[i] / totalEnergy;
      const db = ratio > 0
        ? 10 * Math.log10(ratio * NUM_BANDS) // normalize so flat = 0 dB
        : -60;

      // Exponential smoothing
      this.smoothingBands[i] = this.smoothingCoef * this.smoothingBands[i]
        + (1 - this.smoothingCoef) * db;
      result.push(this.smoothingBands[i]);
    }

    return result;
  }

  /** Decay accumulated spectrum (call periodically for rolling average). */
  decay(factor = 0.95): void {
    for (let i = 0; i < NUM_BANDS; i++) {
      this.bandEnergies[i] *= factor;
    }
    this.bandCounts = Math.max(0, this.bandCounts * factor);
  }
}

// ── Balance reading generation ───────────────────────────────

/**
 * Compute a Tonal Balance reading comparing current spectrum
 * against an optional target curve.
 */
export function computeTonalBalance(
  currentSpectrum: number[],
  target: TargetCurve | null,
): TonalBalanceReading {
  const current = currentSpectrum.slice(0, NUM_BANDS);
  const timestamp = Date.now();

  if (!target) {
    return {
      timestamp,
      current,
      target: null,
      deviation: null,
      rmsDeviation: 0,
      suggestions: null,
    };
  }

  const targetCurve = target.curve;
  const deviation = current.map((c, i) => c - (targetCurve[i] ?? 0));

  // RMS deviation (overall balance score)
  const sumSq = deviation.reduce((a, b) => a + b * b, 0);
  const rmsDeviation = Math.sqrt(sumSq / deviation.length);

  // EQ suggestions: inverse of deviation, scaled to ±6 dB max
  const suggestions = deviation.map((d) => {
    const clamped = Math.max(-6, Math.min(6, -d * 0.5));
    return Math.round(clamped * 10) / 10;
  });

  return {
    timestamp,
    current,
    target: targetCurve.slice(),
    deviation,
    rmsDeviation,
    suggestions,
  };
}

// ── EQ curve generation from balance suggestions ─────────────

/**
 * Convert 10 octave-band suggestions to EQ band parameter proposals.
 * Maps octave bands to the 12-band EQ (selecting the closest band).
 */
export function balanceSuggestionsToEqParams(
  suggestions: number[],
): Array<{ bandIndex: number; gainDb: number; freqHz: number }> {
  const eqDefaultFreqs = [
    80, 200, 350, 800, 1500, 3000, 5000, 7000, 10000, 12000, 15000, 18000,
  ];
  const octaveFreqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  const result: Array<{ bandIndex: number; gainDb: number; freqHz: number }> = [];

  for (let i = 0; i < octaveFreqs.length; i++) {
    if (Math.abs(suggestions[i]) < 0.5) continue; // skip negligible adjustments

    // Find closest EQ band
    let bestBand = 0;
    let bestDist = Infinity;
    for (let b = 0; b < eqDefaultFreqs.length; b++) {
      const dist = Math.abs(Math.log2(eqDefaultFreqs[b] / octaveFreqs[i]));
      if (dist < bestDist) {
        bestDist = dist;
        bestBand = b;
      }
    }

    result.push({
      bandIndex: bestBand,
      gainDb: suggestions[i],
      freqHz: eqDefaultFreqs[bestBand],
    });
  }

  return result;
}
