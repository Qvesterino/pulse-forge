import type {
  AutomationTarget,
  DrumPad,
  EffectInstance,
  InstrumentTrack,
  MasterConfig,
  ProjectDocument,
  SampleLayer,
  SceneAutomation,
} from "../project-model/types";
import type { AutomationPoint, Lfo } from "../project-model/types";
import { valueAt } from "../project-model/automation";
import { hashString } from "../shared/rng";
import { defaultMasterConfig } from "../project-model/schema";
import { PPQ, BAR_TICKS } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { EFFECT_DEFS } from "../effects/registry";
import type { EffectRuntime } from "../effects/types";
import { clampInstrumentParam, INSTRUMENT_DEFS } from "../instruments/registry";
import { dbToLinear, presetNormalizationGainDb } from "../presets/normalization";
import type { InstrumentRuntime } from "../instruments/types";
import type { InstrumentPreset } from "../presets/types";
import { previewCleanupDelayMs, previewNoteDuration } from "../presets/audioQuality";
import { clampTargetValue, targetOwner, targetParamDef } from "../project-model/targets";
import {
  ensureWorkletsForDoc,
  isWorkletReady,
  loadCoreWorklets,
  loadPluginWorklet,
  PLUGIN_WORKLET_TYPES,
  type PluginWorkletType,
} from "../audio-worklets/loader";
import { createLimiterNode } from "../audio-worklets/limiter-node";
// @ts-ignore — reserved for tape stage, wired in next pass
import { createTapeNode } from "../audio-worklets/tape-node";
import { createEnvFollowerNode, type EnvFollowerHandle } from "../audio-worklets/envfollower-node";
import { createKwMeterNode, type KwMeterHandle } from "../audio-worklets/kwmeter-node";
import { timeStretch } from "./time-stretch";
import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "./phase-vocoder";
import { renderWarpPreserveAsync } from "../audio-workers/warp-render-client";
import { MeterRing } from "./MeterRing";
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
  // `null` means this graph has never been built. The empty string is a valid
  // signature for a chain with no effects, and still needs pass-through
  // routing plus its PDC node initialized.
  signature: string | null;
  /**
   * Compensation delay (PDC): latency-introducing effects (look-ahead limiter)
   * route through it; syncPdc() sizes it so every track reaches the master
   * with identical total latency. delayTime 0 = fully transparent.
   */
  pdcDelay: DelayNode | null;
  /**
   * Latency-change subscriptions from runtimes whose DSP latency is only
   * known asynchronously (worklet plugins). Each fires syncPdc() so PDC
   * tracks latency without waiting for the next document sync.
   */
  latencySubs: Array<() => void>;
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
  /** Per-send PDC delays (sendGain → delay → return input), sized by syncPdc. */
  sendDelays: Map<string, DelayNode>;
}

interface ReturnNodes {
  input: GainNode;
  gain: GainNode;
  modAutoGain: GainNode;
  modMacroGain: GainNode;
  analyser: AnalyserNode;
  fx: FxChainState;
}

interface InstrumentState {
  runtime: InstrumentRuntime;
  /**
   * Preset loudness normalization stage (factory-content pass): an
   * engine-owned gain after the runtime output, driven by the preset's
   * measured gain (src/presets/normalization.ts). Lives here — not inside
   * the runtime — so every instrument kind gets it uniformly, and so it
   * applies identically to live playback, previews and offline renders.
   */
  normGain: GainNode;
  /** Applied normalization in dB — diffed so preset switches are the only writes. */
  normGainDb: number;
  params: Record<string, number>;
  sampleId: string | null;
  /** Reference-compared against the track — sampler velocity/RR layers. */
  layers: SampleLayer[] | undefined;
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
  /** Per-send PDC delays (sendGain → delay → return input), sized by syncPdc. */
  sendDelays: Map<string, DelayNode>;
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
  /** Per-pad mod nodes (LFO osc + depth gain) — disconnected with the voice. */
  extras?: AudioNode[];
}

interface PreviewVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface TrackMeterSnapshot {
  level: number;
  peakDb: number;
  clipping: boolean;
}

interface InstrumentPreviewVoice {
  runtime: InstrumentRuntime;
  gain: GainNode;
  timer: ReturnType<typeof setTimeout> | null;
}

/** `instanceof AudioContext` is not safe in browsers that expose only the
 * Base/Offline context globals (and it throws when the constructor is absent).
 * Keep the live-context capability check in one place. */
