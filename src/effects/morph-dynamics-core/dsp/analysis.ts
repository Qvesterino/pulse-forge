/**
 * MORPH DYNAMICS — Reactive feature extraction.
 *
 * Derives the perceptual control model from the incoming audio:
 *
 *   TRANSIENT — fast events (drum strikes, consonants, pick attacks)
 *   BODY      — sustained tonal mass (vocal tone, bass, synth body)
 *   TEXTURE   — noise-like / diffuse content (breath, cymbals, air)
 *
 * These are SOFT CONTROL MASKS (scores 0..1, allowed to overlap), not
 * source separation. The implementation is deliberately time-domain and
 * low-latency (DSP_ARCHITECTURE.md §18): multi-timescale envelopes plus
 * band-limited energy taps — no FFT on the audible path.
 *
 *   transient ∝ fast/mid envelope divergence + positive energy slope
 *   body      ∝ low-band presence × sustained-ness (1 − transient)
 *   texture   ∝ high-band energy share (crest-weighted)
 *   density   ∝ slow envelope (context/loudness for modulation)
 *
 * Sensitivity params rescale each score before its output smoother, so a
 * preset can bias what "the sound behaving" means without touching DSP.
 */

import { EnvelopeFollower, OnePoleHP, OnePoleLP, tcToCoef } from "./dspUtils.js";

export interface AnalysisSensitivities {
  transient: number; // 0..2 (percent/100)
  body: number;
  texture: number;
}

export interface AnalysisSignals {
  inputEnergy: number;
  transient: number;
  body: number;
  texture: number;
  density: number;
}

export class FeatureExtractor {
  private sampleRate = 48000;

  // Multi-timescale envelopes on the (rectified) mono analysis tap.
  private fast = new EnvelopeFollower(); // ~1 ms attack — transient edge
  private mid = new EnvelopeFollower(); // ~10 ms — musical dynamics
  private slow = new EnvelopeFollower(); // ~60 ms — density/context

  // Band-limited taps for body/texture energy.
  private bodyLP = new OnePoleLP(); // 250 Hz body band
  private textureHP = new OnePoleHP(); // 4 kHz texture band
  private bodyEnv = new EnvelopeFollower();
  private textureEnv = new EnvelopeFollower();
  private texturePeak = new EnvelopeFollower(); // crest of the HF band

  // Output smoothers (attack fast enough to feel immediate, release musical).
  private outTransient = new EnvelopeFollower();
  private outBody = new EnvelopeFollower();
  private outTexture = new EnvelopeFollower();

  // Positive slope detector state (previous mid envelope).
  private prevMid = 0;
  private slope = 0; // one-pole smoothed positive slope
  private slopeCoef = 0;

  private sens: AnalysisSensitivities = { transient: 1, body: 1, texture: 1 };
  private ecoDivisor = 1;
  private ecoCounter = 0;

  // Published scores (persist between blocks so meters never strobe).
  private signals: AnalysisSignals = { inputEnergy: 0, transient: 0, body: 0, texture: 0, density: 0 };

  prepare(sampleRate: number, qualityMode: number): void {
    this.sampleRate = sampleRate;
    this.fast.setTimes(0.001, 0.04, sampleRate);
    this.mid.setTimes(0.01, 0.12, sampleRate);
    this.slow.setTimes(0.06, 0.4, sampleRate);
    this.bodyLP.setFreq(250, sampleRate);
    this.textureHP.setFreq(4000, sampleRate);
    this.bodyEnv.setTimes(0.01, 0.15, sampleRate);
    this.textureEnv.setTimes(0.01, 0.2, sampleRate);
    this.texturePeak.setTimes(0.0005, 0.03, sampleRate);
    this.outTransient.setTimes(0.002, 0.15, sampleRate);
    this.outBody.setTimes(0.03, 0.25, sampleRate);
    this.outTexture.setTimes(0.02, 0.3, sampleRate);
    // Positive-slope smoother: ~8 ms — fast enough for strikes, slow enough
    // to reject single-sample zigzag.
    this.slopeCoef = tcToCoef(0.008, sampleRate);
    // ECO halves the band-tap evaluation rate (analysis CPU), NORMAL/HIGH run
    // full rate. Scores themselves stay smooth via the output envelopes.
    this.ecoDivisor = qualityMode === 0 ? 2 : 1;
    this.reset();
  }

