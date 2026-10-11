/**
 * REZONANS — YIN pitch tracker.
 *
 * A faithful TypeScript port of the detector that `pitchcorrect-processor.js`
 * already ships (lines 73-174), including its calibrated constants and the two
 * biases its golden vectors caught:
 *
 *   - **CMND**, not a raw difference-function minimum. A perfectly periodic
 *     tone has near-zero differences at EVERY period multiple, so a raw picker
 *     lands an octave low (330 Hz detected as 165 Hz).
 *   - **Parabolic interpolation around the local d minimum**, not around the
 *     threshold pick. The threshold lands systematically BEFORE the true
 *     period (~-1.4 % flat on a pure tone); re-centring removes that bias.
 *
 * It is ported rather than imported because there is no shared DSP module
 * between `src/audio-worklets/*.js` (plain JS, served raw) and
 * `src/effects/*-core/dsp/*.ts` (bundled by esbuild) — the same reason
 * `bass-harmonic-processor.js` carries its own private `yinDetect` copy.
 * If the two ever drift, REZONANS's own goldens are what catch it.
 *
 * Allocation-free after `prepare()`: the scratch buffers are sized once and
 * reused, because this runs on the audio thread every HOP samples and a
 * per-call allocation would churn the GC inside the render callback.
 */

/** Clarity gate reference: pure tone ~0.85, chord mush ~0.61, noise ~0.12. */
export const DEFAULT_CLARITY_THRESHOLD = 0.75;

/** YIN absolute threshold on the normalized difference function. */
const YIN_THRESHOLD = 0.05;
/** Below this RMS there is nothing to track (silence gate). */
const SILENCE_RMS = 1e-4;

export interface PitchEstimate {
  /** Detected fundamental in Hz; 0 means "no confident pitch". */
  hz: number;
  /** 0..1 confidence derived from the CMND value at the picked lag. */
  clarity: number;
}

const NO_PITCH: PitchEstimate = { hz: 0, clarity: 0 };

export class PitchTracker {
  private sampleRate = 48000;
  private windowW = 2048;
  private minHz = 70;
  private maxHz = 800;

  private x = new Float32Array(0);
  private d = new Float32Array(0);
  private nd = new Float32Array(0);

  private lastHz = 0;
  private lastClarity = 0;
  /**
   * Preallocated result object. The detector runs on the audio thread every
   * hop; returning a fresh literal each time would allocate ~47 objects/s
   * inside the render callback for no reason. Callers must read it, never
   * retain it.
   */
  private result: PitchEstimate = { hz: 0, clarity: 0 };

  get hz(): number {
    return this.lastHz;
  }

  get clarity(): number {
    return this.lastClarity;
  }

  prepare(sampleRate: number, windowW = 2048, minHz = 70, maxHz = 800): void {
    this.sampleRate = sampleRate;
    this.windowW = Math.max(256, windowW);
    this.minHz = Math.max(20, minHz);
    this.maxHz = Math.max(this.minHz + 1, maxHz);

    const maxLag = Math.min(Math.floor(this.sampleRate / this.minHz), this.windowW - 64);
    this.x = new Float32Array(this.windowW);
    this.d = new Float32Array(maxLag + 2);
    this.nd = new Float32Array(maxLag + 2);
    this.reset();
  }

  reset(): void {
    this.lastHz = 0;
    this.lastClarity = 0;
  }

  /**
   * Detect over the most recent `windowW` samples of a ring buffer whose
   * `writePos` points past the last written sample.
   *
   * Returns a shared frozen-shape literal on failure rather than allocating —
   * callers must not mutate the result.
   */
  detect(ring: Float32Array, ringLen: number, writePos: number): PitchEstimate {
    const sr = this.sampleRate;
    const windowW = this.windowW;
    const minHz = this.minHz;
    const maxHz = this.maxHz;

    const maxLag = Math.min(Math.floor(sr / minHz), windowW - 64);
    const minLag = Math.max(2, Math.ceil(sr / maxHz));
    const m = windowW - maxLag; // correlation length
    if (m < 64 || maxLag <= minLag) {
      this.lastHz = 0;
      this.lastClarity = 0;
      return NO_PITCH;
    }

    const x = this.x;
    const d = this.d;
    const nd = this.nd;

    // Unwrap the window out of the ring, and measure its level in one pass.
    const start = writePos - windowW;
    let rms = 0;
    for (let i = 0; i < windowW; i++) {
      let p = (start + i) % ringLen;
      if (p < 0) p += ringLen;
      const v = ring[p]!;
      x[i] = v;
      rms += v * v;
    }
    rms = Math.sqrt(rms / windowW);
    if (rms < SILENCE_RMS) {
      this.lastHz = 0;
      this.lastClarity = 0;
      return NO_PITCH;
    }

    // YIN difference function.
    let runningSum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < m; i++) {
        const diff = x[i]! - x[i + lag]!;
        sum += diff * diff;
      }
      d[lag] = sum;
      runningSum += sum;
    }
    if (runningSum <= 0) {
      this.lastHz = 0;
      this.lastClarity = 0;
      return NO_PITCH;
    }

    // Cumulative mean normalized difference.
    let cumulative = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      cumulative += d[lag]!;
      nd[lag] = cumulative > 0 ? (d[lag]! * (lag - minLag + 1)) / cumulative : Infinity;
    }

    // Absolute-threshold pick: the SMALLEST lag under the threshold is the
    // fundamental. Noisy live vocals may abstain here — abstaining is the
    // safe failure, because the caller's response is to pass the voice
    // through, never to apply a wrong correction.
    let picked = -1;
    let pickedValue = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (nd[lag]! < YIN_THRESHOLD) {
        picked = lag;
        pickedValue = nd[lag]!;
        break;
      }
      if (nd[lag]! < pickedValue) pickedValue = nd[lag]!;
    }
    if (picked < 0) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (nd[lag] === pickedValue) {
          picked = lag;
          break;
        }
      }
    }
    if (picked < 0) {
      this.lastHz = 0;
      this.lastClarity = 0;
      return NO_PITCH;
    }
    const clarity = Math.max(0, Math.min(1, 1 - pickedValue));

    // Parabolic interpolation around the LOCAL d minimum.
    let center = picked;
    if (picked > minLag && d[picked - 1]! < d[picked]!) center = picked - 1;
    else if (picked < maxLag && d[picked + 1]! < d[picked]!) center = picked + 1;
    let lagF = center;
    if (center > minLag && center < maxLag) {
      const a = d[center - 1]!;
      const b = d[center]!;
      const c = d[center + 1]!;
      const denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-12) lagF = center + (c - a) / denom;
    }

    const hz = sr / lagF;
    if (!(hz >= minHz) || !(hz <= maxHz)) {
      this.lastHz = 0;
      this.lastClarity = 0;
      return NO_PITCH;
    }
    this.lastHz = hz;
    this.lastClarity = clarity;
    this.result.hz = hz;
    this.result.clarity = clarity;
    return this.result;
  }
}
