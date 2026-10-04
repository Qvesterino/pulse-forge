import { describe, expect, it, vi } from "vitest";
import {
  INSTRUMENT_DEFS,
  INSTRUMENT_ORDER,
  defaultInstrumentParams,
  clampInstrumentParam,
} from "../src/instruments/registry";
import { factoryPresets, warmFactoryPresets } from "../src/presets/factory-loader";
// The pack seam (2026-10-04): the full bank = core + real-instrument packs,
// assembled by the loader's warm — same presets as before the seam.
const FACTORY_PRESETS = await warmFactoryPresets().then(() => factoryPresets());
import { organDrawbarWeights } from "../src/instruments/registry";
import type { InstrumentTrack } from "../src/project-model/types";

/**
 * ORGAN (kind #16) — drawbar additive synthesis.
 *
 * Runtime tests use a mock BaseAudioContext (the bandlimited.test.ts
 * pattern): the organ's real DSP is Web Audio node wiring, so the contracts
 * that matter are STRUCTURAL — the drawbar mix rides ONE PeriodicWave per
 * voice (band-limited, not nine oscillators), the 16' sub is a half-freq
 * sine, the rotary LFOs are phase-locked to the note (determinism), and the
 * key click is a seeded noise burst. Plus pure param/preset math.
 */

const SR = 44100;
const ORGAN_ENV = { bpm: 120, getSample: () => undefined };

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

function mockCtx() {
  const record = {
    periodicWaves: [] as number[][],
    oscs: [] as Array<{
      type: string;
      started: number[];
      stopped: number[];
      detune: ReturnType<typeof mockParam>;
      frequency: ReturnType<typeof mockParam>;
      periodicWaveCalls: number;
      periodicWave?: number[];
      onended: (() => void) | null;
    }>,
    connections: [] as string[],
  };
  const ctx = {
    sampleRate: SR,
    currentTime: 0,
    destination: { toString: () => "destination" },
    createGain: () => ({
      gain: mockParam(),
      connect: (n: unknown) => {
        record.connections.push(`gain→${String(n)}`);
        return n;
      },
      disconnect: () => undefined,
    }),
    createStereoPanner: () => ({
      pan: mockParam(),
      connect: (n: unknown) => {
        record.connections.push(`pan→${String(n)}`);
        return n;
      },
      disconnect: () => undefined,
    }),
    createBiquadFilter: () => ({
      type: "",
      frequency: mockParam(),
      Q: mockParam(),
      gain: mockParam(),
      detune: mockParam(),
      connect: (n: unknown) => {
        record.connections.push(`biquad→${String(n)}`);
        return n;
      },
      disconnect: (n: unknown) => n,
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
      duration: length / SR,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      playbackRate: mockParam(1),
      onended: null,
      start: vi.fn(),
      stop: vi.fn(),
      connect: (n: unknown) => n,
      disconnect: (n: unknown) => n,
    }),
    createOscillator: () => {
      const osc = {
        type: "sine",
        started: [] as number[],
        stopped: [] as number[],
        detune: mockParam(),
        frequency: mockParam(),
        periodicWaveCalls: 0,
        periodicWave: undefined as number[] | undefined,
        onended: null as (() => void) | null,
        setPeriodicWave(w: number[]) {
          this.periodicWaveCalls += 1;
          this.periodicWave = w;
        },
        start(when: number) {
          this.started.push(when);
        },
        stop(when: number) {
          this.stopped.push(when);
        },
        connect: (n: unknown) => n,
        disconnect: (n: unknown) => n,
      };
      record.oscs.push(osc);
      return osc;
    },
    createPeriodicWave: (_real: Float32Array, imag: Float32Array) => {
      const wave = Array.from(imag);
      record.periodicWaves.push(wave);
      return wave;
    },
  };
  return { ctx, record };
}

