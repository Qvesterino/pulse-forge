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

const SUBBLOCK_SECONDS = 0.1; // 100 ms hop (75 % block overlap)

/**
 * Full K-weighted loudness analysis of rendered channel buffers.
 * BS.1770-4: 400 ms blocks with 100 ms hop, absolute gate −70 LUFS and
 * relative gate −10 LU, evaluated in the power domain.
 */
export function analyzeLoudnessBuffer(channels: readonly Float32Array[], sampleRate: number): LoudnessReading {
  const length = channels.reduce((acc, ch) => Math.min(acc, ch.length), Number.MAX_SAFE_INTEGER);
  const minSamples = Math.ceil(0.4 * sampleRate);
  if (!Number.isFinite(length) || length < minSamples || channels.length === 0) {
    return { integrated: MIN_DB, momentaryMax: MIN_DB, shortTermMax: MIN_DB, measured: false };
  }

  const stages = kWeightingCoefficients(sampleRate);
  const filtered = channels.map((channel) => {
    const filter = new KWeightingFilter(stages);
    const out = new Float64Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = filter.processSample(channel[i]);
    return out;
  });

  const subblock = Math.max(1, Math.round(SUBBLOCK_SECONDS * sampleRate));
  const subPowers: number[] = [];
  for (let start = 0; start + subblock <= length; start += subblock) {
    let sum = 0;
    for (const ch of filtered) {
      let acc = 0;
      for (let i = start; i < start + subblock; i++) acc += ch[i] * ch[i];
      sum += acc / subblock;
    }
    subPowers.push(sum);
  }

  const loudnessOf = (meanSquare: number): number =>
    meanSquare > 1e-12 ? Math.max(-180, -0.691 + 10 * Math.log10(meanSquare)) : -180;

  const blockMeanSquare = (k: number): number =>
    (subPowers[k] + subPowers[k + 1] + subPowers[k + 2] + subPowers[k + 3]) / 4;

  const blocks: number[] = []; // loudness per 400 ms block (4 subblocks)
  for (let k = 0; k + 4 <= subPowers.length; k++) {
    blocks.push(loudnessOf(blockMeanSquare(k)));
  }
  const shortTerm: number[] = []; // loudness per 3 s window (30 subblocks)
  for (let k = 0; k + 30 <= subPowers.length; k++) {
    let acc = 0;
    for (let j = k; j < k + 30; j++) acc += subPowers[j];
    shortTerm.push(loudnessOf(acc / 30));
  }
  if (blocks.length === 0) {
    return { integrated: MIN_DB, momentaryMax: MIN_DB, shortTermMax: MIN_DB, measured: false };
  }

  // Dual gate: absolute −70 LUFS, then relative −10 LU (power domain).
  const blockEntries = blocks.map((loudness, index) => ({ loudness, ms: blockMeanSquare(index) }));
  const audible = blockEntries.filter((entry) => entry.loudness > -70);
  let integrated = MIN_DB;
  if (audible.length > 0) {
    const ungatedMean = audible.reduce((acc, entry) => acc + entry.ms, 0) / audible.length;
    const relativeGate = -0.691 + 10 * Math.log10(ungatedMean) - 10;
    const gateFloor = Math.max(-70, relativeGate);
    const gated = audible.filter((entry) => entry.loudness >= gateFloor);
    if (gated.length > 0) {
      const gatedMean = gated.reduce((acc, entry) => acc + entry.ms, 0) / gated.length;
      integrated = loudnessOf(gatedMean);
    }
  }

  return {
    integrated,
    momentaryMax: Math.max(...blocks),
    shortTermMax: shortTerm.length > 0 ? Math.max(...shortTerm) : Math.max(...blocks),
    measured: true,
  };
}
