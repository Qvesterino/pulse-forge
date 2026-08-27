/**
 * Live audio metering primitives. All helpers are pure and analyser-friendly so
 * they can be reused by the master/track/return meters and by the offline
 * renderer for export summaries.
 *
 * Conventions:
 *  - peak amplitude in linear [0..1] (full-scale = 1.0)
 *  - dBFS via `toDb(linear)`, clamped to -120..+6
 *  - RMS over a frame for momentary loudness
 *  - stereo correlation ∈ [-1, +1]: +1 = mono-compatible, < 0 = phase issues
 *  - peak hold with linear decay per poll
 */

import { analyzeLoudnessBuffer } from "./kweighting";

export const MIN_DB = -120;
export const MAX_DB = 6;

export function toDb(linear: number): number {
  const v = Math.abs(linear);
  if (!Number.isFinite(v) || v <= 0) return MIN_DB;
  const db = 20 * Math.log10(v);
  if (db > MAX_DB) return MAX_DB;
  if (db < MIN_DB) return MIN_DB;
  return db;
}

export function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/** Approximate BS.1770 loudness from a stereo window (K-weighting is omitted
 * for the lightweight live path; the same calibration is used offline). */
export function lufsFromChannels(left: Float32Array, right: Float32Array = left): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return MIN_DB;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += (left[i] * left[i] + right[i] * right[i]) * 0.5;
  return energy <= 1e-12 ? MIN_DB : Math.max(MIN_DB, -0.691 + 10 * Math.log10(energy / n));
}

/** EBU-style relative-gated integrated loudness from 400 ms block readings. */
export function integratedLufs(blocks: number[]): number {
  const valid = blocks.filter((value) => Number.isFinite(value) && value > -70);
  if (valid.length === 0) return MIN_DB;
  const ungated = valid.reduce((sum, value) => sum + Math.pow(10, (value + 0.691) / 10), 0) / valid.length;
  const relativeGate = -0.691 + 10 * Math.log10(Math.max(1e-12, ungated)) - 10;
  const gated = valid.filter((value) => value >= Math.max(-70, relativeGate));
  if (gated.length === 0) return MIN_DB;
  const energy = gated.reduce((sum, value) => sum + Math.pow(10, (value + 0.691) / 10), 0) / gated.length;
  return Math.max(MIN_DB, -0.691 + 10 * Math.log10(Math.max(1e-12, energy)));
}

/** Stereo fold-down level relative to the stereo RMS level. */
export function monoLossDb(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 0;
  let stereo = 0;
  let mono = 0;
  for (let i = 0; i < n; i++) {
    stereo += (left[i] * left[i] + right[i] * right[i]) * 0.5;
    const m = (left[i] + right[i]) * 0.5;
    mono += m * m;
  }
  if (stereo <= 1e-12) return 0;
  return toDb(Math.sqrt(mono / stereo));
}

export interface MixCheckSnapshot {
  truePeakDb: number;
  correlation: number;
  monoLossDb: number;
  lrImbalanceDb: number;
  phaseDurationMs?: number;
  imbalanceDurationMs?: number;
}

export interface MixCheckWarning {
  code: "true-peak" | "clipping" | "phase" | "mono-loss" | "lr-imbalance";
  message: string;
  severity: "warn" | "error";
}

export function evaluateMixCheck(snapshot: MixCheckSnapshot): MixCheckWarning[] {
  const warnings: MixCheckWarning[] = [];
  if (snapshot.truePeakDb > -0.1) warnings.push({ code: "clipping", message: "True peak is clipping above -0.1 dBTP", severity: "error" });
  else if (snapshot.truePeakDb > -1) warnings.push({ code: "true-peak", message: "True peak is above -1 dBTP", severity: "warn" });
  if (snapshot.correlation < 0 && (snapshot.phaseDurationMs ?? 0) >= 250) warnings.push({ code: "phase", message: "Stereo correlation is negative", severity: "warn" });
  if (snapshot.monoLossDb < -3) warnings.push({ code: "mono-loss", message: "Mono fold-down loses more than 3 dB", severity: "warn" });
  if (snapshot.lrImbalanceDb > 6 && (snapshot.imbalanceDurationMs ?? 0) >= 1000) warnings.push({ code: "lr-imbalance", message: "Left/right balance differs by more than 6 dB", severity: "warn" });
  return warnings;
}

