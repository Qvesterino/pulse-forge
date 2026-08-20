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
}

const EMPTY_SUMMARY: BufferSummary = { peak: 0, peakDb: MIN_DB, truePeakDb: MIN_DB, rms: 0, rmsDb: MIN_DB, correlation: 1 };

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
  const truePeak = channels >= 1 ? interpolatePeak(split) : peak;
  const correlation = split.length >= 2 ? stereoCorrelation(split[0], split[1]) : 1;

  return {
    peak,
    peakDb: toDb(peak),
    truePeakDb: toDb(truePeak),
    rms,
    rmsDb: toDb(rms),
    correlation,
  };
}

/** Parabolic peak interpolation between adjacent samples (4× peak estimate). */
function interpolatePeak(channels: Float32Array<ArrayBuffer>[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 1; i < ch.length - 1; i++) {
      const a = ch[i - 1];
      const b = ch[i];
      const c = ch[i + 1];
      if (b >= a && b >= c) {
        const denom = a - 2 * b + c;
        const delta = denom === 0 ? 0 : ((a - c) * 0.5) / denom;
        const interp = Math.abs(b - 0.25 * (a - c) * delta);
        if (interp > peak) peak = interp;
      }
    }
    if (Math.abs(ch[0]) > peak) peak = Math.abs(ch[0]);
    const last = Math.abs(ch[ch.length - 1]);
    if (last > peak) peak = last;
  }
  return peak;
}
