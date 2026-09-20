/**
 * MORPH DYNAMICS — shared DSP primitives.
 *
 * Deterministic, allocation-free after prepare(), sample-rate independent
 * (every coefficient derives from sampleRate), denormal-safe (envelope
 * states flush to zero below ~-400 dBFS instead of decaying into denormal
 * ranges where a single multiply costs 100× on x86 without FTZ).
 */

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (lin: number): number => 20 * Math.log10(Math.max(lin, 1e-12));

/** One-pole time constant (seconds) → per-sample coefficient. */
export function tcToCoef(tcSec: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(tcSec, 1e-4) * sampleRate));
}

/** Peak envelope follower with separate attack/release coefficients. */
export class EnvelopeFollower {
  private aAtk = 0;
  private aRel = 0;
  private state = 0;

  setTimes(attackSec: number, releaseSec: number, sampleRate: number): void {
    this.aAtk = tcToCoef(attackSec, sampleRate);
    this.aRel = tcToCoef(releaseSec, sampleRate);
  }

  process(x: number): number {
    const abs = Math.abs(x);
    const a = abs > this.state ? this.aAtk : this.aRel;
    this.state = abs + a * (this.state - abs);
    this.flush();
    return this.state;
  }

  /** Feed an already-rectified value (e.g. an envelope of a filtered tap). */
  processAbs(abs: number): number {
    const a = abs > this.state ? this.aAtk : this.aRel;
    this.state = abs + a * (this.state - abs);
    this.flush();
    return this.state;
  }

  get value(): number {
    return this.state;
  }

  reset(): void {
    this.state = 0;
  }

  private flush(): void {
    if (this.state < 1e-10) this.state = 0; // denormal guard
  }
}

/** One-pole low-pass. */
export class OnePoleLP {
  private a = 1;
  private state = 0;

  setFreq(hz: number, sampleRate: number): void {
    // Stable first-order coefficient; clamped inside Nyquist.
    const w = Math.min(hz, sampleRate * 0.45);
    this.a = Math.exp(-2 * Math.PI * (w / sampleRate));
  }

  process(x: number): number {
    this.state = x + this.a * (this.state - x);
    // Denormal flush: a decaying state crawling through denormal range
    // costs 100× per multiply on x86 without FTZ and keeps tails "alive"
    // for seconds after silence.
    if (this.state > -1e-20 && this.state < 1e-20) this.state = 0;
    return this.state;
  }

  reset(): void {
    this.state = 0;
  }
}

/** One-pole high-pass (LP complement). */
export class OnePoleHP {
  private lp = new OnePoleLP();

  setFreq(hz: number, sampleRate: number): void {
    this.lp.setFreq(hz, sampleRate);
  }

  process(x: number): number {
    return x - this.lp.process(x);
  }

  reset(): void {
    this.lp.reset();
  }
}

/**
 * Block-rate parameter smoother (one-pole toward a target). Control
 * scalars (stage depths, matrix outputs, PRESSURE curve values) advance
 * once per audio block; a ~10–30 ms TC hides the 2.7 ms quantum stair.
 */
export class BlockSmoother {
  private target: number;
  private value: number;
  private coef = 0;

  constructor(initial = 0, tcSec = 0.02) {
    this.target = initial;
    this.value = initial;
    this.tc = tcSec;
  }

  set tc(tcSec: number) {
    // Coefficient derived per block later — store TC and compute lazily via
    // setSampleRate to avoid a per-block pow when the TC never changes.
    this.tcSeconds = tcSec;
    this.dirty = true;
  }

  private tcSeconds = 0.02;
  private dirty = true;
  private lastSampleRate = 0;

  setSampleRate(sampleRate: number): void {
    if (this.lastSampleRate !== sampleRate) {
      this.lastSampleRate = sampleRate;
      this.dirty = true;
    }
  }

  setTarget(v: number): void {
    this.target = v;
  }

  /** Advance one audio block; returns the smoothed value. */
  tick(): number {
    if (this.dirty) {
      this.coef = tcToCoef(this.tcSeconds, this.lastSampleRate);
      this.dirty = false;
    }
    this.value = this.target + this.coef * (this.value - this.target);
    if (!Number.isFinite(this.value)) this.value = this.target;
    return this.value;
  }

  snap(): void {
    this.value = this.target;
  }

  get current(): number {
    return this.value;
  }
}

/** Cubic soft clip: transparent below t, asymptote at ±1. */
export function softClip(x: number, t: number): number {
  const ax = Math.abs(x);
  if (ax <= t) return x;
  // The cubic segment is defined only over [t, 1]. Without this boundary,
  // hot but valid inputs make its cubic term run away instead of clipping.
  if (ax >= 1) return Math.sign(x);
  const over = (ax - t) / (1 - t);
  const shaped = t + (1 - t) * (over - (over * over * over) / 3) * (3 / 2);
  return Math.sign(x) * Math.min(shaped, 1);
}

/** Clamp to the open interval (−1, 1) — one-pole all-pass coefficients
 * with |c| ≥ 1 are INSTABILITY (a hardening lesson from the FX wave). */
export function clampUnit(x: number): number {
  if (x > 0.999999) return 0.999999;
  if (x < -0.999999) return -0.999999;
  return x;
}

/** Non-finite guard for development + hardening tests. */
export function isFiniteNumber(x: number): boolean {
  return Number.isFinite(x);
}
