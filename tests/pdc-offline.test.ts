import { describe, expect, it } from "vitest";
import { createDrumTrackModel, createGroupTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { createLatencyReportReadiness } from "../src/effects/latencyReadiness";

/**
 * PDC Wave 2 — offline/export determinism.
 *
 * The live path deliberately GLIDES PDC delay changes (setTargetAtTime,
 * 20 ms — a chain edit must not click). On a fresh offline timeline the
 * same glide was a frozen-in-the-file defect: a 5 ms look-ahead target is
 * within one sample only after ~100 ms of rendered audio, so the head of
 * every export with a look-ahead chain was progressively misaligned.
 *
 * prepareOfflineRender() waits for the initial async worklet latency reports
 * (main-thread tasks that startRendering() does not wait for), sizes the
 * graph, then ARMS: delay writes become exact setValueAtTime and further
 * syncPdc() calls early-return so a straggler report can never mutate a
 * rendering OfflineAudioContext graph.
 */

type ParamCall = { method: "setTargetAtTime" | "setValueAtTime"; value: number };

describe("latency report readiness", () => {
  it("resolves current and later waiters after the first valid report", async () => {
    const readiness = createLatencyReportReadiness();
    const pending = readiness.wait(100);
    readiness.markReported();

    await expect(pending).resolves.toBe(true);
    await expect(readiness.wait(1)).resolves.toBe(true);
    readiness.dispose();
  });

  it("times out and releases pending waits when the runtime is disposed", async () => {
    const readiness = createLatencyReportReadiness();
    await expect(readiness.wait(1)).resolves.toBe(false);

    const pending = readiness.wait(100);
    readiness.dispose();
    await expect(pending).resolves.toBe(false);
    await expect(readiness.wait(100)).resolves.toBe(false);
  });
});

function mockNode() {
  const connections = new Set<unknown>();
  const chainable = {
    connections,
    connect(destination?: unknown) {
      if (destination !== undefined) connections.add(destination);
      return chainable;
    },
    disconnect(destination?: unknown) {
      if (destination === undefined) connections.clear();
      else connections.delete(destination);
    },
  };
  const param = (initial = 0) => {
    let value = initial;
    const calls: ParamCall[] = [];
    return {
      get value() {
        return value;
      },
      set value(v: number) {
        value = v;
      },
      setTargetAtTime(v: number) {
        calls.push({ method: "setTargetAtTime", value: v });
        value = v;
      },
      setValueAtTime(v: number) {
        calls.push({ method: "setValueAtTime", value: v });
        value = v;
      },
      calls,
      /** Last write regardless of mode — wiring assertions use this. */
      lastValue: () => (calls.length > 0 ? calls[calls.length - 1].value : value),
    };
  };
  return {
    gain: param(1),
    frequency: param(440),
    Q: param(1),
    pan: param(0),
    threshold: param(0),
    ratio: param(1),
    attack: param(0),
    release: param(0),
    knee: param(0),
    delayTime: param(0),
    ...chainable,
  };
}

function mockCtx() {
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => mockNode(),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => mockNode(),
    createBiquadFilter: () => mockNode(),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createWaveShaper: () => ({ oversample: "none" as OverSampleType, curve: null, connect() {}, disconnect() {} }),
  };
  return ctx;
}

function twoTrackDoc(): { doc: ProjectDocument; groupId: string; trackA: string; trackB: string } {
  const group = createGroupTrackModel("Bus");
  // Each chain carries ONE non-bypassed (latency-free) effect: a chain with no
  // effects connects straight through and owns NO compensation delay at all
  // (lazy-PDC, 2026-10-17), so a truly dry chain could not witness the writes
  // these specs assert. The injected look-ahead latency still lands on the
  // GROUP runtime, exactly as before.
  //
  // (2026-10-22: the delay node is now allocated ON DEMAND — see "a dry chain
  // waits out the graph's latency" below. These specs keep the effect on the
  // chains because the latency they inject lands on the GROUP, and a track
  // inside a group waits that latency out THROUGH the group: its own
  // compensation is 0, so it would have no node and no write to witness.)
  const eqFx = () => [{ id: "eq", type: "eq", bypassed: false, params: {} }] as never;
  const a = { ...createDrumTrackModel("A"), groupId: group.id, effects: eqFx() };
  const b = { ...createDrumTrackModel("B"), groupId: group.id, effects: eqFx() };
  const doc = {
    schemaVersion: 1,
    id: "pdc-offline-doc",
    name: "PDC offline",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [a, b, group],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    returns: [],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  } as unknown as ProjectDocument;
  return { doc, groupId: group.id, trackA: a.id, trackB: b.id };
}

