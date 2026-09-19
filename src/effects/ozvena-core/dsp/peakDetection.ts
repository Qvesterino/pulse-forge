/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Spectral peak detection (HPS, Q estimation)
//
// Used by the Auto Cut (Pre EQ) and Unmask (Reverb EQ) analyzers.
// All routines are pure functions operating on a pre-computed FFT
// magnitude spectrum (length = fftSize / 2 + 1).
//
// Algorithms:
//   • findSpectralPeaks     — greedy peak picking with min-separation
//                                quarantine. Returns the top N peaks
//                                sorted by descending magnitude.
//   • estimateQ              — parabolic fit around a peak; returns
//                                Q = f₀ / (−3 dB bandwidth).
//   • harmonicProductSpectrum — N-th order HPS used to lift
//                                fundamental frequencies that are
//                                otherwise masked by louder harmonics.
//
// Threading: all routines are allocation-free once the caller has
// supplied the magnitude buffer.
// ═══════════════════════════════════════════════════════════

/** A single spectral peak with metadata for downstream analysis. */
export interface SpectralPeak {
  /** Bin index in the magnitude array. */
  index: number;
  /** Frequency in Hz (derived from bin × binWidth). */
  freqHz: number;
  /** Magnitude in dB (coherent-gain normalised). */
  magnitudeDb: number;
  /** Estimated Q (f₀ / −3 dB bandwidth). 0 = unknown / broad. */
  q: number;
}

/** Bin index → Hz. */
export function binToHz(binIndex: number, fftSize: number, sampleRate: number): number {
  return (binIndex * sampleRate) / fftSize;
}

/** Hz → bin index. */
export function hzToBin(freqHz: number, fftSize: number, sampleRate: number): number {
  return (freqHz * fftSize) / sampleRate;
}

/**
 * Greedy spectral peak picking. Returns up to `topN` peaks sorted
 * by descending magnitude. Peaks closer than `minSeparationHz`
 * (after rounding) are merged — the louder one wins.
 *
 *   mag        — magnitude spectrum (length = fftSize / 2 + 1).
 *   minSeparationHz  — minimum peak-to-peak distance in Hz
 *                          (default 50 Hz; suitable for vocal
 *                          resonance detection).
 *   topN       — maximum peaks to return (default 5).
 */
export function findSpectralPeaks(
  mag: Float32Array | number[],
  minSeparationHz: number = 50,
  topN: number = 5,
  fftSize: number = 2048,
  sampleRate: number = 48000,
): SpectralPeak[] {
  const n = mag.length;
  if (n < 3) return [];

  const allPeaks: SpectralPeak[] = [];

  // ── Local-maxima scan (skip DC at 0 and Nyquist at n-1) ───
  for (let i = 1; i < n - 1; i++) {
    const v = mag[i];
    if (v <= mag[i - 1] || v < mag[i + 1]) continue;
    if (v <= -120) continue; // skip floor bins
    allPeaks.push({
      index: i,
      freqHz: binToHz(i, fftSize, sampleRate),
      magnitudeDb: v,
      q: estimateQ(mag, i, sampleRate, fftSize),
    });
  }

  // ── Greedy merge with minSeparationHz quarantine ─────────
  // Sort by descending magnitude so the louder peak wins when two
  // are within the quarantine band.
  allPeaks.sort((a, b) => b.magnitudeDb - a.magnitudeDb);
  const accepted: SpectralPeak[] = [];
  for (const p of allPeaks) {
    let conflict = false;
    for (const a of accepted) {
      if (Math.abs(p.freqHz - a.freqHz) < minSeparationHz) {
        conflict = true;
        break;
      }
    }
    if (!conflict) accepted.push(p);
    if (accepted.length >= topN) break;
  }
  return accepted;
}

/**
 * Estimate the Q-factor of a spectral peak at `peakIndex` by
 * fitting a parabola to the magnitude curve in dB and finding
 * the −3 dB bandwidth.
 *
 *   mag        — magnitude spectrum in dB (coherent-gain normalised).
 *   peakIndex  — index of the local maximum.
 *   spreadHz   — search radius around the peak in Hz (default 200).
 *
 * Returns 0 when the peak is too flat / noise-floor (Q < 0.5).
 */
export function estimateQ(
  mag: Float32Array | number[],
  peakIndex: number,
  sampleRate: number = 48000,
  fftSize: number = 2048,
  spreadHz: number = 200,
): number {
  const n = mag.length;
  if (peakIndex < 1 || peakIndex >= n - 1) return 0;
  const binWidth = sampleRate / fftSize;
  const spreadBins = Math.max(2, Math.round(spreadHz / binWidth));
  const lo = Math.max(1, peakIndex - spreadBins);
  const hi = Math.min(n - 2, peakIndex + spreadBins);

  const peakDb = mag[peakIndex];
  const thresholdDb = peakDb - 3.0;
  if (peakDb <= -120) return 0;

  // Find −3 dB crossings via linear interpolation.
  let fLow: number | null = null;
  let fHigh: number | null = null;

  for (let i = peakIndex; i > lo; i--) {
    const v0 = mag[i - 1];
    const v1 = mag[i];
    if (v0 <= thresholdDb && v1 > thresholdDb) {
      const t = (thresholdDb - v0) / (v1 - v0);
      const bin = i - 1 + t;
      fLow = binToHz(bin, fftSize, sampleRate);
      break;
    }
  }
  for (let i = peakIndex; i < hi; i++) {
    const v0 = mag[i];
    const v1 = mag[i + 1];
    if (v0 > thresholdDb && v1 <= thresholdDb) {
      const t = (thresholdDb - v0) / (v1 - v0);
      const bin = i + t;
      fHigh = binToHz(bin, fftSize, sampleRate);
      break;
    }
  }
  if (fLow == null || fHigh == null) return 0;

  const f0 = binToHz(peakIndex, fftSize, sampleRate);
  const bw = Math.max(1, fHigh - fLow);
  const q = f0 / bw;
  // Reject very-low-Q (likely noise / sub-bin) estimates.
  return q < 0.5 ? 0 : q;
}

/**
 * Harmonic Product Spectrum (HPS) of order N. Returns a spectrum
 * roughly `N` times shorter than the input. Useful for finding the
 * fundamental frequency when it is masked by louder harmonics.
 *
 *   mag       — magnitude spectrum (length = fftSize / 2 + 1).
 *   harmonics — N (1 = identity, 4 = default for vocal fundamental).
 *
 * The returned array length = floor(mag.length / N). The mean of
 * `mag[i*k]` for k = 1..N is written to `out[floor(i/N)]`.
 */
export function harmonicProductSpectrum(mag: Float32Array | number[], harmonics: number = 4): Float32Array {
  if (harmonics < 1) {
    // Defensive: return a copy as Float32Array.
    const out = new Float32Array(mag.length);
    for (let i = 0; i < mag.length; i++) out[i] = mag[i];
    return out;
  }
  const N = mag.length;
  const outLen = Math.floor(N / harmonics);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let k = 1; k <= harmonics; k++) {
      sum += mag[i * k] ?? 0;
    }
    out[i] = sum / harmonics;
  }
  return out;
}
