import { describe, expect, it, vi } from "vitest";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { midiToFreq, type InstrumentTrack } from "../src/project-model/types";

/**
 * 808 MASSIVE engine — punch/knock/grit/dist wiring tests (mock-graph).
 *
 * The modern 808 is not a fading sine: PUNCH throws the pitch envelope N
 * semitones above the target and snaps it down in P-TIME (kick-style
 * knock), KNOCK layers a short beater thump, GRIT feeds a square into the
 * shaper so DRIVE/DIST generate the 200–400 Hz harmonics that keep the
 * 808 audible on phone speakers, and the DIST ladder gains TAPE + FOLD
 * circuits. Contracts:
 *  - punch multiplies the legacy P-DROP start frequency and sets the ramp
 *    length from P-TIME (default 60 ms preserves the old behaviour),
 *  - grit is a SQUARE at the fundamental wired INTO the per-voice tone
 *    filter (pre-shaper), glides with slides, and is cut on voice stop,
 *  - knock is a 2.5× sine burst that never fires on slides,
 *  - the five DIST circuits produce five distinct bounded curves,
 *  - with everything at defaults the voice is exactly the legacy one:
 *    main sine + sub sine, no grit, no knock, 60 ms drop.
 */

let nextId = 1;

interface MockParam {
  __id: number;
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

interface MockNode {
  __id: number;
  connect: (target: unknown) => unknown;
  disconnect: () => void;
}

interface MockOsc extends MockNode {
  type: string;
  frequency: MockParam;
  detune: MockParam;
  started: number[];
  stopped: number[];
  start: (when?: number) => void;
  stop: (when?: number) => void;
  onended: (() => void) | null;
}

function mockParam(initial = 0): MockParam {
  return {
    __id: nextId++,
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function mockCtx() {
  const record = {
    oscs: [] as MockOsc[],
    gains: [] as Array<MockNode & { gain: MockParam }>,
    filters: [] as Array<MockNode & { type: string }>,
    shapers: [] as Array<{
      __id: number;
      curve: Float32Array | null;
      oversample: string;
      connect: (t: unknown) => unknown;
    }>,
    edges: [] as Array<[number, number]>,
  };
  const link = (fromId: number) => (target: unknown) => {
    if (target && typeof target === "object" && "__id" in (target as MockNode)) {
      record.edges.push([fromId, (target as MockNode).__id]);
    }
    return target;
  };
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: { __id: 0 },
    createGain: () => {
      const id = nextId++;
      const node = { __id: id, gain: mockParam(1), connect: link(id), disconnect: () => undefined };
      record.gains.push(node);
      return node;
    },
    createStereoPanner: () => {
      const id = nextId++;
      return { __id: id, pan: mockParam(0), connect: link(id), disconnect: () => undefined };
    },
    createBiquadFilter: () => {
      const id = nextId++;
      const node = {
        __id: id,
        type: "",
        frequency: mockParam(),
        Q: mockParam(),
        gain: mockParam(),
        detune: mockParam(),
        connect: link(id),
        disconnect: () => undefined,
      };
      record.filters.push(node);
      return node;
    },
    createWaveShaper: () => {
      const id = nextId++;
      const node = {
        __id: id,
        curve: null as Float32Array | null,
        oversample: "none",
        connect: link(id),
        disconnect: () => undefined,
      };
      record.shapers.push(node);
      return node;
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
        playbackRate: mockParam(1),
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
        frequency: mockParam(),
        detune: mockParam(),
        started: [],
        stopped: [],
        start: vi.fn((when?: number) => osc.started.push(when ?? 0)),
        stop: vi.fn((when?: number) => osc.stopped.push(when ?? Infinity)),
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

function track808(overrides: Record<string, number> = {}): InstrumentTrack {
  const params = { ...defaultInstrumentParams("808"), ...overrides };
  return {
    id: "t-808",
    kind: "instrument",
    instrument: "808",
    name: "808",
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

const TEST_ENV = { bpm: 140, getSample: (_id: string | null) => undefined };

const A1 = midiToFreq(33); // ~55 Hz — classic 808 territory

describe("808 PUNCH — kick-style pitch envelope", () => {
  it("throws the start pitch +PUNCH semitones up and snaps down in P-TIME", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(
      ctx,
      track808({ pitchDrop: 0, punch: 12, punchTime: 0.02 }) as never,
      TEST_ENV,
    );
    runtime.noteOn(33, 0.9, 0.1, 0.5);
    const main = record.oscs[0]!;
    const start = vi.mocked(main.frequency.setValueAtTime).mock.calls[0]![0] as number;
    expect(start).toBeCloseTo(A1 * 2, 2); // +12 st = octave up
    expect(main.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(A1, 0.1 + 0.02);
    runtime.dispose();
  });

  it("stacks PUNCH on top of the legacy P-DROP whip", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ pitchDrop: 0.5, punch: 7 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0, 0.5);
    const main = record.oscs[0]!;
    const start = vi.mocked(main.frequency.setValueAtTime).mock.calls[0]![0] as number;
    expect(start).toBeCloseTo(A1 * 1.65 * Math.pow(2, 7 / 12), 2);
    runtime.dispose();
  });

  it("defaults keep the legacy 60 ms drop with no punch", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808() as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0, 0.5);
    const main = record.oscs[0]!;
    const start = vi.mocked(main.frequency.setValueAtTime).mock.calls[0]![0] as number;
    expect(start).toBeCloseTo(A1 * (1 + 0.4 * 1.3), 2); // P-DROP 0.4 default
    expect(main.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(A1, 0.06);
    runtime.dispose();
  });
});

describe("808 GRIT — square harmonic anchor", () => {
  it("adds a square at the fundamental wired INTO the tone filter (pre-shaper)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, grit: 0.5 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.8, 0, 0.5);
    const squares = record.oscs.filter((o) => o.type === "square" && o.started.length > 0);
    expect(squares).toHaveLength(1);
    const grit = squares[0]!;
    expect(grit.frequency.value).toBe(A1);
    // Grit gain → tone filter: the first biquad is the per-voice TONE stage.
    const toneFilter = record.filters[0]!;
    const gritGain = record.gains.find((g) => record.edges.some(([from, to]) => from === grit.__id && to === g.__id));
    expect(gritGain).toBeDefined();
    expect(record.edges.some(([from, to]) => from === gritGain!.__id && to === toneFilter.__id)).toBe(true);
    // Level: grit × 0.4 × velocity (delivered via setValueAtTime).
    const gritLevelCall = vi.mocked(gritGain!.gain.setValueAtTime).mock.calls[0]![0] as number;
    expect(gritLevelCall).toBeCloseTo(0.5 * 0.4 * 0.8, 5);
    runtime.dispose();
  });

  it("glides with slides so the grind stays attached", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, grit: 0.5, glide: 1 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0.2, 0.5, { pitch: 45, when: 0 });
    const grit = record.oscs.find((o) => o.type === "square")!;
    expect(vi.mocked(grit.frequency.setValueAtTime).mock.calls[0]![0]).toBeCloseTo(midiToFreq(45), 2);
    expect(grit.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(A1, 0 + 0.35); // glide 1 → 0.35 s
    runtime.dispose();
  });

  it("is cut when the voice is stopped (mono trap cut)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, grit: 0.5 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0, 0.5);
    runtime.noteOn(40, 0.9, 0.1, 0.5);
    const grit = record.oscs.find((o) => o.type === "square")!;
    // stopped[] holds the scheduled stopTime first, then the mono cut —
    // the cut must land no later than the second attack (+release tail).
    expect(grit.stopped.some((s) => s <= 0.1 + 0.06)).toBe(true);
    runtime.dispose();
  });
});

describe("808 KNOCK — beater thump", () => {
  it("adds a short 2.5× sine burst through the tone stage", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, knock: 0.6 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.8, 0, 0.5);
    const knocks = record.oscs.filter(
      (o) => o.type === "sine" && Math.abs(o.frequency.value - A1 * 2.5) < 0.01 && o.started.length > 0,
    );
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.stopped[0]).toBeLessThanOrEqual(0.12);
    runtime.dispose();
  });

  it("never fires on slides (slides are continuous)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, knock: 0.6 }) as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0.2, 0.5, { pitch: 45, when: 0 });
    expect(record.oscs.filter((o) => Math.abs(o.frequency.value - A1 * 2.5) < 0.01)).toHaveLength(0);
    runtime.dispose();
  });
});

