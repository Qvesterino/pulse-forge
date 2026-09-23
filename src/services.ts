import { AudioEngine } from "./audio-engine/AudioEngine";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { ticksPerBar } from "./project-model/schema";
import { ProjectStore } from "./store/ProjectStore";
import { ProjectRepository } from "./persistence/ProjectRepository";
import { SnapshotRepository, shouldAutoSnapshot } from "./persistence/SnapshotRepository";
import { PresetRepository } from "./persistence/PresetRepository";
import { LibraryRepository } from "./persistence/LibraryRepository";
import { KitRepository } from "./persistence/KitRepository";
import { GroovePoolRepository } from "./persistence/GroovePoolRepository";
import { installSaveUnloadGuards } from "./persistence/save-lifecycle";
import { processorErrorCount } from "./audio-worklets/processor-errors";
import type {
  IFrozenBufferRepository,
  IGroovePoolRepository,
  IKitRepository,
  ILibraryRepository,
  IPresetRepository,
  IProjectRepository,
  IRecordingRecoveryRepository,
  ISnapshotRepository,
  IUserSampleRepository,
} from "./persistence/contracts";
import { createAutosaveDebouncer } from "./persistence/autosave-debouncer";
import { generateFactoryBank } from "./sample-library/factory";
import type { SampleBank } from "./sample-library/factory";
import type { PlayMode, ProjectDocument, Scene } from "./project-model/types";
import { BAR_TICKS, PPQ } from "./project-model/types";
import { setActivePattern, unfreezeTrack } from "./commands/commands";
import { MidiInput } from "./midi/MidiInput";
import { PatternRecorder } from "./midi/patternRecorder";
import { recordPlayActivity } from "./ui/playActivity";
import { MidiOutput } from "./midi/MidiOutput";
import { MidiClock } from "./midi/MidiClock";
import { UserSampleRepository, restoreUserSampleAudioMemoized } from "./persistence/UserSampleRepository";
import { RecordingRecoveryRepository } from "./persistence/RecordingRecoveryRepository";
import { ensureCuratedLayer } from "./sample-library/curated";
import { FrozenBufferRepository, restoreFrozenTracks } from "./persistence/FrozenBufferRepository";
import { ensureWorkletsForDoc } from "./audio-worklets/loader";
import type { YDocStore } from "./collab/YDocStore";
import type { CollabSession } from "./collab/CollabSession";
import { collabParamsFromSearch } from "./collab/collabShared";
import type { BandmateControls } from "./collab/bandmate";
import { createBandmate } from "./collab/bandmate";
import { createUnavailableGenerativeProvider, GenerativeProviderRegistry } from "./generative/registry";
import { GenerativeLatencyCalibrationController } from "./generative/latency";
import { GenerativeRuntime } from "./generative/runtime";
import { bindGenerativeContextLifecycle } from "./generative/context-lifecycle";
import {
  applyTransportState,
  captureTransportState,
  shouldStartRemoteScheduler,
  type SharedTransportState,
} from "./collab/transportSync";
import { LatencyCalibrationController } from "./audio-engine/latencyCalibration";
import { ArrangementCaptureController } from "./arrangement/capture";
import { GhostPreviewPlayer } from "./audio-engine/GhostPreviewPlayer";
import { NoteRepeatController } from "./audio-engine/NoteRepeat";

/**
 * Long-lived services shared across projects: the audio engine (one shared
 * AudioContext — no re-unlock needed when switching projects), the factory
 * sample bank, and persistence repositories.
 */
export interface CoreServices {
  engine: AudioEngine;
  bank: SampleBank;
  /** Provider implementations are host capabilities, never project state. */
  generativeProviders?: GenerativeProviderRegistry;
  /** Host-local provider warm-up/control measurements; never project state. */
  generativeLatency?: GenerativeLatencyCalibrationController;
  repo: IProjectRepository;
  snapshots: ISnapshotRepository;
  presets: IPresetRepository;
  library: ILibraryRepository;
  userKits: IKitRepository;
  groovePool: IGroovePoolRepository;
  latency: LatencyCalibrationController;
}

export interface Services {
  /**
   * Instant Jam: re-anchor the local transport to the last received remote
   * pulse. Used by the TAP TO JAM gate after the audio context resumes
   * (a joiner landing mid-jam hears the room from the leader's NOW).
   */
  sharedTransportReapply?: () => void;
  /** Instant Jam AI bandmate (drums) — present when a collab session runs. */
  bandmate?: BandmateControls;
  core: CoreServices;
  /** Plain local store, or a CRDT store while a collab session is active. */
  store: ProjectStore | YDocStore;
  engine: AudioEngine;
  generativeProviders: GenerativeProviderRegistry;
  /** Provider/audio bridge for live generative tracks and capture. */
  generativeRuntime: GenerativeRuntime;
  generativeLatency?: GenerativeLatencyCalibrationController;
  transport: Transport;
  scheduler: Scheduler;
  repo: IProjectRepository;
  bank: SampleBank;
  library: ILibraryRepository;
  userKits: IKitRepository;
  groovePool: IGroovePoolRepository;
  playback: PlaybackController;
  midi: MidiInput;
  /** Live MIDI record-to-pattern controller (record arm + overdub/replace). */
  patternRecorder: PatternRecorder;
  /** App re-points getSelectedTrackId after mount — live MIDI follows it. */
  selectionBridge: {
    getSelectedTrackId: () => string | null;
    /** Resolved perform target: selected instrument track, else the first. */
    getPerformTrackId: () => string | null;
  };
  midiOutput: MidiOutput;
  midiClock: MidiClock;
  userSamples: IUserSampleRepository;
  recordingRecovery: IRecordingRecoveryRepository;
  frozenAudio: IFrozenBufferRepository;
  latency: LatencyCalibrationController;
  capture: ArrangementCaptureController;
  ghost: GhostPreviewPlayer;
  /** Live Note Repeat pad-mode (holds from pads, QWERTY keys or MIDI notes). */
  noteRepeat: NoteRepeatController;
  /** Live when a collab session is active, null otherwise. */
  collab: CollabSession | null;
  flushSave(): Promise<void>;
  /** Stop playback, flush autosave and detach page listeners. */
  closeProject(): Promise<void>;
  getDiagnostics(): Record<string, string | number | boolean>;
}

