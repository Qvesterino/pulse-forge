import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { SampleBank } from "../src/sample-library/factory";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumPad, InstrumentTrack } from "../src/project-model/types";

/**
 * AUDIO-BOUNDARY NUMERIC GATE (engine audit 2026-10-18)
 *
 * `AudioParam.setValueAtTime(NaN)` / `start(NaN)` throw, and a throw inside a
 * scheduler tick aborts the rest of that tick. The audit probe proved the whole
 * class reachable: a non-finite pitch bend is STORED on the instrument state,
 * so one bad bend poisons every later note (`adjustedPitch = pitch + NaN`), and
 * a NaN drum velocity reaches `Math.max(0, NaN)` → `setValueAtTime(NaN)`.
 *
 * These specs pin the boundary: invalid events are dropped, valid ones are
 * untouched (the positive control proves the drop is selective, not a blanket
 * no-op).
 */

interface MockNode {
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
      if (!Number.isFinite(v)) throw new TypeError(`setTargetAtTime(${v})`);
      value = v;
    },
    setValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`setValueAtTime(${v})`);
      value = v;
    },
    linearRampToValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`linearRampToValueAtTime(${v})`);
      value = v;
    },
    exponentialRampToValueAtTime(v: number) {
      if (!Number.isFinite(v)) throw new TypeError(`exponentialRampToValueAtTime(${v})`);
      value = v;
    },
    setValueCurveAtTime() {},
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
  };
}

