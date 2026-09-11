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
// FXEQ — Polyphase FIR oversampling
//
// Purpose
//   Proper anti-imaging (upsampler) and anti-aliasing (downsampler)
//   filters for nonlinear saturation. Linear interpolation is NOT
//   adequate — it aliases high-frequency harmonics back into the
//   audible band when a waveshaper creates energy above Nyquist.
//
// Design
//   - Polyphase decomposition of a Kaiser-windowed sinc low-pass.
//   - The same kernel is reused for up and down sampling (linear-phase
//     FIR is its own inverse up to delay and gain).
//   - Fixed oversampling factors: 2x and 4x. 1x bypasses the filter.
//
// Latency
//   - The downsampler compensates for the FIR group delay so that the
//     overall latency of the oversampler is exactly half the kernel
//     length in input samples. This is what `getLatencySamples()` returns.
// ═══════════════════════════════════════════════════════════

import { clamp } from "./mathUtils.js";

export type OversampleFactor = 1 | 2 | 4 | 8;

export interface OversamplerLatency {
  /** Samples of latency introduced at the input/output rate. */
  samples: number;
  /** Human-readable breakdown for UI. */
  filterLength: number;
  factor: OversampleFactor;
}

// ── Kaiser-windowed sinc kernel design ────────────────────────

/**
 * Modified Bessel function of the first kind, order zero. Used by the
 * Kaiser window. Series expansion — converges to ~1e-6 in ~20 terms.
 */
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

/**
 * Kaiser window of length N, parameter beta.
 *   w[n] = I0(beta * sqrt(1 - (n / M)^2)) / I0(beta),  n in [-M..M],  N = 2M+1
 */
function kaiserWindow(n: number, M: number, beta: number): number {
  const r = n / M;
  const arg = beta * Math.sqrt(Math.max(0, 1 - r * r));
  return besselI0(arg) / besselI0(beta);
}

/**
 * Design a Kaiser-windowed sinc low-pass filter at cutoff `cutoffHz`
 * for a given input sample rate. Returns `length` taps (must be odd).
 *
 * The Kaiser beta is chosen via the standard stop-band attenuation
 * rule of thumb (≈ 0.1102*(A-8.7) for A dB). We target A = 90 dB which
 * is more than enough for musical saturation anti-aliasing.
 */
export function designLowpassKernel(
  cutoffHz: number,
  sampleRate: number,
  length: number,
): Float32Array {
  // Round up to nearest odd integer for symmetric linear-phase.
  if (length % 2 === 0) length += 1;
  const M = (length - 1) / 2;
  const A = 90; // stop-band attenuation dB
  const beta = A > 50 ? 0.1102 * (A - 8.7) : 0.5842 * Math.pow(A / 20, 0.4) + 0.07886 * (A / 20);
  const omegaC = (2 * Math.PI * cutoffHz) / sampleRate;
  const kernel = new Float32Array(length);
  let sum = 0;
  for (let n = 0; n < length; n++) {
    const k = n - M;
    // Normalized sinc with peak at k=0: sin(omegaC*k) / (omegaC*k).
    // The peak value is 1; DC gain of the unnormalized kernel is
    // exactly 1, so we don't need to divide by sum at the end.
    const sinc = k === 0 ? 1 : Math.sin(omegaC * k) / (omegaC * k);
    const w = kaiserWindow(k, M, beta);
    const v = sinc * w;
    kernel[n] = v;
    sum += v;
  }
  // Normalize to DC gain = 1 (defensive — the formula above should
  // already sum to ~1, but the windowing introduces small error).
  if (sum > 0) {
    const inv = 1 / sum;
    for (let i = 0; i < length; i++) kernel[i] *= inv;
  }
  return kernel;
}

// ── Polyphase decomposition ───────────────────────────────────

/**
 * Split a length-N kernel into `factor` polyphase subfilters of length
 * `tapsPerPhase = ceil(N / factor)`. Each subfilter handles one phase of
 * the upsampled signal.
 *
 * Layout: subfilter[p][t] = kernel[p + t*factor]  for p in [0..factor-1]
 */
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

