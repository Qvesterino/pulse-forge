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

/* ------------------------------------------------------------------ */
/* Noise-region suggestion ("erase noise" preset)                      */
/* ------------------------------------------------------------------ */

/**
 * STFT magnitudes in dB, one Float32Array (fftSize/2 bins) per frame.
 * Shared by the spectrogram painter and the noise suggester so both see
 * identical frames.
 */
export function computeStftDbFrames(mono: Float32Array, fftSize = 2048, hop = 1024): Float32Array<ArrayBuffer>[] {
  const bins = fftSize >> 1;
  if (mono.length < fftSize) return [];
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const frames: Float32Array<ArrayBuffer>[] = [];
  for (let base = 0; base + fftSize <= mono.length; base += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = mono[base + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const frame = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) / (fftSize / 4);
      frame[bin] = mag > 1e-7 ? 20 * Math.log10(mag) : -160;
    }
    frames.push(frame);
  }
  return frames;
}

function percentileOf(values: Float32Array, p: number): number {
  if (values.length === 0) return -160;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export interface NoiseSuggestion {
  startSec: number;
  endSec: number;
  freqLoHz: number;
  freqHiHz: number;
  gainDb: number;
}

export interface NoiseSuggestOptions {
  /** A bin is a noise candidate when its 10th percentile sits above this. Default −75 dB. */
  floorAbsDb?: number;
  /** …and its 90th−10th percentile spread stays below this (no musical peaks). Default 12 dB. */
  flatnessDb?: number;
  /** Smallest usable band width in bins. Default 8. */
  minBins?: number;
  /** Gain of the suggested erase cut. Default −48 dB. */
  gainDb?: number;
}

/**
 * Find the loudest persistent noise band and return a full-time erase
 * region for it. Stationarity heuristic: a bin is "noise" when it is
 * consistently audible (10th percentile above floorAbsDb) AND never rises
 * above its own floor (90th−10th spread below flatnessDb) — musical
 * content spikes, hiss hum and rumble sit flat. The widest reasonable
 * contiguous band with the highest floor wins. Null = nothing persistent
 * found (clean recording or pure silence).
 */
export function suggestNoiseRegionFromFrames(
  frames: Float32Array[],
  sampleRate: number,
  fftSize: number,
  durationSec: number,
  opts: NoiseSuggestOptions = {},
): NoiseSuggestion | null {
  if (frames.length < 4) return null;
  const floorAbsDb = opts.floorAbsDb ?? -75;
  const flatnessDb = opts.flatnessDb ?? 15;
  const minBins = opts.minBins ?? 3;
  const gainDb = opts.gainDb ?? -48;

  const bins = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const T = frames.length;

  // Raw per-bin dB percentiles.
  const rawFloor = new Float32Array(bins);
  const rawPeak = new Float32Array(bins);
  const column = new Float32Array(T);
  for (let bin = 1; bin < bins; bin++) {
    for (let t = 0; t < T; t++) column[t] = frames[t][bin];
    rawFloor[bin] = percentileOf(column, 0.1);
    rawPeak[bin] = percentileOf(column, 0.9);
  }

  // Raw percentiles swing ~15 dB between the 10th and 90th percentile even
  // for pure noise (2-DOF power statistics at short frame counts), which
  // would fail any flatness test. A ±3-bin moving average restores a
  // workable spread (~11 dB) and keeps tone bands local.
  const smoothFloor = new Float32Array(bins);
  const smoothPeak = new Float32Array(bins);
  for (let bin = 1; bin < bins; bin++) {
    let sumFloor = 0;
    let sumPeak = 0;
    let count = 0;
    for (let k = -3; k <= 3; k++) {
      const idx = bin + k;
      if (idx >= 1 && idx < bins) {
        sumFloor += rawFloor[idx];
        sumPeak += rawPeak[idx];
        count++;
      }
    }
    smoothFloor[bin] = sumFloor / count;
    smoothPeak[bin] = sumPeak / count;
  }

  const isNoise = new Uint8Array(bins);
  for (let bin = 1; bin < bins; bin++) {
    isNoise[bin] = smoothFloor[bin] > floorAbsDb && smoothPeak[bin] - smoothFloor[bin] < flatnessDb ? 1 : 0;
  }

  // Group contiguous noise bins (≤4-bin gaps merge — filter ripples).
  const bands: Array<{ from: number; to: number }> = [];
  let from = -1;
  let gap = 0;
  for (let bin = 1; bin < bins; bin++) {
    if (isNoise[bin]) {
      if (from < 0) from = bin;
      gap = 0;
    } else if (from >= 0) {
      gap++;
      if (gap > 4) {
        bands.push({ from, to: bin - gap });
        from = -1;
        gap = 0;
      }
    }
  }
  if (from >= 0) bands.push({ from, to: bins - 1 });

  // The loudest persistent band wins (highest average smoothed floor).
  let best: { from: number; to: number } | null = null;
  let bestScore = -Infinity;
  for (const band of bands) {
    if (band.to - band.from + 1 < minBins) continue;
    let sum = 0;
    for (let bin = band.from; bin <= band.to; bin++) sum += smoothFloor[bin];
    const score = sum / (band.to - band.from + 1);
    if (score > bestScore) {
      bestScore = score;
      best = band;
    }
  }
  if (!best) return null;

  return {
    startSec: 0,
    endSec: Math.max(0.01, durationSec),
    freqLoHz: Math.max(20, best.from * binHz),
    freqHiHz: Math.min(sampleRate / 2, best.to * binHz),
    gainDb,
  };
}

/** Convenience wrapper: STFT + suggestion in one call. */
export function suggestNoiseRegion(
  mono: Float32Array,
  sampleRate: number,
  durationSec: number,
  opts: NoiseSuggestOptions & { fftSize?: number; hop?: number } = {},
): NoiseSuggestion | null {
  const fftSize = opts.fftSize ?? 2048;
  const hop = opts.hop ?? 1024;
  const frames = computeStftDbFrames(mono, fftSize, hop);
  return suggestNoiseRegionFromFrames(frames, sampleRate, fftSize, durationSec, opts);
}
