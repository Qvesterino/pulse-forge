import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument, EffectInstance } from "../src/project-model/types";

/**
 * THE AUDITION MUST NEVER REACH THE DOCUMENT.
 *
 * The KOREŇ A/B (wave 1 of the flagship roadmap) is MONITOR-ONLY: the mode
 * lives on the runtime, so it cannot change a saved parameter, an automation
 * lane, the mix or an export. This file is the engine-side proof of that
 * claim — the document is byte-identical before and after the switch, and the
 * mode is engine state that dies with the effect it belonged to.
 *
 * It also pins the half of the contract that is easy to lose: the mode must
 * SURVIVE a chain rebuild (a rebuild disposes and recreates every runtime —
 * an insert, a reorder or a bypass toggle — so without an explicit re-apply
 * the user's A/B position would silently snap back to WET).
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
    cancelAndHoldAtTime() {},
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

class MockLiveAudioContext {}

/** The worklet factories run in the mock context too — without this stub
 * every chain build throws and the rebuild never actually happens. */
class FakeWorkletNode {
  port = { onmessage: null as ((e: unknown) => void) | null, postMessage() {} };
  onprocessorerror: (() => void) | null = null;
  parameters = { get: () => undefined };
  connect() {}
  disconnect() {}
}

function mockCtx() {
  const constantSources: Array<{
    onended: (() => void) | null;
    connections: Set<unknown>;
    fireEnded: () => void;
  }> = [];
  const ctx = {
    constantSources,
    currentTime: 0,
    sampleRate: 48000,
    state: "running",
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => ({
      ...mockNode(),
      fftSize: 2048,
      channelCount: 2,
      channelCountMode: "explicit",
      getFloatTimeDomainData() {},
      getByteTimeDomainData() {},
      getByteFrequencyData() {},
      getFloatFrequencyData() {},
    }),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => ({ ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => ({ ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createWaveShaper: () => ({ ...mockNode(), oversample: "none" as OverSampleType, curve: null }),
    createConstantSource: () => {
      const base = mockNode();
      const source = {
        ...base,
        connections: (base as unknown as { connections: Set<unknown> }).connections,
        offset: param(0),
        onended: null as (() => void) | null,
        start() {},
        stop() {},
        fireEnded() {
          source.onended?.();
        },
      };
      constantSources.push(source);
      return source;
    },
    createOscillator: () => ({ ...mockNode(), type: "sine", start() {}, stop() {} }),
    createBufferSource: () => ({ ...mockNode(), buffer: null, playbackRate: param(1), start() {}, stop() {} }),
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
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  Object.setPrototypeOf(ctx, MockLiveAudioContext.prototype);
  return ctx;
}

const TRACK_ID = createDrumTrackModel("Drums").id;

function docWith(effects: EffectInstance[]) {
  const base = normalizeProject({
    schemaVersion: 32,
    id: "audition-state",
    name: "Audition state",
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
    returns: [],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  } as unknown as ProjectDocument);
  const track = { ...createDrumTrackModel("Drums"), id: TRACK_ID, effects };
  return { ...base, tracks: [track] } as unknown as ProjectDocument;
}

const fx = (id: string, type: string, bypassed = false): EffectInstance =>
  ({ id, type, bypassed, params: {} }) as unknown as EffectInstance;

const modes = (engine: AudioEngine) => (engine as unknown as { fxAudition: Map<string, number> }).fxAudition;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function engineWith(effects: EffectInstance[]) {
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  const engine = new AudioEngine();
  engine.useContext(mockCtx() as unknown as BaseAudioContext);
  await engine.setProject(docWith(effects));
  await flush();
  return engine;
}

describe("the monitor-only audition never reaches the document", () => {
  it("writes the mode to the runtime and leaves the document byte-identical", async () => {
    const engine = await engineWith([fx("fx-grow", "bassHarmonic")]);
    const before = JSON.stringify(engine.doc);

    engine.setFxAudition(TRACK_ID, "fx-grow", 2);
    expect(engine.getFxAudition("fx-grow")).toBe(2);
    expect(JSON.stringify(engine.doc), "the audition leaked into the project document").toBe(before);

    // The document has no field for it at all — not even an empty one.
    const stored = (engine.doc as unknown as { tracks: { effects: { params: Record<string, number> }[] }[] }).tracks[0]
      ?.effects?.[0]?.params;
    expect(stored).toBeDefined();
    expect(Object.keys(stored!).some((key) => key === "audition")).toBe(false);

    engine.setFxAudition(TRACK_ID, "fx-grow", 0);
    expect(engine.getFxAudition("fx-grow")).toBe(0);
    expect(JSON.stringify(engine.doc)).toBe(before);
    engine.dispose();
  });

  it("reaches the live runtime — the switch is not a dead API", async () => {
    const engine = new AudioEngine();
    const seen: number[] = [];
    (engine as unknown as { trackNodes: Map<string, unknown> }).trackNodes.set(TRACK_ID, {
      fx: { runtimes: new Map([["fx-grow", { setAudition: (mode: number) => seen.push(mode) }]]) },
    });
    engine.setFxAudition(TRACK_ID, "fx-grow", 1);
    expect(seen).toEqual([1]);
    // A non-finite or out-of-range request is clamped, never written raw.
    engine.setFxAudition(TRACK_ID, "fx-grow", Number.NaN);
    expect(seen.at(-1)).toBe(0);
    engine.setFxAudition(TRACK_ID, "fx-grow", 99);
    expect(seen.at(-1)).toBe(2);
  });

  it("survives a chain rebuild (an insert disposes and recreates every runtime)", async () => {
    const engine = await engineWith([fx("fx-grow", "bassHarmonic")]);
    engine.setFxAudition(TRACK_ID, "fx-grow", 2);
    expect(modes(engine).get("fx-grow")).toBe(2);

    // Insert a second effect: the chain signature changes, so the whole
    // chain is rebuilt. The audition position must survive it.
    await engine.setProject(docWith([fx("fx-grow", "bassHarmonic"), fx("fx-eq", "eq")]));
    await flush();
    expect(modes(engine).get("fx-grow"), "the audition was dropped by a chain rebuild").toBe(2);
    engine.dispose();
  });

  it("dies with the effect it belonged to", async () => {
    const engine = await engineWith([fx("fx-grow", "bassHarmonic")]);
    engine.setFxAudition(TRACK_ID, "fx-grow", 2);
    expect(modes(engine).get("fx-grow")).toBe(2);

    await engine.setProject(docWith([fx("fx-eq", "eq")]));
    await flush();
    expect(modes(engine).has("fx-grow"), "a removed effect's audition leaked").toBe(false);
    engine.dispose();
  });
});
