import type {
  AutomationTarget,
  DrumPad,
  EffectInstance,
  InstrumentTrack,
  ProjectDocument,
  SampleLayer,
  SceneAutomation,
} from "../project-model/types";
import type { AutomationPoint } from "../project-model/types";
import { MAX_AUDIO_CLIP_WARP_SEGMENTS, resolveWarpPinPoints } from "../project-model/audio-clip-warp";
export { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { hashString } from "../shared/rng";
import { PPQ, BAR_TICKS } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import type { EffectRuntime } from "../effects/types";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { dbToLinear, presetNormalizationGainDb } from "../presets/normalization";
import type { InstrumentRuntime } from "../instruments/types";
import type { InstrumentPreset } from "../presets/types";
import {
  ensureWorkletsForDoc,
  isWorkletReady,
  loadCoreWorklets,
  loadPluginWorklet,
  PLUGIN_WORKLET_TYPES,
  type PluginWorkletType,
} from "../audio-worklets/loader";
import { connectAudioClipSourceChannel } from "./audioClipChannels";
import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "./phase-vocoder";
import { renderWarpPreserveAsync } from "../audio-workers/warp-render-client";
import { MeteringRig, measureTruePeak as measureTruePeakImpl } from "./meteringRig";
import { PreviewDeck } from "./previewDeck";
import { AutomationBridge } from "./automationBridge";
import type { TrackOrGroupView, ReturnView } from "./deviceLookup";
import { targetOwner } from "../project-model/targets";
import { timeStretch } from "./time-stretch";
import { DeviceLookup } from "./deviceLookup";
import { DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback } from "./declick";
import { MasterChain } from "./masterChain";
import type { MasterStage } from "./masterChain";
import { isLiveAudioContext } from "./liveContext";
import type { MasterMeterSnapshot, TrackMeterSnapshot } from "./metering-types";
import type { Frame, ChannelLevels } from "./metering";

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

export type EffectIntentPreviewEndReason = "manual" | "projectChanged" | "transportStarted" | "restoreFailed";

interface EffectIntentPreviewSession {
  trackId: string;
  fxId: string;
  effectType: EffectInstance["type"];
  paramIds: string[];
  onEnded?: (reason: EffectIntentPreviewEndReason) => void;
}

interface TrackNodes {
  input: GainNode;
  panner: StereoPannerNode;
  gain: GainNode;
  modAutoGain: GainNode;
  modAutoPan: StereoPannerNode;
  modMacroGain: GainNode;
  modMacroPan: StereoPannerNode;
  /** Exact downstream owner for the track output (master or one group input). */
  routeDestination: AudioNode;
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

interface Voice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  trackId: string;
  chokeGroup: number | null;
  filter?: BiquadFilterNode;
  /** Per-pad mod nodes (LFO osc + depth gain) — disconnected with the voice. */
  extras?: AudioNode[];
}

export type { TrackMeterSnapshot, MasterMeterSnapshot } from "./metering-types";
export { DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback } from "./declick";
export { expandSceneLaneWindow } from "./automationBridge";
export type { ResolvedSlicePlayback } from "./declick";

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

/** Shared master-metering readout (true peak, BS.1770 loudness, GR). */

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;

  /**
   * Wave 4a (decomposition): metering/analysis owner — meters, peak hold,
   * LUFS history and the registered master taps. Creation of the tap nodes
   * stays in MasterChain.build(); this rig owns storage, reads and teardown.
   */
  private metering = new MeteringRig({
    ctx: () => this.ctx,
    trackAnalyser: (id) => this.trackNodes.get(id)?.analyser ?? null,
    groupAnalyser: (id) => this.groupNodes.get(id)?.analyser ?? null,
    returnAnalyser: (id) => this.returnNodes.get(id)?.analyser ?? null,
    masterStage: (): MasterStage => this.masterChain.stage,
  });
  /**
   * Wave 4c (decomposition): audition deck owner — pad/preset/slice/asset/
   * buffer/synced previews and their voice sets. Graph-param previews
   * (faders, FX intent) stay here; they write engine-owned nodes.
   */
  private previewDeck = new PreviewDeck({
    ctx: () => this.ctx,
    doc: () => this.doc,
    bank: () => this.bank,
    masterInput: () => this.masterChain.input,
    ensureContext: () => this.ensureContext(),
    currentTime: () => this.currentTime,
    transportTickNow: () => this.transportTickNow(),
    trigger: (trackId, pad, when, velocity) => this.trigger(trackId, pad, when, velocity),
    noteOn: (trackId, pitch, velocity, when, durationSec) => this.noteOn(trackId, pitch, velocity, when, durationSec),
    missAsset: (assetId) => this.missedAssets.add(assetId),
  });
  /**
   * Wave 4b (decomposition): master output chain owner — input gain, tape,
   * M/S, bass-mono, DC, match EQ, tilt, glue, clipper, limiter and their
   * config/upgrade paths. The graph sink is `masterChain.input` (formerly
   * the engine's `master` field). See masterChain.ts + the plan doc.
   */
  private masterChain = new MasterChain({
    ctx: () => this.ctx,
    doc: () => this.doc,
    metering: this.metering,
  });
  private liveContextListeners = new Set<(context: AudioContext | null) => void>();
  private bank: SampleBank | null = null;
  private doc: ProjectDocument | null = null;
  private effectIntentPreview: EffectIntentPreviewSession | null = null;
  private synthNoise: AudioBuffer | null = null;
  /**
   * Serializes back-to-back `setProject()` calls so a worklet-load driven
   * continuation from the prior doc can't mutate the new doc's runtime
   * graph (the previous bug: `queueWorkletRefresh` -> `loadCoreWorklets().then`
   * -> `queueFxRebuild` ran `syncProject(this.doc)` after `this.doc` had
   * already been replaced by a re-entrant `setProject`, so doc A's effect
   * IDs were applied to doc B's graph). The IIFE wrapping `setProject`'s
   * body resolves to `void`; the queue drains FIFO once the in-flight
   * body settles. Re-entrant calls coalesce — only the latest pending doc
   * matters, since older queued docs are already superseded by the most
   * recent push.
   */
  private projectPromise: Promise<void> | null = null;
  private projectQueue: ProjectDocument[] = [];

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
  /** External realtime sources owned by a provider runtime, keyed by track. */
  private generativeSources = new Map<string, AudioNode>();
  private connectedGenerativeSources = new Set<string>();
  private returnNodes = new Map<string, ReturnNodes>();
  private groupNodes = new Map<string, GroupNodes>();
  /** Desired metering state per fx id (panel attached → on). Re-applied when a
   * chain rebuild recreates runtimes so the panel never has to re-register. */
  private fxMetersEnabled = new Map<string, boolean>();
  private instruments = new Map<string, InstrumentState>();

  /**
   * Wave 4d step 1 (decomposition): shared device-target resolvers — the
   * AudioParam lookup, effect/instrument runtime lookup, base-value read
   * and the single clamped device write path. Consumed by the automation
   * bridge AND by graph sync through these same seams.
   */
  private deviceLookup = new DeviceLookup({
    doc: () => this.doc,
    trackNodes: (id) => this.trackNodes.get(id),
    groupNodes: (id) => this.groupNodes.get(id),
    returnNodes: (id) => this.returnNodes.get(id),
    instrumentStates: () => this.instruments,
  });
  /**
   * Wave 4d step 2 (decomposition): modulation + automation write layer —
   * LFO runtime buses, macro/intensity composer, schedulable modulators,
   * scene lanes, automation writers, stop takeover, MIDI-CC writes.
   */
  private automation = new AutomationBridge(
    {
      ctx: () => this.ctx,
      doc: () => this.doc,
      currentTime: () => this.currentTime,
      // Contained covariance cast: Map is invariant, the bridge only reads.
      trackNodes: this.trackNodes as unknown as Map<string, TrackOrGroupView>,
      groupNodes: this.groupNodes as unknown as Map<string, TrackOrGroupView>,
      returnNodes: this.returnNodes as unknown as Map<string, ReturnView>,
    },
    this.deviceLookup,
  );
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
  private voices = new Set<Voice>();
  /**
   * One-shot scheduled sources (AudioClips, marker cues, metronome clicks).
   * These are committed up to the 120 ms horizon ahead and are NOT part of
   * `voices`, so panic() previously left them playing — a stopped transport
   * kept sounding a multi-bar AudioClip, and seek/stop fired stale marker
   * cues. Bounded: each source removes itself on `onended`.
   */
  private oneShotSources = new Set<AudioScheduledSourceNode>();
  private missedAssets = new Set<string>();
  /** Project id the stretchCache entries were computed for. */
  private stretchProjectId: string | null = null;
  private syncedBpm = 0;
  /** Active scene BPM override (song mode) — null = runtimes follow doc.bpm. */
  private sceneBpmOverride: number | null = null;

  private bankUnsubscribe: (() => void) | null = null;

  attachBank(bank: SampleBank): void {
    this.bank = bank;
    // Reload race (GOAL 06): worklet-backed instrument runtimes (granular /
    // wavetable voices) bake their sample into the processor at construction,
    // and syncInstrument's diff only fires on a sampleId CHANGE — a sample
    // that lands in the bank AFTER construction (the fire-and-forget boot
    // restore) never reaches them, leaving the track silent (granular) or on
    // the wrong table (wavetable) until the user re-picks the sample. Re-push
    // the id to every instrument waiting on it. Main-thread runtimes re-read
    // the bank per note anyway, so the extra setSample is harmless there.
    this.bankUnsubscribe?.();
    this.bankUnsubscribe = bank.onSampleAdded((id) => {
      for (const state of this.instruments.values()) {
        if (state.sampleId === id) state.runtime.setSample?.(id);
      }
    });
  }

  /**
   * Release the sample-added subscription taken by attachBank. Offline
   * engines (renderer) MUST call this when done — the bank outlives them,
   * and an unconsumed closure would retain every discarded render engine.
   */
  detachBank(): void {
    this.bankUnsubscribe?.();
    this.bankUnsubscribe = null;
  }

  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /** Subscribe to live AudioContext creation, replacement and loss. */
  subscribeLiveContext(listener: (context: AudioContext | null) => void): () => void {
    this.liveContextListeners.add(listener);
    try {
      listener(this.getLiveAudioContext());
    } catch {
      /* observers cannot break engine initialization */
    }
    return () => this.liveContextListeners.delete(listener);
  }

  private notifyLiveContextChange(): void {
    const context = this.getLiveAudioContext();
    for (const listener of [...this.liveContextListeners]) {
      try {
        listener(context);
      } catch {
        /* observers cannot break context creation or recovery */
      }
    }
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Route a provider-owned realtime source through the normal track graph.
   * The engine owns only the connection edge; the caller still owns the
   * source node and must dispose it after detaching.
   */
  attachGenerativeSource(trackId: string, source: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || source.context !== ctx) return;
    const previous = this.generativeSources.get(trackId);
    if (previous && previous !== source) {
      const nodes = this.trackNodes.get(trackId);
      try {
        if (nodes) previous.disconnect(nodes.input);
        else previous.disconnect();
      } catch {
        /* previous edge may already be disconnected */
      }
      this.connectedGenerativeSources.delete(trackId);
    }
    this.generativeSources.set(trackId, source);
    const track = this.doc?.tracks.find((candidate) => candidate.id === trackId);
    const nodes = this.trackNodes.get(trackId);
    if (!nodes || track?.kind !== "generative" || track.frozen) return;
    if (this.connectedGenerativeSources.has(trackId)) return;
    try {
      source.connect(nodes.input);
      this.connectedGenerativeSources.add(trackId);
    } catch {
      /* A provider can race a context swap; the next attach retries. */
    }
  }

  /** Detach a provider source without taking ownership of its AudioNode. */
  detachGenerativeSource(trackId: string, source?: AudioNode): void {
    const current = this.generativeSources.get(trackId);
    if (!current || (source && current !== source)) return;
    const nodes = this.trackNodes.get(trackId);
    try {
      if (nodes) current.disconnect(nodes.input);
      else current.disconnect();
    } catch {
      /* edge may already be gone */
    }
    this.connectedGenerativeSources.delete(trackId);
    this.generativeSources.delete(trackId);
  }

  /**
   * Route a dry software input monitor through the armed track's mixer path.
   * Connecting after track FX avoids adding their latency while preserving
   * track pan/level, mute/solo, group and master routing. The caller owns the
   * source and must invoke the returned detach function when monitoring ends.
   */
  attachDryInputMonitor(trackId: string, source: AudioNode): (() => void) | null {
    const ctx = this.ctx;
    const track = this.doc?.tracks.find((candidate) => candidate.id === trackId);
    const nodes = this.trackNodes.get(trackId);
    if (
      !ctx ||
      !isLiveAudioContext(ctx) ||
      source.context !== ctx ||
      !track ||
      track.kind === "group" ||
      track.frozen ||
      !nodes
    ) {
      return null;
    }

    try {
      source.connect(nodes.panner);
    } catch {
      return null;
    }

    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      try {
        source.disconnect(nodes.panner);
      } catch {
        /* The graph may already have been disposed during a project/context change. */
      }
    };
  }

  private setGenerativeSourceConnection(trackId: string, nodes: TrackNodes, connected: boolean): void {
    const source = this.generativeSources.get(trackId);
    if (!source || source.context !== this.ctx) {
      this.generativeSources.delete(trackId);
      this.connectedGenerativeSources.delete(trackId);
      return;
    }
    if (connected) {
      if (this.connectedGenerativeSources.has(trackId)) return;
      try {
        source.connect(nodes.input);
        this.connectedGenerativeSources.add(trackId);
      } catch {
        /* provider/context race; a later sync can retry */
      }
      return;
    }
    if (!this.connectedGenerativeSources.has(trackId)) return;
    try {
      source.disconnect(nodes.input);
    } catch {
      /* edge may already be gone */
    }
    this.connectedGenerativeSources.delete(trackId);
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  get missingAssets(): string[] {
    return [...this.missedAssets];
  }

  /**
   * Route offline-rendered track output around the fixed master chain.
   * Disabled user master processors are still not a transparent identity:
   * the always-on DC blocker alters phase, so a rendered clip would be
   * filtered once while consolidating and again when played in the project.
   */
  /** Route offline-rendered track output around the fixed master chain. */
  bypassMasterChainForOfflineRender(): void {
    this.masterChain.bypassForOfflineRender();
  }

  useContext(ctx: BaseAudioContext): void {
    this.cancelEffectIntentPreview(this.doc ?? undefined, "manual");
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
    this.automation.disposeLfos();
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
    // Audition voices belong to the PreviewDeck (Wave 4c) — hard-dispose
    // with the context swap (no de-click tail on a dying graph).
    this.previewDeck.disposeAll();
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
    this.automation.clearMacroCache();
    this.syncedBpm = 0;
    // Warp buffers/stretches hold context-era AudioBuffers AND rate-dependent
    // pre-renders: after a device change (44.1 → 48 kHz) a stale entry would
    // play off-pitch. setProject clears these too — but a bare context swap
    // (contextlost recovery) never runs setProject.
    this.warpCache.clear();
    this.warpInflight.clear();
    this.warpEpoch++;
    this.ctx = ctx;
    this.masterChain.build();
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
    // GOAL 04 (browser-audio lifecycle): iOS Safari / mobile Chrome can fire
    // `contextlost` when an audio session is interrupted (call, Siri, route
    // change). Without a handler the engine keeps a reference to the dead
    // context and every subsequent context-creation helper either recurses
    // on the same broken handle or no-ops until the user reloads. With the
    // handler:
    //   - contextlost: clear `this.ctx` so the next context-creation helper
    //     rebuilds against a fresh AudioContext.
    //   - contextrestored: rebuild the graph against the SAME restored
    //     context (no new AudioContext needed — the browser kept it alive).
    // `preventDefault()` on contextlost is required for contextrestored to
    // fire. Feature-detect with `typeof ... !== "undefined"` — the property
    // is missing entirely on Safari < 16.4 and Firefox.
    // oncontextlost / oncontextrestored are newer APIs (Chrome 108+,
    // Safari 16.4+, Firefox TBD) missing from the lib.dom AudioContext
    // type. Declare a local typed alias that mirrors the runtime shape
    // so the `typeof` feature-detect and the assignment both type-check.
    const ext = ctx as unknown as {
      oncontextlost: ((event: Event) => void) | null;
      oncontextrestored: ((event: Event) => void) | null;
    };
    if (typeof ext.oncontextlost !== "undefined") {
      ext.oncontextlost = (event: Event) => {
        event.preventDefault();
        if (this.ctx !== ctx) return;
        // Drop the handle; the next context-creation helper detects state
        // === "closed" and constructs a fresh context.
        this.ctx = null;
        this.notifyLiveContextChange();
      };
    }
    if (typeof ext.oncontextrestored !== "undefined") {
      ext.oncontextrestored = () => {
        if (this.ctx !== ctx) return;
        // The browser kept the SAME context alive (see preventDefault above) —
        // rebuild the engine's graph against the restored handle rather than
        // allocating a new AudioContext.
        this.useContext(ctx);
      };
    }
    this.notifyLiveContextChange();
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
   * Set by prepareOfflineRender(): syncPdc() writes sample-exact
   * setValueAtTime instead of the live glide.
   */
  private offlineExactPdc = false;

  /**
   * Set by prepareOfflineRender() AFTER the final exact sizing pass:
   * syncPdc() early-returns so a straggler latency report can never mutate
   * an OfflineAudioContext mid-render.
   */
  private offlineRenderLocked = false;

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
        this.masterChain.upgradeMasterDynamics();
        this.masterChain.upgradeKwMeter();
      })
      .catch((err) => {
        if (this.workletRefreshQueuedFor === ctx) this.workletRefreshQueuedFor = null;
        // Fire-and-forget is deliberate, but a mid-syncProject throw leaves
        // chains half-built — that must at least be observable in the
        // console instead of silently degrading the graph.
        console.error("[audio-engine] deferred FX rebuild failed:", err);
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

  setProject(doc: ProjectDocument): void {
    // `this.doc = doc` MUST be synchronous — the offline renderer and the
    // surrounding UI read `engine.doc` immediately after this returns, so
    // the new project's metadata is visible before the rest of the body
    // runs. The remaining work (preview cancel, cache reset, graph sync)
    // is deferred through `projectPromise` so a re-entrant call with a
    // different doc can't interleave its body with this one.
    this.doc = doc;
    if (this.projectPromise) {
      // Coalesce re-entrant calls — only the latest pending doc matters.
      // Older queued docs are superseded by this most-recent push, so
      // drop them: applying their bodies against the current graph would
      // only fight the build for the doc we're actually settling on.
      this.projectQueue = [doc];
      return;
    }
    const runBody = async (target: ProjectDocument): Promise<void> => {
      this.cancelEffectIntentPreview(target, "projectChanged");
      this.metering.syncProjectId(target.id);
      if (this.stretchProjectId !== target.id) {
        this.stretchProjectId = target.id;
        this.clearStretchCache();
        this.clearWarpCache();
        this.warpEpoch++;
        // Missing-asset ids belong to the project that missed them — the
        // engine outlives projects, so stale ids would accumulate forever and
        // pollute the diagnostics panel of the newly opened project.
        this.missedAssets.clear();
      }
      if (this.ctx) this.syncProject(target);
    };
    this.projectPromise = (async () => {
      try {
        await runBody(doc);
        // Drain any re-entrant calls that arrived while the body was
        // settling. Each push replaces older queued entries, so the
        // loop exits as soon as no further calls land during the drain.
        while (this.projectQueue.length > 0) {
          const next = this.projectQueue.shift()!;
          await runBody(next);
        }
      } catch (err) {
        // The queue is the hottest path in the app (every doc change): a
        // thrown body (e.g. an effect factory on a hostile doc) must land in
        // the console, never as an unhandled rejection. The graph may be
        // half-synced — the next setProject re-syncs (queueFxRebuild guards
        // the same hazard on its own path).
        console.error("[audio-engine] setProject body failed:", err);
      } finally {
        this.projectPromise = null;
      }
    })();
  }

  transportStarted(time: number, beatPhase: number, positionBeats = beatPhase): void {
    this.cancelEffectIntentPreview(this.doc ?? undefined, "transportStarted");
    // Groups and returns carry tempo-synced / phase-locked FX too (Pump,
    // Step Gate, SYNC delays) — skipping them left bus effects out of phase
    // with the transport for the whole play.
    for (const nodes of [...this.trackNodes.values(), ...this.groupNodes.values(), ...this.returnNodes.values()]) {
      for (const rt of nodes.fx.runtimes.values()) {
        rt.onTransportStarted?.(time, beatPhase, positionBeats);
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
      const rawRuntime = def.factory(ctx, fx, { bpm, seed });
      const trimGain = ctx.createGain();
      trimGain.gain.value = dbToLinear(fx.outputTrimDb ?? 0);
      rawRuntime.output.connect(trimGain);
      let trimDisposed = false;
      const rt = new Proxy(rawRuntime, {
        get(target, property, receiver) {
          if (property === "output") return trimGain;
          if (property === "setOutputTrimDb") {
            return (gainDb: number) => {
              const safe = Number.isFinite(gainDb) ? Math.max(-18, Math.min(12, gainDb)) : 0;
              trimGain.gain.setTargetAtTime(dbToLinear(safe), ctx.currentTime, 0.015);
            };
          }
          if (property === "dispose") {
            return () => {
              if (trimDisposed) return;
              trimDisposed = true;
              try {
                target.dispose();
              } finally {
                trimGain.disconnect();
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as EffectRuntime;
      const positionTick = this.transportTickNow();
      const beatPhase = (((positionTick % PPQ) + PPQ) % PPQ) / PPQ;
      rt.onTransportStarted?.(ctx.currentTime, beatPhase, positionTick / PPQ);
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
      state.params.set(fx.id, { ...fx.params, __outputTrimDb: fx.outputTrimDb ?? 0 });
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
        // Quality backlog B3: only re-materialize the cached params object
        // when something actually changed — a fresh {...spread} per FX per
        // sync was pure churn on the unchanged 95 %.
        let paramsChanged = false;
        for (const [k, v] of Object.entries(fx.params)) {
          if (cached[k] !== v) {
            rt.setParameter(k, v);
            paramsChanged = true;
          }
        }
        const outputTrimDb = fx.outputTrimDb ?? 0;
        if (cached.__outputTrimDb !== outputTrimDb) {
          rt.setOutputTrimDb?.(outputTrimDb);
          paramsChanged = true;
        }
        // Step-envelope sync (beatMangler): the runtime reference-compares
        // and ignores identical arrays, so untouched envelopes never
        // re-upload to the audio thread.
        rt.setSteps?.(fx.volumeSteps, fx.pitchSteps);
        if (paramsChanged) state.params.set(fx.id, { ...fx.params, __outputTrimDb: outputTrimDb });
      } finally {
        rt.endParamSync?.();
      }
    }
  }

  /**
   * Resolve sidechains only after every group and track node exists. A source
   * is allowed to appear later in document order, so wiring it during the
   * target chain's construction is not sufficient.
   */
  private syncFxSidechains(doc: ProjectDocument): void {
    // Returns hold sidechain-capable FX too; skipping them left a return's
    // detector feed null whenever its chain was built before the source
    // track existed (fxSignature unchanged → no rebuild to rewire it).
    for (const owner of [...doc.tracks, ...doc.returns]) {
      const ownerNodes =
        owner.kind === "group"
          ? this.groupNodes.get(owner.id)
          : (this.trackNodes.get(owner.id) ?? this.returnNodes.get(owner.id));
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
    // A frozen track's looping buffer source must die with its channel —
    // only the unfreeze/panic paths touch it otherwise, so deleting a
    // frozen track used to leave the source running (and pinned in memory)
    // inside frozenBuffers until the next project switch.
    this.disposeFrozenSource(id);
    this.setGenerativeSourceConnection(id, nodes, false);
    this.generativeSources.delete(id);
    this.connectedGenerativeSources.delete(id);
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
    if (!ctx || !this.masterChain.input) return;

    this.masterChain.applyMasterConfig(doc.master);

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
        analyser.connect(this.masterChain.input);
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
        modMacroPan.connect(this.masterChain.input);
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
        modMacroPan.connect(this.masterChain.input);
        modMacroPan.connect(analyser);
        nodes = {
          input,
          panner,
          gain,
          modAutoGain,
          modAutoPan,
          modMacroGain,
          modMacroPan,
          routeDestination: this.masterChain.input,
          analyser,
          fx: { runtimes: new Map(), params: new Map(), signature: null, pdcDelay: null, latencySubs: [] },
          sends: new Map(),
          sendDelays: new Map(),
        };
        this.trackNodes.set(track.id, nodes);
      }

      // A live provider source enters at the same point as an instrument and
      // therefore receives the track FX, gain/pan, sends and group routing.
      // Frozen tracks retain the provider handle but disconnect it while the
      // baked buffer owns the audible path.
      if (track.kind === "generative") {
        this.setGenerativeSourceConnection(track.id, nodes, !track.frozen);
      } else {
        this.detachGenerativeSource(track.id);
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

    // Route child tracks through their group instead of master. Keep exact
    // edge ownership per track so moving a track (or deleting its old group)
    // can always disconnect the prior destination, even after that group has
    // already left groupNodes. Unchanged routes are left untouched.
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      const nodes = this.trackNodes.get(track.id);
      if (!nodes) continue;
      const nextDestination =
        (track.groupId ? this.groupNodes.get(track.groupId)?.input : null) ?? this.masterChain.input;
      if (nodes.routeDestination === nextDestination) continue;
      try {
        nodes.modMacroPan.disconnect(nodes.routeDestination);
      } catch {
        /* prior edge was already disconnected */
      }
      nodes.modMacroPan.connect(nextDestination);
      nodes.routeDestination = nextDestination;
    }

    this.automation.syncLfos(doc);
    this.automation.syncMacros(doc);
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
  setEffectiveBpm(bpm: number | null, when?: number): void {
    this.sceneBpmOverride = bpm;
    const effective = bpm ?? this.doc?.bpm;
    if (effective != null && Number.isFinite(effective)) this.pushSyncBpm(effective, when);
  }

  private pushSyncBpm(bpm: number, when?: number): void {
    // The change-guard only makes sense for live (immediate) pushes: scheduled
    // offline pushes must reach the runtimes even when the BPM value repeats
    // (120→140→120 scenes), because each push carries its own window time.
    if (when === undefined && this.syncedBpm === bpm) return;
    this.syncedBpm = bpm;
    // Bus and return chains hold tempo-synced runtimes (SYNC delays, LFO
    // syncs) — without these loops a return delay kept the old BPM after a
    // project/scene tempo change and echoes landed off-grid.
    // AudioParam-backed runtimes schedule the write at `when` (offline scene
    // lanes land at their own window start); message-port runtimes apply
    // immediately regardless (their processors cannot schedule) — those stay
    // last-write-wins across offline windows (vendor constraint on ozvena).
    for (const nodes of [...this.trackNodes.values(), ...this.groupNodes.values(), ...this.returnNodes.values()]) {
      for (const rt of nodes.fx.runtimes.values()) rt.syncBpm?.(bpm, when);
    }
    // Instrument runtimes: tempo-synced modulators (LFO sync, texture delay,
    // granular rate sync) pick the new tempo up live. `when` schedules the
    // write for offline scene lanes where the runtime supports it.
    for (const inst of this.instruments.values()) inst.runtime.syncBpm?.(bpm, when);
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
   *
   * Write mode: live edits glide (setTargetAtTime, 20 ms — a chain edit must
   * not click). Offline renders armed via prepareOfflineRender() write
   * EXACTLY (setValueAtTime): a glide on a fresh offline timeline leaves the
   * head of the export progressively misaligned — at the 20 ms time constant
   * a 5 ms look-ahead target is within one sample only after ~100 ms of
   * rendered audio, which is a defect frozen into the file.
   */
  private syncPdc(): void {
    const ctx = this.ctx;
    if (!ctx || !this.doc) return;
    if (this.offlineRenderLocked) return; // a rendering graph must not be mutated
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
    const writeDelay = (delay: DelayNode | null | undefined, seconds: number): void => {
      // Non-finite mirrors sendPdcDelaySec: treat as no compensation rather
      // than throwing on the AudioParam write.
      const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
      if (this.offlineExactPdc) delay?.delayTime.setValueAtTime(target, now);
      else delay?.delayTime.setTargetAtTime(target, now, 0.02);
    };
    for (const [id, nodes] of this.trackNodes) {
      writeDelay(nodes.fx.pdcDelay, Math.max(0, maxEffective - (effective.get(id) ?? 0)));
    }
    for (const nodes of this.groupNodes.values()) {
      writeDelay(nodes.fx.pdcDelay, 0);
    }
    for (const nodes of this.returnNodes.values()) {
      writeDelay(nodes.fx.pdcDelay, 0);
    }
    // Per-send compensation. Track taps sit post-track-PDC at
    // (maxEffective − groupLat), so the send waits out the downstream group
    // latency minus the return's own latency. Group taps sit post-group at
    // exactly maxEffective (downstream 0).
    for (const [id, nodes] of this.trackNodes) {
      const track = this.doc.tracks.find((t) => t.id === id);
      const downstream = track && track.kind !== "group" && track.groupId ? (groupLatency.get(track.groupId) ?? 0) : 0;
      for (const [returnId, delay] of nodes.sendDelays) {
        writeDelay(delay, sendPdcDelaySec(downstream, returnLatency.get(returnId) ?? 0));
      }
    }
    for (const nodes of this.groupNodes.values()) {
      for (const [returnId, delay] of nodes.sendDelays) {
        writeDelay(delay, sendPdcDelaySec(0, returnLatency.get(returnId) ?? 0));
      }
    }
  }

  /**
   * Offline-render PDC barrier — the renderer calls this right before
   * OfflineAudioContext.startRendering().
   *
   * Two concerns in one gate:
   * 1. Latency settle. Worklet processors (gate, limiter, fxeq, ultina,
   *    ozvena, morph) post their DSP latency from the audio thread during
   *    node construction; those port messages are MAIN-THREAD TASKS and
   *    startRendering() does not wait for them. Rendering without the
   *    yield races the reports: the export runs with delayTime 0 (whole
   *    file misaligned against look-ahead chains) or a mid-render
   *    syncPdc() mutates an OfflineAudioContext graph (spec-undefined).
   *    Two macrotask turns let every constructor-time report land, then
   *    syncPdc() sizes the graph from real figures.
   * 2. Exact writes. Arming switches syncPdc to setValueAtTime so the
   *    compensation is sample-exact from sample 0 (see syncPdc). Late
   *    straggler reports after arming early-return in syncPdc — a rendering
   *    graph is never mutated.
   *
   * The render engine is throwaway (one per export), so arming never needs
   * to disarm.
   */
  async prepareOfflineRender(): Promise<void> {
    for (let turn = 0; turn < 2; turn++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // Switch to exact writes FIRST, then run the final sizing pass with
    // them, then lock: a mid-glide final write would defeat the whole
    // barrier (the arm-before-write ordering is the contract).
    this.offlineExactPdc = true;
    this.syncPdc();
    this.offlineRenderLocked = true;
  }

  private syncSends(sends: Record<string, number>, nodes: TrackNodes | GroupNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const live = new Set(Object.keys(sends).filter((returnId) => this.returnNodes.has(returnId)));
    for (const [returnId, sendGain] of [...nodes.sends]) {
      if (!live.has(returnId)) {
        // A send is a two-edge tap: modMacroPan ─▶ sendGain ─▶ sendDelay ─▶
        // return.input. `sendGain.disconnect()` only severs edges LEAVING
        // sendGain, so the upstream edge stayed wired and the tap node was
        // never collected — every send that was switched off and later re-added
        // left another live GainNode + DelayNode pair hanging off the channel
        // output. Full-channel teardown (disposeTrackNodes /
        // disposeGroupNodes) disconnects modMacroPan wholesale and was always
        // safe; this per-send path has to drop its own edge explicitly.
        try {
          nodes.modMacroPan.disconnect(sendGain);
        } catch {
          /* prior edge was already disconnected */
        }
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
      // Capability check, NOT `??`: setParameterAt returns void, so the old
      // `??` fallback executed the immediate setParameter on EVERY call —
      // the locked value landed now (on ringing voices) instead of only at
      // the scheduled `when`.
      if (inst.runtime.setParameterAt) {
        inst.runtime.setParameterAt("ratio", Math.max(1, Math.min(7, lockedRatio as number)), when);
      } else {
        inst.runtime.setParameter("ratio", Math.max(1, Math.min(7, lockedRatio as number)));
      }
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
        // if/else, not `??` — setParameterAt returns void, so the old fallback
        // fired the restore IMMEDIATELY, undoing the p-lock on ringing voices
        // a full lookahead before the note even played.
        if (inst.runtime.setParameterAt) inst.runtime.setParameterAt("ratio", 3.5, restoreAt);
        else inst.runtime.setParameter("ratio", 3.5);
      } else {
        if (inst.runtime.setParameterAt) inst.runtime.setParameterAt("ratio", savedRatio, restoreAt);
        else inst.runtime.setParameter("ratio", savedRatio);
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
  triggerAudioClip(
    clip: import("../project-model/types").AudioClip,
    when: number,
    durationSec?: number,
    resumeOffsetSec = 0,
  ): void {
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
    const resumedBy = Number.isFinite(resumeOffsetSec) ? Math.max(0, resumeOffsetSec) : 0;
    if (
      resumedBy > 0 &&
      (reverse ||
        clip.loop ||
        (clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01) ||
        (clip.warpMarkers?.length ?? 0) > 0)
    ) {
      return;
    }

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
    const clipGain = Math.min(2, Math.max(0, clip.gain ?? 1));
    gain.gain.value = clipGain;
    // Musical comp overlaps use deterministic equal-power curves. Ordinary
    // clip fades keep their existing linear behavior.
    const isCompClip = clip.compSourceTakeId !== undefined;
    let fadeIn = Math.max(0, clip.fadeIn ?? 0);
    let fadeOut = Math.max(0, clip.fadeOut ?? 0);
    const originalClipDurSec = clipDurSec + resumedBy;
    if (isCompClip && fadeIn + fadeOut > originalClipDurSec) {
      const scale = originalClipDurSec / Math.max(0.001, fadeIn + fadeOut);
      fadeIn *= scale;
      fadeOut *= scale;
    } else if (!isCompClip) {
      // Match the original non-comp envelopes: linear fade-in tops out at
      // half the clip duration, and fade-out can span at most the clip.
      // Use the full pre-resume duration so a mid-clip start evaluates the
      // same envelope progress the source had reached before audition began.
      fadeIn = Math.min(fadeIn, originalClipDurSec / 2);
      fadeOut = Math.min(fadeOut, originalClipDurSec);
    }
    const fadeInActive = fadeIn > 0.001 && resumedBy < fadeIn;
    const fadeInProgress = fadeIn > 0 ? Math.min(1, resumedBy / fadeIn) : 1;
    const fadeInRemaining = fadeInActive ? fadeIn - resumedBy : 0;
    const fadeOutStartSec = originalClipDurSec - fadeOut;
    const fadeOutActive = fadeOut > 0.001 && resumedBy >= fadeOutStartSec;
    const fadeOutProgress =
      fadeOutActive && fadeOut > 0 ? Math.min(1, Math.max(0, (resumedBy - fadeOutStartSec) / fadeOut)) : 0;
    const fadeOutRemaining = fadeOutActive ? clipDurSec : fadeOut;
    const fadeOutAt = fadeOutActive ? when : when + Math.max(0, clipDurSec - fadeOut);
    if (isCompClip) {
      const scheduleCurve = (startAt: number, duration: number, rising: boolean, startProgress = 0): void => {
        const pointCount = 64;
        const values = new Float32Array(pointCount + 1);
        for (let index = 0; index <= pointCount; index++) {
          const progress = startProgress + (index / pointCount) * (1 - startProgress);
          const angle = (progress * Math.PI) / 2;
          values[index] = clipGain * (rising ? Math.sin(angle) : Math.cos(angle));
        }
        gain.gain.setValueCurveAtTime(values, startAt, duration);
      };
      const initialEnvelope = fadeOutActive ? Math.cos((fadeOutProgress * Math.PI) / 2) : 1;
      gain.gain.setValueAtTime(clipGain * initialEnvelope, when);
      if (fadeInActive) scheduleCurve(when, Math.min(fadeInRemaining, clipDurSec), true, fadeInProgress);
      if (fadeOutRemaining > 0.001 && clipDurSec > 0.01) {
        scheduleCurve(fadeOutAt, Math.min(fadeOutRemaining, clipDurSec), false, fadeOutProgress);
      }
    } else {
      const initialEnvelope = (fadeInActive ? fadeInProgress : 1) * (fadeOutActive ? 1 - fadeOutProgress : 1);
      gain.gain.setValueAtTime(clipGain * initialEnvelope, when);
      if (fadeInActive) {
        gain.gain.linearRampToValueAtTime(clipGain, when + Math.min(fadeInRemaining, clipDurSec / 2));
      }
      if (fadeOutRemaining > 0.001 && clipDurSec > 0.01) {
        const outStart = fadeOutAt;
        if (!fadeOutActive) gain.gain.setValueAtTime(clipGain, outStart);
        gain.gain.linearRampToValueAtTime(0, when + clipDurSec);
      }
    }
    const sourceSplitter = connectAudioClipSourceChannel(ctx, source, gain, clip.sourceChannel);
    gain.connect(nodes.input);

    // Offset / trim handling
    const { duration, bufferDuration, playOffset, contentDur, loopStart, loopEnd } = audioClipPlayWindow(
      clip,
      playBuffer.duration,
      clipDurSec,
      timeScale,
    );

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
      if (loopEnd - loopStart >= 0.01) {
        source.loop = true;
        source.loopStart = loopStart;
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
      try {
        sourceSplitter?.disconnect();
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
        const segSplitter = connectAudioClipSourceChannel(ctx, segSource, segGain, clip.sourceChannel);
        segGain.connect(gain);
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
          try {
            segSplitter?.disconnect();
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
      const effWallDuration = warpedHit ? Math.min(clipDurSec, warpedHit.duration) : duration;
      const effBufferDuration = warpedHit ? effWallDuration : bufferDuration;
      try {
        if (source.loop) {
          // Keep the loop's source window separate from its starting phase.
          // The optional duration argument counts source-buffer seconds, so
          // stop() owns the arrangement-time boundary for repeated loops.
          source.start(when, effOffset);
          source.stop(when + effWallDuration + 0.01);
        } else {
          source.start(when, effOffset, effBufferDuration);
          source.stop(when + effWallDuration + 0.01);
        }
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
          sourceSplitter?.disconnect();
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
    // Audit 12 D1: ALWAYS release the in-flight claim — a rejected render
    // (worker onerror falling into a throwing runSync) used to leave the key
    // claimed forever, silently starving every later re-warm of this clip
    // into repitch fallback for the rest of the session.
    renderWarpPreserveAsync(channels, job.sampleRate, job.intervals, job.outLen)
      .catch((error) => {
        console.warn("[audio-engine] background warp render failed:", error);
        return null;
      })
      .then((rendered) => {
        this.warpInflight.delete(job.key);
        if (!rendered) return;
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
    this.previewDeck.previewNote(trackId, pitch);
  }

  // ── Automation bridge (Wave 4d) — delegates; public surface unchanged. ──

  syncMacros(doc: ProjectDocument): void {
    this.automation.syncMacros(doc);
  }

  setSceneIntensity(value: number): void {
    this.automation.setSceneIntensity(value);
  }

  scheduleSceneIntensity(points: Array<{ tick: number; value: number }>, timeAt: (tick: number) => number): void {
    this.automation.scheduleSceneIntensity(points, timeAt);
  }

  applySceneAutomationLane(
    lane: SceneAutomation,
    fromTick: number,
    toTick: number,
    sceneStartTick: number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    this.automation.applySceneAutomationLane(lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec, timeAt);
  }

  applyModulators(fromTick: number, toTick: number, whenFor: (tick: number) => number): void {
    this.automation.applyModulators(fromTick, toTick, whenFor);
  }

  scheduleModulatorsOffline(windows: { from: number; to: number }[], timeAt: (tick: number) => number): void {
    this.automation.scheduleModulatorsOffline(windows, timeAt);
  }

  applyEnvFollowersToParams(): void {
    this.automation.applyEnvFollowersToParams();
  }

  applyAutomation(
    fromTick: number,
    toTick: number,
    relOf: (tick: number) => number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    this.automation.applyAutomation(fromTick, toTick, relOf, scheduleOffsetSec, timeAt);
  }

  scheduleTrackAutomation(
    trackId: string,
    param: "gain" | "pan",
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    this.automation.scheduleTrackAutomation(trackId, param, points, timeAt);
  }

  scheduleDeviceAutomation(
    trackId: string,
    kind: "fx" | "inst",
    deviceId: string | undefined,
    paramId: string | undefined,
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    this.automation.scheduleDeviceAutomation(trackId, kind, deviceId, paramId, points, timeAt);
  }

  automationReset(): void {
    this.automation.automationReset();
  }

  applyMidiCc(target: AutomationTarget, value: number): void {
    this.automation.applyMidiCc(target, value);
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
    if (!ctx || !buffer || !this.masterChain.input) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain).connect(this.masterChain.input);
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
    if (!ctx || !this.masterChain.input) return;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = downbeat ? 1600 : 1000;
    const gain = ctx.createGain();
    const level = downbeat ? 0.25 : 0.14;
    gain.gain.setValueAtTime(level, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
    osc.connect(gain).connect(this.masterChain.input);
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

  trigger(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    /** Resolved velocity-layer / round-robin sample for this hit (see groove.ts). */
    sampleId?: string | null,
  ): void {
    const ctx = this.ctx;
    const trackNodes = this.trackNodes.get(trackId);
    if (!ctx || !trackNodes) return;
    // Frozen tracks play back a pre-rendered buffer — skip individual triggers
    if (this.frozenBuffers.has(trackId)) return;
    const buffer = this.bank?.get(sampleId ?? pad.assetId ?? "");
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
    // MPC-style pad loop: play the head into the region, then cycle
    // loopStart→loopEnd until choked, retriggered or a 30 s safety cap.
    const loopPlayback = pad.sliceLoop === true && !slice.reverse;
    // De-click: every one-shot gets a guaranteed 2 ms tail even when no slice
    // fade is configured (default) and when a `length` p-lock cut the slice
    // mid-body. A step to zero at full amplitude is a click — this is the
    // single place that makes every drum voice safe. Attack is never touched.
    // A LOOPED pad schedules no slice-end fade (that would mute the loop) —
    // its de-click lives on the safety stop below and on the choke path.
    const fadeOut = declickFadeOut(slice.fadeOut, slice.duration);
    const endWhen = when + slice.duration;
    gain.gain.setValueAtTime(slice.fadeIn > 0 ? 0 : peak, when);
    if (slice.fadeIn > 0) gain.gain.linearRampToValueAtTime(peak, when + slice.fadeIn);
    if (!loopPlayback && fadeOut > 0) {
      const fadeOutAt = Math.max(when + slice.fadeIn, endWhen - fadeOut);
      gain.gain.setValueAtTime(peak, fadeOutAt);
      gain.gain.linearRampToValueAtTime(0, fadeOutAt + fadeOut);
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
        // De-click the cap itself — a hard source.stop mid-loop clicks.
        const safetyStop = when + 30;
        const safetyFade = Math.min(DECLICK_TAIL_SEC, 0.05);
        gain.gain.setValueAtTime(peak, safetyStop - safetyFade);
        gain.gain.linearRampToValueAtTime(0, safetyStop);
        source.stop(safetyStop);
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
    this.previewDeck.preview(pad, trackId, velocity);
  }

  // ── Audition deck (Wave 4c) — delegates to PreviewDeck; public surface unchanged. ──

  previewInstrumentPreset(trackId: string, preset: InstrumentPreset): void {
    this.previewDeck.previewInstrumentPreset(trackId, preset);
  }

  previewSlice(pad: DrumPad, loop = false): void {
    this.previewDeck.previewSlice(pad, loop);
  }

  stopPreview(): void {
    this.previewDeck.stopPreview();
  }

  previewAsset(assetId: string): void {
    this.previewDeck.previewAsset(assetId);
  }

  previewBuffer(buffer: AudioBuffer, gainValue = 0.9, onEnded?: () => void, offsetSec = 0): void {
    this.previewDeck.previewBuffer(buffer, gainValue, onEnded, offsetSec);
  }

  previewAssetSynced(assetId: string, rate = 1): void {
    this.previewDeck.previewAssetSynced(assetId, rate);
  }

  /**
   * Late-bound transport reader (assigned by services after construction):
   * transport-synced previews quantize to the next bar relative to the live
   * playhead; falls back to 0 when unset.
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
      this.previewDeck.disposeAll();
      this.stopOneShotSources();
      this.frozenBuffers.clear();
      this.frozenBufferIds.clear();
      this.frozenPlaying = false;
      this.frozenAlign = null;
      this.automation.disposeLfos();
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
    this.automation.disposeLfos();
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

  // ── Metering (Wave 4a) — delegates to MeteringRig; public surface unchanged. ──

  getTrackLevel(trackId: string): number {
    return this.metering.getTrackLevel(trackId);
  }

  getReturnLevel(returnId: string): number {
    return this.metering.getReturnLevel(returnId);
  }

  getTrackMeterSnapshot(trackId: string): TrackMeterSnapshot {
    return this.metering.getTrackMeterSnapshot(trackId);
  }

  getReturnMeterSnapshot(returnId: string): TrackMeterSnapshot {
    return this.metering.getReturnMeterSnapshot(returnId);
  }

  /** Post-limiter master tap for realtime recording ("bounce what you hear"). */
  getMasterTapNode(): AudioNode | null {
    return this.masterChain.stage.limiter;
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
    for (const { id, reason } of this.automation.degradedLfos()) {
      const host = this.doc?.lfos.find((l) => l.id === id)?.trackId ?? "";
      out.push({ trackId: host, fxId: id, reason });
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

  /**
   * Roadmap O7: drop a previously loaded user IR (falls back to the
   * factory selection). Mirrors loadUserIrForFx for the rack's CLR button.
   */
  clearUserIrForFx(trackId: string, fxId: string): void {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    if (!rt?.clearUserIr) throw new Error("This effect cannot load impulse responses");
    rt.clearUserIr();
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
   *
   * Skips degraded (bypass) runtimes: the worklet DSP isn't loaded yet and
   * the bypass runtime's setParameter is a deliberate no-op. Wasting the
   * port message hides the fact that a drag is silent (the banner tells the
   * user PRISM is bypassed, but the slider still visually moves). The doc
   * commit path is unaffected — values written by the panel still land in
   * the document and replay through syncFxParams once the real runtime is
   * installed after the worklet lands.
   */
  previewFxParam(trackId: string, fxId: string, paramId: string, value: number): void {
    const rt =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    if (!rt || rt.degraded) return;
    rt.setParameter?.(paramId, value);
  }

  /**
   * Live mixer previews (Audit 04 #6): the same writes syncProject performs
   * on commit, fired during a fader drag so the level is audible WHILE it
   * moves — the document write still happens once on commit and is
   * idempotent with the preview. Cancel re-previews the committed doc value.
   */
  previewTrackGain(trackId: string, gain: number): void {
    const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
    if (!nodes || !this.ctx) return;
    // This is the SAME param syncProject drives with `audible ? gain : 0` —
    // a preview that wrote the raw fader value would audibly un-mute a
    // muted (or soloed-out) channel for the length of the drag, then snap
    // back to silence on commit.
    const audible = this.doc ? soloAudibility(this.doc).audible(trackId) : true;
    nodes.gain.gain.setTargetAtTime(audible ? Math.min(1.5, Math.max(0, gain)) : 0, this.ctx.currentTime, 0.01);
  }

  /** Live send-level preview (mirrors syncSends' write; commit is setTrackSend). */
  previewTrackSend(trackId: string, returnId: string, level: number): void {
    const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
    const sendGain = nodes?.sends.get(returnId);
    if (!sendGain || !this.ctx) return;
    sendGain.gain.setTargetAtTime(Math.min(1.5, Math.max(0, level)), this.ctx.currentTime, 0.01);
  }

  previewTrackPan(trackId: string, pan: number): void {
    const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
    if (!nodes || !this.ctx) return;
    nodes.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), this.ctx.currentTime, 0.01);
  }

  previewReturnGain(returnId: string, gain: number): void {
    const nodes = this.returnNodes.get(returnId);
    if (!nodes || !this.ctx) return;
    nodes.gain.gain.setTargetAtTime(Math.min(1.5, Math.max(0, gain)), this.ctx.currentTime, 0.01);
  }

  previewMasterGain(masterGain: number): void {
    // applyMasterConfig combines the fader with the persisted loudness trim —
    // route through it so the preview matches the committed write exactly.
    if (!this.masterChain.input || !this.doc || !this.ctx) return;
    this.masterChain.applyMasterConfig({ ...this.doc.master, masterGain: Math.min(1.5, Math.max(0, masterGain)) });
  }

  /** Start an engine-owned, non-persistent audition for one reviewed FX proposal. */
  beginEffectIntentPreview(
    trackId: string,
    fxId: string,
    values: Record<string, number>,
    onEnded?: (reason: EffectIntentPreviewEndReason) => void,
  ): boolean {
    const doc = this.doc;
    const effect = doc ? targetOwner(doc, trackId)?.effects.find((candidate) => candidate.id === fxId) : undefined;
    if (!effect || effect.bypassed || Object.keys(values).length === 0) return false;
    if (this.effectIntentPreview) this.cancelEffectIntentPreview(this.doc ?? undefined, "manual");

    const restoreValues: Record<string, number> = {};
    for (const [paramId, value] of Object.entries(values)) {
      const def = EFFECT_DEFS[effect.type].params.find((candidate) => candidate.id === paramId);
      if (!def || !Number.isFinite(value) || clampEffectParam(effect.type, paramId, value) !== value) return false;
      if (def.options && !def.options.some((option) => option.value === value)) return false;
      restoreValues[paramId] = effect.params[paramId] ?? def.default;
    }

    if (!this.previewFxParams(trackId, fxId, values, restoreValues)) return false;
    this.effectIntentPreview = { trackId, fxId, effectType: effect.type, paramIds: Object.keys(values), onEnded };
    return true;
  }

  /** Restore the current document values and close the single active FX intent audition. */
  cancelEffectIntentPreview(
    nextDoc: ProjectDocument | undefined = this.doc ?? undefined,
    reason: EffectIntentPreviewEndReason = "manual",
  ): boolean {
    const active = this.effectIntentPreview;
    if (!active) return true;
    this.effectIntentPreview = null;
    const current = nextDoc
      ? targetOwner(nextDoc, active.trackId)?.effects.find((effect) => effect.id === active.fxId)
      : undefined;
    let restored = true;
    if (current?.type === active.effectType) {
      const values = Object.fromEntries(
        active.paramIds.map((paramId) => {
          const def = EFFECT_DEFS[current.type].params.find((candidate) => candidate.id === paramId);
          return [paramId, current.params[paramId] ?? def?.default ?? 0];
        }),
      );
      restored = this.previewFxParams(active.trackId, active.fxId, values);
    }
    try {
      active.onEnded?.(restored ? reason : "restoreFailed");
    } catch {
      // UI observers must not interrupt project or transport lifecycle work.
    }
    return restored;
  }

  /**
   * Apply a transient, multi-parameter audition directly to one live effect
   * runtime. No project state, autosave or undo history is touched. If one
   * runtime setter throws, the caller-provided rollback map is replayed.
   */
  private previewFxParams(
    trackId: string,
    fxId: string,
    values: Record<string, number>,
    rollbackValues: Record<string, number> = {},
  ): boolean {
    if (Object.keys(values).length === 0 || Object.values(values).some((value) => !Number.isFinite(value)))
      return false;
    const runtime =
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    if (!runtime) return false;
    try {
      for (const [paramId, value] of Object.entries(values)) runtime.setParameter(paramId, value);
      return true;
    } catch {
      for (const [paramId, value] of Object.entries(rollbackValues)) {
        try {
          runtime.setParameter(paramId, value);
        } catch {
          // The project/document remains authoritative; a later engine sync
          // will restore parameters if a plugin runtime is already failing.
        }
      }
      return false;
    }
  }

  getMasterLevel(): number {
    return this.metering.getMasterLevel();
  }

  getMasterLevels(): { left: ChannelLevels; right: ChannelLevels; correlation: number } {
    return this.metering.getMasterLevels();
  }

  getMasterPeakHoldDb(): number {
    return this.metering.getMasterPeakHoldDb();
  }

  getMasterGainReductionDb(): number {
    return this.metering.getMasterGainReductionDb();
  }

  getMasterGlueReductionDb(): number {
    return this.metering.getMasterGlueReductionDb();
  }

  resetMasterPeakHold(): void {
    this.metering.resetMasterPeakHold();
  }

  resetMasterIntegratedLufs(): void {
    this.metering.resetMasterIntegratedLufs();
  }

  getMasterMeterSnapshot(): MasterMeterSnapshot {
    return this.metering.getMasterMeterSnapshot();
  }

  getMasterHeadroomDb(): number {
    return this.metering.getMasterHeadroomDb();
  }

  getMasterSpectrumAnalyser(): AnalyserNode | null {
    return this.metering.getMasterSpectrumAnalyser();
  }

  getMasterStereoAnalysers(): { l: AnalyserNode; r: AnalyserNode } | null {
    return this.metering.getMasterStereoAnalysers();
  }

  getMasterSpectrogramAnalyser(): AnalyserNode | null {
    return this.metering.getMasterSpectrogramAnalyser();
  }

  /** Read-only live context state for UI indicators (no side effects, no
   *  resume attempt — UI chips must be able to observe "suspended" without
   *  perturbing it). Null while no realtime context exists. */
  getLiveAudioState(): "suspended" | "running" | "interrupted" | "closed" | null {
    return (this.ctx?.state as "suspended" | "running" | "interrupted" | "closed") ?? null;
  }

  /** Default media-device change subscription for UI monitoring. Returns an
   *  unsubscribe fn; no-op on hosts without mediaDevices (insecure context). */
  onDeviceChange(listener: () => void): () => void {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return () => {};
    const handler = () => listener();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", handler);
  }

  getMasterSpectrogramTaps(): { low: AnalyserNode; mid: AnalyserNode; high: AnalyserNode } | null {
    return this.metering.getMasterSpectrogramTaps();
  }

  getMasterSpectrogramStereoTaps(): { mid: AnalyserNode; side: AnalyserNode } | null {
    return this.metering.getMasterSpectrogramStereoTaps();
  }

  getSpectrogramTrackAnalyser(sourceId: string): AnalyserNode | null {
    return this.metering.getSpectrogramTrackAnalyser(sourceId);
  }

  /** True peak via 4× polyphase oversampling — pure impl lives in metering.ts. */
  static measureTruePeak(frames: Frame, channels: number): number {
    return measureTruePeakImpl(frames, channels);
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
      activeLfos: this.automation.lfoCount,
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
export const MAX_WARP_SEGMENTS = MAX_AUDIO_CLIP_WARP_SEGMENTS;

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
  const { clipStartTick, clipTicks, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipStartTick) || !Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;
  const resolved = resolveWarpPinPoints(opts);
  if (!resolved || resolved.inRangeMarkerCount === 0) return null;
  // The shared resolver has already rejected maps with no in-range markers.
  const segs: WarpSegment[] = [];
  for (let i = 0; i + 1 < resolved.points.length && segs.length < MAX_WARP_SEGMENTS; i++) {
    const a = resolved.points[i]!;
    const b = resolved.points[i + 1]!;
    const dTick = b.relTick - a.relTick;
    const dBuf = b.bufferTimeSec - a.bufferTimeSec;
    // Degenerate: zero time span or frozen/reversed buffer direction —
    // BufferSource cannot hold or play backwards in a forward warp.
    if (dTick <= 1e-9 || dBuf <= 0.0005) continue;
    const rate = dBuf / (dTick * spt);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    segs.push({
      startTick: a.relTick,
      endTick: b.relTick,
      bufStartSec: a.bufferTimeSec,
      bufEndSec: b.bufferTimeSec,
      rate,
    });
  }
  return segs.length > 0 ? segs : null;
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
): {
  /** Wall-clock duration after source-window limits are applied. */
  duration: number;
  /** Duration argument for AudioBufferSourceNode.start(), in buffer seconds. */
  bufferDuration: number;
  /** Source playhead position passed to start(). */
  playOffset: number;
  /** Trimmed content length in play-buffer seconds. */
  contentDur: number;
  /** Loop region endpoints in play-buffer seconds. */
  loopStart: number;
  loopEnd: number;
} {
  const offset = Math.max(0, ((clip.offsetSec ?? 0) + (clip.trimStart ?? 0)) * timeScale);
  const trimEnd = Math.max(0, (clip.trimEnd ?? 0) * timeScale);
  const maxDur = Math.max(0.01, playBufferDurationSec - offset - trimEnd);
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preStretched = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01 && timeScale !== 1;
  const playbackRate = preStretched ? 1 : rate;
  const bufferDuration = Math.min(Math.max(0, requestedDurationSec * playbackRate), maxDur);
  const loopStart = offset;
  const loopEnd = Math.min(playBufferDurationSec, offset + maxDur);
  const loopContentDur = Math.max(0, loopEnd - loopStart);
  const loopingForward = clip.loop === true && clip.reverse !== true && loopContentDur > 0.02;
  const duration = loopingForward ? requestedDurationSec : bufferDuration / playbackRate;
  let playOffset: number;
  if (loopingForward) {
    const sourceLoopDur = loopContentDur / timeScale;
    const phase = Math.max(0, Number.isFinite(clip.loopPhaseOffsetSec) ? clip.loopPhaseOffsetSec! : 0);
    const wrappedPhase = sourceLoopDur > 0 ? phase % sourceLoopDur : 0;
    playOffset = loopStart + wrappedPhase * timeScale;
  } else if (clip.reverse) {
    // Pitch-preserving reverse uses a physically reversed stretched buffer;
    // resample reverse uses the original buffer and a negative playbackRate.
    playOffset = preStretched
      ? Math.max(0, playBufferDurationSec - offset - bufferDuration)
      : Math.min(playBufferDurationSec, offset + bufferDuration);
  } else {
    playOffset = offset;
  }
  return { duration, bufferDuration, playOffset, contentDur: maxDur, loopStart, loopEnd };
}
