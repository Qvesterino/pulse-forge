/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Polyphase FIR oversampling
//
// Used by the saturation/ADAA stage (not yet wired in this iteration)
// and by the Smoother lookahead convolution. Mirrors FXEQ's
// oversampler structure but adds a 1×/2×/4×/8× factor and explicit
// per-channel state for the realtime audio callback.
// ═══════════════════════════════════════════════════════════

import { clamp, nextPow2 } from "./math.js";

export type OversampleFactor = 1 | 2 | 4 | 8;

export interface OversamplerLatency {
  samples: number;
  filterLength: number;
  factor: OversampleFactor;
}

// ── Kaiser-windowed sinc kernel design ────────────────────────

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k < 60; k++) {
    term *= (halfX * halfX) / (k * k);
    sum += term;
    if (term < 1e-12) break;
  }
  return sum;
}

function kaiserWindow(n: number, M: number, beta: number): number {
  const r = n / M;
  const arg = beta * Math.sqrt(Math.max(0, 1 - r * r));
  return besselI0(arg) / besselI0(beta);
}

/**
 * Design a Kaiser-windowed sinc low-pass at `cutoffHz` for a given
 * sample rate. Length must be odd. Stop-band attenuation = 90 dB.
 */
export function designLowpassKernel(
  cutoffHz: number,
  sampleRate: number,
  length: number,
): Float32Array {
  if (length % 2 === 0) length += 1;
  const M = (length - 1) / 2;
  const A = 90;
  const beta = A > 50 ? 0.1102 * (A - 8.7) : 0.5842 * Math.pow(A / 20, 0.4) + 0.07886 * (A / 20);
  const omegaC = (2 * Math.PI * cutoffHz) / sampleRate;
  const kernel = new Float32Array(length);
  let sum = 0;
  for (let n = 0; n < length; n++) {
    const k = n - M;
    const sinc = k === 0 ? 1 : Math.sin(omegaC * k) / (omegaC * k);
    const w = kaiserWindow(k, M, beta);
    const v = sinc * w;
    kernel[n] = v;
    sum += v;
  }
  if (sum > 0) {
    const inv = 1 / sum;
    for (let i = 0; i < length; i++) kernel[i] *= inv;
  }
  return kernel;
}

export function polyphaseDecompose(kernel: Float32Array, factor: number): Float32Array[] {
  const tapsPerPhase = Math.ceil(kernel.length / factor);
  const subs: Float32Array[] = [];
  for (let p = 0; p < factor; p++) {
    const taps = new Float32Array(tapsPerPhase);
    for (let t = 0; t < tapsPerPhase; t++) {
      const idx = p + t * factor;
      if (idx < kernel.length) taps[t] = kernel[idx];
    }
    subs.push(taps);
  }
  return subs;
}

export interface PolyphaseOversampler {
  readonly factor: OversampleFactor;
  readonly latencySamples: number;
  readonly filterLength: number;
  prepare(inputSampleRate: number, factor: OversampleFactor): void;
  /**
   * Upsample the first `inputLen` samples (defaults to `input.length`).
   * Returns a REUSED internal buffer valid until the next upsample() call
   * on this instance — allocation-free at steady state. Pass `inputLen`
   * explicitly when the host buffer may be longer than the audio block,
   * otherwise stale samples past the block would pollute the filter state.
   */
  upsample(input: Float32Array, inputLen?: number): Float32Array;
  /**
   * Downsample the first `inputLen` samples (defaults to `input.length`).
   * Returns a REUSED internal buffer valid until the next downsample() call.
   */
  downsample(input: Float32Array, inputLen?: number): Float32Array;
  reset(): void;
}

