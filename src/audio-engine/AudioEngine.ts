import type {
  AutomationTarget,
  DrumPad,
  EffectInstance,
  InstrumentTrack,
  ProjectDocument,
  SampleLayer,
  SceneAutomation,
} from "../project-model/types";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";
import type { AudioClip, AutomationPoint } from "../project-model/types";
import { MAX_AUDIO_CLIP_WARP_SEGMENTS, resolveWarpPinPoints } from "../project-model/audio-clip-warp";
export { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { hashString } from "../shared/rng";
import { PPQ } from "../project-model/types";
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
  loadInstrumentWorklet,
  loadPluginWorklet,
  PLUGIN_WORKLET_TYPES,
  type PluginWorkletType,
} from "../audio-worklets/loader";
import { MeteringRig, measureTruePeak as measureTruePeakImpl } from "./meteringRig";
import { PreviewDeck } from "./previewDeck";
import { AutomationBridge } from "./automationBridge";
import { WarpManager } from "./warpManager";
import { TriggerEngine } from "./triggerEngine";
import type { TriggerTrackView, InstrumentStateView, ClipSourceMeta } from "./triggerEngine";
import { audioClipsForPlayback } from "../project-model/audio-takes";
import type { TrackOrGroupView, ReturnView } from "./deviceLookup";
import { targetOwner } from "../project-model/targets";
import { DeviceLookup } from "./deviceLookup";
import { MasterChain } from "./masterChain";
import type { MasterStage } from "./masterChain";
import { isLiveAudioContext } from "./liveContext";
import type { MasterMeterSnapshot, TrackMeterSnapshot } from "./metering-types";
import type { Frame, ChannelLevels } from "./metering";

/** Tick position → seconds inside a frozen loop (mod buffer duration). */
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

/**
 * MIXER AUDIT (signal-flow re-run 2026-10): the engine's COMMIT writes used to
 * push raw doc values into the graph while the drag previews clamped — safety
 * rested entirely on normalizeProject + command writers. Any path that reaches
 * setProject with an unnormalized doc (collab peer mid-merge, embed, a future
 * caller) hit the graph raw. These helpers mirror the schema clamps exactly
 * (gain fallback 0.9 / pan 0 / send 0) so the graph can never see a non-finite
 * or out-of-range fader value — setTargetAtTime(NaN) throws and would abort
 * the whole syncProject pass.
 */
export function clampFaderGain(value: number): number {
  return Number.isFinite(value) ? Math.min(1.5, Math.max(0, value)) : 0.9;
}

export function clampPanValue(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}

export function clampSendLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(1.5, Math.max(0, value)) : 0;
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
  /** PRE-fader tap (post-insert, pre-pan/fader) — gain-staging + triage meter. */
  preFaderAnalyser: AnalyserNode;
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
  instrument: InstrumentTrack["instrument"];
  /** Whether TSAR was built on its real worklet or its audible fallback. */
  tsarWorkletBacked: boolean;
  sampleId: string | null;
  sampleIdB: string | null;
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
  /** PRE-fader tap (post-insert, pre-pan/fader) — gain-staging + triage meter. */
  preFaderAnalyser: AnalyserNode;
  fx: FxChainState;
  sends: Map<string, GainNode>;
  /** Per-send PDC delays (sendGain → delay → return input), sized by syncPdc. */
  sendDelays: Map<string, DelayNode>;
}

