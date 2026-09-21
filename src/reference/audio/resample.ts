/**
 * Deterministic linear-interpolation resampler.
 * Ported from audiokey `src/audio/resample.ts`. Isolated so it can later be
 * replaced by a windowed-sinc implementation without touching the pipeline.
 */
export function resampleLinear(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (inputRate === targetRate || input.length === 0) return input;
  const ratio = inputRate / targetRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
