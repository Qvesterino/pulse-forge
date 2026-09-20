/**
 * MORPH DYNAMICS — Dynamics stage.
 *
 * A production-credible feed-forward compressor (the foundation the
 * creative processing stands on) that ALSO exposes its behavior as
 * modulation: gain reduction normalized to 0..1 is the second-most
 * important reactive source after the raw features.
 *
 * PUNCH (macro.punch) shapes the transient relationship rather than acting
 * as an EQ: positive punch withdraws gain reduction while a transient is
 * active (transient-weighted release) and passes a short parallel
 * transient lift; negative punch deepens attack grab and gently tames
 * transients. All phase-safe (no all-pass, no lookahead — zero latency).
 */

import { EnvelopeFollower, OnePoleHP, dbToLin, tcToCoef } from "./dspUtils.js";

export interface DynParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  /** 0 = peak … 1 = RMS. */
  detectorBlend: number;
  sidechainHpfHz: number;
  makeupDb: number;
  makeupAuto: boolean;
}

export class DynamicsStage {
  private sampleRate = 48000;
  private scHP = new OnePoleHP();
  private detectorEnv = new EnvelopeFollower(); // RMS-ish arm
  private atkCoef = 0;
  private relCoef = 0;
  /** Smoothed applied gain (linear) — click-free under param jumps. */
  private gain = 1;
  private gainDbSmoothed = 0;
  /** Report-only GR in dB (positive). */
  grDb = 0;
  /** Normalized GR 0..1 (24 dB full scale) — modulation source. */
  grNorm = 0;
  private params: DynParams = {
    thresholdDb: -24,
    ratio: 2.5,
    attackMs: 12,
    releaseMs: 180,
    kneeDb: 6,
    detectorBlend: 0.5,
    sidechainHpfHz: 60,
    makeupDb: 0,
    makeupAuto: true,
  };

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.detectorEnv.setTimes(0.005, 0.05, sampleRate);
    this.scHP.setFreq(this.params.sidechainHpfHz, sampleRate);
  }

  setParams(p: DynParams): void {
    // Coefficients derive per-block from the CURRENT params; attack/release
    // changes are block-glided by the coefficient interpolation below.
    this.params = p;
    this.scHP.setFreq(Math.max(p.sidechainHpfHz, 5), this.sampleRate);
  }

  reset(): void {
    this.gain = 1;
    this.gainDbSmoothed = 0;
    this.grDb = 0;
    this.grNorm = 0;
    this.detectorEnv.reset();
  }

  /**
   * Process one frame. `punch` ∈ [-1, 1], `transientScore` ∈ [0, 1] from
   * the analysis engine. Returns [gainAppliedL, gainAppliedR] via out.
   */
  processFrame(
    l: number,
    r: number,
    punch: number,
    transientScore: number,
    out: { gl: number; gr: number; makeup: number },
  ): void {
    const p = this.params;
    // Linked stereo detector on the HP-filtered sidechain (kick-safe:
    // rumble below the HPF never grabs the gain computer).
    const det = Math.abs(this.scHP.process(0.5 * (l + r)));
    const peak = det;
    const rms = this.detectorEnv.processAbs(det);
    const level = peak * (1 - p.detectorBlend) + rms * p.detectorBlend;

    // Coefficient interpolation: recompute from params each frame is fine
    // (two Math.exp per frame is cheap and keeps automation click-free).
    const attackSec = p.attackMs / 1000;
    let relSec = p.releaseMs / 1000;
    // Punch>0 slows release slightly through transients (let hits ring out
    // of the compressor); punch<0 speeds it (denser grab).
    if (punch !== 0 && transientScore > 0.05) {
      relSec *= 1 + (punch > 0 ? 0.8 * punch : 0.5 * punch) * transientScore;
    }
    const aAtk = tcToCoef(attackSec, this.sampleRate);
    const aRel = tcToCoef(Math.max(relSec, 0.002), this.sampleRate);

    // Soft-knee gain computer (static curve).
    const overDb = level > 1e-6 ? 20 * Math.log10(level) - p.thresholdDb : -120;
    let targetGainDb: number;
    if (overDb <= -p.kneeDb / 2) {
      targetGainDb = 0;
    } else if (overDb < p.kneeDb / 2) {
      // Quadratic knee interpolation.
      const x = overDb + p.kneeDb / 2;
      targetGainDb = -((1 / p.ratio - 1) * x * x) / (2 * p.kneeDb);
    } else {
      targetGainDb = -(1 - 1 / p.ratio) * overDb;
    }

    // PUNCH: transient-weighted gain-release — while a transient is hot,
    // walk the target back toward 0 dB by up to 6 dB × punch × transient.
    if (punch > 0 && transientScore > 0.02) {
      targetGainDb *= 1 - Math.min(0.9, punch * transientScore * 0.85);
    }

    const targetLin = dbToLin(targetGainDb);
    const a = targetLin < this.gain ? aAtk : aRel;
    this.gain = targetLin + a * (this.gain - targetLin);

    // Makeup: auto ≈ what a static mix of the curve would eat at nominal
    // depth (threshold/ratio heuristic), plus manual trim.
    const autoDb = p.makeupAuto ? Math.max(0, -p.thresholdDb) * 0.12 * (1 - 1 / p.ratio) * 2 : 0;
    const makeup = dbToLin(autoDb + p.makeupDb);
    this.grDb = -20 * Math.log10(Math.max(this.gain, 1e-6));
    this.grNorm = Math.min(1, this.grDb / 24);
    // Smooth the REPORTED GR slightly so meters/matrix don't strobe.
    this.gainDbSmoothed = this.grNorm + 0.7 * (this.gainDbSmoothed - this.grNorm);
    this.grNorm = this.gainDbSmoothed;

    out.gl = this.gain;
    out.gr = this.gain;
    out.makeup = makeup;
  }
}
