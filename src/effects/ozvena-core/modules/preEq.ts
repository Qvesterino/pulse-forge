/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Pre EQ (3-band) + Auto Cut analyzer
//
// Three biquad bands (low shelf / bell / high shelf by default), each
// with its own EQ shape selector (shelf / cut variants supported).
//
// Auto Cut (Phase 6 refactor):
//   Listens to the input signal via FFT snapshot. For each band:
//     • Performs spectral peak detection in the band's ±½-octave
//       window using `findSpectralPeaks()` + `estimateQ()`.
//     • Compares the peak level to the spectrum median (robust
//       baseline) via `bandLevel()` / `medianLevel()`.
//     • If the peak exceeds the baseline by a threshold (driven by
//       the `amount` slider), suggests a cut proportional to the
//       excess (capped at -12 dB), soft-knee via `softKneeMap()`.
//   `runAutoCutDetailed()` exposes the full detection result
//   (peak frequencies, magnitudes, Qs, suggested cuts) so the UI
//   can render a tooltip / suggestion popup.
// ═══════════════════════════════════════════════════════════

import { type EqBandState } from "../v2/types.js";
import { clamp } from "../dsp/math.js";
import {
  createBiquad,
  setBell,
  setHighShelf,
  setHighPass,
  setLowPass,
  setLowShelf,
  processBiquad,
  type BiquadState,
} from "../dsp/biquad.js";
import { createSpectrumAnalyzer, type SpectrumAnalyzer } from "../dsp/spectrumAnalyzer.js";
import {
  findSpectralPeaks,
  harmonicProductSpectrum,
} from "../dsp/peakDetection.js";
import {
  bandLevel,
  medianLevel,
  softKneeMap,
  clamp01,
} from "./analyzerHelpers.js";

export interface PreEqParams {
  enabled: boolean;
  band1: EqBandState;
  band2: EqBandState;
  band3: EqBandState;
}

export interface PreEq {
  prepare(sampleRate: number, channelCount: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: PreEqParams): void;
  setAutoCutAmount(amount: number): void;
  setAutoCutEnabled(on: boolean): void;
  /** Run one FFT snapshot and produce band suggestions. */
  runAutoCut(sampleRate: number): [number, number, number] | null;
  /**
   * Detailed Auto Cut analysis. Returns peak frequencies, magnitudes,
   * Qs, and suggested cuts (in dB) for all 3 bands. Returns null
   * if Auto Cut is disabled or no audio has been pushed yet.
   */
  runAutoCutDetailed(sampleRate: number): AutoCutDetails | null;
  reset(): void;
}

export interface AutoCutBandInfo {
  /** Band index (0..2). */
  bandIndex: number;
  /** Centre frequency of the band. */
  bandFreqHz: number;
  /** Dominant peak frequency detected in the band window. */
  peakFreqHz: number;
  /** Peak magnitude in dB. */
  peakDb: number;
  /** Estimated Q of the peak. */
  q: number;
  /** Average band level (dB) used for the comparison. */
  bandLevelDb: number;
  /** Baseline (median spectrum level, dB). */
  baselineDb: number;
  /** Excess above the threshold (dB, 0 if below). */
  excessDb: number;
  /** Soft-knee mapped value in [0, 1]. */
  softKnee: number;
  /** Suggested cut in dB (0..-12). */
  suggestedCutDb: number;
}

export interface AutoCutDetails {
  bands: AutoCutBandInfo[];
  /** Mean suggested cut across the 3 bands (dB, ≤ 0). */
  meanSuggestedCutDb: number;
  /** Number of bands where suggestedCutDb < 0 (problem bins). */
  problemBandCount: number;
  /** Sensitivity used for this analysis (dB). */
  sensitivityDb: number;
  /** Maximum allowed cut magnitude (dB). */
  maxCutDb: number;
}

function shapeCoeffs(
  bq: BiquadState,
  band: EqBandState,
  sampleRate: number,
): void {
  if (!band.enabled) {
    bq.coeffs.b0 = 1; bq.coeffs.b1 = 0; bq.coeffs.b2 = 0;
    bq.coeffs.a1 = 0; bq.coeffs.a2 = 0;
    return;
  }
  switch (band.shape) {
    case "lowShelf":  setLowShelf(bq.coeffs, band.freqHz, band.q, band.gainDb, sampleRate); break;
    case "highShelf": setHighShelf(bq.coeffs, band.freqHz, band.q, band.gainDb, sampleRate); break;
    case "lowCut":    setHighPass(bq.coeffs, band.freqHz, band.q, sampleRate); break;
    case "highCut":   setLowPass(bq.coeffs, band.freqHz, band.q, sampleRate); break;
    case "bell":
    default:          setBell(bq.coeffs, band.freqHz, band.q, band.gainDb, sampleRate); break;
  }
}

