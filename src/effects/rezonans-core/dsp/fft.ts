/**
 * REZONANS — first-party radix-2 FFT + windowing.
 *
 * NOT vendored: this is our own implementation, written for REZONANS's
 * spectral formant path. It deliberately does not import `ozvena-core`'s
 * copy — each flagship suite owns its transform (ozvena and ultina each carry
 * one), and cross-suite imports would couple REZONANS to OZVENA's vendor
 * reconciliation markers.
 *
 * Implementation: iterative in-place Cooley–Tukey decimation-in-time
 * radix-2 with precomputed bit-reversal and twiddle tables, plus the
 * conjugate trick for the inverse. Tables are built once per size and cached;
 * after `prepare()` the hot path allocates nothing.
 */

export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function isPow2(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

/** Periodic Hann window of length N. */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  const inv = (2 * Math.PI) / n;
  for (let k = 0; k < n; k++) w[k] = 0.5 * (1 - Math.cos(k * inv));
  return w;
}

interface FftPlan {
  readonly size: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly rev: Int32Array;
}

const planCache = new Map<number, FftPlan>();

/** Build (or fetch) the twiddle/bit-reversal tables for a power-of-two size. */
export function fftPlan(size: number): FftPlan {
  if (!isPow2(size) || size < 1) {
    throw new Error(`fftPlan: size must be a power of two >= 1, got ${size}`);
  }
  const cached = planCache.get(size);
  if (cached) return cached;

  const n = size;
  const levels = Math.round(Math.log2(n));

  const rev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }

  // One period of twiddles (cos/sin of -2πk/N). Indexing is `k` stepped by
  // `n / size`, so only n/2 distinct entries are ever needed.
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  const base = (-2 * Math.PI) / n;
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos(base * k);
    sin[k] = Math.sin(base * k);
  }

  const plan: FftPlan = { size: n, cos, sin, rev };
  planCache.set(n, plan);
  return plan;
}

/** In-place complex forward FFT. `re.length === im.length`, a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: re/im length mismatch");
  if (n === 1) return;
  const { rev, cos, sin } = fftPlan(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      let k = 0;
      for (let j = i; j < i + half; j++) {
        const c = cos[k]!;
        const s = sin[k]!;
        const tr = re[j + half]! * c - im[j + half]! * s;
        const ti = re[j + half]! * s + im[j + half]! * c;
        re[j + half] = re[j]! - tr;
        im[j + half] = im[j]! - ti;
        re[j] = re[j]! + tr;
        im[j] = im[j]! + ti;
        k += step;
      }
    }
  }
}

/**
 * In-place inverse FFT via the conjugate trick: IFFT(X) = conj(FFT(conj(X))) / n.
 *
 * The forward transform is negation-symmetric, so there is no second table —
 * only a conjugation pass and the 1/n scaling folded into the resynthesis
 * loop (see `voice.ts`), where it costs nothing extra.
 */
export function ifftInto(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let k = 0; k < n; k++) im[k] = -im[k]!;
  fft(re, im);
}

/** Principal argument: wrap to (-π, π]. */
export function princarg(x: number): number {
  const tau = Math.PI * 2;
  let y = x % tau;
  if (y > Math.PI) y -= tau;
  else if (y < -Math.PI) y += tau;
  return y;
}

/** Bin centre frequency for index k. */
export function binFreq(k: number, fftSize: number, sampleRate: number): number {
  return (k * sampleRate) / fftSize;
}

/** Bin index nearest to a given frequency (clamped into range). */
export function freqToBin(freqHz: number, fftSize: number, sampleRate: number): number {
  const k = Math.round((freqHz * fftSize) / sampleRate);
  return Math.max(0, Math.min(fftSize >> 1, k));
}

/**
 * Catmull-Rom cubic sample read; returns 0 outside `[0, len)`.
 *
 * The zero-outside behaviour is load-bearing: the analysis window reaches
 * back before the start of the stream, and reading undefined there would be
 * a NaN source that survives every downstream clamp.
 */
export function cubicAt(data: Float32Array, pos: number): number {
  const len = data.length;
  const i1 = Math.floor(pos);
  if (i1 < -1 || i1 > len) return 0;
  const frac = pos - i1;
  const p0 = i1 - 1 >= 0 ? data[i1 - 1]! : 0;
  const p1 = i1 >= 0 && i1 < len ? data[i1]! : 0;
  const p2 = i1 + 1 >= 0 && i1 + 1 < len ? data[i1 + 1]! : 0;
  const p3 = i1 + 2 >= 0 && i1 + 2 < len ? data[i1 + 2]! : 0;
  return p1 + 0.5 * frac * (p2 - p0 + frac * (2 * p0 - 5 * p1 + 4 * p2 - p3 + frac * (3 * (p1 - p2) + p3 - p0)));
}