describe("808 DIST ladder — five circuits", () => {
  it("produces five distinct bounded curves (Soft/Tube/Hard/Tape/Fold)", () => {
    const curves: Float32Array[] = [];
    for (const distType of [0, 1, 2, 3, 4]) {
      const { ctx, record } = mockCtx();
      const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, distType }) as never, TEST_ENV);
      runtime.noteOn(33, 0.9, 0, 0.5);
      const curve = record.shapers[0]!.curve!;
      expect(curve).toHaveLength(1024);
      for (const v of curve) expect(Number.isFinite(v)).toBe(true);
      curves.push(curve);
      runtime.dispose();
    }
    // All five circuits are distinct waveshapes.
    for (let i = 0; i < curves.length; i++) {
      for (let j = i + 1; j < curves.length; j++) {
        const differ = curves[i]!.some((v, k) => Math.abs(v - curves[j]![k]!) > 1e-4);
        expect(differ).toBe(true);
      }
    }
  });

  it("TAPE stays gentle at low drive, FOLD escalates folds with drive", () => {
    const make = (distType: number, drive: number) => {
      const { ctx, record } = mockCtx();
      const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808({ sub: 0, distType, drive }) as never, TEST_ENV);
      runtime.noteOn(33, 0.9, 0, 0.5);
      const curve = record.shapers[0]!.curve!;
      runtime.dispose();
      return curve;
    };
    const tapeHot = make(3, 1);
    const hardHot = make(2, 1);
    // Circuit distinction: TAPE saturates smoothly — no flat clipping
    // plateau even fully hot; HARD CLIP slams into one.
    const plateau = (c: Float32Array) => {
      let best = 0;
      let run = 0;
      for (let i = 0; i < c.length; i++) {
        run = Math.abs(c[i]!) >= 0.999 ? run + 1 : 0;
        best = Math.max(best, run);
      }
      return best;
    };
    expect(plateau(tapeHot)).toBeLessThan(5);
    expect(plateau(hardHot)).toBeGreaterThan(10);
    expect(Math.max(...Array.from(tapeHot))).toBeLessThanOrEqual(1.05);
    const foldLow = make(4, 0.1);
    const foldHigh = make(4, 1);
    // Fold count escalates: the hot curve crosses zero far more often.
    const zeroCrossings = (c: Float32Array) => {
      let n = 0;
      for (let i = 1; i < c.length; i++) if (c[i - 1]! <= 0 !== c[i]! <= 0) n++;
      return n;
    };
    expect(zeroCrossings(foldHigh)).toBeGreaterThan(zeroCrossings(foldLow));
  });
});

describe("808 defaults — legacy voice untouched", () => {
  it("with GRIT/KNOCK/PUNCH at defaults the voice is main sine + sub sine only", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS["808"].factory(ctx, track808() as never, TEST_ENV);
    runtime.noteOn(33, 0.9, 0, 0.5);
    const voiced = record.oscs.filter((o) => o.started.length > 0);
    expect(voiced).toHaveLength(2);
    expect(voiced.every((o) => o.type === "sine")).toBe(true);
    const sub = voiced[1]!;
    expect(sub.frequency.value).toBeCloseTo(A1 / 2, 4);
    runtime.dispose();
  });
});
