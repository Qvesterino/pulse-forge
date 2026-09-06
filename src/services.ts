import { AudioEngine } from "./audio-engine/AudioEngine";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { ProjectStore } from "./store/ProjectStore";
import { ProjectRepository } from "./persistence/ProjectRepository";
import { SnapshotRepository, shouldAutoSnapshot } from "./persistence/SnapshotRepository";
import { PresetRepository } from "./persistence/PresetRepository";
import { LibraryRepository } from "./persistence/LibraryRepository";
import { KitRepository } from "./persistence/KitRepository";
import { GroovePoolRepository } from "./persistence/GroovePoolRepository";
import { installSaveUnloadGuards } from "./persistence/save-lifecycle";
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
import { ensureWorkletsForDoc } from "./audio-worklets/loader";
import type { YDocStore } from "./collab/YDocStore";
import type { CollabSession } from "./collab/CollabSession";
import { collabParamsFromSearch } from "./collab/collabShared";
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
  repo: ProjectRepository;
  snapshots: SnapshotRepository;
  presets: PresetRepository;
  library: LibraryRepository;
  userKits: KitRepository;
  groovePool: GroovePoolRepository;
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
  userKits: KitRepository;
  groovePool: GroovePoolRepository;
  playback: PlaybackController;
  midi: MidiInput;
  midiOutput: MidiOutput;
  midiClock: MidiClock;
  userSamples: UserSampleRepository;
  frozenAudio: FrozenBufferRepository;
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
      this.onTransportPause?.();
    } else {
      // Pre-roll: start playback a few bars early so the metronome count-in
      // leads into the requested position (content starts at anchor+preRoll).
      const preRollTicks = this.transport.preRollBars * BAR_TICKS;
      const requested = Math.max(0, this.transport.position);
      if (preRollTicks > 0 && requested >= preRollTicks) {
        this.transport.play(requested - preRollTicks);
      } else {
        this.transport.play();
      }
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
    this.onTransportPause?.();
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
  const userKits = new KitRepository();
  const groovePool = new GroovePoolRepository();
  void library.load();
  return {
    engine,
    bank,
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
  const { engine, repo, bank, library, userKits, groovePool, latency, snapshots } = core;

  const collabConfig =
    options.collab ?? (typeof location !== "undefined" ? collabParamsFromSearch(location.search) : null);
  // yjs + y-websocket ship only in the collab chunk — loaded on demand, so
  // solo sessions never download ~300 KB of CRDT runtime.
  let store: ProjectStore | YDocStore = new ProjectStore(initial);
  let collab: CollabSession | null = null;
  if (collabConfig) {
    const [{ YDocStore: YDocStoreImpl }, { CollabSession: CollabSessionImpl }] = await Promise.all([
      import("./collab/YDocStore"),
      import("./collab/CollabSession"),
    ]);
    store = YDocStoreImpl.fromDocument(initial);
    collab = new CollabSessionImpl((store as YDocStore).yDocRef, collabConfig.roomId, collabConfig.serverUrl);
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
    applyAutomation: (fromTick, toTick, relOf, scheduleOffsetSec) =>
      engine.applyAutomation(fromTick, toTick, relOf, scheduleOffsetSec),
    applyModulators: (fromTick, toTick, whenFor) => engine.applyModulators(fromTick, toTick, whenFor),
    applyEnvFollowers: () => engine.applyEnvFollowersToParams(),
    applySceneAutomationLane: (lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec) =>
      engine.applySceneAutomationLane(lane, fromTick, toTick, sceneStartTick, scheduleOffsetSec),
    applyPatternLaunch: (patternId) => store.execute(setActivePattern(store.doc, patternId)),
    triggerMarker: (assetId, when, trackId) => engine.triggerMarker(assetId, when, trackId),
    setSceneIntensity: (value) => engine.setSceneIntensity(value),
    // Scene tempo lane: clips whose scene pins a BPM drive the transport
    // (setBpm re-anchors position-preserving); null = project tempo.
    applySceneTempo: (bpm) => transport.setBpm(bpm ?? store.doc.bpm),
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
  void ensureWorkletsForDoc(store.doc, engine.ensureContext());
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
    () => capture.markPause(),
  );

  const midi = new MidiInput();
  const userSamples = new UserSampleRepository();
  const frozenAudio = new FrozenBufferRepository();

  // Close-race guard (critical path audit): several fire-and-forget asyncs
  // started below resolve AFTER an awaited IndexedDB decode or a pending
  // MIDI permission prompt. If the user closes this project (or switches to
  // another one) before they land, their continuations must not touch the
  // shared engine or wire handlers into a dead store.
  let closed = false;

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
      capture.recordEvent({
        trackId,
        padId,
        velocity,
        tick: Math.max(0, Math.round(transport.tickAt(when))),
      });
    },
  });
  midi.attachNoteRepeat(noteRepeat);

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

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let saveQueued = false;

  const doSave = async (): Promise<void> => {
    // Capture the exact immutable document revision being written. A user
    // can edit while IndexedDB is awaiting; that newer revision must not be
    // reported as saved when this older write completes.
    const documentAtStart = store.doc;
    store.setSaveStatus("saving");
    try {
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
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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

  store.onDocChanged = (doc) => {
    engine.setProject(doc);
    transport.setBpm(doc.bpm);
    store.setSaveStatus("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 800);
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      void flushSave();
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
    engine.ensureContext();
    if (transport.playing) scheduler.resync();
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
    playback.stop();
    collab?.dispose();
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
    transport,
    scheduler,
    repo,
    bank,
    library,
    userKits,
    groovePool,
    playback,
    midi,
    midiOutput,
    midiClock,
    userSamples,
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
