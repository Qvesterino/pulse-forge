import { describe, expect, it } from "vitest";
import { createDrumTrackModel, createGroupTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * PDC Wave 2 — offline/export determinism.
 *
 * The live path deliberately GLIDES PDC delay changes (setTargetAtTime,
 * 20 ms — a chain edit must not click). On a fresh offline timeline the
 * same glide was a frozen-in-the-file defect: a 5 ms look-ahead target is
 * within one sample only after ~100 ms of rendered audio, so the head of
 * every export with a look-ahead chain was progressively misaligned.
 *
 * prepareOfflineRender() settles the async worklet latency reports (main-
 * thread tasks that startRendering() does not wait for), sizes the graph,
 * then ARMS: delay writes become exact setValueAtTime and further syncPdc()
 * calls early-return so a straggler report can never mutate a rendering
 * OfflineAudioContext graph.
 */

type ParamCall = { method: "setTargetAtTime" | "setValueAtTime"; value: number };

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
  const a = { ...createDrumTrackModel("A"), groupId: group.id };
  const b = { ...createDrumTrackModel("B"), groupId: group.id };
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

type DelayParam = { calls: ParamCall[]; value: number };

type Internals = {
  trackNodes: Map<
    string,
    {
      fx: { runtimes: Map<string, { getLatencySec?: () => number }>; pdcDelay: { delayTime: DelayParam } | null };
      sendDelays: Map<string, { delayTime: DelayParam }>;
    }
  >;
  groupNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
  prepareOfflineRender: () => Promise<void>;
  syncPdc: () => void;
};

function internalsOf(engine: unknown): Internals {
  return engine as unknown as Internals;
}

/** Simulate a look-ahead runtime of `ms` landing on a chain (post-build). */
function addLatency(chain: { runtimes: Map<string, { getLatencySec?: () => number }> }, id: string, sec: number): void {
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
  });

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
