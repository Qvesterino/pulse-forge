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
 * Cost per hop: 1 analysis FFT + 2 cepstrum transforms + 4 IFFT.
 *
 * Transients: phases are peak-locked (`phaseLock.ts`) — a precondition for
 * vocal intelligibility, not a quality pass.
 *
 * Determinism: no RNG. Every value derives from the frame counter and the
 * absolute sample position.
 */

import { FormantWarp } from "./cepstrum.js";
import { PhaseLocker } from "./phaseLock.js";
import { hannWindow, ifftInto, princarg } from "./fft.js";

export class HarmonyVoice {
  private n = 0;
  private half = 0;
  private hop = 512;
  private window: Float32Array = new Float32Array(0);

  private outPhase = new Float64Array(0);
  private magV = new Float64Array(0);
  private envWarp = new Float64Array(0);
  private re = new Float64Array(0);
  private im = new Float64Array(0);

  private warp = new FormantWarp();
  private locker = new PhaseLocker();

  private first = true;
  private primed = false;

  /** Current pitch ratio (target f0 / detected f0), clamped to ±12 st. */
  private ratio = 1;
  /** Current formant warp factor (1 = identity). */
  private alpha = 1;

  prepare(fftSize: number, hop: number): void {
    this.hop = hop;
    if (this.n === fftSize) return;
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.window = hannWindow(fftSize);
    this.outPhase = new Float64Array(this.half + 1);
    this.magV = new Float64Array(this.half + 1);
    this.envWarp = new Float64Array(this.half + 1);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.warp.prepare(fftSize);
    this.locker.prepare(fftSize);
    this.primed = false;
    this.first = true;
  }

  setTargets(ratio: number, alpha: number): void {
    this.ratio = Math.max(0.5, Math.min(2, Number.isFinite(ratio) ? ratio : 1));
    this.alpha = Math.max(0.5, Math.min(2, Number.isFinite(alpha) ? alpha : 1));
  }

  /** True once at least one frame has been rendered (phases are usable). */
  get started(): boolean {
    return this.primed;
  }

  reset(): void {
    this.first = true;
    this.primed = false;
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
    prevPhase: Float64Array,
    envLin: Float64Array,
    logEnv: Float64Array,
    outRing: Float32Array,
    outPos: number,
    ringMask: number,
  ): void {
    const n = this.n;
    const half = this.half;
    const hs = this.hop;

    this.warp.update(this.alpha, logEnv);
    this.warp.renderInto(logEnv, this.envWarp, this.alpha);

    const magV = this.magV;
    const outPhase = this.outPhase;

    // The PREVIOUS analysis phase is owned by the frame engine (it is the same
    // for every voice), so this voice only reads it.
    for (let k = 0; k <= half; k++) {
      // Excitation × warped envelope: the whole point of REZONANS.
      const env = envLin[k]!;
      magV[k] = (mag[k]! / env) * this.envWarp[k]!;

      if (this.first) {
        outPhase[k] = phase[k]!;
        continue;
      }
      const omega = (2 * Math.PI * k) / n;
      const dphi = princarg(phase[k]! - prevPhase[k]! - omega * hs);
      const inst = omega + dphi / hs;
      // The pitch shift lives HERE — the analysis advance never moves.
      outPhase[k] = outPhase[k]! + inst * hs * this.ratio;
    }

    this.primed = true;
    this.first = false;

    // Peak-lock before resynthesis (DC and Nyquist stay real and unphaseable).
    this.locker.findPeaks(magV, half);
    this.locker.applyLock(outPhase, half);
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
    for (let k = half + 1; k < n; k++) {
      re[k] = re[n - k]!;
      im[k] = -im[n - k]!;
    }

    ifftInto(re, im);

    const invN = 1 / n;
    const win = this.window;
    for (let i = 0; i < n; i++) {
      const pos = (outPos + i) & ringMask;
      outRing[pos] = outRing[pos]! + re[i]! * invN * win[i]!;
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
