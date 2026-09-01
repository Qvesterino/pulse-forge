/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — DSP Primitives (TypeScript Reference)
//
// Self-contained allocation-free building blocks shared by all
// Ultina reference modules. No runtime dependency on the
// audio-engine package.
//
// All classes preallocate during construction/prepare and reuse
// state in process(). No new array allocations on the audio path.
// ═══════════════════════════════════════════════════════════

// ── Math helpers ────────────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number): number {
  return lin <= 1e-12 ? -240 : 20 * Math.log10(lin);
}

export function ampToDb(amp: number): number {
  return amp < 1e-10 ? -200 : 20 * Math.log10(amp);
}

/** Coefficient for a one-pole smoothing filter given a time constant. */
export function smoothCoef(timeConstantMs: number, sampleRate: number): number {
  if (timeConstantMs <= 0) return 1;
  return 1 - Math.exp(-1 / ((timeConstantMs / 1000) * sampleRate));
}

/**
 * Fast tanh approximation — [5/5] Padé approximant.
 *
 * Max error < 0.1% on |x| ≤ 3 (the previous 3rd-order rational form
 * was ~2% off mid-range, which shaped the character paths' harmonics
 * audibly differently from a true tanh). Clamped to ±1 beyond |x| > 3
 * (tanh(3) ≈ 0.995, and the Padé form starts overshooting above ~3.5).
 */
export function fastTanh(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax > 3) return x < 0 ? -1 : 1;
  const x2 = x * x;
  const x4 = x2 * x2;
  return (x * (945 + 105 * x2 + x4)) / (945 + 420 * x2 + 15 * x4);
}

/** Sanitize a sample to prevent NaN/Inf propagation. */
export function sanitizeSample(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x > 32) return 32;
  if (x < -32) return -32;
  return x;
}

// ── One-pole smoother ───────────────────────────────────────

export class OnePoleSmoother {
  private alpha = 1;
  private value = 0;

  setTimeConstant(ms: number, sampleRate: number): void {
    this.alpha = smoothCoef(ms, sampleRate);
  }

  setCoeff(a: number): void {
    this.alpha = a;
  }

  reset(v = 0): void {
    this.value = v;
  }

  process(target: number): number {
    if (!Number.isFinite(target)) return this.value;
    this.value += this.alpha * (target - this.value);
    if (!Number.isFinite(this.value)) this.value = 0;
    return this.value;
  }

  getValue(): number {
    return this.value;
  }
}

// ── Biquad filter ───────────────────────────────────────────

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  coeffs: BiquadCoeffs;
  z1: number[];
  z2: number[];
}

export function createBiquad(channelCount: number): BiquadState {
  return {
    coeffs: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
    z1: new Array(channelCount).fill(0),
    z2: new Array(channelCount).fill(0),
  };
}

export function resetBiquad(bq: BiquadState): void {
  bq.z1.fill(0);
  bq.z2.fill(0);
}

