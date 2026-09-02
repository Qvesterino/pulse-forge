/**
 * Master-safe quantization for consumer PCM formats (16-bit MP3 / WAV).
 *
 * 1. Soft-knee clip: content below ≈ −0.45 dBFS passes untouched; intersample
 *    overs above the threshold are rounded off with a tanh knee instead of a
 *    hard square clip — hot masters fade into the ceiling instead of crunch.
 * 2. TPDF dither at ±1 LSB: two independent uniform randoms per sample
 *    decorrelate the quantization error, so quiet passages and reverb tails
 *    fade into level-dependent noise instead of digital silence.
 *
 * The PRNG is seeded, so identical renders produce byte-identical files.
 */

const SOFT_CLIP_THRESHOLD = 0.95; // ≈ −0.45 dBFS — linear below, tanh knee above

/** Soft-knee limiter: linear below the threshold, tanh asymptote to ±1. */
export function softClipSample(x: number): number {
  if (x > SOFT_CLIP_THRESHOLD) {
    return SOFT_CLIP_THRESHOLD + (1 - SOFT_CLIP_THRESHOLD) * Math.tanh((x - SOFT_CLIP_THRESHOLD) / (1 - SOFT_CLIP_THRESHOLD));
  }
  if (x < -SOFT_CLIP_THRESHOLD) {
    return -SOFT_CLIP_THRESHOLD - (1 - SOFT_CLIP_THRESHOLD) * Math.tanh((-x - SOFT_CLIP_THRESHOLD) / (1 - SOFT_CLIP_THRESHOLD));
  }
  return x;
}

/** Deterministic PRNG for dither sequences (exported for per-call seeding). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft-clip, TPDF-dither and quantize one sample to the 16-bit domain. */
export function quantizeInt16Sample(x: number, rand: () => number): number {
  const dither = rand() + rand() - 1; // TPDF: triangular, ±1 LSB peak
  const v = Math.round(softClipSample(x) * 0x8000 + dither);
  return Math.max(-0x8000, Math.min(0x7fff, v));
}

/** Soft-clip + TPDF-dither + quantize a channel to 16-bit PCM. */
export function quantizeInt16(input: Float32Array, seed: number): Int16Array<ArrayBuffer> {
  const rand = mulberry32(seed);
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = quantizeInt16Sample(input[i], rand);
  }
  return out;
}
