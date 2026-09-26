import { beforeAll, describe, expect, it } from "vitest";

/**
 * Drive oversampling (PARAM-VALUE-AUDIT-2026-09, Vlna 3).
 *
 * The audit's biggest beyond-ranges gap: tanh drives running at base sample
 * rate alias audibly when pushed. The native WaveShaper drives (saturation,
 * clipper, distortion, drum/bass buss, shimmer) already ran 4× oversampled;
 * tapeSat 4× and svFilter 2× ship their own in-worklet stages. This wave
 * brought the remaining two tanh drives (freqShifter, kaskada) onto the
 * svfilter 2× pattern.
 *
 * Tests:
 *  1. the exported `osDriveSat` (freqShifter's curve) on a hot 5.8 kHz sine:
 *     harmonic-fold products (5th → 19 kHz, 7th → 7.4 kHz at 48 k) must sit
 *     far below the plain base-rate saturator's, while the fundamental and
 *     the in-band 3rd harmonic survive (drive is still DRIVING);
 *  2. the full freqShifter processor with DRIVE = 1 stays finite, audible
 *     and bounded (the kaskada driven loop is covered by tests/kaskada.test.ts).
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const SR = 48000;
const F0 = 5800;

let osDriveSat: (st: unknown, x: number, inGain: number, outNorm: number) => number;
let newOsDriveState: () => unknown;
let createFreqShiftProcessor: () => any;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const mod = await import("../src/audio-worklets/freqshifter-processor.js");
  osDriveSat = mod.osDriveSat;
  newOsDriveState = mod.newOsDriveState;
  createFreqShiftProcessor = mod.createFreqShiftProcessor;
  expect(typeof osDriveSat).toBe("function");
});

/** Base-rate reference: the exact legacy curve fsSoftSat(x·g)·norm. */
function legacySat(x: number, inGain: number, outNorm: number): number {
  const v = x * inGain;
  const x2 = v * v;
  return ((v * (27 + x2)) / (27 + 9 * x2)) * outNorm;
}

/** Goertzel magnitude at one frequency over a Hann-windowed segment. */
function goertzel(sig: Float32Array, freq: number): number {
  const n = sig.length;
  const w = (2 * Math.PI * freq) / SR;
  const coef = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let power = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const x = sig[i] * win;
    s0 = x + coef * s1 - s2;
    s2 = s1;
    s1 = s0;
    power += x * x;
  }
  const mag = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coef * s1 * s2));
  return mag / (n / 4); // Hann coherent gain ≈ 0.5 → amplitude estimate
}

function renderSine(sat: (x: number) => number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = sat(Math.sin((2 * Math.PI * F0 * i) / SR) * 0.9);
  return out;
}

function db(a: number, b: number): number {
  return 20 * Math.log10(a / b);
}

describe("2× oversampled drive (freqShifter curve)", () => {
  // DRIVE = 1 on the freqShifter curve: inGain 1+4·1, outNorm 1/(1+0.6).
  const IN_GAIN = 5;
  const OUT_NORM = 1 / 1.6;

  it("folds harmonics far quieter than the base-rate saturator, keeps the tone", () => {
    const st = newOsDriveState();
    const osOut = new Float32Array(32768);
    for (let i = 0; i < osOut.length; i++) {
      osOut[i] = osDriveSat(st, Math.sin((2 * Math.PI * F0 * i) / SR) * 0.9, IN_GAIN, OUT_NORM);
    }
    const legacyOut = renderSine((x) => legacySat(x, IN_GAIN, OUT_NORM), 32768);
    // Skip the FIR warmup, analyze the steady-state tail.
    const seg = (buf: Float32Array) => buf.subarray(buf.length - 16384);

    for (const buf of [osOut, legacyOut]) {
      for (const v of buf) expect(Number.isFinite(v)).toBe(true);
    }

    const mag = (buf: Float32Array, f: number) => goertzel(seg(buf), f);
    // Fundamental + in-band 3rd harmonic survive (the drive still saturates).
    const fundOs = mag(osOut, F0);
    const fundLegacy = mag(legacyOut, F0);
    expect(fundOs).toBeGreaterThan(0.01);
    expect(Math.abs(db(fundOs, fundLegacy))).toBeLessThan(3);
    expect(mag(osOut, 3 * F0)).toBeGreaterThan(0.0005);

    // Fold products: base-rate 5th (29 kHz → 19 kHz) and 7th (40.6 kHz →
    // 7.4 kHz) aliases must drop far below the legacy saturator's.
    const drop5 = db(mag(legacyOut, 19000), mag(osOut, 19000));
    const drop7 = db(mag(legacyOut, 7400), mag(osOut, 7400));
    expect(drop5).toBeGreaterThan(18);
    expect(drop7).toBeGreaterThan(12);
  });
});

describe("freqShifter processor with DRIVE = 1", () => {
  it("renders finite, audible, bounded output", () => {
    const proc = createFreqShiftProcessor();
    const params: Record<string, Float32Array> = {};
    for (const d of (proc.constructor as any).parameterDescriptors as {
      name: string;
      defaultValue: number;
    }[]) {
      params[d.name] = Float32Array.from([d.name === "drive" ? 1 : d.name === "mix" ? 0.5 : d.defaultValue]);
    }
    const block = 128;
    let peak = 0;
    for (let b = 0; b < 60; b++) {
      const input = [new Float32Array(block).map((_, i) => Math.sin((2 * Math.PI * 440 * (b * block + i)) / SR) * 0.5)];
      const output = [new Float32Array(block), new Float32Array(block)];
      proc.process([input], [output], params);
      for (const ch of output) {
        for (const v of ch) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
      }
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThan(4);
  });
});
