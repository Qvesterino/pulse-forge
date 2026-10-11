/**
 * REZONANS — processor.
 *
 *   mono(0.5(L+R)) → FrameEngine (STFT · envelope · f0)
 *                          │
 *                          ├─ HarmonySolver → per-voice ratio  (key / chord)
 *                          └─ HarmonyBus    → per-voice render   (warp · PV · lock)
 *                                    │
 *   dry ──► delay(N - 1) ─────────────┴─► mix → out
 *
 * DRY/WET ALIGNMENT. A spectral formant shifter cannot be causal, so the wet
 * path's transient peak is N - 1 samples behind the dry. The dry is therefore delayed by the SAME
 * amount INSIDE the processor, so the mix stays coherent and the whole insert
 * reports its latency honestly through `getLatencySamples()` for PDC to
 * compensate against the rest of the graph (ADR 0040 §12).
 *
 * UNVOICED. Below the clarity gate the harmony voices fade out over ~10 ms and
 * their ratio is HELD, never chased — consonants and sibilants pass through as
 * dry. This is the single most important quality behaviour in the processor:
 * a harmonizer that chases an unreliable f0 is a robot, not a vocal.
 *
 * Determinism: no RNG anywhere in the signal path.
 */

import {
  REZONANS_PARAMS,
  REZ_PARAM,
  QUALITY_FFT_SIZE,
  QUALITY_FINE,
  buildDefaultParams,
  clampParam,
  hopFor,
  resolveFormantSemitones,
  voiceParamId,
  VOICE_COUNT,
} from "../contracts/parameters.js";
import { FrameEngine } from "./frame.js";
import {
  HarmonyBus,
  MusicalClock,
  MAX_RATIO,
  MIN_RATIO,
  clamp,
  humanizeCents,
  type ChordLaneEntry,
  type HarmonyMode,
} from "./harmony.js";
import { HarmonySolver, SOLVER_VOICES, type SolverContext } from "./solver.js";

const MODES: HarmonyMode[] = ["off", "interval", "degrees", "chordTones"];

export interface HarmonyContextInit {
  keyRootPc: number;
  scaleMask: number;
  chords: ReadonlyArray<{
    startBar: number;
    lengthBars: number;
    rootPc: number;
    chordMask: number;
  }>;
}

export interface RezMeters {
  f0: number;
  clarity: number;
  chordPc: number;
  bar: number;
  activeVoices: number;
  latencySamples: number;
  sampleRate: number;
  /** Share of frames that passed the clarity gate (diagnostic, P1 A2). */
  voicedRatio: number;
  claritySum: number;
  /**
   * Resolved MIDI target per voice, read straight off the solver.
   *
   * The panel draws these instead of re-deriving targets from the chord lane:
   * a host-side recomputation would have to guess the same masks AND the same
   * clarity-gated hold behaviour, and any disagreement between the drawing and
   * the audio is exactly the "instrument lies to the user" defect this meter
   * exists to prevent. `-1` means "not solved yet" (never voiced).
   */
  voiceMidi: number[];
}

export class RezonansProcessor {
  private params: Record<string, number> = buildDefaultParams();

  private frame = new FrameEngine();
  private bus = new HarmonyBus();
  private solver = new HarmonySolver();
  private clock = new MusicalClock();

  private sampleRate = 48000;
  private channels = 2;
  private blockSize = 128;
  /** Context time the clock was seeded at — anchors `syncBpm(when)` offsets. */
  private clockOriginSec = 0;
  private elapsedSec = 0;

  private ratioTarget = new Float64Array(SOLVER_VOICES);
  private ratioSm = new Float64Array(SOLVER_VOICES);
  private alpha = new Float64Array(SOLVER_VOICES);
  private voiceGain = new Float64Array(SOLVER_VOICES);
  private degree = new Float64Array(SOLVER_VOICES);

  private solverCtx: SolverContext = {
    mode: "degrees",
    keyRootPc: 0,
    scaleMask: 0b101010110101,
    chordMask: 0,
    chordFollow: 1,
  };

  private chords: ChordLaneEntry[] = [];
  private chordCursor = 0;
  private currentChordPc = -1;

  /** Per-channel dry delay lines keep unvoiced consonants stereo and PDC-aligned. */
  private dryRingL = new Float32Array(0);
  private dryRingR = new Float32Array(0);
  private dryMask = 0;
  private dryWrite = 0;
  /** Crossfade from harmonies to the latency-matched source on transients/unvoiced frames. */
  private sourcePassGain = 1;

