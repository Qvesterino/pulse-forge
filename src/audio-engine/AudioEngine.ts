import type {
  AutomationTarget,
  DrumPad,
  EffectInstance,
  InstrumentTrack,
  MasterConfig,
  ProjectDocument,
  SceneAutomation,
} from "../project-model/types";
import type { AutomationPoint, Lfo } from "../project-model/types";
import { valueAt } from "../project-model/automation";
import { defaultMasterConfig } from "../project-model/schema";
import { PPQ } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import type { EffectRuntime } from "../effects/types";
import { INSTRUMENT_DEFS, clampInstrumentParam } from "../instruments/registry";
import type { InstrumentRuntime } from "../instruments/types";
import { loadWorkletModules, isWorkletReady } from "../audio-worklets/loader";
import { createLimiterNode } from "../audio-worklets/limiter-node";
import { createEnvFollowerNode, type EnvFollowerHandle } from "../audio-worklets/envfollower-node";
import { createKwMeterNode, type KwMeterHandle } from "../audio-worklets/kwmeter-node";
import {
  lfoKind,
  lfoWave,
  modulatorEventsInRange,
  modulatorPointValue,
  resolveLfoTarget,
} from "../project-model/modulators";
import {
  channelLevels,
  integratedLufs,
  lufsFromChannels,
  monoLossDb,
  splitChannels,
  stereoCorrelation,
  PeakHold,
  toDb,
  truePeakOversampled,
  type Frame,
  type ChannelLevels,
} from "./metering";

/** Tick position → seconds inside a frozen loop (mod buffer duration). */
export function frozenPlaybackOffset(positionTick: number, bpm: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const seconds = (Math.max(0, positionTick) / PPQ) * (60 / Math.max(1, bpm));
  return seconds % durationSec;
}

/**
 * Solo-bus semantics for a project. Any solo anywhere mutes unsoloed
 * material; a group is audible when it — or any of its members — is soloed;
 * a member is audible when it — or the group it feeds — is soloed. (Before
 * this rule, soloing a child inside a group muted the group itself, so the
 * soloed child was inaudible too.)
 */
export interface SoloAudibility {
  anySolo: boolean;
  audible(trackId: string): boolean;
}

export function soloAudibility(doc: ProjectDocument): SoloAudibility {
  const tracks = doc.tracks;
  const anySolo = tracks.some((t) => t.solo);
  const soloedGroups = new Set(tracks.filter((t) => t.kind === "group" && t.solo).map((t) => t.id));
  const groupsWithSoloedChild = new Set<string>();
  for (const t of tracks) {
    if (t.kind !== "group" && t.solo && t.groupId) groupsWithSoloedChild.add(t.groupId);
  }
  return {
    anySolo,
    audible(trackId: string): boolean {
      const t = tracks.find((x) => x.id === trackId);
      if (!t) return false;
      // Group mute silences its members — 1 gesture mutes 8 tracks
      if (t.kind !== "group" && t.groupId) {
        const g = tracks.find((x) => x.id === t.groupId);
        if (g && g.mute) return false;
      }
      if (t.kind === "group") {
        return !t.mute && (!anySolo || t.solo || groupsWithSoloedChild.has(t.id));
      }
      return !t.mute && (!anySolo || t.solo || (t.groupId != null && soloedGroups.has(t.groupId)));
    },
  };
}

interface FxChainState {
  runtimes: Map<string, EffectRuntime>;
  params: Map<string, Record<string, number>>;
  signature: string;
  /**
   * Compensation delay (PDC): latency-introducing effects (look-ahead limiter)
   * route through it; syncPdc() sizes it so every track reaches the master
   * with identical total latency. delayTime 0 = fully transparent.
   */
  pdcDelay: DelayNode | null;
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
  pitchBend: number; // semitones offset from MIDI pitch bend
}

