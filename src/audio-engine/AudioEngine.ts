import type { DrumPad, EffectInstance, InstrumentTrack, MasterConfig, ProjectDocument, SceneAutomation } from "../project-model/types";
import type { AutomationPoint, Lfo } from "../project-model/types";
import { valueAt } from "../project-model/automation";
import { defaultMasterConfig } from "../project-model/schema";
import type { SampleBank } from "../sample-library/factory";
import { EFFECT_DEFS } from "../effects/registry";
import type { EffectRuntime } from "../effects/types";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentRuntime } from "../instruments/types";
import { channelLevels, splitChannels, stereoCorrelation, PeakHold, type Frame, type ChannelLevels } from "./metering";

interface FxChainState {
  runtimes: Map<string, EffectRuntime>;
  params: Map<string, Record<string, number>>;
  signature: string;
}

interface TrackNodes {
  input: GainNode;
  panner: StereoPannerNode;
  gain: GainNode;
  modAutoGain: GainNode;
  modAutoPan: StereoPannerNode;
  modMacroGain: GainNode;
  modMacroPan: StereoPannerNode;
  analyser: AnalyserNode;
  fx: FxChainState;
  sends: Map<string, GainNode>;
}

interface ReturnNodes {
  input: GainNode;
  gain: GainNode;
  analyser: AnalyserNode;
  fx: FxChainState;
}

interface InstrumentState {
  runtime: InstrumentRuntime;
  params: Record<string, number>;
  sampleId: string | null;
}

interface LfoRuntimeState {
  osc: OscillatorNode;
  depth: GainNode;
  signature: string;
}

const LFO_DIVISION_MULTS = [1 / 4, 1 / 2, 1, 2, 4];

