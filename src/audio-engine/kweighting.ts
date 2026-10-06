import { MIN_DB } from "./metering";

/**
 * ITU-R BS.1770-4 K-weighting and loudness math — PURE, shared by the offline
 * analyzer (summarizeBuffer/exports), the unit tests (spec vectors) and the
 * kwmeter worklet wrapper (coefficients shipped to the audio thread via
 * processorOptions, so the raw-JS processor carries no duplicated math).
 *
 * Two cascaded biquads per channel:
 *   1) high shelf (f0 ≈ 1682 Hz, +4 dB)              — "head" stage
 *   2) high pass  (f0 ≈ 38.1 Hz, Q ≈ 0.5)            — "RLB" stage
 * Coefficients are recomputed for the actual sample rate from the analog
 * prototype (reference: ebur128 reference implementation).
 */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function kWeightingCoefficients(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  const fs = Math.max(16000, sampleRate);

  // Stage 1 — high shelf (+4 dB head).
  const shelfF0 = 1681.974450955533;
  const shelfGainDb = 3.9998438539736248;
  const shelfQ = 0.7071752369554196;
  const ks = Math.tan((Math.PI * shelfF0) / fs);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + ks / shelfQ + ks * ks;

  // Stage 2 — RLB high pass.
  const hpF0 = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const kh = Math.tan((Math.PI * hpF0) / fs);
  const hpA0 = 1 + kh / hpQ + kh * kh;

  const shelf: BiquadCoefficients = {
    b0: (vh + (vb * ks) / shelfQ + ks * ks) / shelfA0,
    b1: (2 * (ks * ks - vh)) / shelfA0,
    b2: (vh - (vb * ks) / shelfQ + ks * ks) / shelfA0,
    a1: (2 * (ks * ks - 1)) / shelfA0,
    a2: (1 - ks / shelfQ + ks * ks) / shelfA0,
  };
  const highPass: BiquadCoefficients = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (kh * kh - 1)) / hpA0,
    a2: (1 - kh / hpQ + kh * kh) / hpA0,
  };
  return [shelf, highPass];
}

/** Two-stage K-weighting biquad chain with per-instance state. */
export class KWeightingFilter {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private u1 = 0;
  private u2 = 0;
  private w1 = 0;
  private w2 = 0;

  constructor(private stages: readonly [BiquadCoefficients, BiquadCoefficients]) {}

  processSample(input: number): number {
    const s1 = this.stages[0];
    const shelf = s1.b0 * input + s1.b1 * this.x1 + s1.b2 * this.x2 - s1.a1 * this.y1 - s1.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = shelf;

    const s2 = this.stages[1];
    const hp = s2.b0 * shelf + s2.b1 * this.u1 + s2.b2 * this.u2 - s2.a1 * this.w1 - s2.a2 * this.w2;
    this.u2 = this.u1;
    this.u1 = shelf;
    this.w2 = this.w1;
    this.w1 = hp;
    return hp;
  }

  clone(): KWeightingFilter {
    const copy = new KWeightingFilter(this.stages);
    copy.x1 = this.x1;
    copy.x2 = this.x2;
    copy.y1 = this.y1;
    copy.y2 = this.y2;
    copy.u1 = this.u1;
    copy.u2 = this.u2;
    copy.w1 = this.w1;
    copy.w2 = this.w2;
    return copy;
  }
}

export interface LoudnessReading {
  /** Gated integrated loudness, LUFS (BS.1770 dual gate). */
  integrated: number;
  /** Highest 400 ms momentary block, LUFS. */
  momentaryMax: number;
  /** Highest 3 s short-term window, LUFS. */
  shortTermMax: number;
  /** False when the material is shorter than one 400 ms block. */
  measured: boolean;
}

export interface LoudnessTimelinePoint {
  /** Center of this display bucket, relative to the beginning of the render. */
  timeSeconds: number;
  /** Lowest 3 s short-term value represented by this bucket. */
  lowLufs: number;
  /** Mean 3 s short-term value represented by this bucket. */
  meanLufs: number;
  /** Highest 3 s short-term value represented by this bucket. */
  highLufs: number;
}

export interface LoudnessTimeline {
  windowSeconds: 3;
  hopSeconds: number;
  startSeconds: 3;
  durationSeconds: number;
  sourceWindowCount: number;
  /** Downsampled min/mean/max buckets; no more than 1,200 points. */
  points: LoudnessTimelinePoint[];
}

const SUBBLOCK_SECONDS = 0.1; // 100 ms hop (75 % block overlap)
const MAX_LOUDNESS_TIMELINE_POINTS = 1200;

