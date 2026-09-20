/**
 * MORPH DYNAMICS — Space stage (reactive ambience + width).
 *
 * Send/return topology: a compact stereo diffusion network (4 damping
 * combs + 2 all-passes per channel, decorrelated delay lengths) fed
 * through a fractional pre-delay. The signature behavior lives here:
 *
 *   Transient ↑ → space send ducked (clear attack)
 *   Transient releases → send blooms back (expanding tail)
 *
 * Safety: comb feedback is hard-bounded (|g| ≤ 0.88 regardless of the
 * decay param), the side channel is high-passed for mono compatibility
 * (low-frequency stereo expansion constrained by design), and all buffers
 * allocate in prepare() only. Delay lengths are NOT power-of-two — wraps
 * use plain compare/adjust, never a mask.
 */

import { EnvelopeFollower, OnePoleHP, tcToCoef } from "./dspUtils.js";

const COMB_COUNT = 4;
// Decorrelated per channel; all < 50 ms so buffers stay compact.
const COMB_MS_L = [23.7, 31.3, 37.1, 43.9];
const COMB_MS_R = [26.3, 29.7, 38.9, 45.1];
const AP_MS = [5.1, 8.3];
const MAX_COMB_GAIN = 0.88;

interface CombState {
  buf: Float32Array;
  write: number;
  dampState: number;
  dampCoef: number;
  gain: number;
}

interface ApState {
  buf: Float32Array;
  write: number;
  g: number;
}

export interface SpaceParams {
  send: number; // 0..1
  predelayMs: number;
  diffusion: number; // 0..1
  decayS: number; // 0.1..5
  damping: number; // 0..1
  width: number; // 0..2
  duck: number; // 0..1 transient-ducking depth
}