  setSensitivities(sens: AnalysisSensitivities): void {
    this.sens = sens;
  }

  reset(): void {
    this.fast.reset();
    this.mid.reset();
    this.slow.reset();
    this.bodyEnv.reset();
    this.textureEnv.reset();
    this.texturePeak.reset();
    this.outTransient.reset();
    this.outBody.reset();
    this.outTexture.reset();
    this.prevMid = 0;
    this.slope = 0;
  }

  /**
   * Process one interleaved stereo frame (post input-gain tap). Returns the
   * current signals object (mutated in place — do not retain).
   */
  processFrame(l: number, r: number): AnalysisSignals {
    const mono = 0.5 * (Math.abs(l) + Math.abs(r));

    const fastV = this.fast.processAbs(mono);
    const midV = this.mid.processAbs(mono);
    const slowV = this.slow.processAbs(mono);

    // Positive energy slope (normalized rise of the mid envelope).
    const rise = midV - this.prevMid;
    this.prevMid = midV;
    if (rise > 0) this.slope += rise * (1 - this.slopeCoef);
    else this.slope *= this.slopeCoef;

    // Band taps: ECO evaluates every other frame (per-instance CPU lever).
    let bodyBand = this.bodyEnv.value;
    let texBand = this.textureEnv.value;
    let texPeak = this.texturePeak.value;
    if (this.ecoCounter++ % this.ecoDivisor === 0) {
      bodyBand = this.bodyEnv.processAbs(Math.abs(this.bodyLP.process(l)));
      const hf = this.textureHP.process(l);
      texBand = this.textureEnv.processAbs(Math.abs(hf));
      texPeak = this.texturePeak.processAbs(Math.abs(hf) > Math.abs(r) ? hf : this.textureHP.process(r));
    }

    // ── Score synthesis ─────────────────────────────────────
    // Normalizations: envelopes are linear-amplitude; map to 0..1 with a
    // fixed reference where ~-20 dBFS sustained ≈ 0.5. Deterministic and
    // level-dependent by design — louder IS more reactive (the thesis).
    const ref = 0.1;
    const inputEnergy = clamp01(fastV / (ref * 2));
    const density = clamp01(slowV / (ref * 1.5));

    // Transient: normalized rise + fast/slow divergence (strikes spike both).
    const divergence = slowV > 1e-6 ? Math.max(0, (fastV - slowV) / (fastV + slowV)) : 0;
    const transientRaw = clamp01(6 * this.slope * (1 / (ref * 8)) + 1.4 * divergence);
    const transient = smoothScore(this.outTransient, transientRaw * this.sens.transient);

    // Body: low-band share of total energy, gated by sustained-ness.
    const totalE = midV + 1e-9;
    const lowShare = this.bodyEnv.value / totalE;
    const sustain = clamp01(slowV / (totalE * 1.2));
    const bodyRaw = clamp01(2.2 * lowShare * sustain * (1 - 0.6 * transient));
    const body = smoothScore(this.outBody, bodyRaw * this.sens.body);

    // Texture: HF share, crest-weighted (noise-ish HF has spiky crest).
    const hfShare = texBand / totalE;
    const crest = texBand > 1e-9 ? clamp01((texPeak / texBand - 1) * 0.5) : 0;
    const textureRaw = clamp01(3.5 * hfShare * (0.55 + 0.45 * crest));
    const texture = smoothScore(this.outTexture, textureRaw * this.sens.texture);

    this.signals.inputEnergy = inputEnergy;
    this.signals.transient = transient;
    this.signals.body = body;
    this.signals.texture = texture;
    this.signals.density = density;
    return this.signals;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Score output smoother: attack releases immediately toward the raw value,
 * release decays musically (the envelope follower does exactly this). */
function smoothScore(env: EnvelopeFollower, raw: number): number {
  return env.processAbs(clamp01(raw));
}