  private gate = 1;
  private gateCoef = 0;
  private envFast = 0;
  private envCoefFast = 0;
  private envSlow = 0;
  private envCoefSlow = 0;

  private glideCoef = 0;
  private mixSm = 0;
  private mixSmCoef = 0;
  private gateSmCoef = 0;

  private voicedFrames = 0;
  private claritySum = 0;

  private out = { l: 0, r: 0 };
  private bypass = true;
  private metersOn = false;
  private meters: RezMeters = {
    f0: 0,
    clarity: 0,
    chordPc: -1,
    bar: 0,
    activeVoices: 0,
    latencySamples: 0,
    sampleRate: 48000,
    voicedRatio: 0,
    claritySum: 0,
    voiceMidi: new Array<number>(VOICE_COUNT).fill(-1),
  };

  // ── lifecycle ────────────────────────────────────────────────────────

  prepare(sampleRate: number, channels = 2, blockSize = 128, bpm = 120): void {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.blockSize = blockSize;
    this.clock.prepare(sampleRate, bpm);
    this.applyQuality(this.params[REZ_PARAM.quality] ?? 1);
    this.recomputeCoefficients();
    this.reset();
  }

  reset(): void {
    this.frame.reset();
    this.bus.reset();
    this.solver.reset();
    this.clock.reset();
    this.ratioTarget.fill(1);
    this.ratioSm.fill(1);
    this.alpha.fill(1);
    this.voiceGain.fill(0);
    this.dryRingL.fill(0);
    this.dryRingR.fill(0);
    this.dryWrite = 0;
    this.sourcePassGain = 1;
    this.gate = 1;
    this.envFast = 0;
    this.envSlow = 0;
    this.mixSm = 0;
    this.chordCursor = 0;
    this.currentChordPc = -1;
    this.solverCtx.chordMask = 0;
  }

  /** Latency the processor reports (ADR §12). */
  getLatencySamples(): number {
    return this.frame.latencySamples;
  }

  private applyQuality(quality: number): void {
    const q = Math.round(clamp(quality, 0, QUALITY_FINE));
    const fftSize = QUALITY_FFT_SIZE[q] ?? 2048;
    const hop = hopFor(fftSize);

    this.frame.prepare(this.sampleRate, fftSize, hop);
    this.bus.prepare(this.sampleRate, fftSize, hop);

    // The dry ring is sized from the NEW latency, so this must come after
    // frame.prepare() — sizing it from the previous configuration would make
    // the very first blocks read out of range on a quality change.
    const latency = this.frame.latencySamples;
    let ringLen = 1;
    while (ringLen < latency + 8) ringLen <<= 1;
    if (ringLen !== this.dryRingL.length) {
      this.dryRingL = new Float32Array(ringLen);
      this.dryRingR = new Float32Array(ringLen);
      this.dryMask = ringLen - 1;
      this.dryWrite = 0;
    }
  }

  private recomputeCoefficients(): void {
    const sr = this.sampleRate;
    // Envelope smoothing: 0 → 3 ms quefrency cutoff (follows the voice
    // closely), 1 → 1 ms (very smooth, "vintage" formant character).
    const smooth = this.params[REZ_PARAM.envelopeSmooth] ?? 0.5;
    const quefrencySec = 0.003 - 0.002 * clamp(smooth, 0, 1);
    this.frame.setQuefrencyCut(quefrencySec);
    this.frame.setPitchRange(this.params[REZ_PARAM.minHz] ?? 70, 800);

    // Voice fade: fixed ~10 ms, it is an artifact-protection time constant,
    // not a musical control.
    const voiceTc = 0.01;
    this.gateSmCoef = Math.exp(-1 / (voiceTc * sr));
    this.mixSmCoef = Math.exp(-1 / (0.03 * sr));

    // Glide: 0 → 80 ms, 1 → 5 ms.
    const glide = this.params[REZ_PARAM.glide] ?? 0.35;
    const glideTc = 0.08 - 0.075 * clamp(glide, 0, 1);
    // ratioSm advances once per analysis frame, not once per sample. Scale
    // the one-pole by the actual hop so the advertised 5–80 ms glide remains
    // stable across Economy/Balanced/Fine quality settings.
    this.glideCoef = Math.exp(-this.frame.synthesisHop / (glideTc * sr));

    // Body gate envelopes (the transient/body split reused from MORPH).
    this.envCoefFast = Math.exp(-1 / (0.002 * sr));
    this.envCoefSlow = Math.exp(-1 / (0.06 * sr));
    this.gateCoef = Math.exp(-1 / (0.04 * sr));

    const modeIdx = Math.round(this.params[REZ_PARAM.harmonyMode] ?? 2);
    this.solverCtx.mode = MODES[clamp(modeIdx, 0, 3)] ?? "degrees";
    this.solverCtx.chordFollow = this.params[REZ_PARAM.chordFollow] ?? 1;
  }

