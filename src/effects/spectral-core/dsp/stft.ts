/**
 * PORTAL — realtime streaming STFT engine.
 *
 * The skeleton is ported from `src/audio-engine/phase-vocoder.ts` (Laroche-Dolson
 * framing, sum-of-squares overlap-add normalisation), reshaped from a full-buffer
 * offline utility into an incremental streaming engine that can run inside an
 * AudioWorkletProcessor with no allocations in the steady state.
 *
 * FFT is the vendored radix-2 oracle, imported not copied — exactly the import
 * `phase-vocoder.ts` already uses (ADR 0038, D2).
 *
 * WHY AN OUTPUT RING INSTEAD OF A FRAME COUNTER
 * ---------------------------------------------
 * An AudioWorklet's `process()` must return exactly `blockLen` samples per call,
 * but a 75 %-overlap STFT produces one output frame of `fftSize` samples every
 * `hop`. Those two do not divide each other (1024/256 vs 128), so the engine keeps
 * a second ring: frames are overlap-added at `hop` intervals and the output is
 * read out at exactly the block rate. The steady latency is `fftSize - hop`
 * samples, reported honestly through `latencySamples()` — never hidden.
 *
 * WHY SUM-OF-SQUARES NORMALISATION
 * -------------------------------
 * Windowed frames overlap at 75 %, so their powers sum to more than 1 inside a
 * window's support. Dividing by the accumulated `w^2` makes the reconstruction
 * exact there and tapers to zero at the edges. Without it the output pumps at the
 * frame rate — a bug no parameter sweep explains.
 */

import { fft, hannWindow, isPow2 } from "../../ozvena-core/dsp/fft.js";

/** Largest block an AudioWorkletProcessor is allowed to receive. */
export const MAX_BLOCK = 128;

/** Below this accumulated window power the output is treated as silence. */
const NORM_FLOOR = 1e-9;

/** Hard ceiling on a per-bin feedback magnitude. See ADR 0038, D5. */
export const MAX_BIN_GAIN = 4;

/** A magnitude above this reads as an exploded bin. */
const BIN_FINITE_LIMIT = 1e6;

/** A magnitude above this is clamped back into the contractive envelope. */
const BIN_MAGNITUDE_LIMIT = 64;

export interface StftConfig {
  /** FFT length, power of two >= 256. Default 1024 (~23 ms @ 44.1 kHz). */
  fftSize?: number;
  /** Synthesis hop in samples. Default `fftSize / 4` (75 % overlap). */
  hop?: number;
}

/**
 * Spectral-domain frame callback. `re`/`im` carry the full FFT layout but only
 * bins `0 .. binCount-1` are meaningful on entry; the rest is mirrored for you.
 */
export type FrameProcessor = (re: Float64Array, im: Float64Array, binCount: number) => void;

/** Per-frame observer for meters/telemetry. Runs after `processFrame`. */
export type FrameObserver = (binCount: number) => void;

export class StftEngine {
  readonly fftSize: number;
  readonly hop: number;
  readonly binCount: number;
  readonly window: Float32Array;

  private readonly sampleRate: number;

  /** Last `fftSize` input samples, windowed on read. */
  private readonly inBuf: Float32Array;
  /** Overlap-add accumulator for output frames. */
  private readonly outBuf: Float32Array;
  /** Accumulated `w^2`, the overlap-add normaliser. */
  private readonly normBuf: Float32Array;
  private outRead = 0;
  private outWrite = 0;
  /** Input samples accumulated since the last emitted frame. */
  private inputSinceFrame = 0;

  private readonly re: Float64Array;
  private readonly im: Float64Array;

  private processFrame: FrameProcessor | null = null;
  private observer: FrameObserver | null = null;

  /** Frames pushed through since construction — exposed for golden tests. */
  frameCount = 0;

