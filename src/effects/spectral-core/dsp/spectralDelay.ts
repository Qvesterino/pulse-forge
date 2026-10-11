/**
 * PORTAL — per-bin spectral delay line with feedback.
 *
 * Each FFT bin owns an independent delay, so a ringing partial keeps its own
 * identity instead of smearing into its neighbours the way a fixed pitch shift
 * does. This is exactly the axis ADR 0038, D6 draws against `shimmer`: shimmer
 * moves a whole octave uniformly, PORTAL lets the user hold individual partials.
 *
 * LAYOUT
 * ------
 * Frame-major, not bin-major: `ring[frame * binCount + bin]`. The delay time is a
 * single global control, so every bin reads from the same frame offset — one
 * running index instead of `binCount` cursors, and sequential access per frame
 * instead of a stride of `maxFrames` per bin. Bin-major would thrash the cache
 * on exactly the loop that runs every hop.
 *
 * SAFETY (ADR 0038, D5)
 * ---------------------
 * Spectral feedback has no natural bound — kaskada's tanh drive is contractive
 * by construction, this is not. Three guards, in order:
 *   1. `feedback` is clamped to a contractive ceiling before it is ever used.
 *   2. Every bin is flushed denormal-clean BEFORE being stored.
 *   3. The caller re-checks the spectrum for non-finite values every frame.
 * A single Infinity reaching the ring propagates to every bin in every later
 * frame; the user recovers only by reloading the page.
 */

import { clampBinGain, flushDenormal } from "./stft";

/** Longest delay the DSP supports, in seconds. Mirrors the TIME param max. */
export const MAX_DELAY_SEC = 2;

/** Safety margin added to the ring so the write cursor always has a free slot. */
const RING_MARGIN = 2;
/** Keep the loop strictly contractive, even at the rack's 100% setting. */
const MAX_DELAY_FEEDBACK = 0.95;
const TWO_PI = 2 * Math.PI;

export interface SpectralDelayParams {
  /** Delay time in seconds (0.02 .. 2). */
  timeSec: number;
  /** Feedback amount 0..1. Clamped to a contractive ceiling internally. */
  feedback: number;
  /** Per-bin decay shaping, 0..1 — higher decays the low bins faster. */
  decay: number;
  /** Feedback region in semitones (-24..+24). */
  shiftSemitones: number;
  /** Per-bin phase drift, 0..1 — the "diffuse" texture. */
  diffuse: number;
  /** Hold the most recent analysed spectrum instead of following the input. */
  freeze: number;
}

export interface SpectralDelayMeters {
  /** Highest bin magnitude observed in the wet spectrum this frame. */
  peak: number;
  /** Fraction of bins whose magnitude exceeded the activity floor. */
  activity: number;
}

export class SpectralDelayBank {
  private readonly binCount: number;
  private readonly maxFrames: number;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  private writeFrame = 0;
  private readFrame = 0;
  private delayFrames = 1;

  /** Frozen spectrum for FREEZE mode — magnitudes and phases held across frames. */
  private readonly frozenRe: Float64Array;
  private readonly frozenIm: Float64Array;
  private frozen = false;

  /** Per-bin deterministic phase-drift accumulator (the DIFFUSE texture). */
  private readonly drift: Float32Array;

  private readonly meters: SpectralDelayMeters = { peak: 0, activity: 0 };

  constructor(binCount: number, sampleRate: number, hop: number) {
    this.binCount = binCount;
    this.maxFrames = Math.max(2, Math.ceil((MAX_DELAY_SEC * sampleRate) / hop) + RING_MARGIN);
    this.re = new Float32Array(this.maxFrames * binCount);
    this.im = new Float32Array(this.maxFrames * binCount);
    this.frozenRe = new Float64Array(binCount);
    this.frozenIm = new Float64Array(binCount);
    this.drift = new Float32Array(binCount);
  }

  /** Frames currently allocated — the soak harness asserts this stays put. */
  get ringFrames(): number {
    return this.maxFrames;
  }

  get delayFramesActive(): number {
    return this.delayFrames;
  }

  getMeters(): SpectralDelayMeters {
    return { peak: this.meters.peak, activity: this.meters.activity };
  }

  reset(): void {
    this.re.fill(0);
    this.im.fill(0);
    this.frozenRe.fill(0);
    this.frozenIm.fill(0);
    this.drift.fill(0);
    this.writeFrame = 0;
    this.readFrame = 0;
    this.frozen = false;
    this.meters.peak = 0;
    this.meters.activity = 0;
  }

