import { describe, expect, it, vi, beforeEach, afterEach, vi as vitestVi } from "vitest";
import { openProject } from "../src/services";
import type { CoreServices } from "../src/services";
import { MidiInput } from "../src/midi/MidiInput";
import { LatencyCalibrationController } from "../src/audio-engine/latencyCalibration";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * Critical-path audit regression: openProject starts fire-and-forget asyncs
 * (frozen-audio restore, Web MIDI access). A slow IndexedDB decode or a
 * permission prompt left open can outlive the project — the user closes it or
 * opens another one. The late continuations must NOT re-point the shared
 * engine at the stale document or wire MIDI handlers into a dead store.
 */

// Controllable restore: each openProject call gets its own never-resolving
// promise until the test releases it.
const { restoreResolvers } = vitestVi.hoisted(() => ({
  restoreResolvers: [] as Array<(missing: string[]) => void>,
}));

vi.mock("../src/persistence/FrozenBufferRepository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persistence/FrozenBufferRepository")>();
  return {
    ...actual,
    restoreFrozenTracks: () =>
      new Promise<string[]>((resolve) => {
        restoreResolvers.push(resolve);
      }),
  };
});

function makeDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function makeCore(engine: AudioEngine): CoreServices {
  return {
    engine,
    bank: {} as SampleBank,
    repo: {
      referencedFrozenBufferIds: vi.fn(async () => new Set<string>()),
    } as unknown as CoreServices["repo"],
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
  } as unknown as AudioEngine;
}

/** Drain pending microtasks + timers so fire-and-forget continuations land. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("openProject close-race guards", () => {
  let engine: AudioEngine;
  let midiStartSpy: ReturnType<typeof vi.spyOn>;
  let midiDeferreds: Array<(ok: boolean) => void>;

  beforeEach(() => {
    engine = makeEngine();
    restoreResolvers.length = 0;
    midiDeferreds = [];
    vi.spyOn(MidiInput.prototype, "requestAccess").mockImplementation(
      () => new Promise<boolean>((resolve) => midiDeferreds.push(resolve)),
    );
    midiStartSpy = vi.spyOn(MidiInput.prototype, "start").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not wire MIDI handlers when access is granted after closeProject", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    expect(midiStartSpy).not.toHaveBeenCalled();
    await services.closeProject();
    // The user finally grants Web MIDI access — after the project closed.
    for (const resolve of midiDeferreds) resolve(true);
    await flushAsync();
    expect(midiStartSpy).not.toHaveBeenCalled();
  });

  it("still wires MIDI handlers when access is granted while the project is open", async () => {
    const services = await openProject(makeCore(engine), makeDoc());
    for (const resolve of midiDeferreds) resolve(true);
    await flushAsync();
    expect(midiStartSpy).toHaveBeenCalledTimes(1);
    await services.closeProject();
  });

  it("does not re-apply a stale document to the engine when the frozen restore lands after close", async () => {
    const docA = makeDoc();
    const servicesA = await openProject(makeCore(engine), docA);
    expect(engine.setProject).toHaveBeenCalledTimes(1);
    await servicesA.closeProject();
    // The restore continuation resolves after the project was closed.
    for (const resolve of restoreResolvers.splice(0)) resolve([]);
    await flushAsync();
    expect(engine.setProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the engine pointed at the NEW project when the old restore lands after a switch", async () => {
    const docA = makeDoc();
    const docB = makeDoc();
    const core = makeCore(engine);
    const servicesA = await openProject(core, docA);
    expect(engine.setProject).toHaveBeenCalledWith(docA);
    await servicesA.closeProject();

    // User opens project B while A's restore is still in flight.
    const servicesB = await openProject(core, docB);
    expect(engine.setProject).toHaveBeenCalledWith(docB);
    const callsAfterB = (engine.setProject as ReturnType<typeof vi.fn>).mock.calls.length;

    // Release ONLY A's restore (resolver order = call order); B's stays
    // pending, as a real decode would.
    restoreResolvers.shift()!([]);
    await flushAsync();

    expect((engine.setProject as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterB);
    expect(engine.setProject).toHaveBeenLastCalledWith(docB);
    await servicesB.closeProject();
  });
});