/** Channel-interleaved linear frame (L, R, L, R, …). */
export type Frame = Float32Array<ArrayBuffer>;

export interface ChannelLevels {
  /** Linear peak [0..1] (post-clipping safety). */
  peak: number;
  /** Linear RMS [0..1]. */
  rms: number;
  /** Peak in dBFS. */
  peakDb: number;
  /** RMS in dBFS. */
  rmsDb: number;
}

export function emptyLevels(): ChannelLevels {
  return { peak: 0, rms: 0, peakDb: MIN_DB, rmsDb: MIN_DB };
}

/** Split an interleaved frame into separate left/right channel arrays. */
export function splitChannels(frame: Frame, channels: number): Float32Array<ArrayBuffer>[] {
  if (channels <= 1) return [frame as Float32Array<ArrayBuffer>];
  const length = Math.floor(frame.length / channels);
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) {
    const slice = new Float32Array(length);
    for (let i = 0; i < length; i++) slice[i] = frame[i * channels + c];
    out.push(slice);
  }
  return out;
}

/** Peak + RMS over a single channel. */
export function channelLevels(channel: Float32Array): ChannelLevels {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < channel.length; i++) {
    const v = Math.abs(channel[i]);
    if (v > peak) peak = v;
    sumSq += channel[i] * channel[i];
  }
  const rms = channel.length > 0 ? Math.sqrt(sumSq / channel.length) : 0;
  return { peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms) };
}

/**
 * Stereo correlation ∈ [-1, +1] from two equal-length channels. Uses the
 * standard Pearson formula on the recent frame. Returns 1 for true mono.
 */
export function stereoCorrelation(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 1;
  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < n; i++) {
    sumL += left[i];
    sumR += right[i];
  }
  const meanL = sumL / n;
  const meanR = sumR / n;
  let num = 0;
  let denL = 0;
  let denR = 0;
  for (let i = 0; i < n; i++) {
    const dl = left[i] - meanL;
    const dr = right[i] - meanR;
    num += dl * dr;
    denL += dl * dl;
    denR += dr * dr;
  }
  if (denL === 0 || denR === 0) return 1;
  return Math.max(-1, Math.min(1, num / Math.sqrt(denL * denR)));
}

/**
 * Peak-hold with linear decay per poll. The "true peak" reading tracks the
 * largest peak observed since the last reset (or implicit last decay window),
 * then drops at `decayPerPoll` dB per poll. Decay rate is set so the displayed
 * value falls ~10 dB over ~1 second at a 30 Hz poll rate.
 */
export class PeakHold {
  private value = MIN_DB;
  constructor(private decayPerPoll = 0.33) {}

  push(peakDb: number): number {
    if (peakDb > this.value) {
      this.value = peakDb;
    } else {
      this.value = Math.max(MIN_DB, this.value - this.decayPerPoll);
    }
    return this.value;
  }

  reset(): void {
    this.value = MIN_DB;
  }

  get current(): number {
    return this.value;
  }
}

/**
 * Read interleaved audio data from an AnalyserNode into a buffer. Handles
 * channelCount via `getFloatTimeDomainData` (which produces interleaved data
 * when channelCount > 1).
 */
export function readAnalyserFrame(analyser: AnalyserNode, target: Frame): void {
  analyser.getFloatTimeDomainData(target);
}

export interface BufferSummary {
  /** Linear peak [0..1] across the whole buffer. */
  peak: number;
  /** Peak in dBFS. */
  peakDb: number;
  /** True peak estimate (4×-style oversampled search) in dBFS. */
  truePeakDb: number;
  /** Linear RMS [0..1]. */
  rms: number;
  /** RMS in dBFS. */
  rmsDb: number;
  /** Stereo correlation [-1, +1]; 1 for mono source. */
  correlation: number;
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  monoLossDb: number;
}

