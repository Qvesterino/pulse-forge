/**
 * Master-safe quantization for consumer PCM formats (16-bit MP3 / WAV).
 *
 * 1. Legacy exports can apply a soft-knee clip: content below ≈ −0.45 dBFS
 *    passes untouched; hotter samples are rounded off with a tanh knee. Master
 *    delivery can instead reject over-range samples and preserve in-range PCM.
 * 2. TPDF dither at ±1 LSB: two independent uniform randoms per sample
 *    decorrelate the quantization error, so quiet passages and reverb tails
 *    fade into level-dependent noise instead of digital silence.
 *
 * The PRNG is seeded, so identical renders produce byte-identical files.
 */

const SOFT_CLIP_THRESHOLD = 0.95; // ≈ −0.45 dBFS — linear below, tanh knee above

export type IntegerOverflowPolicy = "soft-knee" | "reject";

export class IntegerPcmDeliveryError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "IntegerPcmDeliveryError";
  }
}

/** Refuse integer delivery that would need a hidden level change to fit full scale. */
export function assertIntegerPcmRange(sample: number): void {
  if (!Number.isFinite(sample)) {
    throw new IntegerPcmDeliveryError(
      "Integer PCM export refused: the render contains a non-finite sample. Re-render and inspect the master chain.",
    );
  }
  if (Math.abs(sample) > 1) {
    throw new IntegerPcmDeliveryError(
      `Integer PCM export refused: sample peak ${sample > 0 ? "+" : ""}${sample.toFixed(6)} exceeds 0 dBFS. Reduce master input/trim or limiter ceiling and render again; use 32-bit-float WAV to preserve over-range headroom. No soft clipping was applied.`,
    );
  }
}

/** Legacy soft-knee curve: linear below the threshold, tanh asymptote to ±1. */
export function softClipSample(x: number): number {
  if (x > SOFT_CLIP_THRESHOLD) {
    return (
      SOFT_CLIP_THRESHOLD + (1 - SOFT_CLIP_THRESHOLD) * Math.tanh((x - SOFT_CLIP_THRESHOLD) / (1 - SOFT_CLIP_THRESHOLD))
    );
  }
  if (x < -SOFT_CLIP_THRESHOLD) {
    return (
      -SOFT_CLIP_THRESHOLD -
      (1 - SOFT_CLIP_THRESHOLD) * Math.tanh((-x - SOFT_CLIP_THRESHOLD) / (1 - SOFT_CLIP_THRESHOLD))
    );
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

/** Soft-knee (or pass through), TPDF-dither and quantize one sample to 16-bit PCM. */
export function quantizeInt16Sample(
  x: number,
  rand: () => number,
  overflowPolicy: IntegerOverflowPolicy = "soft-knee",
): number {
  if (overflowPolicy === "reject") assertIntegerPcmRange(x);
  const dither = rand() + rand() - 1; // TPDF: triangular, ±1 LSB peak
  const input = overflowPolicy === "soft-knee" ? softClipSample(x) : x;
  const v = Math.round(input * 0x8000 + dither);
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