// ── Polyphase upsampler ───────────────────────────────────────

/**
 * Upsample by `factor` using polyphase FIR. Inserts zeros between input
 * samples and applies the appropriate subfilter at each output sample.
 *
 * The output is exactly `factor * input.length` samples long. Latency in
 * the upsampled domain is `(tapsPerPhase - 1) * factor` samples.
 */
export function upsamplePolyphase(
  input: Float32Array,
  subfilters: Float32Array[],
  factor: number,
): Float32Array {
  const tapsPerPhase = subfilters[0].length;
  const outLen = input.length * factor;
  const output = new Float32Array(outLen);
  const delayLine = new Float32Array(tapsPerPhase);

  // Fill delay line from end of previous call? For block processing we
  // simply use the input block; the FIR will naturally produce the
  // startup transient. Cross-block state is held by the caller if needed.
  for (let n = 0; n < input.length; n++) {
    // Shift delay line.
    for (let i = tapsPerPhase - 1; i > 0; i--) delayLine[i] = delayLine[i - 1];
    delayLine[0] = input[n];

    // Compute `factor` output samples, one per subfilter.
    for (let p = 0; p < factor; p++) {
      const sf = subfilters[p];
      let acc = 0;
      for (let t = 0; t < tapsPerPhase; t++) acc += sf[t] * delayLine[t];
      output[n * factor + p] = acc;
    }
  }

  return output;
}

// ── Polyphase downsampler (decimating FIR) ────────────────────

/**
 * Downsample by `factor` using polyphase FIR. Each output sample is the
 * sum of `tapsPerPhase` polyphase taps, all of which receive the same
 * input sample (just at different historical offsets).
 *
 * Output length is `floor(input.length / factor)`. Latency at input rate
 * is `(tapsPerPhase - 1) / 2` samples (the half-kernel group delay at
 * the output rate, divided by factor for input-rate samples).
 */
export function downsamplePolyphase(
  input: Float32Array,
  subfilters: Float32Array[],
  factor: number,
): Float32Array {
  const tapsPerPhase = subfilters[0].length;
  const fullTaps = tapsPerPhase * factor;
  const outLen = Math.floor(input.length / factor);
  const output = new Float32Array(outLen);
  const delayLine = new Float32Array(fullTaps);

  // Reconstruct full kernel from polyphase components.
  const fullKernel = new Float32Array(fullTaps);
  for (let t = 0; t < fullTaps; t++) {
    fullKernel[t] = subfilters[t % factor][Math.floor(t / factor)];
  }

  let inIdx = 0;
  for (let n = 0; n < outLen; n++) {
    // Push `factor` oversampled samples so the FIR processes all data.
    for (let p = 0; p < factor; p++) {
      for (let i = fullTaps - 1; i > 0; i--) delayLine[i] = delayLine[i - 1];
      delayLine[0] = input[inIdx];
      inIdx++;
    }
    let acc = 0;
    for (let t = 0; t < fullTaps; t++) acc += fullKernel[t] * delayLine[t];
    output[n] = acc;
  }

  return output;
}

// ── Stateful oversampler (per-channel, block-streaming) ───────

/**
 * Stateful oversampler suitable for in-place per-channel processing.
 * Holds the FIR history across blocks so that block-size independence
 * is preserved. The downsampler compensates for half the kernel group
 * delay so the reported latency is `(tapsPerPhase - 1) / (2 * factor)`
 * samples at the input rate.
 */
