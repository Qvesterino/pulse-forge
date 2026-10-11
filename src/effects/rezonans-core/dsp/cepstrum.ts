/**
 * REZONANS — cepstral spectral envelope + frequency-axis warp.
 *
 * This is the module that makes REZONANS a formant shifter rather than a
 * pitch shifter with a loudness knob. Per frame it separates the spectrum
 * into
 *
 *   E(f)  the vocal-tract envelope  (low quefrency, smooth in frequency)
 *   R(f) = X(f) / E(f)             the excitation (the harmonic comb)
 *
 * then rebuilds `X' = R · E'` where `E'(f) = E(f / α)` — the same excitation,
 * re-coloured by a different vocal tract. α = 2^(semitones/12), so α > 1
 * makes the voice physically larger and α < 1 smaller, INDEPENDENT of pitch.
 *
 * Two details that are the difference between "works" and "sounds like a box":
 *
 * 1. The warp samples the envelope on a LOG-frequency axis. Linear
 *    interpolation makes the perceived shift frequency-dependent — the low
 *    formants barely move while the top end races.
 * 2. The edges extrapolate by EDGE SLOPE, never zero-padding. Below ~80 Hz and
 *    above ~8 kHz there is no meaningful cepstral envelope; clamping the slope
 *    of the nearest valid bins keeps the warp continuous, whereas zero-padding
 *    collapses the shifted voice at both band ends into a mid-scoped, boxy
 *    timbre that users describe as "phasey".
 */

import { fft, ifftInto } from "./fft.js";

/** Magnitude floor for the log — keeps a silent bin from becoming -Infinity. */
const LOG_FLOOR = 1e-9;
/** Clamp on the final warped envelope, so R = X/E can never explode. */
const ENV_MIN = 1e-6;
const ENV_MAX = 1e6;
/** Bins used to estimate the edge slopes for extrapolation. */
const EDGE_BINS = 4;

/**
 * Real-cepstrum envelope estimator over a fixed FFT size.
 *
 * Owns every scratch buffer; `compute()` allocates nothing after `prepare()`.
 */
export class CepstralEnvelope {
  private n = 0;
  private half = 0;
  /** Symmetric full-length log-magnitude spectrum (FFT input). */
  private logFull = new Float64Array(0);
  /** Cepstrum / liftered log-envelope workspace (real + imaginary). */
  private cepstrum = new Float64Array(0);
  private cepImag = new Float64Array(0);
  /** Output: log envelope over the half spectrum, geometric mean removed. */
  logEnv = new Float64Array(0);
  private sampleRate = 48000;
  private quefrencyCutSec = 0.0025;
  private primed = false;

  prepare(sampleRate: number, fftSize: number): void {
    if (this.n === fftSize) {
      this.sampleRate = sampleRate;
      return;
    }
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.logFull = new Float64Array(fftSize);
    this.cepstrum = new Float64Array(fftSize);
    this.cepImag = new Float64Array(fftSize);
    this.logEnv = new Float64Array(this.half + 1);
    this.primed = false;
  }

  /**
   * Quefrency cutoff of the lifter, in seconds. LOWER tracks the singer's
   * moving articulators more closely (and noisier); HIGHER gives a smoother,
   * more "vintage" envelope. Exposed as the `envelopeSmooth` parameter.
   */
  setQuefrencyCut(sec: number): void {
    const clamped = Math.max(0.0005, Math.min(0.006, sec));
    if (Math.abs(clamped - this.quefrencyCutSec) < 1e-6) return;
    this.quefrencyCutSec = clamped;
    // The lifter mask changes, so the cached envelope is stale.
    this.primed = false;
  }

  get quefrencyCut(): number {
    return this.quefrencyCutSec;
  }

  /**
   * Estimate the log envelope from a half-spectrum magnitude array.
   * `mag` must hold at least `half + 1` bins.
   */
  compute(mag: Float64Array, half: number): void {
    const n = this.n;
    if (n === 0 || half !== this.half) return;

    // 1. Symmetric full-length log-magnitude spectrum.
    const logFull = this.logFull;
    logFull[0] = Math.log(Math.max(mag[0]!, LOG_FLOOR));
    logFull[this.half] = Math.log(Math.max(mag[this.half]!, LOG_FLOOR));
    for (let k = 1; k < this.half; k++) {
      const v = Math.log(Math.max(mag[k]!, LOG_FLOOR));
      logFull[k] = v;
      logFull[n - k] = v;
    }

    // 2. Real cepstrum = IFFT of the log-magnitude spectrum. The inverse
    //    needs a SEPARATE imaginary buffer — aliasing them would conjugate
    //    the spectrum into nonsense in place.
    const cep = this.cepstrum;
    const cepIm = this.cepImag;
    cep.set(logFull);
    cepIm.fill(0);
    ifftInto(cep, cepIm);

    // 3. Lifter: keep only low quefrency bins (the vocal tract is a short
    //    filter — roughly 2-3 ms), mirrored so the result stays real and even.
    const q = Math.max(1, Math.min(this.half - 1, Math.round(this.quefrencyCutSec * this.sampleRate)));
    cep[q + 1] = 0;
    for (let i = q + 2; i < n - q - 1; i++) cep[i] = 0;

    // 4. Back to the frequency domain: the lifted cepstrum IS the log envelope.
    fft(cep, cepIm);
    const invN = 1 / n;

    // Remove the DC (quefrency-0) coefficient so the envelope has geometric
    // mean 1. Without it the whole warp moves the level, and a "formant"
    // control that also changes volume is not a formant control.
    const mean = cep[0]! * invN;
    for (let k = 0; k <= this.half; k++) {
      this.logEnv[k] = cep[k]! * invN - mean;
    }
    this.primed = true;
  }

