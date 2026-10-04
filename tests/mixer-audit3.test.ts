import { describe, expect, it } from "vitest";
import { createDrumTrackModel, createGroupTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MIXER AUDIT 3 (signal-flow re-run 2026-10) — engine-side commit clamps.
 *
 * Pre-fix state: every drag PREVIEW clamped (previewTrackGain/Pan/Send clamp
 * to the legal mixer ranges) but the COMMIT path in syncProject pushed the raw
 * doc value into the graph (track/group/frozen gain+pan writes, syncSends send
 * level, and the macro path's return base-gain rewrite had no finite guard).
 * Safety rested entirely on normalizeProject + the command writers — any path
 * that reaches setProject with an unnormalized doc (collab peer mid-merge,
 * embed host, a future caller) hit the graph raw: gain 999 = +60 dB blast, a
 * non-finite value made setTargetAtTime THROW mid-syncProject and left audio
 * permanently desynced from the UI.
 *
 * Also pins the automation/macro gain-domain alignment: the authoritative
 * trackGain range is targetParamDef's 0..1.5, but the lane writer clamped to 2
 * (+6 dB past every other gain surface) and the macro composer had NO upper
 * bound on stacked gain offsets (runaway gain).
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
  };
}

function nodeWith(params: Record<string, ReturnType<typeof param>> = {}) {
  return {
    gain: params.gain ?? param(1),
    pan: params.pan ?? param(0),
    ...params,
    connect() {
      return this;
    },
    disconnect() {},
  };
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

function mockCtx() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => ({
      ...mockNode(),
      fftSize: 0,
      channelCount: 2,
      channelCountMode: "explicit",
      getFloatTimeDomainData() {},
      getByteFrequencyData() {},
    }),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => ({ ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => ({ ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createWaveShaper: () => ({ oversample: "none" as OverSampleType, curve: null, connect() {}, disconnect() {} }),
  };
}

function baseDoc(): { doc: ProjectDocument; trackId: string; groupId: string } {
  const drums = createDrumTrackModel("Drums");
  const group = createGroupTrackModel("Bus");
  const doc = {
    schemaVersion: 1,
    id: "mixer-audit3",
    name: "MixerAudit3",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [drums, group],
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
  return { doc, trackId: drums.id, groupId: group.id };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface ParamView {
  gain: { gain: { value: number } };
  panner: { pan: { value: number } };
  sends: Map<string, { gain: { value: number } }>;
}

function engineInternals(engine: unknown) {
  return engine as {
    trackNodes: Map<string, ParamView>;
    groupNodes: Map<string, ParamView>;
    returnNodes: Map<string, { gain: { gain: { value: number } } }>;
  };
}

describe("mixer commit-path clamps (engine defense-in-depth)", () => {
  it("hostile out-of-range gain/pan/send values are clamped at the graph write", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const { doc, trackId } = baseDoc();
    doc.tracks = doc.tracks.map((t, i) =>
      i === 0 ? { ...t, gain: 999, pan: 5, sends: { ret: 42 } } : t,
    ) as ProjectDocument["tracks"];
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    engine.setProject(doc);
    await flush();
    const nodes = engineInternals(engine).trackNodes.get(trackId)!;
    expect(nodes.gain.gain.value).toBe(1.5);
    expect(nodes.panner.pan.value).toBe(1);
    expect(nodes.sends.get("ret")!.gain.value).toBe(1.5);
  });

  it("non-finite gain/pan/send values fall back safely instead of throwing mid-sync", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const { doc, trackId, groupId } = baseDoc();
    doc.tracks = doc.tracks.map((t, i) =>
      i === 0
        ? { ...t, gain: Number.NaN, pan: Number.NaN, sends: { ret: Number.NaN } }
        : { ...t, gain: Number.NaN, pan: Number.NaN },
    ) as ProjectDocument["tracks"];
    doc.returns = [{ id: "ret", kind: "return", name: "Space", gain: Number.NaN, effects: [] }] as never;
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    expect(() => engine.setProject(doc)).not.toThrow();
    await flush();
    const internals = engineInternals(engine);
    const track = internals.trackNodes.get(trackId)!;
    expect(track.gain.gain.value).toBe(0.9);
    expect(track.panner.pan.value).toBe(0);
    expect(track.sends.get("ret")!.gain.value).toBe(0);
    const group = internals.groupNodes.get(groupId)!;
    expect(group.gain.gain.value).toBe(0.9);
    expect(group.panner.pan.value).toBe(0);
    expect(internals.returnNodes.get("ret")!.gain.gain.value).toBe(0.9);
  });

  it("preview writers share the same finite guards (drag can never NaN the graph)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const { doc, trackId } = baseDoc();
    doc.tracks = doc.tracks.map((t, i) => (i === 0 ? { ...t, sends: { ret: 0.5 } } : t)) as ProjectDocument["tracks"];
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    engine.setProject(doc);
    await flush();
    engine.previewTrackGain(trackId, Number.NaN);
    engine.previewTrackPan(trackId, Number.NaN);
    engine.previewTrackSend(trackId, "ret", 42);
    const nodes = engineInternals(engine).trackNodes.get(trackId)!;
    expect(nodes.gain.gain.value).toBe(0.9);
    expect(nodes.panner.pan.value).toBe(0);
    expect(nodes.sends.get("ret")!.gain.value).toBe(1.5);
  });
});

describe("automation/macros gain-domain alignment", () => {
  async function bridgeForDoc(doc: ProjectDocument) {
    const { AutomationBridge } = await import("../src/audio-engine/automationBridge");
    const { DeviceLookup } = await import("../src/audio-engine/deviceLookup");
    const view = {
      modAutoGain: nodeWith({ gain: param(1) }),
      modAutoPan: nodeWith({ pan: param(0) }),
      modMacroGain: nodeWith({ gain: param(1) }),
      modMacroPan: nodeWith({ pan: param(0) }),
    };
    const trackMap = new Map([[doc.tracks[0]!.id, view]]);
    const lookup = new DeviceLookup({
      doc: () => doc,
      trackNodes: (id: string) => trackMap.get(id) as never,
      groupNodes: () => undefined,
      returnNodes: () => undefined,
      instrumentStates: () => new Map(),
    } as never);
    const ctx = { currentTime: 0 };
    const bridge = new AutomationBridge(
      {
        ctx: () => ctx as unknown as BaseAudioContext,
        doc: () => doc,
        currentTime: () => 0,
        trackNodes: trackMap as never,
        groupNodes: new Map(),
        returnNodes: new Map(),
      },
      lookup,
    );
    return { bridge, view };
  }

  it("automation lane writes clamp at the authoritative 0..1.5 gain range (was 2)", async () => {
    const { doc, trackId } = baseDoc();
    const { bridge, view } = await bridgeForDoc(doc);
    const write = (
      bridge as unknown as {
        writeAutomationTargetAt(target: unknown, value: number, when: number): void;
      }
    ).writeAutomationTargetAt.bind(bridge);
    write({ kind: "trackGain", trackId }, 2, 0);
    expect(view.modAutoGain.gain.value).toBe(1.5);
    write({ kind: "trackGain", trackId }, -5, 0);
    expect(view.modAutoGain.gain.value).toBe(0);
    // Lane PAN clamp unchanged.
    write({ kind: "trackPan", trackId }, 4, 0);
    expect(view.modAutoPan.pan.value).toBe(1);
  });

  it("gain modulators swing at most to the 1.5 ceiling (was 2)", async () => {
    const { doc, trackId } = baseDoc();
    const { bridge, view } = await bridgeForDoc(doc);
    const writer = (
      bridge as unknown as {
        makeModulatorWriter(target: unknown): ((v: number, mode: "set", when: number) => void) | null;
      }
    ).makeModulatorWriter.call(bridge, { kind: "trackGain", trackId });
    expect(writer).not.toBeNull();
    writer!(1, "set", 0); // full-positive bipolar offset
    expect(view.modAutoGain.gain.value).toBe(1.5);
    writer!(-1, "set", 0); // full dip still reaches silence
    expect(view.modAutoGain.gain.value).toBe(0);
  });

  it("stacked macro gain offsets are capped at 2 (runaway guard; single mapping unchanged)", async () => {
    const { doc, trackId } = baseDoc();
    // Two macros, both at full value, each mapping gain at full amount:
    // pre-fix composition = 1 + 1 + 1 = 3 (unbounded with N macros).
    doc.macros = [
      { id: "m1", name: "A", value: 1, mappings: [{ id: "x1", trackId, param: "gain", amount: 1 }] },
      { id: "m2", name: "B", value: 1, mappings: [{ id: "x2", trackId, param: "gain", amount: 1 }] },
    ] as never;
    const { bridge, view } = await bridgeForDoc(doc);
    bridge.syncMacros(doc);
    expect(view.modMacroGain.gain.value).toBe(2);

    // A single full mapping still lands exactly at 2 — existing projects
    // with one macro keep their sound.
    doc.macros = [
      { id: "m1", name: "A", value: 1, mappings: [{ id: "x1", trackId, param: "gain", amount: 1 }] },
    ] as never;
    const second = await bridgeForDoc(doc);
    second.bridge.syncMacros(doc);
    expect(second.view.modMacroGain.gain.value).toBe(2);
  });
});
