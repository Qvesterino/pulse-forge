/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: NaN-safe clamp (NaN degrades to lower bound).)
// ═══════════════════════════════════════════════════════════
// Ozvena — Math helpers
//
// Allocation-free DSP math utilities shared by every module. Mirrors
// FXEQ's mathUtils so the two plugins share a common primitive set.
// ═══════════════════════════════════════════════════════════

export const TAU = 2 * Math.PI;
export const HALF_PI = Math.PI / 2;

/**
 * Clamp `v` to the closed range [min, max].
 *
 * NaN-safe BY CONTRACT: NaN fails both naive comparisons, so the old
 * implementation returned NaN unchanged and one non-finite parameter
 * poisoned every derived coefficient it touched (attack alphas, feedback
 * gains, damper states — the FDN then latched NaN permanently). NaN is
 * never a meaningful audio value, so it degrades to the LOWER bound,
 * which for every parameter in the state tree is the safe/off direction.
 */
export function clamp(v: number, min: number, max: number): number {
  if (!(v >= min)) return min; // also catches NaN
  if (v > max) return max;
  return v;
}

/** Linear interpolation: (1 - t) * a + t * b. `t` is not clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Convert decibels to linear gain. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Convert linear gain to decibels. Returns -Infinity for ≤ 0. */
export function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Smallest power of two >= n (n >= 1). Ring/delay buffers are allocated at
 * power-of-two capacity so the realtime loops can replace `% len` wrap
 * arithmetic with a single `& mask`. Ring read/write distances always stay
 * below the original (non-pow2) length, so values are unaffected.
 * (Reconciled from Pulse Forge vendored drift, 2026-09-05.)
 */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Fast tanh approximation: x*(27+x²)/(27+9x²). Accurate within ~1e-3 over
 * [-3, 3]. Saturates to ±1 outside that range.
 */
export function fastTanh(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax > 3) return x < 0 ? -1 : 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/**
 * Hermite 4-point, 3rd-order (Catmull-Rom) interpolation. Used for
 * fractional-delay reads in Mod Pad and engine smoothers.
 */
export function hermiteInterp(
  s0: number,
  s1: number,
  s2: number,
  s3: number,
  frac: number,
): number {
  const c0 = s1;
  const c1 = 0.5 * (s2 - s0);
  const c2 = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3;
  const c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

/** One-pole low-pass coefficient from cutoff freq + sample rate. */
export function onePoleLpCoef(freqHz: number, sampleRate: number): number {
  return 1 - Math.exp((-TAU * freqHz) / sampleRate);
}

/** One-pole high-pass coefficient from cutoff freq + sample rate. */
export function onePoleHpCoef(freqHz: number, sampleRate: number): number {
  const rc = 1 / (TAU * freqHz);
  const dt = 1 / sampleRate;
  return rc / (rc + dt);
}

// ── Sanitization ────────────────────────────────────────────

export const DENORMAL_THRESHOLD = 1.1754943508222875e-38;

/** Flush subnormals to zero (CPU spike prevention in long feedback loops). */
export function flushDenormal(x: number): number {
  return Math.abs(x) < DENORMAL_THRESHOLD ? 0 : x;
}

/** Replace NaN/±Infinity with 0. Call at processor boundaries. */
export function sanitize(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/** Default sample rate used when none is provided. */
export const DEFAULT_SAMPLE_RATE = 44100;

/** Audio-rate clamps. */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 192000;

// ── Time helpers ───────────────────────────────────────────

/** Convert milliseconds to samples at a given sample rate. */
export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

/** Convert seconds to samples at a given sample rate. */
export function secondsToSamples(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

// ── Tempo-sync helpers ─────────────────────────────────────

/**
 * Beats-per-minute to samples-per-beat at the given sample rate.
 * Used by Pre-Delay tempo sync.
 */
export function beatsToSamples(beats: number, bpm: number, sampleRate: number): number {
  return Math.round((60 / bpm) * beats * sampleRate);
}