function makeCtx(sampleRate = 48000) {
  const created: MockNode[] = [];
  const make = (): MockNode & Record<string, unknown> => {
    const node = {
      connections: new Set<MockNode>(),
      gain: param(1),
      pan: param(0),
      connect(destination?: MockNode) {
        if (destination && typeof destination === "object") node.connections.add(destination);
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
        start(when?: number) {
          if (when !== undefined && !Number.isFinite(when)) throw new TypeError(`osc.start(${when})`);
        },
        stop() {},
        onended: null,
      }),
    createBufferSource: () =>
      Object.assign(make(), {
        buffer: null,
        playbackRate: param(1),
        detune: param(0),
        start(when?: number) {
          if (when !== undefined && !Number.isFinite(when)) throw new TypeError(`source.start(${when})`);
        },
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

async function build() {
  const ctx = makeCtx();
  const engine = new AudioEngine();
  engine.useContext(ctx as unknown as AudioContext);
  const doc = createProjectFromTemplate("house");
  engine.setProject(doc);
  await flush();
  const instrument = doc.tracks.find((t) => t.kind === "instrument") as InstrumentTrack;
  const drum = doc.tracks.find((t) => t.kind === "drum");
  const pad = drum && drum.kind === "drum" ? (drum.pads[0] as DrumPad) : null;
  // A sampled pad needs its buffer in the bank; without it the trigger path
  // early-returns and the positive control below would be vacuous.
  if (pad) {
    const bank = new SampleBank();
    const buffer = ctx.createBuffer(1, 4800, 48000) as unknown as AudioBuffer;
    bank.add(pad.assetId ?? "audit-pad", buffer);
    engine.attachBank(bank);
  }
  return { ctx, engine, instrument, drum, pad };
}

describe("audio boundary numeric gate", () => {
  it("a non-finite pitch bend must not poison every later note", async () => {
    const { engine, instrument } = await build();
    engine.setMidiPitchBend(instrument.id, Number.NaN);
    // The regression: the stored NaN made adjustedPitch NaN and threw inside
    // the instrument runtime on EVERY note until the bend was reset.
    expect(() => engine.noteOn(instrument.id, 60, 0.8, 1.01, 0.2)).not.toThrow();
    await flush();
    engine.setMidiPitchBend(instrument.id, 12);
    expect(() => engine.noteOn(instrument.id, 62, 0.8, 1.02, 0.2)).not.toThrow();
  });

  it("an absurd bend is clamped to the MPE ceiling instead of poisoning the pitch math", async () => {
    const { engine, instrument } = await build();
    engine.setMidiPitchBend(instrument.id, 1e9);
    const state = (engine as unknown as { instruments: Map<string, { pitchBend?: number }> }).instruments.get(
      instrument.id,
    );
    expect(state?.pitchBend).toBe(96);
  });

  it("NEGATIVE: non-finite note/slide/off events are dropped without throwing", async () => {
    const { engine, instrument } = await build();
    expect(() => engine.noteOn(instrument.id, Number.NaN, 0.8, 1.01, 0.2)).not.toThrow();
    expect(() => engine.noteOn(instrument.id, 60, Number.NaN, 1.01, 0.2)).not.toThrow();
    expect(() => engine.noteOn(instrument.id, 60, 0.8, Number.NaN, 0.2)).not.toThrow();
    expect(() => engine.noteOn(instrument.id, 60, 0.8, 1.01, Number.NaN)).not.toThrow();
    expect(() => engine.noteSlide(instrument.id, Number.NaN, 1.01, 0.2)).not.toThrow();
    expect(() => engine.noteSlide(instrument.id, 60, Number.POSITIVE_INFINITY, 0.2)).not.toThrow();
    expect(() => engine.noteOff(instrument.id, Number.NaN, 1.02)).not.toThrow();
    expect(() => engine.noteOff(instrument.id, 60, Number.NaN)).not.toThrow();
    expect(() => engine.polyTimbre(instrument.id, Number.NaN, 0.5)).not.toThrow();
    expect(() => engine.polyPressure(instrument.id, 60, Number.NaN)).not.toThrow();
    await flush();
  });

  it("NEGATIVE: a non-finite drum hit is dropped; a valid hit still creates a voice", async () => {
    const { engine, drum, pad } = await build();
    expect(drum, "house template must seed a drum track").toBeDefined();
    expect(pad, "house template must seed pads").not.toBeNull();
    const before = engine.voiceCount;
    expect(() => engine.trigger(drum!.id, pad!, 1.01, Number.NaN)).not.toThrow();
    expect(() => engine.trigger(drum!.id, pad!, Number.NaN, 0.9)).not.toThrow();
    expect(engine.voiceCount, "invalid hits must not create a voice").toBe(before);
    // Positive control: the same pad with finite values DOES create one
    // (synth pads fall back to the noise synth; sampled pads need the bank).
    engine.trigger(drum!.id, pad!, 1.01, 0.9);
    await flush();
    expect(engine.voiceCount, "valid hit was dropped too — the guard is not selective").toBeGreaterThan(before);
  });

  it("counts every dropped event but logs only the FIRST per kind (no tick spam)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { engine, instrument, drum, pad } = await build();
      for (let i = 0; i < 25; i += 1) engine.noteOn(instrument.id, Number.NaN, 0.8, 1, 0.2);
      expect(engine.audioBoundaryDiagnostics.note, "every drop is counted").toBe(25);
      const noteWarnings = warn.mock.calls.filter(([message]) => String(message).includes("non-finite note"));
      expect(noteWarnings, "the first occurrence logs once; later ones only count").toHaveLength(1);

      engine.setMidiPitchBend(instrument.id, Number.NaN);
      engine.trigger(drum!.id, pad!, 1, Number.NaN);
      expect(engine.audioBoundaryDiagnostics.pitchBend).toBe(1);
      expect(engine.audioBoundaryDiagnostics.drumHit).toBe(1);
      // A fresh engine starts clean; the counter belongs to the instance.
      expect(new AudioEngine().audioBoundaryDiagnostics).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  it("diagnostics expose the dropped-event counters the panel reads", async () => {
    const { engine, instrument } = await build();
    for (let i = 0; i < 3; i += 1) engine.noteOn(instrument.id, Number.NaN, 0.8, 1, 0.2);
    engine.setMidiPitchBend(instrument.id, Number.NaN);
    const diagnostics = engine.getDiagnostics();
    expect(diagnostics.audioBoundaryDrops).toBe(4);
    expect(diagnostics.audioBoundaryDropKinds).toBe("note=3, pitchBend=1");
    // A clean engine reports the real empty state, not a fabricated kind list.
    expect(new AudioEngine().getDiagnostics().audioBoundaryDropKinds).toBe("none");
    expect(new AudioEngine().getDiagnostics().audioBoundaryDrops).toBe(0);
  });
});