/** Set low-pass coefficients (RBJ cookbook). */
export function setLowPass(
  c: BiquadCoeffs,
  freq: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = ((1 - cosW) / 2) / a0;
  c.b1 = (1 - cosW) / a0;
  c.b2 = ((1 - cosW) / 2) / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

/** Set high-pass coefficients (RBJ cookbook). */
export function setHighPass(
  c: BiquadCoeffs,
  freq: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = ((1 + cosW) / 2) / a0;
  c.b1 = (-(1 + cosW)) / a0;
  c.b2 = ((1 + cosW) / 2) / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

/**
 * Set peaking/bell coefficients (RBJ cookbook).
 *
 * Uses the classic RBJ parametrization (alpha = sin(w0)/(2Q)) where Q
 * is the resonance sharpness — identical to the C++ native core, so a
 * given (freq, gain, Q) produces the same filter in both engines.
 * (The previous octave-bandwidth sinh() variant interpreted Q as
 * bandwidth and could overflow to NaN coefficients at high Q near
 * Nyquist.)
 */
export function setBell(
  c: BiquadCoeffs,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha / A;

  c.b0 = (1 + alpha * A) / a0;
  c.b1 = (-2 * cosW) / a0;
  c.b2 = (1 - alpha * A) / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha / A) / a0;
}

/** Set high-shelf coefficients (RBJ cookbook). */
export function setHighShelf(
  c: BiquadCoeffs,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = (A + 1) - (A - 1) * cosW + 2 * Math.sqrt(A) * alpha;

  c.b0 = (A * ((A + 1) + (A - 1) * cosW + 2 * Math.sqrt(A) * alpha)) / a0;
  c.b1 = (-2 * A * ((A - 1) + (A + 1) * cosW)) / a0;
  c.b2 = (A * ((A + 1) + (A - 1) * cosW - 2 * Math.sqrt(A) * alpha)) / a0;
  c.a1 = (2 * ((A - 1) - (A + 1) * cosW)) / a0;
  c.a2 = ((A + 1) - (A - 1) * cosW - 2 * Math.sqrt(A) * alpha) / a0;
}

/** Set low-shelf coefficients (RBJ cookbook). */
export function setLowShelf(
  c: BiquadCoeffs,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = (A + 1) + (A - 1) * cosW + 2 * Math.sqrt(A) * alpha;

  c.b0 = (A * ((A + 1) - (A - 1) * cosW + 2 * Math.sqrt(A) * alpha)) / a0;
  c.b1 = (2 * A * ((A - 1) - (A + 1) * cosW)) / a0;
  c.b2 = (A * ((A + 1) - (A - 1) * cosW - 2 * Math.sqrt(A) * alpha)) / a0;
  c.a1 = (-2 * ((A - 1) + (A + 1) * cosW)) / a0;
  c.a2 = ((A + 1) + (A - 1) * cosW - 2 * Math.sqrt(A) * alpha) / a0;
}

/** Set notch coefficients (RBJ cookbook). */
export function setNotch(
  c: BiquadCoeffs,
  freq: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = 1 / a0;
  c.b1 = (-2 * cosW) / a0;
  c.b2 = 1 / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

/** Set band-pass coefficients (RBJ cookbook, constant 0 dB peak gain). */
export function setBandPass(
  c: BiquadCoeffs,
  freq: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = alpha / a0;
  c.b1 = 0;
  c.b2 = -alpha / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

/** Set all-pass coefficients (RBJ cookbook). */
export function setAllPass(
  c: BiquadCoeffs,
  freq: number,
  q: number,
  sampleRate: number,
): void {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = (1 - alpha) / a0;
  c.b1 = (-2 * cosW) / a0;
  c.b2 = 1 / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

/**
 * Post-block biquad state guard: if a non-finite sample poisoned the
 * filter state during the block, reset it (O(1) per block instead of
 * a per-sample check inside the hot loop). Output NaN/Inf is handled
 * by the module-output / top-level sanitizers.
 */
function guardBiquadState(z: number[]): boolean {
  for (let ch = 0; ch < z.length; ch++) {
    if (!Number.isFinite(z[ch])) {
      return true;
    }
  }
  return false;
}

/** Process a biquad on interleaved channels (Direct Form II Transposed).
 * Hot path: no per-sample sanitize — the state is guarded once per
 * block and the module/top-level outputs sanitize. */
export function processBiquad(
  bq: BiquadState,
  channels: Float32Array[],
  frameCount: number,
): void {
  const { b0, b1, b2, a1, a2 } = bq.coeffs;
  for (let ch = 0; ch < bq.z1.length && ch < channels.length; ch++) {
    let z1 = bq.z1[ch];
    let z2 = bq.z2[ch];
    const data = channels[ch];
    for (let i = 0; i < frameCount; i++) {
      const x = data[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      data[i] = y;
    }
    bq.z1[ch] = z1;
    bq.z2[ch] = z2;
  }
  if (guardBiquadState(bq.z1) || guardBiquadState(bq.z2)) {
    bq.z1.fill(0);
    bq.z2.fill(0);
  }
}

/** Process a biquad on one channel (Direct Form II Transposed).
 * Hot path: no per-sample sanitize — see processBiquad. */
export function processBiquadChannel(
  bq: BiquadState,
  data: Float32Array,
  ch: number,
  frameCount: number,
): void {
  const { b0, b1, b2, a1, a2 } = bq.coeffs;
  let z1 = bq.z1[ch];
  let z2 = bq.z2[ch];
  for (let i = 0; i < frameCount; i++) {
    const x = data[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    data[i] = y;
  }
  bq.z1[ch] = z1;
  bq.z2[ch] = z2;
  if (!Number.isFinite(z1) || !Number.isFinite(z2)) {
    bq.z1[ch] = 0;
    bq.z2[ch] = 0;
  }
}

// ── Coefficient smoothing (zipper-noise prevention) ─────────

/**
 * Linear-ramp interpolator between biquad coefficient sets.
 *
 * Designing new coefficients while audio flows (knob drag, automation)
 * swaps them instantaneously — an audible click/staircase. The smoother
 * keeps a target set and glides the active coefficients toward it over
 * a short ramp (~10 ms). While settled, the per-sample cost is a single
 * branch.
 *
 * A new target arriving mid-ramp restarts the ramp from wherever the
 * interpolation has reached, so a continuous parameter stream produces
 * a continuous coefficient chase (the classic approach).
 */
export class BiquadCoeffSmoother {
  private readonly from: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private readonly target: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  readonly current: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private rampRemaining = 0;
  private rampLength = 1;

  /** Ramp duration in samples for the given time constant. */
  setTimeConstant(ms: number, sampleRate: number): void {
    this.rampLength = Math.max(1, Math.round((ms / 1000) * sampleRate));
  }

  /** Publish a new target coefficient set and start gliding toward it. */
  setTarget(c: BiquadCoeffs): void {
    this.from.b0 = this.current.b0;
    this.from.b1 = this.current.b1;
    this.from.b2 = this.current.b2;
    this.from.a1 = this.current.a1;
    this.from.a2 = this.current.a2;
    this.target.b0 = c.b0;
    this.target.b1 = c.b1;
    this.target.b2 = c.b2;
    this.target.a1 = c.a1;
    this.target.a2 = c.a2;
    this.rampRemaining = this.rampLength;
  }

  /** Jump straight to the target (reset / hard bypass). */
  snap(): void {
    this.current.b0 = this.target.b0;
    this.current.b1 = this.target.b1;
    this.current.b2 = this.target.b2;
    this.current.a1 = this.target.a1;
    this.current.a2 = this.target.a2;
    this.from.b0 = this.target.b0;
    this.from.b1 = this.target.b1;
    this.from.b2 = this.target.b2;
    this.from.a1 = this.target.a1;
    this.from.a2 = this.target.a2;
    this.rampRemaining = 0;
  }

  /** True while a ramp is in progress. */
  isRamping(): boolean {
    return this.rampRemaining > 0;
  }

  /** Advance the interpolation by one sample (in place on `current`). */
  tick(): BiquadCoeffs {
    if (this.rampRemaining > 0) {
      this.rampRemaining--;
      if (this.rampRemaining === 0) {
        this.current.b0 = this.target.b0;
        this.current.b1 = this.target.b1;
        this.current.b2 = this.target.b2;
        this.current.a1 = this.target.a1;
        this.current.a2 = this.target.a2;
      } else {
        const t = 1 - this.rampRemaining / this.rampLength;
        this.current.b0 = this.from.b0 + (this.target.b0 - this.from.b0) * t;
        this.current.b1 = this.from.b1 + (this.target.b1 - this.from.b1) * t;
        this.current.b2 = this.from.b2 + (this.target.b2 - this.from.b2) * t;
        this.current.a1 = this.from.a1 + (this.target.a1 - this.from.a1) * t;
        this.current.a2 = this.from.a2 + (this.target.a2 - this.from.a2) * t;
      }
    }
    return this.current;
  }
}

/**
 * Process a smoothed biquad over interleaved channels. The coefficient
 * interpolation advances once per SAMPLE (both channels share one
 * trajectory), so the loop is sample-outer / channel-inner.
 */
export function processBiquadSmoothed(
  bq: BiquadState,
  smoother: BiquadCoeffSmoother,
  channels: Float32Array[],
  frameCount: number,
): void {
  const channelCount = Math.min(bq.z1.length, channels.length);
  for (let i = 0; i < frameCount; i++) {
    const c = smoother.tick();
    for (let ch = 0; ch < channelCount; ch++) {
      const data = channels[ch];
      const x = data[i];
      const y = c.b0 * x + bq.z1[ch];
      bq.z1[ch] = c.b1 * x - c.a1 * y + bq.z2[ch];
      bq.z2[ch] = c.b2 * x - c.a2 * y;
      data[i] = y;
    }
  }
  // Hot path: no per-sample sanitize — guard the state once per block.
  if (guardBiquadState(bq.z1) || guardBiquadState(bq.z2)) {
    bq.z1.fill(0);
    bq.z2.fill(0);
  }
}

// ── DC blocker ──────────────────────────────────────────────

export class DCBlocker {
  private xm1: number[] = [];
  private ym1: number[] = [];
  private r = 0.995;

  prepare(channelCount: number): void {
    this.xm1 = new Array(channelCount).fill(0);
    this.ym1 = new Array(channelCount).fill(0);
  }

  reset(): void {
    this.xm1.fill(0);
    this.ym1.fill(0);
  }

  process(channels: Float32Array[], frameCount: number): void {
    for (let ch = 0; ch < this.xm1.length && ch < channels.length; ch++) {
      let xm1 = this.xm1[ch];
      let ym1 = this.ym1[ch];
      const data = channels[ch];
      for (let i = 0; i < frameCount; i++) {
        const x = data[i];
        const y = x - xm1 + this.r * ym1;
        xm1 = x;
        ym1 = y;
        data[i] = sanitizeSample(y);
      }
      this.xm1[ch] = xm1;
      this.ym1[ch] = ym1;
    }
  }
}

// ── Envelope follower ───────────────────────────────────────

export class EnvelopeFollower {
  private envelope = 0;
  private attackCoef = 0;
  private releaseCoef = 0;

  prepare(attackMs: number, releaseMs: number, sampleRate: number): void {
    this.attackCoef = smoothCoef(attackMs, sampleRate);
    this.releaseCoef = smoothCoef(releaseMs, sampleRate);
    this.envelope = 0;
  }

  setAttack(attackMs: number, sampleRate: number): void {
    this.attackCoef = smoothCoef(attackMs, sampleRate);
  }

  setRelease(releaseMs: number, sampleRate: number): void {
    this.releaseCoef = smoothCoef(releaseMs, sampleRate);
  }

  reset(): void {
    this.envelope = 0;
  }

  process(input: number): number {
    // NaN guard: a single non-finite sample would otherwise poison the
    // envelope state permanently (all NaN comparisons are false).
    if (!Number.isFinite(input)) return this.envelope;
    const abs = Math.abs(input);
    const coef = abs > this.envelope ? this.attackCoef : this.releaseCoef;
    this.envelope += coef * (abs - this.envelope);
    if (!Number.isFinite(this.envelope)) this.envelope = 0;
    return this.envelope;
  }

  getEnvelope(): number {
    return this.envelope;
  }
}

// ── RMS detector ────────────────────────────────────────────

export class RmsDetector {
  private sumSq = 0;
  private windowSize = 1;
  private window: number[] = [];
  private writePos = 0;

  prepare(windowMs: number, sampleRate: number): void {
    this.windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
    this.window = new Array(this.windowSize).fill(0);
    this.sumSq = 0;
    this.writePos = 0;
  }

  reset(): void {
    this.sumSq = 0;
    this.window.fill(0);
    this.writePos = 0;
  }

  process(input: number): number {
    // NaN guard: NaN stored into the sliding window would keep
    // re-poisoning sumSq on every rotation (NaN - finite = NaN).
    if (!Number.isFinite(input)) {
      this.sumSq = Math.max(0, this.sumSq);
      return Math.sqrt(this.sumSq / this.windowSize);
    }
    const sq = input * input;
    this.sumSq -= this.window[this.writePos];
    this.window[this.writePos] = sq;
    this.sumSq += sq;
    this.writePos++;
    if (this.writePos >= this.windowSize) {
      this.writePos = 0;
    }
    if (!Number.isFinite(this.sumSq)) this.sumSq = 0;
    return Math.sqrt(Math.max(0, this.sumSq) / this.windowSize);
  }
}

// ── Waveshapers ─────────────────────────────────────────────

/** Soft saturation via cubic. */
export function softClip(x: number, drive: number): number {
  const d = x * drive;
  return d - (d * d * d) / 3;
}

/** Hard clip. */
export function hardClip(x: number, threshold: number): number {
  if (x > threshold) return threshold;
  if (x < -threshold) return -threshold;
  return x;
}

/** Tube-like asymmetric saturation. */
export function tubeSaturation(x: number, drive: number): number {
  const d = x * drive;
  // Asymmetric: positive half saturates sooner
  if (d > 0) return fastTanh(d * 1.2);
  return fastTanh(d * 0.8);
}

/** Tape saturation model. */
export function tapeSaturation(x: number, drive: number): number {
  const d = x * drive;
  return fastTanh(d) * 0.7 + fastTanh(d * 2) * 0.3;
}

/** Warm saturation: blend of tanh and dry. */
export function warmSaturation(x: number, drive: number, amount: number): number {
  const d = x * drive;
  const sat = fastTanh(d);
  return x * (1 - amount) + sat * amount;
}

// ── Mid/Side encode/decode ──────────────────────────────────

const INV_SQRT2 = 1 / Math.SQRT2;

export function encodeMidSide(
  left: Float32Array,
  right: Float32Array,
  frameCount: number,
  midOut: Float32Array,
  sideOut: Float32Array,
): void {
  for (let i = 0; i < frameCount; i++) {
    midOut[i] = (left[i] + right[i]) * INV_SQRT2;
    sideOut[i] = (left[i] - right[i]) * INV_SQRT2;
  }
}

export function decodeMidSide(
  mid: Float32Array,
  side: Float32Array,
  frameCount: number,
  leftOut: Float32Array,
  rightOut: Float32Array,
): void {
  for (let i = 0; i < frameCount; i++) {
    leftOut[i] = (mid[i] + side[i]) * INV_SQRT2;
    rightOut[i] = (mid[i] - side[i]) * INV_SQRT2;
  }
}

// ── FIR (linear-phase) crossover utilities ──────────────────

/**
 * Default FIR tap count for the linear-phase crossover.
 * 63 taps → 31 samples latency (≈ 0.7 ms at 44.1 kHz).
 * Higher = steeper roll-off but more latency and CPU.
 */
export const DEFAULT_FIR_TAPS = 63;

/**
 * FIR filter state: symmetric taps + circular delay line.
 * Designed for per-channel streaming convolution.
 */
export interface FirFilterState {
  /** FIR coefficients (symmetric, odd length). */
  taps: Float32Array;
  /** Circular delay line, sized to `taps.length`. */
  delayLine: Float32Array;
  /** Write position into the circular delay line. */
  writePos: number;
  /** Number of valid taps. */
  length: number;
  /** Group delay in samples = (length - 1) / 2. */
  latency: number;
}

/** Create a FIR filter state preallocated for up to `maxTaps` coefficients. */
export function createFirFilter(maxTaps: number): FirFilterState {
  const len = maxTaps % 2 === 0 ? maxTaps + 1 : maxTaps;
  return {
    taps: new Float32Array(len),
    delayLine: new Float32Array(len),
    writePos: 0,
    length: len,
    latency: (len - 1) / 2,
  };
}

/**
 * Design a windowed-sinc low-pass FIR with a Blackman window.
 *
 * The result is a Type-I linear-phase filter (symmetric, odd length).
 * Group delay = (numTaps - 1) / 2 samples.
 *
 * @param fir    Target FIR state (taps are written in-place).
 * @param freqHz Cutoff frequency (-6 dB point).
 * @param sampleRate
 * @param numTaps  Desired tap count (forced to odd).
 */
export function designLowPassFir(
  fir: FirFilterState,
  freqHz: number,
  sampleRate: number,
  numTaps: number,
): void {
  let N = Math.max(3, numTaps | 0);
  if (N % 2 === 0) N++; // must be odd for Type-I linear phase
  const M = (N - 1) / 2;
  const fc = freqHz / sampleRate; // normalised cutoff

  let sum = 0;
  for (let n = 0; n < N; n++) {
    const k = n - M;
    let h: number;
    if (k === 0) {
      h = 2 * fc; // sinc(0) = 1
    } else {
      h = Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    }
    // Blackman window
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (N - 1));
    fir.taps[n] = h * w;
    sum += fir.taps[n];
  }

  // Normalise to unity DC gain
  if (sum !== 0) {
    for (let n = 0; n < N; n++) fir.taps[n] /= sum;
  }

  fir.length = N;
  fir.latency = M;
}

/** Reset FIR delay line to zero. */
export function resetFirFilter(fir: FirFilterState): void {
  fir.delayLine.fill(0);
  fir.writePos = 0;
}

/**
 * Process one sample through the FIR via circular-buffer convolution.
 * Returns the filtered output (delayed by `fir.latency` samples).
 */
export function processFirSample(fir: FirFilterState, input: number): number {
  const N = fir.length;
  const dl = fir.delayLine;
  const taps = fir.taps;

  dl[fir.writePos] = input;

  let output = 0;
  let readPos = fir.writePos;
  for (let n = 0; n < N; n++) {
    output += taps[n] * dl[readPos];
    readPos--;
    if (readPos < 0) readPos += N;
  }

  fir.writePos++;
  if (fir.writePos >= N) fir.writePos = 0;

  return output;
}

/**
 * Process a block of samples through the FIR filter in-place.
 */
export function processFirBlock(
  fir: FirFilterState,
  data: Float32Array,
  frameCount: number,
): void {
  for (let i = 0; i < frameCount; i++) {
    data[i] = processFirSample(fir, data[i]);
  }
}
