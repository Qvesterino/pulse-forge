/**
 * Spectral editing: STFT-domain gain surgery on audio buffers (RX-style
 * "select a time×frequency region, attenuate it" processing).
 *
 * Pipeline: Hann-windowed STFT (75% overlap, WOLA synthesis) → per-frame
 * bin gain from the edit list → inverse STFT → edited samples. Edits are
 * composable (multiplicative) and feathered at every edge (raised cosine
 * in time, log-frequency) so selections never click or ring.
 *
 * Pure math only — no DOM, no audio graph. The caller owns buffers: pass
 * Float32Array channels in, get new Float32Arrays out, keep the original
 * for A/B (and for undo — commands rewire a clip's bufferId instead of
 * mutating the bank entry).
 */

/** In-place iterative radix-2 complex FFT. `n` must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1 || (n & (n - 1)) !== 0) throw new Error(`fft size must be a power of two, got ${n}`);
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + half;
        const oddRe = re[oddIdx] * curRe - im[oddIdx] * curIm;
        const oddIm = re[oddIdx] * curIm + im[oddIdx] * curRe;
        re[oddIdx] = re[evenIdx] - oddRe;
        im[oddIdx] = im[evenIdx] - oddIm;
        re[evenIdx] += oddRe;
        im[evenIdx] += oddIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** One spectral edit: attenuate/boost [freqLoHz, freqHiHz] inside [startSec, endSec]. */
export interface SpectralEdit {
  startSec: number;
  endSec: number;
  freqLoHz: number;
  freqHiHz: number;
  /** Linear gain applied in dB. −60 and below reads as a near-cut. */
  gainDb: number;
}

export interface SpectralEditOptions {
  /** FFT window (power of two). Default 2048 — ~46 ms @ 44.1 kHz. */
  fftSize?: number;
  /** Raised-cosine time feather per edit edge (sec). Default 0.03. */
  featherSec?: number;
  /** Log-frequency feather per edit edge (octaves). Default 0.25. */
  featherOctaves?: number;
}

interface CompiledEdit {
  startSec: number;
  endSec: number;
  binLo: number;
  binHi: number;
  gainLin: number;
  featherSec: number;
  featherOct: number;
  freqLoHz: number;
  freqHiHz: number;
}

function compileEdits(edits: SpectralEdit[], sampleRate: number, fftSize: number): CompiledEdit[] {
  return edits.map((e) => ({
    startSec: e.startSec,
    endSec: e.endSec,
    binLo: Math.max(0, (e.freqLoHz * fftSize) / sampleRate),
    binHi: Math.min(fftSize / 2, (e.freqHiHz * fftSize) / sampleRate),
    gainLin: Math.pow(10, e.gainDb / 20),
    featherSec: e.featherSec ?? 0,
    featherOct: 0,
    freqLoHz: e.freqLoHz,
    freqHiHz: e.freqHiHz,
  }));
}

