/**
 * REZONANS — one harmony voice: formant warp + pitch shift + phase locking.
 *
 * ARCHITECTURAL NOTE (this is the decision the whole CPU budget rests on).
 *
 * A phase vocoder can pitch-shift in two equivalent-looking ways:
 *
 *   (a) move the ANALYSIS position (advance = hop × ratio), or
 *   (b) scale the SYNTHESIS phase increment (increment = inst × ratio) while
 *       the analysis advances at a constant hop.
 *
 * (a) forces every voice to own its own analysis position, which means its own
 * FFT, its own cepstral envelope and its own pitch detection — four independent
 * analyses per hop, and worse, four DIVERGENT analyses: a voice running at
 * ratio 0.5 reads the singer from 2 s behind while the reference reads "now",
 * so its f0 and its vocal-tract envelope belong to a different moment than the
 * samples it is shifting. Harmonised notes then drift out of tune with each
 * other exactly as they become musically interesting.
 *
 * (b) keeps ONE analysis lattice at a constant hop for the whole device. The
 * envelope, the f0 and the STFT are computed once per frame and every voice
 * consumes them, differing only in its phase-increment multiplier and its
 * formant warp. That is also why per-voice formant shift is free: the two
 * axes are separated before synthesis rather than tangled inside it.
 *
 * Cost per hop: 1 analysis FFT + 2 cepstrum transforms + up to 4 packed
 * inverse real FFTs (each a complex FFT of half the window length).
 *
 * Transients: phases are peak-locked (`phaseLock.ts`) — a precondition for
 * vocal intelligibility, not a quality pass.
 *
 * Determinism: no RNG. Every value derives from the frame counter and the
 * absolute sample position.
 */

import { FormantWarp } from "./cepstrum.js";
import { PhaseLocker } from "./phaseLock.js";
import { hannWindow, ifftRealInto } from "./fft.js";

export class HarmonyVoice {
  private static readonly FORMANT_SMOOTHING_SECONDS = 0.015;

  private n = 0;
  private half = 0;
  private hop = 512;
  private formantSmooth = 0;
  private window: Float32Array = new Float32Array(0);

  private outPhase = new Float64Array(0);
  private magV = new Float64Array(0);
  private phaseV = new Float64Array(0);
  private envWarp = new Float64Array(0);
  private re = new Float64Array(0);
  private im = new Float64Array(0);
  private ifftScratchRe = new Float64Array(0);
  private ifftScratchIm = new Float64Array(0);

  private warp = new FormantWarp();
  private locker = new PhaseLocker();

  private first = true;
  private primed = false;

  /** Current pitch ratio (target f0 / detected f0), clamped to ±12 st. */
  private ratio = 1;
  /** Current formant warp factor (1 = identity). */
  private alphaTarget = 1;
  private alphaSm = 1;

  prepare(fftSize: number, hop: number, sampleRate: number): void {
    this.hop = hop;
    this.formantSmooth = 1 - Math.exp(-hop / (HarmonyVoice.FORMANT_SMOOTHING_SECONDS * sampleRate));
    if (this.n === fftSize) return;
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.window = hannWindow(fftSize);
    this.outPhase = new Float64Array(this.half + 1);
    this.magV = new Float64Array(this.half + 1);
    this.phaseV = new Float64Array(this.half + 1);
    this.envWarp = new Float64Array(this.half + 1);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.ifftScratchRe = new Float64Array(this.half);
    this.ifftScratchIm = new Float64Array(this.half);
    this.warp.prepare(fftSize);
    this.locker.prepare(fftSize);
    this.primed = false;
    this.first = true;
  }

  setTargets(ratio: number, alpha: number): void {
    this.ratio = Math.max(0.5, Math.min(2, Number.isFinite(ratio) ? ratio : 1));
    this.alphaTarget = Math.max(0.5, Math.min(2, Number.isFinite(alpha) ? alpha : 1));
  }

  /** True once at least one frame has been rendered (phases are usable). */
  get started(): boolean {
    return this.primed;
  }

  reset(): void {
    this.first = true;
    this.primed = false;
    this.alphaSm = 1;
    this.outPhase.fill(0);
    this.locker.reset();
  }