function lfoSignature(lfo: Lfo): string {
  return [lfo.trackId, lfo.param, lfo.wave, lfo.rateMode, lfo.rateHz, lfo.division, lfo.amount].join("|");
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  trackId: string;
  chokeGroup: number | null;
}

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private masterClipper: WaveShaperNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private bank: SampleBank | null = null;
  private doc: ProjectDocument | null = null;
  private trackNodes = new Map<string, TrackNodes>();
  private returnNodes = new Map<string, ReturnNodes>();
  private instruments = new Map<string, InstrumentState>();
  private lfos = new Map<string, LfoRuntimeState>();
  private macroCache = new Map<string, { gain: number; pan: number }>();
  private currentSceneIntensity = 0.7;
  private voices = new Set<Voice>();
  private missedAssets = new Set<string>();
  private levelBuf = new Float32Array(1024);
  /** Stereo interleaved frame (L,R) reading the master analyser. */
  private masterMeterBuf: Float32Array<ArrayBuffer> = new Float32Array(2048 * 2);
  private masterPeakHold = new PeakHold(0.4);
  private syncedBpm = 0;

  attachBank(bank: SampleBank): void {
    this.bank = bank;
  }

  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  get missingAssets(): string[] {
    return [...this.missedAssets];
  }

  useContext(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.buildMaster();
    if (this.doc) this.syncProject(this.doc);
  }

  ensureContext(): BaseAudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.buildMaster();
      if (this.doc) this.syncProject(this.doc);
    }
    const ctx = this.ctx;
    if (ctx instanceof AudioContext && ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  private buildMaster(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Disconnect old master chain if re-invoked (e.g. useContext with new context).
    try {
      this.masterAnalyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterLimiter?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterClipper?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.master?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.masterClipper = ctx.createWaveShaper();
    this.masterClipper.oversample = "4x";
    this.masterClipper.curve = null;
    this.masterLimiter = ctx.createDynamicsCompressor();
    this.applyMasterConfig(this.doc?.master ?? defaultMasterConfig());
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.channelCount = 2;
    this.masterAnalyser.channelCountMode = "explicit";
    this.master.connect(this.masterClipper);
    this.masterClipper.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);
  }

  private applyMasterConfig(config: MasterConfig): void {
    if (!this.master || !this.masterClipper || !this.masterLimiter) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    if (this.master) this.master.gain.setTargetAtTime(Math.min(2, Math.max(0, config.masterGain)), now, 0.01);
    if (config.clipperEnabled) {
      const n = 2048;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      const ceilingLin = Math.pow(10, -0.3 / 20);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = (ceilingLin * Math.tanh(x * 3)) / Math.tanh(3);
      }
      this.masterClipper.curve = curve;
    } else {
      this.masterClipper.curve = null;
    }
    const ceiling = Math.pow(10, config.ceilingDb / 20);
    if (config.limiterEnabled) {
      this.masterLimiter.threshold.value = ceiling;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.002;
      this.masterLimiter.release.value = 0.1;
    } else {
      this.masterLimiter.threshold.value = 0;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 1;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.01;
    }
  }

  setProject(doc: ProjectDocument): void {
    this.doc = doc;
    if (this.ctx) this.syncProject(doc);
  }

  transportStarted(time: number, beatPhase: number): void {
    for (const nodes of this.trackNodes.values()) {
      for (const rt of nodes.fx.runtimes.values()) {
        rt.onTransportStarted?.(time, beatPhase);
      }
    }
  }

  private fxSignature(effects: EffectInstance[]): string {
    return effects.filter((e) => !e.bypassed).map((e) => `${e.id}:${e.type}`).join("|");
  }

  private rebuildFxChain(
    effects: EffectInstance[],
    input: AudioNode,
    output: AudioNode,
    state: FxChainState,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const rt of state.runtimes.values()) rt.dispose();
    state.runtimes.clear();
    state.params.clear();
    input.disconnect();
    const bpm = this.doc?.bpm ?? 124;
    let head: AudioNode = input;
    for (const fx of effects) {
      if (fx.bypassed) continue;
      const def = EFFECT_DEFS[fx.type];
      if (!def) continue;
      const rt = def.factory(ctx, fx, { bpm });
      // Sidechain routing: wire the source track's input node as the effect's
      // sidechain feed (if the effect supports it and the source track is live).
      if (fx.sidechainTrackId && rt.setSidechainInput) {
        const sourceNodes = this.trackNodes.get(fx.sidechainTrackId);
        if (sourceNodes) {
          rt.setSidechainInput(sourceNodes.input);
        } else {
          rt.setSidechainInput(null);
        }
      }
      head.connect(rt.input);
      head = rt.output;
      state.runtimes.set(fx.id, rt);
      state.params.set(fx.id, { ...fx.params });
    }
    head.connect(output);
    state.signature = this.fxSignature(effects);
  }

  private syncFxParams(effects: EffectInstance[], state: FxChainState): void {
    for (const fx of effects) {
      if (fx.bypassed) continue;
      const rt = state.runtimes.get(fx.id);
      const cached = state.params.get(fx.id);
      if (!rt || !cached) continue;
      for (const [k, v] of Object.entries(fx.params)) {
        if (cached[k] !== v) rt.setParameter(k, v);
      }
      state.params.set(fx.id, { ...fx.params });
    }
  }

  private disposeTrackNodes(id: string, nodes: TrackNodes): void {
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    nodes.fx.params.clear();
    for (const send of nodes.sends.values()) send.disconnect();
    nodes.sends.clear();
    nodes.input.disconnect();
    nodes.panner.disconnect();
    nodes.gain.disconnect();
    nodes.modAutoGain.disconnect();
    nodes.modAutoPan.disconnect();
    nodes.modMacroGain.disconnect();
    nodes.modMacroPan.disconnect();
    nodes.analyser.disconnect();
    this.trackNodes.delete(id);
  }

  private disposeReturnNodes(id: string, nodes: ReturnNodes): void {
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    nodes.fx.params.clear();
    nodes.input.disconnect();
    nodes.gain.disconnect();
    nodes.analyser.disconnect();
    this.returnNodes.delete(id);
  }

  private syncProject(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    this.applyMasterConfig(doc.master);

    const liveTrackIds = new Set(doc.tracks.map((t) => t.id));
    for (const [id, nodes] of [...this.trackNodes]) {
      if (!liveTrackIds.has(id)) this.disposeTrackNodes(id, nodes);
    }
    for (const [id, state] of [...this.instruments]) {
      if (!liveTrackIds.has(id)) {
        state.runtime.dispose();
        this.instruments.delete(id);
      }
    }
    const liveReturnIds = new Set(doc.returns.map((r) => r.id));
    for (const [id, nodes] of [...this.returnNodes]) {
      if (!liveReturnIds.has(id)) this.disposeReturnNodes(id, nodes);
    }

    for (const ret of doc.returns) {
      let nodes = this.returnNodes.get(ret.id);
      if (!nodes) {
        const input = ctx.createGain();
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.channelCount = 2;
        analyser.channelCountMode = "explicit";
        gain.connect(analyser);
        analyser.connect(this.master);
        nodes = {
          input,
          gain,
          analyser,
          fx: { runtimes: new Map(), params: new Map(), signature: "" },
        };
        this.returnNodes.set(ret.id, nodes);
      }
      const sig = this.fxSignature(ret.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(ret.effects, nodes.input, nodes.gain, nodes.fx);
      } else {
        this.syncFxParams(ret.effects, nodes.fx);
      }
      nodes.gain.gain.setTargetAtTime(ret.gain, ctx.currentTime, 0.01);
    }

    for (const track of doc.tracks) {
      let nodes = this.trackNodes.get(track.id);
      if (!nodes) {
        const input = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const gain = ctx.createGain();
        const modAutoGain = ctx.createGain();
        modAutoGain.gain.value = 1;
        const modAutoPan = ctx.createStereoPanner();
        const modMacroGain = ctx.createGain();
        modMacroGain.gain.value = 1;
        const modMacroPan = ctx.createStereoPanner();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.channelCount = 2;
        analyser.channelCountMode = "explicit";
        input.connect(panner);
        panner.connect(gain);
        gain.connect(modAutoGain);
        modAutoGain.connect(modAutoPan);
        modAutoPan.connect(modMacroGain);
        modMacroGain.connect(modMacroPan);
        modMacroPan.connect(this.master);
        modMacroPan.connect(analyser);
        nodes = {
          input,
          panner,
          gain,
          modAutoGain,
          modAutoPan,
          modMacroGain,
          modMacroPan,
          analyser,
          fx: { runtimes: new Map(), params: new Map(), signature: "" },
          sends: new Map(),
        };
        this.trackNodes.set(track.id, nodes);
      }
      const sig = this.fxSignature(track.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(track.effects, nodes.input, nodes.panner, nodes.fx);
      } else {
        this.syncFxParams(track.effects, nodes.fx);
      }
      if (track.kind === "instrument") {
        this.syncInstrument(track, nodes);
      }
      this.syncSends(track.sends, nodes);
      const now = ctx.currentTime;
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
      const anySolo = doc.tracks.some((t) => t.solo);
      const audible = !track.mute && (!anySolo || track.solo);
      nodes.gain.gain.setTargetAtTime(audible ? track.gain : 0, now, 0.01);
    }

    this.syncLfos(doc);
    this.syncMacros(doc);

    if (this.syncedBpm !== doc.bpm) {
      this.syncedBpm = doc.bpm;
      for (const nodes of this.trackNodes.values()) {
        for (const rt of nodes.fx.runtimes.values()) rt.syncBpm?.(doc.bpm);
      }
    }
  }

  private syncSends(sends: Record<string, number>, nodes: TrackNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const live = new Set(Object.keys(sends).filter((returnId) => this.returnNodes.has(returnId)));
    for (const [returnId, sendGain] of [...nodes.sends]) {
      if (!live.has(returnId)) {
        sendGain.disconnect();
        nodes.sends.delete(returnId);
      }
    }
    for (const returnId of live) {
      let sendGain = nodes.sends.get(returnId);
      if (!sendGain) {
        sendGain = ctx.createGain();
        sendGain.connect(this.returnNodes.get(returnId)!.input);
        nodes.sends.set(returnId, sendGain);
        nodes.modMacroPan.connect(sendGain);
      }
      sendGain.gain.setTargetAtTime(sends[returnId] ?? 0, ctx.currentTime, 0.01);
    }
  }

  private syncInstrument(track: InstrumentTrack, nodes: TrackNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let state = this.instruments.get(track.id);
    if (!state) {
      const runtime = INSTRUMENT_DEFS[track.instrument].factory(
        ctx,
        track,
        { bpm: this.doc?.bpm ?? 124, getSample: (id) => this.bank?.get(id) },
      );
      runtime.output.connect(nodes.input);
      state = { runtime, params: { ...track.params }, sampleId: track.sampleId };
      this.instruments.set(track.id, state);
      return;
    }
    if (state.sampleId !== track.sampleId) {
      state.runtime.setSample?.(track.sampleId);
      state.sampleId = track.sampleId;
    }
    for (const [key, value] of Object.entries(track.params)) {
      if (state.params[key] !== value) state.runtime.setParameter(key, value);
    }
    state.params = { ...track.params };
  }

  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void {
    this.instruments.get(trackId)?.runtime.noteOn(pitch, velocity, when, durationSec);
  }

  previewNote(trackId: string, pitch: number): void {
    this.ensureContext();
    this.noteOn(trackId, pitch, 1, this.currentTime + 0.005, 0.25);
  }

  private lfoFrequency(lfo: Lfo): number {
    if (lfo.rateMode === "hz") return Math.max(0.01, lfo.rateHz);
    const bpm = this.doc?.bpm ?? 124;
    const mult = LFO_DIVISION_MULTS[Math.max(0, Math.min(LFO_DIVISION_MULTS.length - 1, Math.round(lfo.division)))];
    return Math.max(0.01, (bpm / 60) * mult);
  }

  private syncLfos(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const liveIds = new Set(doc.lfos.map((l) => l.id));
    for (const [id, state] of [...this.lfos]) {
      if (!liveIds.has(id)) {
        try {
          state.osc.stop();
        } catch {
          // not started
        }
        state.osc.disconnect();
        state.depth.disconnect();
        this.lfos.delete(id);
      }
    }
    for (const lfo of doc.lfos) {
      const nodes = this.trackNodes.get(lfo.trackId);
      if (!nodes) continue;
      const sig = lfoSignature(lfo);
      const existing = this.lfos.get(lfo.id);
      if (existing && existing.signature === sig) continue;
      if (existing) {
        try {
          existing.osc.stop();
        } catch {
          // not started
        }
        existing.osc.disconnect();
        existing.depth.disconnect();
      }
      const osc = ctx.createOscillator();
      osc.type = lfo.wave === "sawUp" || lfo.wave === "sawDown" ? "sawtooth" : lfo.wave;
      osc.frequency.value = this.lfoFrequency(lfo);
      const depth = ctx.createGain();
      const sign = lfo.wave === "sawDown" ? -1 : 1;
      depth.gain.value = sign * lfo.amount;
      const targetParam = lfo.param === "gain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
      osc.connect(depth).connect(targetParam);
      osc.start();
      this.lfos.set(lfo.id, { osc, depth, signature: sig });
    }
  }

  private syncMacros(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const next = new Map<string, { gain: number; pan: number }>();
    for (const track of doc.tracks) {
      next.set(track.id, { gain: 1, pan: 0 });
    }
    for (const macro of doc.macros) {
      const bipolar = macro.value * 2 - 1;
      for (const mapping of macro.mappings) {
        if (mapping.source === "intensity") continue; // routed through setSceneIntensity
        const acc = next.get(mapping.trackId);
        if (!acc) continue;
        if (mapping.param === "gain") acc.gain += mapping.amount * bipolar;
        else acc.pan += mapping.amount * bipolar;
      }
    }
    // Intensity bindings: gain-only, scaled to ±amount from the live scene
    // intensity (0..1). We treat intensity 0.5 as neutral (gain × 1).
    const intensityBipolar = Math.max(-1, Math.min(1, this.currentSceneIntensity * 2 - 1));
    for (const macro of doc.macros) {
      for (const mapping of macro.mappings) {
        if (mapping.source !== "intensity" || mapping.param !== "gain") continue;
        const acc = next.get(mapping.trackId);
        if (!acc) continue;
        acc.gain += mapping.amount * intensityBipolar;
      }
    }
    for (const [trackId, offsets] of next) {
      const gain = Math.max(0, offsets.gain);
      const pan = Math.min(1, Math.max(-1, offsets.pan));
      const cached = this.macroCache.get(trackId);
      if (cached && cached.gain === gain && cached.pan === pan) continue;
      const nodes = this.trackNodes.get(trackId);
      if (nodes) {
        nodes.modMacroGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
        nodes.modMacroPan.pan.setTargetAtTime(pan, ctx.currentTime, 0.01);
      }
      this.macroCache.set(trackId, { gain, pan });
    }
    for (const trackId of [...this.macroCache.keys()]) {
      if (!next.has(trackId)) this.macroCache.delete(trackId);
    }
  }

  /** Update the live scene intensity signal. Idempotent. */
  setSceneIntensity(value: number): void {
    this.currentSceneIntensity = Math.max(0, Math.min(1, value));
  }

  /**
   * Apply a scene automation lane within an absolute tick window. The lane
   * is scene-relative, so we interpolate scene-local ticks and dispatch the
   * resulting target/value to the existing track / FX / instrument pipeline.
   */
  applySceneAutomationLane(
    lane: SceneAutomation,
    fromTick: number,
    toTick: number,
    sceneStartTick: number,
  ): void {
    if (lane.points.length === 0 || fromTick >= toTick) return;
    const t0Local = Math.max(0, fromTick - sceneStartTick);
    const t1Local = Math.max(0, toTick - sceneStartTick);
    const valueAt = (tick: number) => {
      if (tick <= lane.points[0].tick) return lane.points[0].value;
      if (tick >= lane.points[lane.points.length - 1].tick) return lane.points[lane.points.length - 1].value;
      for (let i = 0; i < lane.points.length - 1; i++) {
        const a = lane.points[i];
        const b = lane.points[i + 1];
        if (tick >= a.tick && tick <= b.tick) {
          const span = b.tick - a.tick;
          if (span <= 0) return a.value;
          const t = (tick - a.tick) / span;
          return a.value + (b.value - a.value) * t;
        }
      }
      return lane.points[lane.points.length - 1].value;
    };
    const v0 = valueAt(t0Local);
    const v1 = valueAt(t1Local);
    this.applyLane(lane, v0, v1, fromTick, toTick);
  }

  /** Apply a single automation lane directly (not via doc.automation). */
  private applyLane(
    lane: { id: string; target: import("../project-model/types").AutomationTarget; points: AutomationPoint[] },
    v0: number,
    v1: number,
    fromTick: number,
    toTick: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const t1 = Math.max(t0, this.currentTime + 0.1);
    const nodes = this.trackNodes.get(lane.target.trackId);
    if (!nodes) return;
    switch (lane.target.kind) {
      case "trackGain":
        nodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v0)), t0, 0.008);
        nodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v1)), t1, 0.008);
        break;
      case "trackPan":
        nodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, v0)), t0, 0.008);
        nodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, v1)), t1, 0.008);
        break;
      case "fxParam": {
        if (!lane.target.fxId || !lane.target.paramId) break;
        const rt = nodes.fx.runtimes.get(lane.target.fxId);
        if (rt?.setParameterAt) rt.setParameterAt(lane.target.paramId, v0, t0);
        else rt?.setParameter(lane.target.paramId, v0);
        break;
      }
      case "instParam": {
        if (!lane.target.paramId) break;
        const inst = this.instruments.get(lane.target.trackId);
        if (inst?.runtime.setParameterAt) inst.runtime.setParameterAt(lane.target.paramId, v0, t0);
        else inst?.runtime.setParameter(lane.target.paramId, v0);
        break;
      }
    }
    void fromTick;
    void toTick;
  }

  /**
   * Trigger a marker cue by routing the asset through `previewAsset`, optionally
   * limited to a specific track. For `linkedClipId`, we preview against the
   * track's analyser so the marker is heard in context.
   */
  triggerMarker(assetId: string | null, when: number, trackId?: string): void {
    if (!assetId) return;
    if (trackId) {
      this.previewMarkerOnTrack(assetId, when, trackId);
    } else {
      this.previewAssetAt(assetId, when);
    }
  }

  private previewMarkerOnTrack(assetId: string, when: number, trackId: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const buffer = this.bank?.get(assetId);
    const trackNodes = this.trackNodes.get(trackId);
    if (!buffer || !trackNodes) {
      this.previewAssetAt(assetId, when);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.85;
    source.connect(gain).connect(trackNodes.input);
    source.start(when);
    source.onended = () => {
      gain.disconnect();
      source.disconnect();
    };
  }

  private previewAssetAt(assetId: string, when: number): void {
    this.ensureContext();
    const ctx = this.ctx;
    const buffer = this.bank?.get(assetId);
    if (!ctx || !buffer || !this.master) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain).connect(this.master);
    source.start(when);
    source.onended = () => {
      gain.disconnect();
      source.disconnect();
    };
  }

  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc || doc.automation.length === 0) return;
    const t0 = ctx.currentTime;
    const t1 = Math.max(t0, this.currentTime + 0.1);
    for (const lane of doc.automation) {
      if (lane.points.length === 0) continue;
      const v0 = valueAt(lane.points, relOf(fromTick), 1);
      const v1 = valueAt(lane.points, relOf(toTick), 1);
      const nodes = this.trackNodes.get(lane.target.trackId);
      if (!nodes) continue;
      switch (lane.target.kind) {
        case "trackGain":
          nodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v0)), t0, 0.008);
          nodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v1)), t1, 0.008);
          break;
        case "trackPan":
          nodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, v0)), t0, 0.008);
          nodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, v1)), t1, 0.008);
          break;
        case "fxParam": {
          if (!lane.target.fxId || !lane.target.paramId) break;
          const rt = nodes.fx.runtimes.get(lane.target.fxId);
          if (rt?.setParameterAt) rt.setParameterAt(lane.target.paramId, v0, t0);
          else rt?.setParameter(lane.target.paramId, v0);
          break;
        }
        case "instParam": {
          if (!lane.target.paramId) break;
          const inst = this.instruments.get(lane.target.trackId);
          if (inst?.runtime.setParameterAt) inst.runtime.setParameterAt(lane.target.paramId, v0, t0);
          else inst?.runtime.setParameter(lane.target.paramId, v0);
          break;
        }
      }
    }
  }

  scheduleTrackAutomation(trackId: string, param: "gain" | "pan", points: AutomationPoint[], timeAt: (tick: number) => number): void {
    const nodes = this.trackNodes.get(trackId);
    if (!nodes || points.length === 0) return;
    const target = param === "gain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
    const clampValue = param === "gain"
      ? (v: number) => Math.max(0, Math.min(2, v))
      : (v: number) => Math.max(-1, Math.min(1, v));
    target.setValueAtTime(clampValue(valueAt(points, 0, param === "gain" ? 1 : 0)), 0);
    for (const point of points) {
      target.linearRampToValueAtTime(clampValue(point.value), Math.max(0, timeAt(point.tick)));
    }
  }

  scheduleDeviceAutomation(
    trackId: string,
    kind: "fx" | "inst",
    deviceId: string | undefined,
    paramId: string | undefined,
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    if (!paramId) return;
    const nodes = this.trackNodes.get(trackId);
    if (!nodes) return;
    for (const point of points) {
      const when = Math.max(0, timeAt(point.tick));
      if (kind === "fx") {
        if (!deviceId) return;
        const rt = nodes.fx.runtimes.get(deviceId);
        if (rt?.setParameterAt) rt.setParameterAt(paramId, point.value, when);
        else rt?.setParameter(paramId, point.value);
      } else {
        const rt = this.instruments.get(trackId)?.runtime;
        if (rt?.setParameterAt) rt.setParameterAt(paramId, point.value, when);
        else rt?.setParameter(paramId, point.value);
      }
    }
  }

  automationReset(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const nodes of this.trackNodes.values()) {
      nodes.modAutoGain.gain.setTargetAtTime(1, now, 0.01);
      nodes.modAutoPan.pan.setTargetAtTime(0, now, 0.01);
    }
  }

  trigger(trackId: string, pad: DrumPad, when: number, velocity: number): void {
    const ctx = this.ctx;
    const trackNodes = this.trackNodes.get(trackId);
    const buffer = this.bank?.get(pad.assetId);
    if (!ctx || !trackNodes) return;
    if (!buffer) {
      if (pad.assetId) this.missedAssets.add(pad.assetId);
      return;
    }
    if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.pow(2, pad.pitch / 12);
    const gain = ctx.createGain();
    gain.gain.value = velocity * pad.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pad.pan;
    source.connect(gain).connect(panner).connect(trackNodes.input);

    const voice: Voice = { source, gain, trackId, chokeGroup: pad.chokeGroup };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      gain.disconnect();
      panner.disconnect();
      source.disconnect();
    };
    source.start(when);
  }

  preview(pad: DrumPad, trackId: string): void {
    this.ensureContext();
    this.trigger(trackId, pad, this.currentTime + 0.005, 1);
  }

  /** Preview a factory sample directly through the master bus (no track needed). */
  previewAsset(assetId: string): void {
    this.ensureContext();
    const ctx = this.ctx;
    const buffer = this.bank?.get(assetId);
    if (!ctx || !this.master) return;
    if (!buffer) {
      if (assetId) this.missedAssets.add(assetId);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain).connect(this.master);
    source.start(ctx.currentTime + 0.005);
    source.onended = () => {
      gain.disconnect();
      source.disconnect();
    };
  }

  private choke(trackId: string, chokeGroup: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const voice of this.voices) {
      if (voice.trackId !== trackId || voice.chokeGroup !== chokeGroup) continue;
      voice.gain.gain.cancelScheduledValues(ctx.currentTime);
      voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      try {
        voice.source.stop(when + 0.02);
      } catch {
        // already stopped
      }
      this.voices.delete(voice);
    }
  }

  panic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      try {
        voice.source.stop(now + 0.05);
      } catch {
        // already stopped
      }
    }
    this.voices.clear();
    for (const state of this.instruments.values()) state.runtime.panic();
  }

  private peakOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i]);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  getTrackLevel(trackId: string): number {
    return this.peakOf(this.trackNodes.get(trackId)?.analyser ?? null);
  }

  getReturnLevel(returnId: string): number {
    return this.peakOf(this.returnNodes.get(returnId)?.analyser ?? null);
  }

  getMasterLevel(): number {
    return this.peakOf(this.masterAnalyser);
  }

  /** Refresh the cached master frame and return per-channel levels + correlation. */
  getMasterLevels(): { left: ChannelLevels; right: ChannelLevels; correlation: number } {
    const out = {
      left: { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 } as ChannelLevels,
      right: { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 } as ChannelLevels,
      correlation: 1,
    };
    if (!this.masterAnalyser) return out;
    this.masterAnalyser.getFloatTimeDomainData(this.masterMeterBuf);
    const channels = this.masterAnalyser.channelCount || 1;
    const split = splitChannels(this.masterMeterBuf, channels);
    const l = channelLevels(split[0] ?? new Float32Array(0));
    const r = channelLevels(split[1] ?? split[0] ?? new Float32Array(0));
    const corr = split.length >= 2 ? stereoCorrelation(split[0], split[1]) : 1;
    this.masterPeakHold.push(Math.max(l.peakDb, r.peakDb));
    out.left = l;
    out.right = r;
    out.correlation = corr;
    return out;
  }

  /** Held peak dBFS (decays slowly). Call after getMasterLevels() to get the latest hold. */
  getMasterPeakHoldDb(): number {
    return this.masterPeakHold.current;
  }

  resetMasterPeakHold(): void {
    this.masterPeakHold.reset();
  }

  /** 0 dBFS → 0 dB headroom (positive = peaking). */
  getMasterHeadroomDb(): number {
    const levels = this.getMasterLevels();
    return -Math.max(levels.left.peakDb, levels.right.peakDb);
  }

  /**
   * True peak estimation by 4× oversampling (zero-crossing interpolation).
   * Cheap enough for offline use; the renderer uses it on the exported buffer.
   */
  static measureTruePeak(frames: Frame, channels: number): number {
    if (frames.length === 0) return 0;
    let peak = 0;
    const split = splitChannels(frames, channels);
    for (const channel of split) {
      for (let i = 1; i < channel.length - 1; i++) {
        const prev = channel[i - 1];
        const cur = channel[i];
        const next = channel[i + 1];
        // 4× peak estimation: search for a local maximum around the current sample.
        const a = Math.abs(prev);
        const b = Math.abs(cur);
        const c = Math.abs(next);
        const m = Math.max(a, b, c);
        if (m > peak) peak = m;
        // Parabolic peak between two samples if they look like a peak.
        if (b >= a && b >= c) {
          const denom = a - 2 * b + c;
          const delta = denom === 0 ? 0 : ((a - c) * 0.5) / denom;
          const interp = Math.abs(b - 0.25 * (a - c) * delta);
          if (interp > peak) peak = interp;
        }
      }
      if (Math.abs(channel[0]) > peak) peak = Math.abs(channel[0]);
      const last = Math.abs(channel[channel.length - 1]);
      if (last > peak) peak = last;
    }
    return peak;
  }

  getDiagnostics(): Record<string, string | number> {
    const effectCount = [...this.trackNodes.values()].reduce((sum, n) => sum + n.fx.runtimes.size, 0);
    return {
      contextState: this.ctx?.state ?? "not-created",
      sampleRate: this.ctx?.sampleRate ?? "-",
      activeVoices: this.voices.size,
      loadedSamples: this.bank?.size ?? 0,
      activeEffects: effectCount,
      activeInstruments: this.instruments.size,
      activeLfos: this.lfos.size,
      returns: this.returnNodes.size,
      automationLanes: this.doc?.automation.length ?? 0,
      missingAssets: this.missingAssets.join(", ") || "none",
    };
  }
}
