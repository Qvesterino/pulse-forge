import { describe, expect, it } from "vitest";
import { EFFECT_DEFS, withOfflineEffectParams } from "../src/effects/registry";
import { defaultParamsOf } from "../src/effects/definitions";
import { createDrumTrackModel } from "../src/project-model/schema";
import type { EffectInstance, ProjectDocument } from "../src/project-model/types";

/**
 * OFFLINE parameter regime (live↔offline null test).
 *
 * In the REALTIME branch the effect chain is built long before its first
 * note is audible, so the construction-time smoothing has settled by the
 * time anything reaches the speaker. In an OFFLINE render the chain is
 * built AT the render origin — the very same smoothing is still in flight
 * when the first event lands (50 ms = 2.5 time constants at tc = 20 ms →
 * the parameter sits at 91.8 % of the way to its target). The export then
 * starts from the NODE's default values and glides into the document's
 * values, which is exactly what the live↔offline null test measured
 * (liveNull ≈ -17…-33 dB against a -40 dB floor).
 *
 * The offline regime applies the document's values INSTANTLY at
 * construction (setValueAtTime), so the render starts from the same values
 * the settled live chain plays.
 *
 * These specs pin the WRITE MODE (instant vs glide), the SCOPE of the
 * regime, and the engine's routing by context type. The audible proof is
 * the browser parity gate.
 */

type ParamCall = { method: "setTargetAtTime" | "setValueAtTime"; value: number; when: number };

interface MockParam {
  value: number;
  calls: ParamCall[];
  setTargetAtTime(value: number, when: number): void;
  setValueAtTime(value: number, when: number): void;
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
    // The BiquadFilterNode's own default cutoff — the value an offline
    // render used to start from.
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
  };
  return node;
}

