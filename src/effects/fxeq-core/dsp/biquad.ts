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
// ═══════════════════════════════════════════════════════════
// FXEQ — Biquad filter engine
//
// Direct Form II Transposed biquad with per-channel state. Coefficients
// are set via RBJ Audio EQ Cookbook formulas. This is the single filter
// primitive the crossover and any future module build upon.
//
// Reference: https://www.musicdsp.org/en/latest/Filters/197-rbj-audio-eq-cookbook.html
// ═══════════════════════════════════════════════════════════

import { clamp } from "./mathUtils.js";

/** Normalized biquad coefficients (a0 divided out so a0 = 1). */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Per-channel Direct Form II Transposed state. */
export interface BiquadState {
  coeffs: BiquadCoeffs;
  z1: Float32Array;
  z2: Float32Array;
}

/** Create a flat (all-pass) biquad state for `channelCount` channels. */
export function createBiquad(channelCount: number): BiquadState {
  return {
    coeffs: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
    z1: new Float32Array(channelCount),
    z2: new Float32Array(channelCount),
  };
}

/** Set a biquad to flat (unity passthrough). */
export function setFlat(bq: BiquadState): void {
  const c = bq.coeffs;
  c.b0 = 1;
  c.b1 = 0;
  c.b2 = 0;
  c.a1 = 0;
  c.a2 = 0;
}

/** Clear filter state (after coefficient changes or on reset). */
export function resetBiquad(bq: BiquadState): void {
  bq.z1.fill(0);
  bq.z2.fill(0);
}

// ── RBJ Cookbook coefficient setters ──────────────────────────
// All normalize by a0 so the difference equation uses a1, a2 directly.

function w0(freq: number, sampleRate: number): number {
  // Clamp to avoid instability near Nyquist; freq must stay below Nyquist.
  const nyq = sampleRate * 0.5;
  const f = clamp(freq, 10, nyq * 0.99);
  return (2 * Math.PI * f) / sampleRate;
}

export function setLowPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = (1 - cosW) / 2 / a0;
  c.b1 = (1 - cosW) / a0;
  c.b2 = (1 - cosW) / 2 / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

export function setHighPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = (1 + cosW) / 2 / a0;
  c.b1 = -(1 + cosW) / a0;
  c.b2 = (1 + cosW) / 2 / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

export function setAllPass(c: BiquadCoeffs, freq: number, q: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha;

  c.b0 = (1 - alpha) / a0;
  c.b1 = (-2 * cosW) / a0;
  c.b2 = (1 + alpha) / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha) / a0;
}

// ── RBJ EQ sections (quality roadmap Q3 — band equalizer module) ──

/** RBJ peaking EQ: ±gainDb at freq with quality q. */
export function setPeaking(c: BiquadCoeffs, freq: number, q: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const a = Math.pow(10, gainDb / 40);
  const alpha = sinW / (2 * Math.max(1e-6, q));
  const a0 = 1 + alpha / a;

  c.b0 = (1 + alpha * a) / a0;
  c.b1 = (-2 * cosW) / a0;
  c.b2 = (1 - alpha * a) / a0;
  c.a1 = (-2 * cosW) / a0;
  c.a2 = (1 - alpha / a) / a0;
}

/** RBJ low shelf (shelf slope S = 1): ±gainDb below freq. */
export function setLowShelf(c: BiquadCoeffs, freq: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const a = Math.pow(10, gainDb / 40);
  const alpha = (sinW / 2) * Math.SQRT2;
  const sq = 2 * Math.sqrt(a) * alpha;
  const a0 = a + 1 + (a - 1) * cosW + sq;

  c.b0 = (a * (a + 1 - (a - 1) * cosW + sq)) / a0;
  c.b1 = (2 * a * (a - 1 - (a + 1) * cosW)) / a0;
  c.b2 = (a * (a + 1 - (a - 1) * cosW - sq)) / a0;
  c.a1 = (-2 * (a - 1 + (a + 1) * cosW)) / a0;
  c.a2 = (a + 1 + (a - 1) * cosW - sq) / a0;
}

/** RBJ high shelf (shelf slope S = 1): ±gainDb above freq. */
export function setHighShelf(c: BiquadCoeffs, freq: number, gainDb: number, sampleRate: number): void {
  const w = w0(freq, sampleRate);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const a = Math.pow(10, gainDb / 40);
  const alpha = (sinW / 2) * Math.SQRT2;
  const sq = 2 * Math.sqrt(a) * alpha;
  const a0 = a + 1 - (a - 1) * cosW + sq;

  c.b0 = (a * (a + 1 + (a - 1) * cosW + sq)) / a0;
  c.b1 = (-2 * a * (a - 1 + (a + 1) * cosW)) / a0;
  c.b2 = (a * (a + 1 + (a - 1) * cosW - sq)) / a0;
  c.a1 = (2 * (a - 1 - (a + 1) * cosW)) / a0;
  c.a2 = (a + 1 - (a - 1) * cosW - sq) / a0;
}

// ── Processing ────────────────────────────────────────────────
// Direct Form II Transposed:
//   y[n]   = b0*x[n] + z1
//   z1[n]  = b1*x[n] - a1*y[n] + z2
//   z2[n]  = b2*x[n] - a2*y[n]

/** Process a biquad in-place across all channels of `channels`. */
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
