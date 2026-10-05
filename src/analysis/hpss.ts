/**
 * S0 — HPSS: harmonic–percussive source separation (Fitzgerald 2010),
 * the Tier-1 deterministic stem provider (ADR 0019).
 *
 * STFT → median filter across TIME (harmonic reference) and across
 * FREQUENCY (percussive reference) on the magnitude spectrogram → soft
 * complementary Wiener masks with a margin (the librosa convention) →
 * masked inverse STFT via weighted overlap-add. The harmonic stem is then
 * split by a low-pass into the BASS register; the full harmonic signal is
 * kept too — consumers pick their register.
 *
 * Honest properties, all pinned by tests:
 * - deterministic: same PCM → bit-identical stems (no RNG, no clock);
 * - segment-chunked: long tracks process in bounded segments with context
 *   overlap, so memory stays bounded and chunk seams carry no median bias —
 *   only segment-center samples are written back;
 * - conservative: near-silence yields null (nothing to separate), never
 *   invented content.
 *
 * Tier-1 HONESTY (ADR 0019): these are GUIDE stems — percussion vs tonal
 * with bleed where content overlaps spectrally. Nothing here may be
 * presented to the user as neural-separation quality.
 */
import { ReferenceFft } from "../reference/dsp/fft";
import { hannWindow } from "../reference/dsp/window";
import { applyLowPass } from "../reference/analysis/bass";

export interface HpssStems {
  percussive: Float32Array;
  harmonic: Float32Array;
  /** Low-passed harmonic register (≤ 250 Hz) — the bass lane's input. */
  bass: Float32Array;
  sampleRate: number;
  /** Seconds actually processed (after the analysis cap). */
  analyzedSec: number;
}

export interface HpssOptions {
  /** Soft-mask margin (>1 = harder assignment; librosa convention). */
  margin?: number;
  /** Analysis cap in seconds (default 120). */
  maxSeconds?: number;
  /** Segment length in seconds for bounded memory (default 16). */
  segmentSec?: number;
}

const FFT_SIZE = 2048;
const HOP = 512;
/** Median window across time (frames) for the harmonic reference — ~360 ms
 * at the 11.6 ms frame rate: longer than any drum decay, shorter than notes. */
const HARMONIC_FRAMES = 31;
/** Median window across frequency (bins) for the percussive reference —
 * ~173 Hz at 44.1 kHz: wide enough to bridge a harmonic's gaps, narrow
 * enough to follow a kick's broadband burst. */
const PERCUSSIVE_BINS = 17;
const DEFAULT_MARGIN = 1.5;
const BASS_SPLIT_HZ = 250;
const DEFAULT_SEGMENT_SEC = 16;

function inverseTransform(fft: ReferenceFft, re: Float64Array, im: Float64Array): void {
  // ifft(x) = conj(fft(conj(x))) / N
  for (let i = 0; i < fft.size; i++) im[i] = -im[i];
  fft.transform(re, im);
  for (let i = 0; i < fft.size; i++) {
    re[i] /= fft.size;
    im[i] /= fft.size;
  }
}

/** Median of a clamped window around `index` (edge-replicated) using a
 * caller-owned scratch buffer — no per-call allocation. */
function windowMedian(column: Float64Array, scratch: number[], index: number, half: number): number {
  const from = Math.max(0, index - half);
  const to = Math.min(column.length - 1, index + half);
  let count = 0;
  for (let i = from; i <= to; i++) scratch[count++] = column[i];
  const window = scratch.slice(0, count).sort((a, b) => a - b);
  return window[Math.floor(count / 2)];
}

interface SegmentSpectra {
  frameCount: number;
  bins: number;
  re: Float64Array;
  im: Float64Array;
  mag: Float32Array;
  maskH: Float32Array;
  maskP: Float32Array;
}

/** Forward STFT of one segment (complex Hermitian half + magnitudes). */
function forwardStft(segment: Float32Array, win: Float64Array, fft: ReferenceFft): SegmentSpectra {
  const bins = FFT_SIZE / 2 + 1;
  const frameCount = Math.max(1, Math.floor((segment.length - FFT_SIZE) / HOP) + 1);
  const re = new Float64Array(frameCount * bins);
  const im = new Float64Array(frameCount * bins);
  const mag = new Float32Array(frameCount * bins);
  const bufRe = new Float64Array(FFT_SIZE);
  const bufIm = new Float64Array(FFT_SIZE);
  for (let t = 0; t < frameCount; t++) {
    const start = t * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      bufRe[i] = (start + i < segment.length ? segment[start + i] : 0) * win[i];
      bufIm[i] = 0;
    }
    fft.transform(bufRe, bufIm);
    for (let b = 0; b < bins; b++) {
      const index = t * bins + b;
      re[index] = bufRe[b];
      im[index] = bufIm[b];
      mag[index] = Math.sqrt(bufRe[b] * bufRe[b] + bufIm[b] * bufIm[b]);
    }
  }
  return {
    frameCount,
    bins,
    re,
    im,
    mag,
    maskH: new Float32Array(mag.length),
    maskP: new Float32Array(mag.length),
  };
}

/** Soft complementary Wiener masks from the two median references.
 * maskH = H²/(H² + margin·P²), maskP = 1 − maskH — they sum to 1, so the
 * two stems add back to the original up to windowing. */