async function makeEngine(doc: ProjectDocument) {
  const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
  const engine = new AudioEngine();
  engine.useContext(mockCtx() as unknown as BaseAudioContext);
  engine.setProject(doc);
  return engine;
}

/**
 * The mock AudioParam this file asserts against (see `mockNode`'s `param()`).
 *
 * `lastValue` is NOT part of the DOM `AudioParam` — it is the mock's own
 * "last write regardless of mode" reader, and it is what the wiring specs
 * below use to assert the compensation delay was actually written. Leaving it
 * off this type made the file fail `tsc --noEmit`, which is the first half of
 * `npm run build` — so the whole production build was red over a type that
 * did not match the mock three lines above it.
 */
type DelayParam = { calls: ParamCall[]; value: number; lastValue: () => number };
type LatencyRuntime = {
  getLatencySec?: () => number;
  waitForLatencyReport?: (timeoutMs: number) => Promise<boolean>;
};

type Internals = {
  trackNodes: Map<
    string,
    {
      fx: { runtimes: Map<string, LatencyRuntime>; pdcDelay: { delayTime: DelayParam } | null };
      sendDelays: Map<string, { delayTime: DelayParam }>;
    }
  >;
  groupNodes: Map<string, { fx: { runtimes: Map<string, LatencyRuntime> } }>;
  prepareOfflineRender: () => Promise<void>;
  syncPdc: () => void;
};

function internalsOf(engine: unknown): Internals {
  return engine as unknown as Internals;
}

/** Simulate a look-ahead runtime of `ms` landing on a chain (post-build). */
function addLatency(chain: { runtimes: Map<string, LatencyRuntime> }, id: string, sec: number): void {
  chain.runtimes.set(id, { getLatencySec: () => sec });
}

