import { describe, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Scratch census — MEASURE step for D (scale: mixer bus layer + virtualization).
 * Counts exactly how many WebAudio nodes the engine builds per track/return/FX.
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
  return node as typeof node & { connections: Set<unknown> };
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
    __counts: counts,
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => (bump("gain"), mockNode()),
    createStereoPanner: () => (bump("panner"), mockNode()),
    createAnalyser: () => (
      bump("analyser"), { ...mockNode(), fftSize: 0, channelCount: 2, channelCountMode: "explicit", getFloatTimeDomainData() {}, getByteFrequencyData() {} }
    ),
    createDelay: () => (bump("delay"), mockNode()),
    createDynamicsCompressor: () => (bump("compressor"), { ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => (bump("biquad"), { ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => (bump("splitter"), mockNode()),
    createChannelMerger: () => (bump("merger"), mockNode()),
    createWaveShaper: () => (bump("waveshaper"), { oversample: "none" as OverSampleType, curve: null, connect() {}, disconnect() {} }),
    createConvolver: () => (bump("convolver"), { ...mockNode(), buffer: null, normalize: true }),
    createConstantSource: () => (bump("constant"), { ...mockNode(), offset: param(0), start() {}, stop() {} }),
    createOscillator: () => (bump("oscillator"), { ...mockNode(), type: "sine", start() {}, stop() {} }),
    createBufferSource: () => (bump("bufferSource"), { ...mockNode(), buffer: null, playbackRate: param(1), start() {}, stop() {} }),
    createBuffer: (_c: number, len: number, rate: number) => ({ length: len, sampleRate: rate, numberOfChannels: _c, getChannelData: () => new Float32Array(len) }),
    decodeAudioData: async () => ({ duration: 1, sampleRate: 48000, numberOfChannels: 2, length: 48000, getChannelData: () => new Float32Array(48000) }),
    audioWorklet: { addModule: async () => {} },
    destination: mockNode(),
  };
  return ctx;
}

function docWithTracks(tracks: number, groups: number, withFx: boolean): ProjectDocument {
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
  for (let i = 0; i < groups; i += 1) list.push(createGroupTrackModel(`Bus ${i}`));
  for (let i = 0; i < tracks; i += 1) {
    const t = createDrumTrackModel(`Drums ${i}`);
    if (withFx) {
      (t as unknown as { effects: unknown[] }).effects = [{ id: `fx${i}`, type: "eq", bypassed: false, params: {} }];
    }
    list.push(t);
  }
  return { ...base, tracks: list };
}

describe("engine graph census (scratch)", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("counts nodes for 1 / 24 / 100 tracks, with and without one FX each", async () => {
    for (const [tracks, groups, withFx] of [
      [1, 0, false],
      [24, 0, false],
      [100, 0, false],
      [100, 0, true],
    ] as Array<[number, number, boolean]>) {
      const ctx = countingCtx();
      const engine = new AudioEngine();
      engine.useContext(ctx as unknown as BaseAudioContext);
      const doc = docWithTracks(tracks, groups, withFx);
      const t0 = process.hrtime.bigint();
      engine.setProject(doc);
      await flush();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const counts = ctx.__counts;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(
        `[census] tracks=${tracks} fx=${withFx ? 1 : 0} total=${total} ms=${ms.toFixed(1)} ` +
          Object.entries(counts)
            .map(([k, v]) => `${k}:${v}`)
            .join(" "),
      );
    }
  });
});
