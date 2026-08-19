import { AudioEngine } from "./audio-engine/AudioEngine";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { ProjectStore } from "./store/ProjectStore";
import { ProjectRepository } from "./persistence/ProjectRepository";
import { PresetRepository } from "./persistence/PresetRepository";
import { generateFactoryBank } from "./sample-library/factory";
import type { SampleBank } from "./sample-library/factory";
import type { PlayMode, ProjectDocument, Scene } from "./project-model/types";
import { BAR_TICKS, PPQ } from "./project-model/types";
import { setActivePattern } from "./commands/commands";

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
}

export interface Services {
  core: CoreServices;
  store: ProjectStore;
  engine: AudioEngine;
  transport: Transport;
  scheduler: Scheduler;
  repo: ProjectRepository;
  bank: SampleBank;
  playback: PlaybackController;
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
      this.scheduler.start();
    }
    this.notify();
  };

  stop = (): void => {
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
      this.applyPattern(scene.patternId);
      this.notify();
      return;
    }
    const nextBar = (Math.floor(this.transport.position / BAR_TICKS) + 1) * BAR_TICKS;
    this.scheduler.queuePatternLaunch(scene.patternId, nextBar);
    this.notify();
  };
}

export async function createCoreServices(): Promise<CoreServices> {
  const bank = await generateFactoryBank();
  const engine = new AudioEngine();
  engine.attachBank(bank);
  return { engine, bank, repo: new ProjectRepository(), presets: new PresetRepository() };
}

/**
 * Build per-project services around the shared core. The engine is reused
 * across projects (its `setProject` diff handles full project swaps), so
 * switching projects never re-creates the AudioContext.
 */
export function openProject(core: CoreServices, initial: ProjectDocument): Services {
  const { engine, repo, bank } = core;

  const store = new ProjectStore(initial);
  const transport = new Transport({ now: () => engine.currentTime }, initial.bpm);
  const modeRef: { mode: PlayMode } = { mode: "pattern" };
  const scheduler = new Scheduler({
    getProject: () => store.doc,
    getTransport: () => transport,
    getAudioTime: () => engine.currentTime,
    getMode: () => modeRef.mode,
    trigger: (trackId, pad, when, velocity) => engine.trigger(trackId, pad, when, velocity),
    noteOn: (trackId, pitch, velocity, when, durationSec) =>
      engine.noteOn(trackId, pitch, velocity, when, durationSec),
    applyAutomation: (fromTick, toTick, relOf) => engine.applyAutomation(fromTick, toTick, relOf),
    applyPatternLaunch: (patternId) => store.execute(setActivePattern(store.doc, patternId)),
  });
  engine.setProject(store.doc);
  transport.seek(0);
  const playback = new PlaybackController(engine, transport, scheduler, modeRef, () => store.doc, (patternId) =>
    store.execute(setActivePattern(store.doc, patternId)),
  );

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;

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
    if (saving) await saving;
    if (store.saveStatus === "dirty" || store.saveStatus === "error") {
      saving = doSave().finally(() => {
        saving = null;
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
    playback.stop();
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

  return { core, store, engine, transport, scheduler, repo, bank, playback, flushSave, closeProject, getDiagnostics };
}