  /**
   * Diagnostic read-out of the overlap-add accumulator. The golden suite asserts
   * on it: a healthy engine keeps `normPeak` in the 1..4 band — the number of
   * Hann windows that overlap a sample at 75 % overlap. A normPeak far below 1
   * is the signature of a normaliser that gets reset mid-flight, which divides
   * the output by a window power it never accumulated (that defect measured
   * 7030x input peak before it was found).
   */
  readonly normStats = { normPeak: 0 };

  constructor(sampleRate: number, config: StftConfig = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`StftEngine: sampleRate must be positive, got ${sampleRate}`);
    }
    const size = config.fftSize ?? 1024;
    if (!isPow2(size) || size < 256) {
      throw new Error(`StftEngine: fftSize must be a power of two >= 256, got ${size}`);
    }
    const step = config.hop ?? size >> 2;
    if (step < 1 || step > size) throw new Error(`StftEngine: hop out of range, got ${step}`);

    this.sampleRate = sampleRate;
    this.fftSize = size;
    this.hop = step;
    this.binCount = (size >> 1) + 1;
    this.window = hannWindow(size);

    this.inBuf = new Float32Array(size + MAX_BLOCK);
    // A frame spans `size` samples but lands `hop` apart, and the readout can
    // begin before the first frame completes, so the ring is 2 windows long.
    this.outBuf = new Float32Array(size * 2 + MAX_BLOCK);
    this.normBuf = new Float32Array(size * 2 + MAX_BLOCK);

    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** Steady latency in samples: `fftSize - hop` (see the module note). */
  latencySamples(): number {
    return this.fftSize - this.hop;
  }

  latencySeconds(): number {
    return this.latencySamples() / this.sampleRate;
  }

  onFrame(processor: FrameProcessor | null): void {
    this.processFrame = processor;
  }

  onFrameComplete(observer: FrameObserver | null): void {
    this.observer = observer;
  }

  /**
   * Push one input block, emit exactly `out.length` output samples.
   *
   * Runs on the audio thread: no allocation here, in `processFrame`, or in the
   * overlap-add. Every scratch buffer is allocated in the constructor.
   */
  processBlock(input: Float32Array, blockLen: number, out: Float32Array): void {
    const N = this.fftSize;
    const hop = this.hop;

    this.inBuf.copyWithin(0, blockLen, N);
    this.inBuf.set(input.subarray(0, blockLen), N - blockLen);
    this.inputSinceFrame += blockLen;

    while (this.inputSinceFrame >= hop && this.processFrame) {
      this.emitOneFrame();
      this.inputSinceFrame -= hop;
    }
    // No frame processor attached (bypass): drop the accumulated input so the
    // first real frame is not preceded by stale history.
    if (!this.processFrame) this.inputSinceFrame = 0;

    const L = this.outBuf.length;
    let pos = wrap(this.outRead, L);
    let normPeak = 0;
    for (let i = 0; i < blockLen; i++) {
      const w = this.normBuf[pos];
      if (w > normPeak) normPeak = w;
      out[i] = w > NORM_FLOOR ? this.outBuf[pos] / w : 0;
      pos = pos + 1 === L ? 0 : pos + 1;
    }
    this.outRead += blockLen;
    this.normStats.normPeak = normPeak;
  }

  /** Zero every state buffer — used on bypass and by the soak harness. */
  reset(): void {
    this.inBuf.fill(0);
    this.outBuf.fill(0);
    this.normBuf.fill(0);
    this.outRead = 0;
    this.outWrite = 0;
    this.inputSinceFrame = 0;
    this.re.fill(0);
    this.im.fill(0);
    this.normStats.normPeak = 0;
  }

  /** Analyse → process → resynthesise → overlap-add one frame. */
  private emitOneFrame(): void {
    const { fftSize: N, hop, binCount, window, re, im } = this;
    const proc = this.processFrame;
    if (!proc) return;

    for (let n = 0; n < N; n++) {
      re[n] = this.inBuf[n] * window[n];
      im[n] = 0;
    }
    fft(re, im);

    proc(re, im, binCount);

    // Guard (ADR 0038, D5): one poisoned bin poisons every later frame through
    // the delay ring. Zero the spectrum rather than shipping NaN downstream.
    if (!spectrumIsFinite(re, im, binCount)) {
      re.fill(0);
      im.fill(0);
    }

    // Hermitian mirror — the FFT of a real signal is conjugate-symmetric and we
    // only touched the lower half.
    for (let k = binCount; k < N; k++) {
      re[k] = re[N - k];
      im[k] = -im[N - k];
    }

    // IFFT via the conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N.
    for (let k = 0; k < N; k++) im[k] = -im[k];
    fft(re, im);
    const invN = 1 / N;

    const L = this.outBuf.length;
    const base = wrap(this.outWrite, L);

    // Retire the leading `hop` positions before accumulating. Those samples have
    // just aged out of every overlapping window (the window is 4*hop long), so
    // whatever they still hold belongs to a frame from an earlier cycle. Leaving
    // it there mixes two different stretches of audio into one output sample —
    // measured as a steady-state tail at 0.395 against a 0.5 input, and as a
    // 7030x output peak once spectral feedback amplified the mix-up.
    for (let j = 0; j < hop; j++) {
      const p = base + j < L ? base + j : base + j - L;
      this.outBuf[p] = 0;
      this.normBuf[p] = 0;
    }

    let pos = base;
    for (let n = 0; n < N; n++) {
      const w = window[n];
      this.outBuf[pos] += re[n] * invN * w;
      this.normBuf[pos] += w * w;
      pos = pos + 1 === L ? 0 : pos + 1;
    }
    this.outWrite += hop;
    this.frameCount++;
    this.observer?.(binCount);
  }
}

