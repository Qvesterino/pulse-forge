import { describe, expect, it, vi } from "vitest";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import type { InstrumentTrack } from "../src/project-model/types";

/**
 * SYNTH DRIFT KIT — wiring tests (mock-graph pattern).
 *
 * The analog "alive" quality: every subtractive voice oscillator gets a
 * slow seeded detune wander (sine LFO 0.4–0.9 Hz, ±1.8–5 ct) through a
 * depth gain into the osc's detune input. Contracts:
 *  - WHICH oscillators drift: analog non-sine oscs + unison copies, keys
 *    carrier, strings/brass section saws, reese beating pair, acid osc.
 *    Sine subs NEVER drift (the pitch anchor stays rock-solid).
 *  - WHERE it lands: drift → depth gain (exact cents) → osc.detune edge.
 *  - DETERMINISM: same track id → same drift rate + phase offset, so
 *    live == offline and re-renders are bit-comparable.
 */

interface MockNode {
  __id: number;
  connect: (target: unknown) => unknown;
  disconnect: () => void;
}

interface MockParam {
  __id: number;
  __ownerId: number;
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

interface MockOsc extends MockNode {
  type: string;
  frequency: MockParam;
  detune: MockParam;
  started: number[];
  stopped: number[];
  start: (when?: number) => void;
  stop: (when?: number) => void;
  setPeriodicWave: (w: unknown) => void;
  onended: (() => void) | null;
}

interface MockGraph {
  oscs: MockOsc[];
  gains: Array<MockNode & { gain: MockParam }>;
  edges: Array<[number, number]>;
}

let nextId = 1;

function mockParam(ownerId: number, initial = 0): MockParam {
  return {
    __id: nextId++,
    __ownerId: ownerId,
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function mockCtx() {
  const record: MockGraph = { oscs: [], gains: [], edges: [] };
  const link = (fromId: number) => (target: unknown) => {
    if (target && typeof target === "object" && "__id" in (target as MockNode)) {
      record.edges.push([fromId, (target as MockNode).__id]);
    }
    return target;
  };
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: { __id: 0, toString: () => "destination" },
    createGain: () => {
      const id = nextId++;
      const node = { __id: id, gain: mockParam(id, 1), connect: link(id), disconnect: () => undefined };
      record.gains.push(node);
      return node;
    },
    createStereoPanner: () => {
      const id = nextId++;
      return { __id: id, pan: mockParam(id), connect: link(id), disconnect: () => undefined };
    },
    createBiquadFilter: () => {
      const id = nextId++;
      return {
        __id: id,
        type: "",
        frequency: mockParam(id),
        Q: mockParam(id),
        gain: mockParam(id),
        detune: mockParam(id),
        connect: link(id),
        disconnect: () => undefined,
      };
    },
    createWaveShaper: () => {
      const id = nextId++;
      return { __id: id, curve: null, oversample: "none", connect: link(id), disconnect: () => undefined };
    },
    createBuffer: (_ch: number, length: number, _sr: number) => ({
      numberOfChannels: 1,
      length,
      duration: length / 44100,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const id = nextId++;
      return {
        __id: id,
        buffer: null as unknown,
        loop: false,
        playbackRate: mockParam(id, 1),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: link(id),
        disconnect: () => undefined,
      };
    },
    createOscillator: () => {
      const id = nextId++;
      const osc: MockOsc = {
        __id: id,
        type: "sine",
        frequency: mockParam(id),
        detune: mockParam(id),
        started: [],
        stopped: [],
        start: vi.fn((when?: number) => osc.started.push(when ?? 0)),
        stop: vi.fn((when?: number) => osc.stopped.push(when ?? Infinity)),
        setPeriodicWave: vi.fn(),
        onended: null,
        connect: link(id),
        disconnect: () => undefined,
      };
      record.oscs.push(osc);
      return osc;
    },
    createPeriodicWave: () => ({}),
  };
  return { ctx: ctx as never, record };
}

function trackOf(kind: InstrumentTrack["instrument"], overrides: Record<string, number> = {}): InstrumentTrack {
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

const TEST_ENV = { bpm: 124, getSample: (_id: string | null) => undefined };

/** A drift LFO: a slow sine in the 0.4–0.9 Hz wander band that starts AND stops with the voice. */
function driftLfos(record: MockGraph) {
  return record.oscs.filter(
    (o) =>
      o.type === "sine" &&
      o.frequency.value >= 0.39 &&
      o.frequency.value <= 0.9 &&
      o.started.length > 0 &&
      o.stopped.length > 0,
  );
}

/** Follow drift → depth gain → target param; returns { depthCents, targetOsc }. */
function driftWiring(record: MockGraph, drift: MockOsc): { depth: number; target: MockOsc | null } {
  const depthEdge = record.edges.find(([from]) => from === drift.__id);
  expect(depthEdge).toBeDefined();
  const depth = record.gains.find((g) => g.__id === depthEdge![1]);
  expect(depth).toBeDefined();
  const targetEdge = record.edges.find(([from]) => from === depth!.__id);
  expect(targetEdge).toBeDefined();
  const target = record.oscs.find((o) => o.detune.__id === targetEdge![1]);
  return { depth: depth!.gain.value, target: target ?? null };
}

describe("analog — drift wiring", () => {
  it("drifts BOTH saw oscs but never the sine sub", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.analog.factory(ctx, trackOf("analog") as never, TEST_ENV);
    runtime.noteOn(60, 0.9, 0, 1);
    // Default oscA=2 (saw) + oscB=2 (saw) + sub sine → exactly 2 drift LFOs.
    // Band-limited saws keep type "sine" + setPeriodicWave, so non-sine =
    // "has a custom periodic wave".
    const drifts = driftLfos(record);
    expect(drifts).toHaveLength(2);
    for (const d of drifts) {
      const { depth, target } = driftWiring(record, d);
      expect(depth).toBe(4);
      expect(target).not.toBeNull();
      // The anchor: whatever the drift feeds is NOT the sine sub (an octave
      // down, never given a periodic wave).
      expect(vi.mocked(target!.setPeriodicWave).mock.calls.length).toBeGreaterThan(0);
      expect(target!.frequency.value).not.toBeCloseTo(261.6255653005986 / 2, 1);
      // Baked phase offset lives in the detune base value (oscB carries an
      // extra static +8 ct, so bound is base + drift depth, not depth alone).
      expect(Math.abs(target!.detune.value)).toBeLessThanOrEqual(12.1);
    }
    runtime.dispose();
  });

  it("skips drift when the osc IS a sine (OSC A = sine)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.analog.factory(
      ctx,
      trackOf("analog", { oscA: 0, oscB: 0, subLevel: 0.25 }) as never,
      TEST_ENV,
    );
    runtime.noteOn(60, 0.9, 0, 1);
    expect(driftLfos(record)).toHaveLength(0);
    runtime.dispose();
  });

  it("drifts every UNISON copy on top of the main oscs", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.analog.factory(ctx, trackOf("analog", { unison: 3 }) as never, TEST_ENV);
    runtime.noteOn(60, 0.9, 0, 1);
    // 2 main saws + 3 unison copies = 5 drifting oscs (unison wave = OSC A saw).
    expect(driftLfos(record)).toHaveLength(5);
    runtime.dispose();
  });

  it("is deterministic: same track id → same drift rates, different track id → different rates", () => {
    const rates: number[][] = [];
    for (const id of ["t-analog", "t-analog", "t-analog2"]) {
      const { ctx, record } = mockCtx();
      const track = { ...trackOf("analog"), id } as never;
      const runtime = INSTRUMENT_DEFS.analog.factory(ctx, track, TEST_ENV);
      runtime.noteOn(60, 0.9, 0, 1);
      rates.push(
        driftLfos(record)
          .map((d) => d.frequency.value)
          .sort((a, b) => a - b),
      );
      runtime.dispose();
    }
    expect(rates[0]).toEqual(rates[1]);
    expect(rates[0]).not.toEqual(rates[2]);
  });
});

