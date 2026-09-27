/**
 * `openProject` factory contract — the wiring every panel depends on.
 *
 * `CoreServices` is the long-lived, project-independent half (one AudioContext,
 * shared preset caches); `Services` is the per-project half built around it.
 * `Services` re-exposes a large subset of `CoreServices` under its own name so
 * a component can read `services.engine` or `services.core.engine` without
 * caring which lifecycle it belongs to.
 *
 * That re-export is the fragile part, and it has already grown by hand several
 * times (generative providers, MTC, Link, morph/ultina preset stores). Each
 * addition is one forgotten alias away from a panel reading `undefined` — a
 * crash with no type error, because the alias is not declared on `Services`.
 * So the alias set is derived from `CoreServices` **at the type level** and
 * checked by identity here: a new required field without an alias fails this
 * test rather than the studio.
 *
 * The lifecycle half pins three rules the browser only reveals at runtime:
 * a project switch must not re-create the AudioContext, `closeProject` must be
 * idempotent (unmount and an explicit close both fire), and `getDiagnostics`
 * must stay primitive-only because the Diagnostics panel renders it directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProject, type CoreServices, type Services } from "../../src/services";
import { LatencyCalibrationController } from "../../src/audio-engine/latencyCalibration";
import { MidiInput } from "../../src/midi/MidiInput";
import { setBpm } from "../../src/commands/commands";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { AudioEngine } from "../../src/audio-engine/AudioEngine";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Keys of `CoreServices` that are NOT optional. If a field is required on the
 * core, every project must be able to reach it — so it must be re-exported.
 */
type RequiredCoreKeys = {
  [K in keyof CoreServices]-?: undefined extends CoreServices[K] ? never : K;
}[keyof CoreServices];

/** Fields reachable on `Services` that should be the *same object* as on `core`. */
const SHARED_REFERENCE_KEYS: RequiredCoreKeys[] = [
  "engine",
  "bank",
  "repo",
  "library",
  "userKits",
  "groovePool",
  "morphPresets",
  "ultinaPresets",
  "latency",
];

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
  } as unknown as AudioEngine;
}

function makeCore(engine: AudioEngine, repo?: CoreServices["repo"]): CoreServices {
  return {
    engine,
    bank: {} as CoreServices["bank"],
    repo: repo ?? ({ referencedFrozenBufferIds: vi.fn(async () => new Set<string>()) } as unknown as CoreServices["repo"]),
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
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("re-exports every required core field by identity, not by copy", async () => {
    const core = makeCore(engine);
    const services = await openProject(core, makeDoc());
    for (const key of SHARED_REFERENCE_KEYS) {
      // Identity, not deep equality: these are the *same* instances. A copy
      // would mean a preset saved through one path is invisible to a panel
      // reading the other.
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

  it("leaves no required core field unreachable from the project surface", async () => {
    // Compile-time half: assigning every key to `never`-shaped variables fails
    // to build if a required core key stops existing. Runtime half: each key
    // must resolve to a defined value on the project surface.
    const core = makeCore(engine);
    const services = await openProject(core, makeDoc());
    const unreachable: string[] = [];
    for (const key of Object.keys(core) as Array<keyof CoreServices>) {
      if ((services as unknown as Record<string, unknown>)[key] === undefined) unreachable.push(key);
    }
    expect(unreachable).toEqual([]);
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
    // and every scheduled source is orphaned on the old context.
    expect(servicesB.engine).toBe(engine);
    expect(engine.ensureContext).toHaveBeenCalledTimes(0);
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

  it("stops playback and detaches the scheduler on close", async () => {
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
      save: vi.fn((doc: ProjectDocument) => {
        saveCalls.push(doc);
        return Promise.resolve();
      }),
      loadMostRecent: vi.fn(async () => null),
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
    // during JSON.stringify export.
    const services = await openProject(makeCore(engine), makeDoc());
    const diagnostics: Record<string, string | number | boolean> = services.getDiagnostics();
    expect(Object.keys(diagnostics).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(diagnostics)) {
      expect(
        ["string", "number", "boolean"],
        `getDiagnostics().${key} is ${typeof value}`,
      ).toContain(typeof value);
      if (typeof value === "number") expect(Number.isFinite(value), `getDiagnostics().${key} is not finite`).toBe(true);
    }
    await services.closeProject();
  });

  it("returns diagnostics whose values stay primitives across a project switch", async () => {
    const core = makeCore(engine);
    const servicesA = await openProject(core, makeDoc());
    await servicesA.closeProject();
    const servicesB = await openProject(core, makeDoc());
    for (const value of Object.values(servicesB.getDiagnostics())) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
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

  it("hands the scheduler the same store the UI mutates", async () => {
    const services: Services = await openProject(makeCore(engine), makeDoc());
    services.store.execute(setBpm(services.store.doc, 133));
    await flushAsync();
    // The scheduler reads `getProject()` live; if it captured a snapshot at
    // construction, playback would run on the pre-edit document.
    const schedulerDoc = (
      services.scheduler as unknown as { opts: { getProject: () => ProjectDocument } }
    ).opts.getProject();
    expect(schedulerDoc.bpm).toBe(133);
    expect(schedulerDoc).toBe(services.store.doc);
    await services.closeProject();
  });

  it("routes the scheduler's AudioContext-state gate to the live engine", async () => {
    // Defect A02.D1: without this getter the "machine gun" burst after a
    // visibility/sleep resume ships anyway, because the gate is dead code.
    const services = await openProject(makeCore(engine), makeDoc());
    const getContextState = (services.scheduler as unknown as { opts: { getContextState: () => AudioContextState } })
      .opts.getContextState;
    expect(getContextState()).toBe("closed");
    (engine as unknown as { context: { state: string } }).context = { state: "running" };
    expect(getContextState()).toBe("running");
    await services.closeProject();
  });
});