/** Positive modulo — the cursors are unbounded counters. */
function wrap(value: number, length: number): number {
  const m = value % length;
  return m < 0 ? m + length : m;
}

/**
 * True when every meaningful bin is finite and below the explode threshold.
 * The magnitude clamp is separate and runs after this check.
 */
export function spectrumIsFinite(re: Float64Array, im: Float64Array, binCount: number): boolean {
  for (let k = 0; k < binCount; k++) {
    const r = re[k];
    const m = im[k];
    if (!Number.isFinite(r) || !Number.isFinite(m)) return false;
    if (Math.abs(r) > BIN_FINITE_LIMIT || Math.abs(m) > BIN_FINITE_LIMIT) return false;
  }
  return true;
}

/** Clamp a per-bin complex magnitude into the contractive envelope. */
export function clampBinMagnitude(re: Float64Array, im: Float64Array, binCount: number): void {
  for (let k = 0; k < binCount; k++) {
    const r = re[k];
    const m = im[k];
    if (r === 0 && m === 0) continue;
    const mag = Math.sqrt(r * r + m * m);
    if (mag <= BIN_MAGNITUDE_LIMIT) continue;
    const scale = BIN_MAGNITUDE_LIMIT / mag;
    re[k] = r * scale;
    im[k] = m * scale;
  }
}

/** Flush a denormal into zero BEFORE it is stored as recursive state. */
export function flushDenormal(x: number): number {
  return Math.abs(x) < 1e-20 ? 0 : x;
}

/**
 * Sample-accurate exponential smoothing applied ONCE PER BLOCK.
 *
 * `NEW-EFFECT-CHECKLIST` §4: the coefficient is per-sample but the application
 * is per-block, so the block-length correction is mandatory — `1 - exp(-blockLen /
 * (tc * sr))`. Without it a 1 s time constant runs ~100× slow inside 128-sample
 * blocks (the vowel/svfilter defect).
 */
export function blockSmoothingCoefficient(blockLen: number, timeConstantSec: number, sampleRate: number): number {
  if (!(timeConstantSec > 0) || !(sampleRate > 0)) return 0;
  return 1 - Math.exp(-blockLen / (timeConstantSec * sampleRate));
}

/** Clamp a feedback-like coefficient to the contractive bound ADR 0038, D5 sets. */
export function clampBinGain(g: number): number {
  if (!Number.isFinite(g)) return 0;
  return Math.min(MAX_BIN_GAIN, Math.max(-MAX_BIN_GAIN, g));
}