describe("keys — carrier drift wiring", () => {
  it("drifts BOTH FM carriers (tine + bell pair) at 3.2 ct; modulators stay clean", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.keys.factory(ctx, trackOf("keys") as never, TEST_ENV);
    runtime.noteOn(60, 0.9, 0, 1);
    // Keys drift rate: 0.6 + (modRatio % 0.5) → 0.6–1.1 Hz band. Default
    // builds TWO FM pairs (tine + bell), each with its own drift LFO.
    const drifts = record.oscs.filter(
      (o) => o.type === "sine" && o.frequency.value >= 0.59 && o.frequency.value <= 1.11 && o.started.length > 0,
    );
    expect(drifts).toHaveLength(2);
    for (const d of drifts) {
      const { depth, target } = driftWiring(record, d);
      expect(depth).toBe(3.2);
      expect(target).not.toBeNull();
      expect(target!.frequency.value).toBeCloseTo(261.6255653005986, 3); // C4 carrier
    }
    runtime.dispose();
  });
});

describe("strings — section drift wiring", () => {
  it("drifts all THREE section saws at 3 ct; spread moved off automation to the detune base", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.strings.factory(ctx, trackOf("strings", { ensemble: 1 }) as never, TEST_ENV);
    runtime.noteOn(60, 0.9, 0, 1);
    const saws = record.oscs.filter((o) => o.type === "sawtooth");
    expect(saws).toHaveLength(3);
    const drifts = driftLfos(record);
    expect(drifts).toHaveLength(3);
    // The static ensemble spread (0, +7, −12 ct) is now the detune BASE
    // (no setValueAtTime — the drift offset must survive on the same param).
    expect(vi.mocked(saws[0]!.detune.setValueAtTime).mock.calls).toHaveLength(0);
    const bases = saws.map((o) => o.detune.value).map((v) => Math.round(v / 1) * 1);
    expect(bases[0]).toBeGreaterThanOrEqual(-3.01);
    expect(bases[0]).toBeLessThanOrEqual(3.01);
    for (const d of drifts) {
      const { depth, target } = driftWiring(record, d);
      expect(depth).toBe(3);
      expect(saws).toContain(target);
    }
    runtime.dispose();
  });
});

