import { describe, expect, it } from "vitest";
import { createDrumTrackModel, createGroupTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * AUDIT 04 (signal-flow) — send-tap teardown.
 *
 * A send is a two-edge chain per track/group:
 *
 *   modMacroPan ──▶ sendGain ──▶ sendDelay ──▶ return.input
 *
 * `disposeTrackNodes` / `disposeGroupNodes` call `modMacroPan.disconnect()` with
 * no argument, which drops every outgoing edge of that node — so the whole
 * channel teardown is safe.
 *
 * The per-send removal path in `syncSends()` is NOT safe: it disconnects the
 * send's own OUTPUT (`sendGain.disconnect()`) and its delay, but never the
 * INPUT edge `modMacroPan → sendGain`. Web Audio's `disconnect()` only severs
 * edges leaving the node it is called on, so the tap node stayed connected
 * downstream of `modMacroPan` and was never collected: every send that was
 * turned off and later re-added leaked another live GainNode + DelayNode
 * pair hanging off the channel tap, permanently summing extra sends into the
 * return bus.
 *
 * The mock context below models real Web Audio edge semantics (edges are
 * per-node and directional) precisely so this class of defect is observable
 * under vitest, which has no WebAudio.
 */

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
  return {
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
}

function docWithSend(): { doc: ProjectDocument; groupId: string; trackId: string; returnId: string } {
  const group = createGroupTrackModel("Bus");
  const drums = createDrumTrackModel("Drums");
  const track = { ...drums, groupId: group.id, sends: { ret: 0.5 } };
  const doc = {
    schemaVersion: 1,
    id: "send-leak-doc",
    name: "SendLeak",
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

interface SendNodes {
  sends: Map<string, { connections: Set<unknown>; disconnect(d?: unknown): void }>;
  sendDelays: Map<string, { connections: Set<unknown>; disconnect(d?: unknown): void }>;
  modMacroPan: { connections: Set<unknown> };
  input: { connections: Set<unknown>; disconnect(d?: unknown): void };
}

function internals(engine: unknown) {
  return engine as {
    trackNodes: Map<string, SendNodes>;
    groupNodes: Map<string, SendNodes>;
    returnNodes: Map<string, { input: { connections: Set<unknown> } }>;
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("mixer send teardown — no orphaned tap nodes", () => {
  it("removing a send disconnects the modMacroPan → sendGain edge (leak guard)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, trackId, returnId } = docWithSend();
    engine.setProject(doc);
    await flush();

    const nodes = internals(engine).trackNodes.get(trackId)!;
    expect(nodes.sends.size, "send must be wired on first sync").toBe(1);
    const sendGain = nodes.sends.get(returnId)!;
    expect(nodes.modMacroPan.connections.has(sendGain), "tap must start connected").toBe(true);

    // Drop the send from the document (what the mixer send-off switch does).
    engine.setProject({ ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, sends: {} } : t)) });
    await flush();

    expect(nodes.sends.size, "send bookkeeping must drop it").toBe(0);
    expect(nodes.sendDelays.size, "send delay bookkeeping must drop it").toBe(0);
    // THE REGRESSION: the tap node was still hanging off the channel output.
    expect(
      nodes.modMacroPan.connections.has(sendGain),
      "syncSends must disconnect the modMacroPan → sendGain edge, not only the send's own output",
    ).toBe(false);
    expect(sendGain.connections.size, "orphan tap must have no downstream edges").toBe(0);
  });

  it("re-adding a send does not stack duplicate taps on the channel output", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, trackId } = docWithSend();
    engine.setProject(doc);
    await flush();

    const nodes = internals(engine).trackNodes.get(trackId)!;
    // Baseline edge count of the channel output: master tap + analyser + the
    // one live send tap. This is the number that must NOT grow across cycles.
    const edges = () => nodes.modMacroPan.connections.size;
    const baseline = edges();
    expect(baseline).toBe(3);

    for (let i = 0; i < 5; i++) {
      engine.setProject({ ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, sends: {} } : t)) });
      await flush();
      engine.setProject(doc);
      await flush();
    }
    expect(nodes.sends.size, "one live send at a time").toBe(1);
    expect(
      edges(),
      "five off/on cycles must leave the channel output at its baseline edge count — pre-fix this grew by one orphaned tap per cycle",
    ).toBe(baseline);
    expect(nodes.sendDelays.size).toBe(1);
  });

  it("group sends tear down the same way (bus taps leak identically)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, groupId, returnId } = docWithSend();
    // Put a send ON THE GROUP itself (the fixture's send is on the track).
    const withGroupSend = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === groupId ? { ...t, sends: { ret: 0.5 } } : t)),
    };
    engine.setProject(withGroupSend);
    await flush();

    const nodes = internals(engine).groupNodes.get(groupId)!;
    const tap = nodes.sends.get(returnId)!;
    expect(tap, "group send must be wired").toBeTruthy();
    expect(nodes.modMacroPan.connections.has(tap)).toBe(true);
    const baseline = nodes.modMacroPan.connections.size;

    engine.setProject({ ...doc, tracks: doc.tracks.map((t) => (t.id === groupId ? { ...t, sends: {} } : t)) });
    await flush();

    expect(nodes.sends.size).toBe(0);
    expect(
      nodes.modMacroPan.connections.has(tap),
      "group send tap must be fully disconnected from the bus output",
    ).toBe(false);
    expect(nodes.modMacroPan.connections.size, "bus output returns to its no-send edge count").toBe(baseline - 1);
  });

  it("deleting a track's group re-parents the track to the master (no orphaned route)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, groupId, trackId } = docWithSend();
    engine.setProject(doc);
    await flush();

    const intern = internals(engine);
    const nodes = intern.trackNodes.get(trackId)!;
    const groupInput = intern.groupNodes.get(groupId)!.input;
    const masterInput = (engine as unknown as { masterChain: { input: unknown } }).masterChain.input;
    expect(nodes.modMacroPan.connections.has(groupInput), "the member starts routed into its group").toBe(true);

    // Delete the group out from under the track. The member must land on the
    // master, and the edge into the now-dead group input must be gone — a
    // surviving edge would feed a disposed node and mute the track entirely.
    engine.setProject({ ...doc, tracks: doc.tracks.filter((t) => t.id !== groupId) });
    await flush();

    expect(intern.groupNodes.has(groupId), "the group channel must be disposed").toBe(false);
    expect(intern.trackNodes.has(trackId), "the member track must survive its group").toBe(true);
    expect(
      nodes.modMacroPan.connections.has(groupInput),
      "the route into the deleted group's input must be disconnected",
    ).toBe(false);
    expect(nodes.modMacroPan.connections.has(masterInput), "the member must re-parent to the master").toBe(true);
  });

  it("deleting the track still tears the whole channel down (guard against over-correction)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    const { doc, trackId } = docWithSend();
    engine.setProject(doc);
    await flush();

    const nodes = internals(engine).trackNodes.get(trackId)!;
    engine.setProject({ ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) });
    await flush();

    expect(internals(engine).trackNodes.has(trackId), "channel nodes must be disposed").toBe(false);
    expect(nodes.modMacroPan.connections.size, "no edges may survive channel teardown").toBe(0);
    expect(nodes.input.connections.size).toBe(0);
  });
});