function unmeasuredLoudness(): LoudnessReading {
  return { integrated: MIN_DB, momentaryMax: MIN_DB, shortTermMax: MIN_DB, measured: false };
}

function loudnessFromSubblocks(subPowers: readonly number[]): LoudnessReading {
  const loudnessOf = (meanSquare: number): number =>
    meanSquare > 1e-12 ? Math.max(-180, -0.691 + 10 * Math.log10(meanSquare)) : -180;
  const blockMeanSquare = (index: number): number =>
    ((subPowers[index] ?? 0) +
      (subPowers[index + 1] ?? 0) +
      (subPowers[index + 2] ?? 0) +
      (subPowers[index + 3] ?? 0)) /
    4;
  const blockCount = Math.max(0, subPowers.length - 3);
  if (blockCount === 0) return unmeasuredLoudness();

  let audiblePower = 0;
  let audibleCount = 0;
  let momentaryMax = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < blockCount; index++) {
    const power = blockMeanSquare(index);
    const lufs = loudnessOf(power);
    momentaryMax = Math.max(momentaryMax, lufs);
    if (lufs > -70) {
      audiblePower += power;
      audibleCount++;
    }
  }

  let integrated = MIN_DB;
  if (audibleCount > 0) {
    const ungatedMean = audiblePower / audibleCount;
    const relativeGate = -0.691 + 10 * Math.log10(ungatedMean) - 10;
    const gateFloor = Math.max(-70, relativeGate);
    let gatedPower = 0;
    let gatedCount = 0;
    for (let index = 0; index < blockCount; index++) {
      const power = blockMeanSquare(index);
      if (loudnessOf(power) >= gateFloor) {
        gatedPower += power;
        gatedCount++;
      }
    }
    if (gatedCount > 0) integrated = loudnessOf(gatedPower / gatedCount);
  }

  let shortTermMax = momentaryMax;
  if (subPowers.length >= 30) {
    shortTermMax = Number.NEGATIVE_INFINITY;
    let windowPower = 0;
    for (let offset = 0; offset < 30; offset++) windowPower += subPowers[offset];
    const windowCount = subPowers.length - 29;
    for (let start = 0; start < windowCount; start++) {
      shortTermMax = Math.max(shortTermMax, loudnessOf(windowPower / 30));
      if (start + 30 < subPowers.length) windowPower += subPowers[start + 30] - subPowers[start];
    }
  }
  return { integrated, momentaryMax, shortTermMax, measured: audibleCount > 0 };
}

function shortTermLoudnessFromSubblocks(subPowers: readonly number[]): number[] {
  if (subPowers.length < 30) return [];
  const loudnessOf = (meanSquare: number): number =>
    meanSquare > 1e-12 ? Math.max(-180, -0.691 + 10 * Math.log10(meanSquare)) : -180;
  const shortTerm: number[] = [];
  let windowPower = 0;
  for (let offset = 0; offset < 30; offset++) windowPower += subPowers[offset] ?? 0;
  for (let start = 0; start + 30 <= subPowers.length; start++) {
    shortTerm.push(loudnessOf(windowPower / 30));
    if (start + 30 < subPowers.length) windowPower += (subPowers[start + 30] ?? 0) - (subPowers[start] ?? 0);
  }
  return shortTerm;
}

/** EBU Tech 3342 LRA from 3 s K-weighted windows sampled at 10 Hz. */
function loudnessRangeFromShortTerm(shortTerm: readonly number[]): number | null {
  if (shortTerm.length === 0) return null;
  const absoluteGated = shortTerm.filter((value) => value >= -70);
  if (absoluteGated.length === 0) return null;
  const absoluteGatedMeanPower =
    absoluteGated.reduce((sum, value) => sum + Math.pow(10, value / 10), 0) / absoluteGated.length;
  const relativeGate = 10 * Math.log10(absoluteGatedMeanPower) - 20;
  const gated = absoluteGated.filter((value) => value >= relativeGate).sort((a, b) => a - b);
  if (gated.length === 0) return null;
  const low = gated[Math.round((gated.length - 1) * 0.1)];
  const high = gated[Math.round((gated.length - 1) * 0.95)];
  return low === undefined || high === undefined ? null : Math.max(0, high - low);
}