export interface PolyphaseOversampler {
  readonly factor: OversampleFactor;
  readonly latencySamples: number;
  readonly filterLength: number;
  prepare(inputSampleRate: number, factor: OversampleFactor, maxInputSize?: number): void;
  /**
   * Upsample the first `inputLen` samples (defaults to `input.length`).
   * Returns the reused internal buffer; the caller must use the explicit
   * frame count rather than the returned buffer's capacity.
   */
  upsample(input: Float32Array, inputLen?: number): Float32Array;
  /**
   * Downsample the first `inputLen` samples (defaults to `input.length`).
   * Returns the reused internal buffer; the caller must use the explicit
   * output frame count rather than the returned buffer's capacity.
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
  // True through-latency (input-rate samples) of the up→down cascade,
  // measured from the impulse response at prepare() time. The analytic
  // formulas drift from the real kernels (per-phase normalization shifts
  // the peak by more than a phase slot), so we measure instead.
  let measuredLatency = 0;
  const downState = new Map<number, Float32Array>();
  const upState = new Map<number, Float32Array>();

  let upBuf: Float32Array = new Float32Array(0);
  let downBuf: Float32Array = new Float32Array(0);

  function stateKey(map: Map<number, Float32Array>, ch: number, len: number): Float32Array {
    let s = map.get(ch);
    if (!s || s.length !== len) {
      s = new Float32Array(len);
      map.set(ch, s);
    }
    return s;
  }

  /** Shared upsampling core (caller owns the delay line + output). */
  function runUpsample(
    input: Float32Array,
    inputLen: number,
    delayLine: Float32Array,
    output: Float32Array,
  ): void {
    const taps = subfilters[0].length;
    for (let n = 0; n < inputLen; n++) {
      for (let i = taps - 1; i > 0; i--) delayLine[i] = delayLine[i - 1];
      delayLine[0] = input[n];

      for (let p = 0; p < factor; p++) {
        const sub = subfilters[p];
        let acc = 0;
        for (let t = 0; t < taps; t++) acc += sub[t] * delayLine[t];
        output[n * factor + p] = acc * subScale[p];
      }
    }
  }

  /** Shared downsampling core (caller owns the delay line + output). */
  function runDownsample(
    input: Float32Array,
    inputLen: number,
    delayLine: Float32Array,
    output: Float32Array,
  ): void {
    const outLen = Math.floor(inputLen / factor);
    let inIdx = 0;
    for (let n = 0; n < outLen; n++) {
      for (let p = 0; p < factor; p++) {
        for (let i = fullDownTaps - 1; i > 0; i--) delayLine[i] = delayLine[i - 1];
        delayLine[0] = input[inIdx];
        inIdx++;
      }
      let acc = 0;
      for (let t = 0; t < fullDownTaps; t++) acc += fullDownKernel[t] * delayLine[t];
      output[n] = acc * decNorm;
    }
  }

