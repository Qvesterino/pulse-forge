/**
 * Spectral editing: STFT-domain gain surgery on audio buffers (RX-style
 * "select a time×frequency region, attenuate it" processing).
 *
 * Pipeline: Hann-windowed STFT (75% overlap, WOLA synthesis) → per-bin
 * gain from the edit list → inverse STFT → edited samples. Edits are
 * composable (multiplicative) and feathered at every edge (raised cosine
 * in time and in log-frequency) so selections never click or ring.
 * Frames outside every edit's reach skip the FFT entirely — editing a
 * small region of a long file costs almost nothing.
 *
 * Pure math only — no DOM, no audio graph. The caller owns buffers: pass
 * Float32Array channels in, get new Float32Arrays out, keep the original
 * for A/B (and for undo — commands rewire a clip's bufferId instead of
 * mutating the shared bank entry).
 */

/** In-place iterative radix-2 complex FFT. `n` must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1 || (n & (n - 1)) !== 0) throw new Error(`fft size must be a power of two, got ${n}`);
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
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
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
  /** Gain applied inside the region, dB. −60 and below reads as a cut. */
  gainDb: number;
}

export interface SpectralEditOptions {
  /** FFT window (power of two). Default 2048 — ~46 ms @ 44.1 kHz. */
  fftSize?: number;
  /** Raised-cosine time feather on each edit edge (sec). Default 0.03. */
  featherSec?: number;
  /** Log-frequency feather on each band edge (octaves). Default 0.25. */
  featherOctaves?: number;
}

interface CompiledEdit {
  startSec: number;
  endSec: number;
  gainLin: number;
  binLo: number;
  binHi: number;
  binFrom: number;
  binTo: number;
  logLo: number;
  logHi: number;
}

function compileEdits(edits: SpectralEdit[], sampleRate: number, fftSize: number, featherOct: number): CompiledEdit[] {
  const binHz = sampleRate / fftSize;
  const half = fftSize >> 1;
  return edits.map((e) => {
    const fLo = Math.max(1, e.freqLoHz);
    const fHi = Math.min(sampleRate / 2, Math.max(fLo * 1.001, e.freqHiHz));
    const logLo = Math.log2(fLo);
    const logHi = Math.log2(fHi);
    // Feather reach in bins: ±featherOct octaves around the band edges.
    const reachLo = fLo / Math.pow(2, featherOct);
    const reachHi = fHi * Math.pow(2, featherOct);
    return {
      startSec: e.startSec,
      endSec: e.endSec,
      gainLin: Math.pow(10, e.gainDb / 20),
      binLo: fLo / binHz,
      binHi: fHi / binHz,
      binFrom: Math.max(1, Math.floor(reachLo / binHz)),
      binTo: Math.min(half - 1, Math.ceil(reachHi / binHz)),
      logLo,
      logHi,
    };
  });
}

/** Raised cosine in [0,1]: 0 at t≤0, 1 at t≥1. */
function raisedCosine(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/**
 * Apply spectral edits to one channel. WOLA: Hann analysis + Hann
 * synthesis with 75% overlap and per-sample normalization — untouched
 * regions reconstruct near-exactly and edit edges crossfade smoothly.
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
  if (n === 0) return out;
  if (edits.length === 0) {
    out.set(input);
    return out;
  }
  const compiled = compileEdits(edits, sampleRate, fftSize, featherOct);

  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const winSum = new Float64Array(n);
  const featherInv = 1 / Math.max(featherSec, 1e-6);

  for (let base = 0; ; base += hop) {
    const frameStartSec = base / sampleRate;
    const frameEndSec = (base + fftSize) / sampleRate;

    // Which edits reach this frame? None → plain windowed overlap-add.
    const active: CompiledEdit[] = [];
    for (const e of compiled) {
      if (frameEndSec + featherSec < e.startSec || frameStartSec - featherSec > e.endSec) continue;
      active.push(e);
    }

    if (active.length === 0) {
      for (let i = 0; i < fftSize; i++) {
        const idx = base + i;
        if (idx >= n) break;
        const w = win[i];
        out[idx] += input[idx] * w * w;
        winSum[idx] += w * w;
      }
    } else {
      for (let i = 0; i < fftSize; i++) {
        const idx = base + i;
        re[i] = idx < n ? input[idx] * win[i] : 0;
        im[i] = 0;
      }
      fftInPlace(re, im);
      const binHz = sampleRate / fftSize;
      for (const e of active) {
        const tIn =
          raisedCosine((frameTimeCenter(frameStartSec, fftSize, sampleRate) - (e.startSec - featherSec)) * featherInv) *
          raisedCosine(((e.endSec + featherSec) - frameTimeCenter(frameStartSec, fftSize, sampleRate)) * featherInv);
        if (tIn <= 0) continue;
        for (let bin = e.binFrom; bin <= e.binTo; bin++) {
          const freq = bin * binHz;
          const logF = Math.log2(freq);
          const fIn =
            raisedCosine((logF - (e.logLo - featherOct)) / featherOct) *
            raisedCosine((e.logHi + featherOct - logF) / featherOct);
          if (fIn <= 0) continue;
          const g = 1 + (e.gainLin - 1) * tIn * fIn;
          // Real-signal FFT symmetry: mirror bins move conjugately.
          re[bin] *= g;
          im[bin] *= g;
          re[fftSize - bin] *= g;
          im[fftSize - bin] *= g;
        }
      }
      fftInPlace(re, im, true);
      for (let i = 0; i < fftSize; i++) {
        const idx = base + i;
        if (idx >= n) break;
        const w = win[i];
        out[idx] += re[i] * w;
        winSum[idx] += w * w;
      }
    }
    if (base + fftSize >= n) break;
  }

  // WOLA normalization — untouched regions reconstruct exactly. Samples
  // the window never reached (tail) pass through as-is.
  for (let i = 0; i < n; i++) {
    out[i] = winSum[i] > 1e-8 ? out[i] / winSum[i] : input[i];
  }
  return out;
}

function frameTimeCenter(frameStartSec: number, fftSize: number, sampleRate: number): number {
  return frameStartSec + fftSize / 2 / sampleRate;
}

/** Apply one edit list to every channel of a clip (stereo-safe). */
export function applySpectralEditsToChannels(
  channels: Float32Array[],
  sampleRate: number,
  edits: SpectralEdit[],
  opts: SpectralEditOptions = {},
): Float32Array<ArrayBuffer>[] {
  return channels.map((ch) => applySpectralEdits(ch, sampleRate, edits, opts));
}