function computeMasks(spectra: SegmentSpectra, margin: number): void {
  const { frameCount, bins, mag } = spectra;
  const maskH = new Float32Array(mag.length);
  const maskP = new Float32Array(mag.length);
  const eps = 1e-12;

  // Harmonic reference: median across TIME for every frequency bin.
  const timeHalf = (HARMONIC_FRAMES - 1) / 2;
  const column = new Float64Array(frameCount);
  const timeScratch: number[] = new Array(HARMONIC_FRAMES);
  const harmonicRef = new Float32Array(mag.length);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frameCount; t++) column[t] = mag[t * bins + b];
    for (let t = 0; t < frameCount; t++) harmonicRef[t * bins + b] = windowMedian(column, timeScratch, t, timeHalf);
  }

  // Percussive reference: median across FREQUENCY for every frame.
  const freqHalf = (PERCUSSIVE_BINS - 1) / 2;
  const rowScratch: number[] = new Array(PERCUSSIVE_BINS);
  for (let t = 0; t < frameCount; t++) {
    const rowFrom = t * bins;
    const row = mag.subarray(rowFrom, rowFrom + bins);
    for (let b = 0; b < bins; b++) {
      const percussive = windowMedian(row as unknown as Float64Array, rowScratch, b, freqHalf);
      const h = harmonicRef[rowFrom + b];
      const p = percussive;
      const denom = h * h + margin * p * p + eps;
      const mh = (h * h) / denom;
      maskH[rowFrom + b] = mh;
      maskP[rowFrom + b] = 1 - mh;
    }
  }
  spectra.maskH = maskH;
  spectra.maskP = maskP;
}

/** Weighted overlap-add resynthesis of one masked stem. */
function resynthesize(spectra: SegmentSpectra, mask: Float32Array, win: Float64Array, fft: ReferenceFft): Float32Array {
  const { frameCount, bins, re, im } = spectra;
  const length = (frameCount - 1) * HOP + FFT_SIZE;
  const out = new Float64Array(length);
  const norm = new Float64Array(length);
  const bufRe = new Float64Array(FFT_SIZE);
  const bufIm = new Float64Array(FFT_SIZE);
  for (let t = 0; t < frameCount; t++) {
    for (let b = 0; b < bins; b++) {
      const scaled = mask[t * bins + b];
      bufRe[b] = re[t * bins + b] * scaled;
      bufIm[b] = im[t * bins + b] * scaled;
    }
    // Rebuild the Hermitian half (bins 1..N/2-1 mirror; DC and Nyquist real).
    for (let b = 1; b < FFT_SIZE / 2; b++) {
      bufRe[FFT_SIZE - b] = bufRe[b];
      bufIm[FFT_SIZE - b] = -bufIm[b];
    }
    bufIm[0] = 0;
    bufIm[FFT_SIZE / 2] = 0;
    inverseTransform(fft, bufRe, bufIm);
    const start = t * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      out[start + i] += bufRe[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) result[i] = norm[i] > 1e-9 ? out[i] / norm[i] : 0;
  return result;
}

/** Full RMS of a signal (the silence gate). */
function signalRms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

export function separateHPSS(pcm: Float32Array, sampleRate: number, options: HpssOptions = {}): HpssStems | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 120;
  const total = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  if (total < sampleRate) return null; // under a second — nothing to separate
  if (signalRms(pcm.subarray(0, total)) < 1e-5) return null;

  const margin = options.margin ?? DEFAULT_MARGIN;
  const segmentSec = options.segmentSec ?? DEFAULT_SEGMENT_SEC;
  const segmentSamples = Math.max(FFT_SIZE * 2, Math.floor(segmentSec * sampleRate));
  const contextSamples = ((HARMONIC_FRAMES >> 1) + 2) * HOP;

  const win = hannWindow(FFT_SIZE);
  const fft = new ReferenceFft(FFT_SIZE);
  const percussive = new Float32Array(total);
  const harmonic = new Float32Array(total);

  for (let segmentStart = 0; segmentStart < total; segmentStart += segmentSamples) {
    const centerFrom = segmentStart;
    const centerTo = Math.min(total, segmentStart + segmentSamples);
    const extFrom = Math.max(0, centerFrom - contextSamples);
    const extTo = Math.min(total, centerTo + contextSamples);

    const spectra = forwardStft(pcm.subarray(extFrom, extTo), win, fft);
    computeMasks(spectra, margin);
    const segmentPercussive = resynthesize(spectra, spectra.maskP, win, fft);
    const segmentHarmonic = resynthesize(spectra, spectra.maskH, win, fft);

    // Write back ONLY the segment center — context exists so the median
    // filters near the seams see their full window. The WOLA output can end
    // a few samples before the segment does (integer frame count); the tail
    // beyond it stays 0 rather than reading past the stem arrays.
    const writeFrom = centerFrom - extFrom;
    const wanted = centerTo - centerFrom;
    const length = Math.min(wanted, segmentPercussive.length - writeFrom);
    for (let i = 0; i < length; i++) {
      percussive[centerFrom + i] = segmentPercussive[writeFrom + i];
      harmonic[centerFrom + i] = segmentHarmonic[writeFrom + i];
    }
  }

  const bass = applyLowPass(harmonic, sampleRate, BASS_SPLIT_HZ);
  return {
    percussive,
    harmonic,
    bass,
    sampleRate,
    analyzedSec: total / sampleRate,
  };
}