  // ── host surface ─────────────────────────────────────────────────────

  setParameter(id: string, value: number): void {
    const def = REZONANS_PARAMS.find((p) => p.id === id);
    const v = clampParam(id, value);
    if (this.params[id] === v && !def) return;
    this.params[id] = v;

    if (id === REZ_PARAM.quality) {
      const fftSize = QUALITY_FFT_SIZE[Math.round(v)] ?? 2048;
      if (fftSize !== this.frame.fftSize) {
        this.applyQuality(v);
        this.recomputeCoefficients();
        this.frame.reset();
        this.bus.reset();
      }
      return;
    }
    if (
      id === REZ_PARAM.envelopeSmooth ||
      id === REZ_PARAM.minHz ||
      id === REZ_PARAM.harmonyMode ||
      id === REZ_PARAM.chordFollow ||
      id === REZ_PARAM.glide
    ) {
      this.recomputeCoefficients();
    }
  }

  loadState(params: Record<string, number>): void {
    for (const [id, v] of Object.entries(params)) this.setParameter(id, v);
  }

  /** Project musical context (ADR §4.3a). Masks come from the host. */
  setHarmonyContext(ctx: HarmonyContextInit): void {
    if (!ctx) return;
    this.solverCtx.keyRootPc = ((Math.round(ctx.keyRootPc) % 12) + 12) % 12;
    this.solverCtx.scaleMask = Number.isFinite(ctx.scaleMask) ? ctx.scaleMask & 0xfff : 0;
    const lane = ctx.chords;
    this.chords.length = 0;
    if (Array.isArray(lane)) {
      for (const c of lane) {
        if (!c) continue;
        const startBar = Number(c.startBar);
        const lengthBars = Number(c.lengthBars);
        if (!Number.isFinite(startBar) || !Number.isFinite(lengthBars) || lengthBars <= 0) continue;
        this.chords.push({
          startBar,
          lengthBars,
          rootPc: ((Math.round(c.rootPc) % 12) + 12) % 12,
          chordMask: Number.isFinite(c.chordMask) ? c.chordMask & 0xfff : 0,
        });
      }
      this.chords.sort((a, b) => a.startBar - b.startBar);
    }
    this.chordCursor = 0;
  }

  /** Tempo (ADR §4.3b). */
  syncBpm(bpm: number, whenSec?: number): void {
    this.clock.syncBpm(bpm, whenSec ?? 0);
  }

  /** Transport seed — absolute musical position in beats, anchored in time. */
  onTransportStarted(positionBeats: number, timeSec = 0): void {
    this.clockOriginSec = timeSec;
    this.elapsedSec = 0;
    this.clock.seed(positionBeats);
  }

  /** Offline render seed: position and time both start at zero. */
  prepareOfflineRender(): void {
    this.clockOriginSec = 0;
    this.elapsedSec = 0;
    this.clock.seed(0);
  }

  setMetersEnabled(on: boolean): void {
    this.metersOn = on;
  }

  getMeters(): RezMeters {
    this.meters.f0 = this.frame.f0;
    this.meters.clarity = this.frame.clarity;
    this.meters.chordPc = this.currentChordPc;
    this.meters.bar = this.clock.bar;
    this.meters.latencySamples = this.getLatencySamples();
    this.meters.sampleRate = this.sampleRate;
    this.meters.voicedRatio = this.frame.frames > 0 ? this.voicedFrames / this.frame.frames : 0;
    this.meters.claritySum = this.frame.frames > 0 ? this.claritySum / this.frame.frames : 0;
    let active = 0;
    for (let i = 0; i < VOICE_COUNT; i++) if (this.voiceGain[i]! > 0.001) active++;
    this.meters.activeVoices = active;
    for (let i = 0; i < VOICE_COUNT; i++) {
      this.meters.voiceMidi[i] = this.solver.lastMidi[i]!;
    }
    return this.meters;
  }