export class PlaybackController {
  private listeners = new Set<() => void>();
  /** Late-bound (constructed after the controller): seek re-anchors held rolls. */
  private noteRepeatRef: NoteRepeatController | null = null;
  /** Late-bound: stop/seek cancel future-timed MIDI sends (ghost hits). */
  private midiOutputRef: MidiOutput | null = null;

  constructor(
    private engine: AudioEngine,
    private transport: Transport,
    private scheduler: Scheduler,
    private modeRef: { mode: PlayMode },
    private projectRef: () => ProjectDocument,
    private applyPattern: (patternId: string) => void,
    private onSceneLaunch?: (sceneId: string, currentTick: number) => void,
    private onTransportStop?: (currentTick: number) => void,
    private onTransportPause?: () => void,
  ) {}

  private generativeLifecycle: {
    start: () => void;
    pause: () => void;
    stop: () => void;
    seek: () => void;
  } | null = null;

  attachGenerativeLifecycle(lifecycle: {
    start: () => void;
    pause: () => void;
    stop: () => void;
    seek: () => void;
  }): void {
    this.generativeLifecycle = lifecycle;
  }

  /** Audit 03 D2 — seek/stop must re-anchor live note-repeat holds. */
  attachNoteRepeat(noteRepeat: NoteRepeatController): void {
    this.noteRepeatRef = noteRepeat;
  }

  /** Audit 03 D5 — stop/seek must cancel future-timed MIDI sends. */
  attachMidiOutput(midiOutput: MidiOutput): void {
    this.midiOutputRef = midiOutput;
  }

  setMode = (mode: PlayMode): void => {
    if (this.modeRef.mode === mode) return;
    this.modeRef.mode = mode;
    this.notify();
  };

  /** Play-mode getter for UI mirrors. */
  get mode(): PlayMode {
    return this.modeRef.mode;
  }

