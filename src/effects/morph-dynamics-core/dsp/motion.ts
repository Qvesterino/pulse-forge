/**
 * MORPH DYNAMICS — Motion stage (reactive all-pass movement).
 *
 * Four first-order all-pass sections whose coefficient sweep is driven by
 * the REACTIVE control engine (body/GR/density via the matrix and the
 * MOTION macro), with an optional slow drift as a secondary source —
 * reactive-first per DSP_ARCHITECTURE.md §12.
 *
 * Stability: first-order all-pass coefficient c must stay |c| < 1 (a
 * one-pole recursion with |c| ≥ 1 does not blow up linearly but does lock
 * to a pole on the unit circle — the FX-wave instability lesson). The
 * sweep is bounded inside the open interval by construction.
 *
 * Stereo: the right channel runs the same sections with a fixed phase
 * offset so movement opens in width rather than in mono wobble.
 */

import { clampUnit } from "./dspUtils.js";

const STAGES = 4;

export class MotionStage {
  private sampleRate = 48000;
  private coefL: number[] = new Array(STAGES).fill(0);
  private stateL: number[] = new Array(STAGES).fill(0);
  private coefR: number[] = new Array(STAGES).fill(0);
  private stateR: number[] = new Array(STAGES).fill(0);
  private fb = 0;
  private fbStateL = 0;
  private fbStateR = 0;
  /** Slow autonomous drift phase (secondary source, rate param). */
  private phase = 0;
  private centerHz = 900;
  private blockSize = 128;

  prepare(sampleRate: number, maxBlockSize = 128): void {
    this.sampleRate = sampleRate;
    this.blockSize = maxBlockSize;
  }

  setCenter(centerHz: number): void {
    this.centerHz = centerHz;
  }

  reset(): void {
    this.stateL.fill(0);
    this.stateR.fill(0);
    this.fbStateL = 0;
    this.fbStateR = 0;
    this.phase = 0;
  }

  /**
   * Advance control per block. `depth` 0..1 (macro × reactive), `rateHz`
   * drift, `feedback` −0.72..0.72 (clamped), `reactive` −1..1 sweep signal.
   */
  setControl(depth: number, rateHz: number, feedback: number, reactive: number): void {
    this.fb = Math.max(-0.72, Math.min(0.72, feedback));
    const drift = Math.sin(2 * Math.PI * this.phase) * 0.4 * rateHz * 0.5;
    // Drift phase advances in REAL time (rate Hz × block duration) — this
    // runs per block, so a per-block delta of rate/sr would crawl 128× slow.
    this.phase += (rateHz * this.blockSize) / this.sampleRate;
    if (this.phase >= 1) this.phase -= 1;
    // Sweep = reactive signal (scaled by depth) + drift; coefficient swing
    // spans roughly one octave around center per unit sweep.
    const total = Math.max(-1, Math.min(1, reactive * 0.8 + drift));
    // First-order AP coefficient: c = (1−tan(π·f/sr))/(1+tan(π·f/sr));
    // sweep ±1 maps to f = center × (0.5 … 2), tan stays well-behaved.
    const octaves = total * 1;
    const f = this.centerHz * Math.pow(2, octaves);
    const t = Math.tan((Math.PI * Math.min(f, this.sampleRate * 0.45)) / this.sampleRate);
    const c = clampUnit((1 - t) / (1 + t));
    const tShift = Math.tan((Math.PI * Math.min(f * 1.19, this.sampleRate * 0.45)) / this.sampleRate);
    const cShift = clampUnit((1 - tShift) / (1 + tShift));
    for (let i = 0; i < STAGES; i++) {
      // Staggered coefficients → cascaded notches spread instead of stacking.
      // Re-clamp after scaling: c·1.004 can cross |c|=1 near band edges and
      // an AP pole outside the unit circle is runaway feedback.
      this.coefL[i] = i % 2 === 0 ? c : cShift;
      this.coefR[i] = clampUnit(i % 2 === 0 ? cShift * 0.995 : c * 1.004);
    }
    // depth is applied as wet blend in processFrame via this.depth.
    this.depth = depth;
  }

  private depth = 0;

  processFrame(l: number, r: number, out: { l: number; r: number }): void {
    let wl = this.apChain(this.coefL, this.stateL, l + this.fb * this.fbStateL);
    let wr = this.apChain(this.coefR, this.stateR, r + this.fb * this.fbStateR);
    this.fbStateL = wl;
    this.fbStateR = wr;
    // Depth = wet blend of the phase-shifted signal (depth 0 → passthrough).
    wl = l * (1 - this.depth) + wl * this.depth;
    wr = r * (1 - this.depth) + wr * this.depth;
    out.l = wl;
    out.r = wr;
  }

  /**
   * Cascade of first-order all-pass sections, H(z) = (c + z⁻¹)/(1 + c·z⁻¹):
   *   v = c·x + s,  s' = x − c·v   (s carries x[n−1] − c·y[n−1])
   * The pole sits at −c, so |c| < 1 (clampUnit) is the stability bound and
   * |H| ≡ 1 — the feedback loop around the cascade is gain-safe for |fb|<1.
   */
  private apChain(coef: number[], state: number[], x: number): number {
    let y = x;
    for (let i = 0; i < STAGES; i++) {
      const c = coef[i];
      const v = c * y + state[i];
      state[i] = y - c * v;
      if (state[i] > -1e-20 && state[i] < 1e-20) state[i] = 0; // denormal flush
      y = v;
    }
    return y;
  }
}