function loudnessTimelineFromShortTerm(
  shortTerm: readonly number[],
  sourceWindowCount: number,
  durationSeconds: number,
  hopSeconds: number,
): LoudnessTimeline | null {
  const windowCount = Math.min(shortTerm.length, sourceWindowCount);
  if (windowCount === 0) return null;
  const bucketSize = Math.max(1, Math.ceil(windowCount / MAX_LOUDNESS_TIMELINE_POINTS));
  const points: LoudnessTimelinePoint[] = [];
  for (let start = 0; start < windowCount; start += bucketSize) {
    const end = Math.min(windowCount, start + bucketSize);
    let lowLufs = Number.POSITIVE_INFINITY;
    let highLufs = Number.NEGATIVE_INFINITY;
    let sumLufs = 0;
    for (let index = start; index < end; index++) {
      const value = shortTerm[index] ?? -180;
      lowLufs = Math.min(lowLufs, value);
      highLufs = Math.max(highLufs, value);
      sumLufs += value;
    }
    const firstWindowEnd = 3 + start * hopSeconds;
    const lastWindowEnd = 3 + (end - 1) * hopSeconds;
    points.push({
      timeSeconds: Math.min(durationSeconds, (firstWindowEnd + lastWindowEnd) * 0.5),
      lowLufs,
      meanLufs: sumLufs / (end - start),
      highLufs,
    });
  }
  return {
    windowSeconds: 3,
    hopSeconds,
    startSeconds: 3,
    durationSeconds,
    sourceWindowCount: windowCount,
    points,
  };
}

/** Incremental BS.1770 K-weighting state for bounded-memory PCM workers. */
export class KWeightedLoudnessAccumulator {
  private readonly filters: KWeightingFilter[];
  private readonly subblock: number;
  private readonly subPowers: number[] = [];
  private readonly subPowerByChannel: Float64Array;
  private samplesInSubblock = 0;
  private frames = 0;

  constructor(
    private readonly channelCount: number,
    private readonly sampleRate: number,
  ) {
    const stages = kWeightingCoefficients(sampleRate);
    this.filters = Array.from({ length: channelCount }, () => new KWeightingFilter(stages));
    this.subblock = Math.max(1, Math.round(SUBBLOCK_SECONDS * sampleRate));
    this.subPowerByChannel = new Float64Array(channelCount);
  }

  processFrame(samples: ArrayLike<number>): void {
    for (let channel = 0; channel < this.channelCount; channel++) {
      const raw = samples[channel] ?? 0;
      const filtered = this.filters[channel].processSample(Number.isFinite(raw) ? raw : 0);
      this.subPowerByChannel[channel] += filtered * filtered;
    }
    this.samplesInSubblock++;
    this.frames++;
    if (this.samplesInSubblock === this.subblock) {
      let combinedPower = 0;
      for (let channel = 0; channel < this.channelCount; channel++) {
        combinedPower += this.subPowerByChannel[channel] / this.subblock;
        this.subPowerByChannel[channel] = 0;
      }
      this.subPowers.push(combinedPower);
      this.samplesInSubblock = 0;
    }
  }

  finish(): LoudnessReading {
    if (
      !Number.isFinite(this.sampleRate) ||
      this.sampleRate <= 0 ||
      this.channelCount <= 0 ||
      this.frames < Math.ceil(0.4 * this.sampleRate)
    ) {
      return unmeasuredLoudness();
    }
    return loudnessFromSubblocks(this.subPowers);
  }

  /**
   * File-based LRA adds at least 1.5 s of silence so the final sliding
   * 3 s windows can settle. Keep the regular loudness readings based on the
   * unpadded programme and simulate that tail on cloned filters.
   */
  finishWithLoudnessRange(): {
    loudness: LoudnessReading;
    loudnessRangeLu: number | null;
    loudnessTimeline: LoudnessTimeline | null;
  } {
    const loudness = this.finish();
    if (!loudness.measured || this.frames < Math.ceil(3 * this.sampleRate)) {
      return { loudness, loudnessRangeLu: null, loudnessTimeline: null };
    }

    const filters = this.filters.map((filter) => filter.clone());
    const subPowerByChannel = this.subPowerByChannel.slice();
    const subPowers = [...this.subPowers];
    let samplesInSubblock = this.samplesInSubblock;
    const initialBlockPadding = samplesInSubblock > 0 ? this.subblock - samplesInSubblock : 0;
    const paddingFrames = initialBlockPadding + Math.ceil(1.5 * this.sampleRate);
    for (let frame = 0; frame < paddingFrames; frame++) {
      for (let channel = 0; channel < this.channelCount; channel++) {
        const filtered = filters[channel].processSample(0);
        subPowerByChannel[channel] += filtered * filtered;
      }
      samplesInSubblock++;
      if (samplesInSubblock === this.subblock) {
        let combinedPower = 0;
        for (let channel = 0; channel < this.channelCount; channel++) {
          combinedPower += subPowerByChannel[channel] / this.subblock;
          subPowerByChannel[channel] = 0;
        }
        subPowers.push(combinedPower);
        samplesInSubblock = 0;
      }
    }
    const shortTerm = shortTermLoudnessFromSubblocks(subPowers);
    const sourceWindowCount = Math.max(0, this.subPowers.length - 29);
    return {
      loudness,
      loudnessRangeLu: loudnessRangeFromShortTerm(shortTerm),
      loudnessTimeline: loudnessTimelineFromShortTerm(
        shortTerm,
        sourceWindowCount,
        this.frames / this.sampleRate,
        this.subblock / this.sampleRate,
      ),
    };
  }
}

