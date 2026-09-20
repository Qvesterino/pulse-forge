import { describe, expect, it } from "vitest";
import { defaultMasterConfig } from "../src/project-model/schema";

/**
 * Master finish chain wiring (DC blocker + buss glue) with a mocked audio
 * context — no DSP, no worklets. The mock has no AudioWorklet support, so
 * the glue builds its native-DCN fallback path (same settings, coarse GR),
 * which is exactly what the assertions drive: DC highpass @12 Hz, fallback
 * threshold/ratio follow the GLUE toggle.
 */

function mockNode() {
  const chainable = {
    connect() {
      return chainable;
    },
    disconnect() {},
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
    reduction: 0,
    curve: null,
    oversample: "none" as OverSampleType,
    type: "",
    ...chainable,
  };
}

function mockCtx() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    destination: mockNode(),
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => mockNode(),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => mockNode(),
    createBiquadFilter: () => mockNode(),
    createWaveShaper: () => mockNode(),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
  };
}

function masterDoc(glueEnabled: boolean) {
  return {
    schemaVersion: 1,
    id: "master-finish-doc",
    name: "MasterFinish",
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
    master: { ...defaultMasterConfig(), glueEnabled },
    createdAt: "",
    updatedAt: "",
  };
}

describe("master finish chain", () => {
  it("builds a fixed 12 Hz DC blocker ahead of the glue", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    engine.setProject(masterDoc(true) as never);
    const anyEngine = engine as unknown as {
      masterDc: { type: string; frequency: { value: number }; Q: { value: number } } | null;
    };
    expect(anyEngine.masterDc?.type).toBe("highpass");
    expect(anyEngine.masterDc?.frequency.value).toBe(12);
    expect(anyEngine.masterDc?.Q.value).toBe(0.5);
  });

  it("glue defaults ON in a fresh master config", () => {
    expect(defaultMasterConfig().glueEnabled).toBe(true);
  });

  it("native fallback follows the GLUE toggle (threshold/ratio park when off)", async () => {
    const { AudioEngine } = await import("../src/audio-engine/AudioEngine");
    const engine = new AudioEngine();
    engine.useContext(mockCtx() as unknown as BaseAudioContext);
    engine.setProject(masterDoc(true) as never);
    const anyEngine = engine as unknown as {
      masterGlueNative: { threshold: { value: number }; ratio: { value: number } } | null;
    };
    // No AudioWorklet in the mock → native fallback with glue settings.
    expect(anyEngine.masterGlueNative?.threshold.value).toBe(-6);
    expect(anyEngine.masterGlueNative?.ratio.value).toBe(2);
    engine.setProject(masterDoc(false) as never);
    expect(anyEngine.masterGlueNative?.threshold.value).toBe(0);
    expect(anyEngine.masterGlueNative?.ratio.value).toBe(1);
  });
});
