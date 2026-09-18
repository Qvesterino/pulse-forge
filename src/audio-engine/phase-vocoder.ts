/**
 * Pitch-preserving time warp via a classic phase vocoder.
 *
 * Laroche–Dolson phase propagation with a TIME-VARYING analysis advance, so
 * one render can follow a warp map (slow down here, catch up there) while the
 * pitch stays put — the élastique-style "preserve" counterpart to the repitch
 * warp in `AudioEngine.triggerAudioClip` (where pitch follows time).
 *
 * Design constraints (deliberate, FL-honest):
 * - Quality target is evolving mono/poly textures, pads and atmospheres —
 *   sustained, harmonically rich material where granular OLA turns metallic.
 *   Percussive transients SMEAR (no transient preservation in v1); drums keep
 *   using repitch warp / one-shots.
 * - Pure, synchronous, deterministic: identical input → bit-identical output
 *   on the same JS engine, so live (worker-warmed cache) and offline render
 *   are sample-exact. No AudioContext, no DOM, no allocations in the hot
 *   per-frame loop beyond the fixed scratch — safe to run in a Web Worker.
 * - FFT is the vendored radix-2 oracle (`ozvena-core/dsp/fft.ts`, imported
 *   not copied); inverse runs through the conjugate trick.
 *
 * Method per output frame (synthesis hop Hs fixed, 75% Hann overlap):
 *  1. rate r = rateAt(output time), clamped to [0.25, 4] (matches the
 *     granular `timeStretch` range).
 *  2. analysis advance adv = Hs / r; read a Hann-windowed frame at the
 *     fractional source position (Catmull-Rom cubic resampling, zero outside).
 *  3. FFT → magnitude/phase per bin; instantaneous frequency from the
 *     heterodyned phase increment against THIS frame's advance
 *     (inst = omega + princarg(phi - prevPhi - omega*adv) / adv).
 *  4. output phase += inst * Hs; resynthesize magnitude∠output-phase, IFFT,
 *     Hann-window again and overlap-add with sum-of-squares normalization.
 */

import { fft, hannWindow, isPow2 } from "../effects/ozvena-core/dsp/fft.js";

/** One span of a warp rate envelope (seconds, output timeline). */
export interface WarpRateInterval {
  startSec: number;
  endSec: number;
  /** Stretch factor for this span (>1 = longer output, pitch kept). */
  rate: number;
}

/** Clamp a stretch factor into the supported DSP range. */
export function clampWarpRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(4, Math.max(0.25, rate));
}

/**
 * Build a sample-exact rate lookup from warp intervals (piecewise constant,
 * edge-clamped). Pure — shared by the engine, the worker and the tests.
 */
export function warpRateEnvelope(intervals: ReadonlyArray<WarpRateInterval>): (outSec: number) => number {
  const spans = intervals
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .map((s) => ({ startSec: s.startSec, endSec: s.endSec, rate: clampWarpRate(s.rate) }))
    .sort((a, b) => a.startSec - b.startSec);
  return (outSec: number): number => {
    if (spans.length === 0) return 1;
    if (!(outSec > spans[0].startSec)) return spans[0].rate;
    for (const s of spans) {
      if (outSec < s.endSec) return s.rate;
    }
    return spans[spans.length - 1].rate;
  };
}

function princarg(x: number): number {
  const TAU = Math.PI * 2;
  let y = x % TAU;
  if (y > Math.PI) y -= TAU;
  else if (y < -Math.PI) y += TAU;
  return y;
}

/** Catmull-Rom cubic sample read, zero outside [0, data.length). */
function cubicAt(data: Float32Array, pos: number): number {
  const D = data.length;
  const i1 = Math.floor(pos);
  if (i1 < -1 || i1 > D) return 0;
  const frac = pos - i1;
  const p0 = i1 - 1 >= 0 ? data[i1 - 1] : 0;
  const p1 = i1 >= 0 && i1 < D ? data[i1] : 0;
  const p2 = i1 + 1 >= 0 && i1 + 1 < D ? data[i1 + 1] : 0;
  const p3 = i1 + 2 >= 0 && i1 + 2 < D ? data[i1 + 2] : 0;
  return p1 + 0.5 * frac * (p2 - p0 + frac * (2 * p0 - 5 * p1 + 4 * p2 - p3 + frac * (3 * (p1 - p2) + p3 - p0)));
}

