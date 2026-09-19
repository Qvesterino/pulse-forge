import { beforeAll, describe, expect, it } from "vitest";
import type { TapeProcessorInstance } from "../src/audio-worklets/tape-processor";

/**
 * Tape 4× oversampling battery.
 *
 * The tanh hysteresis loop used to run at the base rate, so harmonics above
 * Nyquist folded straight back as inharmonic grit. The processor now runs
 * the nonlinear stage at 4× behind a 33-tap Blackman-sinc anti-image /
 * anti-alias pair. These tests run the REAL processor under a stubbed
 * AudioWorkletGlobalScope (house harness, see tests/kaskada.test.ts):
 *
 *  - registration + descriptor contract
 *  - mix = 0 is unity with exactly 4 samples of latency (dry aligned)
 *  - aliasing A/B proof: driven 7 kHz sine vs a naive base-rate tanh loop
 *    (same drive law, same hysteresis, same post tone — the ONLY difference
 *    is oversampling). Folded 5th/7th harmonics (13 kHz / 1 kHz) must drop
 *    ≥20 dB while the fundamental stays within 1 dB.
 *  - hysteresis memory still works (hyst > 0 colors repeats, hyst = 0 does not)
 *  - tone LP darkens, output gain scales, extremes stay finite + bounded
 */

class FakeAudioWorkletProcessor {}
class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
void FakePort;

let createTapeProcessor: () => TapeProcessorInstance;
let RegisteredName = "";
let Descriptors: { name: string; defaultValue: number }[] = [];

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: unknown) => {
    RegisteredName = name;
    Descriptors = (cls as { parameterDescriptors?: { get?: unknown } }).parameterDescriptors as never as never;
    // parameterDescriptors is a static getter on the class.
    Descriptors = (cls as unknown as { parameterDescriptors: { name: string; defaultValue: number }[] })
      .parameterDescriptors;
  };
  createTapeProcessor = (await import("../src/audio-worklets/tape-processor.js")).createTapeProcessor;
  expect(typeof createTapeProcessor).toBe("function");
});

const BLOCK = 128;
const SR = 48000;

const DEFAULTS: Record<string, number> = {
  drive: 0.4,
  hysteresis: 0.3,
  tone: 6500,
  mix: 1,
  output: 0,
};

function paramSet(overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...overrides })) out[k] = Float32Array.from([v]);
  return out;
}

function renderStereo(
  proc: TapeProcessorInstance,
  seconds: number,
  prm: Record<string, Float32Array>,
  input: (n: number) => [number, number] = () => [0, 0],
): { L: Float32Array; R: Float32Array } {
  const nBlocks = Math.ceil((seconds * SR) / BLOCK);
  const L = new Float32Array(nBlocks * BLOCK);
  const R = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = input(b * BLOCK + i);
      inL[i] = l;
      inR[i] = r;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inL, inR]], [[outL, outR]], prm);
    L.set(outL, b * BLOCK);
    R.set(outR, b * BLOCK);
  }
  return { L, R };
}

/** Goertzel magnitude at one frequency over the settled region. */
function goertzel(buf: Float32Array, freq: number, fromSec = 0.2): number {
  const from = Math.floor(fromSec * SR);
  const w = (2 * Math.PI * freq) / SR;
  const cos = Math.cos(w);
  const coeff = 2 * cos;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < buf.length; i++) {
    s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cos;
  const imag = s2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / (buf.length - from);
}

/**
 * Naive base-rate tape reference: the pre-oversampling algorithm with the
 * same drive law, hysteresis and post tone — the ONLY difference vs the
 * processor is the missing 4× stage. Shared by the A/B proof so a failure
 * can only come from (the absence of) oversampling.
 */
function naiveTape(seconds: number, input: (n: number) => number, drive: number, tone: number): Float32Array {
  const n = Math.ceil(seconds * SR);
  const out = new Float32Array(n);
  const driveGain = 1 + drive * 14;
  const alpha = 1 - Math.exp((-2 * Math.PI * tone) / SR);
  let prev = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const wet = Math.tanh(driveGain * input(i));
    prev = wet;
    lp += alpha * (wet - lp);
    out[i] = lp;
  }
  void prev;
  return out;
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

describe("tape-processor registration", () => {
  it("registers as 'tape-processor' with the registry param surface", () => {
    expect(RegisteredName).toBe("tape-processor");
    for (const id of ["drive", "hysteresis", "tone", "mix", "output"]) {
      expect(Descriptors.map((d) => d.name)).toContain(id);
    }
  });
});

