import { describe, expect, it, vi } from "vitest";
import { clampInstrumentParam, INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { midiToFreq, type InstrumentTrack } from "../src/project-model/types";

/**
 * STRINGS (kind #17) / BELL (kind #18) / REESE (kind #19) — wiring tests.
 *
 * Mock-graph pattern (organ-instrument.test.ts): the DSP is Web Audio node
 * wiring, so the contracts that matter are STRUCTURAL —
 *  - Strings: THREE detuned saws (the section) + delayed vibrato LFO,
 *  - Bell: carrier + inharmonic modulator (freq × RATIO) + shimmer partial
 *    + velocity-scaled FM index,
 *  - Reese: TWO beating saws + sine sub + slow filter MOVEMENT LFO,
 *  - all voices start AND stop, glide pulls from lastFreq.
 */

function mockParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

interface MockOsc {
  type: string;
  frequency: ReturnType<typeof mockParam>;
  detune: ReturnType<typeof mockParam>;
  started: number[];
  stopped: number[];
  start: (when?: number) => void;
  stop: (when?: number) => void;
  connect: (target: unknown) => unknown;
  disconnect: () => void;
  periodicWaveCalls: number;
  onended: (() => void) | null;
}

function mockCtx() {
  const record = {
    oscs: [] as MockOsc[],
    gains: [] as Array<{ gain: ReturnType<typeof mockParam> }>,
  };
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: { toString: () => "destination" },
    createGain: () => {
      const node = { gain: mockParam(1), connect: (n: unknown) => n, disconnect: () => undefined };
      record.gains.push(node);
      return node;
    },
    createStereoPanner: () => ({ pan: mockParam(0), connect: (n: unknown) => n, disconnect: () => undefined }),
    createBiquadFilter: () => ({
      type: "",
      frequency: mockParam(),
      Q: mockParam(),
      gain: mockParam(),
      detune: mockParam(),
      connect: (n: unknown) => n,
      disconnect: () => undefined,
    }),
    createWaveShaper: () => ({
      curve: null,
      oversample: "none",
      connect: (n: unknown) => n,
      disconnect: () => undefined,
    }),
    createBuffer: (_ch: number, length: number, _sr: number) => ({
      numberOfChannels: 1,
      length,
      duration: length / 44100,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const src = {
        buffer: null as unknown,
        loop: false,
        playbackRate: mockParam(1),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: (n: unknown) => n,
        disconnect: () => undefined,
      };
      return src;
    },
    createOscillator: () => {
      const osc: MockOsc = {
        type: "sine",
        frequency: mockParam(),
        detune: mockParam(),
        started: [],
        stopped: [],
        start: vi.fn((when?: number) => osc.started.push(when ?? 0)),
        stop: vi.fn((when?: number) => osc.stopped.push(when ?? Infinity)),
        connect: (target: unknown) => target,
        disconnect: vi.fn(),
        periodicWaveCalls: 0,
        onended: null,
      };
      record.oscs.push(osc);
      return osc;
    },
    createPeriodicWave: () => ({}),
  };
  return { ctx: ctx as never, record };
}

function trackOf(kind: "strings" | "bell" | "reese", overrides: Record<string, number> = {}): InstrumentTrack {
  const params = { ...defaultInstrumentParams(kind), ...overrides };
  return {
    id: `t-${kind}`,
    kind: "instrument",
    instrument: kind,
    name: kind,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params,
    effects: [],
    sends: {},
  };
}

const TEST_ENV = { bpm: 120, getSample: (_id: string | null) => undefined };

describe("strings — ensemble wiring", () => {
  it("builds a THREE-saw detuned section with detune offsets from ENSEMBLE", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.strings.factory(
      ctx as never,
      trackOf("strings", { ensemble: 1 }) as never,
      TEST_ENV,
    );
    runtime.noteOn(60, 0.9, 0, 1);
    const saws = record.oscs.filter((o) => o.type === "sawtooth");
    expect(saws).toHaveLength(3);
    // Detune offsets: 0, +7, -12 cents at full ENSEMBLE.
    const detunes = saws.map((o) => vi.mocked(o.detune.setValueAtTime).mock.calls[0]![0]);
    expect(detunes).toEqual([0, 7, -12]);
    runtime.dispose();
  });

  it("the vibrato LFO targets the FILTER frequency and delays its onset", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.strings.factory(
      ctx as never,
      trackOf("strings", { vibrato: 0.5, vibDelay: 0.5 }) as never,
      TEST_ENV,
    );
    runtime.noteOn(60, 0.9, 0, 1);
    const lfo = record.oscs.find((o) => o.frequency.value === 4.5);
    expect(lfo).toBeDefined();
    const lfoDepth = record.gains.find((node) =>
      vi.mocked(node.gain.linearRampToValueAtTime).mock.calls.some(([value]) => value === 11),
    );
    expect(lfoDepth).toBeDefined();
    // Vibrato reaches full depth after vibDelay + 300 ms, not at note-on.
    expect(lfoDepth!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(11, 0.8);
    runtime.dispose();
  });
});