  /**
   * Process one frame in place.
   *
   * @param re      lower-half spectrum, mutated in place with the wet signal
   * @param im      lower-half imaginary part, mutated in place
   * @param binCount meaningful bin count
   * @param params  the live control values
   * @param sampleRate context sample rate, for the time→frames conversion
   * @param hop     synthesis hop, for the same conversion
   */
  process(
    re: Float64Array,
    im: Float64Array,
    binCount: number,
    params: SpectralDelayParams,
    sampleRate: number,
    hop: number,
    passInputThrough = false,
  ): void {
    const n = Math.min(binCount, this.binCount);
    const maxFrames = this.maxFrames;

    this.updateDelayLength(params.timeSec, sampleRate, hop);

    // FREEZE: hold the analysed spectrum and feed the held signal back. The
    // input is not used, which is the point — a frozen frame sustains forever
    // and only the DELAY feedback decays it.
    if (params.freeze >= 0.5) {
      if (!this.frozen) {
        for (let k = 0; k < n; k++) {
          this.frozenRe[k] = re[k];
          this.frozenIm[k] = im[k];
        }
        this.frozen = true;
      }
      for (let k = 0; k < n; k++) {
        re[k] = this.frozenRe[k];
        im[k] = this.frozenIm[k];
      }
    } else if (this.frozen) {
      this.frozen = false;
    }

    const writeBase = this.writeFrame * this.binCount;
    const readBase = this.readFrame * this.binCount;
    const shiftRatio = Math.pow(2, clampSemitones(params.shiftSemitones) / 12);
    // Upward shifts spread each source bin across more output bins. Reduce both
    // feedback and output by that expansion factor so a high SHIFT cannot build
    // a brighter but progressively louder spectral staircase.
    const shiftCompensation = 1 / Math.max(1, shiftRatio);
    const feedback = Math.min(MAX_DELAY_FEEDBACK, clampBinGain(Math.max(0, params.feedback))) * shiftCompensation;
    const diffuse = params.diffuse;
    const decayShape = params.decay;

    let peak = 0;
    let active = 0;

    for (let k = 0; k < n; k++) {
      const srcRe = re[k];
      const srcIm = im[k];

      // Feedback is read from a transposed source bin. Positive SHIFT moves a
      // partial upward: output bin k reads the lower source bin k / ratio. A
      // negative shift maps a partial downward by reading a higher source bin.
      //
      // Source mappings beyond Nyquist get silence, NOT the last bin. Clamping
      // to `n - 1` would point hundreds of bins at the same state and pump it
      // hundreds of times over — measured 7030× input peak at +12 semitones.
      const shifted = Math.round(k / shiftRatio);
      const inRange = shifted >= 0 && shifted < n;
      const srcBin = inRange ? shifted : 0;
      const rIdx = readBase + srcBin;
      const dRe = inRange ? this.re[rIdx] : 0;
      const dIm = inRange ? this.im[rIdx] : 0;

      // DECAY shapes the feedback per bin: a one-pole tilt that removes more low
      // end as the control rises, so a long tail thins out into the top rather
      // than turning into a muddy low rumble.
      const shape = decayTilt(k, n, decayShape);
      const fbk = feedback * shape;

      let shiftedRe = dRe;
      let shiftedIm = dIm;

      // DIFFUSE: a deterministic per-bin phase rotation. The accumulator starts
      // at zero and advances by a fixed increment per frame, so the texture is a
      // pure function of (frames elapsed, diffuse) — identical in the live and
      // offline paths, and identical across reloads. It carries no RNG and no
      // persisted seed, so it is deterministic WITHOUT depending on the effect
      // instance id. Wrap the phase each frame: an unbounded Float32 accumulator
      // loses phase precision after long sessions even though the rotation is
      // periodic.
      if (diffuse > 0) {
        let ang = this.drift[k]! + diffuse * 0.35 + 1e-4;
        if (ang >= TWO_PI) ang -= TWO_PI;
        this.drift[k] = ang;
        ang = this.drift[k]!;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const nr = shiftedRe * c - shiftedIm * s;
        shiftedIm = shiftedRe * s + shiftedIm * c;
        shiftedRe = nr;
      }

      const wetRe = shiftedRe * shiftCompensation;
      const wetIm = shiftedIm * shiftCompensation;

      // A mode may keep the delay ring warm while taking its output from a
      // parallel process (PORTAL's RESONATOR). In that case retain the input
      // spectrum here, while still writing it into the ring below.
      re[k] = passInputThrough ? srcRe : wetRe;
      im[k] = passInputThrough ? srcIm : wetIm;

      // Flush BEFORE storing (NEW-EFFECT-CHECKLIST §4): storing the un-flushed
      // value leaves a subnormal in the ring that taxes every following frame.
      this.re[writeBase + k] = flushDenormal(srcRe + shiftedRe * fbk);
      this.im[writeBase + k] = flushDenormal(srcIm + shiftedIm * fbk);

      const mag = Math.abs(wetRe) + Math.abs(wetIm);
      if (mag > peak) peak = mag;
      if (mag > 1e-4) active++;
    }

    this.writeFrame = this.writeFrame + 1 < maxFrames ? this.writeFrame + 1 : 0;
    this.readFrame = this.readFrame + 1 < maxFrames ? this.readFrame + 1 : 0;

    this.meters.peak = peak;
    this.meters.activity = n > 0 ? active / n : 0;
  }

  /**
   * Recompute the read offset for a new delay time. Only shifts the cursor —
   * the ring contents are deliberately preserved so changing TIME warps the
   * existing tail instead of restarting it.
   */
  private updateDelayLength(timeSec: number, sampleRate: number, hop: number): void {
    const t = Number.isFinite(timeSec) ? Math.min(MAX_DELAY_SEC, Math.max(0, timeSec)) : 0;
    const frames = Math.round((t * sampleRate) / hop);
    this.delayFrames = Math.min(this.maxFrames - 1, Math.max(1, frames));
    this.readFrame = (this.writeFrame - this.delayFrames + this.maxFrames) % this.maxFrames;
  }
}

/** Clamp the pitch shift into the shipped ±24 st range. */
function clampSemitones(st: number): number {
  if (!Number.isFinite(st)) return 0;
  return Math.min(24, Math.max(-24, st));
}

/**
 * Feedback tilt across the spectrum. `shape = 0` is flat (every bin feeds back
 * equally); `shape = 1` removes the lowest octaves so the tail thins upward.
 */
function decayTilt(bin: number, binCount: number, shape: number): number {
  if (shape <= 0) return 1;
  const norm = bin / (binCount - 1);
  const knee = shape * 0.35;
  if (norm <= knee) return 1 - norm / Math.max(1e-6, knee);
  return 1 - shape * 0.5 * norm;
}