  // ── render ───────────────────────────────────────────────────────────

  /**
   * Process one block in place.
   * `blocks` is [Float32Array, Float32Array]; `frames` may be shorter than the
   * array length (the render quantum is not guaranteed to be 128).
   */
  process(blocks: Float32Array[], frames: number): void {
    const left = blocks[0];
    const right = blocks[1] ?? blocks[0];
    if (!left) return;

    const mix = this.params[REZ_PARAM.mix] ?? 0.5;
    const mode = this.solverCtx.mode;
    const bypass = mode === "off" || mix <= 1e-6;
    this.bypass = bypass;

    if (bypass) {
      // Bit-exact bypass: no delay, no analysis, no allocation.
      this.bus.reset();
      this.frame.reset();
      return;
    }

    const delay = this.frame.latencySamples & this.dryMask;
    this.elapsedSec += frames / this.sampleRate;
    this.clock.advance(frames, this.clockOriginSec + this.elapsedSec);

    for (let i = 0; i < frames; i++) {
      const l = left[i]!;
      const r = right[i]!;
      const mono = 0.5 * (l + r);

      // ── body gate: sustained vs transient, the split MORPH uses ──
      const abs = Math.abs(mono);
      this.envFast = abs + this.envCoefFast * (this.envFast - abs);
      this.envSlow = abs + this.envCoefSlow * (this.envSlow - abs);
      // Sustainedness: when the slow mass matches the fast edge the tone is
      // being HELD. `bodyGate` scales how hard unvoiced material is excluded —
      // 0 leaves the gate fully open (no gating at all), 1 closes it fully.
      const bodyAmount = this.params[REZ_PARAM.bodyGate] ?? 0.5;
      const w = this.envFast > 1e-9 ? clamp(this.envSlow / this.envFast, 0, 1) : 0;
      const target = 1 - bodyAmount * (1 - w);
      this.gate += (target - this.gate) * (1 - this.gateCoef);

      // ── analysis + synthesis ──
      const due = this.frame.push(mono);
      if (due) this.renderFrame();

      this.bus.read(this.out);

      // ── voice gains (unvoiced hold) ──
      const voiced = this.frame.clarity >= (this.params[REZ_PARAM.clarity] ?? 0.75) && this.frame.f0 > 0;
      let hasVoice = false;
      for (let v = 0; v < VOICE_COUNT; v++) {
        const enabled = this.params[voiceParamId(v, "enabled")]! > 0.5;
        const level = enabled ? (this.params[voiceParamId(v, "level")] ?? 0) * this.gate : 0;
        if (level > 0.0005) hasVoice = true;
        const g = voiced ? level : 0;
        this.voiceGain[v] = this.voiceGain[v]! + (g - this.voiceGain[v]!) * (1 - this.gateSmCoef);
        this.bus.setVoiceGain(v, this.voiceGain[v]!);
      }

      // Keep consonants and attacks in the wet output. The source path is
      // latency-matched, so it can crossfade against the harmony voices with
      // no timing smear. Unvoiced frames pass fully; voiced transients use
      // the complement of the body gate; a patch with no enabled voice stays
      // a transparent insert instead of going silent at 100% wet.
      const sourcePassTarget = !voiced || !hasVoice ? 1 : 1 - this.gate;
      this.sourcePassGain += (sourcePassTarget - this.sourcePassGain) * (1 - this.gateSmCoef);

      // ── dry delay: matches the wet path's inherent latency ──
      const dryWritePos = this.dryWrite & this.dryMask;
      this.dryRingL[dryWritePos] = l;
      this.dryRingR[dryWritePos] = r;
      this.dryWrite++;
      const dryPos = (this.dryWrite - 1 - delay) & this.dryMask;
      const dryDelayedL = this.dryRingL[dryPos]!;
      const dryDelayedR = this.dryRingR[dryPos]!;

      this.mixSm += (mix - this.mixSm) * (1 - this.mixSmCoef);

      const wet = this.out;
      const m = this.mixSm;
      left[i] = dryDelayedL * (1 - m) + (wet.l + dryDelayedL * this.sourcePassGain) * m;
      right[i] = dryDelayedR * (1 - m) + (wet.r + dryDelayedR * this.sourcePassGain) * m;
    }
  }

