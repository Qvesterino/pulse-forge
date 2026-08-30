import { AudioEngine } from "./audio-engine/AudioEngine";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { ProjectStore } from "./store/ProjectStore";
import { ProjectRepository } from "./persistence/ProjectRepository";
import { PresetRepository } from "./persistence/PresetRepository";
import { LibraryRepository } from "./persistence/LibraryRepository";
import { generateFactoryBank } from "./sample-library/factory";
import type { SampleBank } from "./sample-library/factory";
import type { PlayMode, ProjectDocument, Scene } from "./project-model/types";
import { BAR_TICKS, PPQ } from "./project-model/types";
import { setActivePattern, unfreezeTrack } from "./commands/commands";
import { MidiInput } from "./midi/MidiInput";
import { MidiOutput } from "./midi/MidiOutput";
import { MidiClock } from "./midi/MidiClock";
import { UserSampleRepository, restoreUserSampleAudio } from "./persistence/UserSampleRepository";
import { FrozenBufferRepository, restoreFrozenTracks } from "./persistence/FrozenBufferRepository";
import { loadWorkletModules } from "./audio-worklets/loader";
import { YDocStore } from "./collab/YDocStore";
import { CollabSession, collabParamsFromSearch, type CollabStatus } from "./collab/CollabSession";
import type { CollaboratorInfo } from "./collab/CollaborationProvider";
import { LatencyCalibrationController } from "./audio-engine/latencyCalibration";
import { ArrangementCaptureController } from "./arrangement/capture";
import { GhostPreviewPlayer } from "./audio-engine/GhostPreviewPlayer";

/**
 * Long-lived services shared across projects: the audio engine (one shared
 * AudioContext — no re-unlock needed when switching projects), the factory
 * sample bank, and persistence repositories.
 */
export interface CoreServices {
  engine: AudioEngine;
  bank: SampleBank;
  repo: ProjectRepository;
  presets: PresetRepository;
  library: LibraryRepository;
  latency: LatencyCalibrationController;
}

export interface Services {
  core: CoreServices;
  /** Plain local store, or a CRDT store while a collab session is active. */
  store: ProjectStore | YDocStore;
  engine: AudioEngine;
  transport: Transport;
  scheduler: Scheduler;
  repo: ProjectRepository;
  bank: SampleBank;
  library: LibraryRepository;
  playback: PlaybackController;
  midi: MidiInput;
  midiOutput: MidiOutput;
  midiClock: MidiClock;
  userSamples: UserSampleRepository;
  frozenAudio: FrozenBufferRepository;
  latency: LatencyCalibrationController;
  capture: ArrangementCaptureController;
  ghost: GhostPreviewPlayer;
  /** Live when a collab session is active, null otherwise. */
  collab: CollabSession | null;
  flushSave(): Promise<void>;
  /** Stop playback, flush autosave and detach page listeners. */
  closeProject(): Promise<void>;
  getDiagnostics(): Record<string, string | number | boolean>;
}

export class PlaybackController {
  private listeners = new Set<() => void>();

  constructor(
    private engine: AudioEngine,
    private transport: Transport,
    private scheduler: Scheduler,
    private modeRef: { mode: PlayMode },
    private projectRef: () => ProjectDocument,
    private applyPattern: (patternId: string) => void,
    private onSceneLaunch?: (sceneId: string, currentTick: number) => void,
    private onTransportStop?: (currentTick: number) => void,
  ) {}

  setMode = (mode: PlayMode): void => {
    if (this.modeRef.mode === mode) return;
    this.modeRef.mode = mode;
    this.notify();
  };

