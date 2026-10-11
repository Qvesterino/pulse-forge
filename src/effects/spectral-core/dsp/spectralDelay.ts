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
  /** Deterministic seed for the phase drift (persisted seed contract). */
  seed: number;
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
  private driftPos = 0;

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
    this.driftPos = 0;
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

    const feedback = clampBinGain(Math.max(0, params.feedback));
    const writeBase = this.writeFrame * this.binCount;
    const readBase = this.readFrame * this.binCount;
    const shiftRatio = Math.pow(2, clampSemitones(params.shiftSemitones) / 12);
    const diffuse = params.diffuse;
    const decayShape = params.decay;

    let peak = 0;
    let active = 0;

    for (let k = 0; k < n; k++) {
      const srcRe = re[k];
      const srcIm = im[k];

      // Feedback is read from a SHIFTED bin: a positive shift folds the fed-back
      // region up an octave so a sustained partial keeps rising instead of just
      // repeating. This is what makes it a spectral delay rather than a comb.
      //
      // Bins that shift ABOVE Nyquist get silence, NOT the last bin. Clamping
      // `shifted` to `n - 1` would point hundreds of bins at the same state and
      // pump it hundreds of times over — measured 7030× input peak at +12
      // semitones. Physically, energy that shifted past Nyquist is simply gone,
      // so silence is both correct and stable.
      const shifted = Math.round(k * shiftRatio);
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

      let wetRe = dRe;
      let wetIm = dIm;

      // DIFFUSE: a deterministic per-bin phase rotation. Seeded from the
      // persisted id, so the texture is stable across reloads and identical in
      // the live and offline paths.
      if (diffuse > 0) {
        this.drift[k] = this.drift[k] + diffuse * 0.35 + 1e-4;
        const ang = this.drift[k];
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const nr = wetRe * c - wetIm * s;
        wetIm = wetRe * s + wetIm * c;
        wetRe = nr;
      }

      // Wet is the delayed signal only; the fresh analysis goes into the ring.
      // Dry/wet mixing belongs to the processor, one level above the spectrum.
      re[k] = wetRe;
      im[k] = wetIm;

      // Flush BEFORE storing (NEW-EFFECT-CHECKLIST §4): storing the un-flushed
      // value leaves a subnormal in the ring that taxes every following frame.
      this.re[writeBase + k] = flushDenormal(srcRe + wetRe * fbk);
      this.im[writeBase + k] = flushDenormal(srcIm + wetIm * fbk);

      const mag = Math.abs(wetRe) + Math.abs(wetIm);
      if (mag > peak) peak = mag;
      if (mag > 1e-4) active++;
    }

    this.writeFrame = this.writeFrame + 1 < maxFrames ? this.writeFrame + 1 : 0;
    this.readFrame = this.readFrame + 1 < maxFrames ? this.readFrame + 1 : 0;
    this.driftPos = (this.driftPos + 1) % n;

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