export type { TrackMeterSnapshot, MasterMeterSnapshot } from "./metering-types";
export { DECLICK_TAIL_SEC, declickFadeOut, resolveSlicePlayback } from "./declick";
export { frozenPlaybackOffset, audioClipPlayWindow } from "./warpManager";
export { expandSceneLaneWindow } from "./automationBridge";
export { WARP_MICRO_FADE_SEC, warpSegmentRenders } from "./triggerEngine";
export type { WarpSegmentRender } from "./triggerEngine";
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
    trackPreAnalyser: (id) => this.trackNodes.get(id)?.preFaderAnalyser ?? null,
    groupPreAnalyser: (id) => this.groupNodes.get(id)?.preFaderAnalyser ?? null,
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
   * Wave 4e (decomposition): warp/freeze cache owner — the time-stretch LRU,
   * pitch-preserving warp pre-renders (in-flight claims + invalidation epoch)
   * and frozen-track playback. The engine's trigger paths consult it; storage
   * and lifecycle live here.
   */
  private warpManager = new WarpManager({
    ctx: () => this.ctx,
    doc: () => this.doc,
    bank: () => this.bank,
    trackInput: (trackId) => this.trackNodes.get(trackId)?.input ?? null,
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
    masterInsertLatencySec: () => this.masterInsertLatencySec(),
  });
  private masterFx: FxChainState = {
    runtimes: new Map(),
    params: new Map(),
    signature: null,
    pdcDelay: null,
    latencySubs: [],
  };
  private liveContextListeners = new Set<(context: AudioContext | null) => void>();
  private bank: SampleBank | null = null;
  private doc: ProjectDocument | null = null;
  private effectIntentPreview: EffectIntentPreviewSession | null = null;
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
   * Wave 4f (FINAL decomposition): realtime performance path — drum/synth
   * voices, instrument noteOn with p-locks + slides, AudioClips, MPE/MIDI
   * poly writes. Voice state and the 64-voice retirement cap live here.
   */
  private triggerEngine = new TriggerEngine(
    {
      ctx: () => this.ctx,
      doc: () => this.doc,
      bank: () => this.bank,
      currentTime: () => this.currentTime,
      trackNodes: this.trackNodes as unknown as Map<string, TriggerTrackView>,
      groupNodes: this.groupNodes as unknown as Map<string, TriggerTrackView>,
      instrumentStates: this.instruments as unknown as Map<string, InstrumentStateView>,
      warp: this.warpManager,
      trackOneShot: (source, clipMeta) => {
        this.oneShotSources.add(source);
        if (clipMeta) this.clipSourceMeta.set(source, clipMeta);
      },
      releaseOneShot: (source) => {
        this.oneShotSources.delete(source);
        this.clipSourceMeta.delete(source);
      },
      missAsset: (assetId) => this.missedAssets.add(assetId),
    },
    this.warpManager,
  );

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
    masterFx: () => this.masterFx,
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
  /** bufferId each frozen source is currently playing (detect re-freezes). */
  /** Frozen playback is transport-aware — sources only run while rolling. */
  /** Transport tick + ctx time at the last frozen restart, for alignment. */
  /**
   * LRU cache for time-stretched AudioBuffers keyed by `bufferId+rate+reverse`.
   * Lazy-computed on first triggerAudioClip with stretchMode="stretch".
   * Cleared on project swap to prevent stale references.
   */
  /**
   * LRU cache for pitch-preserving warp renders keyed by
   * `bufferId+wallSec+pins+reverse`. Warp buffers are clip-sized (bars of
   * audio, not one-shots), so the limit is small. Warmed in a worker on
   * trigger-miss / clip edit; the offline renderer precomputes synchronously
   * with the same core, so live and export are sample-exact.
   * Cleared on project swap (plus an epoch bump that orphans in-flight
   * worker replies).
   */
  /**
   * One-shot scheduled sources (AudioClips, marker cues, metronome clicks).
   * These are committed up to the 120 ms horizon ahead and are NOT part of
   * `voices`, so panic() previously left them playing — a stopped transport
   * kept sounding a multi-bar AudioClip, and seek/stop fired stale marker
   * cues. Bounded: each source removes itself on `onended`.
   */
  private oneShotSources = new Set<AudioScheduledSourceNode>();
  /**
   * Clip identity for the subset of one-shot sources that belong to an
   * AudioClip (straight source or warp segment). Keyed by source node; a
   * source removes itself via releaseOneShot on `onended`. Consumed by
   * cancelOrphanedClipSources() — the live-editing flush.
   */
  private clipSourceMeta = new Map<AudioScheduledSourceNode, ClipSourceMeta>();
  private missedAssets = new Set<string>();
  private syncedBpm = 0;
  /** Active scene BPM override (song mode) — null = runtimes follow doc.bpm. */
  private sceneBpmOverride: number | null = null;

  private bankUnsubscribe: (() => void) | null = null;
  private readonly tsarWorkletLoads = new WeakSet<BaseAudioContext>();

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
        if (state.sampleIdB === id) state.runtime.setSampleB?.(id);
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
    return this.triggerEngine.voiceCount;
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

  /** Toggle monitor-only master bypass without changing project state. */
  setMasterBypassed(enabled: boolean, immediate = false): void {
    this.masterChain.setBypassed(enabled, immediate);
  }

  isMasterBypassed(): boolean {
    return this.masterChain.isBypassed;
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
    this.triggerEngine.disposeVoicesForContextSwap();
    this.stopOneShotSources();
    // Audition voices belong to the PreviewDeck (Wave 4c) — hard-dispose
    // with the context swap (no de-click tail on a dying graph).
    this.previewDeck.disposeAll();
    this.warpManager.disposeAllFrozen();
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
    // Context-era AudioBuffer caches (synth noise, stretch/warp pre-renders)
    // must never survive a swap — the synth noise buffer lives in the
    // TriggerEngine now and dies with the voices (Wave 4f).
    this.triggerEngine.disposeVoicesForContextSwap();
    this.automation.clearMacroCache();
    this.syncedBpm = 0;
    // Warp buffers/stretches hold context-era AudioBuffers AND rate-dependent
    // pre-renders: after a device change (44.1 → 48 kHz) a stale entry would
    // play off-pitch. setProject clears these too — but a bare context swap
    // (contextlost recovery) never runs setProject. (Wave 4e: WarpManager.)
    this.warpManager.invalidateForContextSwap();
    this.disposeFxChainForContextSwap(this.masterFx);
    this.ctx = ctx;
    this.masterChain.build();
    if (this.doc) {
      this.syncProject(this.doc);
      this.queueTsarWorkletLoad(ctx, this.doc);
    }
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
        // Master inserts can have been materialized as transparent fallbacks
        // before the core modules landed. Force their factories to run again
        // so the live master rack swaps to the real AudioWorklet runtimes.
        this.masterFx.signature = "";
        for (const nodes of this.trackNodes.values()) nodes.fx.signature = "";
        for (const nodes of this.groupNodes.values()) nodes.fx.signature = "";
        for (const nodes of this.returnNodes.values()) nodes.fx.signature = "";
        this.syncProject(this.doc);
        // The master chain was built before processors existed — splice the
        // look-ahead limiter in now that they are ready.
        this.masterChain.upgradeMasterDynamics();
        this.masterChain.upgradeKwMeter();
        this.masterChain.upgradeRtMonitor();
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

  /** Load TSAR when a project starts using it, then replace any fallback runtime. */
  private queueTsarWorkletLoad(ctx: BaseAudioContext, doc: ProjectDocument): void {
    const hasTsar = doc.tracks.some((track) => track.kind === "instrument" && track.instrument === "tsar");
    if (!hasTsar || isWorkletReady("tsar", ctx) || this.tsarWorkletLoads.has(ctx)) return;
    this.tsarWorkletLoads.add(ctx);
    void loadInstrumentWorklet(ctx, "tsar")
      .then(() => {
        this.tsarWorkletLoads.delete(ctx);
        const currentDoc = this.doc;
        if (
          this.ctx === ctx &&
          isWorkletReady("tsar", ctx) &&
          currentDoc?.tracks.some((track) => track.kind === "instrument" && track.instrument === "tsar")
        ) {
          // syncInstrument notices the fallback→worklet transition and
          // rebuilds only the TSAR runtime against the now-ready processor.
          this.setProject(currentDoc);
        }
      })
      .catch(() => {
        this.tsarWorkletLoads.delete(ctx);
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

  /**
   * Managed gain for external graph helpers (the scheduler's ticker driver
   * needs a zero-gain sink so the graph pulls its worklet). Invariant #7
   * discipline: AudioNodes are created on the engine's context path, never
   * by consumers holding a raw context — this hands them an engine-owned
   * node instead. Null when no live context exists yet.
   */
  createContextGain(): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "closed") return null;
    return ctx.createGain();
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
      if (this.warpManager.syncProjectId(target.id)) {
        // Missing-asset ids belong to the project that missed them — the
        // engine outlives projects, so stale ids would accumulate forever and
        // pollute the diagnostics panel of the newly opened project.
        this.missedAssets.clear();
      }
      if (this.ctx) {
        this.syncProject(target);
        this.queueTsarWorkletLoad(this.ctx, target);
      }
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
    this.warpManager.restartFrozenSources(positionTick);
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

  /** Release master insert runtimes before their AudioContext is replaced. */
  private disposeFxChainForContextSwap(state: FxChainState): void {
    for (const unsubscribe of state.latencySubs) unsubscribe();
    state.latencySubs.length = 0;
    for (const runtime of state.runtimes.values()) {
      try {
        runtime.dispose();
      } catch {
        /* context swap must continue if a device fails teardown */
      }
    }
    state.runtimes.clear();
    state.params.clear();
    try {
      state.pdcDelay?.disconnect();
    } catch {
      /* already disconnected */
    }
    state.pdcDelay = null;
    state.signature = null;
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
    for (const rt of state.runtimes.values()) {
      try {
        rt.dispose();
      } catch {
        /* a failing runtime must not abort the chain rebuild */
      }
    }
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
        // Step-pattern sync (stepGate / stutter): same reference contract.
        // Without this push, pattern edits were audible only until the first
        // chain rebuild — the runtime's construction snapshot was all the
        // processor ever saw, so undo/redo of a pattern silently reverted it.
        rt.setPattern?.(fx.steps ?? []);
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
    for (const fx of doc.master.effects ?? []) {
      if (fx.bypassed) continue;
      const runtime = this.masterFx.runtimes.get(fx.id);
      if (!runtime?.setSidechainInput) continue;
      const sourceNodes = fx.sidechainTrackId
        ? (this.trackNodes.get(fx.sidechainTrackId) ?? this.groupNodes.get(fx.sidechainTrackId))
        : null;
      runtime.setSidechainInput(sourceNodes?.input ?? null);
    }
  }

  private disposeTrackNodes(id: string, nodes: TrackNodes): void {
    // A frozen track's looping buffer source must die with its channel —
    // only the unfreeze/panic paths touch it otherwise, so deleting a
    // frozen track used to leave the source running (and pinned in memory)
    // inside frozenBuffers until the next project switch.
    this.warpManager.disposeFrozenSource(id);
    this.setGenerativeSourceConnection(id, nodes, false);
    this.generativeSources.delete(id);
    this.connectedGenerativeSources.delete(id);
    for (const unsub of nodes.fx.latencySubs) unsub();
    nodes.fx.latencySubs.length = 0;
    // Defect 12.1 (audio-engine audit): the instrument path below already
    // contains per-runtime throws; the FX path did not. A runtime whose
    // dispose() throws must not abort the rest of the teardown (remaining
    // runtimes keep their nodes wired into a graph that is being discarded)
    // nor the context swap that called this. Contain each dispose.
    for (const rt of nodes.fx.runtimes.values()) {
      try {
        rt.dispose();
      } catch {
        /* a failing runtime must not strand the rest of the channel */
      }
    }
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
    nodes.preFaderAnalyser.disconnect();
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

  private disposeReturnNodes(id: string, nodes: ReturnNodes): void {
    for (const unsub of nodes.fx.latencySubs) unsub();
    nodes.fx.latencySubs.length = 0;
    for (const rt of nodes.fx.runtimes.values()) {
      try {
        rt.dispose();
      } catch {
        /* a failing runtime must not strand the rest of the bus */
      }
    }
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
    for (const rt of nodes.fx.runtimes.values()) {
      try {
        rt.dispose();
      } catch {
        /* a failing runtime must not strand the rest of the group */
      }
    }
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
    nodes.preFaderAnalyser.disconnect();
    for (const send of nodes.sends.values()) send.disconnect();
    nodes.sends.clear();
    for (const delay of nodes.sendDelays.values()) delay.disconnect();
    nodes.sendDelays.clear();
    this.groupNodes.delete(id);
  }

  private syncProject(doc: ProjectDocument): void {
    const ctx = this.ctx;
    const insertInput = this.masterChain.insertInput;
    const insertOutput = this.masterChain.insertOutput;
    if (!ctx || !this.masterChain.input || !insertInput || !insertOutput) return;

    this.masterChain.applyMasterConfig(doc.master);
    const masterEffects = doc.master.effects ?? [];
    const masterSignature = this.fxSignature(masterEffects);
    if (this.masterFx.signature !== masterSignature) {
      this.rebuildFxChain(MASTER_EFFECT_OWNER_ID, masterEffects, insertInput, insertOutput, this.masterFx);
    } else {
      this.syncFxParams(masterEffects, this.masterFx);
    }

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
      nodes.gain.gain.setTargetAtTime(clampFaderGain(ret.gain), ctx.currentTime, 0.01);
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
        // PRE-fader meter tap: the panner output is post-insert, pre-fader —
        // the gain-staging and muted-channel-triage point. Pure parallel edge
        // off panner; the audio path and PDC are untouched.
        const preFaderAnalyser = ctx.createAnalyser();
        preFaderAnalyser.fftSize = 2048;
        preFaderAnalyser.channelCount = 2;
        preFaderAnalyser.channelCountMode = "explicit";
        input.connect(panner);
        panner.connect(preFaderAnalyser);
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
          preFaderAnalyser,
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
      nodes.panner.pan.setTargetAtTime(clampPanValue(track.pan), now, 0.01);
      // Group audible when it — or any of its members — is soloed.
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? clampFaderGain(track.gain) : 0, now, 0.01);
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
        // PRE-fader meter tap: the panner output is post-insert, pre-fader —
        // the gain-staging and muted-channel-triage point. Pure parallel edge
        // off panner; the audio path and PDC are untouched.
        const preFaderAnalyser = ctx.createAnalyser();
        preFaderAnalyser.fftSize = 2048;
        preFaderAnalyser.channelCount = 2;
        preFaderAnalyser.channelCountMode = "explicit";
        input.connect(panner);
        panner.connect(preFaderAnalyser);
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
          preFaderAnalyser,
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
        if (!this.warpManager.hasFrozenBuffer(track.id, bufferId)) {
          this.warpManager.disposeFrozenSource(track.id);
          // A mid-playback freeze rehydrate needs the live frozen alignment —
          // the manager's restart path is the single creation point (Wave 4e).
          if (this.warpManager.frozenActive)
            this.warpManager.restartFrozenSources(this.warpManager.frozenPositionTickNow());
        }
        // Still allow live gain/pan adjustments
        const now = ctx.currentTime;
        nodes.panner.pan.setTargetAtTime(clampPanValue(track.pan), now, 0.01);
        // Member audible when it — or the group it feeds — is soloed.
        nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? clampFaderGain(track.gain) : 0, now, 0.01);
        continue; // Skip FX/instrument sync for frozen tracks
      }

      // Clean up frozen buffer if track was unfrozen
      this.warpManager.disposeFrozenSource(track.id);

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
      nodes.panner.pan.setTargetAtTime(clampPanValue(track.pan), now, 0.01);
      nodes.gain.gain.setTargetAtTime(solo.audible(track.id) ? clampFaderGain(track.gain) : 0, now, 0.01);
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
    this.masterChain.syncMonitorBypassLatency(this.offlineExactPdc);
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

  /** Serial fixed latency of the master insert slot plus its local PDC delay. */
  private masterInsertLatencySec(): number {
    let seconds = Math.max(0, this.masterFx.pdcDelay?.delayTime.value ?? 0);
    for (const runtime of this.masterFx.runtimes.values()) {
      const latency = runtime.getLatencySec?.() ?? 0;
      if (Number.isFinite(latency) && latency > 0) seconds += latency;
    }
    return seconds;
  }

  /**
   * Offline-render PDC barrier — the renderer calls this right before
   * OfflineAudioContext.startRendering().
   *
   * Two concerns in one gate:
   * 1. Latency settle. Worklet processors post DSP latency from the audio
   *    thread during node construction; those port messages are MAIN-THREAD
   *    TASKS and startRendering() does not wait for them. Two macrotask turns
   *    give startup a chance to run, then explicit readiness reports prove
   *    the latency-bearing runtimes have answered. If one does not answer,
   *    abort before rendering instead of exporting a file with delayTime 0.
   *    The final syncPdc() sizes the graph from the reported figures.
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
    // A fixed number of task turns is only a scheduling yield, not proof that
    // every AudioWorklet has started. Firefox can deliver constructor-time
    // latency messages later than Chromium; do not arm sample-exact PDC from
    // a temporary zero-latency snapshot.
    const latencyReportWaits: { owner: string; effectId: string; runtime: EffectRuntime }[] = [];
    const collectLatencyWaits = (owner: string, runtimes: Map<string, EffectRuntime>): void => {
      for (const [effectId, runtime] of runtimes) {
        if (runtime.waitForLatencyReport) latencyReportWaits.push({ owner, effectId, runtime });
      }
    };
    for (const [trackId, nodes] of this.trackNodes) collectLatencyWaits(`track ${trackId}`, nodes.fx.runtimes);
    for (const [groupId, nodes] of this.groupNodes) collectLatencyWaits(`group ${groupId}`, nodes.fx.runtimes);
    for (const [returnId, nodes] of this.returnNodes) collectLatencyWaits(`return ${returnId}`, nodes.fx.runtimes);
    collectLatencyWaits("master", this.masterFx.runtimes);
    const latencyReportTimeoutMs = 2_500;
    const missingReports = await Promise.all(
      latencyReportWaits.map(async ({ owner, effectId, runtime }) => {
        try {
          return (await runtime.waitForLatencyReport!(latencyReportTimeoutMs)) ? null : `${owner}, effect ${effectId}`;
        } catch {
          return `${owner}, effect ${effectId}`;
        }
      }),
    );
    const missing = missingReports.filter((entry): entry is string => entry !== null);
    if (missing.length > 0) {
      throw new Error(
        `Offline render stopped before audio rendering because latency reports did not arrive for: ${missing.join("; ")}`,
      );
    }
    // TSAR (and future event-queue instrument runtimes): build the seeded
    // worklet node NOW, after every note/automation is scheduled and before
    // startRendering (docs/TSAR-ROADMAP.md T5, ADR 0023). Port messages are
    // not pumped during an OfflineAudioContext render, so the runtime seeded
    // its queue via processorOptions instead.
    for (const state of this.instruments.values()) {
      const runtime = state.runtime as { prepareOfflineRender?: () => void };
      runtime.prepareOfflineRender?.();
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
      sendGain.gain.setTargetAtTime(clampSendLevel(sends[returnId] ?? 0), ctx.currentTime, 0.01);
    }
  }

  private syncInstrument(track: InstrumentTrack, nodes: TrackNodes): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let state = this.instruments.get(track.id);
    const tsarWorkletBacked = track.instrument === "tsar" && isWorkletReady("tsar", ctx);
    if (state && (state.instrument !== track.instrument || state.tsarWorkletBacked !== tsarWorkletBacked)) {
      this.disposeInstrumentRuntime(track.id);
      state = undefined;
    }
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
        instrument: track.instrument,
        tsarWorkletBacked,
        sampleId: track.sampleId,
        sampleIdB: track.sampleIdB ?? null,
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
    const sampleIdB = track.sampleIdB ?? null;
    if (state.sampleIdB !== sampleIdB) {
      state.runtime.setSampleB?.(sampleIdB);
      state.sampleIdB = sampleIdB;
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

  precomputeWarpSync(clip: AudioClip, wallSec: number): AudioBuffer | null {
    return this.warpManager.precomputeWarpSync(clip, wallSec);
  }

  warmWarpForClip(clip: AudioClip): void {
    this.warpManager.warmWarpForClip(clip);
  }

  clearStretchCache(): void {
    this.warpManager.clearStretchCache();
  }

  /** Clear pitch-preserving warp renders (project swap / bank rebuild). */
  clearWarpCache(): void {
    this.warpManager.clearWarpCache();
  }

  // ── Trigger engine (Wave 4f) — delegates; public surface unchanged. ──

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
    this.triggerEngine.noteOn(
      trackId,
      pitch,
      velocity,
      when,
      durationSec,
      slideFromTick,
      slideFromPitch,
      locks,
      slideFromWhen,
    );
  }

  triggerAudioClip(
    clip: import("../project-model/types").AudioClip,
    when: number,
    durationSec?: number,
    resumeOffsetSec = 0,
  ): void {
    this.triggerEngine.triggerAudioClip(clip, when, durationSec, resumeOffsetSec);
  }

  trigger(
    trackId: string,
    pad: DrumPad,
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    sampleId?: string | null,
  ): void {
    this.triggerEngine.trigger(trackId, pad, when, velocity, locks, sampleId);
  }

  /**
   * Scope the voices created inside `fn` to `owner` — a transient player
   * (ghost preview) claims its voices so its stop() can kill exactly its own
   * overhang without touching live-transport sound. See
   * TriggerEngine.withVoiceOwner.
   */
  withVoiceOwner<T>(owner: string, fn: () => T): T {
    return this.triggerEngine.withVoiceOwner(owner, fn);
  }

  /** De-clicked stop of one owner's pending + ringing voices. */
  stopVoicesForOwner(owner: string): void {
    this.triggerEngine.stopVoicesForOwner(owner, this.currentTime);
  }

  setMidiPitchBend(trackId: string, semitones: number): void {
    this.triggerEngine.setMidiPitchBend(trackId, semitones);
  }

  polyTimbre(trackId: string, pitch: number, timbre: number): void {
    this.triggerEngine.polyTimbre(trackId, pitch, timbre);
  }

  polyPressure(trackId: string, pitch: number, pressure: number): void {
    this.triggerEngine.polyPressure(trackId, pitch, pressure);
  }

  noteOff(trackId: string, pitch: number, when: number): void {
    this.triggerEngine.noteOff(trackId, pitch, when);
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

  previewNote(trackId: string, pitch: number): void {
    this.previewDeck.previewNote(trackId, pitch);
  }

  preview(pad: DrumPad, trackId: string, velocity = 1): void {
    this.previewDeck.preview(pad, trackId, velocity);
  }

  /**
   * Late-bound transport reader (assigned by services after construction):
   * transport-synced previews quantize to the next bar relative to the live
   * playhead; falls back to 0 when unset.
   */
  getTransportTick: (() => number) | null = null;

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

  /** Audition an already mastered comparison render straight to the monitor output. */
  previewMasterCompare(buffer: AudioBuffer, gainValue = 0.9, onEnded?: () => void, offsetSec = 0, mono = false): void {
    this.previewDeck.previewMasterCompare(buffer, gainValue, onEnded, offsetSec, mono);
  }

  updateMasterComparePreview(gainValue: number, mono: boolean): void {
    this.previewDeck.updateMasterComparePreview(gainValue, mono);
  }

  previewAssetSynced(assetId: string, rate = 1): void {
    this.previewDeck.previewAssetSynced(assetId, rate);
  }

  /**
   * Late-bound transport reader (assigned by services after construction):
   * transport-synced previews quantize to the next bar relative to the live
   * playhead; falls back to 0 when unset.
   */

  private transportTickNow(): number {
    try {
      const tick = this.getTransportTick?.() ?? 0;
      return Number.isFinite(tick) && tick >= 0 ? tick : 0;
    } catch {
      return 0;
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
    this.clipSourceMeta.clear();
  }

  /**
   * LIVE-EDITING FLUSH — de-click-cancel every clip one-shot whose clip is
   * gone from (or has moved within) the current document — or whose mute
   * state flipped (B3): muting a sounding clip must silence it NOW, exactly
   * like a delete, and unmuting lets the resume pass pick the clip back up.
   *
   * The scheduler re-plans from the new document at the next 25 ms window,
   * but one-shot sources already handed to the WebAudio clock keep sounding
   * to their ORIGINALLY scheduled stop: deleting a multi-bar clip during
   * playback left it ringing for seconds, and a moved clip kept sounding at
   * its old spot. Called by the doc-change sync while playing; returns the
   * ids of clips still legitimately sounding (unchanged id + timeline
   * geometry + mute state), which the resume pass must not double-trigger.
   */
  cancelOrphanedClipSources(): Set<string> {
    const survivors = new Set<string>();
    if (this.clipSourceMeta.size === 0) return survivors;
    const live = new Map<string, { startBar: number; lengthBars: number; muted?: boolean }>();
    for (const clip of this.doc ? audioClipsForPlayback(this.doc.arrangement) : []) {
      live.set(clip.id, clip);
    }
    const now = this.currentTime;
    for (const [source, meta] of this.clipSourceMeta) {
      const current = live.get(meta.clipId);
      // A muted clip no longer reaches this map (audioClipsForPlayback
      // filters it) — current === undefined covers mute-while-playing; the
      // meta.muted check is the belt-and-suspenders for legacy call shapes.
      if (
        current &&
        !current.muted &&
        !meta.muted &&
        current.startBar === meta.startBar &&
        current.lengthBars === meta.lengthBars
      ) {
        survivors.add(meta.clipId);
        continue;
      }
      // Orphaned: drop the envelope over ~12 ms (3τ) before the hard stop at
      // +50 ms — a bare source.stop() would click at an arbitrary waveform
      // phase. cancelScheduledValues first so scheduled fade ramps cannot
      // fight the ramp-down (a mid-fade cancel can step to the ramp's start
      // value; the 4 ms time-constant masks it).
      try {
        meta.gainNode.gain.cancelScheduledValues(now);
        meta.gainNode.gain.setTargetAtTime(0, now, 0.004);
      } catch {
        /* node already disconnected */
      }
      try {
        source.stop(now + 0.05);
      } catch {
        /* already stopped */
      }
      this.clipSourceMeta.delete(source);
    }
    return survivors;
  }

  panic(): void {
    const ctx = this.ctx;
    if (!ctx) {
      // Even with no live context, internal voice / LFO / frozen-buffer
      // Maps must be cleared so the next play() does not dispatch into
      // stale state. A panic is a hard reset — "everything off, now".
      this.triggerEngine.hardClearVoices();
      this.previewDeck.disposeAll();
      this.stopOneShotSources();
      this.warpManager.disposeAllFrozen();
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
    this.triggerEngine.panicVoices(now);
    this.warpManager.disposeAllFrozen(now);
    for (const state of this.instruments.values()) state.runtime.panic();
  }

  /** Apply a MIDI CC value directly to a target parameter. */
  /** Apply a pitch bend offset (in semitones) to an instrument track. */

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

  /** PRE-fader read (post-insert, pre-pan/fader) — see MeteringRig. */
  getTrackPreMeterSnapshot(trackId: string): TrackMeterSnapshot {
    return this.metering.getTrackPreMeterSnapshot(trackId);
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
    collect(MASTER_EFFECT_OWNER_ID, this.masterFx);
    for (const [id, nodes] of this.trackNodes) collect(id, nodes.fx);
    for (const [id, nodes] of this.groupNodes) collect(id, nodes.fx);
    for (const [id, nodes] of this.returnNodes) collect(id, nodes.fx);
    for (const { id, reason } of this.automation.degradedLfos()) {
      const host = this.doc?.lfos.find((l) => l.id === id)?.trackId ?? "";
      out.push({ trackId: host, fxId: id, reason });
    }
    return out;
  }

  /** Built-in master processors using reduced or bypass fallbacks. */
  getDegradedMasterStages(): {
    stageId: "tape" | "glue" | "limiter" | "monitorBypass";
    reason: string;
  }[] {
    return this.masterChain.getDegradedStages();
  }

  /** Latest gain reduction in dB reported by an effect runtime (metering). */
  getFxGainReductionDb(trackId: string, fxId: string): number | null {
    const rt =
      (trackId === MASTER_EFFECT_OWNER_ID ? this.masterFx.runtimes.get(fxId) : undefined) ??
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
      (trackId === MASTER_EFFECT_OWNER_ID ? this.masterFx.runtimes.get(fxId) : undefined) ??
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
      (trackId === MASTER_EFFECT_OWNER_ID ? this.masterFx.runtimes.get(fxId) : undefined) ??
      this.trackNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.groupNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId);
    if (!rt?.clearUserIr) throw new Error("This effect cannot load impulse responses");
    rt.clearUserIr();
  }

  /** Live meter snapshot from an effect runtime ( Ultina spectrum/LUFS/masking…). */
  getFxMeters(trackId: string, fxId: string): unknown {
    const rt =
      (trackId === MASTER_EFFECT_OWNER_ID ? this.masterFx.runtimes.get(fxId) : undefined) ??
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
      this.returnNodes.get(trackId)?.fx.runtimes.get(fxId) ??
      (trackId === MASTER_EFFECT_OWNER_ID ? this.masterFx.runtimes.get(fxId) : undefined);
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
    nodes.gain.gain.setTargetAtTime(audible ? clampFaderGain(gain) : 0, this.ctx.currentTime, 0.01);
  }

  /** Live send-level preview (mirrors syncSends' write; commit is setTrackSend). */
  previewTrackSend(trackId: string, returnId: string, level: number): void {
    const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
    const sendGain = nodes?.sends.get(returnId);
    if (!sendGain || !this.ctx) return;
    sendGain.gain.setTargetAtTime(clampSendLevel(level), this.ctx.currentTime, 0.01);
  }

  previewTrackPan(trackId: string, pan: number): void {
    const nodes = this.trackNodes.get(trackId) ?? this.groupNodes.get(trackId);
    if (!nodes || !this.ctx) return;
    nodes.panner.pan.setTargetAtTime(clampPanValue(pan), this.ctx.currentTime, 0.01);
  }

  previewReturnGain(returnId: string, gain: number): void {
    const nodes = this.returnNodes.get(returnId);
    if (!nodes || !this.ctx) return;
    nodes.gain.gain.setTargetAtTime(clampFaderGain(gain), this.ctx.currentTime, 0.01);
  }

  previewMasterGain(masterGain: number): void {
    // applyMasterConfig combines the fader with the persisted loudness trim —
    // route through it so the preview matches the committed write exactly.
    // Clamp mirrors the authoritative master domain (0..2, clampMasterGain):
    // the old 1.5 here made an imported 1.8 fader flicker between preview and
    // commit, and Math.min/max pass NaN through — a NaN ask would throw
    // inside the chain's setTargetAtTime.
    if (!this.masterChain.input || !this.doc || !this.ctx) return;
    if (!Number.isFinite(masterGain)) return;
    this.masterChain.applyMasterConfig({ ...this.doc.master, masterGain: Math.min(2, Math.max(0, masterGain)) });
  }

  /**
   * Studio I/O panel: a short quiet tone straight to the destination — a
   * DEVICE test, deliberately bypassing the mixer so project state (mutes,
   * master trim, limiter) can never mask a dead output. Invariant #7
   * discipline: the nodes are created here on the engine's own context and
   * disposed; the panel never touches a raw context. 440 Hz at −24 dBFS,
   * 10 ms fade edges — audible but polite.
   */
  playTestTone(durationSec = 0.45): { status: "ok" | "error"; message?: string } {
    if (!this.ctx || this.ctx.state === "closed" || !isLiveAudioContext(this.ctx)) {
      return { status: "error", message: "No active audio context — start playback once first" };
    }
    const ctx = this.ctx;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      osc.type = "sine";
      const now = ctx.currentTime;
      const end = now + Math.max(0.05, Math.min(2, durationSec));
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.01);
      gain.gain.setValueAtTime(0.06, end - 0.01);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain).connect(ctx.destination);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(now);
      osc.stop(end);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
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

  /**
   * Live audio-thread load / xrun probe (release-gate hardening). Null while
   * no RT Monitor is attached (worklet module unavailable / no live context).
   * The snapshot is the honest in-process proxy for device xruns: worst wall
   * time inside one render quantum vs the 128/sampleRate budget, plus the
   * worst wall gap between consecutive callbacks.
   */
  getRtLoad(): import("../audio-worklets/rt-monitor-node").RtMonitorSnapshot | null {
    return this.metering.getRtLoad();
  }

  resetRtLoad(): void {
    this.metering.resetRtLoad();
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
    const rt = this.metering.getRtLoad();
    return {
      contextState: this.ctx?.state ?? "not-created",
      sampleRate: this.ctx?.sampleRate ?? "-",
      activeVoices: this.triggerEngine.voiceCount,
      loadedSamples: this.bank?.size ?? 0,
      activeEffects: effectCount,
      activeInstruments: this.instruments.size,
      activeLfos: this.automation.lfoCount,
      returns: this.returnNodes.size,
      automationLanes: this.doc?.automation.length ?? 0,
      missingAssets: this.missingAssets.join(", ") || "none",
      // Audio-thread health: quanta the device actually dropped, plus the
      // main-thread delivery jitter of the worklet heartbeat. "n/a" (never a
      // fabricated 0) while no RT Monitor is attached.
      rtQuantumMs: rt ? Number(rt.quantumMs.toFixed(3)) : "n/a",
      rtBlocks: rt ? rt.blocks : "n/a",
      rtXruns: rt ? rt.xruns : "n/a",
      rtHeartbeatGapMs: rt && rt.heartbeats > 1 ? Number(rt.avgGapMs.toFixed(2)) : "n/a",
      rtMaxGapMs: rt ? Number(rt.maxGapMs.toFixed(2)) : "n/a",
    };
  }
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