  /** True once `compute()` has produced at least one envelope. */
  get ready(): boolean {
    return this.primed;
  }

  /** Linear envelope value at bin k (unwarped). */
  valueAtBin(k: number): number {
    const v = Math.exp(this.logEnv[k] ?? 0);
    return v < ENV_MIN ? ENV_MIN : v > ENV_MAX ? ENV_MAX : v;
  }

  reset(): void {
    this.logEnv.fill(0);
    this.primed = false;
  }
}

/**
 * Per-voice warp table: precomputes, for a given α, where every output bin
 * samples the envelope and how far it sits between the two neighbouring bins
 * in log-frequency space.
 *
 * Rebuilding only when α actually moved matters: the formant parameter is
 * static in the overwhelming majority of frames, and this turns the hot loop
 * from "a Math.log per bin per voice per frame" (~380 k logs/s at 4 voices)
 * into two table reads.
 */
export class FormantWarp {
  private half = 0;
  private n = 0;
  private cachedAlpha = -1;
  private idx = new Int32Array(0);
  private frac = new Float32Array(0);
  /** Edge slopes in log-envelope per bin, for extrapolation outside the band. */
  private slopeLow = 0;
  private slopeHigh = 0;

  prepare(fftSize: number): void {
    if (this.n === fftSize) return;
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.idx = new Int32Array(this.half + 1);
    this.frac = new Float32Array(this.half + 1);
    this.cachedAlpha = -1;
  }

  /** Rebuild the sampling table when α moved. `logEnv` supplies the edges. */
  update(alpha: number, logEnv: Float64Array): void {
    const half = this.half;

    // Edge slopes are recomputed EVERY frame even when α is unchanged. They
    // describe the current envelope, and caching them alongside the table
    // would leave the band edges extrapolating the FIRST frame's slope for
    // the rest of the stream.
    const e = Math.min(EDGE_BINS, Math.max(1, half - 1));
    this.slopeLow = (logEnv[e]! - logEnv[0]!) / e;
    this.slopeHigh = (logEnv[half]! - logEnv[half - e]!) / e;

    if (Math.abs(alpha - this.cachedAlpha) < 1e-4 && this.cachedAlpha > 0) return;
    this.cachedAlpha = alpha;


    const invAlpha = 1 / Math.max(alpha, 1e-6);
    for (let k = 0; k <= half; k++) {
      // Source frequency f/α expressed as a source bin index.
      const j = k * invAlpha;
      if (j <= 0) {
        this.idx[k] = 0;
        this.frac[k] = 0; // handled by the low-edge slope at sample time
        continue;
      }
      if (j >= half) {
        this.idx[k] = half - 1;
        this.frac[k] = 0;
        continue;
      }
      const i = Math.floor(j);
      // Position between bin i and i+1 measured on a LOG-frequency axis.
      const li = Math.log(i + 1e-9);
      const lj = Math.log(j + 1e-9);
      const lj1 = Math.log(i + 1 + 1e-9);
      const denom = lj1 - li;
      const f = denom > 1e-12 ? (lj - li) / denom : 0;
      this.idx[k] = i;
      this.frac[k] = f < 0 ? 0 : f > 1 ? 1 : f;
    }
  }

  /**
   * Write the warped envelope for the cached α into `out` (linear, clamped).
   * `alpha` is only used to detect that the table is stale — call `update()`
   * first.
   */
  renderInto(logEnv: Float64Array, out: Float64Array, alpha: number): void {
    const half = this.half;
    const invAlpha = 1 / Math.max(alpha, 1e-6);
    for (let k = 0; k <= half; k++) {
      const j = k * invAlpha;
      let le: number;
      if (j <= 0) {
        // Low edge: carry the opening slope outward (never zero-pad).
        le = logEnv[0]! + this.slopeLow * j;
      } else if (j >= half) {
        // High edge: carry the closing slope outward from the Nyquist bin.
        le = logEnv[half]! + this.slopeHigh * (j - half);
      } else {
        const i = this.idx[k]!;
        const a = logEnv[i]!;
        const b = logEnv[i + 1]!;
        le = a + (b - a) * this.frac[k]!;
      }
      const v = Math.exp(le);
      out[k] = v < ENV_MIN ? ENV_MIN : v > ENV_MAX ? ENV_MAX : v;
    }
  }
}