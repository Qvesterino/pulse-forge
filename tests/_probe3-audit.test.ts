import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createProjectFromTemplate } from "../src/project-model/templates";

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
    exponentialRampToValueAtTime(v: number) {
      value = v;
    },
    setValueCurveAtTime() {},
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
  };
}

function makeCtx(sampleRate = 48000) {
  const make = (): Record<string, unknown> => {
    const node = {
      connections: new Set<unknown>(),
      gain: param(1),
      pan: param(0),
      connect(destination?: unknown) {
        if (destination && typeof destination === "object") {
          (node.connections as Set<unknown>).add(destination);
        }
        return node;
      },
      disconnect(destination?: unknown) {
        if (destination === undefined) (node.connections as Set<unknown>).clear();
        else (node.connections as Set<unknown>).delete(destination);
      },
    };
    return node;
  };
  const ctx = {
    state: "running",
    currentTime: 1,
    sampleRate,
    onstatechange: null as (() => void) | null,
    createGain: make,
    createStereoPanner: make,
    createAnalyser: () =>
      Object.assign(make(), {
        fftSize: 0,
        channelCount: 2,
        channelCountMode: "explicit",
        getFloatTimeDomainData() {},
        getByteFrequencyData() {},
      }),
    createDelay: () => Object.assign(make(), { delayTime: param(0) }),
    createDynamicsCompressor: () =>
      Object.assign(make(), {
        reduction: 0,
        threshold: param(0),
        knee: param(0),
        ratio: param(1),
        attack: param(0),
        release: param(0),
      }),
    createBiquadFilter: () => Object.assign(make(), { type: "lowpass", frequency: param(440), Q: param(1) }),
    createChannelSplitter: make,
    createChannelMerger: make,
    createWaveShaper: () => Object.assign(make(), { oversample: "none", curve: null }),
    createConvolver: () => Object.assign(make(), { buffer: null, normalize: true }),
    createConstantSource: () => Object.assign(make(), { offset: param(0), start() {}, stop() {} }),
    createOscillator: () =>
      Object.assign(make(), {
        type: "sine",
        frequency: param(440),
        detune: param(0),
        start() {},
        stop() {},
        onended: null,
      }),
    createBufferSource: () =>
      Object.assign(make(), {
        buffer: null,
        playbackRate: param(1),
        detune: param(0),
        start() {},
        stop() {},
        onended: null,
      }),
    createBuffer: (channels: number, len: number, rate: number) => ({
      length: len,
      sampleRate: rate,
      numberOfChannels: channels,
      duration: len / rate,
      getChannelData: () => new Float32Array(len),
      copyToChannel() {},
    }),
    decodeAudioData: async () => ({
      duration: 1,
      sampleRate,
      numberOfChannels: 2,
      length: sampleRate,
      getChannelData: () => new Float32Array(sampleRate),
      copyToChannel() {},
    }),
    audioWorklet: { addModule: async () => {} },
    destination: make(),
  };
  return ctx;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("probe 3", () => {
  it("why does the sample diff not fire?", async () => {
    const ctx = makeCtx(48000);
    const engine = new AudioEngine();
    engine.useContext(ctx as unknown as AudioContext);
    const doc = createProjectFromTemplate("house");
    engine.setProject(doc);
    await flush();
    await flush();

    const internals = engine as unknown as {
      instruments: Map<string, { runtime: Record<string, unknown>; sampleId: string | null; sampleIdB: string | null }>;
    };
    const states = [...internals.instruments.entries()];
    console.log(
      "STATE SAMPLE IDS",
      states.map(([id, s]) => ({ id: id.slice(0, 12), sampleId: s.sampleId, sampleIdB: s.sampleIdB })),
    );
    console.log(
      "DOC TRACKS",
      doc.tracks.map((t) => ({ id: t.id.slice(0, 12), kind: t.kind, sampleId: (t as { sampleId?: string }).sampleId })),
    );

    const [firstId, first] = states[0]!;
    const [secondId] = states[1]!;
    const calls: string[] = [];
    first.runtime.setSample = (id: string) => {
      calls.push(`first:${id}`);
    };
    states[1]![1].runtime.setSample = (id: string) => {
      calls.push(`second:${id}`);
    };

    const next = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "instrument" ? { ...t, sampleId: t.id === firstId ? "sample-a" : "sample-b" } : t,
      ),
    };
    console.log(
      "NEXT TRACKS",
      next.tracks.map((t) => ({ id: t.id.slice(0, 12), kind: t.kind, sampleId: (t as { sampleId?: string }).sampleId })),
    );
    engine.setProject(next);
    await flush();
    await flush();
    console.log("CALLS", calls);
    console.log("SECOND ID", secondId.slice(0, 12));

    expect(true).toBe(true);
  });
});
