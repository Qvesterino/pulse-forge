import { beforeAll, describe, expect, it } from "vitest";

/**
 * Drive oversampling (PARAM-VALUE-AUDIT-2026-09, Vlna 3).
 *
 * The audit's biggest beyond-ranges gap: tanh drives running at base sample
 * rate alias audibly when pushed. The native WaveShaper drives (saturation,
 * clipper, distortion, drum/bass buss, shimmer) already ran 4× oversampled;
 * tapeSat 4× and svFilter 2× ship their own in-worklet stages. This wave
 * brought every remaining tanh drive onto the svfilter 2× pattern:
 * freqShifter, kaskada (RYFT), autowah (the hottest curve — up to ×10 into
 * tanh) and vinyl (tube saturation of the wet path). ringMod has no
 * saturator (carrier-sum fold is the aesthetic) and bitcrusher's aliasing
 * IS the effect — both documented, no OS by design.
 *
 * Tests per curve: on a hot 5.8 kHz sine, harmonic-fold products (5th →
 * 19 kHz, 7th → 7.4 kHz at 48 k) must sit far below the plain base-rate
 * saturator's, while the fundamental and the in-band 3rd harmonic survive
 * (drive is still DRIVING). Plus full-processor smokes at DRIVE = 1.
 * The kaskada driven loop is covered by tests/kaskada.test.ts.
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
const BLOCK = 128;

const registered = new Map<string, new () => any>();

let osDriveSat: (st: unknown, x: number, inGain: number, outNorm: number) => number;
let newOsDriveState: () => unknown;
let createFreqShiftProcessor: (options?: { processorOptions?: unknown }) => any;
let vnOsDrive: (st: unknown, x: number, k: number, comp: number) => number;
let newVnDriveState: () => unknown;

function freshState(): unknown {
  return { sub: new Float32Array(8), sat: new Float32Array(8), w: 0, sw: 0, prev: 0 };
}

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  const fsMod = await import("../src/audio-worklets/freqshifter-processor.js");
  osDriveSat = fsMod.osDriveSat;
  newOsDriveState = fsMod.newOsDriveState;
  createFreqShiftProcessor = fsMod.createFreqShiftProcessor;
  const vnMod = await import("../src/audio-worklets/vinyl-processor.js");
  vnOsDrive = vnMod.vnOsDrive;
  newVnDriveState = vnMod.newVnDriveState;
  await import("../src/audio-worklets/autowah-processor.js");
  expect(registered.get("autowah-processor")).toBeDefined();
  expect(typeof osDriveSat).toBe("function");
  expect(typeof vnOsDrive).toBe("function");
});

/** Goertzel magnitude at one frequency over a Hann-windowed segment. */
function goertzel(sig: Float32Array, freq: number): number {
  const n = sig.length;
  const w = (2 * Math.PI * freq) / SR;
  const coef = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const x = sig[i] * win;
    const s0 = x + coef * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coef * s1 * s2)) / (n / 4);
}

function db(a: number, b: number): number {
  return 20 * Math.log10(a / b);
}

/**
 * Shared fold analysis: render the same hot sine through the oversampled
 * saturator and the plain base-rate curve, compare fold products.
 * osSample/legacySample take one input sample, return one output sample.
 */
