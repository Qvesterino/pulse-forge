import { describe, expect, it } from "vitest";
import {
  BANDLIMITED_RMS,
  bandlimitedCoefficients,
  freqToMidi,
  periodicWaveFor,
  shapeOscillator,
} from "../src/instruments/bandlimited";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";

/**
 * Band-limited oscillator tables.
 *
 * Native saw/square/triangle alias: every harmonic above Nyquist folds back
 * as inharmonic whine on bright high leads. These tables carry exactly the
 * sub-Nyquist harmonics for the scheduled pitch, so voices built with
 * setPeriodicWave cannot alias by construction. FM paths keep native
 * oscillators (audio-rate frequency modulation needs them) — documented in
 * bandlimited.ts, not an oversight.
 *
 *  - Pure math: harmonic count, RMS normalization, odd-only spectra.
 *  - A/B proof: IDFT-reconstructed naive saw vs bandlimited saw at 2100 Hz —
 *    folded 12th/13th harmonics (22.8/20.7 kHz, non-harmonic bins) must drop
 *    ≥40 dB while the fundamental holds ±0.5 dB.
 *  - Wiring (mock context): analog + bass voices route saw/square/triangle
 *    through setPeriodicWave and leave sine native; the per-note table cache
 *    serves identical pitches with one build.
 */

const SR = 48000;

/** IDFT reconstruction of a coefficient set at f0 (sine terms only). */
function reconstruct(imag: Float32Array, f0: number, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const partials: { k: number; a: number }[] = [];
  for (let k = 1; k < imag.length; k++) if (imag[k] !== 0) partials.push({ k, a: imag[k] });
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const { k, a } of partials) v += a * Math.sin((2 * Math.PI * k * f0 * i) / SR);
    out[i] = v;
  }
  return out;
}

/** Naive (infinite-series, truncated at 200 partials) saw — the aliasing reference. */
function naiveSaw(f0: number, seconds: number, partials = 200): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= partials; k++) {
      v += ((k % 2 === 1 ? 2 : -2) / (Math.PI * k)) * Math.sin((2 * Math.PI * k * f0 * i) / SR);
    }
    out[i] = v;
  }
  return out;
}

/** Goertzel magnitude over the settled region (1 s window → ±1 Hz selectivity). */
function goertzel(buf: Float32Array, freq: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / buf.length;
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-15, x));

describe("bandlimitedCoefficients", () => {
  it("carries exactly the sub-Nyquist harmonics", () => {
    expect(bandlimitedCoefficients("sawtooth", 440, SR).harmonicCount).toBe(Math.floor(SR / 2 / 440));
    expect(bandlimitedCoefficients("square", 20000, SR).harmonicCount).toBe(1);
    expect(bandlimitedCoefficients("sawtooth", 1, SR).harmonicCount).toBeGreaterThan(100);
  });

  it("RMS-matches the naive loudness (preset levels keep meaning)", () => {
    for (const wave of ["sawtooth", "square", "triangle"] as const) {
      const { imag } = bandlimitedCoefficients(wave, 440, SR);
      let energy = 0;
      for (let k = 1; k < imag.length; k++) energy += (imag[k] * imag[k]) / 2;
      expect(Math.sqrt(energy)).toBeCloseTo(BANDLIMITED_RMS[wave], 6);
    }
  });

  it("square/triangle carry odd harmonics only, triangle falls as 1/n²", () => {
    const sq = bandlimitedCoefficients("square", 440, SR);
    for (let k = 2; k <= sq.harmonicCount; k += 2) expect(sq.imag[k]).toBe(0);
    expect(sq.imag[1]).toBeGreaterThan(0);
    const tri = bandlimitedCoefficients("triangle", 440, SR);
    expect(Math.abs(tri.imag[1] / tri.imag[3])).toBeCloseTo(9, 5);
    expect(tri.imag[2]).toBe(0);
  });

  it("freqToMidi clamps", () => {
    expect(freqToMidi(440)).toBe(69);
    expect(freqToMidi(-3)).toBe(69);
    expect(freqToMidi(100000)).toBe(127);
  });
});