/** A context that records every AudioParam write it receives. */
class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  readonly created: { gain: MockNode[]; biquad: MockNode[]; waveshaper: MockNode[] } = {
    gain: [],
    biquad: [],
    waveshaper: [],
  };
  createGain(): MockNode {
    const node = mockNode("gain");
    this.created.gain.push(node);
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
  createStereoPanner(): MockNode {
    return mockNode("panner");
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

/** Install (or remove) the fake OfflineAudioContext global. */
function useOfflineGlobal(enabled: boolean): void {
  if (enabled) globals.OfflineAudioContext = FakeOfflineAudioContext;
  else delete globals.OfflineAudioContext;
}

function saturationInstance(): EffectInstance {
  return {
    id: "fx-saturation",
    type: "saturation",
    bypassed: false,
    params: defaultParamsOf("saturation"),
  };
}

/** Build the saturation chain; `offline` picks the parameter regime. */
function buildSaturation(offline: boolean) {
  useOfflineGlobal(offline);
  try {
    const ctx = offline ? new FakeOfflineAudioContext() : new MockAudioContext();
    const runtime = withOfflineEffectParams(ctx as unknown as BaseAudioContext, () =>
      EFFECT_DEFS.saturation.factory(ctx as unknown as BaseAudioContext, saturationInstance(), { bpm: 124 }),
    );
    return {
      ctx,
      runtime,
      /** The TONE lowpass — the second biquad the factory builds. */
      tone: ctx.created.biquad[1],
      /** The mix bus wet gain — the 4th gain the factory builds. */
      wet: ctx.created.gain[3],
    };
  } finally {
    useOfflineGlobal(false);
  }
}

describe("offline effect parameter regime", () => {
  it("applies the document's tone value INSTANTLY in an offline render", () => {
    const { tone } = buildSaturation(true);
    // The node's own default is 350 Hz; the document says 8000 Hz.
    expect(tone.frequency.calls).toEqual([{ method: "setValueAtTime", value: 8000, when: 0 }]);
    expect(tone.frequency.calls.some((call) => call.method === "setTargetAtTime")).toBe(false);
  });

  it("glides the same value in the live branch (a knob move must not click)", () => {
    const { tone } = buildSaturation(false);
    expect(tone.frequency.calls).toEqual([{ method: "setTargetAtTime", value: 8000, when: 0 }]);
    expect(tone.frequency.calls.some((call) => call.method === "setValueAtTime")).toBe(false);
  });

  it("opens the mix bus instantly offline, so the export does not start on the dry side", () => {
    const { wet } = buildSaturation(true);
    // The bus starts SILENT on the wet side; mix = 1 in the document.
    expect(wet.gain.value).toBe(1);
    expect(wet.gain.calls.every((call) => call.method === "setValueAtTime")).toBe(true);
  });

  it("keeps the glide for a write scheduled AFTER the construction moment", () => {
    useOfflineGlobal(true);
    try {
      const ctx = new FakeOfflineAudioContext();
      const runtime = withOfflineEffectParams(ctx as unknown as BaseAudioContext, () =>
        EFFECT_DEFS.saturation.factory(ctx as unknown as BaseAudioContext, saturationInstance(), { bpm: 124 }),
      );
      const tone = ctx.created.biquad[1];
      const before = tone.frequency.calls.length;
      // A scheduled ramp the live engine would have heard must be heard by the
      // export too — only the CONSTRUCTION write is exact.
      runtime.setParameterAt?.("tone", 4000, 0.5);
      const added = tone.frequency.calls.slice(before);
      expect(added).toEqual([{ method: "setTargetAtTime", value: 4000, when: 0.5 }]);
    } finally {
      useOfflineGlobal(false);
    }
  });

  it("scopes the regime to the call — a later live build still glides", () => {
    const ctx = new MockAudioContext();
    withOfflineEffectParams(ctx as unknown as BaseAudioContext, () =>
      EFFECT_DEFS.saturation.factory(ctx as unknown as BaseAudioContext, saturationInstance(), { bpm: 124 }),
    );
    const liveCtx = new MockAudioContext();
    EFFECT_DEFS.saturation.factory(liveCtx as unknown as BaseAudioContext, saturationInstance(), { bpm: 124 });
    expect(liveCtx.created.biquad[1].frequency.calls[0]?.method).toBe("setTargetAtTime");
  });

  it("restores the regime even when the factory throws", () => {
    expect(() =>
      withOfflineEffectParams(new MockAudioContext() as unknown as BaseAudioContext, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const { tone } = buildSaturation(false);
    expect(tone.frequency.calls[0]?.method).toBe("setTargetAtTime");
  });
});

/**
 * The ENGINE wiring: the regime follows the CONTEXT TYPE. The renderer hands
 * the engine an OfflineAudioContext and the chain is built from the
 * document's values; a live engine keeps its glide so a knob move does not
 * click.
 */
describe("the engine routes the parameter regime by context type", () => {
  const docWithSaturation = () => {
    const track = createDrumTrackModel("A");
    return {
      schemaVersion: 1,
      id: "offline-params-doc",
      name: "offline params",
      bpm: 124,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [
        {
          ...track,
          effects: [{ id: "fx-1", type: "saturation", bypassed: false, params: defaultParamsOf("saturation") }],
        },
      ],
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
  };

  /** The tone lowpass is the biquad whose frequency was written with 8000 Hz. */
  const toneOf = (ctx: MockAudioContext) =>
    ctx.created.biquad.find((node) => node.frequency.calls.some((c) => c.value === 8000));

  it("builds the chain with exact writes on an OfflineAudioContext", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    useOfflineGlobal(true);
    try {
      const ctx = new FakeOfflineAudioContext();
      const engine = new AudioEngine();
      engine.useContext(ctx as unknown as BaseAudioContext);
      await engine.setProject(docWithSaturation());
      const tone = toneOf(ctx);
      expect(tone, "the saturation chain must be built").toBeTruthy();
      expect(tone!.frequency.calls[0]?.method).toBe("setValueAtTime");
      expect(tone!.frequency.calls.some((c) => c.method === "setTargetAtTime")).toBe(false);
    } finally {
      useOfflineGlobal(false);
    }
  }, 30_000);

  it("keeps the glide on a live context", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    useOfflineGlobal(false);
    const ctx = new MockAudioContext();
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as BaseAudioContext);
    await engine.setProject(docWithSaturation());
    const tone = toneOf(ctx);
    expect(tone, "the saturation chain must be built").toBeTruthy();
    expect(tone!.frequency.calls[0]?.method).toBe("setTargetAtTime");
  }, 30_000);
});
