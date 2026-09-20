/**
 * MORPH DYNAMICS — Character stage (nonlinear timbre engine).
 *
 * One excellent engine before many models (IMPLEMENTATION_PLAN Phase 4):
 * drive → asymmetric harmonic lift → tone tilt → soft clip. Reactive drive
 * (Body→Drive, GR→Drive routes and the BODY macro) is the product identity
 * — static saturation is merely the P=0 baseline.
 *
 * Oversampling (DSP_ARCHITECTURE.md §11): in NORMAL/HIGH quality the
 * nonlinear subgraph runs inside a 2× polyphase halfband (oversampler.ts)
 * — ×8 tanh drive at 1× aliases audibly on hats/cymbals, and 2× pushes the
 * first alias zone above the audio band. The transform is applied ONLY at
 * 2× (never cascaded). ECO runs 1× for minimum CPU. The added 8-sample
 * group delay is reported by the processor via the latency port and
 * mirrored on its dry/mix path.
 */

import { OnePoleHP, OnePoleLP, softClip } from "./dspUtils.js";
import { HalfbandStage, OS2_LATENCY } from "./oversampler.js";

export interface CharParams {
  drive: number; // 0..1
  tone: number; // -1..1
  asym: number; // 0..1
  clip: number; // 0..1
}

const TONE_HZ = 900;

export class CharacterStage {
  private sampleRate = 48000;
  // Per-channel tone filters — sharing one one-pole pair across L and R
  // (an earlier revision) interleaves their states and smears the stereo
  // image; filters are stateful per channel by definition.
  private lpL = new OnePoleLP();
  private hpL = new OnePoleHP();
  private lpR = new OnePoleLP();
  private hpR = new OnePoleHP();
  private params: CharParams = { drive: 0, tone: 0, asym: 0, clip: 0 };
  /** Fully bypassed when every nonlinear control is at zero. */
  private bypassed = true;
  /** 0 = 1× (eco), 1 = 2× halfband (normal/high). */
  private osStages = 0;
  private chainL: HalfbandStage | null = null;
  private chainR: HalfbandStage | null = null;
  // Hoisted per-channel transforms — a fresh arrow per SAMPLE would be an
  // audio-thread allocation (GC pressure at 96k allocs/s); these are built
  // once per instance.
  private nlL = (y: number): number => this.nonlinear(0, y);
  private nlR = (y: number): number => this.nonlinear(1, y);

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.applyToneRates();
  }

  /**
   * Quality-mode hook. 1×/2× only for now: 4× (docs "high") needs a
   * cascaded up/transform/down topology and is deferred — the audible
   * alias win is the 1×→2× step. Rebuilding the halfband allocates, so it
   * happens only when the mode actually changes (param handler, not the
   * audio loop).
   */
  setQuality(qualityMode: number): void {
    const stages = qualityMode >= 1 ? 1 : 0;
    if (stages !== this.osStages) {
      this.osStages = stages;
      this.chainL = stages > 0 ? new HalfbandStage() : null;
      this.chainR = stages > 0 ? new HalfbandStage() : null;
    }
    this.applyToneRates();
  }

  /** Tone filters run INSIDE the 2× transform — they see the OS rate. */
  private applyToneRates(): void {
    const rate = this.sampleRate * Math.pow(2, this.osStages);
    this.lpL.setFreq(TONE_HZ, rate);
    this.hpL.setFreq(TONE_HZ, rate);
    this.lpR.setFreq(TONE_HZ, rate);
    this.hpR.setFreq(TONE_HZ, rate);
  }

  /**
   * Group delay added by the ACTIVE oversampling path, in base-rate samples.
   * When the nonlinear controls are all zero the stage hard-bypasses (input
   * → output, no halfband), so the wet chain carries no delay and the dry
   * compensation must be zero too — otherwise the delta/mix reference would
   * shift against an undelayed wet path.
   */
  get latencySamples(): number {
    return this.osStages > 0 && !this.bypassed ? OS2_LATENCY : 0;
  }

  setParams(p: CharParams): void {
    this.params = p;
    const next = p.drive < 0.001 && p.asym < 0.001 && p.clip < 0.001;
    if (next !== this.bypassed) this.reset(); // flush on either transition:
    // waking from bypass must not pour stale chain state into the signal,
    // and entering bypass should drop the halfband history entirely.
    this.bypassed = next;
  }

  reset(): void {
    this.lpL.reset();
    this.hpL.reset();
    this.lpR.reset();
    this.hpR.reset();
    this.chainL?.reset();
    this.chainR?.reset();
  }

  /** The nonlinear transform for one channel's sample (runs at 1× or 2×). */
  private nonlinear(ch: 0 | 1, y: number): number {
    const p = this.params;
    // Drive: pre-gain up to ×8, post-normalized so a full-scale tone comes
    // back at full scale (tanh(x·k)/tanh(k) is unity at |x|=1) — drive adds
    // harmonics and density, not loudness.
    const driveK = 1 + p.drive * 7;
    let v = Math.tanh(y * driveK) / Math.tanh(driveK);
    v = y * (1 - p.drive) + v * p.drive;

    // Asymmetric harmonics: second-order term biased positive (even-order
    // lift, "tube-ish"), blended in.
    if (p.asym > 0.001) {
      v += p.asym * 0.5 * (v * v - v * Math.abs(v) * 0.5);
    }

    // Tone tilt: first-order shelf pair around ~900 Hz (crossover of the
    // two one-poles). tone>0 opens the HF side, tone<0 the LF side.
    if (Math.abs(p.tone) > 0.001) {
      const low = ch === 0 ? this.lpL.process(v) : this.lpR.process(v);
      const high = ch === 0 ? this.hpL.process(v) : this.hpR.process(v);
      v = p.tone > 0 ? low + (1 + 2 * p.tone) * high : (1 - 2 * p.tone) * low + high;
    }

    // Soft clip: knee slides from ±1 (off) toward ±0.35 with amount.
    if (p.clip > 0.001) {
      v = softClip(v, 1 - p.clip * 0.65);
    }

    // Bounded sanity: nonlinear chain can overshoot; the safety stage owns
    // final limiting, this only guards absurd intermediates.
    return Math.max(-4, Math.min(4, v));
  }

  processFrame(l: number, r: number, out: { l: number; r: number }): void {
    if (this.bypassed) {
      out.l = l;
      out.r = r;
      return;
    }
    if (this.chainL && this.chainR) {
      out.l = this.chainL.process(l, this.nlL);
      out.r = this.chainR.process(r, this.nlR);
      return;
    }
    out.l = this.nonlinear(0, l);
    out.r = this.nonlinear(1, r);
  }
}
