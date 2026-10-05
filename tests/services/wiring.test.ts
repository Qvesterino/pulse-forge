/**
 * `openProject` factory contract — the wiring every panel depends on.
 *
 * `CoreServices` is the long-lived, project-independent half (one AudioContext,
 * shared preset caches); `Services` is the per-project half built around it.
 * `Services` re-exposes most of `CoreServices` under its own name so a
 * component can read `services.engine` or `services.core.engine` without
 * caring which lifecycle it belongs to.
 *
 * That re-export is the fragile part, and it has already grown by hand several
 * times (generative providers, MTC, Link, morph/ultina preset stores). Each
 * addition is one forgotten alias away from a panel reading `undefined` — a
 * crash with no type error, because the alias is not declared on `Services`.
 * So the alias set is asserted by **identity** here: the same instance, not a
 * copy. A copy would mean a preset saved through one path is invisible to a
 * panel reading the other, which is far harder to diagnose than a null.
 *
 * `snapshots` and `presets` are deliberately core-only: nothing in the panel
 * tree drives them directly (snapshots ride the save path, presets ride the
 * instrument registry), so re-exporting them would imply an ownership that
 * does not exist. They are listed in CORE_ONLY_KEYS so the exclusion stays an
 * explicit decision rather than a silent gap.
 *
 * The lifecycle half pins three rules the browser only reveals at runtime:
 * a project switch must not re-create the AudioContext, `closeProject` must be
 * idempotent (StrictMode unmount and an explicit close both fire), and
 * `getDiagnostics` must stay primitive-only because the panel renders it
 * straight into JSX.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProject, type CoreServices } from "../../src/services";
import { LatencyCalibrationController } from "../../src/audio-engine/latencyCalibration";
import { MidiInput } from "../../src/midi/MidiInput";
import { setBpm } from "../../src/commands/commands";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { AudioEngine } from "../../src/audio-engine/AudioEngine";
import type { SchedulerDeps } from "../../src/scheduler/Scheduler";
import type { ProjectDocument } from "../../src/project-model/types";
import { CrashJournalRepository } from "../../src/persistence/crashJournal";

/** Core fields re-exposed on `Services` — must be the *same* object. */
const SHARED_REFERENCE_KEYS = [
  "engine",
  "bank",
  "repo",
  "library",
  "userKits",
  "groovePool",
  "morphPresets",
  "ultinaPresets",
  "latency",
] as const satisfies ReadonlyArray<keyof CoreServices>;

/** Required core fields intentionally NOT re-exported on `Services`. */
const CORE_ONLY_KEYS = ["snapshots", "presets"] as const satisfies ReadonlyArray<keyof CoreServices>;

function makeDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function makeEngine(): AudioEngine {
  return {
    currentTime: 0,
    context: null,
    ensureContext: vi.fn(() => ({ state: "running" })),
    subscribeLiveContext: vi.fn(() => () => {}),
    setProject: vi.fn(),
    panic: vi.fn(),
    automationReset: vi.fn(),
    transportStarted: vi.fn(),
    restartFrozenSources: vi.fn(),
    setEffectiveBpm: vi.fn(),
    stopPreview: vi.fn(),
    getDiagnostics: vi.fn(() => ({ contextState: "closed", workletCount: 0, missedAssets: 0 })),
    getRtLoad: vi.fn(() => null),
  } as unknown as AudioEngine;
}

function makeRepo(): CoreServices["repo"] {
  return {
    save: vi.fn(async () => undefined),
    loadMostRecent: vi.fn(async () => null),
    referencedFrozenBufferIds: vi.fn(async () => new Set<string>()),
  } as unknown as CoreServices["repo"];
}