/**
 * Full K-weighted loudness analysis of rendered channel buffers.
 * BS.1770-4: 400 ms blocks with 100 ms hop, absolute gate −70 LUFS and
 * relative gate −10 LU, evaluated in the power domain.
 */
export function analyzeLoudnessBuffer(
  channels: readonly Float32Array[],
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): LoudnessReading {
  // Guard before any arithmetic — a 0/NaN/Infinity sampleRate would make
  // minSamples = 0 and length = MAX_SAFE_INTEGER (via the reduce), which
  // produces a subblock = 1 loop that iterates MAX_SAFE_INTEGER times and
  // returns measured=true with integrated=MIN_DB. The loudness loop would
  // then chase the silence with gain adjustments.
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return unmeasuredLoudness();
  const length = channels.reduce((acc, ch) => Math.min(acc, ch.length), Number.MAX_SAFE_INTEGER);
  const minSamples = Math.ceil(0.4 * sampleRate);
  if (!Number.isFinite(length) || length < minSamples || channels.length === 0) return unmeasuredLoudness();

  const accumulator = new KWeightedLoudnessAccumulator(channels.length, sampleRate);
  const frameSamples = new Float64Array(channels.length);
  const progressStride = 32768;
  onProgress?.(0);
  for (let frame = 0; frame < length; frame++) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++)
      frameSamples[channelIndex] = channels[channelIndex][frame];
    accumulator.processFrame(frameSamples);
    if (frame > 0 && frame % progressStride === 0) onProgress?.(frame / length);
  }
  onProgress?.(1);
  return accumulator.finish();
}

/**
 * Measure only integrated loudness without retaining a full filtered copy of
 * the audio. This is intended for long, offline A/B renders: a few 100 ms
 * block powers are kept instead of one Float64 sample per channel.
 */
export function integratedLufsStreaming(channels: readonly Float32Array[], sampleRate: number): number | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels.length === 0) return null;
  const length = channels[0]?.length ?? 0;
  if (length < Math.ceil(0.4 * sampleRate) || channels.some((channel) => channel.length !== length)) return null;

  const filters = channels.map(() => new KWeightingFilter(kWeightingCoefficients(sampleRate)));
  const subblock = Math.max(1, Math.round(SUBBLOCK_SECONDS * sampleRate));
  const subPowers: number[] = [];
  let subPower = 0;
  let samplesInSubblock = 0;

  for (let frame = 0; frame < length; frame++) {
    let framePower = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const sample = channels[channelIndex]?.[frame] ?? 0;
      const filtered = filters[channelIndex]?.processSample(Number.isFinite(sample) ? sample : 0) ?? 0;
      framePower += filtered * filtered;
    }
    subPower += framePower;
    samplesInSubblock += 1;
    if (samplesInSubblock === subblock) {
      subPowers.push(subPower / subblock);
      subPower = 0;
      samplesInSubblock = 0;
    }
  }

  const blockPowers: number[] = [];
  for (let start = 0; start + 4 <= subPowers.length; start++) {
    const power =
      ((subPowers[start] ?? 0) +
        (subPowers[start + 1] ?? 0) +
        (subPowers[start + 2] ?? 0) +
        (subPowers[start + 3] ?? 0)) /
      4;
    const lufs = power > 1e-12 ? -0.691 + 10 * Math.log10(power) : -180;
    if (lufs > -70) blockPowers.push(power);
  }
  if (blockPowers.length === 0) return null;

  const absoluteMean = blockPowers.reduce((sum, power) => sum + power, 0) / blockPowers.length;
  const relativeGate = -0.691 + 10 * Math.log10(absoluteMean) - 10;
  const gateFloor = Math.max(-70, relativeGate);
  let gatedPower = 0;
  let gatedCount = 0;
  for (const power of blockPowers) {
    const lufs = power > 1e-12 ? -0.691 + 10 * Math.log10(power) : -180;
    if (lufs >= gateFloor) {
      gatedPower += power;
      gatedCount += 1;
    }
  }
  if (gatedCount === 0) return null;
  const meanPower = gatedPower / gatedCount;
  return meanPower > 1e-12 ? -0.691 + 10 * Math.log10(meanPower) : null;
}
