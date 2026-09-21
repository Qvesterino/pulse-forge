import { describe, expect, it } from "vitest";
import { sendPdcDelaySec } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, createGroupTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

describe("sendPdcDelaySec", () => {
  it("waits out downstream group latency for zero-latency returns", () => {
    expect(sendPdcDelaySec(0.005, 0)).toBeCloseTo(0.005, 6);
    expect(sendPdcDelaySec(0, 0)).toBe(0);
  });

  it("subtracts the return's own latency", () => {
    expect(sendPdcDelaySec(0.005, 0.002)).toBeCloseTo(0.003, 6);
  });

  it("clamps instead of going negative (documented residual)", () => {
    expect(sendPdcDelaySec(0, 0.005)).toBe(0);
    expect(sendPdcDelaySec(0.001, 0.005)).toBe(0);
  });

  it("treats non-finite input as no compensation", () => {
    expect(sendPdcDelaySec(Number.NaN, 0)).toBe(0);
    expect(sendPdcDelaySec(0.005, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/* ── Engine wiring with a mocked audio context (no DSP, no worklets) ── */

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
    return {
      get value() {
        return value;
      },
      set value(v: number) {
        value = v;
      },
      setTargetAtTime(v: number) {
        value = v;
      },
      setValueAtTime(v: number) {
        value = v;
      },
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

function docWithSend(): { doc: ProjectDocument; groupId: string; trackId: string; returnId: string } {
  const group = createGroupTrackModel("Bus");
  const drums = createDrumTrackModel("Drums");
  const track = { ...drums, groupId: group.id, sends: { ret: 0.5 } };
  const doc = {
    schemaVersion: 1,
    id: "pdc-doc",
    name: "PDC",
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
  return { doc, groupId: group.id, trackId: track.id, returnId: "ret" };
}

describe("engine send-PDC wiring", () => {
  it("creates one delay node per send, chained sendGain → delay → return", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, trackId, returnId } = docWithSend();
    engine.setProject(doc);
    const trackNodes = (
      engine as unknown as {
        trackNodes: Map<
          string,
          { sends: Map<string, unknown>; sendDelays: Map<string, unknown>; fx: { pdcDelay: unknown } }
        >;
        returnNodes: Map<string, { fx: { pdcDelay: unknown } }>;
      }
    );
    const nodes = trackNodes.trackNodes.get(trackId)!;
    expect(nodes.sends.has(returnId)).toBe(true);
    expect(nodes.sendDelays.has(returnId)).toBe(true);
    // An empty effect signature is still a built pass-through chain. This is
    // needed for dry-path PDC and for empty return buses to route at all.
    expect(nodes.fx.pdcDelay).toBeTruthy();
    expect(trackNodes.returnNodes.get(returnId)?.fx.pdcDelay).toBeTruthy();
  });

  it("sizes the send delay from downstream group latency minus return latency", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, groupId, trackId, returnId } = docWithSend();
    engine.setProject(doc);
    const anyEngine = engine as unknown as {
      trackNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
      groupNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
      returnNodes: Map<string, { fx: { runtimes: Map<string, { getLatencySec?: () => number }> } }>;
      syncPdc: () => void;
    };
    // Simulate a 5 ms look-ahead limiter on the group + a 2 ms return chain.
    anyEngine.groupNodes.get(groupId)!.fx.runtimes.set("lim", { getLatencySec: () => 0.005 });
    anyEngine.returnNodes.get(returnId)!.fx.runtimes.set("verb", { getLatencySec: () => 0.002 });
    anyEngine.syncPdc();
    const trackNodes = (
      engine as unknown as { trackNodes: Map<string, { sendDelays: Map<string, { delayTime: { value: number } }> }> }
    ).trackNodes;
    // 5 ms downstream − 2 ms return = 3 ms send delay.
    expect(trackNodes.get(trackId)!.sendDelays.get(returnId)!.delayTime.value).toBeCloseTo(0.003, 6);
  });

  it("drops the send delay when the send is removed", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, trackId } = docWithSend();
    engine.setProject(doc);
    const trackNodes = (
      engine as unknown as {
        trackNodes: Map<string, { sends: Map<string, unknown>; sendDelays: Map<string, unknown> }>;
      }
    ).trackNodes;
    expect(trackNodes.get(trackId)!.sendDelays.size).toBe(1);
    engine.setProject({ ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, sends: {} } : t)) });
    // setProject defers the graph sync through projectQueue when a previous
    // body is still settling (one microtask) — flush before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackNodes.get(trackId)!.sendDelays.size).toBe(0);
  });

  it("disconnects the exact previous group route when moving or deleting a group", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, groupId, trackId } = docWithSend();
    const groupB = createGroupTrackModel("Bus B");
    const groupA = doc.tracks.find((track) => track.id === groupId)!;
    const withBothGroups = { ...doc, tracks: [...doc.tracks, groupB] };
    engine.setProject(withBothGroups);

    const internals = engine as unknown as {
      master: unknown;
      trackNodes: Map<string, { modMacroPan: { connections: Set<unknown> }; routeDestination: unknown }>;
      groupNodes: Map<string, { input: unknown }>;
    };
    const output = internals.trackNodes.get(trackId)!.modMacroPan;
    const inputA = internals.groupNodes.get(groupA.id)!.input;
    const inputB = internals.groupNodes.get(groupB.id)!.input;
    expect(output.connections.has(inputA)).toBe(true);
    expect(output.connections.has(internals.master)).toBe(false);

    const moved = {
      ...withBothGroups,
      tracks: withBothGroups.tracks.map((track) => (track.id === trackId ? { ...track, groupId: groupB.id } : track)),
    };
    engine.setProject(moved);
    // Flush the deferred queue-drain sync (see the removal test above).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.connections.has(inputA)).toBe(false);
    expect(output.connections.has(inputB)).toBe(true);
    expect(internals.trackNodes.get(trackId)!.routeDestination).toBe(inputB);

    const ungrouped = {
      ...moved,
      tracks: moved.tracks
        .filter((track) => track.id !== groupB.id)
        .map((track) => (track.id === trackId ? { ...track, groupId: undefined } : track)),
    };
    engine.setProject(ungrouped);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.connections.has(inputB)).toBe(false);
    expect(output.connections.has(internals.master)).toBe(true);
    expect(internals.trackNodes.get(trackId)!.routeDestination).toBe(internals.master);
  });
});
