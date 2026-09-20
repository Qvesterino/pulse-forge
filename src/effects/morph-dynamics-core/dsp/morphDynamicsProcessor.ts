/**
 * MORPH DYNAMICS — Processor (the reactive control engine + audible chain).
 *
 * Signal flow (DSP_ARCHITECTURE.md §2/§14):
 *
 *   input → inputGain ─┬→ FeatureExtractor ─→ Reactive Control Engine ─→ Modulation Matrix ─┐
 *                      │                                                                    │
 *                      ├→ Dynamics → Character → Motion → Space → Safety → (mix) → OUTPUT ←──┘
 *                      └→ dry (latency-compensated; the chain is zero-latency) ─→ (mix) ─↗
 *
 * The control path observes audio and produces normalized modulation
 * sources; the audible path consumes them. PRESSURE is a semantic macro:
 * it scales curated nonlinear mappings per subsystem (f1..f4), so turning
 * it up progressively REVEALS reactive behavior instead of inflating a
 * wet/dry knob (§9).
 *
 * Real-time safety: no allocation, no locks after prepare(); every
 * recursive subsystem is bounded; block-rate control updates are smoothed
 * (BlockSmoother) so automation is click-free; non-finite samples reset
 * the engine instead of propagating. Control-source bookkeeping runs
 * REGARDLESS of the metering gate — the mod matrix cannot freeze when a
 * panel closes; only the port snapshot is gated.
 */

import * as P from "../contracts/parameterIds.js";
import { MOD_DESTINATIONS } from "../contracts/modulation.js";
import type { MorphMeters } from "../contracts/meters.js";
import { buildDefaultParams, clampParam, PARAM_BY_ID } from "../contracts/parameterSchema.js";
import type { AnalysisSignals } from "./analysis.js";
import { BlockSmoother, OnePoleHP, dbToLin, softClip } from "./dspUtils.js";
import { FeatureExtractor } from "./analysis.js";
import { DynamicsStage } from "./dynamics.js";
import { CharacterStage } from "./character.js";
import { MotionStage } from "./motion.js";
import { SpaceStage } from "./space.js";