export function createPreEq(): PreEq {
  let sampleRate = 44100;
  let channelCount = 2;
  let params: PreEqParams = {
    enabled: false,
    band1: { enabled: false, freqHz: 100, gainDb: 0, q: 0.7, shape: "lowShelf" },
    band2: { enabled: false, freqHz: 1000, gainDb: 0, q: 1.0, shape: "bell" },
    band3: { enabled: false, freqHz: 8000, gainDb: 0, q: 0.7, shape: "highShelf" },
  };
  let autoCutAmount = 50;
  let autoCutEnabled = false;

  let bq1: BiquadState = createBiquad(channelCount);
  let bq2: BiquadState = createBiquad(channelCount);
  let bq3: BiquadState = createBiquad(channelCount);
  let analyzer: SpectrumAnalyzer = createSpectrumAnalyzer({ fftSize: 2048 });

  // Default snapshot grid: 48 log-frequency bins 20 → 20 kHz.
  const snapshotGrid = new Float32Array(48);
  for (let i = 0; i < snapshotGrid.length; i++) {
    snapshotGrid[i] = 20 * Math.pow(1000, i / (snapshotGrid.length - 1));
  }
  let snapshotBuf: Float32Array = new Float32Array(snapshotGrid.length);

  // Pre-allocated HPS buffer for the next-detailed run.
  let hpsBuf: Float32Array = new Float32Array(Math.floor(snapshotGrid.length / 4));

  // FFT size for peak detection (independent of analyzer.fftSize).
  // We use the grid length × 4 as an approximation.
  const peakFftSize = snapshotGrid.length * 4;

  function updateCoefficients(): void {
    shapeCoeffs(bq1, params.band1, sampleRate);
    shapeCoeffs(bq2, params.band2, sampleRate);
    shapeCoeffs(bq3, params.band3, sampleRate);
  }

  return {
    prepare(sr, cc) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      bq1 = createBiquad(channelCount);
      bq2 = createBiquad(channelCount);
      bq3 = createBiquad(channelCount);
      analyzer = createSpectrumAnalyzer({ fftSize: 2048 });
      updateCoefficients();
    },

    process(channels, frameCount) {
      // Push input for the analyzer regardless of on/off (so AutoCut can
      // sample the latest fftSize samples at any moment).
      analyzer.push("input", channels, frameCount);
      if (!params.enabled || frameCount <= 0) return;
      processBiquad(bq1, channels, frameCount);
      processBiquad(bq2, channels, frameCount);
      processBiquad(bq3, channels, frameCount);
    },

    setParams(p) {
      params = { ...p, band1: { ...p.band1 }, band2: { ...p.band2 }, band3: { ...p.band3 } };
      updateCoefficients();
    },

    setAutoCutAmount(amount) { autoCutAmount = clamp(amount, 0, 100); },
    setAutoCutEnabled(on) { autoCutEnabled = on; },

    runAutoCut(sr) {
      // Backward-compatible wrapper: returns just the 3-band cuts.
      const result = this.runAutoCutDetailed(sr);
      if (!result) return null;
      return [
        result.bands[0].suggestedCutDb,
        result.bands[1].suggestedCutDb,
        result.bands[2].suggestedCutDb,
      ];
    },

    runAutoCutDetailed(sr) {
      const n = analyzer.snapshot("input", snapshotBuf, snapshotGrid, sr);
      if (n === 0 || !autoCutEnabled) return null;

      // Robust baseline = median dB.
      const baseline = medianLevel(snapshotBuf);

      // Compute HPS once (helps detect fundamentals buried in harmonics).
      hpsBuf = harmonicProductSpectrum(snapshotBuf, 4);
      const hpsPeaks = findSpectralPeaks(hpsBuf, 80, 8, hpsBuf.length * 4, sr);

      // Sensitivity 6..18 dB (amount 0..100).
      const sensitivity = 6 + (autoCutAmount / 100) * 12;
      // Maximum cut 0..-12 dB.
      const maxCut = -(autoCutAmount / 100) * 12;

      const bandFreqs = [params.band1.freqHz, params.band2.freqHz, params.band3.freqHz];
      const bands: AutoCutBandInfo[] = [];
      let sumCuts = 0;

      for (let b = 0; b < 3; b++) {
        const fc = bandFreqs[b];
        const fLo = fc / Math.SQRT2;
        const fHi = fc * Math.SQRT2;
        const bandMean = bandLevel(snapshotBuf, snapshotGrid, fLo, fHi);
        const excess = bandMean - baseline;

        // Spectral peak detection in the band window.
        const peaks = findSpectralPeaks(
          snapshotBuf, 60, 3, peakFftSize, sr,
        ).filter((p) => p.freqHz >= fLo && p.freqHz <= fHi);

        // Pick the dominant peak; fall back to band mean if none.
        const dominant = peaks[0] ?? null;
        const peakFreqHz = dominant?.freqHz ?? fc;
        const peakDb = dominant?.magnitudeDb ?? bandMean;
        const q = dominant?.q ?? 0;

        const soft = softKneeMap(excess, sensitivity, 6);
        const cut = maxCut * clamp01(soft);

        bands.push({
          bandIndex: b,
          bandFreqHz: fc,
          peakFreqHz,
          peakDb,
          q,
          bandLevelDb: bandMean,
          baselineDb: baseline,
          excessDb: excess > 0 ? excess : 0,
          softKnee: soft,
          suggestedCutDb: cut,
        });
        sumCuts += cut;
      }

      // Optionally surface HPS-detected fundamentals for reference.
      // (Currently used only internally; exposed later via host bridge.)
      void hpsPeaks;

      const problemBandCount = bands.filter((b) => b.suggestedCutDb < 0).length;
      return {
        bands,
        meanSuggestedCutDb: sumCuts / 3,
        problemBandCount,
        sensitivityDb: sensitivity,
        maxCutDb: maxCut,
      };
    },

    reset() {
      bq1.z1.fill(0); bq1.z2.fill(0);
      bq2.z1.fill(0); bq2.z2.fill(0);
      bq3.z1.fill(0); bq3.z2.fill(0);
      analyzer.reset();
    },
  };
}