  /**
   * Measure the real up→down group delay with an impulse through the
   * exact production math (fresh delay lines, no cross-block state).
   */
  function measureThroughLatency(): number {
    const probeLen = tapsPerPhase * 2 + fullDownTaps + 8;
    const impulse = new Float32Array(probeLen);
    impulse[0] = 1;
    const upProbe = new Float32Array(probeLen * factor);
    runUpsample(impulse, impulse.length, new Float32Array(tapsPerPhase), upProbe);
    const downProbe = new Float32Array(probeLen);
    runDownsample(upProbe, upProbe.length, new Float32Array(fullDownTaps), downProbe);
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < downProbe.length; i++) {
      const a = downProbe[i] < 0 ? -downProbe[i] : downProbe[i];
      if (a > peakVal) {
        peakVal = a;
        peakIdx = i;
      }
    }
    return peakIdx;
  }

  return {
    get factor() {
      return factor;
    },
    get latencySamples() {
      // Measured impulse delay of the full up→down cascade at input rate.
      // The old analytic formula floor((tapsPerPhase-1)/(2*factor)) reported
      // 4 while the cascade actually delays ~31 samples (audit C1), which
      // made host PDC under-compensate and comb-filter parallel paths.
      return measuredLatency;
    },
    get filterLength() {
      return filterLength;
    },

    prepare(sr, f, maxInputSize = 4096) {
      sampleRate = clamp(sr, 8000, 192000);
      factor = f;
      downState.clear();
      upState.clear();
      if (factor <= 1) {
        subfilters = [];
        filterLength = 0;
        tapsPerPhase = 0;
        measuredLatency = 0;
        upBuf = new Float32Array(maxInputSize);
        downBuf = new Float32Array(maxInputSize);
        return;
      }
      const cutoff = sampleRate / 2;
      const tapsPerPhaseTarget = factor === 8 ? 64 : factor === 4 ? 32 : 16;
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

      // Measure BEFORE overwriting any state the shared cores use —
      // runUpsample/runDownsample only read kernel data, so this is safe
      // mid-prepare.
      measuredLatency = measureThroughLatency();

      upBuf = new Float32Array(maxInputSize * factor);
      downBuf = new Float32Array(maxInputSize);
    },

    upsample(input, inputLen = input.length) {
      if (factor <= 1) {
        if (upBuf.length < inputLen) upBuf = new Float32Array(inputLen);
        for (let i = 0; i < inputLen; i++) upBuf[i] = input[i];
        return upBuf;
      }
      const outLen = inputLen * factor;
      if (upBuf.length < outLen) upBuf = new Float32Array(outLen);
      runUpsample(input, inputLen, stateKey(upState, 0, tapsPerPhase), upBuf);
      return upBuf;
    },

    downsample(input, inputLen = input.length) {
      if (factor <= 1) {
        if (downBuf.length < inputLen) downBuf = new Float32Array(inputLen);
        for (let i = 0; i < inputLen; i++) downBuf[i] = input[i];
        return downBuf;
      }
      const outLen = Math.floor(inputLen / factor);
      if (downBuf.length < outLen) downBuf = new Float32Array(outLen);
      runDownsample(input, inputLen, stateKey(downState, 0, fullDownTaps), downBuf);
      return downBuf;
    },

    reset() {
      downState.clear();
      upState.clear();
    },
  };
}

// ── Quality-mode policy ───────────────────────────────────────

/**
 * Per-mode decision: which saturation modes are nonlinear enough that
 * oversampling matters. Linear modes (cleanWarmth at low drive, tape at
 * modest drive) can stay at 1x; aggressive, foldback, brightEdge, and
 * hard-driven tube/tape modes benefit from 2x or 4x.
 *
 * The threshold is the "knee" where harmonics above Nyquist/2 start
 * appearing.
 */
export const SAT_MODE_NEEDS_OVERSAMPLE: boolean[] = [
  false, // 0 cleanWarmth — tanh, mild even at high drive
  true,  // 1 tube — Miller+asymmetric clip, odd+even harmonics
  true,  // 2 tape — hysteresis, rich harmonics
  true,  // 3 brightEdge — x - x^3/3 has 3rd harmonic
  true,  // 4 aggressive — hard-knee clip, lots of aliasing
  true,  // 5 foldback — explicitly aliasing
  true,  // 6 cathode — 2nd harmonic, alias-prone at high drive
  true,  // 7 transformer — flux+BH curve, odd+even mix
];

/**
 * Decide what oversampling factor to use for a given saturation mode
 * and quality mode. Returns 1 if no oversampling is needed (e.g. eco
 * mode always uses 1x).
 *
 * P-engine #10: "render" quality runs at 8× — an offline export has no
 * realtime CPU budget, so heavy presets get a measurably lower aliasing
 * floor for free. Realtime modes stay at 2×/4×.
 */
export function pickOversampleFactor(
  quality: "eco" | "standard" | "high" | "render",
  satMode: number,
  driveDb: number,
): OversampleFactor {
  if (quality === "eco") return 1;
  const needs = SAT_MODE_NEEDS_OVERSAMPLE[satMode] ?? false;
  if (!needs) return 1;
  // Drive threshold: only oversample when drive exceeds 6 dB (2x linear).
  // Below that the harmonic content is too quiet to alias audibly.
  if (driveDb < 6) return 1;
  if (quality === "standard") return 2;
  if (quality === "high") return Math.max(2, driveDb >= 12 ? 4 : 2) as OversampleFactor;
  // render: offline export — go to the max.
  return 8;
}