const ROUTE_SLOTS = P.ROUTE_COUNT;

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class MorphDynamicsProcessor {
  private params: Record<string, number> = buildDefaultParams();

  private analysis = new FeatureExtractor();
  private dyn = new DynamicsStage();
  private character = new CharacterStage();
  private motion = new MotionStage();
  private space = new SpaceStage();

  // Output safety (per channel — each keeps its own one-pole state).
  private dcL = new OnePoleHP();
  private dcR = new OnePoleHP();

  // Block-rate smoothed control values (click-free automation).
  private sm = {
    inputGain: new BlockSmoother(1, 0.03),
    outputGain: new BlockSmoother(1, 0.03),
    mix: new BlockSmoother(1, 0.03),
    thresholdOffset: new BlockSmoother(0, 0.05),
    ratioBonus: new BlockSmoother(0, 0.05),
    makeupBonus: new BlockSmoother(0, 0.05),
    punch: new BlockSmoother(0, 0.04),
    driveBase: new BlockSmoother(0, 0.05),
    tone: new BlockSmoother(0, 0.05),
    asym: new BlockSmoother(0, 0.05),
    clip: new BlockSmoother(0, 0.05),
    motionDepth: new BlockSmoother(0, 0.06),
    motionRate: new BlockSmoother(0.2, 0.08),
    motionFeedback: new BlockSmoother(0, 0.08),
    motionSweep: new BlockSmoother(0, 0.05),
    spaceSend: new BlockSmoother(0, 0.06),
    diffusion: new BlockSmoother(0.6, 0.08),
    decay: new BlockSmoother(1.2, 0.1),
    width: new BlockSmoother(1.15, 0.06),
    predelayMs: new BlockSmoother(12, 0.08),
    duck: new BlockSmoother(0.5, 0.08),
    /** Per-destination additive modulation delta (plain units of the dest). */
    mod: MOD_DESTINATIONS.map(() => new BlockSmoother(0, 0.06)),
  };
  /** Raw (pre-smoothing) matrix deltas for this block. */
  private rawDelta = new Array<number>(MOD_DESTINATIONS.length).fill(0);

  // Per-route activity for the matrix UI (post-modulation magnitude 0..1).
  private routeActivity = new Array<number>(ROUTE_SLOTS).fill(0);

  // Core users (offline render/tests) get meters by default. The AudioWorklet
  // host disables them when no panel is observing this instance.
  private metersEnabled = true;
  private meters: MorphMeters = {
    inputPeakDb: -100,
    outputPeakDb: -100,
    gainReductionDb: 0,
    transient: 0,
    body: 0,
    texture: 0,
    density: 0,
    inputEnergy: 0,
    pressureActive: 0,
    routes: new Array<number>(ROUTE_SLOTS).fill(0),
  };
  private inPeakHold = 0;
  private outPeakHold = 0;
  private disposed = false;

  prepare(sampleRate: number, _channelCount: number, maxBlockSize: number, qualityMode: number): void {
    // BlockSmoother advances once per render quantum; its update rate is the
    // audio sample rate divided by the prepared block size.
    const controlRate = sampleRate / Math.max(1, maxBlockSize);
    for (const smoother of Object.values(this.sm)) {
      if (Array.isArray(smoother)) {
        for (const item of smoother) item.setSampleRate(controlRate);
      } else {
        smoother.setSampleRate(controlRate);
      }
    }
    this.analysis.prepare(sampleRate, qualityMode);
    this.dyn.prepare(sampleRate);
    this.character.prepare(sampleRate);
    this.motion.prepare(sampleRate, maxBlockSize);
    this.space.prepare(sampleRate);
    this.dcL.setFreq(9, sampleRate);
    this.dcR.setFreq(9, sampleRate);
    this.pushStaticParams();
  }

  setMetersEnabled(enabled: boolean): void {
    this.metersEnabled = enabled;
    if (!enabled) {
      this.inPeakHold = 0;
      this.outPeakHold = 0;
      this.meters.inputPeakDb = -100;
      this.meters.outputPeakDb = -100;
      this.meters.gainReductionDb = 0;
      this.meters.pressureActive = 0;
      this.routeActivity.fill(0);
      this.meters.routes.fill(0);
    }
  }

  getLatencySamples(): number {
    // Zero-latency by design (no lookahead, no oversampling delay).
    return 0;
  }

  setParameter(id: string, value: number): void {
    if (!PARAM_BY_ID.has(id)) return;
    this.params[id] = clampParam(id, value);
    this.pushStaticParams();
  }

  getParameter(id: string): number {
    return this.params[id] ?? 0;
  }

  /** Full state load (project recall / preset apply): clamp EVERYTHING. */
  loadState(params: Record<string, number>): void {
    const next = { ...buildDefaultParams() };
    for (const [id, value] of Object.entries(params)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (!PARAM_BY_ID.has(id)) continue; // unknown id from an older schema
      next[id] = clampParam(id, value);
    }
    this.params = next;
    this.pushStaticParams();
  }

  reset(): void {
    this.analysis.reset();
    this.dyn.reset();
    this.character.reset();
    this.motion.reset();
    this.space.reset();
    this.dcL.reset();
    this.dcR.reset();
    for (const s of this.sm.mod) s.snap();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Params that map 1:1 into stage setters (no PRESSURE coupling). */
  private pushStaticParams(): void {
    const q = this.params;
    this.analysis.setSensitivities({
      transient: q[P.ANALYSIS_TRANSIENT_SENSITIVITY_ID] / 100,
      body: q[P.ANALYSIS_BODY_SENSITIVITY_ID] / 100,
      texture: q[P.ANALYSIS_TEXTURE_SENSITIVITY_ID] / 100,
    });
    this.space.setParams({
      send: q[P.SPACE_SEND_ID] / 100,
      predelayMs: q[P.SPACE_PREDELAY_MS_ID],
      diffusion: q[P.SPACE_DIFFUSION_ID] / 100,
      decayS: q[P.SPACE_DECAY_S_ID],
      damping: q[P.SPACE_DAMPING_ID] / 100,
      width: q[P.SPACE_WIDTH_ID] / 100,
      duck: q[P.SPACE_DUCK_ID] / 100,
    });
    this.motion.setCenter(q[P.MOTION_CENTER_HZ_ID]);
  }

  /**
   * Process one block of stereo. inputs[0]/[1] must hold `frames` samples;
   * they are overwritten with the output.
   */
  process(inputs: Float32Array[], frames: number): void {
    if (this.disposed) {
      for (const ch of inputs) ch.fill(0, 0, frames);
      return;
    }
    const q = this.params;
    const L = inputs[0];
    const R = inputs[1] ?? inputs[0];

    // ── 1. PRESSURE → curated nonlinear subsystem curves (f1..f4) ─
    const Pn = q[P.MACRO_PRESSURE_ID] / 100;
    const dynScale = Pn;
    const charScale = smoothstep(Pn, 0.1, 0.7);
    const motionScale = smoothstep(Pn, 0.35, 0.9);
    const spaceScale = smoothstep(Pn, 0.25, 0.85);
    const routeScale = smoothstep(Pn, 0.15, 0.65);

    // ── 2. Modulation matrix evaluation (block-rate) ──────────────
    // Sources: control scores of the PREVIOUS block + normalized GR.
    // These update every block regardless of the metering gate.
    const src: number[] = [
      this.meters.inputEnergy,
      this.dyn.grNorm,
      this.meters.transient,
      this.meters.body,
      this.meters.texture,
      this.meters.density,
      routeScale, // PRESSURE as a source = post-curve reactive depth
    ];
    this.rawDelta.fill(0);
    for (let slot = 0; slot < ROUTE_SLOTS; slot++) {
      this.routeActivity[slot] = 0;
      if (q[P.routeParamId(slot, "enabled")] < 0.5) continue;
      const sourceIdx = Math.round(q[P.routeParamId(slot, "source")]);
      const destIdx = Math.round(q[P.routeParamId(slot, "destination")]);
      const dest = MOD_DESTINATIONS[destIdx];
      if (!dest) continue;
      const s = src[sourceIdx] ?? 0;
      const amount = q[P.routeParamId(slot, "amount")] / 100;
      const delta = amount * s * dest.span * routeScale;
      this.rawDelta[destIdx] += delta;
      if (this.metersEnabled) this.routeActivity[slot] = Math.min(1, Math.abs(amount * s) * routeScale * 1.25);
    }
    const modDelta = this.sm.mod;
    for (let d = 0; d < modDelta.length; d++) {
      // Per-route smoothing: the route slot that last touched a destination
      // sets the destination smoother's TC (5..300 ms) — good enough for v1
      // where routes rarely share a destination with conflicting TCs.
      const ownerSlot = this.routeSmoothOwner(d);
      if (ownerSlot >= 0) modDelta[d].tc = q[P.routeParamId(ownerSlot, "smoothMs")] / 1000;
      modDelta[d].setTarget(this.rawDelta[d]);
      modDelta[d].tick();
    }

    const mod = (destIdx: number, base: number): number => {
      const dest = MOD_DESTINATIONS[destIdx];
      return Math.max(dest.min, Math.min(dest.max, base + modDelta[destIdx].current));
    };

    // ── 3. Effective (curated + modulated) stage values ───────────
    // f1 — dynamics deepen from the first percent of PRESSURE.
    this.sm.thresholdOffset.setTarget(-10 * Math.pow(dynScale, 1.2));
    this.sm.ratioBonus.setTarget(3.5 * Math.pow(dynScale, 1.6));
    this.sm.makeupBonus.setTarget(1.5 * dynScale * dynScale);
    const thresholdEff = mod(0, q[P.DYN_THRESHOLD_DB_ID] + this.sm.thresholdOffset.tick());
    const ratioEff = mod(1, q[P.DYN_RATIO_ID] + this.sm.ratioBonus.current);
    this.dyn.setParams({
      thresholdDb: thresholdEff,
      ratio: ratioEff,
      attackMs: q[P.DYN_ATTACK_MS_ID],
      releaseMs: q[P.DYN_RELEASE_MS_ID],
      kneeDb: q[P.DYN_KNEE_DB_ID],
      detectorBlend: q[P.DYN_DETECTOR_BLEND_ID] / 100,
      sidechainHpfHz: q[P.DYN_SIDECHAIN_HPF_HZ_ID],
      makeupDb: q[P.DYN_MAKEUP_DB_ID] + this.sm.makeupBonus.current,
      makeupAuto: q[P.DYN_MAKEUP_AUTO_ID] >= 0.5,
    });
    this.sm.punch.setTarget(q[P.MACRO_PUNCH_ID] / 100);
    const punch = this.sm.punch.tick();

    // f2 — character: BODY macro biases drive; curated reactive drive
    // (body + GR → drive, the product identity) scaled by charScale;
    // routes add on top. Stage toggle is a hard bypass.
    const charOn = q[P.CHAR_ENABLED_ID] >= 0.5;
    const reactiveDrive = (this.meters.body * 30 + this.dyn.grNorm * 25) * charScale;
    this.sm.driveBase.setTarget(q[P.CHAR_DRIVE_ID] + (q[P.MACRO_BODY_ID] / 100) * 25 * charScale);
    const driveEff = mod(2, this.sm.driveBase.current + reactiveDrive);
    const toneEff = mod(3, q[P.CHAR_TONE_ID] + (q[P.MACRO_BODY_ID] - 50) * 0.3);
    const clipEff = mod(4, q[P.CHAR_CLIP_ID] + q[P.MACRO_PUNCH_ID] * 0.15);
    this.sm.tone.setTarget(charOn ? toneEff / 100 : 0);
    this.sm.asym.setTarget(charOn ? q[P.CHAR_ASYM_ID] / 100 : 0);
    this.sm.clip.setTarget(charOn ? clipEff / 100 : 0);
    this.character.setParams({
      drive: charOn ? Math.max(0, Math.min(100, driveEff)) / 100 : 0,
      tone: this.sm.tone.tick(),
      asym: this.sm.asym.tick(),
      clip: Math.max(0, Math.min(1, this.sm.clip.tick())),
    });

    // f3 — motion: macro sets the base depth; reactive sources (body,
    // density) sweep the AP bank; GR feeds back; PRESSURE opens the swing.
    const motionOn = q[P.MOTION_ENABLED_ID] >= 0.5;
    const motionDepthEff = mod(5, (q[P.MACRO_MOTION_ID] / 100) * (35 + 65 * motionScale));
    const rateEff = mod(6, q[P.MOTION_RATE_HZ_ID]);
    const fbEff = mod(7, q[P.MOTION_FEEDBACK_ID] + this.dyn.grNorm * 40 * motionScale);
    const reactiveSweep =
      (this.meters.body - 0.35) * 0.9 * motionScale + (this.meters.density - 0.4) * 0.4 * motionScale;
    this.motion.setControl(
      motionOn ? Math.max(0, Math.min(100, motionDepthEff)) / 100 : 0,
      motionOn ? Math.max(0, rateEff) : 0,
      motionOn ? Math.max(-80, Math.min(80, fbEff)) / 100 : 0,
      motionOn ? Math.max(-1, Math.min(1, reactiveSweep)) : 0,
    );

    // f4 — space: macro send with a spaceScale floor (SPACE alone still
    // blooms); texture/density open send + diffusion reactively; transient
    // ducking comes straight from the analysis; width follows TEXTURE macro.
    const spaceOn = q[P.SPACE_ENABLED_ID] >= 0.5;
    const sendBase = (q[P.MACRO_SPACE_ID] / 100) * (40 + 60 * spaceScale);
    const sendEff = mod(8, sendBase + (this.meters.texture * 20 + this.meters.density * 10) * spaceScale);
    const diffEff = mod(9, q[P.SPACE_DIFFUSION_ID] + this.meters.texture * 25 * spaceScale);
    const decayEff = mod(10, q[P.SPACE_DECAY_S_ID] + this.meters.body * 0.5 * spaceScale);
    const widthEff = mod(11, q[P.SPACE_WIDTH_ID] * (0.7 + 0.6 * (q[P.MACRO_TEXTURE_ID] / 100)));
    this.space.setParams({
      send: spaceOn ? Math.max(0, Math.min(100, sendEff)) / 100 : 0,
      predelayMs: q[P.SPACE_PREDELAY_MS_ID],
      diffusion: Math.max(0, Math.min(1, diffEff / 100)),
      decayS: Math.max(0.1, Math.min(5, decayEff)),
      damping: q[P.SPACE_DAMPING_ID] / 100,
      width: Math.max(0, Math.min(2, widthEff / 100)),
      duck: q[P.SPACE_DUCK_ID] / 100,
    });

    // I/O + mix smoothing.
    this.sm.inputGain.setTarget(dbToLin(q[P.GLOBAL_INPUT_GAIN_DB_ID]));
    this.sm.outputGain.setTarget(dbToLin(q[P.GLOBAL_OUTPUT_GAIN_DB_ID]));
    this.sm.mix.setTarget(q[P.GLOBAL_MIX_ID] / 100);
    const inputGain = this.sm.inputGain.tick();
    const outputGain = this.sm.outputGain.tick();
    const mix = this.sm.mix.tick();
    // PUNCH>0 adds a short parallel transient lift after the compressor
    // (phase-safe — pure gain); PUNCH<0 trims transient peaks slightly.
    const transientPathTrim = punch > 0 ? punch * 0.35 : punch * 0.18;

    // ── 4. Sample loop ────────────────────────────────────────────
    let inPeak = 0;
    let outPeak = 0;
    const dynOut = { gl: 1, gr: 1, makeup: 1 };
    const charOut = { l: 0, r: 0 };
    const motionOut = { l: 0, r: 0 };
    const spaceOut = { l: 0, r: 0 };
    let sig: AnalysisSignals = this.analysis.processFrame(0, 0);
    for (let i = 0; i < frames; i++) {
      const dryL = L[i] * inputGain;
      const dryR = R[i] * inputGain;

      // Analysis tap (post input gain — IN trim calibrates reactivity).
      sig = this.analysis.processFrame(dryL, dryR);

      // Dynamics.
      this.dyn.processFrame(dryL, dryR, punch, sig.transient, dynOut);
      let wetL = dryL * dynOut.gl * dynOut.makeup;
      let wetR = dryR * dynOut.gl * dynOut.makeup;
      // Parallel transient path (PUNCH).
      if (transientPathTrim !== 0) {
        const t = sig.transient * transientPathTrim;
        wetL += dryL * t;
        wetR += dryR * t;
      }

      // Character.
      this.character.processFrame(wetL, wetR, charOut);
      wetL = charOut.l;
      wetR = charOut.r;

      // Motion.
      this.motion.processFrame(wetL, wetR, motionOut);
      wetL = motionOut.l;
      wetR = motionOut.r;

      // Space (wet-add, transient-ducked inside).
      this.space.processFrame(wetL, wetR, sig.transient, 1, spaceOut);
      wetL = spaceOut.l;
      wetR = spaceOut.r;

      // Safety: per-channel DC block + soft ceiling, then mix vs dry.
      wetL = softClip(this.dcL.process(wetL), 0.95);
      wetR = softClip(this.dcR.process(wetR), 0.95);
      const outL = (dryL * (1 - mix) + wetL * mix) * outputGain;
      const outR = (dryR * (1 - mix) + wetR * mix) * outputGain;

      L[i] = outL;
      R[i] = outR;

      if (this.metersEnabled) {
        const aIn = Math.abs(dryL) > Math.abs(dryR) ? Math.abs(dryL) : Math.abs(dryR);
        const aOut = Math.abs(outL) > Math.abs(outR) ? Math.abs(outL) : Math.abs(outR);
        if (aIn > inPeak) inPeak = aIn;
        if (aOut > outPeak) outPeak = aOut;
      }
    }

    // Non-finite sentinel: one bad sample means a recursive stage diverged
    // — reset instead of propagating (an audible glitch beats dead silence).
    if (!Number.isFinite(L[0]) || !Number.isFinite(R[0])) {
      this.reset();
      for (let i = 0; i < frames; i++) {
        L[i] = 0;
        R[i] = 0;
      }
      inPeak = 0;
      outPeak = 0;
    }

    // ── 5. Control-source bookkeeping (ALWAYS — matrix continuity) ─
    if (this.metersEnabled) {
      this.inPeakHold = Math.max(inPeak, this.inPeakHold * 0.85);
      this.outPeakHold = Math.max(outPeak, this.outPeakHold * 0.85);
      this.meters.inputPeakDb = linToDbMeter(this.inPeakHold);
      this.meters.outputPeakDb = linToDbMeter(this.outPeakHold);
      this.meters.gainReductionDb = this.dyn.grDb;
      this.meters.pressureActive = routeScale;
      for (let s = 0; s < ROUTE_SLOTS; s++) this.meters.routes[s] = this.routeActivity[s];
    }
    this.meters.transient = this.meters.transient * 0.5 + sig.transient * 0.5;
    this.meters.body = this.meters.body * 0.7 + sig.body * 0.3;
    this.meters.texture = this.meters.texture * 0.7 + sig.texture * 0.3;
    this.meters.density = sig.density;
    this.meters.inputEnergy = sig.inputEnergy;
  }

  /** Route slot that most recently configured destination d's smoother. */
  private routeSmoothOwner(d: number): number {
    for (let slot = 0; slot < ROUTE_SLOTS; slot++) {
      if (
        this.params[P.routeParamId(slot, "enabled")] >= 0.5 &&
        Math.round(this.params[P.routeParamId(slot, "destination")]) === d
      ) {
        return slot;
      }
    }
    return -1;
  }

  getMeters(): MorphMeters {
    return this.meters;
  }
}

function linToDbMeter(lin: number): number {
  return lin > 1e-5 ? 20 * Math.log10(lin) : -100;
}