interface GroupNodes {
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

const LFO_DIVISION_MULTS = [1 / 4, 1 / 2, 1, 2, 4];

interface OscModRuntime {
  osc: OscillatorNode;
  depth: GainNode;
  signature: string;
  targetParam?: AudioParam | null;
}

interface FollowerModRuntime {
  /** Null when AudioWorklet DSP is unavailable — surfaces as a degraded entry. */
  follower: EnvFollowerHandle | null;
  depth: GainNode | null;
  signature: string;
  targetParam?: AudioParam | null;
  degradedReason?: string;
}

type LfoRuntimeState = OscModRuntime | FollowerModRuntime;

function isOscRuntime(state: LfoRuntimeState): state is OscModRuntime {
  return "osc" in state;
}

function disposeLfoRuntime(state: LfoRuntimeState): void {
  if (isOscRuntime(state)) {
    try {
      state.osc.stop();
    } catch {
      /* not started */
    }
    state.osc.disconnect();
    state.depth.disconnect();
  } else {
    try {
      state.follower?.dispose();
    } catch {
      /* already disposed */
    }
    if (state.depth) {
      try {
        state.depth.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}

function lfoSignature(lfo: Lfo, workletAvailable?: boolean): string {
  const kind = lfo.kind ?? "osc";
  const parts: (string | number)[] = [kind, lfo.trackId, lfo.param, lfo.amount];
  if (lfo.target) {
    parts.push(`t:${lfo.target.kind}:${lfo.target.trackId}:${lfo.target.fxId ?? ""}:${lfo.target.paramId ?? ""}`);
  }
  if (kind === "osc") {
    parts.push(lfo.wave ?? "", lfo.rateMode ?? "", lfo.rateHz ?? 0, lfo.division ?? 0);
  } else if (kind === "envFollower") {
    parts.push(lfo.sourceTrackId ?? lfo.trackId, lfo.attackMs ?? 0, lfo.releaseMs ?? 0, lfo.sensitivity ?? 0);
    if (workletAvailable !== undefined) parts.push(`ok:${workletAvailable ? 1 : 0}`);
    const pol = lfo.polarity === 1 ? "swell" : "duck";
    parts.push(pol);
  }
  return parts.join("|");
}

interface Voice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  trackId: string;
  chokeGroup: number | null;
  filter?: BiquadFilterNode;
}

interface PreviewVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface ResolvedSlicePlayback {
  start: number;
  end: number;
  duration: number;
  offset: number;
  rate: number;
  fadeIn: number;
  fadeOut: number;
  reverse: boolean;
}

export function resolveSlicePlayback(pad: DrumPad, bufferDuration: number): ResolvedSlicePlayback {
  const duration = Math.max(0.001, Number.isFinite(bufferDuration) ? bufferDuration : 0.001);
  let start = Number.isFinite(pad.sliceStart) ? Math.max(0, Math.min(pad.sliceStart!, duration)) : 0;
  let end = Number.isFinite(pad.sliceEnd) ? Math.max(0, Math.min(pad.sliceEnd!, duration)) : duration;
  if (end <= start + 0.001) {
    start = 0;
    end = duration;
  }
  const reverse = pad.sliceReverse === true;
  const pitch = Number.isFinite(pad.pitch) ? pad.pitch : 0;
  const rateMagnitude = Math.pow(2, pitch / 12);
  const rate = (reverse ? -1 : 1) * rateMagnitude;
  const outputDuration = Math.max(0.001, end - start);
  let fadeIn = Number.isFinite(pad.sliceFadeIn) ? Math.max(0, pad.sliceFadeIn!) : 0;
  let fadeOut = Number.isFinite(pad.sliceFadeOut) ? Math.max(0, pad.sliceFadeOut!) : 0;
  fadeIn = Math.min(fadeIn, outputDuration);
  fadeOut = Math.min(fadeOut, outputDuration);
  if (fadeIn + fadeOut > outputDuration) {
    const scale = outputDuration / Math.max(0.001, fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return {
    start,
    end,
    duration: outputDuration,
    offset: reverse ? end : start,
    rate,
    fadeIn,
    fadeOut,
    reverse,
  };
}

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private masterClipper: WaveShaperNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  /**
   * Look-ahead limiter runtime spliced between the master clipper and the
   * native node whenever AudioWorklet DSP is available. The native node then
   * stays a neutral pass-through and only takes over again without worklets.
   */
  private masterLimiterWorklet: EffectRuntime | null = null;
  /** K-weighted loudness meter (BS.1770) — sink branch off the master limiter. */
  private kwMeter: KwMeterHandle | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private bank: SampleBank | null = null;
  private doc: ProjectDocument | null = null;
  private synthNoise: AudioBuffer | null = null;

  private ensureSynthNoise(): AudioBuffer | null {
    if (this.synthNoise && this.ctx && this.synthNoise.sampleRate === this.ctx.sampleRate) return this.synthNoise;
    const ctx = this.ctx;
    if (!ctx) return null;
    const len = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    this.synthNoise = buf;
    return buf;
  }
  private trackNodes = new Map<string, TrackNodes>();
  private returnNodes = new Map<string, ReturnNodes>();
  private groupNodes = new Map<string, GroupNodes>();
  private instruments = new Map<string, InstrumentState>();
  private frozenBuffers = new Map<string, AudioBufferSourceNode>();
  /** bufferId each frozen source is currently playing (detect re-freezes). */
  private frozenBufferIds = new Map<string, string>();
  /** Frozen playback is transport-aware — sources only run while rolling. */
  private frozenPlaying = false;
  /** Transport tick + ctx time at the last frozen restart, for alignment. */
  private frozenAlign: { tick: number; ctxTime: number } | null = null;
  private lfos = new Map<string, LfoRuntimeState>();
  private macroCache = new Map<string, { gain: number; pan: number }>();
  private currentSceneIntensity = 0.7;
  private voices = new Set<Voice>();
  private previewVoices = new Set<PreviewVoice>();
  private missedAssets = new Set<string>();
  private levelBuf = new Float32Array(1024);
  /**
   * True per-channel master metering. A single AnalyserNode downmixes to
   * mono regardless of channelCount/channelCountMode (verified in Chromium),
   * so stereo levels/correlation require a ChannelSplitter feeding two
   * single-channel analysers.
   */
  private masterSplitter: ChannelSplitterNode | null = null;
  private masterAnalyserL: AnalyserNode | null = null;
  private masterAnalyserR: AnalyserNode | null = null;
  private masterChBufL: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private masterChBufR: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private masterPeakHold = new PeakHold(0.4);
  private meterProjectId: string | null = null;
  private meterHistoryL: number[] = [];
  private meterHistoryR: number[] = [];
  private meterLoudnessBlocks: number[] = [];
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
    this.queueWorkletRefresh(ctx);
  }

  /**
   * Pre-load AudioWorklet processor modules. Must be called before any
   * effects are created (before `setProject`/`syncProject`). Safe to call
   * multiple times — modules are only loaded once per context.
   */
  async loadWorklets(ctx: BaseAudioContext): Promise<void> {
    // Delegates to the shared per-context loader (graceful no-op on
    // platforms without AudioWorklet, e.g. jsdom tests).
    await loadWorkletModules(ctx);
  }

  private workletRefreshQueued = false;

  /**
   * Rebuild all FX chains once AudioWorklet modules finish loading so the
   * factories swap fallback runtimes for real processors. Only meaningful for
   * the live realtime context — mutating an OfflineAudioContext graph mid-
   * render is undefined behavior, so offline contexts never queue a refresh
   * (they are expected to preload modules before useContext).
   */
  private queueWorkletRefresh(ctx: BaseAudioContext): void {
    if (!(ctx instanceof AudioContext)) return;
    if (this.workletRefreshQueued || isWorkletReady("bitcrusher", ctx)) return;
    this.workletRefreshQueued = true;
    void loadWorkletModules(ctx)
      .then(() => {
        this.workletRefreshQueued = false;
        if (this.ctx !== ctx || !this.doc) return;
        for (const nodes of this.trackNodes.values()) nodes.fx.signature = "";
        for (const nodes of this.groupNodes.values()) nodes.fx.signature = "";
        for (const nodes of this.returnNodes.values()) nodes.fx.signature = "";
        this.syncProject(this.doc);
        // The master chain was built before processors existed — splice the
        // look-ahead limiter in now that they are ready.
        this.upgradeMasterDynamics();
        this.upgradeKwMeter();
      })
      .catch(() => {
        this.workletRefreshQueued = false;
      });
  }

  ensureContext(): BaseAudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.buildMaster();
      if (this.doc) this.syncProject(this.doc);
      // Worklet modules load asynchronously — chains built just now may run
      // reduced fallbacks; queue a rebuild once real processors are available.
      this.queueWorkletRefresh(ctx);
    }
    const ctx = this.ctx;
    if (ctx instanceof AudioContext && ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  private buildMaster(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resetMeterHistory();
    // Disconnect old master chain if re-invoked (e.g. useContext with new context).
    try {
      this.masterAnalyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterSplitter?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterAnalyserL?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterAnalyserR?.disconnect();
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
    this.masterLimiterWorklet?.dispose();
    this.masterLimiterWorklet = null;
    this.kwMeter?.dispose();
    this.kwMeter = null;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.masterClipper = ctx.createWaveShaper();
    this.masterClipper.oversample = "4x";
    this.masterClipper.curve = null;
    this.masterLimiter = ctx.createDynamicsCompressor();
    // Prefer the look-ahead worklet limiter; applyMasterConfig() (right below)
    // then drives it and keeps the native node neutral while it is active.
    if (isWorkletReady("limiter", ctx)) this.attachMasterWorklet(ctx);
    this.applyMasterConfig(this.doc?.master ?? defaultMasterConfig());
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.channelCount = 2;
    this.masterAnalyser.channelCountMode = "explicit";
    this.master.connect(this.masterClipper);
    // Read through an assertion: the null-reset above narrows the property
    // statically, but attachMasterWorklet() repopulates it at runtime.
    const attached = this.masterLimiterWorklet as EffectRuntime | null;
    if (attached) {
      this.masterClipper.connect(attached.input);
      attached.output.connect(this.masterLimiter);
    } else {
      this.masterClipper.connect(this.masterLimiter);
    }
    this.masterLimiter.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);
    // Stereo tap: limiter → splitter → per-channel analysers (metering sinks).
    this.masterSplitter = ctx.createChannelSplitter(2);
    this.masterAnalyserL = ctx.createAnalyser();
    this.masterAnalyserL.fftSize = 2048;
    this.masterAnalyserL.channelCount = 1;
    this.masterAnalyserL.channelCountMode = "explicit";
    this.masterAnalyserR = ctx.createAnalyser();
    this.masterAnalyserR.fftSize = 2048;
    this.masterAnalyserR.channelCount = 1;
    this.masterAnalyserR.channelCountMode = "explicit";
    this.masterLimiter.connect(this.masterSplitter);
    this.masterSplitter.connect(this.masterAnalyserL, 0);
    this.masterSplitter.connect(this.masterAnalyserR, 1);
    // K-weighted loudness meter (BS.1770) — sink branch, no audio output.
    if (isWorkletReady("kwmeter", ctx)) this.attachKwMeter(ctx);
  }

  /** Create + arm the K-weighted loudness meter sink (idempotent). */
  private attachKwMeter(ctx: BaseAudioContext): void {
    if (this.kwMeter || !this.masterLimiter || !isWorkletReady("kwmeter", ctx)) return;
    this.kwMeter = createKwMeterNode(ctx);
    this.masterLimiter.connect(this.kwMeter.input);
  }

  /**
   * Splice the K-weight meter into an already-built live master chain —
   * called once AudioWorklet modules finish loading on a live context.
   */
  private upgradeKwMeter(): void {
    const ctx = this.ctx;
    if (!ctx || !(ctx instanceof AudioContext)) return;
    if (this.kwMeter || !this.masterLimiter || !isWorkletReady("kwmeter", ctx)) return;
    this.attachKwMeter(ctx);
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
    const worklet = this.masterLimiterWorklet;
    if (worklet) {
      // The look-ahead worklet drives limiting; the native node is held at a
      // neutral pass-through so the post-native metering tap measures the
      // true final signal. Master settings: threshold rides the ceiling
      // (soft-knee onset right where peaks must stop) with musical defaults.
      const ceilingParam = Math.min(0, Math.max(-12, config.ceilingDb));
      worklet.setParameter("ceiling", ceilingParam);
      worklet.setParameter("threshold", ceilingParam);
      worklet.setParameter("release", 0.12);
      worklet.setParameter("lookaheadMs", 5);
      worklet.setParameter("link", 1);
      worklet.setParameter("mix", config.limiterEnabled ? 1 : 0);
      this.masterLimiter.threshold.value = 0;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 1;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.01;
    } else if (config.limiterEnabled) {
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

  /** Create + arm the look-ahead master limiter runtime (idempotent). */
  private attachMasterWorklet(ctx: BaseAudioContext): void {
    if (this.masterLimiterWorklet || !isWorkletReady("limiter", ctx)) return;
    this.masterLimiterWorklet = createLimiterNode(ctx, { params: {} });
  }

  /**
   * Splice the look-ahead limiter into an ALREADY-BUILT live master chain —
   * used once AudioWorklet modules finish loading on a context that started
   * rendering before they were ready. Never touches OfflineAudioContexts:
   * mutating their graph mid-render is undefined behavior.
   */
  private upgradeMasterDynamics(): void {
    const ctx = this.ctx;
    if (!ctx || !(ctx instanceof AudioContext)) return;
    if (!this.master || !this.masterClipper || !this.masterLimiter) return;
    if (isWorkletReady("limiter", ctx)) this.attachMasterWorklet(ctx);
    const attached = this.masterLimiterWorklet;
    if (!attached) return;
    try {
      this.masterClipper.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterClipper.connect(attached.input);
    attached.output.connect(this.masterLimiter);
    this.applyMasterConfig(this.doc?.master ?? defaultMasterConfig());
  }

  setProject(doc: ProjectDocument): void {
    if (this.meterProjectId !== null && this.meterProjectId !== doc.id) this.resetMeterHistory();
    this.meterProjectId = doc.id;
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

  /**
   * (Re)start frozen-track buffer sources aligned to the transport position.
   * Called when playback starts, on seek while playing, and right after a
   * fresh freeze during playback. This is the single creation path for frozen
   * sources — panic() (pause/stop/seek) tears them down, this resurrects them,
   * so frozen tracks can never end up permanently silent.
   */
  restartFrozenSources(positionTick: number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc) return;
    this.frozenPlaying = true;
    this.frozenAlign = { tick: Math.max(0, positionTick), ctxTime: ctx.currentTime };
    for (const track of doc.tracks) {
      if (!("frozen" in track) || !track.frozen) continue;
      const existing = this.frozenBuffers.get(track.id);
      if (existing) {
        try {
          existing.stop();
        } catch {
          /* already stopped */
        }
        try {
          existing.disconnect();
        } catch {
          /* already disconnected */
        }
        this.frozenBuffers.delete(track.id);
        this.frozenBufferIds.delete(track.id);
      }
      const buffer = this.bank?.get(track.frozen.bufferId);
      const nodes = this.trackNodes.get(track.id);
      if (!buffer || !nodes) continue; // restore pending — next sync picks it up
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(nodes.input);
      source.start(ctx.currentTime + 0.005, frozenPlaybackOffset(positionTick, doc.bpm, buffer.duration));
      this.frozenBuffers.set(track.id, source);
      this.frozenBufferIds.set(track.id, track.frozen.bufferId);
    }
  }

  /** Current transport tick estimate for frozen-loop alignment. */
  private frozenPositionTickNow(): number {
    if (!this.frozenAlign || !this.ctx || !this.doc) return 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this.frozenAlign.ctxTime);
    return this.frozenAlign.tick + elapsed * (this.doc.bpm / 60) * PPQ;
  }

  private fxSignature(effects: EffectInstance[]): string {
    return effects
      .filter((e) => !e.bypassed)
      .map((e) => `${e.id}:${e.type}`)
      .join("|");
  }

  private rebuildFxChain(effects: EffectInstance[], input: AudioNode, output: AudioNode, state: FxChainState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const rt of state.runtimes.values()) rt.dispose();
    state.runtimes.clear();
    state.params.clear();
    input.disconnect();
    if (state.pdcDelay) {
      try {
        state.pdcDelay.disconnect();
      } catch {
        /* already disconnected */
      }
    }
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
        const sourceNodes = this.trackNodes.get(fx.sidechainTrackId) ?? this.groupNodes.get(fx.sidechainTrackId);
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
    // PDC tap: every chain routes through a compensation delay so syncPdc()
    // can align latency-introducing effects (look-ahead limiter) across the
    // graph. delayTime stays 0 when no compensation is needed.
    if (!state.pdcDelay) state.pdcDelay = ctx.createDelay(0.2);
    head.connect(state.pdcDelay);
    state.pdcDelay.connect(output);
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
    nodes.fx.pdcDelay?.disconnect();
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
    nodes.fx.pdcDelay?.disconnect();
    nodes.input.disconnect();
    nodes.gain.disconnect();
    nodes.analyser.disconnect();
    this.returnNodes.delete(id);
  }

  private disposeGroupNodes(id: string, nodes: GroupNodes): void {
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    nodes.fx.params.clear();
    nodes.fx.pdcDelay?.disconnect();
    nodes.input.disconnect();
    nodes.panner.disconnect();
    nodes.gain.disconnect();
    nodes.modAutoGain.disconnect();
    nodes.modAutoPan.disconnect();
    nodes.modMacroGain.disconnect();
    nodes.modMacroPan.disconnect();
    nodes.analyser.disconnect();
    for (const send of nodes.sends.values()) send.disconnect();
    nodes.sends.clear();
    this.groupNodes.delete(id);
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

    // Create/update group nodes
    const liveGroupIds = new Set(doc.tracks.filter((t) => t.kind === "group").map((t) => t.id));
    for (const [id, nodes] of [...this.groupNodes]) {
      if (!liveGroupIds.has(id)) this.disposeGroupNodes(id, nodes);
    }
    const solo = soloAudibility(doc);
    for (const track of doc.tracks) {
      if (track.kind !== "group") continue;
      let nodes = this.groupNodes.get(track.id);
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
          fx: { runtimes: new Map(), params: new Map(), signature: "", pdcDelay: null },
          sends: new Map(),
        };
        this.groupNodes.set(track.id, nodes);
      }
      const sig = this.fxSignature(track.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(track.effects, nodes.input, nodes.panner, nodes.fx);
      } else {
        this.syncFxParams(track.effects, nodes.fx);
      }
      this.syncSends(track.sends, nodes);
      const now = ctx.currentTime;
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
      // Group audible when it — or any of its members — is soloed.
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? track.gain : 0, now, 0.01);
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
          fx: { runtimes: new Map(), params: new Map(), signature: "", pdcDelay: null },
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
          fx: { runtimes: new Map(), params: new Map(), signature: "", pdcDelay: null },
          sends: new Map(),
        };
        this.trackNodes.set(track.id, nodes);
      }

      // Frozen track: play back the pre-rendered buffer instead of instrument/FX.
      // Sources are transport-aware: they run only while playback is rolling
      // (see restartFrozenSources) and are NOT restarted on doc edits as long
      // as the buffer is unchanged — editing another track must not audibly
      // restart a frozen loop from its beginning.
      if (track.frozen && "frozen" in track && track.frozen) {
        const bufferId = track.frozen.bufferId;
        const existing = this.frozenBuffers.get(track.id);
        if (existing && this.frozenBufferIds.get(track.id) === bufferId) {
          // Same buffer — keep the source running untouched.
        } else {
          if (existing) {
            try {
              existing.stop();
            } catch {
              /* already stopped */
            }
            try {
              existing.disconnect();
            } catch {
              /* already disconnected */
            }
            this.frozenBuffers.delete(track.id);
            this.frozenBufferIds.delete(track.id);
          }
          if (this.frozenPlaying) {
            const buffer = this.bank?.get(bufferId);
            if (buffer) {
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.loop = true;
              source.connect(nodes.input);
              source.start(
                ctx.currentTime + 0.005,
                frozenPlaybackOffset(this.frozenPositionTickNow(), doc.bpm, buffer.duration),
              );
              this.frozenBuffers.set(track.id, source);
              this.frozenBufferIds.set(track.id, bufferId);
            }
          }
        }
        // Still allow live gain/pan adjustments
        const now = ctx.currentTime;
        nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
        // Member audible when it — or the group it feeds — is soloed.
        nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? track.gain : 0, now, 0.01);
        continue; // Skip FX/instrument sync for frozen tracks
      }

