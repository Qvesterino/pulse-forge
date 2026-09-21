/**
 * Aggregate 12-bin pitch-class energy from an STFT.
 *
 * Ported from audiokey-analyzer `src/dsp/chroma.ts`. Magnitudes are
 * log-compressed and per-frame normalized so loud sections do not dominate
 * the aggregate. Frequency range 60–5000 Hz; bins far from an equal-tempered
 * pitch center are rejected as noise.
 */
import { ReferenceFft } from "./fft";
import { hannWindow } from "./window";

export interface ChromaResult {
  chroma: number[];
  frameCount: number;
  tonalEnergy: number;
}

export const CHROMA_MIN_HZ = 60;
export const CHROMA_MAX_HZ = 5000;

export function extractChroma(signal: Float32Array, sampleRate: number, fftSize = 2048, hopSize = 512): ChromaResult {
  const fft = new ReferenceFft(fftSize);
  const win = hannWindow(fftSize);
  const bins = fftSize / 2;
  const binHz = sampleRate / fftSize;

  // Precompute deterministic bin -> pitch class map and weights.
  const pcOf = new Int8Array(bins).fill(-1);
  const weight = new Float64Array(bins);
  for (let i = 1; i < bins; i++) {
    const f = i * binHz;
    if (f < CHROMA_MIN_HZ || f > CHROMA_MAX_HZ) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const rounded = Math.round(midi);
    // Reject bins far from an equal-tempered pitch center (noise rejection).
    if (Math.abs(midi - rounded) > 0.35) continue;
    pcOf[i] = ((rounded % 12) + 12) % 12;
    // Mild high-frequency de-emphasis.
    weight[i] = 1 / (1 + f / 2000);
  }

  const chroma = new Array<number>(12).fill(0);
  const buf = new Float64Array(fftSize);
  const mag = new Float64Array(bins);
  let frameCount = 0;
  let tonalEnergySum = 0;

  for (let start = 0; start + fftSize <= signal.length; start += hopSize) {
    for (let i = 0; i < fftSize; i++) buf[i] = signal[start + i] * win[i];
    fft.magnitudeSpectrum(buf, mag);

    const frame = new Array<number>(12).fill(0);
    let frameSum = 0;
    for (let i = 1; i < bins; i++) {
      const pc = pcOf[i];
      if (pc < 0) continue;
      const v = Math.log1p(1000 * mag[i]) * weight[i];
      frame[pc] += v;
      frameSum += v;
    }
    if (frameSum > 0) {
      for (let p = 0; p < 12; p++) chroma[p] += frame[p] / frameSum;
      // Tonal energy: peakiness of the frame chroma (flat -> noise).
      let max = 0;
      for (let p = 0; p < 12; p++) if (frame[p] > max) max = frame[p];
      tonalEnergySum += max / frameSum;
      frameCount++;
    }
  }

  let total = 0;
  for (let p = 0; p < 12; p++) total += chroma[p];
  if (total > 0) for (let p = 0; p < 12; p++) chroma[p] /= total;

  return {
    chroma,
    frameCount,
    tonalEnergy: frameCount > 0 ? tonalEnergySum / frameCount : 0,
  };
}