describe("brass — section drift wiring", () => {
  it("drifts all THREE section saws at a tight 2.5 ct", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.brass.factory(ctx, trackOf("brass") as never, TEST_ENV);
    runtime.noteOn(60, 0.9, 0, 1);
    const saws = record.oscs.filter((o) => o.type === "sawtooth" && o.started.length > 0);
    expect(saws).toHaveLength(3);
    const drifts = driftLfos(record);
    expect(drifts).toHaveLength(3);
    for (const d of drifts) {
      const { depth, target } = driftWiring(record, d);
      expect(depth).toBe(2.5);
      expect(saws).toContain(target);
    }
    runtime.dispose();
  });
});

describe("reese — pair drift wiring", () => {
  it("drifts BOTH beating saws at 3 ct but never the sub anchor", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.reese.factory(ctx, trackOf("reese", { movement: 0 }) as never, TEST_ENV);
    runtime.noteOn(45, 0.9, 0, 1);
    const saws = record.oscs.filter((o) => o.type === "sawtooth" && o.started.length > 0);
    expect(saws).toHaveLength(2);
    const drifts = driftLfos(record);
    expect(drifts).toHaveLength(2);
    for (const d of drifts) {
      const { depth, target } = driftWiring(record, d);
      expect(depth).toBe(3);
      expect(saws).toContain(target);
    }
    runtime.dispose();
  });
});

describe("acid — 303 drift wiring", () => {
  it("drifts the single squelch osc at a subtle 1.8 ct", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.acid.factory(ctx, trackOf("acid") as never, TEST_ENV);
    runtime.noteOn(40, 0.9, 0, 0.5);
    const saws = record.oscs.filter((o) => o.type === "sawtooth" && o.started.length > 0);
    expect(saws).toHaveLength(1);
    const drifts = driftLfos(record);
    expect(drifts).toHaveLength(1);
    const { depth, target } = driftWiring(record, drifts[0]!);
    expect(depth).toBe(1.8);
    expect(target).toBe(saws[0]);
    runtime.dispose();
  });
});

describe("clav — per-osc drift wiring (clav v2)", () => {
  it("drifts BOTH voice oscs: square A @ 0.7 Hz/3.5 ct, saw B @ 0.55 Hz/4.5 ct", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.clav.factory(ctx, trackOf("clav") as never, TEST_ENV);
    runtime.noteOn(69, 0.9, 0, 0.5);
    // Square + saw voice oscs; the GROWL square (octave-down, default on)
    // also matches the type filter, so only bound the minimum here — the
    // drift wiring below pins the two voice oscs exactly.
    const voiceOscs = record.oscs.filter((o) => (o.type === "square" || o.type === "sawtooth") && o.started.length > 0);
    expect(voiceOscs.length).toBeGreaterThanOrEqual(2);
    const drifts = driftLfos(record);
    expect(drifts.map((d) => d.frequency.value).sort((a, b) => a - b)).toEqual([0.55, 0.7]);
    const wired = drifts.map((d) => driftWiring(record, d));
    expect(wired.map((w) => `${w.target!.type}@${w.depth}`).sort()).toEqual(["sawtooth@4.5", "square@3.5"]);
    runtime.dispose();
  });
});

describe("percussive voices stay drift-free", () => {
  it("no drift LFO feeds the bell FM pair detune", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.bell.factory(ctx, trackOf("bell") as never, TEST_ENV);
    runtime.noteOn(69, 0.9, 0, 0.5);
    for (const d of driftLfos(record)) {
      const { target } = driftWiring(record, d);
      expect(target).toBeNull();
    }
    runtime.dispose();
  });
});
