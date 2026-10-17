import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * ENGINE GRAPH CENSUS GATE (D: scale, 2026-10-17)
 *
 * The one thing a 100+ track project must never do silently is double its
 * graph. Measured baseline that motivated this gate (mock context, one node
 * per factory call — deterministic in jsdom):
 *
 *   1 track          →  86 nodes
 *   24 tracks        → 316
 *   100 tracks (dry) → 1076  · 209 analysers (2/strip), 103 delays (1/strip)
 *   100 tracks + 1 EQ each → 1776
 *
 * After the lazy-allocation + duplicate-strip fixes: 100 tracks → 874 nodes,
 * 109 analysers, ONE delay (the master's). The budgets below sit just above
 * the measured values: they exist to fail when a future feature adds a node
 * per track again, not to freeze the exact count.
 *
 * The counts, not the wall clock, are the gate: time in jsdom is load-noise,
 * nodes are deterministic.
 */

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

function nodeWith(params: Record<string, ReturnType<typeof param>> = {}) {
  const node: Record<string, unknown> = {
    connections: new Set<unknown>(),
    gain: params.gain ?? param(1),
    pan: params.pan ?? param(0),
    ...params,
    connect(destination?: unknown) {
      if (destination !== undefined) (node.connections as Set<unknown>).add(destination);
      return node;
    },
    disconnect(destination?: unknown) {
      const set = node.connections as Set<unknown>;
      if (destination === undefined) set.clear();
      else set.delete(destination);
    },
  };
  return node;
}

function mockNode() {
  const base = nodeWith();
  return {
    ...base,
    frequency: param(440),
    Q: param(1),
    threshold: param(0),
    ratio: param(1),
    attack: param(0),
    release: param(0),
    knee: param(0),
    delayTime: param(0),
  };
}

function countingCtx() {
  const counts: Record<string, number> = {};
  const bump = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const ctx = {
    count: () => Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => (bump("gain"), mockNode()),
    createStereoPanner: () => (bump("panner"), mockNode()),
    createAnalyser: () => (
      bump("analyser"),
      {
        ...mockNode(),
        fftSize: 0,
        channelCount: 2,
        channelCountMode: "explicit",
        getFloatTimeDomainData() {},
        getByteFrequencyData() {},
      }
    ),
    createDelay: () => (bump("delay"), mockNode()),
    createDynamicsCompressor: () => (bump("compressor"), { ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => (bump("biquad"), { ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => (bump("splitter"), mockNode()),
    createChannelMerger: () => (bump("merger"), mockNode()),
    createWaveShaper: () => (
      bump("waveshaper"),
      { oversample: "none" as OverSampleType, curve: null, connect() {}, disconnect() {} }
    ),
    createConstantSource: () => (bump("constant"), { ...mockNode(), offset: param(0), start() {}, stop() {} }),
    createOscillator: () => (bump("oscillator"), { ...mockNode(), type: "sine", start() {}, stop() {} }),
    createBufferSource: () => (
      bump("bufferSource"),
      { ...mockNode(), buffer: null, playbackRate: param(1), start() {}, stop() {} }
    ),
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
    destination: mockNode(),
  };
  return ctx;
}

interface CensusDoc {
  doc: ProjectDocument;
  groupIds: string[];
}

function censusDoc(tracks: number, groups: number, withFx: boolean): CensusDoc {
  const base = normalizeProject({
    schemaVersion: 32,
    id: "census",
    name: "Census",
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
  const groupIds: string[] = [];
  for (let i = 0; i < groups; i += 1) {
    const g = createGroupTrackModel(`Bus ${i}`);
    groupIds.push(g.id);
    list.push(g);
  }
  for (let i = 0; i < tracks; i += 1) {
    const t = createDrumTrackModel(`Drums ${i}`);
    if (withFx) {
      (t as unknown as { effects: unknown[] }).effects = [{ id: `fx${i}`, type: "eq", bypassed: false, params: {} }];
    }
    list.push(t);
  }
  return { doc: { ...base, tracks: list }, groupIds };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function buildCensus(tracks: number, groups: number, withFx: boolean) {
  const ctx = countingCtx();
  const engine = new AudioEngine();
  engine.useContext(ctx as unknown as BaseAudioContext);
  const { doc, groupIds } = censusDoc(tracks, groups, withFx);
  engine.setProject(doc);
  await flush();
  return { engine, counts: ctx.counts, total: ctx.count(), groupIds };
}

describe("engine graph census gate (D: scale)", () => {
  it("100 dry tracks + 8 groups stay under the measured budget (938 nodes)", async () => {
    const { counts, total, groupIds, engine } = await buildCensus(100, 8, false);
    expect(total, "graph grew past the measured 938 — a feature started paying per track").toBeLessThanOrEqual(1000);
    // One POST analyser per strip and NO others: the PRE taps are lazy. The
    // master/return baseline is measured, not assumed.
    const baseline = (await buildCensus(0, 0, false)).counts.analyser ?? 0;
    expect(counts.analyser, "one post-fader analyser per strip, pre taps stay lazy").toBe(baseline + 100 + 8);
    // Delays exist ONLY where an effect chain can need compensation + master.
    expect(counts.delay, "a dry chain must not own a PDC delay").toBe(1);
    // A group must never own a second, silent channel strip.
    const internals = engine as unknown as { trackNodes: Map<string, unknown> };
    for (const id of groupIds) {
      expect(internals.trackNodes.has(id), `group ${id} owns a duplicate strip in trackNodes`).toBe(false);
    }
  });

  it("per-EQ cost stays within 9 nodes per track (measured 8)", async () => {
    const dry = await buildCensus(100, 0, false);
    const withFx = await buildCensus(100, 0, true);
    const deltaPerTrack = (withFx.total - dry.total) / 100;
    expect(deltaPerTrack, "one core effect per track grew past its measured node cost").toBeLessThanOrEqual(9);
    // And the effect case legitimately owns one compensation delay per chain.
    expect(withFx.counts.delay).toBe(1 + 100);
  });

  it("groups cost the same fixed strip as tracks (measured 8, was 20 with the duplicate)", async () => {
    const withoutGroups = await buildCensus(100, 0, false);
    const withGroups = await buildCensus(100, 8, false);
    const perGroup = (withGroups.total - withoutGroups.total) / 8;
    expect(perGroup, "group strip grew past its measured 8 nodes").toBeLessThanOrEqual(9);
  });
});