export class SpaceStage {
  private sampleRate = 48000;
  private combsL: CombState[] = [];
  private combsR: CombState[] = [];
  private apL: ApState[] = [];
  private apR: ApState[] = [];
  private preBuf = new Float32Array(1);
  private preLen = 1;
  private preWrite = 0;
  private preFrac = 0;
  private preDelayInt = 0;
  private sideHP = new OnePoleHP();
  private sendEnv = new EnvelopeFollower(); // ducked send gain
  private params: SpaceParams = {
    send: 0.25,
    predelayMs: 12,
    diffusion: 0.6,
    decayS: 1.2,
    damping: 0.45,
    width: 1.15,
    duck: 0.5,
  };
  /** True while every recirculating state is at rest (fast-path skip). */
  private tailSilent = true;

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.combsL = COMB_MS_L.map((ms) => this.makeComb(ms));
    this.combsR = COMB_MS_R.map((ms) => this.makeComb(ms));
    this.apL = AP_MS.map((ms) => this.makeAp(ms));
    this.apR = [AP_MS[1] * 1.13, AP_MS[0] * 0.91].map((ms) => this.makeAp(ms));
    this.preLen = Math.max(4, Math.ceil(sampleRate * 0.081)); // 80 ms + frac guard
    this.preBuf = new Float32Array(this.preLen);
    this.preWrite = 0;
    this.sideHP.setFreq(150, sampleRate);
    this.sendEnv.setTimes(0.002, 0.18, sampleRate);
    this.applyParams(this.params);
  }

  private makeComb(ms: number): CombState {
    const len = Math.max(4, Math.ceil((this.sampleRate * ms) / 1000));
    return { buf: new Float32Array(len), write: 0, dampState: 0, dampCoef: 0.3, gain: 0.7 };
  }

  private makeAp(ms: number): ApState {
    const len = Math.max(4, Math.ceil((this.sampleRate * ms) / 1000));
    return { buf: new Float32Array(len), write: 0, g: 0.6 };
  }

  setParams(p: SpaceParams): void {
    this.applyParams(p);
  }

  private applyParams(p: SpaceParams): void {
    this.params = p;
    // Decay → per-comb gain from the t60 relation, hard-bounded for
    // runaway safety (MAX_COMB_GAIN regardless of what decay asks for).
    for (let i = 0; i < COMB_COUNT; i++) {
      const lenSecL = this.combsL[i].buf.length / this.sampleRate;
      this.combsL[i].gain = this.decayGain(p.decayS, lenSecL);
      const lenSecR = this.combsR[i].buf.length / this.sampleRate;
      this.combsR[i].gain = this.decayGain(p.decayS, lenSecR);
      // Damping: HF recirculates less when dark (damping 1 = bright tail).
      const damp = tcToCoef(0.02 + (1 - p.damping) * 0.6, this.sampleRate);
      this.combsL[i].dampCoef = damp;
      this.combsR[i].dampCoef = damp;
    }
    for (const ap of [...this.apL, ...this.apR]) {
      ap.g = 0.35 + p.diffusion * 0.45;
    }
    // Fractional pre-delay: linear interpolation between two integer taps.
    const preSamples = (p.predelayMs * this.sampleRate) / 1000;
    this.preDelayInt = Math.min(this.preLen - 2, Math.floor(preSamples));
    this.preFrac = preSamples - Math.floor(preSamples);
  }

  private decayGain(decayS: number, lenSec: number): number {
    const g = Math.pow(10, (-3 * decayS * lenSec) / (COMB_COUNT * 0.9));
    return Math.min(MAX_COMB_GAIN, Math.max(0, Number.isFinite(g) ? g : 0));
  }

  reset(): void {
    for (const c of [...this.combsL, ...this.combsR]) {
      c.buf.fill(0);
      c.dampState = 0;
      c.write = 0;
    }
    for (const ap of [...this.apL, ...this.apR]) {
      ap.buf.fill(0);
      ap.write = 0;
    }
    this.preBuf.fill(0);
    this.preWrite = 0;
    this.sendEnv.reset();
    this.tailSilent = true;
  }

  /**
   * Process one frame. `transientScore` drives send ducking, `sendMod` is
   * the matrix's reactive send multiplier (scale on the send amount).
   * Returns wet-only ambience ADDED to dry via out (wet-add topology).
   */
  processFrame(l: number, r: number, transientScore: number, sendMod: number, out: { l: number; r: number }): void {
    const p = this.params;
    // Ducked send: a transient pulls the send toward zero, then it blooms
    // back on the follower's release (the signature "clear hit → bloom").
    const target = p.duck > 0.001 ? 1 - p.duck * 0.95 * transientScore : 1;
    const sendGain = this.sendEnv.processAbs(target);

    // Pre-delay: fractional tap on a mono-sum write.
    const mono = 0.5 * (l + r);
    this.preBuf[this.preWrite] = mono;
    let i0 = this.preWrite - this.preDelayInt - 1;
    if (i0 < 0) i0 += this.preLen;
    let i1 = i0 - 1;
    if (i1 < 0) i1 += this.preLen;
    const pre = this.preBuf[i0] * (1 - this.preFrac) + this.preBuf[i1] * this.preFrac;
    this.preWrite += 1;
    if (this.preWrite >= this.preLen) this.preWrite = 0;

    const send = pre * p.send * 1.4 * sendMod * sendGain;
    if (send === 0 && this.tailSilent) {
      out.l = l;
      out.r = r;
      return;
    }

    let wetL = 0;
    let wetR = 0;
    for (let i = 0; i < COMB_COUNT; i++) {
      wetL += this.comb(this.combsL[i], send);
      wetR += this.comb(this.combsR[i], send);
    }
    wetL = this.apSeries(this.apL, wetL) * 0.5;
    wetR = this.apSeries(this.apR, wetR) * 0.5;
    this.tailSilent = send === 0 && Math.abs(wetL) < 1e-9 && Math.abs(wetR) < 1e-9;

    // Width: mid/side on the WET return only; the side channel is HP'd so
    // width never destabilizes the low end (mono-compat by construction).
    const mid = 0.5 * (wetL + wetR);
    const sideRaw = 0.5 * (wetL - wetR);
    const side = this.sideHP.process(sideRaw);
    const w = p.width;
    out.l = l + (mid + side * w) * 0.9;
    out.r = r + (mid - side * w) * 0.9;
  }

  private comb(c: CombState, x: number): number {
    const read = c.buf[c.write];
    // One-pole damping inside the feedback loop.
    c.dampState = read + c.dampCoef * (c.dampState - read);
    c.buf[c.write] = x + c.dampState * c.gain;
    c.write += 1;
    if (c.write >= c.buf.length) c.write = 0;
    return read;
  }

  private apSeries(aps: ApState[], x: number): number {
    let y = x;
    for (const ap of aps) {
      const read = ap.buf[ap.write];
      ap.buf[ap.write] = y - ap.g * read;
      y = read + ap.g * ap.buf[ap.write];
      ap.write += 1;
      if (ap.write >= ap.buf.length) ap.write = 0;
    }
    return y;
  }
}
