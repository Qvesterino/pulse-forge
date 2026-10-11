/**
 * PORTAL — per-bin spectral resonator.
 *
 * A bank of complex one-poles, one per FFT bin, weighted by a Gaussian on a log
 * frequency axis centred on FOCUS. Each bin's recursion is independent, so a
 * sustained tone lights up the bins around its own frequency and they ring on
 * after the tone stops. That selective, partial-level sustain is the axis ADR
 * 0038, D6 requires PORTAL to be described by — it is what `shimmer` (a
 * uniform, constant ±12 st shift of the whole spectrum) cannot do.
 *
 * COMPLEX ONE-POLE
 * ----------------
 *     y[k] = x[k] + a[k] * y[k-1],   a[k] = g[k] * e^{i·phi}
 *
 * `g[k]` is always < 1, so the recursion is contractive and the resonator decays
 * on its own — it cannot run away the way an unclamped feedback delay can. That
 * property is why the RESONATOR mode needs no ceiling that DELAY does, but the
 * clamp is applied here anyway: a control surface that can emit a non-finite
 * gain is a control surface that eventually does.
 *
 * DC and Nyquist stay real — a complex recursion there would move energy into
 * the mirrored half and alias it back into the audible band.
 */

import { clampBinGain, flushDenormal } from "./stft";

/** Slight phase advance so the partials ring rather than sit still. */
const RESONATOR_PHASE = 0.15;

/** Largest pole radius; keeps the tail bounded and the soak stable. */
const MAX_POLE = 0.995;

export interface ResonatorParams {
  /** Pole strength 0..1. Zero is a bit-exact passthrough. */
  resonance: number;
  /** Centre frequency in Hz (20..18000). */
  focusHz: number;
  /** Half-width of the focus band, in octaves (0.1..4). */
  focusWidthOct: number;
}

export class ResonatorBank {
  private readonly binCount: number;
  private readonly stateRe: Float64Array;
  private readonly stateIm: Float64Array;
  /** Per-bin pole radius, recomputed only when a focus control moves. */
  private readonly poleRe: Float64Array;
  private readonly poleIm: Float64Array;
  /**
   * Per-bin input trim `1 - |pole|`. Without it the one-pole's DC gain is
   * `1/(1-|pole|)`: at the 0.995 ceiling that is a 200x boost, so a resonator
   * opened to full would be measured at ~228x the input peak while remaining
   * perfectly finite. The trim makes unity gain the steady state.
   */
  private readonly poleTrim: Float64Array;

  private readonly binHz: Float64Array;

  private peak = 0;

  constructor(binCount: number, sampleRate: number) {
    this.binCount = binCount;
    this.stateRe = new Float64Array(binCount);
    this.stateIm = new Float64Array(binCount);
    this.poleRe = new Float64Array(binCount);
    this.poleIm = new Float64Array(binCount);
    this.poleTrim = new Float64Array(binCount);
    this.binHz = new Float64Array(binCount);
    const nyquist = sampleRate / 2;
    for (let k = 0; k < binCount; k++) this.binHz[k] = (k * nyquist) / (binCount - 1);
  }

  getMeters(): number {
    return this.peak;
  }

  reset(): void {
    this.stateRe.fill(0);
    this.stateIm.fill(0);
    this.peak = 0;
  }

  /**
   * Process one frame in place.
   *
   * @param wetWeight how much of the ringing recursion is mixed in, 0..1. The
   *                  resonator is a PARALLEL additive path, so the dry spectrum
   *                  always stays: output = source + wetWeight · recursion.
   *                  0 is a bit-exact passthrough, 1 is the full resonator.
   */
  process(re: Float64Array, im: Float64Array, binCount: number, params: ResonatorParams, wetWeight: number): void {
    const n = Math.min(binCount, this.binCount);
    const res = Number.isFinite(params.resonance) ? Math.min(1, Math.max(0, params.resonance)) : 0;
    const wet = Number.isFinite(wetWeight) ? Math.min(1, Math.max(0, wetWeight)) : 0;

    // A closed resonance or a closed wet weight is a bit-exact passthrough —
    // skip the state update so no denormal work is paid when the control is shut.
    if (res <= 0 || wet <= 0) {
      for (let k = 0; k < n; k++) {
        this.stateRe[k] = flushDenormal(this.stateRe[k]);
        this.stateIm[k] = flushDenormal(this.stateIm[k]);
      }
      this.peak = 0;
      return;
    }

    this.updatePoles(res, params.focusHz, params.focusWidthOct);

    const oneMinusWet = 1 - wet;
    let peak = 0;

    for (let k = 0; k < n; k++) {
      // Real endpoints: DC and Nyquist cannot carry a complex pole — a complex
      // recursion there would move energy into the mirrored half and alias it
      // back into the audible band.
      if (k === 0 || k === n - 1) {
        const pole = this.poleRe[k];
        const src = re[k];
        const st = this.poleTrim[k] * src + pole * this.stateRe[k];
        this.stateRe[k] = flushDenormal(st);
        const out = src * oneMinusWet + st * wet;
        re[k] = out;
        const m = Math.abs(out);
        if (m > peak) peak = m;
        continue;
      }

      const sr = this.stateRe[k];
      const si = this.stateIm[k];
      const recRe = sr * this.poleRe[k] - si * this.poleIm[k];
      const recIm = sr * this.poleIm[k] + si * this.poleRe[k];
      const srcRe = re[k];
      const srcIm = im[k];

      // Trimmed recursion: steady state is `trim/(1-|pole|)` = 1, so a fully
      // open resonator neither boosts nor ducks the material it rings.
      const trim = this.poleTrim[k];
      const stRe = trim * srcRe + recRe;
      const stIm = trim * srcIm + recIm;
      this.stateRe[k] = flushDenormal(stRe);
      this.stateIm[k] = flushDenormal(stIm);

      re[k] = srcRe * oneMinusWet + stRe * wet;
      im[k] = srcIm * oneMinusWet + stIm * wet;

      const m = Math.abs(re[k]) + Math.abs(im[k]);
      if (m > peak) peak = m;
    }

    this.peak = peak;
  }

  /** Recompute the per-bin pole from the focus band. Cheap enough per frame. */
  private updatePoles(res: number, focusHz: number, focusWidthOct: number): void {
    const focus = clampFocusHz(focusHz);
    const width = Number.isFinite(focusWidthOct) ? Math.min(4, Math.max(0.1, focusWidthOct)) : 1;
    // res^2 so the low half of the control stays usable instead of collapsing to
    // no ring at all; MAX_POLE keeps the tail bounded and the soak stable.
    const strength = clampBinGain(res * res * MAX_POLE);
    const logFocus = Math.log2(focus);
    const invWidth = 1 / width;

    for (let k = 0; k < this.binCount; k++) {
      const f = this.binHz[k];
      const d = f > 0 ? (Math.log2(f) - logFocus) * invWidth : -Infinity;
      const w = Math.exp(-0.5 * d * d);
      const g = strength * w;
      // A constant phase advance, pre-rotated into the pole so the per-frame
      // loop stays two multiplies instead of four.
      this.poleRe[k] = g * Math.cos(RESONATOR_PHASE);
      this.poleIm[k] = g * Math.sin(RESONATOR_PHASE);
      this.poleTrim[k] = 1 - g;
    }
  }
}

/** Clamp the focus frequency into the audible band, never to zero. */
function clampFocusHz(hz: number): number {
  if (!Number.isFinite(hz)) return 1000;
  return Math.min(18000, Math.max(20, hz));
}
