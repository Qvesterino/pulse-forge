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
// ═══════════════════════════════════════════════════════════
// Ozvena — Biquad filter engine
//
// Direct Form II Transposed biquad with per-channel state. Coefficients
// are computed via the RBJ Audio EQ Cookbook formulas. Biquad is the
// single filter primitive shared by:
//   • Pre EQ (3-band: low shelf, bell, high shelf, plus low-cut/high-cut)
//   • Reverb EQ (same)
//   • Engine per-band crossover (low/high split in plateChamber/hall)
//   • DC-block high-pass at the input
//
// Reference: https://www.musicdsp.org/en/latest/Filters/197-rbj-audio-eq-cookbook.html
// ═══════════════════════════════════════════════════════════

import { clamp, TAU } from "./math.js";

// float32-quantize RBJ coefficients so V8/MSVC cos/sin ULP differences
// cannot seed drift between the TS reference and the native port.
const q32 = (x: number): number => Math.fround(x);

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  coeffs: BiquadCoeffs;
  // Float64 state — float32 state quantization accumulated through
  // resonant rings (~1e-4 after thousands of samples) and diverged from
  // the native double-state mirror. Mirrors ozvena_biquad.h exactly.
  z1: Float64Array;
  z2: Float64Array;
}

/** Create a flat (unity passthrough) biquad for `channelCount` channels. */
export function createBiquad(channelCount: number): BiquadState {
  return {
    coeffs: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
    z1: new Float64Array(channelCount),
    z2: new Float64Array(channelCount),
  };
}

/** Reset biquad to flat coefficients and clear state. */
export function setFlat(bq: BiquadState): void {
  bq.coeffs.b0 = 1;
  bq.coeffs.b1 = 0;
  bq.coeffs.b2 = 0;
  bq.coeffs.a1 = 0;
  bq.coeffs.a2 = 0;
  bq.z1.fill(0);
  bq.z2.fill(0);
}

/** Clear filter state without changing coefficients. */
export function resetBiquad(bq: BiquadState): void {
  bq.z1.fill(0);
  bq.z2.fill(0);
}

function w0(freq: number, sampleRate: number): number {
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  return (TAU * f) / sampleRate;
}

// ── RBJ Cookbook coefficient setters ──────────────────────────

export function setLowPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;
  c.b0 = q32((1 - cosW) / 2 / a0);
  c.b1 = q32((1 - cosW) / a0);
  c.b2 = q32((1 - cosW) / 2 / a0);
  c.a1 = q32((-2 * cosW) / a0);
  c.a2 = q32((1 - alpha) / a0);
}

export function setHighPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;
  c.b0 = q32((1 + cosW) / 2 / a0);
  c.b1 = q32(-(1 + cosW) / a0);
  c.b2 = q32((1 + cosW) / 2 / a0);
  c.a1 = q32((-2 * cosW) / a0);
  c.a2 = q32((1 - alpha) / a0);
}

export function setBell(c: BiquadCoeffs, freq: number, q: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha / A;
  c.b0 = q32((1 + alpha * A) / a0);
  c.b1 = q32((-2 * cosW) / a0);
  c.b2 = q32((1 - alpha * A) / a0);
  c.a1 = q32((-2 * cosW) / a0);
  c.a2 = q32((1 - alpha / A) / a0);
}

export function setLowShelf(c: BiquadCoeffs, freq: number, q: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const beta = Math.sqrt(A) / q;
  const a0 = A + 1 + (A - 1) * cosW + beta * sinW;
  c.b0 = q32((A * (A + 1 - (A - 1) * cosW + beta * sinW)) / a0);
  c.b1 = q32((2 * A * (A - 1 - (A + 1) * cosW)) / a0);
  c.b2 = q32((A * (A + 1 - (A - 1) * cosW - beta * sinW)) / a0);
  c.a1 = q32((-2 * (A - 1 + (A + 1) * cosW)) / a0);
  c.a2 = q32((A + 1 + (A - 1) * cosW - beta * sinW) / a0);
}

