/**
 * Multi-band spectral-flux onset detection.
 *
 * Ported from audiokey-analyzer `src/dsp/spectralFlux.ts`:
 * flux[t] = sum over bins of max(mag[t] - mag[t-1], 0), computed on
 * log-compressed magnitudes for robustness. Three bands (full + kick-focused
 * low + percussive high) combine with explicit deterministic weights.
 */
import { ReferenceFft } from "./fft";
import { hannWindow } from "./window";

export interface OnsetEnvelopes {
  /** Full-spectrum spectral flux, normalized 0..1. */
  full: Float32Array;
  /** Low band (kick focused, <= 200 Hz). */
  low: Float32Array;
  /** High band (percussive transients, >= 4000 Hz). */
  high: Float32Array;
  /** Deterministic weighted combination. */
  combined: Float32Array;
  /** Seconds per envelope sample. */
  frameRate: number;
  frameCount: number;
}

export const FLUX_WEIGHT_FULL = 0.6;
export const FLUX_WEIGHT_LOW = 0.25;
export const FLUX_WEIGHT_HIGH = 0.15;

function normalize(x: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < x.length; i++) if (x[i] > max) max = x[i];
  if (max <= 0) return x;
  for (let i = 0; i < x.length; i++) x[i] /= max;
  return x;
}

/** Subtract a moving-average baseline and half-wave rectify. */
export function removeBaseline(x: Float32Array, windowSize: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(windowSize / 2));
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(x.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += x[j];
    const mean = sum / (hi - lo + 1);
    out[i] = Math.max(0, x[i] - mean);
  }
  return out;
}

export function computeOnsetEnvelopes(
  signal: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number,
): OnsetEnvelopes {
  const fft = new ReferenceFft(fftSize);
  const win = hannWindow(fftSize);
  const bins = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const lowMax = Math.min(bins - 1, Math.max(1, Math.round(200 / binHz)));
  const highMin = Math.min(bins - 1, Math.round(4000 / binHz));

  const frameCount = Math.max(0, Math.floor((signal.length - fftSize) / hopSize) + 1);
  const full = new Float32Array(Math.max(0, frameCount));
  const low = new Float32Array(Math.max(0, frameCount));
  const high = new Float32Array(Math.max(0, frameCount));

  const buf = new Float64Array(fftSize);
  const prev = new Float64Array(bins);
  const cur = new Float64Array(bins);
  let first = true;

  for (let t = 0; t < frameCount; t++) {
    const start = t * hopSize;
    for (let i = 0; i < fftSize; i++) buf[i] = signal[start + i] * win[i];
    fft.magnitudeSpectrum(buf, cur);
    for (let i = 0; i < bins; i++) cur[i] = Math.log1p(1000 * cur[i]);

    if (!first) {
      let fSum = 0;
      let lSum = 0;
      let hSum = 0;
      for (let i = 1; i < bins; i++) {
        const d = cur[i] - prev[i];
        if (d > 0) {
          fSum += d;
          if (i <= lowMax) lSum += d;
          else if (i >= highMin) hSum += d;
        }
      }
      full[t] = fSum;
      low[t] = lSum;
      high[t] = hSum;
    }
    first = false;
    prev.set(cur);
  }

  const frameRate = sampleRate / hopSize;
  const baselineWin = Math.max(3, Math.round(frameRate * 0.35));
  const fullN = normalize(removeBaseline(full, baselineWin));
  const lowN = normalize(removeBaseline(low, baselineWin));
  const highN = normalize(removeBaseline(high, baselineWin));

  const combined = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    combined[i] = FLUX_WEIGHT_FULL * fullN[i] + FLUX_WEIGHT_LOW * lowN[i] + FLUX_WEIGHT_HIGH * highN[i];
  }
  normalize(combined);

  return { full: fullN, low: lowN, high: highN, combined, frameRate, frameCount };
}

/** Standalone spectral flux (unit-testable helper). */
export function calculateSpectralFlux(
  signal: Float32Array,
  sampleRate: number,
  fftSize = 2048,
  hopSize = 512,
): Float32Array {
  return computeOnsetEnvelopes(signal, sampleRate, fftSize, hopSize).combined;
}
