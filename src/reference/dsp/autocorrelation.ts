/**
 * Deterministic autocorrelation over a lag range (inclusive).
 * Normalized by overlap length so long lags are not penalized.
 * Ported from audiokey-analyzer `src/dsp/autocorrelation.ts`.
 */
export function calculateAutocorrelation(x: Float32Array, minLag: number, maxLag: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  const lo = Math.max(1, minLag);
  const hi = Math.min(maxLag, n - 1);
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) sum += x[i] * x[i + lag];
    out[lag] = limit > 0 ? sum / limit : 0;
  }
  return out;
}

/** Parabolic interpolation around an integer peak; returns fractional index. */
export function parabolicPeak(values: ArrayLike<number>, index: number): number {
  if (index <= 0 || index >= values.length - 1) return index;
  const a = values[index - 1];
  const b = values[index];
  const c = values[index + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return index;
  const delta = (0.5 * (a - c)) / denom;
  if (!Number.isFinite(delta) || Math.abs(delta) > 1) return index;
  return index + delta;
}