describe("aliasing A/B proof", () => {
  // 2100 Hz @48 kHz: the naive 12th (25.2 kHz) folds to 22.8 kHz and the
  // 13th (27.3 kHz) to 20.7 kHz — both non-harmonic bins (×10.857/×9.857),
  // so whatever lands there is pure fold, not a true partial.
  const F0 = 2100;
  const FOLD_A = 22800;
  const FOLD_B = 20700;

  it("folded harmonics drop ≥40 dB, fundamental holds ±0.5 dB", () => {
    const naive = naiveSaw(F0, 1);
    const { imag } = bandlimitedCoefficients("sawtooth", F0, SR);
    const clean = reconstruct(imag, F0, 1);

    expect(Math.abs(db(goertzel(clean, F0)) - db(goertzel(naive, F0)))).toBeLessThan(0.5);

    for (const fold of [FOLD_A, FOLD_B]) {
      const naiveFold = goertzel(naive, fold);
      const cleanFold = goertzel(clean, fold);
      // Validity gate: the naive loop must actually produce the fold.
      expect(db(naiveFold) - db(goertzel(naive, F0))).toBeGreaterThan(-50);
      expect(db(naiveFold) - db(cleanFold)).toBeGreaterThan(40);
    }
  });
});

/* ── Voice wiring with a mocked audio context ── */

interface MockOsc {
  type: string;
  frequency: { value: number; setValueAtTime(v: number): void; exponentialRampToValueAtTime(v: number): void };
  detune: { value: number };
  /** setPeriodicWave call count — the mock table itself carries no audio. */
  periodicWaveCalls: number;
  started: boolean;
  setPeriodicWave(wave: unknown): void;
  connect(): MockOsc;
  disconnect(): void;
  start(): void;
  stop(): void;
}

function mockParam(initial = 0) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
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
    setTargetAtTime(v: number) {
      value = v;
    },
    cancelScheduledValues() {},
  };
}

function mockNodeExtra() {
  const chainable = {
    connect() {
      return chainable;
    },
    disconnect() {},
  };
  return {
    gain: mockParam(1),
    frequency: mockParam(440),
    Q: mockParam(1),
    pan: mockParam(0),
    threshold: mockParam(0),
    ratio: param1(),
    attack: mockParam(0),
    release: mockParam(0),
    knee: mockParam(0),
    delayTime: mockParam(0),
    ...chainable,
  };
  function param1() {
    return mockParam(1);
  }
}

function mockCtx(record: { periodicWaveBuilds: number; oscs: MockOsc[] }) {
  const mkOsc = (): MockOsc => {
    const osc: MockOsc = {
      type: "sine",
      frequency: {
        value: 440,
        setValueAtTime(v: number) {
          osc.frequency.value = v;
        },
        exponentialRampToValueAtTime(v: number) {
          osc.frequency.value = v;
        },
      },
      detune: { value: 0 },
      periodicWaveCalls: 0,
      started: false,
      setPeriodicWave() {
        osc.periodicWaveCalls++;
      },
      connect() {
        return osc;
      },
      disconnect() {},
      start() {
        osc.started = true;
      },
      stop() {},
    };
    record.oscs.push(osc);
    return osc;
  };
  return {
    currentTime: 0,
    sampleRate: SR,
    createGain: () => mockNodeExtra(),
    createOscillator: mkOsc,
    createBiquadFilter: () => ({ ...mockNodeExtra(), type: "lowpass" }),
    createStereoPanner: () => mockNodeExtra(),
    createWaveShaper: () => ({ ...mockNodeExtra(), oversample: "2x", curve: null }),
    createDelay: () => mockNodeExtra(),
    createBufferSource: () => ({ ...mockNodeExtra(), buffer: null, loop: false, start() {}, stop() {} }),
    createBuffer: (_ch: number, len: number) => ({
      sampleRate: SR,
      getChannelData: () => new Float32Array(Math.max(1, len)),
    }),
    createPeriodicWave: () => {
      record.periodicWaveBuilds++;
      return { __stubPeriodicWave: true };
    },
  };
}