function assertFoldSuppressed(name: string, osSample: (x: number) => number, legacySample: (x: number) => number) {
  const osOut = new Float32Array(32768);
  for (let i = 0; i < osOut.length; i++) osOut[i] = osSample(Math.sin((2 * Math.PI * F0 * i) / SR) * 0.9);
  const legacyOut = new Float32Array(32768);
  for (let i = 0; i < legacyOut.length; i++) legacyOut[i] = legacySample(Math.sin((2 * Math.PI * F0 * i) / SR) * 0.9);

  for (const buf of [osOut, legacyOut]) {
    for (const v of buf) expect(Number.isFinite(v)).toBe(true);
  }

  const seg = (buf: Float32Array) => buf.subarray(buf.length - 16384);
  const mag = (buf: Float32Array, f: number) => goertzel(seg(buf), f);

  // Fundamental + in-band 3rd harmonic survive (the drive still saturates).
  const fundOs = mag(osOut, F0);
  expect(fundOs, `${name}: audible fundamental`).toBeGreaterThan(0.01);
  expect(Math.abs(db(fundOs, mag(legacyOut, F0))), `${name}: fundamental parity`).toBeLessThan(3);
  expect(mag(osOut, 3 * F0), `${name}: 3rd harmonic present`).toBeGreaterThan(0.0005);

  // Fold products: base-rate 5th (29 kHz → 19 kHz) and 7th (40.6 kHz →
  // 7.4 kHz) aliases must drop far below the legacy saturator's.
  const drop5 = db(mag(legacyOut, 19000), mag(osOut, 19000));
  const drop7 = db(mag(legacyOut, 7400), mag(osOut, 7400));
  expect(drop5, `${name}: 5th-harmonic fold rejection`).toBeGreaterThan(18);
  expect(drop7, `${name}: 7th-harmonic fold rejection`).toBeGreaterThan(12);
}

describe("2× oversampled drive curves (fold suppression vs base rate)", () => {
  it("freqShifter curve (Padé tanh, inGain 5, outNorm 1/1.6)", () => {
    const st = newOsDriveState();
    assertFoldSuppressed(
      "freqShifter",
      (x) => osDriveSat(st, x, 5, 1 / 1.6),
      (x) => {
        const v = x * 5;
        const x2 = v * v;
        return ((v * (27 + x2)) / (27 + 9 * x2)) * (1 / 1.6);
      },
    );
  });

  it("vinyl curve (softSat, driveK 5, driveComp 1/1.6)", () => {
    const st = newVnDriveState();
    assertFoldSuppressed(
      "vinyl",
      (x) => vnOsDrive(st, x, 5, 1 / 1.6),
      (x) => {
        const v = x * 5;
        const x2 = v * v;
        return ((v * (27 + x2)) / (27 + 9 * x2)) * (1 / 1.6);
      },
    );
  });

  it("autowah curve (Math.tanh, driveK 10 — the hottest in the rack)", () => {
    const cls = registered.get("autowah-processor")!;
    const k = 10;
    const invNorm = 1 / Math.tanh(k);
    const st = freshState();
    assertFoldSuppressed(
      "autowah",
      (x) => (cls as any).osDrive(st, x, k, invNorm),
      (x) => Math.tanh(x * k) * invNorm,
    );
  });
});

function smoke(name: string, proc: any, overrides: Record<string, number>) {
  const params: Record<string, Float32Array> = {};
  for (const d of (proc.constructor as any).parameterDescriptors as { name: string; defaultValue: number }[]) {
    params[d.name] = Float32Array.from([d.name in overrides ? overrides[d.name] : d.defaultValue]);
  }
  let peak = 0;
  for (let b = 0; b < 60; b++) {
    const input = [new Float32Array(BLOCK).map((_, i) => Math.sin((2 * Math.PI * 440 * (b * BLOCK + i)) / SR) * 0.5)];
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([input], [output], params);
    for (const ch of output) {
      for (const v of ch) {
        expect(Number.isFinite(v), `${name}: finite`).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
    }
  }
  expect(peak, `${name}: audible`).toBeGreaterThan(0.001);
  expect(peak, `${name}: bounded`).toBeLessThan(4);
}

describe("full-processor smokes at DRIVE = 1", () => {
  it("freqShifter", () => {
    smoke("freqShifter", createFreqShiftProcessor(), { drive: 1, mix: 0.5 });
  });

  it("autowah (drive grit before the SVF sweep)", () => {
    smoke("autowah", new (registered.get("autowah-processor")!)(), {
      drive: 1,
      minFreq: 300,
      maxFreq: 2500,
      sensitivity: 1.5,
    });
  });

  it("vinyl (tube saturation over the artefact sum)", () => {
    smoke("vinyl", new (registered.get("vinyl-processor")!)(), { drive: 1 });
  });
});