export function createPolyphaseOversampler(): PolyphaseOversampler {
  let factor: OversampleFactor = 1;
  let subfilters: Float32Array[] = [];
  let filterLength = 0;
  let tapsPerPhase = 0;
  let sampleRate = 44100;
  let subScale: Float32Array = new Float32Array(0);
  let decNorm = 1;
  let fullDownKernel: Float32Array = new Float32Array(0);
  let fullDownTaps = 0;
  // Ring delay lines (power-of-two capacity + wrap mask). The old
  // implementation shifted the whole delay line per input sample — at 4×
  // factor the downsample moved ~49k elements per 128-sample block per
  // channel. Ring indexing reads the identical values in the identical
  // order, so the convolution is bit-identical with zero moves.
  let upDelay: Float32Array = new Float32Array(1);
  let upMask = 0;
  let upWp = 0;
  let downDelay: Float32Array = new Float32Array(1);
  let downMask = 0;
  let downWp = 0;
  // Reused output buffers (real-time safe — no per-call allocation).
  let upBuf: Float32Array = new Float32Array(0);
  let downBuf: Float32Array = new Float32Array(0);

  return {
    get factor() { return factor; },
    get latencySamples() {
      if (factor <= 1) return 0;
      return Math.floor((tapsPerPhase - 1) / (2 * factor));
    },
    get filterLength() { return filterLength; },

    prepare(sr, f) {
      sampleRate = clamp(sr, 8000, 192000);
      factor = f;
      upWp = 0;
      downWp = 0;
      if (factor <= 1) {
        subfilters = [];
        filterLength = 0;
        tapsPerPhase = 0;
        return;
      }
      const cutoff = sampleRate / 2;
      const tapsPerPhaseTarget = factor === 8 ? 32 : factor === 4 ? 24 : 16;
      filterLength = tapsPerPhaseTarget * factor;
      const rawKernel = designLowpassKernel(cutoff, sampleRate * factor, filterLength);
      fullDownKernel = rawKernel;
      fullDownTaps = rawKernel.length;
      subfilters = polyphaseDecompose(rawKernel, factor);
      tapsPerPhase = subfilters[0].length;
      const sums = subfilters.map((s) => {
        let total = 0;
        for (const v of s) total += v;
        return total;
      });
      subScale = new Float32Array(factor);
      for (let p = 0; p < factor; p++) {
        subScale[p] = sums[p] > 0 ? 1 / sums[p] : 1;
      }
      decNorm = 1;
      // Rings sized once for the largest line this instance will need.
      const cap = nextPow2(Math.max(tapsPerPhase, fullDownTaps));
      upDelay = new Float32Array(cap);
      upMask = cap - 1;
      downDelay = new Float32Array(cap);
      downMask = cap - 1;
    },

    upsample(input, inputLen = input.length) {
      if (factor <= 1) {
        if (upBuf.length < inputLen) upBuf = new Float32Array(inputLen);
        for (let i = 0; i < inputLen; i++) upBuf[i] = input[i];
        return upBuf;
      }
      const sf = subfilters;
      const taps = sf[0].length;
      const outLen = inputLen * factor;
      if (upBuf.length < outLen) upBuf = new Float32Array(outLen);
      const delayLine = upDelay;
      const mask = upMask;
      let wp = upWp;
      for (let n = 0; n < inputLen; n++) {
        delayLine[wp] = input[n];
        for (let p = 0; p < factor; p++) {
          const sub = sf[p];
          let acc = 0;
          for (let t = 0; t < taps; t++) acc += sub[t] * delayLine[(wp - t) & mask];
          upBuf[n * factor + p] = acc * subScale[p];
        }
        wp = (wp + 1) & mask;
      }
      upWp = wp;
      return upBuf;
    },

    downsample(input, inputLen = input.length) {
      const outLen = factor <= 1 ? inputLen : Math.floor(inputLen / factor);
      if (downBuf.length < outLen) downBuf = new Float32Array(outLen);
      if (factor <= 1) {
        for (let i = 0; i < outLen; i++) downBuf[i] = input[i];
        return downBuf;
      }
      const delayLine = downDelay;
      const mask = downMask;
      const taps = fullDownTaps;
      let wp = downWp;
      let inIdx = 0;
      for (let n = 0; n < outLen; n++) {
        for (let p = 0; p < factor; p++) {
          delayLine[wp] = input[inIdx];
          inIdx++;
          wp = (wp + 1) & mask;
        }
        // wp now sits one PAST the newest sample — kernel tap 0 must read
        // (wp - 1), matching the old shift-line's delayLine[0].
        let acc = 0;
        for (let t = 0; t < taps; t++) acc += fullDownKernel[t] * delayLine[(wp - 1 - t) & mask];
        downBuf[n] = acc * decNorm;
      }
      downWp = wp;
      return downBuf;
    },

    reset() {
      upDelay.fill(0);
      downDelay.fill(0);
      upWp = 0;
      downWp = 0;
    },
  };
}

/**
 * Pick the oversample factor for a given quality mode and CPU budget.
 * Used by quality-aware modules (smoother lookahead, future ADAA).
 */
export function pickOversampleFactor(
  quality: "eco" | "standard" | "high" | "render",
): OversampleFactor {
  if (quality === "eco") return 1;
  if (quality === "standard") return 2;
  if (quality === "high") return 4;
  return 8;
}

/**
 * Map a quality mode to the 0..3 tier used by the FDN engines'
 * setQuality() (0=eco … 3=render). Kept next to pickOversampleFactor so
 * every quality-aware module shares one tier convention.
 */
export function pickQualityTier(
  quality: "eco" | "standard" | "high" | "render",
): number {
  if (quality === "eco") return 0;
  if (quality === "standard") return 1;
  if (quality === "high") return 2;
  return 3;
}
