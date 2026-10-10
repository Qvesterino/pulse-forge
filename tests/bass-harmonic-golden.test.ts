import { beforeAll, describe, expect, it } from "vitest";

/**
 * KOREŇ (bassHarmonic) — determinism pins.
 *
 * The processor has no RNG: same input + params → bit-identical output across
 * any number of runs (no ping-pong render-path defect, no free-running phase
 * state beyond the deterministic detector). Two-variant alternation check
 * pattern from NEW-EFFECT-CHECKLIST §10.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
const registered = new Map<string, any>();
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/bass-harmonic-processor.js");
});

const SR = 48000;
const BLOCK = 128;

function render(paramsOverride: Record<string, number>, seconds: number, input: (i: number) => number): Float32Array {
  const cls = registered.get("bass-harmonic-processor");
  const params: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
    params[d.name] = Float32Array.from([paramsOverride[d.name] ?? d.defaultValue]);
  }
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outAll = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const inp = [Float32Array.from({ length: len }, (_, i) => input(offset + i))];
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process([inp], [out], params);
    outAll.set(out[0]!.subarray(0, len), offset);
  }
  return outAll;
}

const musicalInput = (i: number) =>
  0.55 * Math.sin((2 * Math.PI * 55 * i) / SR) +
  0.12 * Math.sin((2 * Math.PI * 110 * i) / SR) +
  0.05 * Math.sin((2 * Math.PI * 330 * i) / SR);

describe("KOREŇ determinism", () => {
  it("three consecutive renders are sample-identical (no ping-pong)", () => {
    const opts = { drive: 0.9, mix: 0.8, focusHz: 80, harmonics: 0.6, range: 3 };
    const r1 = render(opts, 0.8, musicalInput);
    const r2 = render(opts, 0.8, musicalInput);
    const r3 = render(opts, 0.8, musicalInput);
    expect(r1.length).toBeGreaterThan(0);
    for (let i = 0; i < r1.length; i++) {
      expect(r2[i]).toBe(r1[i]);
      expect(r3[i]).toBe(r1[i]);
    }
  });

  it("detector state is deterministic across instances (two runs from cold)", () => {
    const opts = { drive: 0.7, mix: 1, focusHz: 90, subAnchor: 0.6 };
    const a = render(opts, 1.2, musicalInput);
    const b = render(opts, 1.2, musicalInput);
    expect(a).toEqual(b);
  });

  it("out-of-window focus mutes the generator deterministically (harmonics never invented)", () => {
    // 55 Hz fundamental against a 220 Hz focus: window is [110, 440] — out.
    // The wet path is then only the sub-anchor branch (drive contributes 0).
    const opts = { drive: 1, mix: 1, subAnchor: 1, focusHz: 220, lowCut: 20 };
    const out = render(opts, 0.6, (i) => 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR));
    const r2 = render(opts, 0.6, (i) => 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR));
    expect(out).toEqual(r2);
    // Goertzel: the 110 Hz component must stay far below the 55 Hz component
    // (only filter leakage — no generated harmonics).
    const goertzel = (signal: Float32Array, hz: number): number => {
      const from = Math.floor(signal.length * 0.6);
      const n = signal.length - from;
      const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < signal.length; i++) {
        const s0 = signal[i]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
    };
    const f0 = goertzel(out, 55);
    const h2 = goertzel(out, 110);
    expect(f0).toBeGreaterThan(0.1);
    expect(h2).toBeLessThan(f0 * 0.1);
  });
});