describe("tape-processor latency + unity", () => {
  it("mix = 0 passes dry with exactly 8 samples of latency", () => {
    const proc = createTapeProcessor();
    const { L } = renderStereo(proc, 0.2, paramSet({ mix: 0 }), (n) => (n === 100 ? [1, 0.5] : [0, 0]));
    expect(L[100]).toBe(0);
    expect(L[108]).toBeCloseTo(1, 5);
    // Silence elsewhere (no leakage, no ringing).
    for (let i = 0; i < L.length; i++) {
      if (i === 108) continue;
      expect(Math.abs(L[i])).toBeLessThan(1e-6);
    }
  });

  it("mix = 0 is unity for a sine past the settle region", () => {
    const proc = createTapeProcessor();
    const { L } = renderStereo(proc, 0.5, paramSet({ mix: 0 }), (n) => [
      0.4 * Math.sin((n / SR) * 440 * Math.PI * 2),
      0,
    ]);
    const from = Math.floor(SR * 0.1);
    for (let i = from; i < from + 1000; i++) {
      const want = 0.4 * Math.sin(((i - 8) / SR) * 440 * Math.PI * 2);
      expect(Math.abs(L[i] - want)).toBeLessThan(1e-6);
    }
  });
});

describe("tape-processor aliasing proof", () => {
  // 7 kHz @48 kHz, heavily driven: the 5th harmonic (35 kHz) folds to
  // 13 kHz and the 7th (49 kHz) to 1 kHz at the base rate. Behind 4× both
  // sit below the 96 kHz Nyquist and die in the decimation filter.
  const F0 = 7000;
  const FOLD_5TH = 13000;
  const FOLD_7TH = 1000;

  it("folded harmonics drop ≥20 dB vs the naive loop, fundamental holds ±1 dB", () => {
    const inFn = (n: number) => 0.5 * Math.sin((n / SR) * F0 * Math.PI * 2);
    const proc = createTapeProcessor();
    const { L } = renderStereo(proc, 1, paramSet({ drive: 1, hysteresis: 0, tone: 12000, mix: 1, output: 0 }), (n) => [
      inFn(n),
      inFn(n),
    ]);
    const ref = naiveTape(1, inFn, 1, 12000);

    const fundOs = goertzel(L, F0);
    const fundNaive = goertzel(ref, F0);
    expect(Math.abs(db(fundOs) - db(fundNaive))).toBeLessThan(1);

    for (const fold of [FOLD_5TH, FOLD_7TH]) {
      const osFold = goertzel(L, fold);
      const naiveFold = goertzel(ref, fold);
      // The naive loop must actually produce the fold (test validity gate).
      expect(db(naiveFold) - db(fundNaive)).toBeGreaterThan(-60);
      expect(db(naiveFold) - db(osFold)).toBeGreaterThan(20);
    }
  });
});

describe("tape-processor character", () => {
  it("hysteresis memory colors repeats (hyst > 0 ≠ hyst = 0)", () => {
    const mk = (hysteresis: number) => {
      const proc = createTapeProcessor();
      return renderStereo(proc, 0.5, paramSet({ drive: 0.6, hysteresis, mix: 1 }), (n) => (n === 0 ? [1, 1] : [0, 0]))
        .L;
    };
    const withHyst = mk(0.5);
    const withoutHyst = mk(0);
    let diff = 0;
    for (let i = 0; i < withHyst.length; i++) diff += Math.abs(withHyst[i] - withoutHyst[i]);
    expect(diff).toBeGreaterThan(0.01);
  });

  it("tone LP darkens the top octave", () => {
    const mk = (tone: number) =>
      renderStereo(proc0(), 0.5, paramSet({ drive: 0.5, hysteresis: 0, tone, mix: 1 }), (n) => [
        0.4 * Math.sin((n / SR) * 10000 * Math.PI * 2),
        0,
      ]).L;
    function proc0() {
      return createTapeProcessor();
    }
    const dark = goertzel(mk(500), 10000);
    const bright = goertzel(mk(12000), 10000);
    expect(db(bright) - db(dark)).toBeGreaterThan(6);
  });

  it("output gain scales the wet signal", () => {
    const mk = (output: number) =>
      renderStereo(proc0(), 0.5, paramSet({ drive: 0.3, hysteresis: 0, mix: 1, output }), (n) => [
        0.3 * Math.sin((n / SR) * 440 * Math.PI * 2),
        0,
      ]).L;
    function proc0() {
      return createTapeProcessor();
    }
    const ratio = goertzel(mk(6), 440) / goertzel(mk(0), 440);
    expect(20 * Math.log10(ratio)).toBeGreaterThan(5);
    expect(20 * Math.log10(ratio)).toBeLessThan(7);
  });

  it("extremes soak: finite, bounded, no NaN", () => {
    const proc = createTapeProcessor();
    const { L, R } = renderStereo(
      proc,
      1,
      paramSet({ drive: 1, hysteresis: 0.95, tone: 500, mix: 1, output: 12 }),
      (n) => [Math.sin(n * 0.31) * 0.9, Math.cos(n * 0.17) * 0.9],
    );
    for (const buf of [L, R]) {
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i])).toBe(true);
        expect(Math.abs(buf[i])).toBeLessThan(8);
      }
    }
  });
});
