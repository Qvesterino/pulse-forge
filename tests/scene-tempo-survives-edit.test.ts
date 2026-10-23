import { describe, expect, it, vi } from "vitest";
import { openProject } from "../src/services";
import type { CoreServices } from "../src/services";
import { LatencyCalibrationController } from "../src/audio-engine/latencyCalibration";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setBpm } from "../src/commands/commands";
import { CrashJournalRepository } from "../src/persistence/crashJournal";
import type { ProjectDocument } from "../src/project-model/types";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * A SCENE TEMPO MUST SURVIVE A DOCUMENT CHANGE.
 *
 * The scene-tempo lane (roadmap 2.2) lets a clip's scene pin a BPM; the
 * SCHEDULER then owns the transport's tempo while that scene plays. The
 * document-change path re-applied the PROJECT bpm to the transport on every
 * edit — stomping the scene tempo. The scheduler's change-guard
 * (`lastAppliedTempo`) then saw the same scene tempo as last time and never
 * re-applied it, so the scene tempo was lost for the rest of the playback:
 * every edit put the project back on the project BPM.
 *
 * Two owners, two responsibilities:
 *   - the scheduler owns the tempo while a scene tempo is in effect,
 *   - the document-change path owns the project tempo otherwise.
 *
 * The test drives the real services object: the scheduler is told to apply a
 * scene tempo, the document is then edited, and the transport must still be
 * on the scene tempo.
 */

function makeDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function makeBank(): SampleBank {
  return {
    has: () => true,
    get: () => undefined,
    add: () => {},
    remove: () => {},
  } as unknown as SampleBank;
}

function makeEngine(): AudioEngine {
  return {
    currentTime: 0,
    ensureContext: vi.fn(() => ({ state: "running" })),
    setProject: vi.fn(),
    panic: vi.fn(),
    automationReset: vi.fn(),
    transportStarted: vi.fn(),
    restartFrozenSources: vi.fn(),
    stopVoicesForOwner: vi.fn(),
    setEffectiveBpm: vi.fn(),
    subscribeLiveContext: vi.fn(() => () => undefined),
  } as unknown as AudioEngine;
}

function makeCore(engine: AudioEngine): CoreServices {
  return {
    engine,
    bank: makeBank(),
    repo: {
      save: vi.fn(async () => undefined),
      loadMostRecent: vi.fn(async () => null),
    } as unknown as CoreServices["repo"],
    snapshots: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      prune: vi.fn(async () => undefined),
    } as unknown as CoreServices["snapshots"],
    presets: {} as CoreServices["presets"],
    library: { load: vi.fn(async () => undefined) } as unknown as CoreServices["library"],
    morphPresets: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    } as unknown as CoreServices["morphPresets"],
    ultinaPresets: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    } as unknown as CoreServices["ultinaPresets"],
    userKits: {} as CoreServices["userKits"],
    groovePool: {} as CoreServices["groovePool"],
    latency: new LatencyCalibrationController(null),
    crashJournal: new CrashJournalRepository(),
  } as unknown as CoreServices;
}

type SchedulerInternals = { applyTempo(bpm: number | null): void };

describe("the scene tempo survives a document change", () => {
  it("an edit does not stomp the scene tempo back to the project bpm", async () => {
    const services = await openProject(makeCore(makeEngine()), makeDoc());
    try {
      const internals = services.scheduler as unknown as SchedulerInternals;
      internals.applyTempo(140);
      expect(services.scheduler.sceneTempo, "the scheduler owns the tempo now").toBe(140);
      expect(services.transport.bpm).toBe(140);

      // Any edit at all — the document-change path runs.
      services.store.execute(setBpm(services.store.doc, 130));

      expect(services.transport.bpm, "the scene tempo must survive the edit").toBe(140);
      expect(services.scheduler.sceneTempo).toBe(140);
    } finally {
      await services.closeProject();
    }
  });

  it("without a scene tempo the project bpm still applies", async () => {
    const services = await openProject(makeCore(makeEngine()), makeDoc());
    try {
      const internals = services.scheduler as unknown as SchedulerInternals;
      internals.applyTempo(null);
      expect(services.scheduler.sceneTempo, "no scene tempo → the project tempo owns it").toBeNull();

      services.store.execute(setBpm(services.store.doc, 130));

      expect(services.transport.bpm, "the project bpm must still follow the document").toBe(130);
    } finally {
      await services.closeProject();
    }
  });
});