const VOICE_ENV = { bpm: 124, getSample: () => undefined };

function analogTrack(overrides: Record<string, number> = {}) {
  const params = { ...defaultInstrumentParams("analog"), ...overrides };
  return { id: "t-analog", params };
}

function bassTrack(overrides: Record<string, number> = {}) {
  const params = { ...defaultInstrumentParams("bass"), ...overrides };
  return { id: "t-bass", params };
}

describe("voice wiring", () => {
  it("analog saw voices route through setPeriodicWave (sine stays native)", () => {
    const record = { periodicWaveBuilds: 0, oscs: [] as MockOsc[] };
    const ctx = mockCtx(record);
    const runtime = INSTRUMENT_DEFS.analog.factory(
      ctx as unknown as BaseAudioContext,
      analogTrack() as never,
      VOICE_ENV,
    );
    runtime.noteOn(69, 0.9, 0, 0.5);
    // oscA + oscB are saws at ~440 Hz (+8 ct detune), sub is sine.
    const tabled = record.oscs.filter((o) => o.periodicWaveCalls > 0);
    expect(tabled.length).toBeGreaterThanOrEqual(2);
    expect(record.periodicWaveBuilds).toBe(1); // one cached table for 440 Hz
    expect(tabled.every((o) => o.type === "sine")).toBe(true); // .type untouched
    const sines = record.oscs.filter((o) => o.periodicWaveCalls === 0 && o.started);
    // Sub sine (filter LFO is off by default) keeps the native path.
    expect(sines.length).toBeGreaterThanOrEqual(1);
  });

  it("analog sine voices never touch setPeriodicWave", () => {
    const record = { periodicWaveBuilds: 0, oscs: [] as MockOsc[] };
    const ctx = mockCtx(record);
    const runtime = INSTRUMENT_DEFS.analog.factory(
      ctx as unknown as BaseAudioContext,
      analogTrack({ oscA: 0, oscB: 0 }) as never,
      VOICE_ENV,
    );
    runtime.noteOn(69, 0.9, 0, 0.5);
    expect(record.periodicWaveBuilds).toBe(0);
    expect(record.oscs.filter((o) => o.started).every((o) => o.type === "sine")).toBe(true);
  });

  it("bass saw/square body goes band-limited, sub stays sine", () => {
    const record = { periodicWaveBuilds: 0, oscs: [] as MockOsc[] };
    const ctx = mockCtx(record);
    const runtime = INSTRUMENT_DEFS.bass.factory(ctx as unknown as BaseAudioContext, bassTrack() as never, VOICE_ENV);
    runtime.noteOn(45, 0.9, 0, 0.5);
    const tabled = record.oscs.filter((o) => o.periodicWaveCalls > 0);
    // Saw + square body (unison 1 default) take the table path…
    expect(tabled.length).toBe(2);
    // …while the sine sub stays native.
    const sub = record.oscs.find((o) => o.periodicWaveCalls === 0 && o.started);
    expect(sub?.type).toBe("sine");
  });

  it("shapeOscillator passes sine through and tables the rest", () => {
    const record = { periodicWaveBuilds: 0, oscs: [] as MockOsc[] };
    const ctx = mockCtx(record) as unknown as BaseAudioContext;
    const osc = (mockCtx(record) as unknown as { createOscillator: () => MockOsc }).createOscillator();
    shapeOscillator(ctx, osc as unknown as OscillatorNode, "sine", 440);
    expect(record.periodicWaveBuilds).toBe(0);
    expect(osc.type).toBe("sine");
    shapeOscillator(ctx, osc as unknown as OscillatorNode, "square", 440);
    expect(record.periodicWaveBuilds).toBe(1);
    // Same pitch + wave hits the cache — no rebuild.
    shapeOscillator(ctx, osc as unknown as OscillatorNode, "square", 440);
    expect(record.periodicWaveBuilds).toBe(1);
    expect(periodicWaveFor(ctx, "square", 440)).toBe(periodicWaveFor(ctx, "square", 440));
  });
});
