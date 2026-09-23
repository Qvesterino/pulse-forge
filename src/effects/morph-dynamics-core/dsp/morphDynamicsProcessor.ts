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
import { MOD_DESTINATIONS, MOD_SOURCES } from "../contracts/modulation.js";
import type { MorphMeters } from "../contracts/meters.js";
import { buildDefaultParams, clampParam, PARAM_BY_ID } from "../contracts/parameterSchema.js";
import type { AnalysisSignals } from "./analysis.js";
import { BlockSmoother, OnePoleHP, dbToLin, softClip } from "./dspUtils.js";
import { FeatureExtractor } from "./analysis.js";
import { DynamicsStage } from "./dynamics.js";
import { CharacterStage } from "./character.js";
import { MotionStage } from "./motion.js";
import { SpaceStage } from "./space.js";
import { BodyHarmonizer, HARM_VOICE_COUNT, type BodyHarmonizerParams } from "./harmony.js";

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
  /**
   * BODY Harmonizer (Experiment #1): harmony voices built ONLY from the
   * tonal body; summed into the wet path post-dynamics, pre-character, so
   * the harmony is glued by the same saturation/space stages as everything
   * else. Zero algorithmic latency (grains read only the past) — the dry
   * and harmony paths recombine phase-coherently with no compensation
   * delay, and the reported chain latency stays owned by the character
   * halfband. Bit-exact bypass when harm.enabled is off.
   */
  private harmony = new BodyHarmonizer();
  private harmonyOut = { l: 0, r: 0, dry: 1 };
  /** Preallocated per-block voice config (no allocation in the render path). */
  private harmonyVoicesCfg: BodyHarmonizerParams["voices"] = Array.from({ length: HARM_VOICE_COUNT }, () => ({
    enabled: false,
    interval: 0,
    detune: 0,
    level: 0.7,
    pan: 0,
  }));
  /**
   * Preallocated per-block stage output/config bags and the modulation
   * source vector — process() mutates them in place. Fresh literals per
   * block would put ~5 short-lived objects on the GC nursery every render
   * quantum (the module contract is no allocation after prepare()).
   */
  private src = new Array<number>(MOD_SOURCES.length).fill(0);
  private dynOut = { gl: 1, gr: 1, makeup: 1 };
  private charOut = { l: 0, r: 0 };
  private motionOut = { l: 0, r: 0 };
  private spaceOut = { l: 0, r: 0 };
  private harmonyParams: BodyHarmonizerParams = {
    enabled: true,
    bodyAmount: 1,
    mix: 0.5,
    fullSignal: false,
    spread: 1,
    width: 1,
    diffusion: 0,
    space: 0,
    voices: this.harmonyVoicesCfg,
  };
  // ── Spatial Bloom control signal (Experiment #3, §6) ────────────
  // bloom = BODY score → curve (§3: nothing below ~0.2, rising through
  // the musical range) → enveloped (attack ~80 ms, release ~450 ms — the
  // field contracts gently when a phrase ends). Exposed as MOD SOURCE
  // "Bloom" (index 7); the harm.bloom macro scales the spatial deltas.
  private bloom = 0;
  private bloomUp = 1;
  private bloomDown = 1;

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
    harmonyMix: new BlockSmoother(0.5, 0.05) /**
     * Per-ROUTE smoothing (5..300 ms each): a transient route (wants ~5 ms)
     * and a body route (wants ~150 ms) may share a destination — the route
     * that owns the modulation owns its TC. The destination value is the SUM
     * of the per-route smoothed deltas.
     */,
    route: Array.from({ length: ROUTE_SLOTS }, () => new BlockSmoother(0, 0.04)),
  };
  /** Per-destination sum of SMOOTHED route deltas (plain units of the dest). */
  private rawDelta = new Array<number>(MOD_DESTINATIONS.length).fill(0);

  /** Bound-once mod-matrix clamp — a per-block closure would be a
   * render-path allocation (the module contract is allocate-free). */
  private modDelta = (destIdx: number, base: number): number => {
    const dest = MOD_DESTINATIONS[destIdx]!;
    return Math.max(dest.min, Math.min(dest.max, base + this.rawDelta[destIdx]!));
  };

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
    agcBoostDb: 0,
    routes: new Array<number>(ROUTE_SLOTS).fill(0),
  };
  private inPeakHold = 0;
  private outPeakHold = 0;
  private disposed = false;
  // Dry-path compensation delay (phase-conscious dry/wet): when the 2×
  // character halfband is active it delays the wet chain by 8 samples —
  // the mix/delta dry reference must be delayed identically or every
  // blended output combs.
  private dryBufL = new Float32Array(16);
  private dryBufR = new Float32Array(16);
  private dryPos = 0;
  /** Block-rate control math (morph glide advance) needs the real rate. */
  private sampleRate = 48000;

  prepare(sampleRate: number, _channelCount: number, maxBlockSize: number, qualityMode: number): void {
    this.sampleRate = sampleRate;
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
    this.harmony.prepare(sampleRate);
    this.dcL.setFreq(9, sampleRate);
    this.dcR.setFreq(9, sampleRate);
    // Bloom envelope per-block coefficients (attack/release in seconds,
    // referenced to the control rate).
    const blockSec = maxBlockSize / Math.max(1, sampleRate);
    this.bloomUp = 1 - Math.exp(-blockSec / 0.08);
    this.bloomDown = 1 - Math.exp(-blockSec / 0.45);
    this.applyQuality();
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
    // Zero in ECO; the 2× character halfband adds 8 base samples in
    // NORMAL/HIGH. The dry/mix path is delayed by the same amount inside
    // process() (phase-conscious dry/wet), so the reported latency is
    // purely informational for host PDC alignment.
    return this.character.latencySamples;
  }

  setParameter(id: string, value: number): void {
    if (!PARAM_BY_ID.has(id)) return;
    this.params[id] = clampParam(id, value);
    // During an active morph the host (doc sync / user touch) OVERRULES the
    // glide for that id: collapse its start AND target to the new value so
    // the morph continues smoothly around it instead of fighting the host.
    if (this.morphDur > 0 && id in this.morphTarget) {
      this.morphStart[id] = this.params[id];
      this.morphTarget[id] = this.params[id];
    }
    // Quality changes reconfigure the character oversampling (and thus the
    // chain latency) — the entry's change-guarded postLatency picks the new
    // value up right after this message.
    if (id === P.GLOBAL_QUALITY_ID) this.applyQuality();
    this.pushStaticParams();
  }

  // ── Morph scenes (A–D) ────────────────────────────────────────
  // The document stays owner of truth: the panel commits a scene as ONE
  // undoable command while the engine GLIDES audibly to the same values.
  // Globals (I/O, mix, quality) and the mod-matrix wiring are scene-immune
  // — a scene changes how the processor behaves, not how it is wired or
  // how loud it is.
  private morphIds: string[] = [];
  private morphStart: Record<string, number> = {};
  private morphTarget: Record<string, number> = {};
  private morphPos = 0;
  private morphDur = 0;

  startMorph(target: Record<string, number>, durationSec: number): void {
    this.cancelMorph();
    for (const [id, value] of Object.entries(target)) {
      if (!PARAM_BY_ID.has(id)) continue;
      if (id.startsWith("global.") || id.startsWith("routes.")) continue;
      this.morphIds.push(id);
      this.morphStart[id] = this.params[id] ?? 0;
      this.morphTarget[id] = clampParam(id, value);
    }
    this.morphPos = 0;
    this.morphDur = Math.max(0.05, durationSec);
  }

  private cancelMorph(): void {
    this.morphIds.length = 0;
    this.morphStart = {};
    this.morphTarget = {};
    this.morphPos = 0;
    this.morphDur = 0;
  }

  /** Advance the glide one block; params carry the interpolated values. */
  private advanceMorph(blockSec: number): void {
    if (this.morphDur <= 0) return;
    this.morphPos += blockSec;
    const t = Math.min(1, this.morphPos / this.morphDur);
    const k = t * t * (3 - 2 * t); // smoothstep ease-in-out
    for (const id of this.morphIds) {
      this.params[id] = this.morphStart[id] + (this.morphTarget[id] - this.morphStart[id]) * k;
    }
    if (t >= 1) {
      this.cancelMorph();
      this.pushStaticParams(); // sensitivity/motion-center catch up post-morph
    }
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
    this.applyQuality(); // quality is a CONFIG param — a loaded project/preset
    // must reconfigure oversampling + analysis resolution, not just values.
    this.pushStaticParams();
  }

  reset(): void {
    this.analysis.reset();
    this.dyn.reset();
    this.character.reset();
    this.motion.reset();
    this.space.reset();
    this.harmony.reset();
    this.dcL.reset();
    this.dcR.reset();
    this.dryBufL.fill(0);
    this.dryBufR.fill(0);
    for (const s of this.sm.route) s.snap();
    this.cancelMorph();
  }

  /** Quality mode → analysis resolution + character oversampling (+ its
   * dry-path compensation delay). Called from prepare and whenever the
   * global.quality param changes. */
  private applyQuality(): void {
    const mode = Math.round(this.params[P.GLOBAL_QUALITY_ID] ?? 1);
    this.analysis.setQuality(mode);
    this.character.setQuality(mode);
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
    this.analysis.setAdaptiveLevel(q[P.ANALYSIS_ADAPTIVE_LEVEL_ID] >= 0.5);
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
  /**
   * Process one block of stereo. inputs[0]/[1] must hold `frames` samples;
   * they are overwritten with the output. `sc` is the optional external
   * sidechain feed (same length) — consumed only when dyn.sidechainExt is
   * on; pass null otherwise.
   */
  process(inputs: Float32Array[], frames: number, sc?: Float32Array[] | null): void {
    if (this.disposed) {
      for (const ch of inputs) ch.fill(0, 0, frames);
      return;
    }
    const q = this.params;
    const L = inputs[0];
    const mono = !inputs[1] || inputs[1] === inputs[0];
    // Mono input: READ aliases L, but the right-channel RESULT must land in
    // its own storage — writing into the aliased buffer let the right output
    // overwrite the left mid-block.
    const R = mono ? new Float32Array(frames) : (inputs[1] as Float32Array);

    // Morph scenes: glide params toward the active scene target BEFORE the
    // block reads them — sections 1+ run on the interpolated values.
    this.advanceMorph(frames / this.sampleRate);

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
    // Spatial Bloom (Experiment #3 §3/§6): curve the BODY score —
    // nothing below ~0.2 (intimate), rising through the musical range —
    // then glide it (fast attack, slow release: the field contracts
    // gently when a phrase ends, it does not collapse).
    const bloomRaw = smoothstep(this.meters.body, 0.2, 0.95);
    this.bloom += (bloomRaw - this.bloom) * (bloomRaw > this.bloom ? this.bloomUp : this.bloomDown);
    // Reusable source vector (MOD_SOURCES order — see contracts/modulation).
    const src = this.src;
    src[0] = this.meters.inputEnergy;
    src[1] = this.dyn.grNorm;
    src[2] = this.meters.transient;
    src[3] = this.meters.body;
    src[4] = this.meters.texture;
    src[5] = this.meters.density;
    src[6] = routeScale; // PRESSURE as a source = post-curve reactive depth
    src[7] = this.bloom; // Spatial Bloom (Experiment #3) — curved, enveloped body energy
    this.rawDelta.fill(0);
    for (let slot = 0; slot < ROUTE_SLOTS; slot++) {
      this.routeActivity[slot] = 0;
      const routeSm = this.sm.route[slot];
      if (q[P.routeParamId(slot, "enabled")] < 0.5) {
        // A disabled route decays its smoother to zero — toggling a route
        // mid-playback never steps the destination.
        routeSm.setTarget(0);
        routeSm.tick();
        continue;
      }
      const sourceIdx = Math.round(q[P.routeParamId(slot, "source")]);
      const destIdx = Math.round(q[P.routeParamId(slot, "destination")]);
      const dest = MOD_DESTINATIONS[destIdx];
      if (!dest) continue;
      const s = src[sourceIdx] ?? 0;
      const amount = q[P.routeParamId(slot, "amount")] / 100;
      const delta = amount * s * dest.span * routeScale;
      // Per-route smoothing (its OWN smoothMs — routes sharing a destination
      // no longer fight over one TC), then the destination sums the members.
      routeSm.tc = q[P.routeParamId(slot, "smoothMs")] / 1000;
      routeSm.setTarget(delta);
      this.rawDelta[destIdx] += routeSm.tick();
      if (this.metersEnabled) this.routeActivity[slot] = Math.min(1, Math.abs(amount * s) * routeScale * 1.25);
    }

    // ── 3. Effective (curated + modulated) stage values ───────────
    // External sidechain intent (the feed itself is consumed in the sample
    // loop): when EXT is on, AUTO MAKEUP stands down — reactive makeup would
    // compensate exactly the ducking the user asked for. Manual makeup still
    // applies.
    const sidechainExt = q[P.DYN_SIDECHAIN_EXT_ID] >= 0.5;
    // f1 — dynamics deepen from the first percent of PRESSURE.
    this.sm.thresholdOffset.setTarget(-10 * Math.pow(dynScale, 1.2));
    this.sm.ratioBonus.setTarget(3.5 * Math.pow(dynScale, 1.6));
    this.sm.makeupBonus.setTarget(1.5 * dynScale * dynScale);
    const thresholdEff = this.modDelta(0, q[P.DYN_THRESHOLD_DB_ID] + this.sm.thresholdOffset.tick());
    const ratioEff = this.modDelta(1, q[P.DYN_RATIO_ID] + this.sm.ratioBonus.current);
    this.dyn.setParams({
      thresholdDb: thresholdEff,
      ratio: ratioEff,
      attackMs: q[P.DYN_ATTACK_MS_ID],
      releaseMs: q[P.DYN_RELEASE_MS_ID],
      kneeDb: q[P.DYN_KNEE_DB_ID],
      detectorBlend: q[P.DYN_DETECTOR_BLEND_ID] / 100,
      sidechainHpfHz: q[P.DYN_SIDECHAIN_HPF_HZ_ID],
      makeupDb: q[P.DYN_MAKEUP_DB_ID] + this.sm.makeupBonus.current,
      makeupAuto: q[P.DYN_MAKEUP_AUTO_ID] >= 0.5 && !sidechainExt,
    });
    this.sm.punch.setTarget(q[P.MACRO_PUNCH_ID] / 100);
    const punch = this.sm.punch.tick();

    // f2 — character: BODY macro biases drive; curated reactive drive
    // (body + GR → drive, the product identity) scaled by charScale;
    // routes add on top. Stage toggle is a hard bypass.
    const charOn = q[P.CHAR_ENABLED_ID] >= 0.5;
    const reactiveDrive = (this.meters.body * 30 + this.dyn.grNorm * 25) * charScale;
    this.sm.driveBase.setTarget(q[P.CHAR_DRIVE_ID] + (q[P.MACRO_BODY_ID] / 100) * 25 * charScale);
    // tick() is what ADVANCES the smoother — reading .current without it
    // pins the value at its initial 0 forever, silently bypassing the whole
    // character stage (found by the alias-rejection test).
    const driveEff = this.modDelta(2, this.sm.driveBase.tick() + reactiveDrive);
    const toneEff = this.modDelta(3, q[P.CHAR_TONE_ID] + (q[P.MACRO_BODY_ID] - 50) * 0.3);
    const clipEff = this.modDelta(4, q[P.CHAR_CLIP_ID] + q[P.MACRO_PUNCH_ID] * 0.15);
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
    // All four controls pass through their BlockSmoothers like every other
    // stage — a macro jump or preset snap must step the AP bank click-free
    // (the depth is a wet crossfade; a raw step clicks).
    const motionOn = q[P.MOTION_ENABLED_ID] >= 0.5;
    this.sm.motionDepth.setTarget(
      motionOn
        ? Math.max(0, Math.min(100, this.modDelta(5, (q[P.MACRO_MOTION_ID] / 100) * (35 + 65 * motionScale)))) / 100
        : 0,
    );
    this.sm.motionRate.setTarget(motionOn ? Math.max(0, this.modDelta(6, q[P.MOTION_RATE_HZ_ID])) : 0);
    this.sm.motionFeedback.setTarget(
      motionOn
        ? Math.max(-80, Math.min(80, this.modDelta(7, q[P.MOTION_FEEDBACK_ID] + this.dyn.grNorm * 40 * motionScale))) /
            100
        : 0,
    );
    this.sm.motionSweep.setTarget(
      motionOn
        ? Math.max(
            -1,
            Math.min(
              1,
              (this.meters.body - 0.35) * 0.9 * motionScale + (this.meters.density - 0.4) * 0.4 * motionScale,
            ),
          )
        : 0,
    );
    this.motion.setControl(
      this.sm.motionDepth.tick(),
      this.sm.motionRate.tick(),
      this.sm.motionFeedback.tick(),
      this.sm.motionSweep.tick(),
    );

    // f4 — space: macro send with a spaceScale floor (SPACE alone still
    // blooms); texture/density open send + diffusion reactively; transient
    // ducking comes straight from the analysis; width follows TEXTURE macro.
    const spaceOn = q[P.SPACE_ENABLED_ID] >= 0.5;
    const sendBase = (q[P.MACRO_SPACE_ID] / 100) * (40 + 60 * spaceScale);
    const sendEff = this.modDelta(8, sendBase + (this.meters.texture * 20 + this.meters.density * 10) * spaceScale);
    const diffEff = this.modDelta(9, q[P.SPACE_DIFFUSION_ID] + this.meters.texture * 25 * spaceScale);
    const decayEff = this.modDelta(10, q[P.SPACE_DECAY_S_ID] + this.meters.body * 0.5 * spaceScale);
    const widthEff = this.modDelta(11, q[P.SPACE_WIDTH_ID] * (0.7 + 0.6 * (q[P.MACRO_TEXTURE_ID] / 100)));
    this.space.setParams({
      send: spaceOn ? Math.max(0, Math.min(100, sendEff)) / 100 : 0,
      predelayMs: q[P.SPACE_PREDELAY_MS_ID],
      diffusion: Math.max(0, Math.min(1, diffEff / 100)),
      decayS: Math.max(0.1, Math.min(5, decayEff)),
      damping: q[P.SPACE_DAMPING_ID] / 100,
      width: Math.max(0, Math.min(2, widthEff / 100)),
      duck: q[P.SPACE_DUCK_ID] / 100,
    });

    // BODY Harmonizer (Experiment #1): mix is a MOD DESTINATION (route
    // "Harmony Mix" — the Harmonic Bloom hook drives it externally), the
    // module skipped ENTIRELY when off (bit-exact bypass, zero CPU).
    // Spatial Bloom (Experiment #3): the four spatial depths are MOD
    // DESTINATIONS 13–16 whose deltas are scaled by the harm.bloom macro
    // (§15 — the macro scales reactive depth, base knobs stay honest).
    // PRESSURE reaches them through the common routeScale like every
    // other destination (§7 — no special-case PRESSURE wiring).
    const harmOn = q[P.HARM_ENABLED_ID] >= 0.5;
    if (harmOn) {
      this.sm.harmonyMix.setTarget(this.modDelta(12, q[P.HARM_MIX_ID]));
      const voices = this.harmonyVoicesCfg;
      for (let v = 0; v < HARM_VOICE_COUNT; v++) {
        const vc = voices[v]!;
        vc.enabled = q[P.harmVoiceParamId(v, "on")] >= 0.5;
        vc.interval = q[P.harmVoiceParamId(v, "interval")];
        vc.detune = q[P.harmVoiceParamId(v, "detune")];
        vc.level = q[P.harmVoiceParamId(v, "level")] / 100;
        vc.pan = q[P.harmVoiceParamId(v, "pan")] / 100;
      }
      const bloomScale = q[P.HARM_BLOOM_ID] / 100;
      // Mutate the preallocated config bag in place — the harmonizer holds
      // this reference, so a fresh literal per block is both an allocation
      // and unnecessary.
      const hp = this.harmonyParams;
      hp.enabled = true;
      hp.bodyAmount = q[P.HARM_BODY_AMOUNT_ID] / 100;
      hp.mix = this.sm.harmonyMix.tick() / 100;
      hp.fullSignal = q[P.HARM_DEV_FULL_SIGNAL_ID] >= 0.5;
      hp.spread = Math.max(0, Math.min(200, q[P.HARM_SPREAD_ID] + this.rawDelta[13]! * bloomScale)) / 100;
      hp.width = Math.max(0, Math.min(200, q[P.HARM_WIDTH_ID] + this.rawDelta[14]! * bloomScale)) / 100;
      hp.diffusion = Math.max(0, Math.min(100, q[P.HARM_DIFFUSION_ID] + this.rawDelta[15]! * bloomScale)) / 100;
      hp.space = Math.max(0, Math.min(100, q[P.HARM_SPACE_ID] + this.rawDelta[16]! * bloomScale)) / 100;
      hp.voices = voices;
      this.harmony.setParams(hp);
    }

    // I/O + mix smoothing.
    this.sm.inputGain.setTarget(dbToLin(q[P.GLOBAL_INPUT_GAIN_DB_ID]));
    this.sm.outputGain.setTarget(dbToLin(q[P.GLOBAL_OUTPUT_GAIN_DB_ID]));
    this.sm.mix.setTarget(q[P.GLOBAL_MIX_ID] / 100);
    const inputGain = this.sm.inputGain.tick();
    const outputGain = this.sm.outputGain.tick();
    const mix = this.sm.mix.tick();
    const deltaOn = q[P.GLOBAL_DELTA_ID] >= 0.5;
    // PUNCH>0 adds a short parallel transient lift after the compressor
    // (phase-safe — pure gain); PUNCH<0 trims transient peaks slightly.
    const transientPathTrim = punch > 0 ? punch * 0.35 : punch * 0.18;

    // ── 4. Sample loop ────────────────────────────────────────────
    let inPeak = 0;
    let outPeak = 0;
    const dynOut = this.dynOut;
    const charOut = this.charOut;
    const motionOut = this.motionOut;
    const spaceOut = this.spaceOut;
    let sig: AnalysisSignals = this.analysis.processFrame(0, 0);
    // External sidechain (dyn.sidechainExt): the DETECTOR and the ANALYSIS
    // tap follow the sidechain feed instead of the main signal — a kick or
    // vocal chop drives the ducking/gain while the main audio stays put.
    // Length-checked: a short feed must fall back to the main signal, not
    // read out of bounds into NaN.
    const scLArr = sc?.[0];
    const scRArr = sc?.[1];
    const extSc =
      sidechainExt &&
      scLArr !== undefined &&
      scRArr !== undefined &&
      scLArr.length >= frames &&
      scRArr.length >= frames;
    const dryDelay = this.character.latencySamples;
    for (let i = 0; i < frames; i++) {
      const detL = (extSc ? scLArr![i] : L[i]) * inputGain;
      const detR = (extSc ? scRArr![i] : R[i]) * inputGain;

      // Analysis tap (post input gain — IN trim calibrates reactivity).
      sig = this.analysis.processFrame(detL, detR);

      // Dynamics: the detector listens to (detL, detR); the gain applies to
      // the AUDIBLE main path (which stays untouched in EXT mode).
      this.dyn.processFrame(detL, detR, punch, sig.transient, dynOut);
      let wetL = L[i] * inputGain * dynOut.gl * dynOut.makeup;
      let wetR = R[i] * inputGain * dynOut.gl * dynOut.makeup;
      // Parallel transient path (PUNCH).
      if (transientPathTrim !== 0) {
        const t = sig.transient * transientPathTrim;
        wetL += detL * t;
        wetR += detR * t;
      }

      // BODY Harmonizer: duck the sustained body of the wet path to make
      // room (dryGain, same mask the voices were built from) and add the
      // harmony bus — phase-coherent, zero-latency recombination.
      if (harmOn) {
        this.harmony.processFrame(detL, detR, this.harmonyOut);
        wetL = wetL * this.harmonyOut.dry + this.harmonyOut.l;
        wetR = wetR * this.harmonyOut.dry + this.harmonyOut.r;
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
      // Dry reference for mix/delta — delayed by the character OS latency so
      // the wet chain (2× halfband) never combs against it.
      this.dryBufL[this.dryPos] = detL;
      this.dryBufR[this.dryPos] = detR;
      const rd = (this.dryPos - dryDelay + 16) % 16;
      const mixDryL = this.dryBufL[rd];
      const mixDryR = this.dryBufR[rd];
      this.dryPos = (this.dryPos + 1) % 16;
      let outL = (mixDryL * (1 - mix) + wetL * mix) * outputGain;
      let outR = (mixDryR * (1 - mix) + wetR * mix) * outputGain;
      // Delta listen: output carries ONLY what the whole chain changed
      // (phase-aligned — both paths share inputGain and the OS delay).
      if (deltaOn) {
        outL = (wetL - mixDryL) * outputGain;
        outR = (wetR - mixDryR) * outputGain;
      }

      L[i] = outL;
      R[i] = outR;

      if (this.metersEnabled) {
        const aIn = Math.abs(detL) > Math.abs(detR) ? Math.abs(detL) : Math.abs(detR);
        const aOut = Math.abs(outL) > Math.abs(outR) ? Math.abs(outL) : Math.abs(outR);
        if (aIn > inPeak) inPeak = aIn;
        if (aOut > outPeak) outPeak = aOut;
      }
    }

    // Mono input: fold the stereo result back into the caller's single
    // buffer (mid downmix) — R was scratch, so without this the right half
    // of the processing would silently vanish.
    if (mono) {
      for (let i = 0; i < frames; i++) L[i] = (L[i] + R[i]) * 0.5;
    }

    // Non-finite sentinel: one bad sample means a recursive stage diverged
    // — reset instead of propagating (an audible glitch beats dead silence).
    // Check BOTH endpoints so a divergence that starts mid-block is caught in
    // the SAME block rather than waiting for the next call. First-sample-only
    // leaves the corrupted samples for the surrounding hardware to absorb.
    const last = frames - 1;
    // Mono: R is the scratch right-channel result; stereo: R is inputs[1].
    if (!Number.isFinite(L[0]) || !Number.isFinite(R[0]) || !Number.isFinite(L[last]) || !Number.isFinite(R[last])) {
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
      // AGC observability: the compensation the scores receive relative to
      // the fixed nominal, in dB. The normalization divides BY the
      // reference, so a SMALL reference (quiet material) lifts scores —
      // positive boost; a large reference (hot material) tames them —
      // negative, capped at −8 dB. 0 when AGC is off.
      this.meters.agcBoostDb =
        q[P.ANALYSIS_ADAPTIVE_LEVEL_ID] >= 0.5
          ? 20 * Math.log10(0.1 / Math.max(this.analysis.getReference(), 1e-6))
          : 0;
      for (let s = 0; s < ROUTE_SLOTS; s++) this.meters.routes[s] = this.routeActivity[s];
    }
    this.meters.transient = this.meters.transient * 0.5 + sig.transient * 0.5;
    this.meters.body = this.meters.body * 0.7 + sig.body * 0.3;
    this.meters.texture = this.meters.texture * 0.7 + sig.texture * 0.3;
    this.meters.density = sig.density;
    this.meters.inputEnergy = sig.inputEnergy;
  }

  getMeters(): MorphMeters {
    return this.meters;
  }
}

function linToDbMeter(lin: number): number {
  return lin > 1e-5 ? 20 * Math.log10(lin) : -100;
}
