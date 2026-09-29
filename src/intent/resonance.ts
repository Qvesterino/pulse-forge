/**
 * RESONANCE DETECTOR — the AI ear for problem frequencies.
 *
 * A human engineer sweeps a narrow boost across the spectrum to find
 * ringy resonances; this computes the same information in closed form:
 * an averaged periodogram → per-bin level in dB → local maxima that
 * exceed the LOCAL spectral median by a threshold → clustered into
 * resonance candidates.
 *
 * Used by the intent layer ("odstráň rezonanciu", "notch at 347 Hz") to
 * auto-locate and notch the offender via the EQ's free surgical bands.
 */

import { fftInPlace } from "../audio-engine/spectralEdit";

const FFT_SIZE = 4096;
const HOP = FFT_SIZE / 4;

export interface ResonanceHit {
  /** Center frequency in Hz. */
  hz: number;
  /** How far above the local spectral median, in dB. */
  prominenceDb: number;
}

/**
 * Find spectral resonance peaks: local maxima in the averaged periodogram
 * that exceed a rolling median by `prominenceDb`. Returns up to `maxHits`
 * candidates sorted by prominence (loudest first). Pure — no side effects.
 */
export function findResonances(
  pcm: Float32Array,
  sampleRate: number,
  options: { maxHits?: number; prominenceDb?: number } = {},
): ResonanceHit[] {
  const maxHits = options.maxHits ?? 3;
  const prominence = options.prominenceDb ?? 8;

  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP) + 1);
  const bins = FFT_SIZE / 2;
  const acc = new Float64Array(bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  // Skip DC-blocked first bin (k=0 carries DC offset — not a resonance).
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      re[i] = (off + i < pcm.length ? pcm[off + i] : 0) * w;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 1; k < bins; k++) {
      acc[k] += re[k] * re[k] + im[k] * im[k];
    }
  }

  // Per-bin level in dB.
  const level = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    level[k] = 10 * Math.log10(Math.max(acc[k], 1e-20));
  }

  // Rolling median (window ±8 bins) as the local spectral floor.
  const W = 8;
  const floor = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    const lo = Math.max(1, k - W);
    const hi = Math.min(bins, k + W + 1);
    const window: number[] = [];
    for (let j = lo; j < hi; j++) window.push(level[j]);
    window.sort((a, b) => a - b);
    floor[k] = window[Math.floor(window.length / 2)];
  }

  // Local maxima above floor + prominence.
  const nyquistBin = Math.min(bins, Math.floor((bins * 20000) / (sampleRate / 2)));
  const hits: ResonanceHit[] = [];
  for (let k = 2; k < Math.min(bins - 1, nyquistBin); k++) {
    if (level[k] <= level[k - 1] || level[k] <= level[k + 1]) continue;
    const prom = level[k] - floor[k];
    if (prom < prominence) continue;
    const hz = Math.round((k * sampleRate) / FFT_SIZE);
    // Cluster: skip if within 3 bins of an already-found (louder) hit.
    if (hits.some((h) => Math.abs(h.hz - hz) < (3 * sampleRate) / FFT_SIZE)) continue;
    hits.push({ hz, prominenceDb: Math.round(prom * 10) / 10 });
    if (hits.length >= maxHits) break;
  }
  return hits;
}