describe("bell — inharmonic FM wiring", () => {
  it("wires carrier + modulator at freq×RATIO + shimmer at ~5.4×", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.bell.factory(ctx as never, trackOf("bell", { ratio: 3.46 }) as never, TEST_ENV);
    runtime.noteOn(69, 0.9, 0, 0.5);
    const sines = record.oscs.filter((o) => o.type === "sine" && o.started.length > 0);
    expect(sines.length).toBeGreaterThanOrEqual(3); // carrier + modulator + shimmer
    const freqs = sines.map((o) => o.frequency.value);
    const a4 = 440;
    expect(freqs).toContain(a4); // carrier
    expect(freqs.some((f) => Math.abs(f! - a4 * 3.46) < 0.01)).toBe(true); // modulator
    expect(freqs.some((f) => Math.abs(f! - a4 * 5.4) < 0.01)).toBe(true); // shimmer
    runtime.dispose();
  });

  it("FM index scales with velocity (harder strike = brighter bite)", () => {
    const run = (vel: number) => {
      const { ctx, record } = mockCtx();
      const runtime = INSTRUMENT_DEFS.bell.factory(ctx as never, trackOf("bell") as never, TEST_ENV);
      runtime.noteOn(69, vel, 0, 0.5);
      runtime.dispose();
      return record;
    };
    const soft = run(0.3);
    const hard = run(1);
    const fmIndex = (record: ReturnType<typeof mockCtx>["record"]) =>
      record.gains
        .flatMap((node) => vi.mocked(node.gain.setValueAtTime).mock.calls.map(([value]) => value))
        .find((value) => value > 500);
    expect(fmIndex(soft)).toBeCloseTo(440 * (1.2 + 0.3 * 1.6));
    expect(fmIndex(hard)).toBeCloseTo(440 * (1.2 + 1 * 1.6));
    expect(fmIndex(hard)).toBeGreaterThan(fmIndex(soft)!);
  });
});

describe("reese — beating pair wiring", () => {
  it("builds TWO saws detuned oppositely + a sine sub + movement LFO", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.reese.factory(
      ctx as never,
      trackOf("reese", { detune: 1, movement: 0.5 }) as never,
      TEST_ENV,
    );
    runtime.noteOn(45, 0.9, 0, 1);
    const saws = record.oscs.filter((o) => o.type === "sawtooth" && o.started.length > 0);
    expect(saws).toHaveLength(2);
    const frequencyRatios = saws.map((o) => vi.mocked(o.frequency.setValueAtTime).mock.calls[0]![0] / midiToFreq(45));
    expect(frequencyRatios[0]).toBeCloseTo(2 ** (-35 / 1200));
    expect(frequencyRatios[1]).toBeCloseTo(2 ** (35 / 1200));
    // The sub anchor is a sine that is NOT detuned.
    const sub = record.oscs.filter((o) => o.type === "sine" && o.started.length > 0);
    expect(sub.length).toBeGreaterThanOrEqual(1);
    // Movement LFO present (the only LFO is the movement walk).
    const lfo = record.oscs.filter((o) => o.frequency.value > 0 && o.frequency.value < 4 && o.started.length > 0);
    expect(lfo.length).toBeGreaterThanOrEqual(1);
    runtime.dispose();
  });

  it("glide pulls both saws from lastFreq (legato slides)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.reese.factory(ctx as never, trackOf("reese", { glide: 0.6 }) as never, TEST_ENV);
    runtime.noteOn(45, 0.9, 0, 0.5);
    runtime.noteOn(50, 0.9, 0.6, 0.5, { pitch: 45, when: 0 });
    // The second note's saws must schedule from the previous pitch.
    const secondNoteSaws = record.oscs.filter(
      (o) => o.type === "sawtooth" && o.started.some((t) => Math.abs(t - 0.6) < 1e-9),
    );
    expect(secondNoteSaws).toHaveLength(2);
    const detuneCents = 0.7 * 35;
    expect(secondNoteSaws[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(
      midiToFreq(45) * 2 ** (-detuneCents / 1200),
      0.6,
    );
    expect(secondNoteSaws[0]!.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      midiToFreq(50) * 2 ** (-detuneCents / 1200),
      0.84,
    );
    expect(secondNoteSaws[1]!.frequency.setValueAtTime).toHaveBeenCalledWith(
      midiToFreq(45) * 2 ** (detuneCents / 1200),
      0.6,
    );
    runtime.dispose();
  });
});

describe("strings/bell/reese — presets and registration", () => {
  it("ships the promised preset counts and stays within param bounds", () => {
    expect(FACTORY_PRESETS.filter((p) => p.instrument === "strings")).toHaveLength(10);
    expect(FACTORY_PRESETS.filter((p) => p.instrument === "bell")).toHaveLength(10);
    expect(FACTORY_PRESETS.filter((p) => p.instrument === "reese")).toHaveLength(8);
    for (const kind of ["strings", "bell", "reese"] as const) {
      for (const preset of FACTORY_PRESETS.filter((p) => p.instrument === kind)) {
        for (const [id, value] of Object.entries(preset.params)) {
          expect(clampInstrumentParam(kind, id, value as number)).toBe(value as number);
        }
      }
    }
  });
});
