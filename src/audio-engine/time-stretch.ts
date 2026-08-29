/**
 * Pitch shift that preserves duration (time-stretch) for the Sampler.
 *
 * Granular overlap-add: grains of the source are read at playback rate `r`
 * (2^(semitones/12)) and written back at the original sample rate, so the
 * output has the SAME length as the input while the pitch moves. Source
 * position wraps modulo the buffer length, which makes this a loop-based
 * pitch shifter — ideal for tonal one-shots (plucks, keys, bells, pads).
 *
 * Pure, deterministic, synchronous — runs identically in live playback and
 * offline rendering (no AudioContext, no worker, no async).
 */

export function pitchShiftPreserveDuration(data: Float32Array, sampleRate: number, semitones: number): Float32Array {
  const D = data.length;
  if (D === 0) return new Float32Array(0);
  const r = Math.pow(2, semitones / 12);
  const out = new Float32Array(D);
  const winSum = new Float32Array(D);
  const grainSize = Math.max(64, Math.floor(0.03 * sampleRate));
  const hop = Math.max(16, Math.floor(0.01 * sampleRate));
  const outGrain = Math.max(1, Math.round(grainSize / r));
  const win = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
  }
  let outPos = 0;
  let srcPos = 0;
  while (outPos < D) {
    for (let i = 0; i < outGrain && outPos + i < D; i++) {
      const srcIdx = (srcPos + i * r) % D;
      const i0 = Math.floor(srcIdx);
      const frac = srcIdx - i0;
      const i1 = (i0 + 1) % D;
      const s = data[i0] * (1 - frac) + data[i1] * frac;
      const w = win[Math.min(grainSize - 1, Math.round(i * r))];
      out[outPos + i] += s * w;
      winSum[outPos + i] += w;
    }
    outPos += hop;
    srcPos = (srcPos + grainSize) % D;
  }
  for (let i = 0; i < D; i++) {
    if (winSum[i] > 1e-6) out[i] /= winSum[i];
  }
  return out;
}