  /** One synthesis frame: resolve musical targets, then render all voices. */
  private renderFrame(): void {
    const voiceCount = Math.round(clamp(this.params[REZ_PARAM.voices] ?? VOICE_COUNT, 1, VOICE_COUNT));
    const spread = this.params[REZ_PARAM.spread] ?? 1;
    const formantGlobal = this.params[REZ_PARAM.formant] ?? 0;
    const voiceScale = this.params[REZ_PARAM.formantVoiceScale] ?? 1;

    for (let v = 0; v < VOICE_COUNT; v++) {
      this.degree[v] = this.params[voiceParamId(v, "degree")] ?? 0;
      const vf = this.params[voiceParamId(v, "formant")] ?? 0;
      // Per-voice α is free because the warp is applied during synthesis
      // (ADR 0040 decision 6) — no extra transform, only arithmetic.
      this.alpha[v] = Math.pow(2, resolveFormantSemitones(formantGlobal, vf, voiceScale) / 12);
    }

    // Chord position is resolved EVERY frame, voiced or not: it is a musical
    // clock question, not an audio question. Gating it on `voiced` left the
    // panel showing "no chord" through every gap and rest — and it is the
    // bridge test that caught it.
    this.resolveChord();

    const voiced = this.frame.clarity >= (this.params[REZ_PARAM.clarity] ?? 0.75) && this.frame.f0 > 0;
    this.claritySum += this.frame.clarity;
    if (voiced) this.voicedFrames++;
    if (voiced) this.solver.solve(this.frame.f0, this.solverCtx, this.degree, this.ratioTarget);

    for (let v = 0; v < VOICE_COUNT; v++) {
      // Ratio glide: an abrupt ratio change is a pitch jump, which comb-flares
      // against the previous frame's partials.
      this.ratioSm[v] = this.ratioSm[v]! + (this.ratioTarget[v]! - this.ratioSm[v]!) * (1 - this.glideCoef);
      const ratio = clamp(this.ratioSm[v]!, MIN_RATIO, MAX_RATIO);
      const active = v < voiceCount && this.params[voiceParamId(v, "enabled")]! > 0.5;
      const humanize = active ? (this.params[voiceParamId(v, "humanize")] ?? 0) : 0;
      const cents = humanizeCents(this.frame.frames, v, humanize);
      const renderRatio = clamp(ratio * Math.pow(2, cents / 1200), MIN_RATIO, MAX_RATIO);
      this.bus.setVoiceTargets(
        v,
        renderRatio,
        clamp(this.alpha[v]!, 0.5, 2),
        active ? (this.params[voiceParamId(v, "level")] ?? 0) : 0,
        this.params[voiceParamId(v, "pan")] ?? 0,
        spread,
      );
    }

    this.bus.setBus(1, this.params[REZ_PARAM.width] ?? 1);
    this.bus.renderFrame(
      this.frame.mag,
      this.frame.phase,
      this.frame.previousPhase,
      this.frame.envLin,
      this.frame.envelope.logEnv,
    );
    this.frame.commitFrame();
  }

  /** Resolve the chord mask for the current bar from the lane. */
  private resolveChord(): void {
    const bar = this.clock.bar;
    const lane = this.chords;
    if (lane.length === 0) {
      this.solverCtx.chordMask = 0;
      this.currentChordPc = -1;
      return;
    }
    // The cursor only moves forward; a seek is caught by the rewind below.
    if (this.chordCursor >= lane.length || lane[this.chordCursor]!.startBar > bar) this.chordCursor = 0;
    while (this.chordCursor + 1 < lane.length && lane[this.chordCursor + 1]!.startBar <= bar) this.chordCursor++;

    const entry = lane[this.chordCursor]!;
    if (bar >= entry.startBar && bar < entry.startBar + entry.lengthBars) {
      this.solverCtx.chordMask = entry.chordMask;
      this.currentChordPc = entry.rootPc;
    } else {
      // Before the first bar: no chord, fall back to the scale.
      this.solverCtx.chordMask = 0;
      this.currentChordPc = -1;
    }
  }

  get isBypassed(): boolean {
    return this.bypass;
  }

  get blockSizeHint(): number {
    return this.blockSize;
  }

  get channelCount(): number {
    return this.channels;
  }

  get metersEnabled(): boolean {
    return this.metersOn;
  }
}
