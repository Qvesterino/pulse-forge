/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Self-contained radix-2 FFT + windowing
//
// Used by the realtime spectrum analyzer and by the Auto Cut / Unmask
// / Masking Meter analyzers. Pure, dependency-free, allocation-free
// at steady state (scratch buffers are reused).
//
// Implementation: iterative in-place Cooley–Tukey decimation-in-time
// radix-2 FFT with precomputed bit-reversal and twiddle tables.
// ═══════════════════════════════════════════════════════════

export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function isPow2(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

/** Hann window of length N (periodic convention). */
export function hannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  const inv = (2 * Math.PI) / N;
  for (let k = 0; k < N; k++) w[k] = 0.5 * (1 - Math.cos(k * inv));
  return w;
}

interface FftPlan {
  readonly size: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly rev: Int32Array;
}

const planCache = new Map<number, FftPlan>();

export function fftPlan(size: number): FftPlan {
  if (!isPow2(size) || size < 1) {
    throw new Error(`fftPlan: size must be a power of two ≥ 1, got ${size}`);
  }
  const cached = planCache.get(size);
  if (cached) return cached;

  const N = size;
  const levels = Math.round(Math.log2(N));

  const rev = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }

  const cos = new Float64Array(N);
  const sin = new Float64Array(N);
  const base = (-2 * Math.PI) / N;
  for (let k = 0; k < N; k++) {
    cos[k] = Math.cos(base * k);
    sin[k] = Math.sin(base * k);
  }

  const plan: FftPlan = { size: N, cos, sin, rev };
  planCache.set(N, plan);
  return plan;
}

/**
 * In-place complex radix-2 FFT. `re.length` must equal `im.length` and
 * be a power of two.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const N = re.length;
  if (N !== im.length) throw new Error("fft: re/im length mismatch");
  if (N === 1) return;
  const plan = fftPlan(N);
  const { rev, cos, sin } = plan;

  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let i = 0; i < N; i += size) {
      let k = 0;
      for (let j = i; j < i + half; j++) {
        const c = cos[k];
        const s = sin[k];
        const tpre = re[j + half] * c - im[j + half] * s;
        const tpim = re[j + half] * s + im[j + half] * c;
        re[j + half] = re[j] - tpre;
        im[j + half] = im[j] - tpim;
        re[j] += tpre;
        im[j] += tpim;
        k += step;
      }
    }
  }
}

/**
 * Magnitude spectrum of a real input frame. Applies a Hann window and
 * coherent-gain normalisation so a full-scale sine at a bin yields ~1.
 *
 * `scratchRe`/`scratchIm` are optional reusable Float64Arrays of length N.
 * If omitted or too small, fresh scratch is allocated.
 */
export function magnitudeSpectrum(
  input: Float32Array | Float64Array,
  window: Float32Array,
  out: Float32Array,
  scratchRe?: Float64Array,
  scratchIm?: Float64Array,
): void {
  const N = window.length;
  const half = N >> 1;
  if (out.length < half + 1) {
    throw new Error(`magnitudeSpectrum: out must hold N/2+1=${half + 1} bins`);
  }
  // View the scratch at EXACTLY N samples: fft() transforms re.length, so an
  // oversized scratch (e.g. a 4096 buffer reused after switching to a 2048
  // window) would drag stale bins N..len into the transform and contaminate
  // every output bin, not just waste cycles.
  const re = scratchRe && scratchRe.length >= N ? scratchRe.subarray(0, N) : new Float64Array(N);
  const im = scratchIm && scratchIm.length >= N ? scratchIm.subarray(0, N) : new Float64Array(N);

  let winGain = 0;
  for (let k = 0; k < N; k++) {
    // Short inputs are zero-padded rather than read as undefined (NaN).
    const s = k < input.length ? input[k] : 0;
    re[k] = s * window[k];
    im[k] = 0;
    winGain += window[k];
  }

  fft(re, im);

  const norm = winGain > 0 ? 2 / winGain : 1;
  for (let k = 0; k <= half; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
    out[k] = mag;
  }
  out[0] *= 0.5;
  out[half] *= 0.5;
}

/** Bin centre frequency for index k. */
export function binFreq(k: number, fftSize: number, sampleRate: number): number {
  return (k * sampleRate) / fftSize;
}

/** Bin index for a given frequency. */
export function freqToBin(freqHz: number, fftSize: number, sampleRate: number): number {
  return Math.round((freqHz * fftSize) / sampleRate);
}
