/**
 * REZONANS — shared frame analysis.
 *
 * ONE STFT lattice serves the entire device. Every harmony voice consumes the
 * same magnitude spectrum, the same vocal-tract envelope and the same f0; the
 * voices differ only in the phase-increment multiplier (pitch) and the warp
 * factor (formant). See `voice.ts` for why the analysis advance never moves.
 *
 * Latency: the streaming overlap-add path emits a transient's peak at N - 1
 * samples after its source event. The reported latency follows that measured
 * wet-path delay so PDC and the latency-matched source path stay aligned.
 */

import { CepstralEnvelope } from "./cepstrum.js";
import { PitchTracker } from "./pitchTrack.js";
import { fft, hannWindow } from "./fft.js";

const ENV_MIN = 1e-6;
const ENV_MAX = 1e6;
/** Envelope refresh stride in frames (see ADR 0040 decision 4). */
const ENVELOPE_STRIDE = 2;
/** Keep most of a fresh estimate immediate while smoothing its last small step. */
const ENVELOPE_REFRESH_BLEND = 0.9;

export class FrameEngine {
  private sampleRate = 48000;
  private n = 0;
  private half = 0;
  private hop = 512;

  /** Input ring: N samples of history plus guard samples for safe indexing. */
  private inRing = new Float32Array(0);
  private inMask = 0;
  private writePos = 0;
  private sinceHop = 0;

  private frame = new Float32Array(0);
  private window: Float32Array = new Float32Array(0);

  private re = new Float64Array(0);
  private im = new Float64Array(0);

  /** Current frame — public because voices read it directly. */
  mag = new Float64Array(0);
  phase = new Float64Array(0);
  /** Previous frame's analysis phase: read-only for voices, owned here. */
  private prevPhase = new Float64Array(0);
  private havePrev = false;

  /** Linear envelope of the current frame (geometric mean 1). */
  envLin = new Float64Array(0);
  /** Log envelope interpolated between cepstral refreshes, consumed by voices. */
  renderLogEnv = new Float64Array(0);

  /** Previous cepstral estimate used as the start of a two-frame glide. */
  private previousLogEnv = new Float64Array(0);

  private env = new CepstralEnvelope();
  private pitch = new PitchTracker();

  private frameCount = 0;
  private lastHz = 0;
  private lastClarity = 0;

  get f0(): number {
    return this.lastHz;
  }

  get clarity(): number {
    return this.lastClarity;
  }

  get frames(): number {
    return this.frameCount;
  }

  get halfSpectrum(): number {
    return this.half;
  }

  get fftSize(): number {
    return this.n;
  }

  get synthesisHop(): number {
    return this.hop;
  }

  /** Measured wet-path transient latency in samples. */
  get latencySamples(): number {
    return Math.max(0, this.n - 1);
  }

  get previousPhase(): Float64Array {
    return this.prevPhase;
  }

  get hasPreviousFrame(): boolean {
    return this.havePrev;
  }

  get envelope(): CepstralEnvelope {
    return this.env;
  }

