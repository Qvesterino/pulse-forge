/**
 * MORPH DYNAMICS — Character stage (nonlinear timbre engine).
 *
 * One excellent engine before many models (IMPLEMENTATION_PLAN Phase 4):
 * drive → asymmetric harmonic lift → tone tilt → soft clip. Reactive drive
 * (Body→Drive, GR→Drive routes and the BODY macro) is the product identity
 * — static saturation is merely the P=0 baseline.
 *
 * v1 runs at 1× (no oversampling): drive is normalized post-gain (tanh(x·k)/tanh(k))
 * so loud passages do not multiply aliasing, and max pre-gain is bounded.
 * Quality modes currently gate the ANALYSIS resolution, not this stage.
 */

import { OnePoleHP, OnePoleLP, softClip } from "./dspUtils.js";

export interface CharParams {
  drive: number; // 0..1
  tone: number; // -1..1
  asym: number; // 0..1
  clip: number; // 0..1
}

export class CharacterStage {
  private lp = new OnePoleLP();
  private hp = new OnePoleHP();
  private params: CharParams = { drive: 0, tone: 0, asym: 0, clip: 0 };
  /** Fully bypassed when every nonlinear control is at zero. */
  private bypassed = true;

  prepare(sampleRate: number): void {
    this.lp.setFreq(900, sampleRate);
    this.hp.setFreq(900, sampleRate);
  }

  setParams(p: CharParams): void {
    this.params = p;
    this.bypassed = p.drive < 0.001 && p.asym < 0.001 && p.clip < 0.001;
  }

  reset(): void {
    this.lp.reset();
    this.hp.reset();
  }

  processFrame(l: number, r: number, out: { l: number; r: number }): void {
    if (this.bypassed) {
      out.l = l;
      out.r = r;
      this.warm = false;
      return;
    }
    const p = this.params;
    // Drive: pre-gain up to ×8, post-normalized so a full-scale tone comes
    // back at full scale (tanh(x·k)/tanh(k) is unity at |x|=1) — drive adds
    // harmonics and density, not loudness.
    const driveK = 1 + p.drive * 7;
    const norm = 1 / Math.tanh(driveK);
    let dl = Math.tanh(l * driveK) * norm;
    let dr = Math.tanh(r * driveK) * norm;
    dl = l * (1 - p.drive) + dl * p.drive;
    dr = r * (1 - p.drive) + dr * p.drive;

    // Asymmetric harmonics: second-order term biased positive (even-order
    // lift, "tube-ish"), blended dry.
    if (p.asym > 0.001) {
      const al = dl + p.asym * 0.5 * (dl * dl - dl * Math.abs(dl) * 0.5);
      const ar = dr + p.asym * 0.5 * (dr * dr - dr * Math.abs(dr) * 0.5);
      dl = al;
      dr = ar;
    }

    // Tone tilt: first-order shelf pair around ~900 Hz (crossover of the
    // two one-poles). tone>0 opens the HF side, tone<0 the LF side.
    if (Math.abs(p.tone) > 0.001) {
      const low = this.lp.process(dl);
      const high = this.hp.process(dl);
      dl = p.tone > 0 ? low + (1 + 2 * p.tone) * high : (1 - 2 * p.tone) * low + high;
      const lowR = this.lp.process(dr);
      const highR = this.hp.process(dr);
      dr = p.tone > 0 ? lowR + (1 + 2 * p.tone) * highR : (1 - 2 * p.tone) * lowR + highR;
    }

    // Soft clip: knee slides from ±1 (off) toward ±0.35 with amount.
    if (p.clip > 0.001) {
      const t = 1 - p.clip * 0.65;
      dl = softClip(dl, t);
      dr = softClip(dr, t);
    }

    // Bounded sanity: nonlinear chain can overshoot; the safety stage owns
    // final limiting, this only guards absurd intermediates.
    out.l = Math.max(-4, Math.min(4, dl));
    out.r = Math.max(-4, Math.min(4, dr));
  }
}