function isLiveAudioContext(ctx: BaseAudioContext | null | undefined): ctx is AudioContext {
  return typeof AudioContext !== "undefined" && ctx instanceof AudioContext;
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

 /**
  * Per-send PDC delay (seconds): the send tap sits post-chain-PDC, so the
  * send waits out the downstream latency (the sender's group chain; 0 for
  * groups and ungrouped tracks) minus the return's own latency. Clamped ≥ 0 —
  * a return carrying heavier latency FX than the sender's downstream keeps a
  * documented residual of (returnLat − downstream) instead.
  */
export function sendPdcDelaySec(downstreamLatSec: number, returnLatSec: number): number {
  if (!Number.isFinite(downstreamLatSec) || !Number.isFinite(returnLatSec)) return 0;
  return Math.max(0, downstreamLatSec - returnLatSec);
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
  // @ts-ignore — reserved for master tape/ms stage
  private masterTape: EffectRuntime | null = null;
  // @ts-ignore — reserved for master ms stage
  private masterMs: {
    input: GainNode;
    output: GainNode;
    splitter: ChannelSplitterNode;
    merger: ChannelMergerNode;
    midGain: GainNode;
    sideGain: GainNode;
    sideInv: GainNode;
  } | null = null;
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
  /** Desired metering state per fx id (panel attached → on). Re-applied when a
   * chain rebuild recreates runtimes so the panel never has to re-register. */
  private fxMetersEnabled = new Map<string, boolean>();
  private instruments = new Map<string, InstrumentState>();
  private frozenBuffers = new Map<string, AudioBufferSourceNode>();
  /** bufferId each frozen source is currently playing (detect re-freezes). */
  private frozenBufferIds = new Map<string, string>();
  /** Frozen playback is transport-aware — sources only run while rolling. */
  private frozenPlaying = false;
  /** Transport tick + ctx time at the last frozen restart, for alignment. */
  private frozenAlign: { tick: number; ctxTime: number } | null = null;
  /**
   * LRU cache for time-stretched AudioBuffers keyed by `bufferId+rate+reverse`.
   * Lazy-computed on first triggerAudioClip with stretchMode="stretch".
   * Cleared on project swap to prevent stale references.
   */
  private stretchCache = new Map<string, AudioBuffer>();
  private static readonly STRETCH_CACHE_LIMIT = 48;
  /**
   * LRU cache for pitch-preserving warp renders keyed by
   * `bufferId+wallSec+pins+reverse`. Warp buffers are clip-sized (bars of
   * audio, not one-shots), so the limit is small. Warmed in a worker on
   * trigger-miss / clip edit; the offline renderer precomputes synchronously
   * with the same core, so live and export are sample-exact.
   * Cleared on project swap (plus an epoch bump that orphans in-flight
   * worker replies).
   */
  private warpCache = new Map<string, AudioBuffer>();
  private static readonly WARP_CACHE_LIMIT = 6;
  private warpInflight = new Set<string>();
  private warpEpoch = 0;
  private lfos = new Map<string, LfoRuntimeState>();
  private macroCache = new Map<string, { gain: number; pan: number }>();
  private currentSceneIntensity = 0.7;
  private voices = new Set<Voice>();
  private previewVoices = new Set<PreviewVoice>();
  private instrumentPreviewVoices = new Set<InstrumentPreviewVoice>();
  /**
   * One-shot scheduled sources (AudioClips, marker cues, metronome clicks).
   * These are committed up to the 120 ms horizon ahead and are NOT part of
   * `voices`, so panic() previously left them playing — a stopped transport
   * kept sounding a multi-bar AudioClip, and seek/stop fired stale marker
   * cues. Bounded: each source removes itself on `onended`.
   */
  private oneShotSources = new Set<AudioScheduledSourceNode>();
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
  /** Project id the stretchCache entries were computed for. */
  private stretchProjectId: string | null = null;
  // Defect B.7 (performance / memory recon): the old `number[]` rings
  // did `push(...masterChBufL)` + `splice(0, n)` per overshoot — O(n)
  // each plus the spread allocates a fresh array every call. Pre-allocate
  // a Float32Array ring sized to the worst-case 3.2 s of audio at 96 kHz
  // (307 200 samples ≈ 1.2 MiB per channel) and copy via `set()`.
  // `push(src)` overwrites the oldest samples automatically — no splice.
  private static readonly METER_RING_CAPACITY = Math.ceil(96000 * 3.2);
  private meterHistoryL = new MeterRing(AudioEngine.METER_RING_CAPACITY);
  private meterHistoryR = new MeterRing(AudioEngine.METER_RING_CAPACITY);
  private meterLoudnessBlocks: number[] = [];
  private syncedBpm = 0;
  /** Active scene BPM override (song mode) — null = runtimes follow doc.bpm. */
  private sceneBpmOverride: number | null = null;

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
    const previousContext = this.ctx;
    if (previousContext && previousContext !== ctx) {
      try {
        previousContext.onstatechange = null;
      } catch {
        /* host context may not expose a writable lifecycle hook */
      }
    }
    // Defect 1.1 (lifecycle audit): the previous context's per-track,
    // per-return and per-group EffectRuntimes, plus the LFO/follower
    // state and the AudioWorkletNode-side onLatencyChange subs, are
    // only disposed when a track id disappears from the doc — not when
    // the context itself is swapped. useContext() is the only path that
    // fully discards the engine's prior graph state, so it must also
    // dispose every runtime the old context owned.
    for (const id of [...this.trackNodes.keys()]) {
      const nodes = this.trackNodes.get(id);
      if (nodes) this.disposeTrackNodes(id, nodes);
    }
    for (const id of [...this.returnNodes.keys()]) {
      const nodes = this.returnNodes.get(id);
      if (nodes) this.disposeReturnNodes(id, nodes);
    }
    for (const id of [...this.groupNodes.keys()]) {
      const nodes = this.groupNodes.get(id);
      if (nodes) this.disposeGroupNodes(id, nodes);
    }
    for (const state of [...this.lfos.values()]) disposeLfoRuntime(state);
    this.lfos.clear();
    // Defect A04.D1 (web audio graph lifecycle audit): voices, preview
    // voices, frozen-track sources, frozen bookkeeping, and instrument
    // runtimes all carry AudioNodes (or AudioWorkletNodes for some
    // instruments) that were created against the OLD context. Leaving
    // them in their Maps means (a) every node still references the old
    // context (memory leak until the context is GC'd), and (b) their
    // `onended` callbacks — which mutate the same Maps — fire after
    // the new context is in place and can delete a fresh voice from a
    // matching Set. Stop the live sources first (so onended doesn't
    // race the clear), then disconnect, then clear the Maps.
    for (const voice of this.voices) {
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already */
      }
    }
    this.voices.clear();
    this.stopOneShotSources();
    for (const voice of this.instrumentPreviewVoices) {
      if (voice.timer) clearTimeout(voice.timer);
      try {
        voice.runtime.panic();
      } catch {
        /* already stopped */
      }
      try {
        voice.runtime.dispose();
      } catch {
        /* already disposed */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.instrumentPreviewVoices.clear();
    for (const voice of this.previewVoices) {
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already */
      }
    }
    this.previewVoices.clear();
    for (const source of this.frozenBuffers.values()) {
      try {
        source.stop();
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
    // Instrument runtimes own their own voices + AudioWorkletNodes. `panic()`
    // only silences voices; `dispose()` also disconnects the runtime output
    // and releases worklet-side subscriptions. Both are idempotent in the
    // built-in runtimes, and the defensive catch keeps third-party runtimes
    // from preventing the context swap.
    for (const state of this.instruments.values()) {
      try {
        state.runtime.panic();
      } catch {
        /* already stopped */
      }
      try {
        state.runtime.dispose();
      } catch {
        /* already disposed */
      }
      try {
        state.normGain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.instruments.clear();
    // These are AudioBuffer / AudioNode caches, not value caches. They belong
    // to the context that created them and must never survive a swap, even if
    // the sample rate happens to be identical.
    this.synthNoise = null;
    this.stretchCache.clear();
    this.stretchProjectId = null;
    this.macroCache.clear();
    this.syncedBpm = 0;
    this.ctx = ctx;
    this.buildMaster();
    if (this.doc) this.syncProject(this.doc);
    this.queueWorkletRefresh(ctx);
    // Defect 1.2 (lifecycle audit): Chrome / iOS Safari / Firefox
    // suspend the AudioContext on tab-switch, screen lock, OS sleep and
    // any time the page loses user-activation focus. Without an
    // onstatechange handler the engine never learns the context woke
    // back up — playback silently resumes only when the user clicks
    // somewhere. Re-queueing the worklet refresh on `running` re-builds
    // any FX chains that were created against a different processor
    // state (rare but documented in queueWorkletRefresh).
    if (typeof (ctx as AudioContext).onstatechange !== "undefined") {
      (ctx as AudioContext).onstatechange = () => {
        if (ctx.state === "running" && this.ctx === ctx) {
          this.queueWorkletRefresh(ctx);
        }
      };
    }
  }

  /**
   * Pre-load AudioWorklet processor modules. Must be called before any
   * effects are created (before `setProject`/`syncProject`). Safe to call
   * multiple times — modules are only loaded once per context. Loads the
   * core modules plus exactly the vendored plugin modules this project uses.
   */
  async loadWorklets(ctx: BaseAudioContext): Promise<void> {
    // Delegates to the shared per-context loader (graceful no-op on
    // platforms without AudioWorklet, e.g. jsdom tests).
    await ensureWorkletsForDoc(this.doc, ctx);
  }

  // The refresh lock belongs to a context. A worklet load for an old context
  // may settle after a live/offline swap; a single global boolean lets that
  // stale callback suppress (and permanently strand) the new context's FX
  // refresh.
  private workletRefreshQueuedFor: BaseAudioContext | null = null;

  /**
   * Rebuild all FX chains so factories swap bypass/fallback runtimes for real
   * processors. Only meaningful for the live realtime context — mutating an
   * OfflineAudioContext graph mid-render is undefined behavior, so offline
   * contexts never queue a refresh (they preload modules before useContext).
   */
  private queueFxRebuild(ctx: BaseAudioContext): void {
    if (this.workletRefreshQueuedFor === ctx) return;
    this.workletRefreshQueuedFor = ctx;
    Promise.resolve()
      .then(() => {
        if (this.workletRefreshQueuedFor === ctx) this.workletRefreshQueuedFor = null;
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
        if (this.workletRefreshQueuedFor === ctx) this.workletRefreshQueuedFor = null;
      });
  }

  /**
   * Load CORE worklet modules, then rebuild the FX chains once they land.
   * The chains may have been built with fallbacks before the modules were
   * ready (context creation happens before any network fetch resolves).
   */
  private queueWorkletRefresh(ctx: BaseAudioContext): void {
    if (!isLiveAudioContext(ctx)) return;
    if (this.workletRefreshQueuedFor === ctx || isWorkletReady("bitcrusher", ctx)) return;
    void loadCoreWorklets(ctx)
      .then(() => this.queueFxRebuild(ctx))
      .catch(() => {
        /* loader never rejects, but stay safe */
      });
  }

  ensureContext(): BaseAudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      if (typeof AudioContext === "undefined") {
        throw new Error("This browser does not provide a realtime AudioContext");
      }
      const ctx = new AudioContext();
      // Route every creation path through useContext() so a context that was
      // closed by the browser/device lifecycle gets a complete graph rebuild,
      // exactly like an offline-to-live context swap.
      this.useContext(ctx);
    }
    const ctx = this.ctx;
    if (!ctx) throw new Error("Unable to initialize the realtime AudioContext");
    // Best-effort resume: without a user gesture the browser rejects the
    // promise (NotAllowedError) — swallow it so ensureContext() callers
    // (visibilitychange, playback clicks) never produce unhandled
    // rejections. The next real user gesture revives the context.
    if (isLiveAudioContext(ctx) && ctx.state === "suspended") void ctx.resume().catch(() => {});
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
    this.masterTape?.dispose();
    this.masterTape = null;
    if (this.masterMs) {
      try {
        this.masterMs.splitter.disconnect();
      } catch {}
      try {
        this.masterMs.merger.disconnect();
      } catch {}
      try {
        this.masterMs.midGain.disconnect();
      } catch {}
      try {
        this.masterMs.sideGain.disconnect();
      } catch {}
      try {
        this.masterMs.sideInv.disconnect();
      } catch {}
      try {
        this.masterMs.input.disconnect();
      } catch {}
      try {
        this.masterMs.output.disconnect();
      } catch {}
      this.masterMs = null;
    }
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    // Master tape saturation (pre-limiter, post-gain)
    if (isWorkletReady("tapeSat", ctx)) {
      this.masterTape = createTapeNode(ctx, {
        params: { drive: 0.35, hysteresis: 0.3, tone: 6500, mix: 1, output: 0 },
      });
    } else {
      const shaper = ctx.createWaveShaper();
      shaper.oversample = "4x";
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * 1.8);
      }
      shaper.curve = curve;
      const input = ctx.createGain();
      const output = ctx.createGain();
      input.connect(shaper).connect(output);
      this.masterTape = {
        input,
        output,
        setParameter: () => {},
        setParameterAt: () => {},
        getAudioParam: () => null,
        dispose() {
          input.disconnect();
          shaper.disconnect();
          output.disconnect();
        },
      };
    }
    // Master Mid/Side matrix (post-tape, pre-clipper) — unity when disabled
    {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const midGain = ctx.createGain();
      const sideGain = ctx.createGain();
      const sideInv = ctx.createGain();
      midGain.gain.value = 1;
      sideGain.gain.value = 1;
      sideInv.gain.value = -1;
      input.connect(splitter);
      // Encode: mid = 0.5*L + 0.5*R, side = 0.5*L -0.5*R
      const lToMid = ctx.createGain();
      const rToMid = ctx.createGain();
      const lToSide = ctx.createGain();
      const rToSide = ctx.createGain();
      lToMid.gain.value = 0.5;
      rToMid.gain.value = 0.5;
      lToSide.gain.value = 0.5;
      rToSide.gain.value = -0.5;
      splitter.connect(lToMid, 0);
      splitter.connect(rToMid, 1);
      splitter.connect(lToSide, 0);
      splitter.connect(rToSide, 1);
      lToMid.connect(midGain);
      rToMid.connect(midGain);
      lToSide.connect(sideGain);
      rToSide.connect(sideGain);
      // Decode: L = mid+side, R = mid-side. `sideInv` is THE single side
      // inversion — `sideToRInv` must stay unity or the two −1 gains cancel
      // and R receives +side (= mid+side = L), collapsing the master to mono
      // even with the M/S section disabled.
      const midToL = ctx.createGain();
      const sideToL = ctx.createGain();
      const midToR = ctx.createGain();
      const sideToRInv = ctx.createGain();
      midToL.gain.value = 1;
      sideToL.gain.value = 1;
      midToR.gain.value = 1;
      sideToRInv.gain.value = 1;
      midGain.connect(midToL);
      sideGain.connect(sideToL);
      midGain.connect(midToR);
      sideGain.connect(sideInv);
      sideInv.connect(sideToRInv);
      midToL.connect(merger, 0, 0);
      sideToL.connect(merger, 0, 0);
      midToR.connect(merger, 0, 1);
      sideToRInv.connect(merger, 0, 1);
      merger.connect(output);
      this.masterMs = { input, output, splitter, merger, midGain, sideGain, sideInv };
      // Keep helper gains for cleanup
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).lToMid = lToMid;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).rToMid = rToMid;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).lToSide = lToSide;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).rToSide = rToSide;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).midToL = midToL;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).sideToL = sideToL;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).midToR = midToR;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).sideToRInv = sideToRInv;
    }
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
    this.master.connect(this.masterTape!.input);
    this.masterTape!.output.connect(this.masterMs!.input);
    this.masterMs!.output.connect(this.masterClipper);
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
    if (!isLiveAudioContext(ctx)) return;
    if (this.kwMeter || !this.masterLimiter || !isWorkletReady("kwmeter", ctx)) return;
    this.attachKwMeter(ctx);
  }

  private applyMasterConfig(config: MasterConfig): void {
    if (!this.master || !this.masterClipper || !this.masterLimiter) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    if (this.master) this.master.gain.setTargetAtTime(Math.min(2, Math.max(0, config.masterGain)), now, 0.01);
    if (this.masterTape) {
      const enabled = config.tapeEnabled ?? false;
      const drive = Math.min(1, Math.max(0, config.tapeDrive ?? 0.35));
      this.masterTape.setParameter("drive", enabled ? drive : 0);
      this.masterTape.setParameter("mix", enabled ? 1 : 0);
      this.masterTape.setParameter("hysteresis", enabled ? 0.3 : 0);
    }
    if (this.masterMs) {
      const enabled = config.msEnabled ?? false;
      const midLin = enabled ? Math.pow(10, (config.msMidGain ?? 0) / 20) : 1;
      const sideLin = enabled ? Math.pow(10, (config.msSideGain ?? 0) / 20) : 1;
      this.masterMs.midGain.gain.setTargetAtTime(midLin, now, 0.01);
      this.masterMs.sideGain.gain.setTargetAtTime(sideLin, now, 0.01);
    }
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
    // DynamicsCompressorNode.threshold is expressed in dBFS, not linear
    // amplitude. Passing pow(10, dB / 20) here coerced every negative ceiling
    // into a positive value, which browsers clamp to 0 dB and repeatedly warn
    // about during graph sync. Keep the native fallback honest and quiet.
    const ceilingDb = Math.min(0, Math.max(-12, config.ceilingDb));
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
      this.masterLimiter.threshold.value = ceilingDb;
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
    if (!isLiveAudioContext(ctx)) return;
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
    if (this.stretchProjectId !== doc.id) {
      this.stretchProjectId = doc.id;
      this.clearStretchCache();
      this.clearWarpCache();
      this.warpEpoch++;
      // Missing-asset ids belong to the project that missed them — the
      // engine outlives projects, so stale ids would accumulate forever and
      // pollute the diagnostics panel of the newly opened project.
      this.missedAssets.clear();
    }
    this.doc = doc;
    if (this.ctx) this.syncProject(doc);
  }

  transportStarted(time: number, beatPhase: number): void {
    // Groups and returns carry tempo-synced / phase-locked FX too (Pump,
    // Step Gate, SYNC delays) — skipping them left bus effects out of phase
    // with the transport for the whole play.
    for (const nodes of [
      ...this.trackNodes.values(),
      ...this.groupNodes.values(),
      ...this.returnNodes.values(),
    ]) {
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
    return (
      effects
        .filter((e) => !e.bypassed)
        // Sidechain selection changes the graph even when type and params stay
        // identical. Include it so an old feed cannot survive a source change.
        .map((e) => `${e.id}:${e.type}:${e.sidechainTrackId ?? ""}`)
        .join("|")
    );
  }

  private rebuildFxChain(
    ownerId: string,
    effects: EffectInstance[],
    input: AudioNode,
    output: AudioNode,
    state: FxChainState,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const unsub of state.latencySubs) unsub();
    state.latencySubs.length = 0;
    for (const rt of state.runtimes.values()) rt.dispose();
    state.runtimes.clear();
    // The chain rebuild replaced these effect instances — their meter flags
    // must not survive as unreachable entries that grow across every
    // add/remove/reorder for the life of the session.
    for (const fxId of state.params.keys()) this.fxMetersEnabled.delete(fxId);
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
      // Vendored plugin modules load on demand: the first chain build runs
      // the honest bypass runtime, the module fetch kicks off here, and the
      // rebuild hot-swaps the real processor once it lands.
      if (
        (PLUGIN_WORKLET_TYPES as readonly string[]).includes(fx.type) &&
        !isWorkletReady(fx.type as PluginWorkletType, ctx)
      ) {
        void loadPluginWorklet(ctx, fx.type as PluginWorkletType)
          .then(() => {
            if (isLiveAudioContext(ctx)) this.queueFxRebuild(ctx);
          })
          .catch(() => {
            /* loader never rejects */
          });
      }
      const seed = this.doc ? hashString(`${this.doc.id}|${ownerId}|${fx.id}|fx-dsp-v1`) : undefined;
      const rt = def.factory(ctx, fx, { bpm, seed });
      // PRISM's runtime morph slots are intentionally transient audio state,
      // but their source snapshots are document-owned. Rehydrate them here so
      // a lazy worklet swap or chain rebuild cannot silently empty A/B.
      if (fx.type === "fxeq" && rt.setMorphSnapshot && fx.deviceState?.kind === "effect-ab-v1") {
        const rawSlots = fx.deviceState.data.slots;
        for (const [slotName, slot] of [
          ["A", 0],
          ["B", 1],
        ] as const) {
          const raw =
            typeof rawSlots === "object" && rawSlots !== null && !Array.isArray(rawSlots)
              ? (rawSlots as Record<string, unknown>)[slotName]
              : undefined;
          const hasSnapshot = typeof raw === "object" && raw !== null && !Array.isArray(raw);
          const snapshot: Record<string, number> = {};
          if (hasSnapshot) {
            for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof value === "number" && Number.isFinite(value)) snapshot[id] = value;
            }
          }
          rt.setMorphSnapshot(slot, hasSnapshot ? snapshot : null);
        }
      }
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
      // Metering defaults to off; re-apply the panel's desired state after a
      // rebuild swapped the runtime.
      rt.setMetersEnabled?.(this.fxMetersEnabled.get(fx.id) ?? false);
      // Worklet plugins report latency asynchronously; re-run PDC whenever a
      // report lands so compensation never waits for the next document sync.
      if (rt.onLatencyChange) {
        state.latencySubs.push(rt.onLatencyChange(() => this.syncPdc()));
      }
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
      // A bulk replay (document load, preset apply) is not a user gesture —
      // effects with an internal undo history must not record it, or one
      // preset load evicts the user's live-tweak history.
      rt.beginParamSync?.();
      try {
        for (const [k, v] of Object.entries(fx.params)) {
          if (cached[k] !== v) rt.setParameter(k, v);
        }
      } finally {
        rt.endParamSync?.();
      }
      state.params.set(fx.id, { ...fx.params });
    }
  }

  /**
   * Resolve sidechains only after every group and track node exists. A source
   * is allowed to appear later in document order, so wiring it during the
   * target chain's construction is not sufficient.
   */
  private syncFxSidechains(doc: ProjectDocument): void {
    for (const owner of doc.tracks) {
      const ownerNodes = owner.kind === "group" ? this.groupNodes.get(owner.id) : this.trackNodes.get(owner.id);
      if (!ownerNodes) continue;
      for (const fx of owner.effects) {
        if (fx.bypassed) continue;
        const runtime = ownerNodes.fx.runtimes.get(fx.id);
        if (!runtime?.setSidechainInput) continue;
        const sourceNodes = fx.sidechainTrackId
          ? (this.trackNodes.get(fx.sidechainTrackId) ?? this.groupNodes.get(fx.sidechainTrackId))
          : null;
        runtime.setSidechainInput(sourceNodes?.input ?? null);
      }
    }
  }

  private disposeTrackNodes(id: string, nodes: TrackNodes): void {
    for (const unsub of nodes.fx.latencySubs) unsub();
    nodes.fx.latencySubs.length = 0;
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    for (const fxId of nodes.fx.params.keys()) this.fxMetersEnabled.delete(fxId);
    nodes.fx.params.clear();
    nodes.fx.pdcDelay?.disconnect();
    for (const send of nodes.sends.values()) send.disconnect();
    nodes.sends.clear();
    for (const delay of nodes.sendDelays.values()) delay.disconnect();
    nodes.sendDelays.clear();
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

  private disposeInstrumentRuntime(id: string): void {
    const state = this.instruments.get(id);
    if (!state) return;
    try {
      state.runtime.dispose();
    } catch {
      /* already disposed */
    }
    try {
      state.normGain.disconnect();
    } catch {
      /* already disconnected */
    }
    this.instruments.delete(id);
  }

  private disposeFrozenSource(id: string): void {
    const source = this.frozenBuffers.get(id);
    if (!source) return;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    this.frozenBuffers.delete(id);
    this.frozenBufferIds.delete(id);
  }

  private disposeReturnNodes(id: string, nodes: ReturnNodes): void {
    for (const unsub of nodes.fx.latencySubs) unsub();
    nodes.fx.latencySubs.length = 0;
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    for (const fxId of nodes.fx.params.keys()) this.fxMetersEnabled.delete(fxId);
    nodes.fx.params.clear();
    nodes.fx.pdcDelay?.disconnect();
    nodes.input.disconnect();
    nodes.gain.disconnect();
    nodes.modAutoGain.disconnect();
    nodes.modMacroGain.disconnect();
    nodes.analyser.disconnect();
    this.returnNodes.delete(id);
  }

  private disposeGroupNodes(id: string, nodes: GroupNodes): void {
    for (const unsub of nodes.fx.latencySubs) unsub();
    nodes.fx.latencySubs.length = 0;
    for (const rt of nodes.fx.runtimes.values()) rt.dispose();
    nodes.fx.runtimes.clear();
    for (const fxId of nodes.fx.params.keys()) this.fxMetersEnabled.delete(fxId);
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
    for (const delay of nodes.sendDelays.values()) delay.disconnect();
    nodes.sendDelays.clear();
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
        try {
          state.normGain.disconnect();
        } catch {
          /* already disconnected */
        }
        this.instruments.delete(id);
      }
    }
    const liveReturnIds = new Set(doc.returns.map((r) => r.id));
    for (const [id, nodes] of [...this.returnNodes]) {
      if (!liveReturnIds.has(id)) this.disposeReturnNodes(id, nodes);
    }

    // Create/update return nodes BEFORE groups/tracks: syncSends() only wires
    // sends whose return node already exists, so a first sync after load (or
    // after adding a return) must not run while returnNodes is still empty —
    // group sends were silently dropped until an unrelated second sync.
    for (const ret of doc.returns) {
      let nodes = this.returnNodes.get(ret.id);
      if (!nodes) {
        const input = ctx.createGain();
        const gain = ctx.createGain();
        const modAutoGain = ctx.createGain();
        modAutoGain.gain.value = 1;
        const modMacroGain = ctx.createGain();
        modMacroGain.gain.value = 1;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.channelCount = 2;
        analyser.channelCountMode = "explicit";
        gain.connect(modAutoGain);
        modAutoGain.connect(modMacroGain);
        modMacroGain.connect(analyser);
        analyser.connect(this.master);
        nodes = {
          input,
          gain,
          modAutoGain,
          modMacroGain,
          analyser,
          fx: { runtimes: new Map(), params: new Map(), signature: null, pdcDelay: null, latencySubs: [] },
        };
        this.returnNodes.set(ret.id, nodes);
      }
      const sig = this.fxSignature(ret.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(ret.id, ret.effects, nodes.input, nodes.gain, nodes.fx);
      } else {
        this.syncFxParams(ret.effects, nodes.fx);
      }
      nodes.gain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, ret.gain)), ctx.currentTime, 0.01);
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
          fx: { runtimes: new Map(), params: new Map(), signature: null, pdcDelay: null, latencySubs: [] },
          sends: new Map(),
          sendDelays: new Map(),
        };
        this.groupNodes.set(track.id, nodes);
      }
      const sig = this.fxSignature(track.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(track.id, track.effects, nodes.input, nodes.panner, nodes.fx);
      } else {
        this.syncFxParams(track.effects, nodes.fx);
      }
      this.syncSends(track.sends, nodes);
      const now = ctx.currentTime;
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
      // Group audible when it — or any of its members — is soloed.
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? track.gain : 0, now, 0.01);
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
          fx: { runtimes: new Map(), params: new Map(), signature: null, pdcDelay: null, latencySubs: [] },
          sends: new Map(),
          sendDelays: new Map(),
        };
        this.trackNodes.set(track.id, nodes);
      }

      // Frozen track: play back the pre-rendered buffer instead of instrument/FX.
      // Sources are transport-aware: they run only while playback is rolling
      // (see restartFrozenSources) and are NOT restarted on doc edits as long
      // as the buffer is unchanged — editing another track must not audibly
      // restart a frozen loop from its beginning.
      if (track.frozen && "frozen" in track && track.frozen) {
        // The buffer contains the track-local instrument + FX render. Dispose
        // the live instrument and bypass the live track FX chain; otherwise a
        // freeze silently keeps both runtimes alive and processes the result
        // a second time on every playback.
        this.disposeInstrumentRuntime(track.id);
        if (nodes.fx.signature !== "") {
          this.rebuildFxChain(track.id, [], nodes.input, nodes.panner, nodes.fx);
        }
        // Sends remain live because the freeze render is intentionally
        // pre-group/pre-return. This preserves live return control without
        // double-rendering the return FX into the frozen buffer.
        this.syncSends(track.sends, nodes);
        const bufferId = track.frozen.bufferId;
        const existing = this.frozenBuffers.get(track.id);
        if (existing && this.frozenBufferIds.get(track.id) === bufferId) {
          // Same buffer — keep the source running untouched.
        } else {
          if (existing) this.disposeFrozenSource(track.id);
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
      this.disposeFrozenSource(track.id);

      const sig = this.fxSignature(track.effects);
      if (nodes.fx.signature !== sig) {
        this.rebuildFxChain(track.id, track.effects, nodes.input, nodes.panner, nodes.fx);
      } else {
        this.syncFxParams(track.effects, nodes.fx);
      }
      // Defect 6.8 (lifecycle / leak audit): when a track's `kind`
      // changes from "instrument" to "drum" (or group), the
      // InstrumentRuntime stays parked in `this.instruments` because
      // the cleanup loop above keys on `liveTrackIds` and the track
      // id is still live — only its role changed. Dispose the stale
      // runtime so its `runtime.output` (and any worklet / param
      // subscriptions) does not outlive the track.
      if (track.kind !== "instrument") this.disposeInstrumentRuntime(track.id);
      if (track.kind === "instrument") {
        this.syncInstrument(track, nodes);
      }
      this.syncSends(track.sends, nodes);
      const now = ctx.currentTime;
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.01);
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? track.gain : 0, now, 0.01);
    }

    // All source nodes now exist, including tracks that appear after their
    // PRISM/compressor target in document order.
    this.syncFxSidechains(doc);

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

    // Tempo-synced runtimes follow the EFFECTIVE tempo: an active scene BPM
    // override wins; otherwise doc changes propagate (pushSyncBpm is
    // change-guarded, so this is a no-op while nothing moved).
    this.pushSyncBpm(this.sceneBpmOverride ?? doc.bpm);
  }

  /**
   * Push the EFFECTIVE transport tempo into tempo-synced runtimes without
   * touching the persisted doc.bpm. In song mode a scene may pin its own
   * BPM: the scheduler drives the transport to it (immediately on a seek,
   * at the seam boundary for a flip), and without this call texture's SYNC
   * delay, granular rate sync and LFO syncs would keep running at the
   * project tempo while the transport runs at the scene tempo. The offline
   * renderer calls this per clip window for live==offline parity.
   * `null` clears the scene override — runtimes return to doc.bpm.
   */
  setEffectiveBpm(bpm: number | null): void {
    this.sceneBpmOverride = bpm;
    const effective = bpm ?? this.doc?.bpm;
    if (effective != null && Number.isFinite(effective)) this.pushSyncBpm(effective);
  }

  private pushSyncBpm(bpm: number): void {
    if (this.syncedBpm === bpm) return;
    this.syncedBpm = bpm;
    // Bus and return chains hold tempo-synced runtimes (SYNC delays, LFO
    // syncs) — without these loops a return delay kept the old BPM after a
    // project/scene tempo change and echoes landed off-grid.
    for (const nodes of [
      ...this.trackNodes.values(),
      ...this.groupNodes.values(),
      ...this.returnNodes.values(),
    ]) {
      for (const rt of nodes.fx.runtimes.values()) rt.syncBpm?.(bpm);
    }
    // Instrument runtimes: tempo-synced modulators (LFO sync, texture delay,
    // granular rate sync) pick the new tempo up live.
    for (const inst of this.instruments.values()) inst.runtime.syncBpm?.(bpm);
  }

  /**
   * Minimal PDC for latency-introducing effects (look-ahead limiter etc.).
   * Inserts and groups are fully compensated to the longest chain. Sends tap
   * post-track-PDC, so each send carries its own compensation delay covering
   * the downstream group latency minus the return's own latency — dry vs wet
   * lands sample-aligned for zero-latency returns (reverb/delay/duck/chorus)
   * no matter which track or group feeds them. Returns keep their true
   * relative timing (no padding inflation). Documented residual: a return
   * carrying its own latency FX (limiter on a return) fed from a
   * lower-latency chain stays late by (returnLat − downstream).
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
    // Return latencies are read per-send below; returns themselves are NOT
    // padded (their true timing is what the send delays align against).
    const returnLatency = new Map<string, number>();
    for (const [id, nodes] of this.returnNodes) returnLatency.set(id, chainLatency(nodes.fx));
    const now = ctx.currentTime;
    for (const [id, nodes] of this.trackNodes) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(Math.max(0, maxEffective - (effective.get(id) ?? 0)), now, 0.02);
    }
    for (const nodes of this.groupNodes.values()) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(0, now, 0.02);
    }
    for (const nodes of this.returnNodes.values()) {
      nodes.fx.pdcDelay?.delayTime.setTargetAtTime(0, now, 0.02);
    }
    // Per-send compensation. Track taps sit post-track-PDC at
    // (maxEffective − groupLat), so the send waits out the downstream group
    // latency minus the return's own latency. Group taps sit post-group at
    // exactly maxEffective (downstream 0).
    for (const [id, nodes] of this.trackNodes) {
      const track = this.doc.tracks.find((t) => t.id === id);
      const downstream = track && track.kind !== "group" && track.groupId ? (groupLatency.get(track.groupId) ?? 0) : 0;
      for (const [returnId, delay] of nodes.sendDelays) {
        delay.delayTime.setTargetAtTime(sendPdcDelaySec(downstream, returnLatency.get(returnId) ?? 0), now, 0.02);
      }
    }
    for (const nodes of this.groupNodes.values()) {
      for (const [returnId, delay] of nodes.sendDelays) {
        delay.delayTime.setTargetAtTime(sendPdcDelaySec(0, returnLatency.get(returnId) ?? 0), now, 0.02);
      }
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
        nodes.sendDelays.get(returnId)?.disconnect();
        nodes.sendDelays.delete(returnId);
      }
    }
    for (const returnId of live) {
      let sendGain = nodes.sends.get(returnId);
      if (!sendGain) {
        sendGain = ctx.createGain();
        // Per-send PDC stage: sendGain → delay → return input. syncPdc()
        // sizes the delay so dry vs wet lands aligned (delayTime 0 when no
        // latency FX is involved — fully transparent).
        const sendDelay = ctx.createDelay(0.2);
        sendGain.connect(sendDelay);
        sendDelay.connect(this.returnNodes.get(returnId)!.input);
        nodes.sends.set(returnId, sendGain);
        nodes.sendDelays.set(returnId, sendDelay);
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
      const normGain = ctx.createGain();
      const normGainDb = presetNormalizationGainDb(track.presetId);
      normGain.gain.value = dbToLinear(normGainDb);
      runtime.output.connect(normGain).connect(nodes.input);
      state = {
        runtime,
        normGain,
        normGainDb,
        params: { ...track.params },
        sampleId: track.sampleId,
        layers: track.velocityLayers,
        pitchBend: 0,
      };
      this.instruments.set(track.id, state);
      return;
    }
    // Preset switches (or a regenerated loudness map) move the normalization
    // stage — everything else about the runtime is diffed above/below.
    const targetNormDb = presetNormalizationGainDb(track.presetId);
    if (state.normGainDb !== targetNormDb) {
      state.normGainDb = targetNormDb;
      state.normGain.gain.setTargetAtTime(dbToLinear(targetNormDb), ctx.currentTime, 0.01);
    }
    if (state.sampleId !== track.sampleId) {
      state.runtime.setSample?.(track.sampleId);
      state.sampleId = track.sampleId;
    }
    if (state.layers !== track.velocityLayers) {
      // Reference compare — setVelocityLayersCommand swaps in a fresh array.
      state.layers = track.velocityLayers;
      state.runtime.setVelocityLayers?.(track.velocityLayers ?? []);
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
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    slideFromWhen?: number,
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
    // Ratio p-lock: for Keys, override bell ratio for this voice only (Elektron-style)
    const docTrack = this.doc?.tracks.find((t) => t.id === trackId) as
      import("../project-model/types").InstrumentTrack | undefined;
    const lockedRatio = locks?.ratio;
    const needsRatioLock = lockedRatio !== undefined && docTrack?.instrument === "keys";
    const savedRatio: number | undefined = needsRatioLock ? (docTrack!.params as any).ratio : undefined;
    if (needsRatioLock) {
      inst.runtime.setParameterAt?.("ratio", Math.max(1, Math.min(7, lockedRatio as number)), when) ??
        inst.runtime.setParameter("ratio", Math.max(1, Math.min(7, lockedRatio as number)));
    }
    if (slideFrom) {
      // Glide origin in AudioContext seconds. The scheduler passes the
      // origin's own time from the SAME transport tick→time map that
      // produced `when` — the previous doc.bpm-based conversion was an
      // identity no-op that desynced the glide after any pause, seek or
      // scene-tempo change (glideStart clamped to 0 or landing after `when`).
      const glideStart =
        slideFromWhen !== undefined && Number.isFinite(slideFromWhen) && slideFromWhen < when
          ? slideFromWhen
          : Math.max(0, when - durationSec);
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec, {
        pitch: slideFrom.pitch,
        when: Math.max(0, glideStart),
      });
    } else {
      inst.runtime.noteOn(adjustedPitch, velocity, when, durationSec);
    }
    if (needsRatioLock) {
      // Restore after voice captured ratio (next tick) — keep automation clean
      const restoreAt = when + 0.001;
      if (savedRatio === undefined) {
        // No prior ratio — restore the instrument default on the RUNTIME only.
        // The live doc must never be mutated from the audio path: it bypasses
        // the command/undo system, breaks immutable-doc delta capture, and in
        // a race (user sets a ratio param while the note sounds) would delete
        // their fresh edit.
        inst.runtime.setParameterAt?.("ratio", 3.5, restoreAt) ?? inst.runtime.setParameter("ratio", 3.5);
      } else {
        inst.runtime.setParameterAt?.("ratio", savedRatio, restoreAt) ?? inst.runtime.setParameter("ratio", savedRatio);
      }
    }
  }

  /**
   * Schedule an AudioClip buffer segment through its track's FX chain.
   * Reuses frozenPlaybackOffset semantics (tick→sec + loop offset not needed
   * for one-shots; we use the same tick→sec conversion so live==offline).
   * The clip's timeline is `startBar→lengthBars` (bars), playback offset is
   * `offsetSec+trimStart`, duration is capped to the buffer length minus trims.
   *
   * stretchMode:
   * - "resample" (default): playbackRate changes pitch + time together
   * - "stretch": non-destructive time-stretch preserves pitch (pre-rendered
   *   grain buffer cached per bufferId+rate, deterministic live==offline)
   */
  triggerAudioClip(clip: import("../project-model/types").AudioClip, when: number, durationSec?: number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc) return;
    if (this.frozenBuffers.has(clip.trackId)) return;
    const nodes = this.trackNodes.get(clip.trackId) ?? this.groupNodes.get(clip.trackId);
    if (!nodes) return;
    const srcBuffer = this.bank?.get(clip.bufferId);
    if (!srcBuffer) return;

    const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
    const reverse = clip.reverse;

    // --- stretchMode selection ---
    let playBuffer: AudioBuffer;
    let playbackRate: number;
    let clipDurSec: number;
    // offsetSec/trimStart/trimEnd are seconds in the ORIGINAL sample; the
    // stretched buffer's timeline is original × rate, so positions must be
    // scaled by `timeScale` before they can index into the play buffer.
    let timeScale: number;

    if (clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01) {
      // Lazy-compute stretched buffer and cache it (LRU: re-inserting on a hit
      // moves the key to the newest slot; eviction drops only the oldest —
      // same policy as the sampler's pitch cache in registry.ts).
      const cacheKey = `${clip.bufferId}|${rate}|${reverse ? 1 : 0}`;
      let stretched = this.stretchCache.get(cacheKey);
      if (stretched) {
        this.stretchCache.delete(cacheKey);
        this.stretchCache.set(cacheKey, stretched);
      } else {
        stretched = computeStretchedBuffer(ctx, srcBuffer, rate, reverse);
        if (this.stretchCache.size >= AudioEngine.STRETCH_CACHE_LIMIT) {
          const oldest = this.stretchCache.keys().next().value as string | undefined;
          if (oldest !== undefined) this.stretchCache.delete(oldest);
        }
        this.stretchCache.set(cacheKey, stretched);
      }
      playBuffer = stretched;
      playbackRate = 1;
      clipDurSec = durationSec ?? stretched.duration;
      timeScale = rate;
    } else {
      // Default resample: playbackRate controls both pitch and time
      playBuffer = srcBuffer;
      playbackRate = (reverse ? -1 : 1) * rate;
      clipDurSec = durationSec ?? srcBuffer.duration / Math.abs(playbackRate);
      timeScale = 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = playBuffer;
    source.playbackRate.value = playbackRate;

    const gain = ctx.createGain();
    gain.gain.value = Math.min(2, Math.max(0, clip.gain ?? 1));
    // Fade in/out using linear ramps — scheduled at `when`
    const fadeIn = Math.max(0, clip.fadeIn ?? 0);
    const fadeOut = Math.max(0, clip.fadeOut ?? 0);
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

    // Offset / trim handling
    const { duration, playOffset, contentDur } = audioClipPlayWindow(clip, playBuffer.duration, clipDurSec, timeScale);

    const hasWarpPins = (clip.warpMarkers?.length ?? 0) > 0;
    const clipTicks = clip.lengthBars * BAR_TICKS;
    // Pitch-preserving warp: stretch mode + pins → pre-rendered phase-vocoder
    // buffer (cached, tempo-exact). A cache miss warms in the background while
    // THIS trigger plays legacy straight-stretched, so timing never gaps —
    // the next loop iteration is exact.
    let warpedHit: AudioBuffer | null = null;
    if (hasWarpPins && !reverse && clip.loop !== true && clip.stretchMode === "stretch") {
      warpedHit = this.warpCache.get(this.warpCacheKey(clip, clipDurSec)) ?? null;
      if (warpedHit) {
        source.buffer = warpedHit;
        source.playbackRate.value = 1;
      } else {
        this.warmWarp(clip, clipDurSec);
      }
    }

    // Repitch warp (FL/Slicex-style): warp markers pin sample time to the
    // arrangement grid. Resample mode only — pitch follows time; stretch mode
    // is served by the preserving path above, reverse keeps its legacy path.
    // Loop is skipped when warp maps the clip (warp already spans it fully).
    const warpSegs =
      warpedHit !== null || clip.reverse === true || clip.stretchMode === "stretch" || clip.loop === true
        ? null
        : buildWarpSegments({
            markers: clip.warpMarkers ?? [],
            clipStartTick: clip.startBar * BAR_TICKS,
            clipTicks,
            spt: clipTicks > 0 ? clipDurSec / clipTicks : 0,
            contentStartSec: playOffset,
            contentDurSec: contentDur,
          });

    // Texture-bed loop: cycle the trimmed content for the whole clip length
    // (a 4-bar atmosphere fills 16 bars). Native buffer loop over the content
    // window; the `start(when, offset, duration)` below still bounds total
    // playback and fades still apply at the clip edges. Skipped for reverse
    // (negative-rate looping is undefined behaviour in Web Audio).
    if (!warpSegs && clip.loop === true && !reverse && contentDur > 0.02) {
      const loopEnd = Math.min(playBuffer.duration, playOffset + contentDur);
      if (loopEnd - playOffset >= 0.01) {
        source.loop = true;
        source.loopStart = playOffset;
        source.loopEnd = loopEnd;
      }
    }

    if (warpSegs) {
      // The primary `source` is never started on the segmented path — only
      // per-segment sources are. Disconnect it now so the connected-but-silent
      // BufferSource (and its source→gain edge) does not accumulate in the
      // render graph on every re-trigger of a looped warp clip.
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      // One repitch source per segment through a private micro-fade gain, all
      // sharing the clip gain (musical fades still span the whole clip).
      // Interior joints overlap into a 3 ms crossfade (see
      // `warpSegmentRenders`): boundaries stay grid-exact, clicks do not.
      // Live and offline schedule identically.
      const renders = warpSegmentRenders(warpSegs, {
        clipTicks,
        clipDurSec,
        contentStartSec: playOffset,
        contentDurSec: contentDur,
      });
      let pending = warpSegs.length;
      for (let s = 0; s < warpSegs.length; s++) {
        const seg = warpSegs[s];
        const render = renders[s] ?? {
          startOffsetSec: (seg.startTick / clipTicks) * clipDurSec,
          bufOffsetSec: seg.bufStartSec,
          playDurSec: Math.max(0.005, seg.bufEndSec - seg.bufStartSec),
          fadeInAt: (seg.startTick / clipTicks) * clipDurSec,
          fadeInDur: 0,
          fadeOutAt: (seg.endTick / clipTicks) * clipDurSec,
          fadeOutDur: 0,
        };
        const segSource = ctx.createBufferSource();
        segSource.buffer = playBuffer;
        segSource.playbackRate.value = seg.rate;
        const segGain = ctx.createGain();
        segSource.connect(segGain).connect(gain);
        const segWhen = when + render.startOffsetSec;
        if (render.fadeInDur > 0.0001) {
          segGain.gain.setValueAtTime(0, segWhen);
          segGain.gain.linearRampToValueAtTime(1, segWhen + render.fadeInDur);
        } else {
          segGain.gain.setValueAtTime(1, segWhen);
        }
        if (render.fadeOutDur > 0.0001) {
          const foutAt = when + render.fadeOutAt;
          segGain.gain.setValueAtTime(1, foutAt);
          segGain.gain.linearRampToValueAtTime(0, foutAt + render.fadeOutDur);
        }
        try {
          // start() duration is buffer-domain: wall play length × rate.
          segSource.start(segWhen, render.bufOffsetSec, Math.max(0.005, render.playDurSec * seg.rate));
          segSource.stop(segWhen + render.playDurSec + 0.01);
        } catch {
          /* already started */
        }
        this.oneShotSources.add(segSource);
        segSource.onended = () => {
          this.oneShotSources.delete(segSource);
          try {
            segSource.disconnect();
          } catch {}
          try {
            segGain.disconnect();
          } catch {}
          if (--pending <= 0) {
            try {
              gain.disconnect();
            } catch {}
          }
        };
      }
    } else {
      // A preserving-warp hit plays the pre-rendered clip from its head.
      const effOffset = warpedHit ? 0 : playOffset;
      const effDur = warpedHit ? Math.min(clipDurSec, warpedHit.duration) : duration;
      try {
        source.start(when, effOffset, effDur);
        source.stop(when + effDur + 0.01);
      } catch {
        /* already started */
      }
      this.oneShotSources.add(source);
      source.onended = () => {
        this.oneShotSources.delete(source);
        try {
          source.disconnect();
        } catch {}
        try {
          gain.disconnect();
        } catch {}
      };
    }
  }

  /**
   * Clear the time-stretch buffer cache. Called automatically when the engine
   * switches to a different project (see setProject) — bufferIds are only
   * meaningful within one bank/project generation, so stale stretched buffers
   * must never outlive their source project.
   */
  clearStretchCache(): void {
    this.stretchCache.clear();
  }

  /** Clear pitch-preserving warp renders (project swap / bank rebuild). */
  clearWarpCache(): void {
    this.warpCache.clear();
    this.warpInflight.clear();
  }

  /** Tempo-exact cache key: buffer + wall length + warp pins. */
  private warpCacheKey(clip: import("../project-model/types").AudioClip, wallSec: number): string {
    const pins = (clip.warpMarkers ?? []).map((m) => `${m.timeSec.toFixed(3)}@${Math.round(m.tick)}`).join(",");
    return `${clip.bufferId}|w${wallSec.toFixed(3)}|${hashString(pins).toString(36)}`;
  }

  /**
   * Shared sync core for warp renders: bank buffer → repitch segments →
   * pitch-preserving rate envelope → render job. Used by the synchronous
   * offline path and (for its cheap prefix) by the async live warmer.
   * The warp map fully determines timing here — stretchRate is bypassed
   * (pins capture the geometry; a pin placed at the straight-playback
   * position reproduces the legacy rate).
   */
  private buildWarpJob(
    clip: import("../project-model/types").AudioClip,
    wallSec: number,
  ): {
    key: string;
    src: AudioBuffer;
    intervals: WarpRateInterval[];
    outLen: number;
    sampleRate: number;
  } | null {
    const ctx = this.ctx;
    const src = this.bank?.get(clip.bufferId);
    if (!ctx || !src) return null;
    const markers = clip.warpMarkers ?? [];
    if (markers.length === 0 || clip.reverse || clip.loop) return null;
    if (clip.stretchMode !== "stretch") return null;
    if (!Number.isFinite(wallSec) || wallSec <= 0) return null;
    const clipTicks = clip.lengthBars * BAR_TICKS;
    if (!(clipTicks > 0)) return null;
    const spt = wallSec / clipTicks;
    const { playOffset, contentDur } = audioClipPlayWindow(clip, src.duration, Infinity, 1);
    const segs = buildWarpSegments({
      markers,
      clipStartTick: clip.startBar * BAR_TICKS,
      clipTicks,
      spt,
      contentStartSec: playOffset,
      contentDurSec: contentDur,
    });
    if (!segs) return null;
    const intervals = segs.map((s) => ({
      startSec: s.startTick * spt,
      endSec: s.endTick * spt,
      rate: Math.min(
        4,
        Math.max(0.25, ((s.endTick - s.startTick) * spt) / Math.max(1e-6, s.bufEndSec - s.bufStartSec)),
      ),
    }));
    return {
      key: this.warpCacheKey(clip, wallSec),
      src,
      intervals,
      outLen: Math.max(1, Math.round(wallSec * ctx.sampleRate)),
      sampleRate: ctx.sampleRate,
    };
  }

  private storeWarpBuffer(key: string, buf: AudioBuffer): void {
    if (this.warpCache.has(key)) this.warpCache.delete(key);
    else if (this.warpCache.size >= AudioEngine.WARP_CACHE_LIMIT) {
      const oldest = this.warpCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.warpCache.delete(oldest);
    }
    this.warpCache.set(key, buf);
  }

  /**
   * Synchronous pitch-preserving warp render (offline/export path — no
   * realtime pressure). Result is cached, so the live trigger hitting the
   * same wall length plays the identical buffer.
   */
  precomputeWarpSync(clip: import("../project-model/types").AudioClip, wallSec: number): AudioBuffer | null {
    const ctx = this.ctx;
    const job = this.buildWarpJob(clip, wallSec);
    if (!ctx || !job) return null;
    const hit = this.warpCache.get(job.key);
    if (hit) return hit;
    try {
      const rateAt = warpRateEnvelope(job.intervals);
      const buf = ctx.createBuffer(job.src.numberOfChannels, job.outLen, job.sampleRate);
      for (let c = 0; c < job.src.numberOfChannels; c++) {
        buf
          .getChannelData(c)
          .set(phaseVocoderWarpChannel(job.src.getChannelData(c), job.sampleRate, rateAt, job.outLen));
      }
      this.storeWarpBuffer(job.key, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Project-tempo estimate for UI-driven prewarming (the exact wall follows
   * the scene tempo at trigger; a tempo-mismatched key simply misses and
   * re-warms). Called after warp edits so the next play is already exact.
   */
  warmWarpForClip(clip: import("../project-model/types").AudioClip): void {
    const bpm = this.doc?.bpm;
    if (!bpm || !(bpm > 0)) return;
    this.warmWarp(clip, (clip.lengthBars * BAR_TICKS * 60) / (bpm * PPQ));
  }

  /** Background warp render into the cache (worker when worthwhile). */
  private warmWarp(clip: import("../project-model/types").AudioClip, wallSec: number): void {
    const job = this.buildWarpJob(clip, wallSec);
    if (!job) return;
    if (this.warpCache.has(job.key) || this.warpInflight.has(job.key)) return;
    const epoch = this.warpEpoch;
    const warmCtx = this.ctx;
    this.warpInflight.add(job.key);
    const channels: Float32Array[] = [];
    for (let c = 0; c < job.src.numberOfChannels; c++) channels.push(Float32Array.from(job.src.getChannelData(c)));
    renderWarpPreserveAsync(channels, job.sampleRate, job.intervals, job.outLen).then((rendered) => {
      this.warpInflight.delete(job.key);
      const ctx = this.ctx;
      if (rendered.length === 0 || this.warpEpoch !== epoch || !ctx || ctx !== warmCtx) return;
      try {
        const buf = ctx.createBuffer(rendered.length, job.outLen, job.sampleRate);
        rendered.forEach((ch, i) => {
          if (i < buf.numberOfChannels) buf.getChannelData(i).set(ch.subarray(0, job.outLen));
        });
        this.storeWarpBuffer(job.key, buf);
      } catch {
        /* context died mid-render */
      }
    });
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
        if (nodes) return target.kind === "trackGain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
        const returnNodes = this.returnNodes.get(target.trackId);
        return returnNodes && target.kind === "trackGain" ? returnNodes.modAutoGain.gain : null;
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
    const def = this.doc ? targetParamDef(this.doc, target) : null;
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
      const hostNodes =
        this.trackNodes.get(lfo.trackId) ?? this.groupNodes.get(lfo.trackId) ?? this.returnNodes.get(lfo.trackId);
      // Host may be a return track (for return-targeted bus); allow any nodes.
      if (!hostNodes && kind === "osc" && lfoKind(lfo) === "osc" && !lfo.target) continue;
      if (!hostNodes && !resolveLfoTarget(lfo)) continue;
      const target = resolveLfoTarget(lfo);
      // ProjectStore local commands can reach the engine before a full
      // normalization pass. Never let a stale/deleted FX id fall through to
      // the runtime lookup or accidentally bind an LFO to a different chain.
      if (!targetParamDef(doc, target)) continue;
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
        this.trackNodes.get(sourceTrackId) ?? this.groupNodes.get(sourceTrackId) ?? this.returnNodes.get(sourceTrackId);
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

  private effectRuntimeForTarget(target: AutomationTarget): EffectRuntime | null {
    if (target.kind !== "fxParam" || !target.fxId) return null;
    const nodes =
      this.trackNodes.get(target.trackId) ??
      this.groupNodes.get(target.trackId) ??
      this.returnNodes.get(target.trackId);
    return nodes?.fx.runtimes.get(target.fxId) ?? null;
  }

  private instrumentRuntimeForTarget(target: AutomationTarget): InstrumentRuntime | null {
    if (target.kind !== "instParam") return null;
    return this.instruments.get(target.trackId)?.runtime ?? null;
  }

  /** Current persisted base value for a device target (before modulation). */
  private baseValueForTarget(doc: ProjectDocument, target: AutomationTarget): number | null {
    const def = targetParamDef(doc, target);
    if (!def) return null;
    if (target.kind === "fxParam" && target.fxId && target.paramId) {
      const effect = targetOwner(doc, target.trackId)?.effects.find((fx) => fx.id === target.fxId);
      return effect?.params[target.paramId] ?? def.default;
    }
    if (target.kind === "instParam" && target.paramId) {
      const track = targetOwner(doc, target.trackId);
      return track?.kind === "instrument" ? (track.params[target.paramId] ?? def.default) : null;
    }
    return null;
  }

  /**
   * The single device-parameter write path used by macros, modulators and
   * automation. It resolves track/group/return ownership and clamps against
   * the same catalog used by schema + UI before touching a runtime.
   */
  private writeDeviceTargetAt(target: AutomationTarget, value: number, when?: number): boolean {
    const doc = this.doc;
    if (!target.paramId) return false;
    // The engine always has a document in production. Keeping the runtime
    // fallback makes the small isolated engine tests useful with injected
    // node maps, while real document-bound writes remain strictly validated.
    if (doc && Array.isArray(doc.tracks) && !targetParamDef(doc, target)) return false;
    const clamped = doc ? clampTargetValue(doc, target, value) : value;
    if (target.kind === "fxParam") {
      const runtime = this.effectRuntimeForTarget(target);
      if (!runtime) return false;
      if (when !== undefined && runtime.setParameterAt) runtime.setParameterAt(target.paramId, clamped, when);
      else runtime.setParameter(target.paramId, clamped);
      return true;
    }
    if (target.kind === "instParam") {
      const runtime = this.instrumentRuntimeForTarget(target);
      if (!runtime) return false;
      if (when !== undefined && runtime.setParameterAt) runtime.setParameterAt(target.paramId, clamped, when);
      else runtime.setParameter(target.paramId, clamped);
      return true;
    }
    return false;
  }

  private syncMacros(doc: ProjectDocument): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const next = new Map<string, { gain: number; pan: number }>();
    for (const track of doc.tracks) {
      next.set(track.id, { gain: 1, pan: 0 });
    }
    for (const ret of doc.returns) {
      next.set(ret.id, { gain: 1, pan: 0 });
    }
    const deviceOffsets = new Map<string, { target: AutomationTarget; delta: number }>();
    // Writer composition rule (one writer per chain):
    // - macro/intensity performance offsets resolve FX/inst params as
    //   base ± half-range·bipolar·amount around the PERSISTED doc value —
    //   repeated syncs can never accumulate;
    // - gain/pan offsets accumulate into the dedicated modMacro* nodes;
    // - modulators (LFO/step/S&H) own the modAuto* chain and automation
    //   lanes their own writers — nobody else writes those params.
    const applyToTarget = (
      target: import("../project-model/types").AutomationTarget,
      bipolar: number,
      amount: number,
    ): void => {
      if (target.kind === "trackGain" || target.kind === "trackPan") {
        const acc = next.get(target.trackId);
        if (!acc) return;
        if (target.kind === "trackGain") acc.gain += amount * bipolar;
        else acc.pan += amount * bipolar;
        return;
      }
      if (target.kind === "fxParam") {
        if (!target.fxId || !target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `fx:${target.trackId}:${target.fxId}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
        return;
      }
      if (target.kind === "instParam") {
        if (!target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `inst:${target.trackId}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
      }
    };
    const intensityBipolar = Math.max(-1, Math.min(1, this.currentSceneIntensity * 2 - 1));
    for (const macro of doc.macros) {
      const bipolar = Math.max(-1, Math.min(1, macro.value * 2 - 1));
      for (const mapping of macro.mappings) {
        const amount = mapping.amount;
        if (mapping.source === "intensity") {
          // Scene intensity drives ANY target; gain/pan accumulate via next map.
          if (mapping.target) applyToTarget(mapping.target, intensityBipolar, amount);
          else {
            if (mapping.param !== "gain" && mapping.param !== "pan") continue;
            const acc = next.get(mapping.trackId);
            if (!acc) continue;
            if (mapping.param === "gain") acc.gain += amount * intensityBipolar;
            else acc.pan += amount * intensityBipolar;
          }
          continue;
        }
        // source "macro" (and legacy midiCC): bipolar from THIS macro's value.
        // Generic target (P2 bus) takes precedence over legacy trackId/param.
        if (mapping.target) {
          applyToTarget(mapping.target, bipolar, amount);
          continue;
        }
        if (mapping.param !== "gain" && mapping.param !== "pan") continue;
        const acc = next.get(mapping.trackId);
        if (!acc) continue;
        if (mapping.param === "gain") acc.gain += amount * bipolar;
        else acc.pan += amount * bipolar;
      }
    }
    // Device mappings compose before the single runtime write. This prevents
    // two macros/intensity mappings to the same deep parameter from silently
    // overwriting each other in iteration order.
    for (const { target, delta } of deviceOffsets.values()) {
      const base = this.baseValueForTarget(doc, target);
      if (base !== null) this.writeDeviceTargetAt(target, base + delta);
    }
    for (const [trackId, offsets] of next) {
      const gain = Math.max(0, offsets.gain);
      const pan = Math.min(1, Math.max(-1, offsets.pan));
      const cached = this.macroCache.get(trackId);
      if (cached && cached.gain === gain && cached.pan === pan) continue;
      const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
      const returnNodes = this.returnNodes.get(trackId);
      if (nodes) {
        nodes.modMacroGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
        nodes.modMacroPan.pan.setTargetAtTime(pan, ctx.currentTime, 0.01);
      } else if (returnNodes) {
        const returnTrack = doc.returns.find((ret) => ret.id === trackId);
        if (returnTrack) {
          returnNodes.gain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, returnTrack.gain)), ctx.currentTime, 0.01);
          returnNodes.modMacroGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
        }
      }
      this.macroCache.set(trackId, { gain, pan });
    }
    for (const trackId of [...this.macroCache.keys()]) {
      if (!next.has(trackId)) this.macroCache.delete(trackId);
    }
  }

  /** Update the live scene intensity signal. Idempotent. */
  setSceneIntensity(value: number): void {
    const next = Math.max(0, Math.min(1, value));
    if (next === this.currentSceneIntensity) return;
    this.currentSceneIntensity = next;
    // The signal is a live modulation source, not merely UI state. Recompose
    // the same macro writer immediately so scheduler intensity changes are
    // audible in realtime and use the exact same mapping semantics as export.
    if (this.doc) this.syncMacros(this.doc);
  }

  /**
   * Schedule the scene-intensity macro bus for offline rendering. The live
   * scheduler updates this signal at control rate; an offline render must
   * write the same composed macro/intensity values onto the audio timeline or
   * exports will silently stay at the default 0.7 intensity.
   */
  scheduleSceneIntensity(points: Array<{ tick: number; value: number }>, timeAt: (tick: number) => number): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc || points.length === 0) return;

    const ordered = points
      .filter((point) => Number.isFinite(point.tick) && Number.isFinite(point.value))
      .slice()
      .sort((a, b) => a.tick - b.tick);
    for (const point of ordered) {
      const next = new Map<string, { gain: number; pan: number }>();
      for (const track of doc.tracks) next.set(track.id, { gain: 1, pan: 0 });
      for (const ret of doc.returns) next.set(ret.id, { gain: 1, pan: 0 });

      const deviceOffsets = new Map<string, { target: AutomationTarget; delta: number }>();
      const applyToTarget = (target: AutomationTarget, bipolar: number, amount: number): void => {
        if (target.kind === "trackGain" || target.kind === "trackPan") {
          const acc = next.get(target.trackId);
          if (!acc) return;
          if (target.kind === "trackGain") acc.gain += amount * bipolar;
          else acc.pan += amount * bipolar;
          return;
        }
        if (target.kind !== "fxParam" && target.kind !== "instParam") return;
        if (!target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `${target.kind}:${target.trackId}:${target.fxId ?? ""}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
      };

      const intensityBipolar = Math.max(-1, Math.min(1, point.value * 2 - 1));
      for (const macro of doc.macros) {
        const macroBipolar = Math.max(-1, Math.min(1, macro.value * 2 - 1));
        for (const mapping of macro.mappings) {
          const bipolar = mapping.source === "intensity" ? intensityBipolar : macroBipolar;
          if (mapping.target) {
            applyToTarget(mapping.target, bipolar, mapping.amount);
            continue;
          }
          if (mapping.param !== "gain" && mapping.param !== "pan") continue;
          const acc = next.get(mapping.trackId);
          if (!acc) continue;
          if (mapping.param === "gain") acc.gain += mapping.amount * bipolar;
          else acc.pan += mapping.amount * bipolar;
        }
      }

      const mappedTime = timeAt(point.tick);
      const when = Math.max(ctx.currentTime, Number.isFinite(mappedTime) ? mappedTime : ctx.currentTime);
      for (const { target, delta } of deviceOffsets.values()) {
        const base = this.baseValueForTarget(doc, target);
        if (base !== null) this.writeDeviceTargetAt(target, base + delta, when);
      }
      for (const [trackId, offsets] of next) {
        const gain = Math.max(0, offsets.gain);
        const pan = Math.min(1, Math.max(-1, offsets.pan));
        const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
        const returnNodes = this.returnNodes.get(trackId);
        if (nodes) {
          nodes.modMacroGain.gain.setTargetAtTime(gain, when, 0.008);
          nodes.modMacroPan.pan.setTargetAtTime(pan, when, 0.008);
        } else if (returnNodes) {
          returnNodes.modMacroGain.gain.setTargetAtTime(gain, when, 0.008);
        }
      }
    }
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
    timeAt?: (tick: number) => number,
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
    this.applyLane(lane, v0, v1, fromTick, toTick, scheduleOffsetSec, timeAt);
  }

  /** Apply a single automation lane directly (not via doc.automation). */
  private applyLane(
    lane: { id: string; target: import("../project-model/types").AutomationTarget; points: AutomationPoint[] },
    v0: number,
    v1: number,
    fromTick: number,
    toTick: number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    const t0Fallback = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1Fallback = Math.max(t0Fallback, this.currentTime + 0.1 + offset);
    let t0 = t0Fallback;
    let t1 = t1Fallback;
    if (timeAt) {
      const mapped0 = timeAt(fromTick);
      const mapped1 = timeAt(toTick);
      if (Number.isFinite(mapped0) && Number.isFinite(mapped1)) {
        t0 = Math.max(ctx.currentTime, mapped0 + offset);
        t1 = Math.max(t0, mapped1 + offset);
      }
    }
    this.writeAutomationTargetAt(lane.target, v0, t0);
    this.writeAutomationTargetAt(lane.target, v1, t1);
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
    this.oneShotSources.add(source);
    source.onended = () => {
      this.oneShotSources.delete(source);
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
    this.oneShotSources.add(source);
    source.onended = () => {
      this.oneShotSources.delete(source);
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
    this.oneShotSources.add(osc);
    osc.onended = () => {
      this.oneShotSources.delete(osc);
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
        const returnNodes = this.returnNodes.get(target.trackId);
        if (!nodes && !returnNodes) return null;
        const param = nodes
          ? target.kind === "trackGain"
            ? nodes.modAutoGain.gain
            : nodes.modAutoPan.pan
          : returnNodes!.modAutoGain.gain;
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
            const doc = this.doc;
            const def = doc ? targetParamDef(doc, target) : null;
            const base = doc ? this.baseValueForTarget(doc, target) : null;
            if (!def || base === null) return;
            const mapped = base + (def.max - def.min) * 0.5 * value;
            this.writeDeviceTargetAt(target, mapped, when);
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

  /** Shared target writer for realtime and offline automation. */
  private writeAutomationTargetAt(target: AutomationTarget, value: number, when: number): void {
    const doc = this.doc;
    if (doc && Array.isArray(doc.tracks) && !targetParamDef(doc, target)) return;
    if (target.kind === "trackGain" || target.kind === "trackPan") {
      const trackNodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
      const returnNodes = this.returnNodes.get(target.trackId);
      if (target.kind === "trackGain" && returnNodes) {
        returnNodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, value)), when, 0.008);
      } else if (trackNodes && target.kind === "trackGain") {
        trackNodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(2, value)), when, 0.008);
      } else if (trackNodes && target.kind === "trackPan") {
        trackNodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, value)), when, 0.008);
      }
      return;
    }
    this.writeDeviceTargetAt(target, value, when);
  }

  applyAutomation(
    fromTick: number,
    toTick: number,
    relOf: (tick: number) => number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    const ctx = this.ctx;
    const doc = this.doc;
    if (!ctx || !doc || doc.automation.length === 0) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    // Tick-mapped writes (release roadmap 2.3): when the scheduler supplies
    // its tick→time map, the lane endpoints land at the events' musical
    // times — contiguous windows then produce a continuous param timeline
    // (v1 of window N == v0 of window N+1, same time, same value), which
    // also removes the stale setTargetAtTime override of the old
    // wall-clock staircase. Wall-clock fallback stays for callers without
    // a map.
    const t0Fallback = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1Fallback = Math.max(t0Fallback, this.currentTime + 0.1 + offset);
    let t0 = t0Fallback;
    let t1 = t1Fallback;
    if (timeAt) {
      const mapped0 = timeAt(fromTick);
      const mapped1 = timeAt(toTick);
      if (Number.isFinite(mapped0) && Number.isFinite(mapped1)) {
        t0 = Math.max(ctx.currentTime, mapped0 + offset);
        t1 = Math.max(t0, mapped1 + offset);
      }
    }
    for (const lane of doc.automation) {
      if (lane.points.length === 0) continue;
      const fallback =
        targetParamDef(doc, lane.target)?.default ??
        (lane.target.kind === "trackGain" ? 1 : lane.target.kind === "trackPan" ? 0 : 0);
      const v0 = valueAt(lane.points, relOf(fromTick), fallback);
      const v1 = valueAt(lane.points, relOf(toTick), fallback);
      this.writeAutomationTargetAt(lane.target, v0, t0);
      this.writeAutomationTargetAt(lane.target, v1, t1);
    }
  }

  scheduleTrackAutomation(
    trackId: string,
    param: "gain" | "pan",
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    if (points.length === 0) return;
    const target: AutomationTarget = { kind: param === "gain" ? "trackGain" : "trackPan", trackId };
    this.writeAutomationTargetAt(target, valueAt(points, 0, param === "gain" ? 1 : 0), 0);
    for (const point of points) this.writeAutomationTargetAt(target, point.value, Math.max(0, timeAt(point.tick)));
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
    const target: AutomationTarget =
      kind === "fx" ? { kind: "fxParam", trackId, fxId: deviceId, paramId } : { kind: "instParam", trackId, paramId };
    for (const point of points) {
      this.writeAutomationTargetAt(target, point.value, Math.max(0, timeAt(point.tick)));
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
    for (const nodes of this.returnNodes.values()) {
      try {
        nodes.modAutoGain.gain.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      nodes.modAutoGain.gain.setTargetAtTime(1, now, 0.01);
    }

    // Worklet parameters do not have an AudioParam cancelScheduledValues API:
    // a manual set is the takeover operation that removes future timed
    // events. Reset every device target touched by either project or scene
    // automation, then re-compose persistent macro offsets below.
    const deviceTargets = new Map<string, AutomationTarget>();
    for (const lane of this.doc?.automation ?? []) {
      if (lane.target.kind === "fxParam" || lane.target.kind === "instParam") {
        deviceTargets.set(JSON.stringify(lane.target), lane.target);
      }
    }
    for (const lane of this.doc?.sceneAutomation ?? []) {
      if (lane.target.kind === "fxParam" || lane.target.kind === "instParam") {
        deviceTargets.set(JSON.stringify(lane.target), lane.target);
      }
    }
    for (const target of deviceTargets.values()) {
      const base = this.baseValueForTarget(this.doc!, target);
      if (base !== null) this.writeDeviceTargetAt(target, base);
    }
    if (this.doc) {
      // Return and device macros share the same canonical base writer after a
      // stop; force a fresh composition so stopping automation never erases
      // an intentionally active macro value.
      this.macroCache.clear();
      this.syncMacros(this.doc);
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

    // Per-voice lowpass for cutoff p-lock — or for a filter-target pad mod
    const mod = pad.mod;
    const modActive = !!(mod && mod.depth > 0 && mod.rateHz > 0);
    const wantsFilter = locks?.cutoff !== undefined || (modActive && mod!.target === "filter");
    let voiceFilter: BiquadFilterNode | null = null;
    let voiceOutput: AudioNode = panner;
    if (wantsFilter) {
      voiceFilter = ctx.createBiquadFilter();
      voiceFilter.type = "lowpass";
      const baseFreq = locks?.cutoff ?? (modActive && mod!.target === "filter" ? mod!.base : undefined) ?? 8000;
      voiceFilter.frequency.value = Math.min(16000, Math.max(80, baseFreq));
      voiceFilter.Q.value = 0.7;
      // Chain: source -> gain -> panner -> filter -> trackInput
      source.connect(gain).connect(panner).connect(voiceFilter).connect(trackNodes.input);
      voiceOutput = voiceFilter;
    } else {
      source.connect(gain).connect(panner).connect(trackNodes.input);
    }

    const voice: Voice = { source, gain, trackId, chokeGroup: pad.chokeGroup, filter: voiceFilter ?? undefined };
    if (modActive) this.attachPadMod(voice, mod!, peak, when, endWhen);
    this.addDrumVoice(voice);
    source.onended = () => {
      this.voices.delete(voice);
      gain.disconnect();
      panner.disconnect();
      if (voiceFilter) voiceFilter.disconnect();
      if (voice.extras) {
        for (const n of voice.extras) {
          try {
            (n as OscillatorNode).stop?.();
          } catch {
            /* already stopped */
          }
          try {
            n.disconnect();
          } catch {
            /* already */
          }
        }
      }
      source.disconnect();
    };
    // Slice playback uses the native buffer offset/duration path — realtime
    // and export share the exact same samples.
    if (pad.sliceLoop === true && !slice.reverse) {
      // MPC-style pad loop: play the head into the region, then cycle
      // loopStart→loopEnd until choked, retriggered or a 30 s safety cap.
      const loopStart = Math.min(
        Math.max(slice.start, Number.isFinite(pad.sliceLoopStart) ? pad.sliceLoopStart! : slice.start),
        buffer.duration - 0.005,
      );
      const loopEnd = Math.min(
        Math.max(loopStart + 0.005, Number.isFinite(pad.sliceLoopEnd) ? pad.sliceLoopEnd! : slice.end),
        buffer.duration,
        Math.max(loopStart + 0.005, slice.end),
      );
      if (loopEnd - loopStart >= 0.005) {
        source.loop = true;
        source.loopStart = loopStart;
        source.loopEnd = loopEnd;
        source.start(when, slice.offset);
        // Safety cap: looped pads ring until choke/retrigger, at most 30 s.
        source.stop(when + 30);
        void voiceOutput;
        return;
      }
    }
    source.start(when, slice.offset, slice.duration);
    void voiceOutput;
  }

  /**
   * MPC-style per-pad modulator: a voice-local LFO (osc → depth gain → param)
   * wired to the voice's pitch, gain or filter. Lives and dies with the voice
   * — realtime and offline render share this exact path.
   */
  private attachPadMod(
    voice: Voice,
    mod: NonNullable<import("../project-model/types").DrumPad["mod"]>,
    peak: number,
    when: number,
    _endWhen: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = mod.wave;
    osc.frequency.value = mod.rateHz;
    const depth = ctx.createGain();
    osc.connect(depth);
    if (mod.target === "gain") {
      // Tremolo: LFO adds on TOP of the envelope automation (params sum inputs).
      depth.gain.value = mod.depth * Math.max(0.0001, peak);
      depth.connect(voice.gain.gain);
    } else if (mod.target === "filter") {
      const target = voice.filter;
      if (!target) return;
      depth.gain.value = mod.depth;
      depth.connect(target.frequency);
    } else {
      // Pitch wobble in semitones → cents on the source detune param.
      depth.gain.value = mod.depth * 100;
      const detune = (voice.source as AudioBufferSourceNode).detune;
      if (detune) {
        depth.connect(detune);
      } else {
        // Engines without source detune: wobble playbackRate (±depth semitones).
        depth.gain.value = Math.pow(2, mod.depth / 12) - 1;
        depth.connect((voice.source as AudioBufferSourceNode).playbackRate);
      }
    }
    // Looping pads ring up to the 30 s safety cap; one-shot voices are
    // disconnected at onended, this stop is just the upper bound.
    osc.start(when);
    try {
      osc.stop(when + 30.5);
    } catch {
      /* already scheduled */
    }
    voice.extras = [osc, depth];
  }

  /**
   * Drum voice ceiling (PERFORMANCE.md flag: the one-shot voice Set used to
   * be uncapped — a roll grew it without limit). Insertion-ordered Set, so
   * the first entry is the oldest sounding voice: fade + stop it and let its
   * onended run the normal node cleanup.
   */
  private addDrumVoice(voice: Voice): void {
    this.voices.add(voice);
    const MAX_ACTIVE_DRUM_VOICES = 64;
    let voicesToRetire = this.voices.size - MAX_ACTIVE_DRUM_VOICES;
    if (voicesToRetire <= 0) return;
    const now = this.ctx?.currentTime ?? 0;
    for (const oldest of this.voices) {
      if (voicesToRetire-- <= 0) break;
      try {
        oldest.gain.gain.cancelScheduledValues(now);
        oldest.gain.gain.setTargetAtTime(0.0001, now, 0.004);
        oldest.source.stop(now + 0.03);
      } catch {
        /* already ended — onended removes it */
      }
    }
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
      // Per-pad mod on synth voices: gain wobble on the voice gain, pitch via
      // per-source detune, filter via an extra lowpass after the panner.
      const synthMod = pad.mod;
      if (synthMod && synthMod.depth > 0 && synthMod.rateHz > 0) {
        const osc = ctx.createOscillator();
        osc.type = synthMod.wave;
        osc.frequency.value = synthMod.rateHz;
        const depth = ctx.createGain();
        osc.connect(depth);
        if (synthMod.target === "gain") {
          depth.gain.value = synthMod.depth * Math.max(0.0001, peak);
          depth.connect(gain.gain);
        } else if (synthMod.target === "filter") {
          const vf = ctx.createBiquadFilter();
          vf.type = "lowpass";
          vf.frequency.value = Math.min(16000, Math.max(80, synthMod.base ?? 8000));
          vf.Q.value = 0.7;
          try {
            panner.disconnect();
          } catch {
            /* not yet connected */
          }
          panner.connect(vf).connect(trackNodes.input);
          depth.gain.value = synthMod.depth;
          depth.connect(vf.frequency);
          extraNodes.push(vf);
        } else {
          depth.gain.value = synthMod.depth * 100;
          for (const s of allSources) {
            const d = (s as OscillatorNode).detune;
            if (d) depth.connect(d);
          }
        }
        extraNodes.push(osc, depth);
        osc.start(when);
        try {
          osc.stop(when + dur + 0.6);
        } catch {
          /* already scheduled */
        }
      }
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
      this.addDrumVoice(voice);
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

  preview(pad: DrumPad, trackId: string, velocity = 1): void {
    this.ensureContext();
    this.trigger(trackId, pad, this.currentTime + 0.005, velocity);
  }

  /**
   * Audition an instrument preset without touching the project document.
   *
   * PresetBrowser uses this path for a short, isolated note. The temporary
   * runtime is connected directly to the master preview bus so a muted or
   * silent track cannot make a valid preset audition look broken. Applying
   * the preset remains a separate command-owned operation in the UI.
   */
  previewInstrumentPreset(trackId: string, preset: InstrumentPreset): void {
    this.ensureContext();
    this.stopPreview();
    const ctx = this.ctx;
    const doc = this.doc;
    const master = this.master;
    const track = doc?.tracks.find((candidate): candidate is InstrumentTrack => {
      return candidate.kind === "instrument" && candidate.id === trackId;
    });
    if (!ctx || !master || !track || preset.instrument !== track.instrument) return;

    const definition = INSTRUMENT_DEFS[track.instrument];
    if (!definition) return;
    const params = { ...track.params };
    for (const [id, value] of Object.entries(preset.params)) {
      params[id] = clampInstrumentParam(track.instrument, id, value);
    }
    const previewTrack: InstrumentTrack = {
      ...track,
      params,
      sampleId: preset.sampleId !== undefined ? preset.sampleId : track.sampleId,
      presetId: preset.id,
    };

    let runtime: InstrumentRuntime;
    try {
      runtime = definition.factory(ctx, previewTrack, {
        bpm: doc?.bpm ?? 124,
        getSample: (id) => this.bank?.get(id),
      });
    } catch {
      return;
    }

    // The audition must represent the applied sound: the same preset
    // normalization the live chain gets scales the fixed headroom gain.
    const normGain = ctx.createGain();
    normGain.gain.value = dbToLinear(presetNormalizationGainDb(preset.id));
    runtime.output.connect(normGain);

    const gain = ctx.createGain();
    const when = ctx.currentTime + 0.01;
    const durationSec = previewNoteDuration(params);
    // Keep audition headroom independent from the track's current mixer gain.
    gain.gain.setValueAtTime(0.78, when);
    normGain.connect(gain).connect(master);
    const voice: InstrumentPreviewVoice = { runtime, gain, timer: null };
    this.instrumentPreviewVoices.add(voice);

    try {
      runtime.noteOn(60, 0.82, when, durationSec);
    } catch {
      this.disposeInstrumentPreviewVoice(voice);
      return;
    }

    // Give envelopes a short tail before disposing the temporary runtime.
    voice.timer = setTimeout(
      () => this.disposeInstrumentPreviewVoice(voice),
      previewCleanupDelayMs(params, durationSec),
    );
  }

  private disposeInstrumentPreviewVoice(voice: InstrumentPreviewVoice): void {
    if (voice.timer) clearTimeout(voice.timer);
    voice.timer = null;
    try {
      voice.runtime.panic();
    } catch {
      /* already stopped */
    }
    try {
      voice.runtime.dispose();
    } catch {
      /* already disposed */
    }
    try {
      voice.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    this.instrumentPreviewVoices.delete(voice);
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
    for (const voice of [...this.instrumentPreviewVoices]) this.disposeInstrumentPreviewVoice(voice);
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
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.start(ctx.currentTime + 0.005);
    source.onended = () => {
      this.previewVoices.delete(voice);
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
    // Track it as a preview voice: stopPreview()/panic() must be able to
    // cancel a bar-quantized start that has not fired yet — otherwise the
    // sample sounds after the user pressed Stop.
    const voice: PreviewVoice = { source, gain };
    this.previewVoices.add(voice);
    source.start(when);
    source.onended = () => {
      this.previewVoices.delete(voice);
      gain.disconnect();
      source.disconnect();
    };
  }

  /**
   * Current transport tick, supplied by the service layer (the engine does
   * not own the Transport). Used to quantize transport-synced previews to
   * the NEXT bar relative to the live playhead; falls back to 0 when unset.
   */
  getTransportTick: (() => number) | null = null;

  private transportTickNow(): number {
    try {
      const tick = this.getTransportTick?.() ?? 0;
      return Number.isFinite(tick) && tick >= 0 ? tick : 0;
    } catch {
      return 0;
    }
  }

  private choke(trackId: string, chokeGroup: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Defect 6.2 (lifecycle / leak audit): the previous implementation
    // iterated `this.voices` directly and called `this.voices.delete`
    // mid-loop. ECMAScript tolerates that today, but the code is one
    // future `continue` or thrown callback away from skipping or
    // leaking voices. Take a defensive snapshot — choke fires only
    // on the trigger path (not every tick), so the per-call cost is
    // bounded and worth the safety.
    // FL-style cut: the choke lands EXACTLY on the new hit's scheduled time
    // (`when` from the same tick→time map), not on `currentTime`. The
    // scheduler runs ~120 ms ahead, so cutting at `now` let the old hat ring
    // over the new one. Clamped to `now` for live/immediate hits.
    const cutAt = Number.isFinite(when) ? Math.max(when, ctx.currentTime) : ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.trackId !== trackId || voice.chokeGroup !== chokeGroup) continue;
      voice.gain.gain.cancelScheduledValues(cutAt);
      voice.gain.gain.setTargetAtTime(0, cutAt, 0.005);
      const stopAll = (voice as any)._stopAll as ((t: number) => void) | undefined;
      if (stopAll) {
        try {
          stopAll(cutAt + 0.02);
        } catch {
          /* already */
        }
      } else {
        try {
          voice.source.stop(cutAt + 0.02);
        } catch {
          // already stopped
        }
      }
      this.voices.delete(voice);
    }
  }

  /**
   * Hard-stop every tracked one-shot source (AudioClips, marker cues,
   * metronome clicks). Called from panic() — scheduling runs up to 120 ms
   * ahead, so seek/stop must reach these too, not just `voices`.
   */
  private stopOneShotSources(): void {
    for (const source of this.oneShotSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.oneShotSources.clear();
  }

  panic(): void {
    const ctx = this.ctx;
    if (!ctx) {
      // Even with no live context, internal voice / LFO / frozen-buffer
      // Maps must be cleared so the next play() does not dispatch into
      // stale state. A panic is a hard reset — "everything off, now".
      this.voices.clear();
      this.previewVoices.clear();
      this.stopOneShotSources();
      this.frozenBuffers.clear();
      this.frozenBufferIds.clear();
      this.frozenPlaying = false;
      this.frozenAlign = null;
      for (const state of [...this.lfos.values()]) disposeLfoRuntime(state);
      this.lfos.clear();
      for (const state of this.instruments.values()) {
        try {
          state.runtime.panic();
        } catch {
          /* already */
        }
      }
      return;
    }
    this.stopPreview();
    // AudioClips, warp segments, marker cues and metronome clicks are
    // scheduled up to a lookahead horizon ahead — a live-context panic
    // (pause/stop/seek) must hard-stop them too, or a multi-bar clip keeps
    // playing past Stop and old-position cues fire after a seek.
    this.stopOneShotSources();
    const now = ctx.currentTime;
    // Defect 6.1 (lifecycle / leak audit): dispose every LFO and
    // follower modulator BEFORE instrument.panic() so the modulation
    // path stops driving the (about-to-be-silenced) instrument
    // parameters. Without this, the user hears "wet FX keeps going"
    // for one or two buffer frames after a panic because the LFO
    // oscillator is still connected to its target AudioParam.
    for (const state of [...this.lfos.values()]) disposeLfoRuntime(state);
    this.lfos.clear();
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
    const doc = this.doc;
    if (!ctx || !doc || !targetParamDef(doc, target)) return;
    const clamped = clampTargetValue(doc, target, value);
    const now = ctx.currentTime;
    switch (target.kind) {
      case "trackGain": {
        const nodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
        const returnNodes = this.returnNodes.get(target.trackId);
        if (nodes) nodes.modMacroGain.gain.setTargetAtTime(clamped, now, 0.005);
        else if (returnNodes) returnNodes.modMacroGain.gain.setTargetAtTime(clamped, now, 0.005);
        break;
      }
      case "trackPan": {
        const nodes = this.trackNodes.get(target.trackId) ?? this.groupNodes.get(target.trackId);
        if (nodes) nodes.modMacroPan.pan.setTargetAtTime(clamped, now, 0.005);
        break;
      }
      case "fxParam": {
        this.writeDeviceTargetAt(target, clamped);
        break;
      }
      case "instParam": {
        this.writeDeviceTargetAt(target, clamped);
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
  /**
   * MPE timbre dimension (CC74). Convention mirrors polyPressure: per-note,
   * 0..1 bipolar with 0.5 = the note's base — instruments map it to their
   * brightness control (filter cutoff; FM scales INDEX). No-op for tracks
   * whose runtime does not implement it.
   */
  polyTimbre(trackId: string, pitch: number, timbre: number): void {
    const inst = this.instruments.get(trackId);
    if (!inst) return;
    inst.runtime.polyTimbre?.(pitch, timbre, this.ctx?.currentTime ?? 0);
  }

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

  private rawPeakOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  private peakOf(analyser: AnalyserNode | null): number {
    return Math.min(1, this.rawPeakOf(analyser));
  }

  getTrackLevel(trackId: string): number {
    return this.peakOf(this.trackNodes.get(trackId)?.analyser ?? null);
  }

  getReturnLevel(returnId: string): number {
    return this.peakOf(this.returnNodes.get(returnId)?.analyser ?? null);
  }

  /** One read for the mixer channel meter: level, peak readout and clip flag. */
  getTrackMeterSnapshot(trackId: string): TrackMeterSnapshot {
    const peak = this.rawPeakOf(this.trackNodes.get(trackId)?.analyser ?? null);
    return { level: Math.min(1, peak), peakDb: toDb(peak), clipping: peak >= 0.9995 };
  }

  getReturnMeterSnapshot(returnId: string): TrackMeterSnapshot {
    const peak = this.rawPeakOf(this.returnNodes.get(returnId)?.analyser ?? null);
    return { level: Math.min(1, peak), peakDb: toDb(peak), clipping: peak >= 0.9995 };
  }

  /** Post-limiter master tap for realtime recording ("bounce what you hear"). */
  getMasterTapNode(): AudioNode | null {
    return this.masterLimiter;
  }

  /** The real AudioContext for browser-only APIs (MediaRecorder, media streams). */
  getLiveAudioContext(): AudioContext | null {
    return isLiveAudioContext(this.ctx) ? this.ctx : null;
  }

  /** Post-FX tap for one track (the analyser branch carries the full track signal). */
  getTrackTapNode(trackId: string): AudioNode | null {
    return this.trackNodes.get(trackId)?.analyser ?? null;
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

  /**
   * Roadmap O7: load a user impulse response file into a convolution-capable
   * effect (Ozvena). Decodes via the engine context (decodeAudioData already
   * resamples to the context sample rate) and hands the AudioBuffer to the
   * runtime, which interleaves and posts it to the worklet.
   */
  async loadUserIrForFx(trackId: string, fxId: string, file: File): Promise<void> {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    if (!rt?.loadUserIr) throw new Error("This effect cannot load impulse responses");
    const ctx = this.ctx;
    if (!ctx) throw new Error("Audio engine is not started");
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    rt.loadUserIr(buffer);
  }

  /** Live meter snapshot from an effect runtime ( Ultina spectrum/LUFS/masking…). */
  getFxMeters(trackId: string, fxId: string): unknown {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    return rt?.getMeters?.() ?? null;
  }

  /**
   * Direct runtime access for plugin panels that need the full optional
   * surface (PRISM A/B morph slots, in-plugin undo/redo) beyond the generic
   * per-effect methods. Panels must treat every capability as optional —
   * fallback runtimes expose only the bypass basics.
   */
  getFxRuntime(trackId: string, fxId: string): EffectRuntime | null {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    return rt ?? null;
  }

  /**
   * Metering gate for analysis-heavy effects (Ultina): the panel enables it
   * on mount and disables on unmount, so closed panels cost zero audio-thread
   * analysis. The desired state is remembered and re-applied when chain
   * rebuilds recreate the runtime.
   */
  setFxMetersEnabled(trackId: string, fxId: string, enabled: boolean): void {
    this.fxMetersEnabled.set(fxId, enabled);
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    rt?.setMetersEnabled?.(enabled);
  }

  /**
   * Live parameter preview for an open plugin panel (drag): fire-and-forget
   * write straight to the device runtime, bypassing the document — the knob
   * is audible DURING the drag instead of only after pointer-up. The document
   * write still happens once on commit (syncFxParams then pushes the final
   * value), so the document stays authoritative between gestures.
   */
  previewFxParam(trackId: string, fxId: string, paramId: string, value: number): void {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    rt?.setParameter?.(paramId, value);
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
    this.meterHistoryL.reset();
    this.meterHistoryR.reset();
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
    this.meterHistoryL.push(this.masterChBufL);
    this.meterHistoryR.push(this.masterChBufR);
    const sampleRate = this.ctx?.sampleRate ?? 44100;
    // The ring's capacity is the worst-case ceiling; no manual trim.
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
    const window = (seconds: number): [Float32Array, Float32Array] => {
      // MeterRing.lastN already returns a fresh Float32Array in
      // chronological order — no slice + Float32Array.from copy.
      const length = Math.min(this.meterHistoryL.length, Math.max(1, Math.round(seconds * sampleRate)));
      return [this.meterHistoryL.lastN(length), this.meterHistoryR.lastN(length)];
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

/**
 * Compute a time-stretched AudioBuffer from source at the given rate.
 * Uses the grain-based `timeStretch` algorithm from time-stretch.ts.
 * The stretched buffer plays at rate=1 so pitch is preserved.
 */
function computeStretchedBuffer(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  stretchRate: number,
  reverse: boolean,
): AudioBuffer {
  const sr = source.sampleRate;
  const ch = source.numberOfChannels;
  const stretchFactor = Math.min(4, Math.max(0.25, stretchRate));
  // timeStretch changes duration by stretchFactor: >1 = longer (slower), <1 = shorter (faster)
  const outFrames = Math.max(1, Math.round(source.duration * stretchFactor * sr));
  const out = ctx.createBuffer(ch, outFrames, sr);
  for (let c = 0; c < ch; c++) {
    const src = source.getChannelData(c);
    const stretched = timeStretch(src, sr, stretchFactor);
    // timeStretch returns the input array itself on its fallback paths —
    // reversing it in place would corrupt the bank's shared source buffer.
    const channel = reverse ? (stretched === src ? stretched.slice() : stretched).reverse() : stretched;
    out.getChannelData(c).set(channel);
  }
  return out;
}

/**
 * One repitch-warp segment: play play-buffer seconds [bufStartSec, bufEndSec]
 * across clip-relative ticks [startTick, endTick] at constant `rate`.
 */
export interface WarpSegment {
  startTick: number;
  endTick: number;
  bufStartSec: number;
  bufEndSec: number;
  rate: number;
}

/** Realtime-safety cap: one trigger schedules at most this many sources. */
export const MAX_WARP_SEGMENTS = 64;

/**
 * Build a piecewise-constant-rate warp map from AudioClip warp markers.
 * Each marker pins a sample time (sec, original-sample timeline) to an
 * arrangement tick; the full trimmed content is mapped across the full clip
 * (start pin + end pin are forced), linearly interpolated between pins —
 * FL/Slicex-style repitch warp (pitch follows time, no phase vocoder).
 *
 * Returns null when warp cannot/should not apply (no in-range markers,
 * degenerate geometry) — callers fall back to the legacy single source.
 * Pure and deterministic: live playback and offline render share it.
 */
export function buildWarpSegments(opts: {
  markers: ReadonlyArray<{ timeSec: number; tick: number }>;
  clipStartTick: number;
  clipTicks: number;
  /** Wall seconds per tick (average across the clip). */
  spt: number;
  /** Play-buffer window (secs): trimmed content start + full trimmed length. */
  contentStartSec: number;
  contentDurSec: number;
}): WarpSegment[] | null {
  const { markers, clipStartTick, clipTicks, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;
  const contentEnd = contentStartSec + contentDurSec;
  // Keep only finite markers inside the clip; buffer times clamp into content.
  const pins: { rel: number; buf: number }[] = [{ rel: 0, buf: contentStartSec }];
  let inRange = 0;
  for (const m of markers) {
    if (!Number.isFinite(m.timeSec) || !Number.isFinite(m.tick)) continue;
    const rel = m.tick - clipStartTick;
    if (rel < 0 || rel > clipTicks) continue;
    inRange++;
    pins.push({ rel, buf: Math.min(contentEnd, Math.max(contentStartSec, m.timeSec)) });
  }
  // No usable marker — legacy straight playback (which may cap/silence the
  // tail instead of re-fitting the content; that stays opt-in via warp).
  if (inRange === 0) return null;
  pins.push({ rel: clipTicks, buf: contentEnd });
  // Stable sort by tick; duplicate ticks keep the LAST pin (explicit edit wins).
  const order = pins.map((_, i) => i);
  order.sort((a, b) => pins[a].rel - pins[b].rel);
  const deduped: typeof pins = [];
  for (const i of order) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.rel - pins[i].rel) < 1e-9) deduped[deduped.length - 1] = pins[i];
    else deduped.push(pins[i]);
  }
  // Defensive truncation (sanitize allows 256 markers): first N pins + end.
  let pts = deduped;
  if (pts.length > MAX_WARP_SEGMENTS + 1) {
    pts = [...pts.slice(0, MAX_WARP_SEGMENTS), pts[pts.length - 1]];
  }
  const segs: WarpSegment[] = [];
  for (let i = 0; i + 1 < pts.length && segs.length < MAX_WARP_SEGMENTS; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dTick = b.rel - a.rel;
    const dBuf = b.buf - a.buf;
    // Degenerate: zero time span or frozen/reversed buffer direction —
    // BufferSource cannot hold or play backwards in a forward warp.
    if (dTick <= 1e-9 || dBuf <= 0.0005) continue;
    const rate = dBuf / (dTick * spt);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    segs.push({ startTick: a.rel, endTick: b.rel, bufStartSec: a.buf, bufEndSec: b.buf, rate });
  }
  return segs.length > 0 ? segs : null;
}

/**
 * Buffer time (sec, original-sample timeline) playing at an arrangement tick
 * under the current warp map — the neutral value for a NEW pin at that tick
 * (inserting it leaves the sound unchanged; dragging it bends time).
 *
 * With no usable markers it falls back to the straight-playback position,
 * which is mode-aware: resample consumes the source at `rate` per wall
 * second, stretch-mode straight plays a pre-stretched buffer, i.e. the
 * original advances at 1/`rate` per wall second.
 *
 * Returns null when the tick is outside the clip or geometry is degenerate.
 * Pure — shared by the waveform pin editor and the tests.
 */
export function warpBufferTimeAtTick(opts: {
  markers: ReadonlyArray<{ timeSec: number; tick: number }>;
  clipStartTick: number;
  clipTicks: number;
  /** Arrangement tick to query (absolute). */
  tick: number;
  /** Wall seconds per tick. */
  spt: number;
  /** Trimmed content window (secs, original-sample timeline). */
  contentStartSec: number;
  contentDurSec: number;
  stretchRate?: number;
  stretchMode?: "resample" | "stretch";
}): number | null {
  const { markers, clipStartTick, clipTicks, tick, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;
  const rel = tick - clipStartTick;
  if (!(rel >= 0) || !(rel <= clipTicks)) return null;
  const contentEnd = contentStartSec + contentDurSec;
  const clampBuf = (v: number): number => Math.min(contentEnd, Math.max(contentStartSec, v));
  const pins: { rel: number; buf: number }[] = [{ rel: 0, buf: contentStartSec }];
  let inRange = 0;
  for (const m of markers) {
    if (!Number.isFinite(m.timeSec) || !Number.isFinite(m.tick)) continue;
    const r = m.tick - clipStartTick;
    if (r < 0 || r > clipTicks) continue;
    inRange++;
    pins.push({ rel: r, buf: clampBuf(m.timeSec) });
  }
  pins.push({ rel: clipTicks, buf: contentEnd });
  pins.sort((a, b) => a.rel - b.rel);
  if (inRange === 0) {
    const rate = Math.min(4, Math.max(0.25, opts.stretchRate ?? 1));
    const straight =
      opts.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01
        ? contentStartSec + (rel * spt) / rate
        : contentStartSec + rel * spt * rate;
    return clampBuf(straight);
  }
  for (let i = 0; i + 1 < pins.length; i++) {
    const a = pins[i];
    const b = pins[i + 1];
    if (rel >= a.rel && rel <= b.rel) {
      const span = b.rel - a.rel;
      if (span <= 1e-9) return clampBuf(a.buf);
      const t = (rel - a.rel) / span;
      return clampBuf(a.buf + (b.buf - a.buf) * t);
    }
  }
  return clampBuf(contentEnd);
}

/** Default micro-crossfade at repitch-warp segment joints (de-click only). */
export const WARP_MICRO_FADE_SEC = 0.003;

/**
 * One repitch-warp segment's exact playback envelope: where its source
 * starts/stops (wall + buffer offsets, both relative to the clip start) and
 * the micro-fade automation on its private gain. Interior joints overlap:
 * the outgoing voice rings `o` past the boundary while the incoming voice
 * started `o` early — a 3 ms crossfade that kills boundary clicks without
 * moving any boundary in time. Edge fades (clip start/end) are capped at
 * half the segment so a sub-6 ms segment never folds its ramps over.
 */
export interface WarpSegmentRender {
  /** Wall offset (sec) from the clip `when` to start the source. */
  startOffsetSec: number;
  /** Buffer offset (sec) to start reading. */
  bufOffsetSec: number;
  /** Wall seconds to keep the source playing (stop = when + start + play). */
  playDurSec: number;
  /** Fade-in on the private gain (sec, relative to the clip start). */
  fadeInAt: number;
  fadeInDur: number;
  /** Fade-out on the private gain (sec, relative to the clip start). */
  fadeOutAt: number;
  fadeOutDur: number;
}

/**
 * Expand warp segments into click-free render plans. Pure — shared by the
 * live trigger and the offline render (both go through `triggerAudioClip`).
 */
export function warpSegmentRenders(
  segs: ReadonlyArray<WarpSegment>,
  opts: {
    clipTicks: number;
    clipDurSec: number;
    contentStartSec: number;
    contentDurSec: number;
    fadeSec?: number;
  },
): WarpSegmentRender[] {
  const { clipTicks, clipDurSec, contentStartSec, contentDurSec } = opts;
  const fade = Math.max(0, opts.fadeSec ?? WARP_MICRO_FADE_SEC);
  if (segs.length === 0 || !(clipTicks > 0) || !(clipDurSec > 0)) return [];
  const contentEnd = contentStartSec + contentDurSec;
  const wallAt = (tick: number): number => (tick / clipTicks) * clipDurSec;
  return segs.map((s, i) => {
    const wallStart = wallAt(s.startTick);
    const wallEnd = wallAt(s.endTick);
    const segWall = Math.max(0, wallEnd - wallStart);
    // Overlap with the previous joint: limited by the fade and by readable
    // content on both sides of the shared buffer break.
    let overlapIn = 0;
    if (i > 0 && fade > 0 && s.rate > 0) {
      const prev = segs[i - 1];
      overlapIn = Math.min(
        fade,
        (s.bufStartSec - contentStartSec) / s.rate,
        (contentEnd - prev.bufEndSec) / Math.max(1e-6, prev.rate),
      );
      if (!Number.isFinite(overlapIn) || overlapIn < 0.0005) overlapIn = 0;
    }
    // Overlap past the next joint (symmetric readability check).
    let overlapOut = 0;
    if (i + 1 < segs.length && fade > 0 && s.rate > 0) {
      const next = segs[i + 1];
      overlapOut = Math.min(
        fade,
        (contentEnd - s.bufEndSec) / s.rate,
        (next.bufStartSec - contentStartSec) / Math.max(1e-6, next.rate),
      );
      if (!Number.isFinite(overlapOut) || overlapOut < 0.0005) overlapOut = 0;
    }
    const startOffsetSec = wallStart - overlapIn;
    const bufOffsetSec = s.bufStartSec - overlapIn * s.rate;
    const playDurSec = Math.max(0.005, wallEnd + overlapOut - startOffsetSec);
    // Edge fades cap at half the segment; interior joints use the overlap.
    const edgeFade = Math.min(fade, segWall / 2);
    const fadeInAt = startOffsetSec;
    const fadeInDur = i > 0 ? overlapIn : edgeFade;
    const fadeOutAt = i + 1 < segs.length ? wallEnd : wallEnd - edgeFade;
    const fadeOutDur = i + 1 < segs.length ? overlapOut : edgeFade;
    return { startOffsetSec, bufOffsetSec, playDurSec, fadeInAt, fadeInDur, fadeOutAt, fadeOutDur };
  });
}

/**
 * Resolve an AudioClip's playback window inside the (possibly stretched)
 * play buffer. `offsetSec`/`trimStart`/`trimEnd` are seconds in the ORIGINAL
 * sample; `timeScale` converts them into the play buffer's timeline (1 for
 * resample mode, the stretch rate for pre-stretched buffers). Pure — shared
 * reasoning for live playback and offline render.
 *
 * `contentDur` is the full trimmed content length (before capping to the
 * requested clip length) — the loop region for `clip.loop` texture beds.
 */
export function audioClipPlayWindow(
  clip: import("../project-model/types").AudioClip,
  playBufferDurationSec: number,
  requestedDurationSec: number,
  timeScale: number,
): { duration: number; playOffset: number; contentDur: number } {
  const offset = Math.max(0, ((clip.offsetSec ?? 0) + (clip.trimStart ?? 0)) * timeScale);
  const trimEnd = Math.max(0, (clip.trimEnd ?? 0) * timeScale);
  const maxDur = Math.max(0.01, playBufferDurationSec - offset - trimEnd);
  const duration = Math.min(requestedDurationSec, maxDur);
  const playOffset = clip.reverse ? Math.max(0, playBufferDurationSec - offset - duration) : offset;
  return { duration, playOffset, contentDur: maxDur };
}