  /**
   * Re-broadcast the mode/transport to UI subscribers after an OUTSIDE
   * mutation of the transport (collab remote pulse). The controller's own
   * methods notify internally; direct transport writes otherwise left the
   * TopBar play button stale until the next local gesture.
   */
  notifyForRemoteTransportChange = (): void => {
    this.notify();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PlayMode => this.modeRef.mode;

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  playPause = (): void => {
    // Preview voices are an audition surface, not part of the timeline. Do
    // not let a preset/sample audition survive into transport playback.
    this.engine.stopPreview?.();
    this.engine.ensureContext();
    if (this.transport.playing) {
      this.scheduler.stop();
      this.engine.panic();
      this.transport.pause();
      this.onTransportPause?.();
      this.generativeLifecycle?.pause();
    } else {
      // Lead-in: start playback early so the metronome clicks (pre-roll +
      // count-in bars) lead into the requested position (content starts at
      // anchor + lead-in).
      const leadInTicks = this.transport.leadInTicks();
      const requested = Math.max(0, this.transport.position);
      if (!this.transport.paused && leadInTicks > 0 && requested >= leadInTicks) {
        this.transport.play(requested - leadInTicks);
      } else if (!this.transport.paused && requested > 0 && leadInTicks > 0) {
        // There is not enough timeline before the requested position to fit a
        // complete lead-in. Keep the user's exact location instead of
        // silently moving content forward by another lead-in.
        this.transport.play(requested, { leadIn: false });
      } else {
        this.transport.play();
      }
      const pos = ((this.transport.position % PPQ) + PPQ) % PPQ;
      const beatPhase = pos / PPQ;
      this.engine.transportStarted(this.engine.currentTime, beatPhase, this.transport.position / PPQ);
      // Frozen playback is transport-aware: sources are torn down by
      // panic() on pause/stop and resurrected here on every play.
      this.engine.restartFrozenSources(this.transport.position);
      this.scheduler.start();
      this.generativeLifecycle?.start();
    }
    this.notify();
  };

  stop = (): void => {
    this.engine.stopPreview?.();
    this.onTransportStop?.(this.transport.position);
    this.scheduler.stop();
    this.engine.panic();
    this.engine.automationReset();
    // Audit 03 D5: drop future-timed MIDI note-ons (ghost hits at the old
    // musical time); flush their pending note-offs so nothing hangs.
    this.midiOutputRef?.cancelPending();
    this.transport.stop();
    this.onTransportPause?.();
    this.generativeLifecycle?.stop();
    this.notify();
  };

  /** Seek the transport and re-align the scheduler (safe while playing). */
  seek = (tick: number): void => {
    this.transport.seek(Math.max(0, tick));
    if (this.transport.playing) {
      this.engine.panic();
      // Audit 03 D1: panic() kills voices but not AudioParam timelines —
      // pre-seek windows left automation/modulator writes up to a lookahead
      // (~120 ms) ahead, which fired between the post-seek writes as an
      // audible snap-back. Cancel them; the next scheduler window (≤25 ms)
      // re-lands fresh values from the new position.
      this.engine.automationReset();
      // Audit 03 D2: held note-repeat rolls re-anchor to the new position —
      // a stale nextTick muted the roll until the playhead climbed back.
      this.noteRepeatRef?.reanchorToTransport();
      // Audit 03 D5: same ghost-hit cleanup as stop (pending MIDI sends).
      this.midiOutputRef?.cancelPending();
      const pos = ((this.transport.position % PPQ) + PPQ) % PPQ;
      this.engine.transportStarted(this.engine.currentTime, pos / PPQ, this.transport.position / PPQ);
      this.engine.restartFrozenSources(this.transport.position);
      this.scheduler.resync();
      this.generativeLifecycle?.seek();
    }
    this.notify();
  };

  /**
   * Launch a scene: while stopped it activates the scene's pattern right away;
   * while playing it queues the switch for the next bar boundary (quantized).
   */
  launchScene = (scene: Scene): void => {
    if (this.modeRef.mode === "song") {
      // In song mode the arrangement owns pattern selection — jump to the
      // first clip that uses this scene instead of fighting the timeline.
      const doc = this.projectRef();
      const clip = [...doc.arrangement.clips]
        .sort((a, b) => a.startBar - b.startBar)
        .find((c) => c.sceneId === scene.id);
      if (clip) this.seek(clip.startBar * BAR_TICKS);
      return;
    }
    if (!this.transport.playing) {
      this.onSceneLaunch?.(scene.id, this.transport.position);
      this.applyPattern(scene.patternId);
      this.notify();
      return;
    }
    const nextBar = (Math.floor(this.transport.position / BAR_TICKS) + 1) * BAR_TICKS;
    this.onSceneLaunch?.(scene.id, this.transport.position);
    this.scheduler.queuePatternLaunch(scene.patternId, nextBar);
    this.notify();
  };
}

export async function createCoreServices(): Promise<CoreServices> {
  const bank = await generateFactoryBank();
  const engine = new AudioEngine();
  const generativeProviders = new GenerativeProviderRegistry();
  generativeProviders.register(
    createUnavailableGenerativeProvider("mrt2", "MRT2 native bridge is not installed on this host", "mrt2_small"),
  );
  engine.attachBank(bank);
  // Re-decode persisted user-sample audio into the bank (fire-and-forget —
  // the app is fully usable while imports stream back in). Memoized per bank:
  // the offline renderer awaits the same promise (bounded) so an export or
  // freeze that races the restore cannot silently bake missing samples.
  void restoreUserSampleAudioMemoized(bank).catch((error) => {
    console.error("[user-samples] boot restore failed:", error);
  });
  // Curated factory layer (same-id override): the synthesized kit already
  // sounds; these progressively replace the curated slots as they decode.
  // Export paths await `curatedReady()` so renders use the intended sound.
  void ensureCuratedLayer(bank);
  const library = new LibraryRepository();
  // Audit 14 D1: best-effort durable storage - without persist() iOS Safari
  // may evict ALL projects after ~7 days of non-use. Silent if refused.
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* unsupported - best-effort only */
  }
  const userKits = new KitRepository();
  const groovePool = new GroovePoolRepository();
  void library.load();
  return {
    engine,
    bank,
    generativeProviders,
    generativeLatency: new GenerativeLatencyCalibrationController(),
    repo: new ProjectRepository(),
    snapshots: new SnapshotRepository(),
    presets: new PresetRepository(),
    library,
    userKits,
    groovePool,
    latency: new LatencyCalibrationController(),
  };
}

export interface OpenProjectOptions {
  /** Start a collab session (explicit) — otherwise ?collab= in the URL is used. */
  collab?: { roomId: string; serverUrl: string };
}

/**
 * Build per-project services around the shared core. The engine is reused
 * across projects (its `setProject` diff handles full project swaps), so
 * switching projects never re-creates the AudioContext.
 *
 * With `collab` (or a ?collab=<room> URL param) the store is a CRDT-backed
 * YDocStore synced over y-websocket; remote edits flow back through the
 * same onDocChanged path as local ones.
 */
