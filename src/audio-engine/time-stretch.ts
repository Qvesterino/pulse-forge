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

/**
 * Non-destructive time-stretch: changes the duration of `data` by factor
 * `stretchFactor` WITHOUT changing pitch (P3.1 feature).
 *
 * stretchFactor > 1 = longer output (slower playback), < 1 = shorter (faster).
 * Uses granular resynthesis with overlap-add on individual grains.
 * Each grain is linearly interpolated from the source at the new time-scale,
 * windowed by a Hann envelope, and accumulated. The output length is
 * `round(D * stretchFactor)` samples. Runs synchronously — deterministic
 * live==offline. Best for factors 0.5..3.0 (beyond that, quality degrades).
 *
 * Fallback: if the stretch factor is near 1.0 or extreme (<0.25 or >5),
 * returns the input array itself (by reference — callers must not mutate it;
 * they should use the resample fallback instead).
 */
export function timeStretch(data: Float32Array, sampleRate: number, stretchFactor: number): Float32Array {
  const D = data.length;
  if (D === 0 || stretchFactor < 0.25 || stretchFactor >= 5 || Math.abs(stretchFactor - 1) < 0.01) return data;

  const outLen = Math.max(1, Math.round(D * stretchFactor));
  const out = new Float32Array(outLen);
  const winSum = new Float32Array(outLen);

  const grainSize = Math.max(64, Math.floor(0.04 * sampleRate));
  const hop = Math.max(16, Math.floor(0.015 * sampleRate));

  // Hann window
  const win = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
  }

  let outPos = 0;
  let srcFrame = 0;

  while (outPos < outLen) {
    // Position in the source buffer (stretch time = frame * stretchFactor)
    const srcCenter = outPos / stretchFactor;
    for (let i = 0; i < grainSize; i++) {
      const srcIdx = srcCenter + (i - grainSize / 2);
      // Linear interpolation from source
      const i0 = Math.floor(srcIdx);
      const frac = srcIdx - i0;
      const i1 = i0 + 1;
      let s = 0;
      if (i0 >= 0 && i1 < D) {
        s = data[i0] * (1 - frac) + data[i1] * frac;
      } else if (i0 >= 0 && i0 < D) {
        s = data[i0] * (1 - frac);
      }
      const outIdx = outPos + i;
      if (outIdx >= 0 && outIdx < outLen) {
        out[outIdx] += s * win[i];
        winSum[outIdx] += win[i];
      }
    }
    srcFrame += 1;
    outPos += hop;
  }

  // Normalize overlap
  for (let i = 0; i < outLen; i++) {
    if (winSum[i] > 1e-6) out[i] /= winSum[i];
  }

  return out;
}
