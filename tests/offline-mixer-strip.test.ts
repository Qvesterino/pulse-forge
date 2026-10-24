import { describe, it, expect } from "vitest";
import { createDrumTrackModel } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE MIXER STRIP IS OFFLINE-EXACT.
 *
 * The export is a DIFFERENT graph from the live session: it is built at the
 * render origin (t = 0) and the first event lands immediately. The master
 * chain and the effect registry already write EXACTLY in that regime
 * (masterChain.writeControl, withOfflineEffectParams) — the mixer strip did
 * not, and kept the live 10 ms smoothing glide.
 *
 * The consequence was a defect frozen into the file: the fader node's base
 * value is the GainNode default 1, so at t = 0 a MUTED track leaked at unity
 * for ~30 ms, a 0.5 fader started +6 dB hot, and a hard-panned track
 * started centred. The export "succeeded" and did not sound like the mix.
 *
 * These specs pin the WRITE MODE of the strip: exact offline, gliding live.
 * The audible proof is the browser parity gate; the numeric A/B harness for
 * the whole render path does not exist yet (see the report).
 */

type ParamCall = { method: "setTargetAtTime" | "setValueAtTime"; value: number; when: number };

interface MockParam {
  value: number;
  calls: ParamCall[];
  setTargetAtTime(value: number, when: number): void;
  setValueAtTime(value: number, when: number): void;
  linearRampToValueAtTime(value: number, when: number): void;
  exponentialRampToValueAtTime(value: number, when: number): void;
  setValueCurveAtTime(curve: Float32Array, when: number): void;
  cancelScheduledValues(when: number): void;
}

function mockParam(initial: number): MockParam {
  const param: MockParam = {
    value: initial,
    calls: [],
    setTargetAtTime(value, when) {
      param.calls.push({ method: "setTargetAtTime", value, when });
      param.value = value;
    },
    setValueAtTime(value, when) {
      param.calls.push({ method: "setValueAtTime", value, when });
      param.value = value;
    },
    linearRampToValueAtTime(value) {
      param.value = value;
    },
    exponentialRampToValueAtTime(value) {
      param.value = value;
    },
    setValueCurveAtTime() {
      /* the strip never curves */
    },
    cancelScheduledValues() {
      /* no-op */
    },
  };
  return param;
}

interface MockNode {
  kind: string;
  connections: Set<unknown>;
  connect(destination?: unknown): MockNode;
  disconnect(destination?: unknown): void;
  gain: MockParam;
  frequency: MockParam;
  Q: MockParam;
  pan: MockParam;
  delayTime: MockParam;
  threshold: MockParam;
  ratio: MockParam;
  attack: MockParam;
  release: MockParam;
  knee: MockParam;
  oversample: OverSampleType;
  curve: Float32Array | null;
  fftSize: number;
  channelCount: number;
  channelCountMode: ChannelCountMode;
}

function mockNode(kind: string): MockNode {
  const node: MockNode = {
    kind,
    connections: new Set<unknown>(),
    connect(destination?: unknown) {
      if (destination !== undefined) node.connections.add(destination);
      return node;
    },
    disconnect(destination?: unknown) {
      if (destination === undefined) node.connections.clear();
      else node.connections.delete(destination);
    },
    gain: mockParam(1),
    frequency: mockParam(350),
    Q: mockParam(1),
    pan: mockParam(0),
    delayTime: mockParam(0),
    threshold: mockParam(0),
    ratio: mockParam(1),
    attack: mockParam(0),
    release: mockParam(0),
    knee: mockParam(0),
    oversample: "none",
    curve: null,
    fftSize: 2048,
    channelCount: 2,
    channelCountMode: "max",
  };
  return node;
}

/** A context that records every AudioParam write it receives. */
class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  readonly created: { gain: MockNode[]; panner: MockNode[]; biquad: MockNode[]; waveshaper: MockNode[] } = {
    gain: [],
    panner: [],
    biquad: [],
    waveshaper: [],
  };
  createGain(): MockNode {
    const node = mockNode("gain");
    this.created.gain.push(node);
    return node;
  }
  createStereoPanner(): MockNode {
    const node = mockNode("panner");
    this.created.panner.push(node);
    return node;
  }
  createBiquadFilter(): MockNode {
    const node = mockNode("biquad");
    this.created.biquad.push(node);
    return node;
  }
  createWaveShaper(): MockNode {
    const node = mockNode("waveshaper");
    this.created.waveshaper.push(node);
    return node;
  }
  createAnalyser(): MockNode {
    return mockNode("analyser");
  }
  createDelay(): MockNode {
    return mockNode("delay");
  }
  createDynamicsCompressor(): MockNode {
    return mockNode("compressor");
  }
  createChannelSplitter(): MockNode {
    return mockNode("splitter");
  }
  createChannelMerger(): MockNode {
    return mockNode("merger");
  }
}

/** The engine decides the regime by context TYPE (src/audio-engine/liveContext.ts). */
class FakeOfflineAudioContext extends MockAudioContext {}

const globals = globalThis as unknown as { OfflineAudioContext?: unknown };

function useOfflineGlobal(enabled: boolean): void {
  if (enabled) globals.OfflineAudioContext = FakeOfflineAudioContext;
  else delete globals.OfflineAudioContext;
}

/** A distinctive fader/pan pair — no other node in the graph holds these values. */
const FADER_GAIN = 0.37;
const FADER_PAN = -0.83;

function docWithStrip(): ProjectDocument {
  const track = createDrumTrackModel("Strip");
  return {
    schemaVersion: 1,
    id: "offline-strip-doc",
    name: "offline strip",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [{ ...track, gain: FADER_GAIN, pan: FADER_PAN }],
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
}

describe("the mixer strip writes exactly in an offline render", () => {
  it("puts the fader and the pan on their values at the render origin, with no glide", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    useOfflineGlobal(true);
    try {
      const ctx = new FakeOfflineAudioContext();
      const engine = new AudioEngine();
      engine.useContext(ctx as unknown as BaseAudioContext);
      await engine.setProject(docWithStrip());

      const fader = ctx.created.gain.filter((node) => node.gain.calls.some((call) => call.value === FADER_GAIN));
      expect(fader.length, "the track fader must be written").toBeGreaterThan(0);
      for (const node of fader) {
        expect(node.gain.calls.filter((call) => call.value === FADER_GAIN)).toEqual([
          { method: "setValueAtTime", value: FADER_GAIN, when: 0 },
        ]);
      }

      const panners = ctx.created.panner.filter((node) => node.pan.calls.some((call) => call.value === FADER_PAN));
      expect(panners.length, "the track pan must be written").toBeGreaterThan(0);
      for (const node of panners) {
        expect(node.pan.calls.filter((call) => call.value === FADER_PAN)).toEqual([
          { method: "setValueAtTime", value: FADER_PAN, when: 0 },
        ]);
      }
    } finally {
      useOfflineGlobal(false);
    }
  }, 30_000);

  it("keeps the glide on a live context — a fader move must not click", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    useOfflineGlobal(false);
    const ctx = new MockAudioContext();
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as BaseAudioContext);
    await engine.setProject(docWithStrip());

    const fader = ctx.created.gain.filter((node) => node.gain.calls.some((call) => call.value === FADER_GAIN));
    expect(fader.length, "the track fader must be written").toBeGreaterThan(0);
    for (const node of fader) {
      expect(node.gain.calls.filter((call) => call.value === FADER_GAIN)).toEqual([
        { method: "setTargetAtTime", value: FADER_GAIN, when: 0 },
      ]);
    }
  }, 30_000);
});