export async function openProject(
  core: CoreServices,
  initial: ProjectDocument,
  options: OpenProjectOptions = {},
): Promise<Services> {
  /** Audit 13 INFO: collab sync-guard handle — cleared in closeProject. */
  let syncGuardTimerRef: ReturnType<typeof setTimeout> | null = null;
  const generativeProviders = core.generativeProviders ?? new GenerativeProviderRegistry();
  const { engine, repo, bank, library, userKits, groovePool, latency, snapshots } = core;
  const generativeLatency = core.generativeLatency ?? new GenerativeLatencyCalibrationController();

  const collabConfig =
    options.collab ?? (typeof location !== "undefined" ? collabParamsFromSearch(location.search) : null);
  // yjs + y-websocket ship only in the collab chunk — loaded on demand, so
  // solo sessions never download ~300 KB of CRDT runtime.
  let store: ProjectStore | YDocStore = new ProjectStore(initial);
  let collab: CollabSession | null = null;
  let sharedTransportReapply: (() => void) | undefined = undefined;
  if (collabConfig) {
    const [{ YDocStore: YDocStoreImpl }, { CollabSession: CollabSessionImpl }] = await Promise.all([
      import("./collab/YDocStore"),
      import("./collab/CollabSession"),
    ]);
    // Deferred seed-vs-adopt: the local document is only written into the
    // room when first sync shows the room EMPTY. A joiner opening a room
    // that already lives adopts the remote content instead — an identical
    // re-seed would clobber edits made before they arrived (Instant Jam).
    // Until first sync resolves, the store BUFFERS local commands (the
    // pre-sync window would otherwise fragment the empty map or self-seed
    // the room and defeat the adopt decision).
    store = YDocStoreImpl.empty(initial);
    collab = new CollabSessionImpl((store as YDocStore).yDocRef, collabConfig.roomId, collabConfig.serverUrl);
    syncGuardTimerRef = setTimeout(() => {
      // Relay unreachable — degrade to the old self-seeding behavior rather
      // than wedging editing behind a buffered queue forever.
      (store as YDocStore).markSyncFailed();
    }, 8_000);
    collab.onFirstSync((hasRemote) => {
      if (syncGuardTimerRef) clearTimeout(syncGuardTimerRef);
      if (hasRemote) {
        // Offline-adopt safety net (GOAL 06): edits made while the websocket
        // was down live only in this tab's local copy — adopting the room
        // replaces that document wholesale, which would silently drop them.
        // Park the pre-adopt state as a snapshot (best-effort, deliberately
        // OUTSIDE the 30-min auto-snapshot throttle — this is rarer and more
        // valuable than a routine auto-snapshot).
        void snapshots
          .save(initial.id, initial, "auto — before collab adopt")
          .then(() => snapshots.prune(initial.id))
          .catch(() => {});
        (store as YDocStore).adoptRemote();
      } else {
        (store as YDocStore).hydrate(initial);
      }
      (store as YDocStore).markSynced();
    });
    // Jam roles: gate local commands on the session role and surface refusals.
    (store as YDocStore).roleProvider = () => collab?.localRole ?? null;
    (store as YDocStore).onRoleBlocked = (commandType, role) => {
      console.warn(`[jam] role "${role}" cannot run "${commandType}"`);
    };
  }
  collab?.connect();

  // Snapshot safety net — "restore to yesterday". One snapshot at session
  // start, then daily ones riding the save path. Full-document copies,
  // pruned to the newest 20 per project; failures are silently ignored
  // (the safety net must never take the app down).
  let lastSnapCheck = 0;
  const maybeAutoSnapshot = (label: string): void => {
    const now = Date.now();
    if (now - lastSnapCheck < 30 * 60 * 1000) return; // at most one DB check per 30 min
    lastSnapCheck = now;
    void (async () => {
      try {
        const newest = await snapshots.list(store.doc.id, 1);
        if (!shouldAutoSnapshot(newest[0]?.createdAt)) return;
        await snapshots.save(store.doc.id, store.doc, label);
        await snapshots.prune(store.doc.id);
      } catch {
        /* best-effort */
      }
    })();
  };
  maybeAutoSnapshot("Auto — session start");

  const transport = new Transport({ now: () => engine.currentTime }, initial.bpm);
  transport.setBarTicks(ticksPerBar(initial));
  // Transport-synced previews quantize to the next bar relative to the live
  // playhead — the engine has no Transport reference, so hand it the reader.
  engine.getTransportTick = () => transport.position;
  const modeRef: { mode: PlayMode } = { mode: "pattern" };
  const midiOutput = new MidiOutput();
  const midiClock = new MidiClock();
  const capture = new ArrangementCaptureController(
    () => store.doc,
    (command) => store.execute(command),
    () => transport.position,
  );
  // The scheduler speaks AudioContext seconds; scheduled MIDI sends are a
  // delay-from-now. Events already due (negative delay) go out immediately.
  const midiDelayMs = (when: number | undefined): number =>
    when === undefined || !Number.isFinite(when) ? 0 : Math.max(0, (when - engine.currentTime) * 1000);
  const scheduler = new Scheduler({
    getProject: () => store.doc,
    getTransport: () => transport,
    getAudioTime: () => engine.currentTime,
    getScheduleOffsetSec: () => latency.getSnapshot().midiReferenceOffsetMs / 1000,
    // Defect A02.D1 (browser audio lifecycle audit): the scheduler
    // gates its tick() on the live AudioContext state to prevent a
    // "machine gun" burst of every missed event when the context
    // resumes after visibility / screen lock / OS sleep. Without this
    // getter the gate is dead code and the burst slips through.
    getContextState: () => engine.context?.state ?? "closed",
    getMode: () => modeRef.mode,
    trigger: (trackId, pad, when, velocity, locks) => engine.trigger(trackId, pad, when, velocity, locks),
    noteOn: (trackId, pitch, velocity, when, durationSec, slideFromTick, slideFromPitch, locks, slideFromWhen) =>
      engine.noteOn(trackId, pitch, velocity, when, durationSec, slideFromTick, slideFromPitch, locks, slideFromWhen),
    triggerAudioClip: (clip, when, durationSec) => engine.triggerAudioClip(clip, when, durationSec),
    metronomeClick: (when, downbeat) => engine.click(when, downbeat),
    recordCapturedEvent: (event) => capture.recordEvent(event),
    applyAutomation: (fromTick, toTick, relOf, scheduleOffsetSec, timeAt) =>
      engine.applyAutomation(fromTick, toTick, relOf, scheduleOffsetSec, timeAt),
    applyModulators: (fromTick, toTick, whenFor) => engine.applyModulators(fromTick, toTick, whenFor),
    applyEnvFollowers: () => engine.applyEnvFollowersToParams(),
    applySceneAutomationLane: (lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec, timeAt) =>
      engine.applySceneAutomationLane(lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec, timeAt),
    applyPatternLaunch: (patternId) => store.execute(setActivePattern(store.doc, patternId)),
    triggerMarker: (assetId, when, trackId) => engine.triggerMarker(assetId, when, trackId),
    setSceneIntensity: (value) => engine.setSceneIntensity(value),
    scheduleSceneIntensity: (points, timeAt) => engine.scheduleSceneIntensity(points, timeAt),
    // Scene tempo lane: clips whose scene pins a BPM drive the transport
    // (setBpm re-anchors position-preserving); null = project tempo. The
    // engine's tempo-synced runtimes follow the same effective tempo.
    applySceneTempo: (bpm) => {
      const effective = bpm ?? store.doc.bpm;
      transport.setBpm(effective);
      engine.setEffectiveBpm(effective);
    },
    // Tempo-seam flip commit: the transport re-anchors at the boundary via
    // setBpmAnchored; the engine's SYNC-delay/LFO runtimes flip with it.
    applyEngineTempo: (bpm) => engine.setEffectiveBpm(bpm),
    // MIDI out: the scheduler hands us the precise AudioContext time for the
    // event — convert it to a delay so hardware receives note on/off on the
    // musical timeline (previously both fired immediately, making drum hits
    // clicks and sustained notes inaudible).
    midiNoteOn: (_trackId, channel, note, velocity, when) => {
      const doc = store.doc;
      const instTrack = doc.tracks.find((t) => t.id === _trackId && t.kind === "instrument");
      if (instTrack?.kind === "instrument" && instTrack.midiOutput?.enabled) {
        const ch = instTrack.midiOutput.channel || channel + 1;
        midiOutput.sendNoteOn(ch - 1, note, velocity, midiDelayMs(when));
      }
    },
    midiNoteOff: (_trackId, channel, note, when) => {
      const doc = store.doc;
      const instTrack = doc.tracks.find((t) => t.id === _trackId && t.kind === "instrument");
      if (instTrack?.kind === "instrument" && instTrack.midiOutput?.enabled) {
        const ch = instTrack.midiOutput.channel || channel + 1;
        midiOutput.sendNoteOff(ch - 1, note, 0, midiDelayMs(when));
      }
    },
  });
  engine.setProject(store.doc);
  // Pre-load AudioWorklet modules (fire-and-forget — factories fall back
  // to bypass/fallback until modules are ready, then the engine rebuilds
  // the chains on the next syncProject cycle). The vendored plugin suites
  // load only when this project references them.
  // ensureContext() throws SYNCHRONOUSLY when the browser refuses a realtime
  // context (audio device loss, iOS context cap, blocked embed). A preload
  // optimization must not fail the whole project open — the engine is lazy
  // and the first real user gesture retries through playPause.
  try {
    void ensureWorkletsForDoc(store.doc, engine.ensureContext());
  } catch (error) {
    console.error("[openProject] AudioContext unavailable at open — worklet preload deferred:", error);
  }
  transport.seek(0);
  const playback = new PlaybackController(
    engine,
    transport,
    scheduler,
    modeRef,
    () => store.doc,
    (patternId) => store.execute(setActivePattern(store.doc, patternId)),
    (sceneId, currentTick) => capture.recordSceneLaunch(sceneId, currentTick),
    (currentTick) => {
      void currentTick;
      capture.finish();
      patternRecorder.onTransportInterrupted();
    },
    () => {
      capture.markPause();
      patternRecorder.onTransportInterrupted();
    },
  );
  let generativeRuntimeRef: GenerativeRuntime | null = null;

  if (collab) {
    // ── Shared transport (Instant Jam pulse) ─────────────────────────────
    // User gestures on the local transport broadcast the anchor over the
    // awareness channel; remote pulses re-anchor the local transport to the
    // same wall-clock timeline. The follow path mirrors PlaybackController's
    // pause/stop bookkeeping (scheduler stop + panic) so a remote stop does
    // not leave scheduled notes ringing. `followLock` keeps the follower's
    // own re-anchoring from rebroadcasting (echo loop).
    let followLock = false;
    let lastAppliedAt = 0;
    let lastPulse: SharedTransportState | null = null;
    transport.onGesture = () => {
      if (followLock) return;
      collab.setSharedTransport(captureTransportState(transport, collab.clientID));
    };
    collab.subscribeSharedTransport((state) => {
      if (!state || state.by === collab.clientID) return;
      if (state.at <= lastAppliedAt) return; // stale pulse
      lastAppliedAt = state.at;
      lastPulse = state;
      followLock = true;
      try {
        const wasPlaying = transport.playing;
        const shouldStartScheduler = shouldStartRemoteScheduler(wasPlaying, state.playing);
        if (!state.playing) {
          scheduler.stop();
          engine.panic();
          generativeRuntimeRef?.stopAll().catch((err) => console.warn("[generative] remote stopAll failed:", err));
        }
        applyTransportState(transport, state, Date.now() / 1000);
        if (shouldStartScheduler) {
          scheduler.start();
          generativeRuntimeRef?.startAll().catch((err) => console.warn("[generative] remote startAll failed:", err));
        } else if (wasPlaying && state.playing) scheduler.resync();
        // A REMOTE pulse mutates the transport from outside the controller —
        // without this, the TopBar play button (and every playback
        // subscriber) stayed stale until the next local gesture.
        playback.notifyForRemoteTransportChange();
      } finally {
        followLock = false;
      }
    });
    // TAP TO JAM: after the gate resumes the context, re-anchor to the last
    // known pulse so a mid-jam joiner hears the room from the leader's NOW.
    sharedTransportReapply = () => {
      if (!lastPulse) return;
      followLock = true;
      try {
        applyTransportState(transport, lastPulse, Date.now() / 1000);
        if (lastPulse.playing) void generativeRuntimeRef?.startAll();
      } finally {
        followLock = false;
      }
    };
  }

  let bandmate: BandmateControls | undefined;
  if (collab) {
    bandmate = createBandmate({
      store,
      transport,
      roomId: collab.roomId,
      getMode: () => (modeRef.mode === "song" ? "song" : "pattern"),
    });
  }

  // Test/debug hook: the browser checks read the live store/transport after
  // a real boot through ?import=<code>&collab=<room>.
  if (collab) {
    (window as unknown as { __pfJam: unknown }).__pfJam = { store, collab, transport, playback, bandmate };
  }

  const midi = new MidiInput();
  // The bandmate listens to performed MIDI notes — call & response.
  midi.onInstrumentNote = (pitch) => bandmate?.noteHeard(pitch);
  const userSamples = new UserSampleRepository();
  const recordingRecovery = new RecordingRecoveryRepository();
  const frozenAudio = new FrozenBufferRepository();

  // Close-race guard (critical path audit): several fire-and-forget asyncs
  // started below resolve AFTER an awaited IndexedDB decode or a pending
  // MIDI permission prompt. If the user closes this project (or switches to
  // another one) before they land, their continuations must not touch the
  // shared engine or wire handlers into a dead store.
  let closed = false;

  // Live MIDI record-to-pattern (FL-style overdub): performed hits/notes land
  // in the active pattern at the transport's musical tick. Created before the
  // NoteRepeat controller — every performed drum hit (single or repeat) flows
  // through its fire callback and records here. The whole pass is one undo
  // frame (one Ctrl+Z removes the take).
  const patternRecorder = new PatternRecorder({
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    getTick: () => transport.tickAt(engine.currentTime + 0.005),
    isPlaying: () => transport.playing,
    // Audit 07 D3: count-in/pre-roll hits land before the content region —
    // record only from the content start onward (null while stopped; the
    // isPlaying gate already drops those).
    getContentStartTick: () => (transport.playing ? transport.anchorTickBeforePreRoll() : null),
    beginUndoFrame: (label) => store.beginUndoFrame(label),
    endUndoFrame: () => store.endUndoFrame(),
  });

  // Selected-track bridge: App re-points getSelectedTrackId to the workspace
  // selection after mount. Live MIDI play/recording routes to the selected
  // instrument track (falling back to the first one) — not blindly to the
  // first instrument in the doc.
  const selectionBridge = {
    getSelectedTrackId: (): string | null => null,
    getPerformTrackId: (): string | null => {
      const doc = store.doc;
      const selectedId = selectionBridge.getSelectedTrackId();
      const selected = selectedId ? doc.tracks.find((t) => t.id === selectedId && t.kind === "instrument") : undefined;
      return (selected ?? doc.tracks.find((t) => t.kind === "instrument"))?.id ?? null;
    },
  };

  // Live Note Repeat: pad/QWERTY/MIDI holds re-fire a drum pad on a grid
  // division. The fire callback resolves the pad fresh on every hit so mutes
  // and track deletions apply mid-hold without the controller knowing.
  // Every live hit — single or repeat — lands in the passive capture ring at
  // its grid tick, so "Capture last take" stamps performed fills as steps
  // (the ring previously only heard pattern playback from the scheduler).
  const noteRepeat = new NoteRepeatController({
    getTransport: () => transport,
    getAudioTime: () => engine.currentTime,
    fire: (trackId, padId, velocity, when) => {
      const track = store.doc.tracks.find((t) => t.id === trackId);
      if (!track || track.kind !== "drum" || track.mute) return;
      const pad = track.pads.find((p) => p.id === padId);
      if (!pad || pad.mute) return;
      engine.trigger(trackId, pad, when, velocity);
      const performedTick = Math.max(0, Math.round(transport.tickAt(when)));
      capture.recordEvent({
        trackId,
        padId,
        velocity,
        tick: performedTick,
      });
      recordPlayActivity({ padId });
      patternRecorder.drumHit(padId, velocity);
    },
  });
  midi.attachNoteRepeat(noteRepeat);
  midi.attachPatternRecorder(patternRecorder);
  midi.attachSelectionBridge(selectionBridge);
  playback.attachNoteRepeat(noteRepeat);
  playback.attachMidiOutput(midiOutput);
  midi.onNoteActivity = (pitch) => recordPlayActivity({ pitch });

  const generativeRuntime = new GenerativeRuntime({
    engine,
    transport,
    project: () => store.doc,
    providers: generativeProviders,
    bank,
    userSamples,
    execute: (command) => store.execute(command),
    latencyCalibration: generativeLatency,
  });
  generativeRuntimeRef = generativeRuntime;
  const generativeContextLifecycle = bindGenerativeContextLifecycle(
    engine,
    generativeRuntime,
    () => transport.playing,
    (operation, error) => console.warn(`[generative] context ${operation} failed:`, error),
  );
  const pauseGenerativeForContext = (): void => generativeContextLifecycle.pause();
  const resumeGenerativeAfterContext = (): void => generativeContextLifecycle.resume();
  playback.attachGenerativeLifecycle({
    start: () => {
      void generativeRuntime.startAll().catch((error) => {
        console.warn("[generative] live start failed:", error);
      });
    },
    pause: () => {
      void generativeRuntime.stopAll().catch((error) => {
        console.warn("[generative] pause failed:", error);
      });
    },
    stop: () => {
      void generativeRuntime.stopAll().catch((error) => {
        console.warn("[generative] stop failed:", error);
      });
    },
    seek: () => {
      void generativeRuntime.refreshAll().catch((error) => {
        console.warn("[generative] seek refresh failed:", error);
      });
    },
  });

  // Restore frozen-track audio (IndexedDB → bank) so frozen tracks survive
  // reloads. Tracks whose buffer is gone (cleared site data, other browser)
  // are auto-unfrozen — they play live instead of staying permanently silent.
  // Unreferenced stored buffers are GC'd here — but only buffers referenced
  // by NO project: the store is shared across all projects, so GC-ing by the
  // open document alone would delete every other project's frozen audio.
  void (async () => {
    try {
      const missing = await restoreFrozenTracks(store.doc, bank, frozenAudio);
      // The restore awaits IndexedDB reads + audio decodes; the project may
      // have been closed meanwhile. Re-running unfreeze commands on a dead
      // store and re-pointing the shared engine at THIS (stale) doc would
      // diverge the engine from the newly opened project.
      if (closed) return;
      for (const track of store.doc.tracks) {
        if ("frozen" in track && track.frozen && missing.includes(track.frozen.bufferId)) {
          // The track can disappear while we await above (collab peer edit,
          // rapid startup interaction) — skip instead of letting unfreezeTrack
          // throw and abort the whole restore path.
          if (!store.doc.tracks.some((t) => t.id === track.id)) continue;
          store.execute(unfreezeTrack(store.doc, track.id));
        }
      }
      const referenced = await repo.referencedFrozenBufferIds();
      if (closed) return;
      for (const entry of await frozenAudio.list()) {
        if (!referenced.has(entry.id)) await frozenAudio.remove(entry.id);
      }
    } catch (err) {
      // Restore is best-effort — never leave an unhandled rejection behind.
      console.warn("[services] frozen-audio restore failed:", err);
    } finally {
      if (!closed) engine.setProject(store.doc);
    }
  })();

  void midi.requestAccess().then((ok) => {
    // The Web MIDI permission prompt can outlive the project: a user may
    // close (or switch) while it is still open and only grant access later.
    // Wiring handlers into a closed project would drive the shared engine
    // and a dead store from stale MIDI input.
    if (!ok || closed) return;
    midi.start(
      engine,
      store,
      transport,
      () =>
        store.doc.midi ?? {
          enabled: false,
          deviceId: "",
          drumChannel: 0,
          instrumentChannel: 0,
          ccMappings: [],
          drumNoteMap: [],
          pitchBendRange: 2,
        },
      () => store.doc,
    );
    // Wire MIDI clock callbacks
    midi.onClock({
      pulse: () => midiClock.handleSlavePulse(transport),
      start: () => midiClock.handleSlaveStart(transport),
      continue: () => midiClock.handleSlaveContinue(transport),
      stop: () => midiClock.handleSlaveStop(transport),
    });
  });
  void midiOutput.requestAccess();

  const ghost = new GhostPreviewPlayer(engine, bank, () => store.doc);

  let saving: Promise<void> | null = null;
  let saveQueued = false;

  const doSave = async (): Promise<void> => {
    // Capture the exact immutable document revision being written. A user
    // can edit while IndexedDB is awaiting; that newer revision must not be
    // reported as saved when this older write completes.
    const documentAtStart = store.doc;
    try {
      // Inside the try: a throwing save-status listener must not reject
      // flushSave unhandled during pagehide/beforeunload/crash-save.
      store.setSaveStatus("saving");
      await repo.save(documentAtStart);
      if (store.doc !== documentAtStart) {
        saveQueued = true;
        store.setSaveStatus("dirty");
      } else {
        store.setSaveStatus("saved");
        maybeAutoSnapshot("Auto — daily");
      }
    } catch {
      store.setSaveStatus("error");
      // If a newer edit landed while the write failed, retry the newest
      // revision through the shared drain instead of losing it behind the
      // failed transaction.
      if (store.doc !== documentAtStart) saveQueued = true;
    }
  };

  const flushSave = async (): Promise<void> => {
    // Defect D.1: the debouncer now owns the timer. Cancel the
    // pending re-arm so a force-flush from unload paths isn't
    // racing with a deferred save.
    saveDebouncer.cancel();
    if (saving) {
      // A save is in progress — mark that another one is needed once
      // it finishes, so rapid Ctrl+S / visibility changes don't lose data.
      saveQueued = true;
      await saving;
      return;
    }
    if (store.saveStatus !== "dirty" && store.saveStatus !== "error") return;

    // Keep the whole drain in the shared promise. Callers that arrive while
    // this save is running await the same promise, and a queued follow-up is
    // awaited before any caller observes flushSave() as complete. This is
    // important for closeProject/pagehide: fire-and-forget must not leave a
    // second edit stranded behind the first IndexedDB transaction.
    const run = (async (): Promise<void> => {
      try {
        await doSave();
      } finally {
        saving = null;
        if (saveQueued) {
          saveQueued = false;
          await flushSave();
        }
      }
    })();
    saving = run;
    await run;
  };

  // Defect D.1 (performance / memory recon): a continuous gesture
  // (fader drag, CC sweep) re-armed the 800 ms debounce 60× per
  // second and the save would never commit. The debouncer carries
  // a max-defer ceiling (5 s OR 50 re-arms, whichever hits first)
  // so a long gesture is still force-flushed even if the user never
  // pauses — the 800 ms debounce still gives a single-edit snappy
  // UX, but a sustained session cannot accidentally lose the last
  // few minutes of edits to a closed tab.
  const saveDebouncer = createAutosaveDebouncer({
    flush: flushSave,
    debounceMs: 800,
    maxDeferMs: 5000,
    maxArms: 50,
  });

  store.onDocChanged = (doc) => {
    // Post-close mutations (a late async finalize landing on a panel that
    // outlived closeProject) must not re-point the SHARED engine at the
    // closed project or re-arm the debouncer — the final flush already ran.
    if (closed) return;
    engine.setProject(doc);
    transport.setBarTicks(ticksPerBar(doc));
    transport.setBpm(doc.bpm);
    void generativeRuntime.refreshAll().catch((error) => {
      console.warn("[generative] project refresh failed:", error);
    });
    store.setSaveStatus("dirty");
    // Defect D.1: route through the debouncer so a continuous gesture
    // still force-flushes after maxDeferMs / maxArms. flushSave
    // remains the single writer — `arm()` decides WHEN to call it.
    saveDebouncer.arm();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      void flushSave();
      pauseGenerativeForContext();
      return;
    }
    // Defect A02.D3 (browser audio lifecycle audit): on the visible
    // edge the AudioContext may still be in the suspended state the
    // browser put it in on hide (Chrome, iOS Safari, Firefox all
    // suspend by default on tab-hide). Best-effort resume via
    // ensureContext() — if the browser still requires a user gesture
    // the resume no-ops and the next click will revive it. When
    // playback was running across the hide, re-anchor the scheduler's
    // window origin to the live playhead so it does not try to
    // schedule the events that piled up during the suspended gap.
    // Audit 13 D4: ensureContext throws synchronously when the browser
    // refuses a realtime context (device loss, iOS cap) — an uncaught throw
    // here would also skip the scheduler resync and generative resume.
    try {
      engine.ensureContext();
    } catch (error) {
      console.warn("[services] context resume on visible failed:", error);
    }
    if (transport.playing) {
      scheduler.resync();
      resumeGenerativeAfterContext();
    }
  };
  // pagehide is the one iOS Safari reliably fires before terminating a
  // tab; beforeunload also gets the "unsaved changes" warning wired up
  // so the user has a chance to keep the tab open long enough for the
  // final IDB commit. The helper is testable in isolation.
  const uninstallUnloadGuards = installSaveUnloadGuards({
    flushSave,
    isDirty: () => store.saveStatus === "dirty" || store.saveStatus === "error",
  });
  document.addEventListener("visibilitychange", onVisibility);

  const closeProject = async (): Promise<void> => {
    // Ordered teardown; the flag first so pending fire-and-forget asyncs
    // (frozen restore, Web MIDI access grant) observe the close immediately.
    closed = true;
    noteRepeat.stopAll();
    ghost.stop();
    capture.cancel();
    generativeContextLifecycle.dispose();
    await generativeRuntime.dispose();
    playback.stop();
    collab?.dispose();
    // Audit 13 INFO: the 8s sync-guard must not fire against a disposed
    // session (it would flush buffered commands into a dead Y.Doc).
    if (syncGuardTimerRef) {
      clearTimeout(syncGuardTimerRef);
      syncGuardTimerRef = null;
    }
    midi.stop();
    midiClock.dispose();
    midiOutput.dispose();
    document.removeEventListener("visibilitychange", onVisibility);
    uninstallUnloadGuards();
    await flushSave();
  };

  const getDiagnostics = (): Record<string, string | number | boolean> => {
    const engineDiag = engine.getDiagnostics();
    return {
      ...engineDiag,
      playMode: playback.mode,
      bpm: transport.bpm,
      transportPlaying: transport.playing,
      transportTick: Math.round(transport.position),
      schedulerRunning: scheduler.isRunning,
      scheduledEvents: scheduler.stats.scheduledEvents,
      processorErrors: processorErrorCount(),
      schedulerFailedWindows: scheduler.stats.failedWindows,
      nextStepTick: Math.round(scheduler.stats.lastHorizonTick),
      schedulerWindows: scheduler.stats.windows,
      trackCount: store.doc.tracks.length,
      patternCount: store.doc.patterns.length,
      schemaVersion: store.doc.schemaVersion,
      saveStatus: store.saveStatus,
      noteRepeatHolds: noteRepeat.size,
    };
  };

  return {
    core,
    store,
    engine,
    generativeProviders,
    generativeRuntime,
    generativeLatency,
    transport,
    scheduler,
    sharedTransportReapply,
    bandmate,
    repo,
    bank,
    library,
    userKits,
    groovePool,
    playback,
    patternRecorder,
    selectionBridge,
    midi,
    midiOutput,
    midiClock,
    userSamples,
    recordingRecovery,
    frozenAudio,
    latency,
    capture,
    ghost,
    noteRepeat,
    collab,
    flushSave,
    closeProject,
    getDiagnostics,
  };
}