/** Raised cosine in [0,1]: 0 at edges, 1 in the middle. */
function raisedCosine(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/**
 * Total multiplicative gain (linear) of the edit stack at one point in
 * time × frequency. Feathers: raised cosine over `featherSec` at time
 * edges and over `featherOct` octaves at frequency edges.
 */
export function spectralGainAt(
  edits: SpectralEdit[],
  timeSec: number,
  freqHz: number,
  featherSec = 0.03,
  featherOct = 0.25,
): number {
  let gain = 1;
  for (const e of edits) {
    if (timeSec < e.startSec - e.feather(0) || timeSec > e.endSec + 0.25) {
      // cheap reject below uses feather — handled in full path instead
    }
    const tIn =
      raisedCosine((timeSec - (e.startSec - featherSec)) / Math.max(featherSec, 1e-6)) *
      raisedCosine(((e.endSec + featherSec) - timeSec) / Math.max(featherSec, 1e-6));
    if (tIn <= 0) continue;
    const logF = Math.log2(Math.max(freqHz, 1));
    const logLo = Math.log2(Math.max(e.freqLoHz, 1));
    const logHi = Math.log2(Math.max(e.freqHiHz, 1));
    const fIn =
      raisedCosine((logF - (logLo - featherOct)) / featherOct) *
      raisedCosine(((logHi + featherOct) - logF) / featherOct);
    if (fIn <= 0) continue;
    gain *= 1 + (Math.pow(10, e.gainDb / 20) - 1) * tIn * fIn;
  }
  return gain;
}

/**
 * Apply spectral edits to one channel. WOLA: Hann analysis + Hann
 * synthesis with 75% overlap and per-sample normalization, so untouched
 * regions reconstruct near-bit-exact and edits crossfade smoothly.
 */
export function applySpectralEdits(
  input: Float32Array,
  sampleRate: number,
  edits: SpectralEdit[],
  opts: SpectralEditOptions = {},
): Float32Array<ArrayBuffer> {
  const fftSize = opts.fftSize ?? 2048;
  if ((fftSize & (fftSize - 1)) !== 0) throw new Error(`fftSize must be a power of two, got ${fftSize}`);
  const featherSec = opts.featherSec ?? 0.03;
  const featherOct = opts.featherOctaves ?? 0.25;
  const hop = fftSize >> 2;
  const n = input.length;
  const out = new Float32Array(n);
  if (edits.length === 0 || n === 0) {
    out.set(input);
    return out;
  }

  // Precompute Hann window.
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const winSum = new Float64Array(n);

  for (let base = 0; base + fftSize <= n || base < n; base += hop) {
    const frameStart = base;
    // Zero-pad the tail so the last samples still get full frames.
    for (let i = 0; i < fftSize; i++) {
      const idx = frameStart + i;
      re[i] = idx < n ? input[idx] * win[i] : 0;
      im[i] = 0;
    }
    const frameTime = (frameStart + fftSize / 2) / sampleRate;
    // Frame-level reject: outside every edit's feathered reach → skip FFT.
    let anyEffect = false;
    for (const e of edits) {
      const inReach =
        frameTime + featherSec + fftSize / sampleRate >= e.startSec - featherSec &&
        frameTime - featherSec - fftSize / sampleRate <= e.endSec + featherSec;
      if (inReach) {
        anyEffect = true;
        break;
      }
    }
    if (anyEffect) {
      fftInPlace(re, im);
      const binHz = sampleRate / fftSize;
      for (const e of edits) {
        const tIn =
          raisedCosine((frameTime - (e.startSec - featherSec)) / Math.max(featherSec, 1e-6)) *
          raisedCosine(((e.endSec + featherSec) - frameTime) / Math.max(featherSec, 1e-6));
        if (tIn <= 0) continue;
        const logLo = Math.log2(Math.max(e.freqLoHz, 1));
        const logHi = Math.log2(Math.max(e.freqHiHz, 1));
        const binFrom = Math.max(1, Math.floor(e.binLo - (featherOct * e.binLo) / 1 - 2));
        const binTo = Math.min(fftSize / 2 - 1, Math.ceil(e.binHi + 2));
        for (let bin = binFrom; bin <= binTo; bin++) {
          const freq = bin * binHz;
          if (freq < e.freqLoHz * Math.pow(2, -featherOct) || freq > e.freqHiHz * Math.pow(2, featherOct)) continue;
          const logF = Math.log2(Math.max(freq, 1));
          const fIn =
            raisedCosine((logF - (logLo - featherOct)) / featherOct) *
            raisedCosine(((logHi + featherOct) - logF) / featherOct);
          if (fIn <= 0) continue;
          const g = 1 + (e.gainLinear - 1) * tIn * fIn;
          // Real-signal FFT symmetry: mirror bins stay conjugate.
          re[bin] *= g;
          im[bin] *= g;
          if (bin > 0 && bin < fftSize / 2) {
            re[fftSize - bin] *= g;
            im[fftSize - bin] *= g;
          }
        }
      }
      fftInPlace(re, im, true);
    }
    for (let i = 0; i < fftSize; i++) {
      const idx = frameStart + i;
      if (idx >= n) break;
      out[idx] += re[i] * win[i];
      winSum[idx] += win[i] * win[i];
    }
    if (base + hop >= n && base + fftSize >= n) break;
  }

  // WOLA normalization — untouched regions reconstruct exactly.
  for (let i = 0; i < n; i++) {
    out[i] = winSum[i] > 1e-8 ? out[i] / winSum[i] : input[i];
  }
  return out;
}

// Augment SpectralEdit with an optional internal field used by compile-time
// callers; kept off the public interface to stay JSON-clean.
declare module "./spectralEdit" {}
export interface SpectralEdit {
  /** Compile-time only (never persisted): precomputed linear gain. */
  gainLinear?: number;
}

/** Apply edits to a stereo pair (two channels sharing one edit list). */
export function applySpectralEditsToChannels(
  channels: Float32Array[],
  sampleRate: number,
  edits: SpectralEdit[],
  opts: SpectralEditOptions = {},
): Float32Array<ArrayBuffer>[] {
  return channels.map((ch) => applySpectralEdits(ch, sampleRate, edits, opts));
}