export interface PhaseVocoderOpts {
  /** FFT length, power of two ≥ 64 (default 2048 ≈ 46 ms @ 44.1 kHz). */
  fftSize?: number;
  /** Synthesis hop in samples (default fftSize / 4, 75% overlap). */
  hop?: number;
}

/**
 * Pitch-preserving warp of one mono channel.
 *
 * @param data input samples (any Float32Array view — subarray views are NOT copied).
 * @param sampleRate sample rate in Hz (only sets the time base for `rateAt`).
 * @param rateAt local stretch factor as a function of OUTPUT time in seconds.
 * @param outLenSamples exact output length (warp maps are grid-exact).
 */
export function phaseVocoderWarpChannel(
  data: Float32Array,
  sampleRate: number,
  rateAt: (outSec: number) => number,
  outLenSamples: number,
  opts: PhaseVocoderOpts = {},
): Float32Array {
  const outLen = Math.max(0, Math.floor(outLenSamples));
  const out = new Float32Array(outLen);
  if (outLen === 0 || data.length === 0) return out;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return out;
  const N = opts.fftSize ?? 2048;
  if (!isPow2(N) || N < 64) throw new Error(`phaseVocoder: fftSize must be a power of two ≥ 64, got ${N}`);
  const Hs = opts.hop !== undefined ? Math.max(1, Math.floor(opts.hop)) : N >> 2;

  const win = Float64Array.from(hannWindow(N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const half = N >> 1;
  const mag = new Float64Array(half + 1);
  const phi = new Float64Array(half + 1);
  const prevPhi = new Float64Array(half + 1);
  const outPhi = new Float64Array(half + 1);
  const winSum = new Float32Array(outLen);
  const TAU = Math.PI * 2;
  const center = N >> 1;

  let srcPos = 0;
  let outPos = 0;
  let first = true;
  while (outPos < outLen) {
    const rate = clampWarpRate(rateAt(outPos / sampleRate));
    const adv = Hs / rate;
    for (let n = 0; n < N; n++) {
      re[n] = cubicAt(data, srcPos + n - center) * win[n];
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phi[k] = Math.atan2(im[k], re[k]);
    }
    if (first) {
      for (let k = 0; k <= half; k++) {
        outPhi[k] = phi[k];
        prevPhi[k] = phi[k];
      }
      first = false;
    } else {
      for (let k = 1; k < half; k++) {
        const om = (TAU * k) / N;
        const dphi = princarg(phi[k] - prevPhi[k] - om * adv);
        outPhi[k] += (om + dphi / adv) * Hs;
        prevPhi[k] = phi[k];
      }
      // DC and Nyquist stay real (phase 0, measured magnitude).
      outPhi[0] = 0;
      prevPhi[0] = phi[0];
      outPhi[half] = 0;
      prevPhi[half] = phi[half];
    }
    for (let k = 0; k <= half; k++) {
      re[k] = Math.cos(outPhi[k]) * mag[k];
      im[k] = Math.sin(outPhi[k]) * mag[k];
    }
    re[0] = mag[0];
    im[0] = 0;
    re[half] = mag[half];
    im[half] = 0;
    for (let k = half + 1; k < N; k++) {
      re[k] = re[N - k];
      im[k] = -im[N - k];
    }
    // IFFT via the conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N.
    for (let k = 0; k < N; k++) im[k] = -im[k];
    fft(re, im);
    const invN = 1 / N;
    for (let n = 0; n < N && outPos + n < outLen; n++) {
      const v = re[n] * invN;
      out[outPos + n] += v * win[n];
      winSum[outPos + n] += win[n] * win[n];
    }
    srcPos += adv;
    outPos += Hs;
  }
  for (let i = 0; i < outLen; i++) {
    if (winSum[i] > 1e-9) out[i] /= winSum[i];
  }
  return out;
}
