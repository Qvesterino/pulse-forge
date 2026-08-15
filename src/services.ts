import { AudioEngine } from "./audio-engine/AudioEngine";
import { Scheduler } from "./scheduler/Scheduler";
import { Transport } from "./transport/Transport";
import { ProjectStore } from "./store/ProjectStore";
import { ProjectRepository } from "./persistence/ProjectRepository";
import { generateFactoryBank } from "./sample-library/factory";
import { createDefaultProject, migrateProject, validateProjectShape } from "./project-model/schema";
import { PPQ } from "./project-model/types";
import type { ProjectDocument } from "./project-model/types";

export interface Services {
  store: ProjectStore;
  engine: AudioEngine;
  transport: Transport;
  scheduler: Scheduler;
  repo: ProjectRepository;
  playback: PlaybackController;
  flushSave(): Promise<void>;
  getDiagnostics(): Record<string, string | number | boolean>;
}

export class PlaybackController {
  constructor(
    private engine: AudioEngine,
    private transport: Transport,
    private scheduler: Scheduler,
  ) {}

  playPause(): void {
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
  }

  stop(): void {
    this.scheduler.stop();
    this.engine.panic();
    this.transport.stop();
  }
}

export async function createServices(): Promise<Services> {
  const bank = await generateFactoryBank();
  const engine = new AudioEngine();
  engine.attachBank(bank);

  let initial: ProjectDocument | null = null;
  try {
    const repo = new ProjectRepository();
    const loaded = await repo.loadMostRecent();
    if (loaded && validateProjectShape(loaded)) initial = migrateProject(loaded);
  } catch {
    initial = null;
  }
  initial ??= createDefaultProject();

  const store = new ProjectStore(initial);
  const transport = new Transport({ now: () => engine.currentTime }, initial.bpm);
  const scheduler = new Scheduler({
    getProject: () => store.doc,
    getTransport: () => transport,
    getAudioTime: () => engine.currentTime,
    trigger: (trackId, pad, when, velocity) => engine.trigger(trackId, pad, when, velocity),
    noteOn: (trackId, pitch, velocity, when, durationSec) =>
      engine.noteOn(trackId, pitch, velocity, when, durationSec),
  });
  engine.setProject(store.doc);

  const repo = new ProjectRepository();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;

  const flushSave = async () => {
    if (saving) return;
    saving = true;
    store.setSaveStatus("saving");
    try {
      await repo.save(store.doc);
      store.setSaveStatus("saved");
    } catch {
      store.setSaveStatus("error");
    } finally {
      saving = false;
    }
  };

  store.onDocChanged = (doc) => {
    engine.setProject(doc);
    transport.setBpm(doc.bpm);
    store.setSaveStatus("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 800);
  };

  const playback = new PlaybackController(engine, transport, scheduler);

  const getDiagnostics = (): Record<string, string | number | boolean> => {
    const engineDiag = engine.getDiagnostics();
    return {
      ...engineDiag,
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

  return { store, engine, transport, scheduler, repo, playback, flushSave, getDiagnostics };
}
