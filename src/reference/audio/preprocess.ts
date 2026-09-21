/**
 * Analysis-only preprocessing: DC removal + peak normalization.
 * Ported from audiokey `src/audio/preprocess.ts`. The source buffer is never
 * modified — a new normalized copy is returned.
 */
export interface PreprocessResult {
  signal: Float32Array;
  peak: number;
  rms: number;
  isSilent: boolean;
}

export function preprocessForAnalysis(input: Float32Array): PreprocessResult {
  const n = input.length;
  if (n === 0) return { signal: input, peak: 0, rms: 0, isSilent: true };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += input[i];
  mean /= n;

  const out = new Float32Array(n);
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = input[i] - mean;
    out[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sq += v * v;
  }
  const rms = Math.sqrt(sq / n);

  const isSilent = peak < 1e-4 || rms < 1e-5;
  if (!isSilent && peak > 0) {
    const gain = 1 / peak;
    for (let i = 0; i < n; i++) out[i] *= gain;
  }

  return { signal: out, peak, rms, isSilent };
}
