/* eslint-disable */
// @ts-nocheck
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
// Ozvena — Reverb EQ (3-band) + Unmask analyzer
//
// Three biquad bands applied to the wet (post-engine) signal. Identical
// topology to Pre EQ but operates on the wet bus.
//
// Unmask (Phase 6 refactor):
//   Listens to both dry and wet taps of the spectrum analyzer. For each
//   band, performs spectral peak detection on the wet signal inside
//   the band window and compares the peak magnitude to the dry band
//   level. Where the wet signal is significantly louder than the dry
//   signal (the "masking" zone), suggests a cut to reduce the build-up.
//   `runUnmaskDetailed()` exposes the full detection result so the UI
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
import { findSpectralPeaks } from "../dsp/peakDetection.js";
import { bandLevel, clamp01, softKneeMap } from "./analyzerHelpers.js";

export interface ReverbEqParams {
  enabled: boolean;
  band1: EqBandState;
  band2: EqBandState;
  band3: EqBandState;
}

export interface UnmaskBandInfo {
  bandIndex: number;
  bandFreqHz: number;
  /** Dominant wet-band peak frequency. */
  wetPeakFreqHz: number;
  wetPeakDb: number;
  wetBandLevelDb: number;
  dryBandLevelDb: number;
  /** Wet − Dry (dB) — the masking indicator. */
  excessDb: number;
  softKnee: number;
  suggestedCutDb: number;
}

export interface UnmaskDetails {
  bands: UnmaskBandInfo[];
  meanSuggestedCutDb: number;
  problemBandCount: number;
  sensitivityDb: number;
  maxCutDb: number;
}

export interface ReverbEq {
  prepare(sampleRate: number, channelCount: number): void;
  /** Process the wet bus in place. dry must be supplied for Unmask. */
  process(wet: Float32Array[], frameCount: number, dry?: Float32Array[]): void;
  setParams(p: ReverbEqParams): void;
  setUnmaskAmount(amount: number): void;
  setUnmaskEnabled(on: boolean): void;
  /**
   * Gate the internal dry/wet analyzer taps (see PreEq.setAnalyzerEnabled).
   */
  setAnalyzerEnabled(on: boolean): void;
  runUnmask(sampleRate: number): [number, number, number] | null;
  runUnmaskDetailed(sampleRate: number): UnmaskDetails | null;
  reset(): void;
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

export function createReverbEq(): ReverbEq {
  let sampleRate = 44100;
  let channelCount = 2;
  let params: ReverbEqParams = {
    enabled: false,
    band1: { enabled: false, freqHz: 200, gainDb: 0, q: 0.7, shape: "lowShelf" },
    band2: { enabled: false, freqHz: 2500, gainDb: 0, q: 1.0, shape: "bell" },
    band3: { enabled: false, freqHz: 10000, gainDb: 0, q: 0.7, shape: "highShelf" },
  };
  let unmaskAmount = 50;
  let unmaskEnabled = false;

  let bq1: BiquadState = createBiquad(channelCount);
  let bq2: BiquadState = createBiquad(channelCount);
  let bq3: BiquadState = createBiquad(channelCount);
  let analyzer: SpectrumAnalyzer = createSpectrumAnalyzer({ fftSize: 2048 });
  let analyzerEnabled = true;

  const snapshotGrid = new Float32Array(48);
  for (let i = 0; i < snapshotGrid.length; i++) {
    snapshotGrid[i] = 20 * Math.pow(1000, i / (snapshotGrid.length - 1));
  }
  const dryBuf = new Float32Array(snapshotGrid.length);
  const wetBuf = new Float32Array(snapshotGrid.length);

  // FFT size proxy for the peak detector.
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
      analyzer.setEnabled(analyzerEnabled);
      updateCoefficients();
    },

    process(wet, frameCount, dry) {
      analyzer.push("wet", wet, frameCount);
      if (dry) analyzer.push("dry", dry, frameCount);
      if (!params.enabled || frameCount <= 0) return;
      processBiquad(bq1, wet, frameCount);
      processBiquad(bq2, wet, frameCount);
      processBiquad(bq3, wet, frameCount);
    },

    setParams(p) {
      params = { ...p, band1: { ...p.band1 }, band2: { ...p.band2 }, band3: { ...p.band3 } };
      updateCoefficients();
    },

    setUnmaskAmount(amount) { unmaskAmount = clamp(amount, 0, 100); },
    setUnmaskEnabled(on) { unmaskEnabled = on; },
    setAnalyzerEnabled(on) {
      analyzerEnabled = on;
      analyzer.setEnabled(on);
    },

    runUnmask(sr) {
      const result = this.runUnmaskDetailed(sr);
      if (!result) return null;
      return [
        result.bands[0].suggestedCutDb,
        result.bands[1].suggestedCutDb,
        result.bands[2].suggestedCutDb,
      ];
    },

    runUnmaskDetailed(sr) {
      const dryN = analyzer.snapshot("dry", dryBuf, snapshotGrid, sr);
      const wetN = analyzer.snapshot("wet", wetBuf, snapshotGrid, sr);
      if (dryN === 0 || wetN === 0 || !unmaskEnabled) return null;

      // Sensitivity 3..9 dB (amount 0..100): how much wet > dry before
      // we suggest a cut.
      const minExcess = 3 + (unmaskAmount / 100) * 6;
      const maxCut = -(unmaskAmount / 100) * 9;

      const bandFreqs = [params.band1.freqHz, params.band2.freqHz, params.band3.freqHz];
      const bands: UnmaskBandInfo[] = [];
      let sumCuts = 0;

      for (let b = 0; b < 3; b++) {
        const fc = bandFreqs[b];
        const fLo = fc / Math.SQRT2;
        const fHi = fc * Math.SQRT2;

        // Mean band level (the spectrum is already in dB; mean is OK for
        // broadband masking detection).
        const dryBand = bandLevel(dryBuf, snapshotGrid, fLo, fHi);
        const wetBand = bandLevel(wetBuf, snapshotGrid, fLo, fHi);

        // Dominant wet peak inside the band.
        const wetPeaks = findSpectralPeaks(
          wetBuf, 60, 3, peakFftSize, sr,
        ).filter((p) => p.freqHz >= fLo && p.freqHz <= fHi);
        const dominant = wetPeaks[0] ?? null;

        const excess = wetBand - dryBand;
        const soft = softKneeMap(excess, minExcess, 6);
        const cut = maxCut * clamp01(soft);

        bands.push({
          bandIndex: b,
          bandFreqHz: fc,
          wetPeakFreqHz: dominant?.freqHz ?? fc,
          wetPeakDb: dominant?.magnitudeDb ?? wetBand,
          wetBandLevelDb: wetBand,
          dryBandLevelDb: dryBand,
          excessDb: excess > 0 ? excess : 0,
          softKnee: soft,
          suggestedCutDb: cut,
        });
        sumCuts += cut;
      }

      const problemBandCount = bands.filter((b) => b.suggestedCutDb < 0).length;
      return {
        bands,
        meanSuggestedCutDb: sumCuts / 3,
        problemBandCount,
        sensitivityDb: minExcess,
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
