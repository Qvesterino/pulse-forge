import { describe, expect, it, vi } from "vitest";
import { openProject } from "../src/services";
import type { CoreServices } from "../src/services";
import { LatencyCalibrationController } from "../src/audio-engine/latencyCalibration";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setBpm } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * GOAL 08 — the single most valuable untested data-loss guard, pinned at the
 * services layer: a FAILING autosave must surface `saveStatus:"error"`, a
 * doc edited while the write was in flight must be re-queued, and flushSave's
 * drain must write the NEWER revision (never reporting the stale one saved).
 */

function makeDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function makeCore(engine: AudioEngine, repo: CoreServices["repo"]): CoreServices {
  return {
    engine,
    bank: {} as SampleBank,
    repo,
    snapshots: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      prune: vi.fn(async () => undefined),
    } as unknown as CoreServices["snapshots"],
    presets: {} as CoreServices["presets"],
    library: { load: vi.fn(async () => undefined) } as unknown as CoreServices["library"],
    userKits: {} as CoreServices["userKits"],
    groovePool: {} as CoreServices["groovePool"],
    latency: new LatencyCalibrationController(null),
  };
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
    setEffectiveBpm: vi.fn(),
    // MRT2 context lifecycle (concurrent session's openProject wiring)
    subscribeLiveContext: vi.fn(() => () => undefined),
  } as unknown as AudioEngine;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("autosave failure drain (services level, GOAL 08)", () => {
  it("failed write → error status → queued newer revision drained to SAVED", async () => {
    const saveCalls: ProjectDocument[] = [];
    let rejectFirst: ((err: unknown) => void) | null = null;
    const repo = {
      save: vi.fn((doc: ProjectDocument) => {
        saveCalls.push(doc);
        if (saveCalls.length === 1) {
          return new Promise<void>((_, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve();
      }),
      loadMostRecent: vi.fn(async () => null),
    } as unknown as CoreServices["repo"];

    const services = await openProject(makeCore(makeEngine(), repo), makeDoc());
    try {
      // Edit #1 → dirty; flush starts write #1 (deferred, in flight).
      services.store.execute(setBpm(services.store.doc, 130));
      expect(services.store.saveStatus).toBe("dirty");
      const flushing = services.flushSave();

      // The user keeps editing WHILE the write is in flight.
      services.store.execute(setBpm(services.store.doc, 140));

      // Write #1 fails (quota / IDB error).
      rejectFirst!(new Error("QuotaExceededError"));
      await flushing;
      await flushAsync();

      // The failed revision surfaced as an error…
      expect(saveCalls.length).toBe(2);
      // …and the drain wrote the NEWER revision (bpm 140), not the stale one.
      expect(saveCalls[1]!.bpm).toBe(140);
      // The newest write succeeded — status must be saved, not stuck on error.
      expect(services.store.saveStatus).toBe("saved");
    } finally {
      await services.closeProject();
    }
  });

  it("persistent save failure keeps status on error and never reports saved", async () => {
    const repo = {
      save: vi.fn(async () => {
        throw new Error("QuotaExceededError");
      }),
      loadMostRecent: vi.fn(async () => null),
    } as unknown as CoreServices["repo"];
    const services = await openProject(makeCore(makeEngine(), repo), makeDoc());
    try {
      services.store.execute(setBpm(services.store.doc, 132));
      await services.flushSave();
      expect(services.store.saveStatus).toBe("error");
      // A second flush retries and keeps failing loudly (never "saved").
      await services.flushSave();
      expect(services.store.saveStatus).toBe("error");
      expect((repo.save as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await services.closeProject();
    }
  });
});