  get mode(): PlayMode {
    return this.modeRef.mode;
  }

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
    this.engine.ensureContext();
    if (this.transport.playing) {
      this.scheduler.stop();
      this.engine.panic();
      this.transport.pause();
    } else {
      this.transport.play();
      const pos = ((this.transport.position % PPQ) + PPQ) % PPQ;
      const beatPhase = pos / PPQ;
      this.engine.transportStarted(this.engine.currentTime, beatPhase);
      // Frozen playback is transport-aware: sources are torn down by
      // panic() on pause/stop and resurrected here on every play.
      this.engine.restartFrozenSources(this.transport.position);
      this.scheduler.start();
    }
    this.notify();
  };

  stop = (): void => {
    this.onTransportStop?.(this.transport.position);
    this.scheduler.stop();
    this.engine.panic();
    this.engine.automationReset();
    this.transport.stop();
    this.notify();
  };

  /** Seek the transport and re-align the scheduler (safe while playing). */
  seek = (tick: number): void => {
    this.transport.seek(Math.max(0, tick));
    if (this.transport.playing) {
      this.engine.panic();
      this.engine.restartFrozenSources(this.transport.position);
      this.scheduler.resync();
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
  engine.attachBank(bank);
  // Re-decode persisted user-sample audio into the bank (fire-and-forget —
  // the app is fully usable while imports stream back in).
  void restoreUserSampleAudio(bank);
  const library = new LibraryRepository();
  void library.load();
  return {
    engine,
    bank,
    repo: new ProjectRepository(),
    presets: new PresetRepository(),
    library,
    latency: new LatencyCalibrationController(),
  };
}

export interface OpenProjectOptions {
  /** Start a collab session (explicit) — otherwise ?collab= in the URL is used. */
  collab?: { roomId: string; serverUrl: string };
}

export function collabSessionInfo(
  services: Services,
): { roomId: string; status: CollabStatus; participants: CollaboratorInfo[] } | null {
  return services.collab
    ? { roomId: services.collab.roomId, status: services.collab.status, participants: services.collab.participants }
    : null;
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
export function openProject(core: CoreServices, initial: ProjectDocument, options: OpenProjectOptions = {}): Services {
  const { engine, repo, bank, library, latency } = core;

  const collabConfig =
    options.collab ?? (typeof location !== "undefined" ? collabParamsFromSearch(location.search) : null);
  const store: ProjectStore | YDocStore = collabConfig ? YDocStore.fromDocument(initial) : new ProjectStore(initial);
  const collab = collabConfig
    ? new CollabSession((store as YDocStore).yDocRef, collabConfig.roomId, collabConfig.serverUrl)
    : null;
  collab?.connect();
  const transport = new Transport({ now: () => engine.currentTime }, initial.bpm);
  const modeRef: { mode: PlayMode } = { mode: "pattern" };
  const midiOutput = new MidiOutput();
  const midiClock = new MidiClock();
  const capture = new ArrangementCaptureController(
    () => store.doc,
    (command) => store.execute(command),
    () => transport.position,
  );
  const scheduler = new Scheduler({
    getProject: () => store.doc,
    getTransport: () => transport,
    getAudioTime: () => engine.currentTime,
    getScheduleOffsetSec: () => latency.getSnapshot().midiReferenceOffsetMs / 1000,
    getMode: () => modeRef.mode,
    trigger: (trackId, pad, when, velocity, locks) => engine.trigger(trackId, pad, when, velocity, locks),
    noteOn: (trackId, pitch, velocity, when, durationSec, slideFromTick, slideFromPitch) =>
      engine.noteOn(trackId, pitch, velocity, when, durationSec, slideFromTick, slideFromPitch),
    triggerAudioClip: (clip, when, durationSec) => engine.triggerAudioClip(clip, when, durationSec),
    applyAutomation: (fromTick, toTick, relOf, scheduleOffsetSec) =>
      engine.applyAutomation(fromTick, toTick, relOf, scheduleOffsetSec),
    applyModulators: (fromTick, toTick, whenFor) => engine.applyModulators(fromTick, toTick, whenFor),
    applyEnvFollowers: () => engine.applyEnvFollowersToParams(),
    applySceneAutomationLane: (lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec) =>
      engine.applySceneAutomationLane(lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec),
    applyPatternLaunch: (patternId) => store.execute(setActivePattern(store.doc, patternId)),
    triggerMarker: (assetId, when, trackId) => engine.triggerMarker(assetId, when, trackId),
    setSceneIntensity: (value) => engine.setSceneIntensity(value),
    midiNoteOn: (_trackId, channel, note, velocity, when) => {
      const doc = store.doc;
      const instTrack = doc.tracks.find((t) => t.id === _trackId && t.kind === "instrument");
      if (instTrack?.kind === "instrument" && instTrack.midiOutput?.enabled) {
        const ch = instTrack.midiOutput.channel || channel + 1;
        midiOutput.sendNoteOn(ch - 1, note, velocity);
        void when;
      }
    },
    midiNoteOff: (_trackId, channel, note, _when) => {
      const doc = store.doc;
      const instTrack = doc.tracks.find((t) => t.id === _trackId && t.kind === "instrument");
      if (instTrack?.kind === "instrument" && instTrack.midiOutput?.enabled) {
        const ch = instTrack.midiOutput.channel || channel + 1;
        midiOutput.sendNoteOff(ch - 1, note);
      }
    },
  });
  engine.setProject(store.doc);
  // Pre-load AudioWorklet modules (fire-and-forget — factories fall back
  // to old implementation until modules are ready, then pick up worklet
  // on the next syncProject cycle).
  void loadWorkletModules(engine.ensureContext());
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
    },
  );

  const midi = new MidiInput();
  const userSamples = new UserSampleRepository();
  const frozenAudio = new FrozenBufferRepository();

  // Restore frozen-track audio (IndexedDB → bank) so frozen tracks survive
  // reloads. Tracks whose buffer is gone (cleared site data, other browser)
  // are auto-unfrozen — they play live instead of staying permanently silent.
  // Unreferenced stored buffers are GC'd here — but only buffers referenced
  // by NO project: the store is shared across all projects, so GC-ing by the
  // open document alone would delete every other project's frozen audio.
  void (async () => {
    try {
      const missing = await restoreFrozenTracks(store.doc, bank, frozenAudio);
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
      for (const entry of await frozenAudio.list()) {
        if (!referenced.has(entry.id)) await frozenAudio.remove(entry.id);
      }
    } catch (err) {
      // Restore is best-effort — never leave an unhandled rejection behind.
      console.warn("[services] frozen-audio restore failed:", err);
    } finally {
      engine.setProject(store.doc);
    }
  })();

  void midi.requestAccess().then((ok) => {
    if (ok) {
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
    }
  });
  void midiOutput.requestAccess();

  const ghost = new GhostPreviewPlayer(engine, bank, () => store.doc);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let saveQueued = false;

  const doSave = async (): Promise<void> => {
    store.setSaveStatus("saving");
    try {
      await repo.save(store.doc);
      store.setSaveStatus("saved");
    } catch {
      store.setSaveStatus("error");
    }
  };

  const flushSave = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saving) {
      // A save is in progress — mark that another one is needed once
      // it finishes, so rapid Ctrl+S / visibility changes don't lose data.
      saveQueued = true;
      await saving;
    }
    if (store.saveStatus === "dirty" || store.saveStatus === "error") {
      saving = doSave().then(() => {
        saving = null;
        if (saveQueued) {
          saveQueued = false;
          void flushSave();
        }
      });
      await saving;
    }
  };

  store.onDocChanged = (doc) => {
    engine.setProject(doc);
    transport.setBpm(doc.bpm);
    store.setSaveStatus("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 800);
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") void flushSave();
  };
  const onUnload = (): void => {
    void flushSave();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", onUnload);

  const closeProject = async (): Promise<void> => {
    ghost.stop();
    capture.cancel();
    playback.stop();
    collab?.dispose();
    midi.stop();
    midiClock.dispose();
    midiOutput.dispose();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", onUnload);
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
      nextStepTick: Math.round(scheduler.stats.lastHorizonTick),
      schedulerWindows: scheduler.stats.windows,
      trackCount: store.doc.tracks.length,
      patternCount: store.doc.patterns.length,
      schemaVersion: store.doc.schemaVersion,
      saveStatus: store.saveStatus,
    };
  };

  return {
    core,
    store,
    engine,
    transport,
    scheduler,
    repo,
    bank,
    library,
    playback,
    midi,
    midiOutput,
    midiClock,
    userSamples,
    frozenAudio,
    latency,
    capture,
    ghost,
    collab,
    flushSave,
    closeProject,
    getDiagnostics,
  };
}