describe("PDC offline determinism (Wave 2)", () => {
  it("live (unarmed) syncPdc still glides via setTargetAtTime", async () => {
    const { doc, groupId, trackA } = twoTrackDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    addLatency(anyEngine.groupNodes.get(groupId)!.fx, "lim", 0.005);
    anyEngine.syncPdc();
    const delay = anyEngine.trackNodes.get(trackA)!.fx.pdcDelay!.delayTime;
    expect(delay.calls.some((c) => c.method === "setTargetAtTime")).toBe(true);
    expect(delay.calls.some((c) => c.method === "setValueAtTime")).toBe(false);
  }, // The engine's setProject() waits for worklet preparation against a mock
  // context that has no audioWorklet, so this spec costs seconds — 3.3 s on
  // a quiet machine, 7 s on a loaded one. The default 5 s timeout turned
  // that into a flaky failure that has nothing to do with the assertion.
  30_000);

  it("prepareOfflineRender sizes the graph from LATE-arriving latency and writes exact setValueAtTime", async () => {
    const { doc, groupId, trackA, trackB } = twoTrackDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    // The report lands AFTER the build (constructor-time port message).
    addLatency(anyEngine.groupNodes.get(groupId)!.fx, "lim", 0.005);
    await engine.prepareOfflineRender();
    // Both tracks route through the group (5 ms): the track chains are 0,
    // so the compensation lands on the GROUP side is 0 and the per-track
    // taps... assert the exact contract: track delay = max(0, max − own).
    const aDelay = anyEngine.trackNodes.get(trackA)!.fx.pdcDelay!.delayTime;
    const bDelay = anyEngine.trackNodes.get(trackB)!.fx.pdcDelay!.delayTime;
    for (const delay of [aDelay, bDelay]) {
      const exact = delay.calls.find((c) => c.method === "setValueAtTime");
      expect(exact, "an exact offline write must exist").toBeTruthy();
      expect(exact!.value).toBe(0);
    }
  });

  it("waits for a late worklet report before arming sample-exact PDC", async () => {
    const { doc, trackA, trackB } = twoTrackDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    let reportLatency!: () => void;
    let signalWaitStarted!: () => void;
    let reported = false;
    const report = new Promise<boolean>((resolve) => {
      reportLatency = () => {
        reported = true;
        resolve(true);
      };
    });
    const waitStarted = new Promise<void>((resolve) => {
      signalWaitStarted = resolve;
    });
    anyEngine.trackNodes.get(trackA)!.fx.runtimes.set("late-gate", {
      getLatencySec: () => (reported ? 0.0025 : 0),
      waitForLatencyReport: () => {
        signalWaitStarted();
        return report;
      },
    });

    const preparing = engine.prepareOfflineRender();
    await waitStarted;
    const dryDelay = anyEngine.trackNodes.get(trackB)!.fx.pdcDelay!.delayTime;
    expect(dryDelay.calls.some((call) => call.method === "setValueAtTime")).toBe(false);

    reportLatency();
    await preparing;
    const exact = dryDelay.calls.find((call) => call.method === "setValueAtTime");
    expect(exact?.value).toBeCloseTo(0.0025, 6);
  });

  it("aborts before arming when a worklet never reports its initial latency", async () => {
    const { doc, trackA, trackB } = twoTrackDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    anyEngine.trackNodes.get(trackA)!.fx.runtimes.set("silent-gate", {
      getLatencySec: () => 0,
      waitForLatencyReport: async () => false,
    });

    await expect(engine.prepareOfflineRender()).rejects.toThrow(/latency reports did not arrive.*silent-gate/);
    const dryDelay = anyEngine.trackNodes.get(trackB)!.fx.pdcDelay!.delayTime;
    const writesBefore = dryDelay.calls.length;
    anyEngine.syncPdc();
    expect(dryDelay.calls.length).toBe(writesBefore + 1);
    expect(dryDelay.calls.some((call) => call.method === "setValueAtTime")).toBe(false);
  });

  it("arming locks the graph: post-arm syncPdc (straggler report) writes NOTHING", async () => {
    const { doc, groupId, trackA } = twoTrackDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    await engine.prepareOfflineRender();
    const delay = anyEngine.trackNodes.get(trackA)!.fx.pdcDelay!.delayTime;
    const writesBefore = delay.calls.length;
    // A straggler port report re-runs syncPdc mid-render — must no-op.
    addLatency(anyEngine.groupNodes.get(groupId)!.fx, "lim", 0.005);
    anyEngine.syncPdc();
    expect(delay.calls.length).toBe(writesBefore);
  });

  it("per-send PDC is exact offline: downstream 5 ms − return 2 ms = 3 ms via setValueAtTime", async () => {
    const group = createGroupTrackModel("Bus");
    const drums = createDrumTrackModel("Drums");
    const track = { ...drums, groupId: group.id, sends: { ret: 0.5 } };
    const doc = {
      schemaVersion: 1,
      id: "pdc-send-doc",
      name: "PDC send",
      bpm: 124,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [track, group],
      patterns: [],
      activePatternId: "",
      scenes: [],
      arrangement: { clips: [] },
      markers: [],
      sceneAutomation: [],
      automation: [],
      lfos: [],
      macros: [],
      returns: [{ id: "ret", kind: "return", name: "Space", gain: 1, effects: [] }],
      master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
      createdAt: "",
      updatedAt: "",
    } as unknown as ProjectDocument;
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine);
    addLatency(anyEngine.groupNodes.get(group.id)!.fx, "lim", 0.005);
    // The return runtime also lands late.
    const returnNodes = (
      engine as unknown as {
        returnNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
      }
    ).returnNodes;
    addLatency(returnNodes.get("ret")!.fx, "verb", 0.002);
    await engine.prepareOfflineRender();
    const sendDelay = anyEngine.trackNodes.get(track.id)!.sendDelays.get("ret")!.delayTime;
    const exact = sendDelay.calls.find((c) => c.method === "setValueAtTime");
    expect(exact, "send PDC must write exact offline").toBeTruthy();
    expect(exact!.value).toBeCloseTo(0.003, 6);
  });
});

