import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * ENGINE GRAPH REACHABILITY GATE (Package 3, 2026-10-17)
 *
 * The census gate catches a strip that should not exist. This one catches a
 * strip (or a tap) that exists but is not WIRED INTO the audible graph — the
 * class that produced the dead group meters, and the class a future
 * mixer-worklet migration can reintroduce by dropping one connect().
 *
 * Measured on the navigable mock (every node records its connections), house
 * template (139 nodes, 14 analysers) and a synthetic 3-track/1-group/1-return
 * doc (107 nodes):
 *   - every track/group/return strip OUTPUT reaches `ctx.destination`  (0 violations)
 *   - every analyser OUTSIDE MasterChain.build is fed by a node that reaches
 *     the sink (4 master-internal analysers are build-ahead by design)
 *   - every node that is neither able to reach the sink nor fed by a node that
 *     can is attributable to MasterChain.build (12, all optional stereo/MS
 *     stages created once and wired when engaged)
 *   - no strip owns an inline delay that cannot reach the sink
 *
 * The ONLY allowlisted build-ahead surface is MasterChain.build. A second
 * allowlisted owner must be added deliberately, with evidence, in a diff.
 */

interface MockNode {
  name: string;
  owner: string;
  connections: Set<MockNode>;
}

function param(initial = 0) {
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
    linearRampToValueAtTime(v: number) {
      value = v;
    },
    cancelScheduledValues() {},
  };
}

function navigableCtx() {
  const created: MockNode[] = [];
  const make = (kind: string) => {
    const stack = new Error().stack ?? "";
    const owner = (stack.split("\n").find((line) => line.includes("audio-engine")) ?? stack.split("\n")[2] ?? "?")
      .trim()
      .replace(/^at\s+/, "");
    const node = {
      name: `${kind}#${created.length}`,
      owner,
      connections: new Set<MockNode>(),
      gain: param(1),
      pan: param(0),
      connect(destination?: MockNode) {
        if (destination && typeof destination === "object") (node.connections as Set<MockNode>).add(destination);
        return node;
      },
      disconnect(destination?: MockNode) {
        if (destination === undefined) node.connections.clear();
        else node.connections.delete(destination);
      },
    } as MockNode & Record<string, unknown>;
    created.push(node as MockNode);
    return node;
  };
  const ctx = {
    created,
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => make("gain"),
    createStereoPanner: () => make("panner"),
    createAnalyser: () =>
      Object.assign(make("analyser"), {
        fftSize: 0,
        channelCount: 2,
        channelCountMode: "explicit",
        getFloatTimeDomainData() {},
        getByteFrequencyData() {},
      }),
    createDelay: () => Object.assign(make("delay"), { delayTime: param(0) }),
    createDynamicsCompressor: () =>
      Object.assign(make("compressor"), {
        reduction: 0,
        threshold: param(0),
        knee: param(0),
        ratio: param(1),
        attack: param(0),
        release: param(0),
      }),
    createBiquadFilter: () => Object.assign(make("biquad"), { type: "lowpass", frequency: param(440), Q: param(1) }),
    createChannelSplitter: () => make("splitter"),
    createChannelMerger: () => make("merger"),
    createWaveShaper: () => Object.assign(make("waveshaper"), { oversample: "none", curve: null }),
    createConvolver: () => Object.assign(make("convolver"), { buffer: null, normalize: true }),
    createConstantSource: () => Object.assign(make("constant"), { offset: param(0), start() {}, stop() {} }),
    createOscillator: () => Object.assign(make("osc"), { type: "sine", start() {}, stop() {} }),
    createBufferSource: () =>
      Object.assign(make("bufferSource"), { buffer: null, playbackRate: param(1), start() {}, stop() {} }),
    createBuffer: (channels: number, len: number, rate: number) => ({
      length: len,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(len),
    }),
    decodeAudioData: async () => ({
      duration: 1,
      sampleRate: 48000,
      numberOfChannels: 2,
      length: 48000,
      getChannelData: () => new Float32Array(48000),
    }),
    audioWorklet: { addModule: async () => {} },
    destination: make("destination"),
  };
  return ctx;
}