const EMPTY_SUMMARY: BufferSummary = { peak: 0, peakDb: MIN_DB, truePeakDb: MIN_DB, rms: 0, rmsDb: MIN_DB, correlation: 1, lufsMomentary: MIN_DB, lufsShortTerm: MIN_DB, lufsIntegrated: MIN_DB, monoLossDb: 0 };

/**
 * Whole-buffer summary: peak, true-peak, RMS, and (stereo) correlation. Used
 * by the export panel to surface the master reading for a rendered file.
 */
export function summarizeBuffer(buffer: AudioBuffer): BufferSummary {
  const channels = Math.min(2, buffer.numberOfChannels);
  if (channels <= 0 || buffer.length === 0) return EMPTY_SUMMARY;
  const split: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) split.push(buffer.getChannelData(c) as Float32Array<ArrayBuffer>);

  let peak = 0;
  let sumSq = 0;
  for (const ch of split) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
  }
  const total = split.reduce((acc, ch) => acc + ch.length, 0);
  const rms = total > 0 ? Math.sqrt(sumSq / total) : 0;
  const truePeak = channels >= 1 ? truePeakOversampled(split) : peak;
  const correlation = split.length >= 2 ? stereoCorrelation(split[0], split[1]) : 1;
  const loudness = analyzeLoudnessBuffer(split, buffer.sampleRate);

  return {
    peak,
    peakDb: toDb(peak),
    truePeakDb: toDb(truePeak),
    rms,
    rmsDb: toDb(rms),
    correlation,
    lufsMomentary: loudness.measured ? loudness.momentaryMax : MIN_DB,
    lufsShortTerm: loudness.measured ? loudness.shortTermMax : MIN_DB,
    lufsIntegrated: loudness.measured ? loudness.integrated : MIN_DB,
    monoLossDb: split.length >= 2 ? monoLossDb(split[0], split[1]) : 0,
  };
}

/**
 * True-peak via 4× polyphase oversampling (ITU BS.1770 style): each input
 * sample is zero-stuffed ×4 and low-passed with a windowed-sinc prototype
 * (decomposed into 4 phases of 16 taps, DC-normalized). Catches intersample
 * peaks — the classic fs/4 sine at 45° phase reads ~+3 dB over sample peak,
 * which the old parabolic estimate could not see.
 */
const TP_PHASES = 4;
const TP_TAPS_PER_PHASE = 16;

const TRUE_PEAK_FILTER: Float32Array[] = (() => {
  const prototype = new Float64Array(TP_PHASES * TP_TAPS_PER_PHASE);
  const center = (prototype.length - 1) / 2;
  for (let n = 0; n < prototype.length; n++) {
    const x = (n - center) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Blackman window for clean stopband.
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (prototype.length - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (prototype.length - 1));
    prototype[n] = sinc * w;
  }
  const phases: Float32Array[] = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const taps = new Float32Array(TP_TAPS_PER_PHASE);
    let sum = 0;
    for (let j = 0; j < TP_TAPS_PER_PHASE; j++) {
      taps[j] = prototype[j * TP_PHASES + p];
      sum += taps[j];
    }
    for (let j = 0; j < TP_TAPS_PER_PHASE; j++) taps[j] /= sum; // DC gain = 1
    phases.push(taps);
  }
  return phases;
})();

export function truePeakOversampled(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let p = 0; p < TP_PHASES; p++) {
      const taps = TRUE_PEAK_FILTER[p];
      let phasePeak = 0;
      for (let i = 0; i < ch.length; i++) {
        let acc = 0;
        const base = i + 1 - TP_TAPS_PER_PHASE;
        for (let j = 0; j < TP_TAPS_PER_PHASE; j++) {
          const idx = base + j;
          if (idx >= 0 && idx < ch.length) acc += ch[idx] * taps[j];
        }
        const v = acc < 0 ? -acc : acc;
        if (v > phasePeak) phasePeak = v;
      }
      if (phasePeak > peak) peak = phasePeak;
    }
  }
  return peak;
}