/**
 * PDC — a DRY chain waits out the latency the rest of the graph imposes.
 *
 * The compensation is not for a chain's OWN latency, it is for the latency
 * OTHER chains impose. So the chain that needs it most is the dry one: it
 * carries no latency of its own, and while the delay node existed only for
 * chains that HAVE effects, the compensation computed for a dry chain had
 * nowhere to go — it was calculated and then dropped.
 *
 * The browser verifier measured the consequence: a dry track landed 2.5 ms
 * (the gate's look-ahead) EARLIER than the gated one — alignedDelta = 120
 * samples at 48 kHz, byte-identical on a clean baseline checkout, so it was
 * not a regression but a long-standing misalignment.
 */
describe("PDC — a dry chain waits out the graph's latency", () => {
  function dryAndLatentDoc(): { doc: ProjectDocument; trackDry: string; trackLate: string } {
    const eqFx = () => [{ id: "eq", type: "eq", bypassed: false, params: {} }] as never;
    const dry = { ...createDrumTrackModel("Dry") };
    const late = { ...createDrumTrackModel("Late"), effects: eqFx() };
    const doc = {
      schemaVersion: 1,
      id: "pdc-dry-doc",
      name: "PDC dry",
      bpm: 124,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [dry, late],
      patterns: [],
      activePatternId: "",
      scenes: [],
      arrangement: { clips: [] },
      markers: [],
      sceneAutomation: [],
      automation: [],
      lfos: [],
      macros: [],
      returns: [],
      master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
      createdAt: "",
      updatedAt: "",
    } as unknown as ProjectDocument;
    return { doc, trackDry: dry.id, trackLate: late.id };
  }

  type DryInternals = {
    trackNodes: Map<
      string,
      {
        input: { connections: Set<unknown> };
        panner: { connections: Set<unknown> };
        // The delay node is a `mockNode()`, so it carries the same
        // `connections` edge set the other mock nodes do — that edge set is
        // how the spec below proves the delay sits BETWEEN the chain's tail
        // and its sink.
        fx: {
          runtimes: Map<string, LatencyRuntime>;
          pdcDelay: { delayTime: DelayParam; connections: Set<unknown> } | null;
        };
      }
    >;
    syncPdc: () => void;
  };

  it("a dry track owns a compensation delay once another chain carries the latency", async () => {
    const { doc, trackDry, trackLate } = dryAndLatentDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine) as unknown as DryInternals;
    // The other chain reports the gate's 2.5 ms look-ahead.
    addLatency(anyEngine.trackNodes.get(trackLate)!.fx, "gate", 0.0025);
    anyEngine.syncPdc();
    const dryDelay = anyEngine.trackNodes.get(trackDry)!.fx.pdcDelay;
    expect(dryDelay, "a dry chain must own a delay once it has to wait one out").not.toBeNull();
    expect(dryDelay!.delayTime.lastValue()).toBeCloseTo(0.0025, 6);
  });

  it("the compensation delay sits between the chain's tail and its sink", async () => {
    const { doc, trackDry, trackLate } = dryAndLatentDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine) as unknown as DryInternals;
    addLatency(anyEngine.trackNodes.get(trackLate)!.fx, "gate", 0.0025);
    anyEngine.syncPdc();
    const nodes = anyEngine.trackNodes.get(trackDry)!;
    const delay = nodes.fx.pdcDelay!;
    expect(nodes.input.connections.has(delay), "the tail must feed the delay").toBe(true);
    expect(nodes.input.connections.has(nodes.panner), "the tail must no longer feed the sink directly").toBe(false);
    expect(delay.connections.has(nodes.panner), "the delay must feed the sink").toBe(true);
  });

  it("a graph with no latency anywhere allocates no delay node at all", async () => {
    // NEGATIVE CONTROL for the memory contract: the node is allocated ON
    // DEMAND, so a project whose graph carries no latency still pays for no
    // delay nodes — the reason the node was made lazy in the first place
    // (ADR 0048: 100 delays for 100 effect-free tracks).
    const { doc, trackDry } = dryAndLatentDoc();
    const engine = await makeEngine(doc);
    const anyEngine = internalsOf(engine) as unknown as DryInternals;
    anyEngine.syncPdc();
    expect(anyEngine.trackNodes.get(trackDry)!.fx.pdcDelay).toBeNull();
  });
});