  prepare(sampleRate: number, fftSize: number, hop: number): void {
    this.sampleRate = sampleRate;
    this.hop = Math.max(16, hop);
    // Quefrency is expressed in seconds, so the envelope estimator must see
    // every context's sample rate even when the FFT size stays unchanged.
    this.env.prepare(this.sampleRate, fftSize);
    if (this.n === fftSize) {
      this.pitch.prepare(this.sampleRate, this.n, 70, 800);
      return;
    }

    this.n = fftSize;
    this.half = fftSize >> 1;

    let ringLen = 1;
    while (ringLen < fftSize + 8) ringLen <<= 1;
    this.inRing = new Float32Array(ringLen);
    this.inMask = ringLen - 1;

    this.frame = new Float32Array(fftSize);
    this.window = hannWindow(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.mag = new Float64Array(this.half + 1);
    this.phase = new Float64Array(this.half + 1);
    this.prevPhase = new Float64Array(this.half + 1);
    this.envLin = new Float64Array(this.half + 1);
    this.envLin.fill(1);
    this.renderLogEnv = new Float64Array(this.half + 1);
    this.previousLogEnv = new Float64Array(this.half + 1);

    this.pitch.prepare(this.sampleRate, this.n, 70, 800);

    this.writePos = 0;
    this.sinceHop = 0;
    this.frameCount = 0;
    this.havePrev = false;
    this.lastHz = 0;
    this.lastClarity = 0;
  }

  setPitchRange(minHz: number, maxHz: number): void {
    this.pitch.prepare(this.sampleRate, this.n, minHz, maxHz);
  }

  setQuefrencyCut(sec: number): void {
    this.env.setQuefrencyCut(sec);
  }

  reset(): void {
    this.inRing.fill(0);
    this.writePos = 0;
    this.sinceHop = 0;
    this.frameCount = 0;
    this.havePrev = false;
    this.mag.fill(0);
    this.phase.fill(0);
    this.prevPhase.fill(0);
    this.envLin.fill(1);
    this.renderLogEnv.fill(0);
    this.previousLogEnv.fill(0);
    this.env.reset();
    this.pitch.reset();
    this.lastHz = 0;
    this.lastClarity = 0;
  }

  /** Push one mono sample; returns true when a synthesis frame is due. */
  push(sample: number): boolean {
    this.inRing[this.writePos & this.inMask] = sample;
    this.writePos++;
    this.sinceHop++;
    if (this.sinceHop < this.hop) return false;
    this.sinceHop = 0;
    this.analyze();
    return true;
  }

  private analyze(): void {
    const n = this.n;
    const half = this.half;
    const ring = this.inRing;
    const mask = this.inMask;
    const start = this.writePos - n;
    const frame = this.frame;
    const win = this.window;
    const re = this.re;
    const im = this.im;

    for (let i = 0; i < n; i++) frame[i] = ring[(start + i) & mask]!;
    for (let i = 0; i < n; i++) {
      re[i] = frame[i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);

    const mag = this.mag;
    const phase = this.phase;
    for (let k = 0; k <= half; k++) {
      const rr = re[k]!;
      const ii = im[k]!;
      mag[k] = Math.sqrt(rr * rr + ii * ii);
      phase[k] = Math.atan2(ii, rr);
    }

    // Refresh every other frame to halve cepstrum cost, then glide between
    // estimates in log space. Holding a fresh estimate for an entire hop pair
    // creates a small but avoidable step in the spectral colour of the voice.
    const hadEnvelope = this.env.ready;
    const refreshEnvelope = this.frameCount % ENVELOPE_STRIDE === 0 || !hadEnvelope;
    if (refreshEnvelope) {
      if (hadEnvelope) this.previousLogEnv.set(this.env.logEnv);
      this.env.compute(mag, half);
      // First frame and a changed lifter have no valid prior estimate to glide
      // from, so seed both ends with the newly computed envelope.
      if (!hadEnvelope) this.previousLogEnv.set(this.env.logEnv);
    }
    if (this.env.ready) {
      const logEnv = this.env.logEnv;
      // Apply most of a fresh estimate immediately; the next frame lands on it.
      // This avoids an audible envelope step without dulling strong formant shifts.
      const blend = hadEnvelope && refreshEnvelope ? ENVELOPE_REFRESH_BLEND : 1;
      const previousLogEnv = this.previousLogEnv;
      const renderLogEnv = this.renderLogEnv;
      for (let k = 0; k <= half; k++) {
        const interpolatedLog = previousLogEnv[k]! + (logEnv[k]! - previousLogEnv[k]!) * blend;
        renderLogEnv[k] = interpolatedLog;
        const v = Math.exp(interpolatedLog);
        this.envLin[k] = v < ENV_MIN ? ENV_MIN : v > ENV_MAX ? ENV_MAX : v;
      }
    }

    const est = this.pitch.detect(ring, this.inRing.length, this.writePos);
    this.lastHz = est.hz;
    this.lastClarity = est.clarity;
    this.frameCount++;
  }

  /**
   * Called AFTER every voice has rendered, so the next frame's phase
   * difference is measured against this frame rather than a stale copy.
   */
  commitFrame(): void {
    const prev = this.prevPhase;
    const cur = this.phase;
    for (let k = 0; k <= half(this.n); k++) prev[k] = cur[k]!;
    this.havePrev = true;
  }
}

function half(n: number): number {
  return n >> 1;
}
