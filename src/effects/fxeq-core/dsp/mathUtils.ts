/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: onePoleHpCoef zero-cutoff passthrough guard.)
// ═══════════════════════════════════════════════════════════
// FXEQ — Math helpers
//
// Small, allocation-free DSP math utilities. Kept dependency-free so
// every module and the crossover engine can import them freely.
// ═══════════════════════════════════════════════════════════

/** Clamp a value to the closed range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Linear interpolation: (1 - t) * a + t * b. `t` not clamped here. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Convert decibels to linear gain. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Convert linear gain to decibels. */
export function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Fast polynomial approximation of tanh, accurate within ~1e-3 over
 * the range [-3, 3]. Used by waveshapers in the hot sample loop.
 * The Padé approximant naturally saturates to ±1 with zero derivative
 * at |x|=3, so the branchless clamp is C1-continuous.
 */
export function fastTanh(x: number): number {
  const x2 = x * x;
  const y = (x * (27 + x2)) / (27 + 9 * x2);
  return y > 1 ? 1 : y < -1 ? -1 : y;
}

/**
 * Hermite 4-point, 3rd-order interpolation for fractional delay reads.
 * Uses the standard Catmull-Rom-style formulation on sample offset `frac`
 * (0..1) between sample [1] and [2] of the provided window [s0,s1,s2,s3].
 */
export function hermiteInterp(s0: number, s1: number, s2: number, s3: number, frac: number): number {
  const c0 = s1;
  const c1 = 0.5 * (s2 - s0);
  const c2 = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3;
  const c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
  const f = frac;
  return ((c3 * f + c2) * f + c1) * f + c0;
}

/**
 * One-pole low-pass coefficient from a cutoff frequency.
 * alpha = 1 - exp(-2*pi*freq/sr)
 */
export function onePoleLpCoef(freqHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * freqHz) / sampleRate);
}

/**
 * One-pole high-pass coefficient from a cutoff frequency.
 * freqHz <= 0 (or non-finite) degrades to 1 — passthrough, no filtering —
 * instead of the NaN that 1/(2π·0) division produces.
 */
export function onePoleHpCoef(freqHz: number, sampleRate: number): number {
  if (!(freqHz > 0)) return 1;
  const rc = 1 / (2 * Math.PI * freqHz);
  const dt = 1 / sampleRate;
  return rc / (rc + dt);
}

/** Default sample rate when none is provided. */
export const DEFAULT_SAMPLE_RATE = 44100;

/** Minimum sane audio sample rate (Hz). */
export const MIN_SAMPLE_RATE = 8000;

/** Maximum supported sample rate (Hz). */
export const MAX_SAMPLE_RATE = 192000;

// ── Sanitization helpers ──────────────────────────────────────

/**
 * Smallest normalised Float32 value. Values below this are subnormal
 * (denormal) and can cause massive CPU overhead on some architectures.
 * In JS all arithmetic is Float64, but Float32Array storage truncates
 * to Float32, so denormals can accumulate in audio state buffers.
 */
export const DENORMAL_THRESHOLD = 1.1754943508222875e-38;

/**
 * Flush a value to zero if it is a subnormal (denormal) Float32.
 * Call this on IIR state variables after each update to prevent
 * denormal accumulation in long-running feedback loops.
 */
export function flushDenormal(x: number): number {
  return Math.abs(x) < DENORMAL_THRESHOLD ? 0 : x;
}

/**
 * Sanitize a single sample: replace NaN/±Infinity with 0.
 * Used at processor boundaries to contain poison values.
 */
export function sanitizeSample(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