function organTrack(overrides: Record<string, number> = {}): InstrumentTrack {
  const params = { ...defaultInstrumentParams("organ"), ...overrides };
  return {
    id: "t-organ",
    kind: "instrument",
    instrument: "organ",
    name: "Organ",
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

describe("organ — registry + params", () => {
  it("is registered in DEFS and ORDER with matching metadata", () => {
    expect(INSTRUMENT_DEFS.organ.kind).toBe("organ");
    expect(INSTRUMENT_ORDER).toContain("organ");
    expect(INSTRUMENT_DEFS.organ.params.length).toBe(12);
  });

  it("factory presets exist for every promised genre voice and stay within param bounds", () => {
    const organPresets = FACTORY_PRESETS.filter((p) => p.instrument === "organ");
    expect(organPresets.length).toBe(10);
    for (const preset of organPresets) {
      for (const [id, value] of Object.entries(preset.params)) {
        expect(clampInstrumentParam("organ", id, value as number)).toBe(value as number);
      }
    }
  });
});

describe("organ — drawbar math", () => {
  it("weights are L2-normalized, warm is fundamental-dominant, bright is brassy", () => {
    const warm = organDrawbarWeights(0);
    const bright = organDrawbarWeights(1);
    const energy = (w: Float32Array) => Array.from(w).reduce((s, v) => s + v * v, 0);
    expect(energy(warm)).toBeCloseTo(1, 5);
    expect(energy(bright)).toBeCloseTo(1, 5);
    // Warm: fundamental dominates (index 1 = harmonic 1).
    expect(warm[1]!).toBeGreaterThan(0.9);
    expect(warm[3]!).toBeLessThan(0.1);
    // Bright: harmonics 2-4 carry real weight.
    expect(bright[2]!).toBeGreaterThan(0.3);
    expect(bright[3]!).toBeGreaterThan(0.3);
    // Deterministic: same input, same table.
    expect(Array.from(organDrawbarWeights(0.5))).toEqual(Array.from(organDrawbarWeights(0.5)));
  });

  it("clamps garbage tilt instead of poisoning the table", () => {
    expect(Array.from(organDrawbarWeights(-5))).toEqual(Array.from(organDrawbarWeights(0)));
    // NaN degrades to the param default (0.5) — a poisoned table would
    // render NaN audio for the whole voice.
    expect(Array.from(organDrawbarWeights(Number.NaN))).toEqual(Array.from(organDrawbarWeights(0.5)));
    expect(Array.from(organDrawbarWeights(99))).toEqual(Array.from(organDrawbarWeights(1)));
  });
});

describe("organ — voice wiring (mock graph)", () => {
  it("one PeriodicWave voice + a half-frequency sub sine + clock; all started and stopped", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.organ.factory(
      ctx as never,
      organTrack({ rotary: 0.5, rotaryRate: 1.5, click: 0.5 }) as never,
      ORGAN_ENV,
    );
    runtime.noteOn(60, 0.9, 0, 0.5);

    const tabled = record.oscs.filter((o) => o.periodicWaveCalls > 0);
    expect(tabled).toHaveLength(1); // the drawbar carrier — NOT nine oscillators
    const sub = record.oscs.filter((o) => o.periodicWaveCalls === 0 && o.started.length > 0);
    // Sub sine + rotary tremolo LFO + pan LFO (+ clock) — all native sines.
    expect(sub.length).toBeGreaterThanOrEqual(3);

    // The carrier is band-limited drawbars; warm-ish default tilt.
    expect(tabled[0]!.periodicWave!.length).toBe(9);
    expect(tabled[0]!.periodicWave![1]!).toBeGreaterThan(0.5);

    // Every started oscillator also gets a stop scheduled.
    for (const osc of record.oscs) {
      if (osc.started.length > 0) expect(osc.stopped.length).toBeGreaterThan(0);
    }

    runtime.dispose();
  });

  it("the rotary LFOs are phase-locked to the note (start at `when` / +90°)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.organ.factory(
      ctx as never,
      organTrack({ rotary: 1, rotaryRate: 2 }) as never,
      ORGAN_ENV,
    );
    runtime.noteOn(69, 0.9, 1.25, 0.5);
    const starts = record.oscs.map((o) => o.started).filter((s) => s.length > 0);
    // Tremolo LFO and carrier start exactly at `when`.
    expect(starts.filter((s) => s[0] === 1.25).length).toBeGreaterThanOrEqual(2);
    // The pan LFO trails by a quarter turn: 1.25 + 0.25/2 = 1.375.
    expect(starts.some((s) => Math.abs(s[0]! - 1.375) < 1e-9)).toBe(true);
    runtime.dispose();
  });

  it("drawbar wave is cached per tilt step — repeated notes reuse one table", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.organ.factory(ctx as never, organTrack() as never, ORGAN_ENV);
    runtime.noteOn(60, 0.9, 0, 0.5);
    runtime.noteOn(64, 0.9, 0.6, 0.5);
    runtime.noteOn(67, 0.9, 1.2, 0.5);
    expect(record.periodicWaves).toHaveLength(1);
    runtime.dispose();
  });

  it("noteOff releases the held voice and panic silences everything", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.organ.factory(ctx as never, organTrack({ rotary: 0 }) as never, ORGAN_ENV);
    runtime.noteOn(60, 0.9, 0, 10);
    if (!runtime.noteOff) throw new Error("Organ runtime did not expose noteOff");
    runtime.noteOff(60, 0.5);
    const held = record.oscs.filter((o) => o.started.length > 0);
    // Every VOICE oscillator stops at the noteOff time — the only osc allowed
    // to outlive it is the gain-0 cleanup clock that fires onended.
    const outliving = held.filter((o) => !o.stopped.some((t) => t < 10));
    expect(outliving.length).toBeLessThanOrEqual(1);
    runtime.noteOn(62, 0.9, 0, 10);
    runtime.panic();
    expect(record.oscs.every((o) => o.stopped.length >= o.started.length)).toBe(true);
    runtime.dispose();
  });
});