export function setHighShelf(c: BiquadCoeffs, freq: number, q: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const beta = Math.sqrt(A) / q;
  const a0 = A + 1 - (A - 1) * cosW + beta * sinW;
  c.b0 = q32((A * (A + 1 + (A - 1) * cosW + beta * sinW)) / a0);
  c.b1 = q32((-2 * A * (A - 1 + (A + 1) * cosW)) / a0);
  c.b2 = q32((A * (A + 1 + (A - 1) * cosW - beta * sinW)) / a0);
  c.a1 = q32((2 * (A - 1 - (A + 1) * cosW)) / a0);
  c.a2 = q32((A + 1 - (A - 1) * cosW - beta * sinW) / a0);
}

export function setAllPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;
  c.b0 = q32((1 - alpha) / a0);
  c.b1 = q32((-2 * cosW) / a0);
  c.b2 = q32((1 + alpha) / a0);
  c.a1 = q32((-2 * cosW) / a0);
  c.a2 = q32((1 - alpha) / a0);
}

// ── 1st-order high-pass (used for DC blocker — 15 Hz default) ─

export function setDcBlock(c: BiquadCoeffs, sampleRate: number, cutoffHz = 15): void {
  // Single-pole HP: y[n] = x[n] - x[n-1] + α*y[n-1]
  // where α = exp(-2π·fc/sr)
  const alpha = Math.exp((-TAU * cutoffHz) / sampleRate);
  // Reuse the biquad structure with zero b1/b2:
  // y = b0*x + z1 ; z1 = b1*x - a1*y + z2 ; z2 = b2*x - a2*y
  // Set b0=1, a1=α, a2=0, all else 0:
  //   y = x + z1 ; z1 = -α*y + z2 ; z2 = 0
  // We need y = x - x_prev + α*y_prev. But our form has z1 = -α*y + z2.
  // Setting z2 = prev input: z2 = x[n-1]. Then z1 = b1*x - a1*y + z2 = -α*y + x[n-1].
  // y = b0*x + z1 = x - α*y + x[n-1]  →  y(1+α) = x + x[n-1]  ✗
  // The DF2T form makes a 1-pole HP inconvenient; we therefore use the
  // DF1 scalar form via setHighPass with a very high Q (1/√2 = 0.7071).
  // That matches the textbook RBJ 2nd-order HP exactly at fc.
  // Here we still treat it as a 1-pole HP via the simple recursion:
  //   y[n] = (x[n] - x[n-1]) + α*y[n-1]
  // We expose this as a separate scalar filter rather than reusing
  // processBiquad; see DcBlocker below.
  void alpha;
  // This function is intentionally a placeholder; use DcBlocker instead.
  setFlat({ coeffs: c, z1: new Float64Array(0), z2: new Float64Array(0) });
}

/**
 * Standalone DC-blocker. Per-channel, scalar, allocation-free.
 *
 *   y[n] = x[n] - x[n-1] + α·y[n-1],   α = exp(-2π·fc/sr)
 *
 * Default fc = 15 Hz — matches the FXEQ audit fix for residual DC on
 * long feedback paths.
 */
export interface DcBlocker {
  process(x: number): number;
  reset(): void;
}

export function createDcBlocker(sampleRate: number, cutoffHz = 15): DcBlocker {
  const alpha = Math.exp((-TAU * cutoffHz) / sampleRate);
  let prevX = 0;
  let prevY = 0;
  return {
    process(x) {
      const y = x - prevX + alpha * prevY;
      prevX = x;
      prevY = y;
      return y;
    },
    reset() {
      prevX = 0;
      prevY = 0;
    },
  };
}

// ── Processing (Direct Form II Transposed) ───────────────────

/**
 * In-place processing of `channels` (length N each) through the biquad.
 * Maintains per-channel state across blocks.
 */
export function processBiquad(bq: BiquadState, channels: Float32Array[], frameCount: number): void {
  const { b0, b1, b2, a1, a2 } = bq.coeffs;

  for (let ch = 0; ch < channels.length; ch++) {
    if (ch >= bq.z1.length) continue;
    const buf = channels[ch];
    let z1 = bq.z1[ch];
    let z2 = bq.z2[ch];

    for (let i = 0; i < frameCount; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }

    bq.z1[ch] = z1;
    bq.z2[ch] = z2;
    // Non-finite state guard (mirrors the ultina core): a poisoned DF2T
    // recursion never self-heals — without this the section stays silent
    // (or NaN) for the rest of the session even after the input recovers.
    if (!Number.isFinite(z1) || !Number.isFinite(z2)) {
      bq.z1[ch] = 0;
      bq.z2[ch] = 0;
    }
  }
}
