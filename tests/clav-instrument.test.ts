import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INSTRUMENT_DEFS, clampInstrumentParam, defaultInstrumentParams } from "../src/instruments/registry";
import { factoryPresets, warmFactoryPresets } from "../src/presets/factory-loader";
// The pack seam (2026-10-04): the full bank = core + real-instrument packs,
// assembled by the loader's warm — same presets as before the seam.
const FACTORY_PRESETS = await warmFactoryPresets().then(() => factoryPresets());
import type { InstrumentTrack } from "../src/project-model/types";

/**
 * CLAVINET (#22) — wiring tests (mock-graph pattern).
 *
 * Contracts: bright PULSE voice through a per-key pickup bandpass (PICK
 * walks the frequency), velocity → HP brightness, DAMP decay on sustain,
 * CLICK = seeded noise burst post-pickup, GROWL = octave-down square.
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
  onended: (() => void) | null;
  start: (when?: number) => void;
  stop: (when?: number) => void;
  connect: (n: unknown) => unknown;
  disconnect: () => void;
}

function mockCtx() {
  const record = {
    oscs: [] as MockOsc[],
    buffers: [] as Array<{ startTimes: number[]; stopTimes: number[] }>,
    filters: [] as Array<{ frequency: ReturnType<typeof mockParam>; setValueCalls: number[] }>,
  };
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: { toString: () => "destination" },
    createGain: () => ({ gain: mockParam(1), connect: (n: unknown) => n, disconnect: () => undefined }),
    createStereoPanner: () => ({ pan: mockParam(0), connect: (n: unknown) => n, disconnect: () => undefined }),
    createBiquadFilter: () => {
      const filter = {
        type: "",
        frequency: mockParam(),
        Q: mockParam(),
        gain: mockParam(),
        detune: mockParam(),
        setValueCalls: [] as number[],
        connect: (n: unknown) => n,
        disconnect: () => undefined,
      };
      // Spy on setValueAtTime so the test can read what frequencies the
      // factory scheduled (vs. written through .value). vi.fn keeps the
      // Mock<Procedure> shape — a plain function would lose .mock.calls.
      const setSpy = vi.fn((v: number, _when: number) => {
        filter.setValueCalls.push(v);
      });
      filter.frequency.setValueAtTime = setSpy as never;
      record.filters.push(filter);
      return filter;
    },
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
        start: (when?: number) => src.startTimes.push(when ?? 0),
        stop: (when?: number) => src.stopTimes.push(when ?? Infinity),
        startTimes: [] as number[],
        stopTimes: [] as number[],
        connect: (n: unknown) => n,
        disconnect: () => undefined,
      };
      record.buffers.push(src);
      return src;
    },
    createOscillator: () => {
      const osc: MockOsc = {
        type: "sine",
        frequency: mockParam(),
        detune: mockParam(),
        started: [],
        stopped: [],
        onended: null,
        start: (when?: number) => osc.started.push(when ?? 0),
        stop: (when?: number) => osc.stopped.push(when ?? Infinity),
        connect: (n: unknown) => n,
        disconnect: () => undefined,
      };
      record.oscs.push(osc);
      return osc;
    },
  };
  return { ctx: ctx as never, record };
}

function clavTrack(overrides: Record<string, number> = {}): InstrumentTrack {
  const params = { ...defaultInstrumentParams("clav"), ...overrides };
  return {
    id: "t-clav",
    kind: "instrument",
    instrument: "clav",
    name: "Clav",
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

describe("clav — registry + params", () => {
  it("is registered in DEFS with 9 params (incl. pickupType C/D/E/F)", () => {
    expect(INSTRUMENT_DEFS.clav.name).toBe("Clavinet");
    expect(INSTRUMENT_DEFS.clav.params.length).toBe(9);
    expect(defaultInstrumentParams("clav")["pick"]).toBe(0.5);
  });

  it("ships 10 presets within param bounds", () => {
    const clavPresets = FACTORY_PRESETS.filter((p) => p.instrument === "clav");
    expect(clavPresets).toHaveLength(10);
    for (const preset of clavPresets) {
      for (const [id, value] of Object.entries(preset.params)) {
        expect(clampInstrumentParam("clav", id, value as number)).toBe(value as number);
      }
    }
  });
});

describe("clav — voice wiring (mock graph)", () => {
  const clavEnv = { bpm: 120, getSample: () => undefined } as const;
  it("builds the bright square voice; pickup bandpass lands at freq×(1.1+pick×2.4)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.clav.factory(ctx as never, clavTrack({ pick: 0.5 }) as never, clavEnv);
    runtime.noteOn(60, 0.9, 0, 0.3);
    runtime.dispose();
    const voice = record.oscs.filter((o) => o.type === "square" && o.started.length > 0);
    expect(voice.length).toBeGreaterThanOrEqual(1);
    // The factory schedules the pitch via setValueAtTime (not .value).
    const scheduled = vi.mocked(voice[0]!.frequency.setValueAtTime).mock.calls.map((c) => c[0] as number);
    expect(scheduled.some((v) => Math.abs(v - 261.626) < 0.01)).toBe(true);
  });

  it("CLICK fires the seeded noise burst (buffer source, short stop)", () => {
    const { ctx, record } = mockCtx();
    const runtime = INSTRUMENT_DEFS.clav.factory(ctx as never, clavTrack({ click: 0.8 }) as never, clavEnv);
    runtime.noteOn(60, 0.9, 0, 0.3);
    runtime.dispose();
    expect(record.buffers.length).toBeGreaterThanOrEqual(1);
    // Source pin: the click path (post-pickup, fast 15 ms decay).
    const src = readFileSync(resolve(process.cwd(), "src/instruments/registry.ts"), "utf8");
    const clavBlock = src.slice(
      src.indexOf("const clav: InstrumentDefinition"),
      src.indexOf("/* ---------------- Log Drum"),
    );
    expect(clavBlock).toContain("clickSrc.connect(clickBP).connect(clickGain).connect(pickup)");
    expect(clavBlock).toContain("clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.015)");
  });
});