      // Clean up frozen buffer if track was unfrozen
      const frozenSource = this.frozenBuffers.get(track.id);
      if (frozenSource) {
        try {
          frozenSource.stop();
        } catch {
          /* already stopped */
        }
        try {
          frozenSource.disconnect();
        } catch {
          /* already disconnected */
        }
        this.frozenBuffers.delete(track.id);
        this.frozenBufferIds.delete(track.id);
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
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? track.gain : 0, now, 0.01);
    }

    // Route child tracks through their group instead of master. Disconnect
    // every previous destination first — a track moved between groups used
    // to keep feeding the old group's input (doubled audio). The track
    // analyser tap must survive, so disconnect selectively instead of a
    // bare disconnect().
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      const nodes = this.trackNodes.get(track.id);
      if (!nodes) continue;
      const groupDest = track.groupId ? this.groupNodes.get(track.groupId) : null;
      try {
        nodes.modMacroPan.disconnect(this.master);
      } catch {
        /* not connected */
      }
      for (const gn of this.groupNodes.values()) {
        try {
          nodes.modMacroPan.disconnect(gn.input);
        } catch {
          /* not connected */
        }
      }
      if (groupDest) nodes.modMacroPan.connect(groupDest.input);
      else nodes.modMacroPan.connect(this.master);
    }

    this.syncLfos(doc);
    this.syncMacros(doc);
    this.syncPdc();

    if (this.syncedBpm !== doc.bpm) {
      this.syncedBpm = doc.bpm;
      for (const nodes of this.trackNodes.values()) {
        for (const rt of nodes.fx.runtimes.values()) rt.syncBpm?.(doc.bpm);
      }
    }
  }

  /**
   * Minimal PDC for latency-introducing effects (look-ahead limiter etc.).
   * Inserts and groups are fully compensated to the longest chain. Returns
   * (send/return) are aligned among themselves; dry vs wet via a return
   * remains offset by at most maxReturnLatency (≤5 ms for limiter, inaudible
   * for reverb/delay tails). This is documented in DSP-ROADMAP §5.
   */
  private syncPdc(): void {
    const ctx = this.ctx;
    if (!ctx || !this.doc) return;
    const chainLatency = (state: FxChainState): number => {
      let total = 0;
      for (const rt of state.runtimes.values()) total += rt.getLatencySec?.() ?? 0;
      return total;
    };
    const groupLatency = new Map<string, number>();
    for (const [id, nodes] of this.groupNodes) groupLatency.set(id, chainLatency(nodes.fx));
    let maxEffective = 0;
    const effective = new Map<string, number>();
    for (const [id, nodes] of this.trackNodes) {
      const track = this.doc.tracks.find((t) => t.id === id);
      const downstream = track && track.kind !== "group" && track.groupId ? (groupLatency.get(track.groupId) ?? 0) : 0;
      const total = chainLatency(nodes.fx) + downstream;
      effective.set(id, total);
      if (total > maxEffective) maxEffective = total;
    }
    for (const lat of groupLatency.values()) {
      if (lat > maxEffective) maxEffective = lat;
    }
    // Returns: align among themselves (sends via returns are offset by return latency,
    // but at least all returns share the same latency)
    const returnLatency = new Map<string, number>();
    let maxReturnLatency = 0;
    for (const [id, nodes] of this.returnNodes) {
      const lat = chainLatency(nodes.fx);
      returnLatency.set(id, lat);
      if (lat > maxReturnLatency) maxReturnLatency = lat;
    }
    if (maxReturnLatency > maxEffective) maxEffective = maxReturnLatency;
    const now = ctx.currentTime;
    for (const [id, nodes] of this.trackNodes) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(Math.max(0, maxEffective - (effective.get(id) ?? 0)), now, 0.02);
    }
    for (const nodes of this.groupNodes.values()) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(0, now, 0.02);
    }
    for (const [id, nodes] of this.returnNodes) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(
        Math.max(0, maxReturnLatency - (returnLatency.get(id) ?? 0)),
        now,
        0.02,
      );
    }
  }

  private syncSends(sends: Record<string, number>, nodes: TrackNodes | GroupNodes): void {
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
      const runtime = INSTRUMENT_DEFS[track.instrument].factory(ctx, track, {
        bpm: this.doc?.bpm ?? 124,
        getSample: (id) => this.bank?.get(id),
      });
      runtime.output.connect(nodes.input);
      state = { runtime, params: { ...track.params }, sampleId: track.sampleId, pitchBend: 0 };
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

  noteOn(
    trackId: string,
    pitch: number,
    velocity: number,
    when: number,
    durationSec: number,
    slideFromTick?: number,
    slideFromPitch?: number,
  ): void {
    // Frozen tracks play back a pre-rendered buffer — skip individual noteOn
    if (this.frozenBuffers.has(trackId)) return;
    const inst = this.instruments.get(trackId);
    if (!inst) return;
    const bendSemitones = inst.pitchBend ?? 0;
    const adjustedPitch = bendSemitones !== 0 ? pitch + bendSemitones : pitch;
    const slideFrom =
      slideFromTick !== undefined && slideFromPitch !== undefined
        ? {
            tick: slideFromTick,
            pitch: bendSemitones !== 0 ? slideFromPitch + bendSemitones : slideFromPitch,
          }
        : undefined;
    if (slideFrom) {
      // Convert origin tick → seconds before `when` using tick delta
      const bpm = this.doc?.bpm ?? 124;
      const secondsPerTick = 60 / (bpm * PPQ);
      // Glide origin time derived from tick delta relative to the slide note's `when`
      const glideStart = when - (when - slideFrom.tick * secondsPerTick);
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec, {
        pitch: slideFrom.pitch,
        when: Math.max(0, glideStart),
      });
    } else {
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec);
    }
  }

  /**
   * Schedule an AudioClip buffer segment through its track's FX chain.
   * Reuses frozenPlaybackOffset semantics (tick→sec + loop offset not needed
   * for one-shots; we use the same tick→sec conversion so live==offline).
   * The clip's timeline is `startBar→lengthBars` (bars), playback offset is
   * `offsetSec+trimStart`, duration is capped to the buffer length minus trims,
   * stretched via `playbackRate = stretchRate * (reverse?-1:1)`.
   */
  triggerAudioClip(clip: import("../project-model/types").AudioClip, when: number, durationSec?: number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc) return;
    if (this.frozenBuffers.has(clip.trackId)) return;
    const nodes = this.trackNodes.get(clip.trackId) ?? this.groupNodes.get(clip.trackId);
    if (!nodes) return;
    const buffer = this.bank?.get(clip.bufferId);
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = (clip.reverse ? -1 : 1) * Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
    const gain = ctx.createGain();
    gain.gain.value = Math.min(2, Math.max(0, clip.gain ?? 1));
    // Fade in/out using linear ramps — scheduled at `when`
    const fadeIn = Math.max(0, clip.fadeIn ?? 0);
    const fadeOut = Math.max(0, clip.fadeOut ?? 0);
    const clipDurSec = durationSec ?? buffer.duration / Math.abs(source.playbackRate.value);
    if (fadeIn > 0.001) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(gain.gain.value, when + Math.min(fadeIn, clipDurSec / 2));
    }
    if (fadeOut > 0.001 && clipDurSec > 0.01) {
      const outStart = when + Math.max(0, clipDurSec - fadeOut);
      gain.gain.setValueAtTime(gain.gain.value, outStart);
      gain.gain.linearRampToValueAtTime(0, when + clipDurSec);
    }
    source.connect(gain).connect(nodes.input);
    const offset = Math.max(0, (clip.offsetSec ?? 0) + (clip.trimStart ?? 0));
    // Clamp offset+duration to buffer length (stretched time already accounted)
    const maxDur = Math.max(0.01, buffer.duration - offset - (clip.trimEnd ?? 0));
    const dur = Math.min(clipDurSec, maxDur);
    const playOffset = clip.reverse ? Math.max(0, buffer.duration - offset - dur) : offset;
    try {
      source.start(when, playOffset, dur);
      source.stop(when + dur + 0.01);
    } catch {
      /* already started */
    }
    source.onended = () => {
      try {
        source.disconnect();
      } catch {}
      try {
        gain.disconnect();
      } catch {}
    };
  }

  previewNote(trackId: string, pitch: number): void {
    this.ensureContext();
    this.noteOn(trackId, pitch, 1, this.currentTime + 0.005, 0.25);
  }

  private lfoFrequency(lfo: Lfo): number {
    if (lfo.rateMode === "hz") return Math.max(0.01, lfo.rateHz ?? 2);
    const bpm = this.doc?.bpm ?? 124;
    const mult =
      LFO_DIVISION_MULTS[Math.max(0, Math.min(LFO_DIVISION_MULTS.length - 1, Math.round(lfo.division ?? 2)))];
    return Math.max(0.01, (bpm / 60) * mult);
  }

  private resolveModTargetParam(target: AutomationTarget): AudioParam | null {
    switch (target.kind) {
      case "trackGain":
      case "trackPan": {
        const nodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
        if (!nodes) return null;
        return target.kind === "trackGain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
      }
      case "fxParam": {
        if (!target.fxId || !target.paramId) return null;
        const candidates: FxChainState[] = [];
        const t = this.trackNodes.get(target.trackId);
        if (t) candidates.push(t.fx);
        const g = this.groupNodes.get(target.trackId);
        if (g) candidates.push(g.fx);
        const r = this.returnNodes.get(target.trackId);
        if (r) candidates.push(r.fx);
        for (const state of candidates) {
          const rt = state.runtimes.get(target.fxId);
          if (rt?.getAudioParam) {
            const p = rt.getAudioParam(target.paramId);
            if (p) return p;
          }
        }
        // Fallback: effect may live on a different track than the LFO host — search all
        for (const nodes of [...this.trackNodes.values(), ...this.groupNodes.values(), ...this.returnNodes.values()]) {
          const rt = nodes.fx.runtimes.get(target.fxId);
          if (rt?.getAudioParam) {
            const p = rt.getAudioParam(target.paramId);
            if (p) return p;
          }
        }
        return null;
      }
      case "instParam":
        return null;
    }
  }

  private modulationDepthForTarget(lfo: Lfo, target: AutomationTarget): number {
    const amount = lfo.amount ?? 0.3;
    if (target.kind === "trackGain" || target.kind === "trackPan") {
      // Additive bipolar/unipolar around the native param (base 1 / 0). Keep range tight.
      return amount;
    }
    // fxParam / instParam — scale to half the param's declared range so
    // amount=1 sweeps roughly the full range. This matches the polling writer's
    // `def.min + (range/2)*(1+value)` absolute mapping but keeps the user's
    // base param as the centre for additive modulation.
    let def: { min: number; max: number } | undefined;
    if (target.kind === "fxParam" && target.fxId && target.paramId) {
      const owner =
        this.doc?.tracks.find((t) => t.id === target.trackId) ??
        (this.doc?.returns.find((r) => r.id === target.trackId) as unknown as
          { effects?: EffectInstance[] } | undefined);
      const inst =
        owner && "effects" in owner
          ? (owner as { effects: EffectInstance[] }).effects.find((f) => f.id === target.fxId)
          : undefined;
      if (inst) {
        def = EFFECT_DEFS[inst.type]?.params.find((p) => p.id === target.paramId);
      }
      if (!def) {
        // Fallback search across all tracks/returns for the fxId (cross-track LFO)
        for (const track of [...(this.doc?.tracks ?? []), ...(this.doc?.returns ?? [])] as unknown as {
          id: string;
          effects?: EffectInstance[];
        }[]) {
          const fx = (track as { effects?: EffectInstance[] }).effects?.find((f) => f.id === target.fxId);
          if (fx) {
            def = EFFECT_DEFS[fx.type]?.params.find((p) => p.id === target.paramId);
            if (def) break;
          }
        }
      }
    } else if (target.kind === "instParam" && target.paramId) {
      const track = this.doc?.tracks.find((t) => t.id === target.trackId);
      if (track && track.kind === "instrument") {
        def = INSTRUMENT_DEFS[track.instrument]?.params.find((p) => p.id === target.paramId);
      }
    }
    const range = def ? def.max - def.min : 1;
    return (range / 2) * amount;
  }

  /**
   * Runtime kinds only — oscillators (audio-rate) and envelope followers
   * (worklet). Random / step modulators are event-scheduled in
   * applyModulators/scheduleModulatorsOffline and need no graph node.
   * P2 bus: oscillators and followers can now drive ANY AutomationTarget whose
   * effect runtime exposes an AudioParam (see EffectRuntime.getAudioParam).
   * Targets without an AudioParam (instruments, fallback Worklet) keep the
   * polling path via applyEnvFollowersToParams.
   */
  private syncLfos(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const runtimeIds = new Set<string>();
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind === "osc" || kind === "envFollower") runtimeIds.add(lfo.id);
    }
    for (const [id, state] of [...this.lfos]) {
      if (!runtimeIds.has(id)) {
        disposeLfoRuntime(state);
        this.lfos.delete(id);
      }
    }
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind !== "osc" && kind !== "envFollower") continue;
      const hostNodes = this.trackNodes.get(lfo.trackId) ?? this.groupNodes.get(lfo.trackId);
      // Host may be a return track (for return-targeted bus); allow any nodes.
      if (!hostNodes && kind === "osc" && lfoKind(lfo) === "osc" && !lfo.target) continue;
      if (!hostNodes && !resolveLfoTarget(lfo)) continue;
      const target = resolveLfoTarget(lfo);
      // Resolve the AudioParam for the bus connection. For trackGain/pan it is
      // always present when the host track exists; for FX it is null until the
      // effect runtime is built (or when the param has no AudioParam exposure).
      const destParam = this.resolveModTargetParam(target);

      if (kind === "osc") {
        const sig = lfoSignature(lfo);
        const existing = this.lfos.get(lfo.id);
        const paramMatches = existing && (existing as OscModRuntime).targetParam === destParam;
        if (existing && isOscRuntime(existing) && existing.signature === sig && paramMatches) {
          // BPM-synced rate may have drifted — keep frequency live.
          const freq = this.lfoFrequency(lfo);
          if (Math.abs(existing.osc.frequency.value - freq) > 1e-6) {
            try {
              existing.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
            } catch {
              /* best effort */
            }
          }
          continue;
        }
        if (existing) disposeLfoRuntime(existing);
        if (!destParam) {
          (this.lfos as Map<string, LfoRuntimeState>).set(lfo.id, {
            follower: null,
            depth: null,
            signature: sig,
            targetParam: null,
            degradedReason: "Modulation target has no audio-rate param — LFO idle",
          } as unknown as FollowerModRuntime);
          continue;
        }
        const wave = lfoWave(lfo);
        const osc = ctx.createOscillator();
        osc.type = wave === "sawUp" || wave === "sawDown" ? "sawtooth" : wave;
        osc.frequency.value = this.lfoFrequency(lfo);
        const depth = ctx.createGain();
        const sign = wave === "sawDown" ? -1 : 1;
        const scale = this.modulationDepthForTarget(lfo, target);
        // For native track params scale is already 0..1 (amount); for FX it is range/2*amount
        const isFx = target.kind === "fxParam" || target.kind === "instParam";
        depth.gain.value = sign * (isFx ? scale : lfo.amount);
        osc.connect(depth).connect(destParam);
        osc.start();
        this.lfos.set(lfo.id, { osc, depth, signature: sig, targetParam: destParam });
        continue;
      }

      // envFollower: detector taps the SOURCE track's input (pre-FX/pre-gain)
      // so a follower listening to its own host can never form a feedback loop.
      const available = isWorkletReady("envFollower", ctx);
      const sourceTrackId =
        typeof lfo.sourceTrackId === "string" && lfo.sourceTrackId !== "" ? lfo.sourceTrackId : lfo.trackId;
      const sourceNodes =
        this.trackNodes.get(sourceTrackId) ??
        this.groupNodes.get(sourceTrackId) ??
        (hostNodes as unknown as TrackNodes);
      if (!sourceNodes) continue;
      const sig = lfoSignature(lfo, available);
      const existing = this.lfos.get(lfo.id);
      const paramMatches =
        existing && !isOscRuntime(existing) && (existing as FollowerModRuntime).targetParam === destParam;
      if (existing && !isOscRuntime(existing) && existing.signature === sig && paramMatches) continue;
      if (existing) disposeLfoRuntime(existing);
      if (!available) {
        this.lfos.set(lfo.id, {
          follower: null,
          depth: null,
          signature: sig,
          targetParam: destParam,
          degradedReason: "AudioWorklet unavailable — envelope follower idle",
        });
        continue;
      }
      const follower = createEnvFollowerNode(ctx, {
        params: {
          attackMs: lfo.attackMs ?? 12,
          releaseMs: lfo.releaseMs ?? 180,
          sensitivity: lfo.sensitivity ?? 1.5,
        },
      });
      sourceNodes.input.connect(follower.input);
      // If the bus can drive an AudioParam, wire audio-rate path; otherwise
      // keep the follower alive for the polling path (applyEnvFollowersToParams).
      if (destParam) {
        const depth = ctx.createGain();
        const isFx = target.kind === "fxParam" || target.kind === "instParam";
        const scale = this.modulationDepthForTarget(lfo, target);
        const polarity = lfo.polarity === 1 ? 1 : -1;
        depth.gain.value = polarity * (isFx ? scale : lfo.amount);
        follower.output.connect(depth).connect(destParam);
        this.lfos.set(lfo.id, { follower, depth, signature: sig, targetParam: destParam });
      } else {
        // No AudioParam — follower posts envelope via port, polling will apply to FX/inst params.
        // Keep the depth null but preserve the follower for getEnvelope().
        // A dummy gain keeps the type uniform; not connected anywhere.
        this.lfos.set(lfo.id, { follower, depth: null, signature: sig, targetParam: null });
      }
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
    // Intensity → any target: 1 fader (scene intensity 0..1 → bipolar -1..1) drives
    // filter/movement/width etc. Gain/pan accumulate via next map (smoothed),
    // FX/inst params are written directly (delta around base value).
    const intensityBipolar = Math.max(-1, Math.min(1, this.currentSceneIntensity * 2 - 1));
    for (const macro of doc.macros) {
      for (const mapping of macro.mappings) {
        if (mapping.source !== "intensity") continue;
        const amount = mapping.amount;
        // Generic target (P2 bus) takes precedence over legacy trackId/param
        if (mapping.target) {
          const target = mapping.target;
          if (target.kind === "trackGain" || target.kind === "trackPan") {
            const acc = next.get(target.trackId);
            if (!acc) continue;
            if (target.kind === "trackGain") acc.gain += amount * intensityBipolar;
            else acc.pan += amount * intensityBipolar;
          } else if (target.kind === "fxParam") {
            if (!target.fxId || !target.paramId) continue;
            const nodes =
              this.trackNodes.get(target.trackId) ??
              this.groupNodes.get(target.trackId) ??
              this.returnNodes.get(target.trackId);
            const rt = nodes?.fx.runtimes.get(target.fxId);
            if (!rt) continue;
            const owner =
              (doc.tracks.find((t) => t.id === target.trackId) as unknown as
                { effects?: EffectInstance[] } | undefined) ??
              (doc.returns.find((r) => r.id === target.trackId) as unknown as
                { effects?: EffectInstance[] } | undefined);
            const inst = (owner as { effects?: EffectInstance[] } | undefined)?.effects?.find(
              (f) => f.id === target.fxId,
            );
            if (!inst) continue;
            const def = EFFECT_DEFS[inst.type]?.params.find((p) => p.id === target.paramId);
            if (!def) continue;
            const base = inst.params[target.paramId] ?? def.default;
            const delta = ((def.max - def.min) / 2) * intensityBipolar * amount;
            const finalValue = clampEffectParam(inst.type, target.paramId, base + delta);
            rt.setParameter(target.paramId, finalValue);
          } else if (target.kind === "instParam") {
            if (!target.paramId) continue;
            const state = this.instruments.get(target.trackId);
            if (!state) continue;
            const track = doc.tracks.find((t) => t.id === target.trackId);
            if (!track || track.kind !== "instrument") continue;
            const def = INSTRUMENT_DEFS[track.instrument]?.params.find((p) => p.id === target.paramId);
            if (!def) continue;
            const base = state.params[target.paramId] ?? def.default;
            const delta = ((def.max - def.min) / 2) * intensityBipolar * amount;
            const finalValue = clampInstrumentParam(track.instrument, target.paramId, base + delta);
            state.runtime.setParameter(target.paramId, finalValue);
          }
          continue;
        }
        // Legacy: trackId + param string (gain/pan only before P2 bus)
        if (mapping.param !== "gain" && mapping.param !== "pan") continue;
        const acc = next.get(mapping.trackId);
        if (!acc) continue;
        if (mapping.param === "gain") acc.gain += amount * intensityBipolar;
        else acc.pan += amount * intensityBipolar;
      }
    }
    for (const [trackId, offsets] of next) {
      const gain = Math.max(0, offsets.gain);
      const pan = Math.min(1, Math.max(-1, offsets.pan));
      const cached = this.macroCache.get(trackId);
      if (cached && cached.gain === gain && cached.pan === pan) continue;
      const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
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
    scheduleOffsetSec = 0,
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
    this.applyLane(lane, v0, v1, fromTick, toTick, scheduleOffsetSec);
  }

  /** Apply a single automation lane directly (not via doc.automation). */
  private applyLane(
    lane: { id: string; target: import("../project-model/types").AutomationTarget; points: AutomationPoint[] },
    v0: number,
    v1: number,
    fromTick: number,
    toTick: number,
    scheduleOffsetSec = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    const t0 = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1 = Math.max(t0, this.currentTime + 0.1 + offset);
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

  /**
   * Metronome click for count-in / pre-roll. Downbeat accent (bar start) is
   * louder and higher-pitched; works in any BaseAudioContext (live+offline).
   * Deterministic oscillator+gain, no samples — zero latency path.
   */
  click(when: number, downbeat: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = downbeat ? 1600 : 1000;
    const gain = ctx.createGain();
    const level = downbeat ? 0.25 : 0.14;
    gain.gain.setValueAtTime(level, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
    osc.connect(gain).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.05);
    osc.onended = () => {
      try {
        gain.disconnect();
      } catch {
        /* already */
      }
      try {
        osc.disconnect();
      } catch {
        /* already */
      }
    };
  }

  /**
   * Deterministic schedulable-modulator pass (random S&H / step generators).
   * Contributors sharing a target compose ADDITIVELY: corner values merge into
   * a piecewise-linear chain written onto the destination, so natives read
   * `base + Σ contributions` (audio-rate oscillators keep adding on top) and
   * device params land mid-range relative to their ParamDef spans. The same
   * routine serves live playback (whenFor anchored to the transport) and
   * offline rendering (timeAt absolute), which keeps parity by construction.
   */
  applyModulators(fromTick: number, toTick: number, whenFor: (tick: number) => number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc) return;
    const from = Math.max(0, fromTick);
    const to = Math.max(from, toTick);

    interface ModGroup {
      target: AutomationTarget;
      members: Lfo[];
    }
    const groups = new Map<string, ModGroup>();
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind !== "random" && kind !== "step") continue;
      const target = resolveLfoTarget(lfo);
      const key = `${target.kind}:${target.trackId}:${target.fxId ?? ""}:${target.paramId ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { target, members: [] };
        groups.set(key, group);
      }
      group.members.push(lfo);
    }
    if (groups.size === 0) return;

    for (const [, group] of groups) {
      const streams = group.members.map((member) => ({ member, events: modulatorEventsInRange(member, from, to) }));
      const times = new Set<number>([from, to]);
      for (const stream of streams) {
        for (const event of stream.events) times.add(event.tick);
      }
      const sorted = [...times].sort((a, b) => a - b);

      const compositeAt = (tick: number): number => {
        let total = 0;
        for (const stream of streams) total += modulatorPointValue(stream.member, tick) * stream.member.amount;
        return total;
      };

      const write = this.makeModulatorWriter(group.target);
      if (!write) continue;

      let isFirst = true;
      for (const tick of sorted) {
        const when = Math.max(ctx.currentTime, whenFor(tick));
        write(compositeAt(tick), isFirst ? "set" : "ramp", when);
        isFirst = false;
      }
    }
  }

  /**
   * Builds a clamped writer for one modulation target. Natives write absolute
   * composited values; device params scale the contribution around the
   * parameter's mid-point using its registry definition.
   */
  private makeModulatorWriter(
    target: AutomationTarget,
  ): ((value: number, mode: "set" | "ramp", when: number) => void) | null {
    switch (target.kind) {
      case "trackGain":
      case "trackPan": {
        const nodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
        if (!nodes) return null;
        const param = target.kind === "trackGain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
        const clamp =
          target.kind === "trackGain"
            ? (v: number) => Math.max(0, Math.min(2, 1 + v))
            : (v: number) => Math.max(-1, Math.min(1, v));
        return (value, mode, when) => {
          try {
            if (mode === "set") param.setValueAtTime(clamp(value), when);
            else param.linearRampToValueAtTime(clamp(value), when);
          } catch {
            /* overlapping automations — best effort */
          }
        };
      }
      case "fxParam":
      case "instParam": {
        const paramId = target.paramId;
        if (!paramId) return null;
        return (value, _mode, when) => {
          try {
            let mapped = value;
            if (target.kind === "fxParam") {
              const fxId = target.fxId;
              if (!fxId) return;
              const nodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
              const rt = nodes?.fx.runtimes.get(fxId);
              if (!rt) return;
              const owner = this.doc?.tracks.find((t) => t.id === target.trackId);
              const instance = owner && "effects" in owner ? owner.effects.find((f) => f.id === fxId) : undefined;
              if (!instance) return;
              const def = EFFECT_DEFS[instance.type].params.find((p) => p.id === paramId);
              if (def) mapped = def.min + ((def.max - def.min) / 2) * (1 + value);
              const finalValue = clampEffectParam(instance.type, paramId, mapped);
              rt.setParameterAt ? rt.setParameterAt(paramId, finalValue, when) : rt.setParameter(paramId, finalValue);
            } else {
              const state = this.instruments.get(target.trackId);
              if (!state) return;
              const track = this.doc?.tracks.find((t) => t.id === target.trackId);
              if (!track || track.kind !== "instrument") return;
              const def = INSTRUMENT_DEFS[track.instrument].params.find((p) => p.id === paramId);
              if (def) mapped = def.min + ((def.max - def.min) / 2) * (1 + value);
              const finalValue = clampInstrumentParam(track.instrument, paramId, mapped);
              state.runtime.setParameterAt
                ? state.runtime.setParameterAt(paramId, finalValue, when)
                : state.runtime.setParameter(paramId, finalValue);
            }
          } catch {
            /* best effort */
          }
        };
      }
    }
  }

  /** Offline hook — renderer sweeps every window with absolute time mapping. */
  scheduleModulatorsOffline(windows: { from: number; to: number }[], timeAt: (tick: number) => number): void {
    for (const win of windows) this.applyModulators(win.from, win.to, timeAt);
  }

  /**
   * Poll envFollower modulators and apply their envelope to FX/inst param
   * targets that could not be wired at audio-rate (no AudioParam exposure).
   * Called from the scheduler's applyModulators hook (~25 ms refresh).
   * Volume/Pan and any FX with an AudioParam are driven by the audio graph
   * in syncLfos and must NOT be double-driven here.
   */
  applyEnvFollowersToParams(): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc) return;
    for (const lfo of doc.lfos) {
      if (lfoKind(lfo) !== "envFollower") continue;
      const target = resolveLfoTarget(lfo);
      if (target.kind === "trackGain" || target.kind === "trackPan") continue;
      const state = this.lfos.get(lfo.id);
      if (!state || isOscRuntime(state)) continue;
      const runtime = state as FollowerModRuntime;
      // If this follower is already wired audio-rate to an FX AudioParam, the
      // graph drives it — polling would double-modulate.
      if (runtime.targetParam) continue;
      const follower = runtime.follower;
      if (!follower || !follower.getEnvelope) continue;
      const env = (follower as EnvFollowerHandle).getEnvelope();
      if (!Number.isFinite(env) || env <= 0) continue;

      // Map envelope 0..1 to bipolar −1..1 for the existing writer.
      const bipolar = env * 2 - 1;
      const writer = this.makeModulatorWriter(target);
      if (writer) writer(bipolar * lfo.amount, "set", ctx.currentTime);
    }
  }

  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number, scheduleOffsetSec = 0): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc || doc.automation.length === 0) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    const t0 = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1 = Math.max(t0, this.currentTime + 0.1 + offset);
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

  scheduleTrackAutomation(
    trackId: string,
    param: "gain" | "pan",
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    const nodes = this.trackNodes.get(trackId);
    if (!nodes || points.length === 0) return;
    const target = param === "gain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
    const clampValue =
      param === "gain" ? (v: number) => Math.max(0, Math.min(2, v)) : (v: number) => Math.max(-1, Math.min(1, v));
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
    for (const nodes of [...this.trackNodes.values(), ...this.groupNodes.values()]) {
      // Cancel pending modulator/automation writes before restoring — otherwise
      // stale future events would snap parameters right back.
      try {
        nodes.modAutoGain.gain.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      try {
        nodes.modAutoPan.pan.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      nodes.modAutoGain.gain.setTargetAtTime(1, now, 0.01);
      nodes.modAutoPan.pan.setTargetAtTime(0, now, 0.01);
    }
  }

  trigger(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
  ): void {
    const ctx = this.ctx;
    const trackNodes = this.trackNodes.get(trackId);
    if (!ctx || !trackNodes) return;
    // Frozen tracks play back a pre-rendered buffer — skip individual triggers
    if (this.frozenBuffers.has(trackId)) return;
    const buffer = this.bank?.get(pad.assetId);
    if (!buffer) {
      if (pad.synth) {
        if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);
        this.triggerSynth(trackId, pad, when, velocity, locks);
        return;
      }
      if (pad.assetId) this.missedAssets.add(pad.assetId);
      return;
    }
    if (pad.chokeGroup !== null) this.choke(trackId, pad.chokeGroup, when);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    let slice = resolveSlicePlayback(pad, buffer.duration);
    // Sample-start p-lock: normalized 0..1 → absolute start, preserve slice duration
    if (locks?.sampleStart !== undefined) {
      const frac = Math.min(1, Math.max(0, locks.sampleStart));
      const originalDur = slice.duration;
      const maxStart = Math.max(0, buffer.duration - originalDur - 0.001);
      const newStart = frac * maxStart;
      const newEnd = Math.min(buffer.duration, newStart + originalDur);
      const newDur = Math.max(0.001, newEnd - newStart);
      slice = { ...slice, start: newStart, end: newEnd, duration: newDur, offset: slice.reverse ? newEnd : newStart };
    }
    // Length p-lock: multiplier of slice duration (0.1 = 10%, 2 = 200%)
    if (locks?.length !== undefined) {
      const mul = Math.min(2, Math.max(0.1, locks.length));
      const baseDur = slice.duration;
      const newDurRaw = baseDur * mul;
      if (!slice.reverse) {
        const maxDur = Math.max(0.02, buffer.duration - slice.start);
        const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
        slice = { ...slice, duration: newDur, end: slice.start + newDur, offset: slice.start };
      } else {
        const maxDur = Math.max(0.02, slice.end);
        const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
        const newStart = Math.max(0, slice.end - newDur);
        slice = { ...slice, start: newStart, duration: newDur, offset: slice.end };
      }
    }
    const effectivePitch = locks?.pitch !== undefined ? locks.pitch : pad.pitch;
    const rateMagnitude = Math.pow(2, (Number.isFinite(effectivePitch) ? effectivePitch : 0) / 12);
    source.playbackRate.value = (slice.reverse ? -1 : 1) * rateMagnitude;
    const gain = ctx.createGain();
    const effectiveGain = locks?.gain !== undefined ? locks.gain : pad.gain;
    const peak = Math.max(0, velocity * effectiveGain);
    const endWhen = when + slice.duration;
    gain.gain.setValueAtTime(slice.fadeIn > 0 ? 0 : peak, when);
    if (slice.fadeIn > 0) gain.gain.linearRampToValueAtTime(peak, when + slice.fadeIn);
    if (slice.fadeOut > 0) {
      gain.gain.setValueAtTime(peak, Math.max(when + slice.fadeIn, endWhen - slice.fadeOut));
      gain.gain.linearRampToValueAtTime(0, endWhen);
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = locks?.pan !== undefined ? locks.pan : pad.pan;

    // Per-voice lowpass for cutoff p-lock (bypass when not locked)
    let voiceFilter: BiquadFilterNode | null = null;
    let voiceOutput: AudioNode = panner;
    if (locks?.cutoff !== undefined) {
      voiceFilter = ctx.createBiquadFilter();
      voiceFilter.type = "lowpass";
      voiceFilter.frequency.value = Math.min(16000, Math.max(80, locks.cutoff));
      voiceFilter.Q.value = 0.7;
      // Chain: source -> gain -> panner -> filter -> trackInput
      source.connect(gain).connect(panner).connect(voiceFilter).connect(trackNodes.input);
      voiceOutput = voiceFilter;
    } else {
      source.connect(gain).connect(panner).connect(trackNodes.input);
    }

    const voice: Voice = { source, gain, trackId, chokeGroup: pad.chokeGroup, filter: voiceFilter ?? undefined };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      gain.disconnect();
      panner.disconnect();
      if (voiceFilter) voiceFilter.disconnect();
      source.disconnect();
    };
    // Slices use the native buffer offset/duration path, so no decoded buffer
    // copies are needed and realtime/export share the exact same playback.
    source.start(when, slice.offset, slice.duration);
    void voiceOutput;
  }

  private triggerSynth(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
  ): void {
    const ctx = this.ctx;
    const trackNodes = this.trackNodes.get(trackId);
    if (!ctx || !trackNodes || !pad.synth) return;
    const synth = pad.synth;
    const effectiveGain = locks?.gain !== undefined ? locks.gain : pad.gain;
    const peak = Math.max(0, velocity * effectiveGain);
    const pan = locks?.pan !== undefined ? locks.pan : pad.pan;
    const cutoff = locks?.cutoff !== undefined ? locks.cutoff : synth.tone;
    const lengthMul = locks?.length !== undefined ? Math.min(2, Math.max(0.1, locks.length)) : 1;
    const pitchOffset = locks?.pitch !== undefined ? locks.pitch : pad.pitch;
    const baseDecay = synth.decay * lengthMul;
    const noise = this.ensureSynthNoise();
    if (!noise) return;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, when);
    // Decay is handled per-type below; for hat we use exponential ramp
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner).connect(trackNodes.input);

    const sources: AudioScheduledSourceNode[] = [];
    const extraNodes: AudioNode[] = [gain, panner];

    const addVoice = (src: AudioScheduledSourceNode, g: GainNode, filter?: BiquadFilterNode) => {
      sources.push(src);
      extraNodes.push(g);
      if (filter) extraNodes.push(filter);
      // Connect src -> filter? Handled per-type
    };

    const finishVoice = (dur: number) => {
      const voiceGain = gain;
      const voice: Voice = {
        source: sources[0] ?? (gain as unknown as AudioScheduledSourceNode),
        gain: voiceGain,
        trackId,
        chokeGroup: pad.chokeGroup,
      };
      // Store all sources for choke/silence
      const allSources = [...sources];
      // Override voice stop to stop all
      const stopAll = (t: number) => {
        for (const s of allSources) {
          try {
            (s as AudioBufferSourceNode).stop(t);
          } catch {
            try {
              (s as OscillatorNode).stop(t);
            } catch {
              /* already */
            }
          }
        }
        voiceGain.gain.cancelScheduledValues(t);
        voiceGain.gain.setTargetAtTime(0.0001, t, 0.005);
      };
      // Patch voice's stop/silence to use stopAll
      (voice as any)._stopAll = stopAll;
      this.voices.add(voice);
      const primary = sources[0];
      if (primary) {
        primary.onended = () => {
          this.voices.delete(voice);
          for (const n of extraNodes) {
            try {
              n.disconnect();
            } catch {
              /* already */
            }
          }
          for (const s of allSources) {
            try {
              s.disconnect();
            } catch {
              /* already */
            }
          }
        };
      }
      // Schedule stop after dur
      const stopAt = when + dur + 0.05;
      for (const s of allSources) {
        try {
          if ((s as AudioBufferSourceNode).buffer) (s as AudioBufferSourceNode).stop(stopAt);
          else (s as OscillatorNode).stop(stopAt);
        } catch {
          /* already */
        }
      }
    };

    switch (synth.type) {
      case "hatClosed":
      case "hatOpen": {
        const isOpen = synth.type === "hatOpen";
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        // decay now respects user value (schema def already 0.08/0.32); sizzle via snap, body darkens
        const baseDecay = synth.decay * lengthMul;
        const hpFreq = Math.max(1000, Math.min(12000, cutoff * (1 + snap * 0.35) - body * 600));
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = hpFreq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        src.connect(hp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, hp);
        // shimmer layer for open hats when snap high
        if (isOpen && snap > 0.5) {
          const shSrc = ctx.createBufferSource();
          shSrc.buffer = noise!;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = 9200;
          bp.Q.value = 1.2;
          const sg = ctx.createGain();
          sg.gain.setValueAtTime(peak * 0.22 * snap, when);
          sg.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay * 0.7);
          shSrc.connect(bp).connect(sg).connect(gain);
          shSrc.start(when);
          addVoice(shSrc, sg, bp);
        }
        finishVoice(baseDecay);
        break;
      }
      case "clap": {
        const decays = [0.02, 0.018, 0.16];
        const times = [0, 0.011, 0.03];
        for (let i = 0; i < 3; i++) {
          const src = ctx.createBufferSource();
          src.buffer = noise!;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = i < 2 ? 1150 : 1100;
          bp.Q.value = i < 2 ? 1.6 : 1.1;
          const g = ctx.createGain();
          const at = when + times[i];
          const dec = decays[i] * lengthMul;
          g.gain.setValueAtTime(0.55, at);
          g.gain.exponentialRampToValueAtTime(0.0001, at + dec);
          src.connect(bp).connect(g).connect(gain);
          src.start(at);
          addVoice(src, g, bp);
        }
        finishVoice(0.4 * lengthMul);
        break;
      }
      case "kick": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const baseDecay = synth.decay * lengthMul;
        const startHz = 150 * Math.pow(2, pitchOffset / 12) * (1 + body * 0.15);
        const endHz = 45 * Math.pow(2, pitchOffset / 12);
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(startHz, when);
        osc.frequency.exponentialRampToValueAtTime(endHz, when + Math.min(0.09, baseDecay * (0.35 + body * 0.15)));
        const ampOsc = ctx.createGain();
        ampOsc.gain.setValueAtTime(peak, when);
        ampOsc.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        osc.connect(ampOsc).connect(gain);
        osc.start(when);
        addVoice(osc, ampOsc);
        // Click — snap controls transient, tone controls brightness
        const clickSrc = ctx.createBufferSource();
        clickSrc.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 1500;
        const clickGain = ctx.createGain();
        const clickLevel = 0.2 + (cutoff / 12000) * 0.3 + snap * 0.28;
        const clickDur = 0.008 + snap * 0.014;
        clickGain.gain.setValueAtTime(peak * clickLevel, when);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, when + clickDur);
        clickSrc.connect(hp).connect(clickGain).connect(gain);
        clickSrc.start(when);
        addVoice(clickSrc, clickGain, hp);
        finishVoice(baseDecay);
        break;
      }
      case "snare": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const baseDecay = synth.decay * lengthMul;
        const toneHz = 192 * Math.pow(2, pitchOffset / 12) * (1 + body * 0.08);
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(toneHz, when);
        osc.frequency.exponentialRampToValueAtTime(toneHz * 0.6, when + 0.11 * (0.8 + body * 0.4));
        const oscGain = ctx.createGain();
        const bodyGain = 0.62 + body * 0.28;
        oscGain.gain.setValueAtTime(peak * bodyGain, when);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.11 * lengthMul * (0.8 + body * 0.4));
        osc.connect(oscGain).connect(gain);
        osc.start(when);
        addVoice(osc, oscGain);
        const nSrc = ctx.createBufferSource();
        nSrc.buffer = noise!;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = Math.max(500, Math.min(8000, cutoff));
        if (locks?.cutoff === undefined)
          bp.frequency.value = Math.max(500, Math.min(8000, (synth as any).tone ?? 1750));
        bp.Q.value = 0.9 + snap * 0.7;
        const nGain = ctx.createGain();
        const snapGain = 0.55 + snap * 0.35;
        const noiseDecay = baseDecay * (0.6 + snap * 0.5);
        nGain.gain.setValueAtTime(peak * snapGain, when);
        nGain.gain.exponentialRampToValueAtTime(0.0001, when + noiseDecay);
        nSrc.connect(bp).connect(nGain).connect(gain);
        nSrc.start(when);
        addVoice(nSrc, nGain, bp);
        finishVoice(Math.max(0.11, baseDecay));
        break;
      }
      case "perc": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const freq = 2100 * Math.pow(2, pitchOffset / 12);
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = Math.max(500, Math.min(8000, cutoff));
        if (locks?.cutoff === undefined)
          bp.frequency.value = Math.max(500, Math.min(8000, (synth as any).tone ?? freq));
        bp.Q.value = 2.5 + snap * 3;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + (0.04 + body * 0.04) * lengthMul);
        src.connect(bp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, bp);
        finishVoice(0.08);
        break;
      }
      case "cowbell": {
        const snap = (synth as any).snap ?? 0.35;
        const body = (synth as any).body ?? 0.5;
        const base = 540 * Math.pow(2, pitchOffset / 12);
        const freqs = [base, base * 1.485];
        for (const f of freqs) {
          const osc = ctx.createOscillator();
          osc.type = "square";
          osc.frequency.value = f;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = f;
          bp.Q.value = 2 + snap * 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(peak * (0.38 + body * 0.14), when);
          g.gain.exponentialRampToValueAtTime(0.0001, when + (0.32 + body * 0.12) * lengthMul);
          osc.connect(bp).connect(g).connect(gain);
          osc.start(when);
          addVoice(osc, g, bp);
        }
        finishVoice(0.36);
        break;
      }
      default: {
        const src = ctx.createBufferSource();
        src.buffer = noise!;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = cutoff;
        const g = ctx.createGain();
        g.gain.setValueAtTime(peak, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + baseDecay);
        src.connect(hp).connect(g).connect(gain);
        src.start(when);
        addVoice(src, g, hp);
        finishVoice(baseDecay);
        break;
      }
    }

    // Choke already handled via this.voices; triggerSynth voices are in same set
    // so choke will find them by trackId/chokeGroup
    // Patch voices' silence to use stopAll
    // Already handled via _stopAll, but choke calls voice.gain and voice.source.stop
    // For synth, we need to ensure choke stops all sources, not just primary
    // Our _stopAll is stored but choke doesn't know it — we should monkey-patch voice's silence
    // For now, handle via storing allSources on voice instance
    for (const v of this.voices) {
      if ((v as any)._stopAll && v.trackId === trackId && v.chokeGroup === pad.chokeGroup) {
        // Keep reference for choke
      }
    }
  }

  preview(pad: DrumPad, trackId: string): void {
    this.ensureContext();
    this.trigger(trackId, pad, this.currentTime + 0.005, 1);
  }

  /** Preview a source region directly through the master bus. */
  previewSlice(pad: DrumPad, loop = false): void {
    this.ensureContext();
    this.stopPreview();
    const ctx = this.ctx;
    const buffer = this.bank?.get(pad.assetId);
    if (!ctx || !this.master || !buffer) {
      if (pad.assetId) this.missedAssets.add(pad.assetId);
      return;
    }
    const slice = resolveSlicePlayback(pad, buffer.duration);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = slice.rate;
    if (loop) {
      source.loop = true;
      source.loopStart = slice.start;
      source.loopEnd = slice.end;
    }
    const gain = ctx.createGain();
    const peak = Math.max(0, pad.gain);
    const when = ctx.currentTime + 0.005;
    const endWhen = when + slice.duration;
    gain.gain.setValueAtTime(slice.fadeIn > 0 ? 0 : peak, when);
    if (slice.fadeIn > 0) gain.gain.linearRampToValueAtTime(peak, when + slice.fadeIn);
    if (!loop && slice.fadeOut > 0) {
      gain.gain.setValueAtTime(peak, Math.max(when + slice.fadeIn, endWhen - slice.fadeOut));
      gain.gain.linearRampToValueAtTime(0, endWhen);
    }
    source.connect(gain).connect(this.master);
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
    };
    source.start(when, slice.offset, loop ? undefined : slice.duration);
  }

  stopPreview(): void {
    const ctx = this.ctx;
    for (const voice of this.previewVoices) {
      try {
        voice.source.stop(ctx ? ctx.currentTime + 0.005 : 0);
      } catch {
        // Already stopped.
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        voice.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.previewVoices.clear();
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

  /**
   * Preview a sample synced to the transport (FL Browser Alt+P): the sample's
   * first beat lands on the next bar boundary and playbackRate tempo-matches
   * the project. `rate` is caller-computed (fileBPM/doc.bpm) — 1 = dry.
   */
  previewAssetSynced(assetId: string, rate = 1): void {
    this.ensureContext();
    const ctx = this.ctx;
    const buffer = this.bank?.get(assetId);
    if (!ctx || !this.master || !buffer || !this.doc) return;
    const bpm = Math.max(1, this.doc.bpm);
    const barSec = (60 / bpm) * 4;
    const now = ctx.currentTime;
    // Quantized start: next bar boundary relative to transport playhead
    const pos = this.transportTickNow();
    const secondsPerTick = 60 / (bpm * PPQ);
    const nextBarSec = ((Math.floor(pos / PPQ) + 1) * PPQ - pos) * secondsPerTick;
    const when = now + Math.max(0.005, (nextBarSec % Math.max(0.001, barSec)) + 0.005);
    void barSec;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.min(4, Math.max(0.25, rate));
    const gain = ctx.createGain();
    gain.gain.value = 0.85;
    source.connect(gain).connect(this.master);
    source.start(when);
    source.onended = () => {
      gain.disconnect();
      source.disconnect();
    };
  }

  /** Current transport tick estimate (doc-relative), used for preview sync. */
  private transportTickNow(): number {
    return 0;
  }

  private choke(trackId: string, chokeGroup: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const voice of this.voices) {
      if (voice.trackId !== trackId || voice.chokeGroup !== chokeGroup) continue;
      voice.gain.gain.cancelScheduledValues(ctx.currentTime);
      voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      const stopAll = (voice as any)._stopAll as ((t: number) => void) | undefined;
      if (stopAll) {
        try {
          stopAll(when + 0.02);
        } catch {
          /* already */
        }
      } else {
        try {
          voice.source.stop(when + 0.02);
        } catch {
          // already stopped
        }
      }
      this.voices.delete(voice);
    }
  }

  panic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopPreview();
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      const stopAll = (voice as any)._stopAll as ((t: number) => void) | undefined;
      if (stopAll) {
        try {
          stopAll(now + 0.05);
        } catch {
          /* already */
        }
      } else {
        try {
          voice.source.stop(now + 0.05);
        } catch {
          // already stopped
        }
      }
    }
    this.voices.clear();
    for (const source of this.frozenBuffers.values()) {
      try {
        source.stop(now);
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.frozenBuffers.clear();
    this.frozenBufferIds.clear();
    this.frozenPlaying = false;
    this.frozenAlign = null;
    for (const state of this.instruments.values()) state.runtime.panic();
  }

  /** Apply a MIDI CC value directly to a target parameter. */
  applyMidiCc(target: AutomationTarget, value: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    switch (target.kind) {
      case "trackGain": {
        const nodes = this.trackNodes.get(target.trackId);
        if (nodes) nodes.modMacroGain.gain.setTargetAtTime(Math.max(0, Math.min(2, value)), now, 0.005);
        break;
      }
      case "trackPan": {
        const nodes = this.trackNodes.get(target.trackId);
        if (nodes) nodes.modMacroPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, value)), now, 0.005);
        break;
      }
      case "fxParam": {
        const nodes = this.trackNodes.get(target.trackId);
        const rt = nodes?.fx.runtimes.get(target.fxId!);
        if (rt) rt.setParameter(target.paramId!, value);
        break;
      }
      case "instParam": {
        const inst = this.instruments.get(target.trackId);
        if (inst) inst.runtime.setParameter(target.paramId!, value);
        break;
      }
    }
  }

  /** Apply a pitch bend offset (in semitones) to an instrument track. */
  setMidiPitchBend(trackId: string, semitones: number): void {
    const inst = this.instruments.get(trackId);
    if (!inst) return;
    inst.pitchBend = semitones;
  }

  /** Apply polyphonic aftertouch to a specific note on an instrument track. */
  polyPressure(trackId: string, pitch: number, pressure: number): void {
    const inst = this.instruments.get(trackId);
    if (!inst?.runtime.polyPressure) return;
    inst.runtime.polyPressure(pitch, pressure, this.ctx?.currentTime ?? 0);
  }

  /** Release a specific voice by pitch. */
  noteOff(trackId: string, pitch: number, when: number): void {
    const inst = this.instruments.get(trackId);
    if (!inst?.runtime.noteOff) return;
    inst.runtime.noteOff(pitch, when);
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

  /**
   * Effects currently running degraded fallbacks (worklet DSP unavailable).
   * The UI shows a warning badge for each — fallbacks never degrade silently.
   */
  getDegradedFx(): { trackId: string; fxId: string; reason: string }[] {
    const out: { trackId: string; fxId: string; reason: string }[] = [];
    const collect = (trackId: string, state: FxChainState) => {
      for (const [fxId, rt] of state.runtimes) {
        if (rt.degraded) out.push({ trackId, fxId, reason: rt.degradedReason ?? "Fallback processing" });
      }
    };
    for (const [id, nodes] of this.trackNodes) collect(id, nodes.fx);
    for (const [id, nodes] of this.groupNodes) collect(id, nodes.fx);
    for (const [id, nodes] of this.returnNodes) collect(id, nodes.fx);
    for (const [id, state] of this.lfos) {
      if (!isOscRuntime(state) && state.degradedReason) {
        const host = this.doc?.lfos.find((l) => l.id === id)?.trackId ?? "";
        out.push({ trackId: host, fxId: id, reason: state.degradedReason });
      }
    }
    return out;
  }

  /** Latest gain reduction in dB reported by an effect runtime (metering). */
  getFxGainReductionDb(trackId: string, fxId: string): number | null {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    return rt?.getGainReductionDb?.() ?? null;
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
    if (!this.masterAnalyserL || !this.masterAnalyserR) return out;
    this.masterAnalyserL.getFloatTimeDomainData(this.masterChBufL);
    this.masterAnalyserR.getFloatTimeDomainData(this.masterChBufR);
    const l = channelLevels(this.masterChBufL);
    const r = channelLevels(this.masterChBufR);
    const corr = stereoCorrelation(this.masterChBufL, this.masterChBufR);
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

  /**
   * Current master-stage gain reduction in dB (0 = untouched). Reads the
   * look-ahead worklet meter when available, falling back to the native
   * DynamicsCompressorNode's reduction attribute (negative dB → normalized
   * to positive reduction).
   */
  getMasterGainReductionDb(): number {
    if (this.masterLimiterWorklet) return Math.max(0, this.masterLimiterWorklet.getGainReductionDb?.() ?? 0);
    const reduction = this.masterLimiter?.reduction ?? 0;
    const value = typeof reduction === "number" && Number.isFinite(reduction) ? -reduction : 0;
    return Math.max(0, value);
  }

  resetMasterPeakHold(): void {
    this.masterPeakHold.reset();
  }

  private resetMeterHistory(): void {
    this.meterHistoryL = [];
    this.meterHistoryR = [];
    this.meterLoudnessBlocks = [];
    this.masterPeakHold.reset();
  }

  resetMasterIntegratedLufs(): void {
    this.meterLoudnessBlocks = [];
    this.kwMeter?.reset();
  }

  getMasterMeterSnapshot(): {
    left: ChannelLevels;
    right: ChannelLevels;
    correlation: number;
    peakHoldDb: number;
    truePeakDb: number;
    lufsMomentary: number;
    lufsShortTerm: number;
    lufsIntegrated: number;
    monoLossDb: number;
    lrImbalanceDb: number;
    gainReductionDb: number;
  } {
    const levels = this.getMasterLevels();
    this.meterHistoryL.push(...this.masterChBufL);
    this.meterHistoryR.push(...this.masterChBufR);
    const sampleRate = this.ctx?.sampleRate ?? 44100;
    const maxSamples = Math.ceil(sampleRate * 3.2);
    if (this.meterHistoryL.length > maxSamples) {
      this.meterHistoryL.splice(0, this.meterHistoryL.length - maxSamples);
      this.meterHistoryR.splice(0, this.meterHistoryR.length - maxSamples);
    }
    // True peak: 4× polyphase oversampling (intersample peaks included).
    const truePeak = Math.max(
      AudioEngine.measureTruePeak(this.masterChBufL, 1),
      AudioEngine.measureTruePeak(this.masterChBufR, 1),
    );
    // Loudness: exact BS.1770 K-weighting from the worklet when loaded;
    // legacy flat-energy approximation otherwise.
    if (this.kwMeter) {
      const loudness = this.kwMeter.getLoudness();
      return {
        left: levels.left,
        right: levels.right,
        correlation: levels.correlation,
        peakHoldDb: this.masterPeakHold.current,
        truePeakDb: toDb(truePeak),
        lufsMomentary: loudness.m,
        lufsShortTerm: loudness.s,
        lufsIntegrated: loudness.i,
        monoLossDb: monoLossDb(this.masterChBufL, this.masterChBufR),
        lrImbalanceDb: Math.abs(levels.left.rmsDb - levels.right.rmsDb),
        gainReductionDb: this.getMasterGainReductionDb(),
      };
    }
    const window = (seconds: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] => {
      const length = Math.min(this.meterHistoryL.length, Math.max(1, Math.round(seconds * sampleRate)));
      return [
        Float32Array.from(this.meterHistoryL.slice(-length)),
        Float32Array.from(this.meterHistoryR.slice(-length)),
      ];
    };
    const [momentaryL, momentaryR] = window(0.4);
    const [shortL, shortR] = window(3);
    const momentary = lufsFromChannels(momentaryL, momentaryR);
    this.meterLoudnessBlocks.push(momentary);
    if (this.meterLoudnessBlocks.length > 900) this.meterLoudnessBlocks.shift();
    return {
      left: levels.left,
      right: levels.right,
      correlation: levels.correlation,
      peakHoldDb: this.masterPeakHold.current,
      truePeakDb: toDb(truePeak),
      lufsMomentary: momentary,
      lufsShortTerm: lufsFromChannels(shortL, shortR),
      lufsIntegrated: integratedLufs(this.meterLoudnessBlocks),
      monoLossDb: monoLossDb(momentaryL, momentaryR),
      lrImbalanceDb: Math.abs(levels.left.rmsDb - levels.right.rmsDb),
      gainReductionDb: this.getMasterGainReductionDb(),
    };
  }

  /** 0 dBFS → 0 dB headroom (positive = peaking). */
  getMasterHeadroomDb(): number {
    const levels = this.getMasterLevels();
    return -Math.max(levels.left.peakDb, levels.right.peakDb);
  }

  /** Expose the master post-limiter AnalyserNode for spectrum UI (read-only observer). */
  getMasterSpectrumAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }

  /** Expose per-channel analysers for goniometer (read-only observer). */
  getMasterStereoAnalysers(): { l: AnalyserNode; r: AnalyserNode } | null {
    if (!this.masterAnalyserL || !this.masterAnalyserR) return null;
    return { l: this.masterAnalyserL, r: this.masterAnalyserR };
  }

  /**
   * True peak via 4× polyphase oversampling (ITU BS.1770 style) — catches
   * intersample peaks that the old parabolic estimate missed. Delegates to
   * the shared pure implementation in metering.ts.
   */
  static measureTruePeak(frames: Frame, channels: number): number {
    if (frames.length === 0) return 0;
    return truePeakOversampled(splitChannels(frames, channels));
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