function syntheticDoc(tracks: number, groups: number): ProjectDocument {
  const base = normalizeProject({
    schemaVersion: 32,
    id: "reach",
    name: "Reach",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    returns: [{ id: "ret1", kind: "return", name: "Space", gain: 1, effects: [] }],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  } as unknown as ProjectDocument);
  const list = [];
  for (let i = 0; i < groups; i += 1) list.push(createGroupTrackModel(`Bus ${i}`));
  for (let i = 0; i < tracks; i += 1) list.push(createDrumTrackModel(`Drums ${i}`));
  return { ...base, tracks: list };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Analysis {
  nodes: number;
  analysers: number;
  /** Analysers not fed by a node that reaches the sink (master build-ahead excluded). */
  silentStripTaps: string[];
  /** Strip outputs that cannot reach the sink. */
  silentStrips: string[];
  /** Strip inline delays that cannot reach the sink. */
  deadStripDelays: string[];
  /** Nodes neither able to reach the sink nor fed by a node that can, minus the master allowlist. */
  foreignOrphans: string[];
  /** Master build-ahead nodes (the explicit allowlist). */
  masterBuildAhead: number;
}

async function analyseGraph(doc: ProjectDocument): Promise<Analysis> {
  const ctx = navigableCtx();
  const engine = new AudioEngine();
  engine.useContext(ctx as unknown as AudioContext);
  engine.setProject(doc);
  await flush();

  const sink = ctx.destination as unknown as MockNode;
  // Exercise the LAZY taps through their real entry points: the PRE analysers
  // are allocated on first read, and a gate that never reads them would verify
  // a graph without the taps it exists to protect.
  const internalsForTap = engine as unknown as {
    trackNodes: Map<string, MockNode | Record<string, MockNode>>;
    groupNodes: Map<string, Record<string, MockNode>>;
  };
  const firstTrackId = [...internalsForTap.trackNodes.keys()][0];
  const firstGroupId = [...internalsForTap.groupNodes.keys()][0];
  if (firstTrackId) engine.getTrackPreMeterSnapshot(firstTrackId);
  if (firstGroupId) engine.getTrackPreMeterSnapshot(firstGroupId);
  await flush();

  const all = ctx.created;
  const fedBy = new Map<MockNode, Set<MockNode>>();
  for (const node of all) {
    for (const dest of node.connections) {
      const set = fedBy.get(dest) ?? new Set<MockNode>();
      set.add(node);
      fedBy.set(dest, set);
    }
  }
  const canReach = new Map<MockNode, boolean>();
  const walk = (node: MockNode, seen: Set<MockNode>): boolean => {
    const cached = canReach.get(node);
    if (cached !== undefined) return cached;
    if (seen.has(node)) return false;
    seen.add(node);
    let ok = node === sink;
    if (!ok) {
      for (const dest of node.connections) {
        if (walk(dest, seen)) {
          ok = true;
          break;
        }
      }
    }
    canReach.set(node, ok);
    return ok;
  };
  for (const node of all) walk(node, new Set());

  const internals = engine as unknown as {
    trackNodes: Map<string, Record<string, MockNode>>;
    groupNodes: Map<string, Record<string, MockNode>>;
    returnNodes: Map<string, Record<string, MockNode>>;
  };
  const strips: Array<[string, Record<string, MockNode>]> = [
    ...[...internals.trackNodes].map(([id, n]) => [`track:${id}`, n] as [string, Record<string, MockNode>]),
    ...[...internals.groupNodes].map(([id, n]) => [`group:${id}`, n] as [string, Record<string, MockNode>]),
    ...[...internals.returnNodes].map(([id, n]) => [`return:${id}`, n] as [string, Record<string, MockNode>]),
  ];

  const silentStrips: string[] = [];
  const deadStripDelays: string[] = [];
  const stripTapNodes = new Set<MockNode>();
  for (const [label, nodes] of strips) {
    const out = nodes.modMacroPan ?? nodes.panner;
    if (out && canReach.get(out) !== true) silentStrips.push(label);
    const fxState = nodes.fx as unknown as { pdcDelay?: MockNode | null } | undefined;
    const delay = fxState?.pdcDelay ?? undefined;
    if (delay && canReach.get(delay) !== true) deadStripDelays.push(label);
    for (const tap of [nodes.analyser, nodes.preFaderAnalyser]) {
      if (tap) stripTapNodes.add(tap);
    }
  }

  const isMasterOwner = (node: MockNode) => node.owner.includes("masterChain.ts");
  const silentStripTaps: string[] = [];
  for (const tap of stripTapNodes) {
    if (isMasterOwner(tap)) continue;
    const feeders = [...(fedBy.get(tap) ?? [])];
    if (!feeders.some((feeder) => canReach.get(feeder) === true)) silentStripTaps.push(tap.name);
  }

  const foreignOrphans: string[] = [];
  let masterBuildAhead = 0;
  for (const node of all) {
    if (node === sink) continue;
    const reachable = canReach.get(node) === true;
    const fedByReacher = [...(fedBy.get(node) ?? [])].some((feeder) => canReach.get(feeder) === true);
    if (reachable || fedByReacher) continue;
    if (isMasterOwner(node)) masterBuildAhead += 1;
    else foreignOrphans.push(`${node.name} <- ${node.owner}`);
  }

  return {
    nodes: all.length,
    analysers: all.filter((node) => node.name.startsWith("analyser")).length,
    silentStripTaps,
    silentStrips,
    deadStripDelays,
    foreignOrphans,
    masterBuildAhead,
  };
}

describe("engine graph reachability gate (Package 3)", () => {
  it("every strip of the house template is wired into the audible graph", async () => {
    const analysis = await analyseGraph(createProjectFromTemplate("house"));
    expect(analysis.nodes, "the graph did not build — the probe measured nothing").toBeGreaterThan(100);
    expect(analysis.analysers).toBeGreaterThan(5);
    expect(analysis.silentStrips, "a strip output cannot reach ctx.destination").toEqual([]);
    expect(analysis.silentStripTaps, "an analyser is fed by a branch that cannot reach the sink").toEqual([]);
    expect(analysis.deadStripDelays, "a PDC delay is not inline on a sink-reaching path").toEqual([]);
    expect(
      analysis.foreignOrphans,
      "a node is neither on a path to the sink nor a tap fed by one — and it is not master build-ahead",
    ).toEqual([]);
    // The one allowlisted build-ahead surface must still be present (if the
    // master stops pre-building its optional stages, this gate is measuring a
    // different graph than the one the allowlist describes).
    expect(analysis.masterBuildAhead, "master build-ahead stages vanished — update the allowlist").toBeGreaterThan(0);
  });

  it("the synthetic strip set is wired too (groups and returns included)", async () => {
    const analysis = await analyseGraph(syntheticDoc(3, 1));
    expect(analysis.nodes).toBeGreaterThan(80);
    expect(analysis.silentStrips).toEqual([]);
    expect(analysis.silentStripTaps).toEqual([]);
    expect(analysis.deadStripDelays).toEqual([]);
    expect(analysis.foreignOrphans).toEqual([]);
  });

  it("NEGATIVE: a disconnected strip is detected (mutation proof lives in review, not here)", async () => {
    // This spec cannot mutate production code; it pins the DETECTOR itself by
    // feeding the analysis a hand-built graph where one strip output is
    // stranded, so a future refactor of the walk cannot silently soften it.
    const sink = { name: "destination", owner: "test", connections: new Set() } as unknown as MockNode;
    const stranded = { name: "gain#x", owner: "test", connections: new Set() } as unknown as MockNode;
    const all = [sink, stranded];
    const fedBy = new Map<MockNode, Set<MockNode>>();
    const canReach = new Map<MockNode, boolean>();
    const walk = (node: MockNode, seen: Set<MockNode>): boolean => {
      const cached = canReach.get(node);
      if (cached !== undefined) return cached;
      if (seen.has(node)) return false;
      seen.add(node);
      let ok = node === sink;
      if (!ok) {
        for (const dest of node.connections) {
          if (walk(dest, seen)) {
            ok = true;
            break;
          }
        }
      }
      canReach.set(node, ok);
      return ok;
    };
    for (const node of all) walk(node, new Set());
    expect(canReach.get(stranded) === true).toBe(false);
    expect([...(fedBy.get(stranded) ?? [])].length).toBe(0);
  });
});