function makeCore(engine: AudioEngine, repo: CoreServices["repo"] = makeRepo()): CoreServices {
  return {
    engine,
    bank: {} as CoreServices["bank"],
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
    morphPresets: {} as CoreServices["morphPresets"],
    ultinaPresets: {} as CoreServices["ultinaPresets"],
    latency: new LatencyCalibrationController(null),
    crashJournal: new CrashJournalRepository(),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Silence the fire-and-forget restore console noise for a focused assertion. */
async function withSilencedErrorsAsync<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("openProject — core re-export contract", () => {
  let engine: AudioEngine;

  beforeEach(() => {
    engine = makeEngine();
    vi.spyOn(MidiInput.prototype, "requestAccess").mockImplementation(() => new Promise<boolean>(() => {}));
    vi.spyOn(MidiInput.prototype, "start").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-exports every shared core field by identity, not by copy", async () => {
    const core = makeCore(engine);
    const services = await openProject(core, makeDoc());
    for (const key of SHARED_REFERENCE_KEYS) {
      expect({ key, same: services[key] === core[key] }).toEqual({ key, same: true });
    }
    await services.closeProject();
  });

  it("exposes the exact core object it was built from", async () => {
    const core = makeCore(engine);
    const services = await openProject(core, makeDoc());
    expect(services.core).toBe(core);
    await services.closeProject();
  });

  it("keeps the core-only fields reachable through core, not through a missing alias", async () => {
    // snapshots/presets are intentionally not re-exported. This test exists so
    // that a future contributor adding a panel which wants them has to move
    // the key here consciously instead of writing `services.snapshots` and
    // getting undefined at runtime.
    const core = makeCore(engine);
    const services = await openProject(core, makeDoc());
    for (const key of CORE_ONLY_KEYS) {
      expect(services.core[key]).toBe(core[key]);
      expect((services as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
    await services.closeProject();
  });

  it("reuses one engine across a project switch — no second AudioContext", async () => {
    const core = makeCore(engine);
    const docA = makeDoc();
    const docB = makeDoc();
    docB.id = "project-B";
    const servicesA = await openProject(core, docA);
    expect(servicesA.engine).toBe(engine);
    await servicesA.closeProject();

    const servicesB = await openProject(core, docB);
    // The whole point of the core/project split: switching projects must not
    // construct a new AudioContext, or the user re-unlocks audio every time
    // and every scheduled source is orphaned on the old context. Identity is
    // the contract — the preload probe inside openProject is expected to call
    // ensureContext again, so a call count would be a false failure.
    expect(servicesB.engine).toBe(engine);
    expect(servicesB.engine).toBe(servicesA.engine);
    // The new document is projected onto the SAME engine.
    expect(engine.setProject).toHaveBeenLastCalledWith(docB);
    await servicesB.closeProject();
  });
});

describe("openProject — lifecycle contract", () => {
  let engine: AudioEngine;

  beforeEach(() => {
    engine = makeEngine();
    vi.spyOn(MidiInput.prototype, "requestAccess").mockImplementation(() => new Promise<boolean>(() => {}));
    vi.spyOn(MidiInput.prototype, "start").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is idempotent on close — a double unmount must not throw", async () => {
    // React StrictMode double-invokes effects in development, and the app also
    // closes explicitly on project switch. closeProject detaches listeners and
    // tears the scheduler down; doing it twice must be a no-op, not a throw
    // inside a teardown that would mask the original error.
    const services = await openProject(makeCore(engine), makeDoc());
    await expect(services.closeProject()).resolves.toBeUndefined();
    await expect(services.closeProject()).resolves.toBeUndefined();
  });

  it("stops playback and the scheduler on close", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    services.transport.play(0, { leadIn: false });
    const stopSpy = vi.spyOn(services.scheduler, "stop");
    await services.closeProject();
    expect(stopSpy).toHaveBeenCalled();
    expect(services.transport.playing).toBe(false);
  });

  it("flushes pending saves on close so an edit is never lost on project switch", async () => {
    const saveCalls: ProjectDocument[] = [];
    const repo = {
      ...makeRepo(),
      save: vi.fn((doc: ProjectDocument) => {
        saveCalls.push(doc);
        return Promise.resolve();
      }),
    } as unknown as CoreServices["repo"];
    const services = await openProject(makeCore(engine, repo), makeDoc());
    services.store.execute(setBpm(services.store.doc, 140));
    expect(services.store.saveStatus).toBe("dirty");
    await services.closeProject();
    // Whether the autosave debouncer fired on its own or closeProject forced
    // the drain, the edited document must have reached the repository.
    expect(saveCalls.length).toBeGreaterThan(0);
    expect(saveCalls.at(-1)!.bpm).toBe(140);
  });

  it("resolves flushSave after close without re-opening the project", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    await services.closeProject();
    await expect(services.flushSave()).resolves.toBeUndefined();
  });

  it("leaves a live collab-less session with collab === null", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    expect(services.collab).toBeNull();
    expect(services.bandmate).toBeUndefined();
    expect(services.sharedTransportReapply).toBeUndefined();
    await services.closeProject();
  });

  it("keeps getDiagnostics primitive-only", async () => {
    // The Diagnostics panel renders these values straight into JSX. A nested
    // object would render as "[object Object]" and a function would throw
    // during the JSON export.
    const services = await openProject(makeCore(engine), makeDoc());
    const diagnostics: Record<string, string | number | boolean> = services.getDiagnostics();
    expect(Object.keys(diagnostics).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(diagnostics)) {
      expect(["string", "number", "boolean"], `getDiagnostics().${key} is ${typeof value}`).toContain(typeof value);
      if (typeof value === "number") {
        expect(Number.isFinite(value), `getDiagnostics().${key} is not finite`).toBe(true);
      }
    }
    await services.closeProject();
  });

  it("keeps getDiagnostics primitive-only across a project switch", async () => {
    const core = makeCore(engine);
    const servicesA = await openProject(core, makeDoc());
    await servicesA.closeProject();
    const servicesB = await openProject(core, makeDoc());
    for (const [key, value] of Object.entries(servicesB.getDiagnostics())) {
      expect(["string", "number", "boolean"], `after switch: ${key} is ${typeof value}`).toContain(typeof value);
    }
    await servicesB.closeProject();
  });
});

describe("openProject — scheduler wiring", () => {
  let engine: AudioEngine;

  beforeEach(() => {
    engine = makeEngine();
    vi.spyOn(MidiInput.prototype, "requestAccess").mockImplementation(() => new Promise<boolean>(() => {}));
    vi.spyOn(MidiInput.prototype, "start").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the scheduler a live project reader, not a construction-time snapshot", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    services.store.execute(setBpm(services.store.doc, 133));
    await flushAsync();
    const deps = (services.scheduler as unknown as { deps: SchedulerDeps }).deps;
    // The scheduler reads `getProject()` on every tick. If openProject handed
    // it a snapshot, playback would run the pre-edit document forever.
    expect(deps.getProject()).toBe(services.store.doc);
    expect(deps.getProject().bpm).toBe(133);
    await services.closeProject();
  });

  it("routes the scheduler's AudioContext-state gate to the live engine", async () => {
    // Defect A02.D1: without this getter the "machine gun" burst after a
    // visibility/sleep resume ships anyway, because the gate is dead code.
    const services = await openProject(makeCore(engine), makeDoc());
    const deps = (services.scheduler as unknown as { deps: SchedulerDeps }).deps;
    expect(deps.getContextState!()).toBe("closed");
    (engine as unknown as { context: { state: string } }).context = { state: "running" };
    expect(deps.getContextState!()).toBe("running");
    await services.closeProject();
  });

  it("still opens the project when the frozen-audio restore throws", async () => {
    // The frozen-audio restore is best-effort. Its failure must not take the
    // studio down, and must not leave the scheduler reading a half-built doc.
    const repo = {
      ...makeRepo(),
      referencedFrozenBufferIds: vi.fn(async () => {
        throw new Error("IndexedDB unavailable");
      }),
    } as unknown as CoreServices["repo"];
    let opened: Awaited<ReturnType<typeof openProject>> | null = null;
    await withSilencedErrorsAsync(async () => {
      opened = await openProject(makeCore(engine, repo), makeDoc());
      // The restore logs on its own microtask; keep the mute window open long
      // enough to swallow it, otherwise the report shows an expected failure
      // as if it were a regression.
      await flushAsync();
    });
    expect(opened).not.toBeNull();
    expect(opened!.store.doc.tracks.length).toBeGreaterThan(0);
    await opened!.closeProject();
  });
});