  /**
   * Render one synthesis frame into the SHARED overlap-add rings.
   *
   * `outRing`/`winRing` are shared by every voice because the synthesis hop is
   * identical for all of them, so the window normalisation is identical too.
   * Sharing them is what makes per-voice formant cost nothing but arithmetic.
   */
  renderFrame(
    mag: Float64Array,
    phase: Float64Array,
    phaseAdvance: Float64Array,
    phaseDelta: Float64Array,
    envLin: Float64Array,
    logEnv: Float64Array,
    outRing: Float32Array,
    outPos: number,
    ringMask: number,
  ): void {
    const n = this.n;
    const half = this.half;
    const hs = this.hop;

    // Glide the formant warp in semitone space: abrupt automation no longer
    // rebuilds the spectral map at a single frame, while static presets are
    // seeded at their saved value on the first frame below.
    if (this.first) {
      this.alphaSm = this.alphaTarget;
    } else {
      const targetSemitones = 12 * Math.log2(this.alphaTarget);
      const currentSemitones = 12 * Math.log2(this.alphaSm);
      this.alphaSm = Math.pow(2, (currentSemitones + (targetSemitones - currentSemitones) * this.formantSmooth) / 12);
    }
    const envWarp = this.alphaSm === 1 ? envLin : this.envWarp;
    if (envWarp !== envLin) {
      // The identity formant setting already has its linear envelope from
      // FrameEngine. Re-evaluating exp(logEnv[k]) and copying it for every
      // voice and bin is redundant work in the common neutral-formant case.
      this.warp.update(this.alphaSm, logEnv);
      this.warp.renderInto(logEnv, this.envWarp, this.alphaSm);
    }

    const magV = this.magV;
    const outPhase = this.outPhase;
    const phaseV = this.phaseV;
    const ratio = this.ratio;

    // Resample the shared excitation spectrum onto the destination pitch grid.
    // Scaling phase increments alone leaves spectral energy at the source-bin
    // locations; that shortcut loses the target note at Balanced/Fine window
    // sizes. The envelope stays on the destination grid so formant and pitch
    // remain independent.
    for (let k = 0; k <= half; k++) {
      const sourceBin = k / ratio;
      if (sourceBin > half) {
        magV[k] = 0;
        phaseV[k] = 0;
        outPhase[k] = 0;
        continue;
      }

      const lo = Math.floor(sourceBin);
      const hi = Math.min(half, lo + 1);
      const frac = sourceBin - lo;
      const sourcePhase = phase[lo]! + phaseDelta[lo]! * frac;
      phaseV[k] = sourcePhase;

      // Excitation × warped destination envelope: the whole point of REZONANS.
      const sourceMagnitude = mag[lo]! + (mag[hi]! - mag[lo]!) * frac;
      const sourceEnvelope = envLin[lo]! + (envLin[hi]! - envLin[lo]!) * frac;
      magV[k] = (sourceMagnitude / sourceEnvelope) * envWarp[k]!;

      if (this.first) {
        outPhase[k] = sourcePhase;
        continue;
      }
      const instLo = phaseAdvance[lo]!;
      const instHi = phaseAdvance[hi]!;
      const inst = instLo + (instHi - instLo) * frac;
      outPhase[k] = outPhase[k]! + inst * hs * ratio;
    }

    this.primed = true;
    this.first = false;

    // Peak-lock before resynthesis when a spectral transformation is active.
    // At the exact identity point the unmodified propagated phases are already
    // the correct solution; applying a peak lock there can add needless phase
    // motion to a signal that should round-trip unchanged.
    if (Math.abs(this.ratio - 1) > 1e-6 || Math.abs(this.alphaSm - 1) > 1e-6) {
      this.locker.findPeaks(magV, half);
      this.locker.applyLock(outPhase, phaseV, half);
    }
    outPhase[0] = 0;
    outPhase[half] = 0;

    const re = this.re;
    const im = this.im;
    for (let k = 0; k <= half; k++) {
      const m = magV[k]!;
      const p = outPhase[k]!;
      re[k] = Math.cos(p) * m;
      im[k] = Math.sin(p) * m;
    }
    re[0] = magV[0]!;
    im[0] = 0;
    re[half] = magV[half]!;
    im[half] = 0;
    ifftRealInto(re, im, this.ifftScratchRe, this.ifftScratchIm);

    const win = this.window;
    for (let i = 0; i < n; i++) {
      const pos = (outPos + i) & ringMask;
      outRing[pos] = outRing[pos]! + re[i]! * win[i]!;
    }
  }

  /** Window length — the bus owns the shared window-sum accumulation. */
  get windowLength(): number {
    return this.n;
  }

  /** Read the accumulated OLA output at `pos`, normalized by the window sum. */
  static readOla(outRing: Float32Array, winRing: Float32Array, pos: number, mask: number): number {
    const w = winRing[pos & mask]!;
    if (w <= 1e-9) return 0;
    return outRing[pos & mask]! / w;
  }
}
