import { beforeAll, describe, expect, it } from "vitest";

/**
 * SKRUTKA (skrutka) — determinism + transient-shaping pins.
 *
 * The processor has no RNG and no free-running phases: same input + params →
 * bit-identical output across any number of runs (two-variant alternation
 * check, NEW-EFFECT-CHECKLIST §10). The impulse pin proves the actual musical
 * claim of the device: dispersion is all-pass, so a steady tone is untouched,
 * but a broadband transient is SPREAD over time (energy arrives later and
 * over a longer window).
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
  await import("../src/audio-worklets/skrutka-processor.js");
});

const SR = 48000;
const BLOCK = 128;

function render(paramsOverride: Record<string, number>, seconds: number, input: (i: number) => number): Float32Array {
  const cls = registered.get("skrutka-processor");
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

describe("SKRUTKA determinism", () => {
  it("three consecutive renders are sample-identical (no ping-pong)", () => {
    const opts = { dispersion: 0.7, punch: 0.4, focusHz: 260, spread: 0.5 };
    const r1 = render(opts, 0.8, musicalInput);
    const r2 = render(opts, 0.8, musicalInput);
    const r3 = render(opts, 0.8, musicalInput);
    expect(r1.length).toBeGreaterThan(0);
    for (let i = 0; i < r1.length; i++) {
      expect(r2[i]).toBe(r1[i]);
      expect(r3[i]).toBe(r1[i]);
    }
  });

  it("MIX 0 is bit-exact dry from a cold instance (first block adopts the params)", () => {
    const out = render({ mix: 0, dispersion: 1, punch: -1, spread: 1 }, 0.5, musicalInput);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(Math.fround(musicalInput(i)));
    }
  });
});

describe("SKRUTKA v2 legacy compatibility (v1 renders bit-identically)", () => {
  it("the v1 parameter set produces the frozen v1 hash (FNV-1a over the Float32 bits)", () => {
    // Frozen 2026-10-11 from the shipped v1 processor with this exact probe
    // (see ADR 0037 addendum): dispersion 0.6 / punch 0.4 / focus 320 /
    // spread 0.5 / mix 0.8 over a 1.2 s tonal + kick probe at 48 kHz.
    const probe = (i: number) =>
      0.55 * Math.sin((2 * Math.PI * 55 * i) / SR) +
      0.12 * Math.sin((2 * Math.PI * 110 * i) / SR) +
      0.05 * Math.sin((2 * Math.PI * 330 * i) / SR) +
      (i < 4800 ? 0.3 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * (300 + 200 * Math.exp(-i / 900)) * i) / SR) : 0);
    const out = render({ dispersion: 0.6, punch: 0.4, focusHz: 320, spread: 0.5, mix: 0.8, output: 0 }, 1.2, probe);
    let hashL = 2166136261;
    let hashR = 2166136261;
    for (let i = 0; i < out.length; i++) {
      const bytes = new Uint32Array(Float32Array.of(out[i]!).buffer);
      hashL = Math.imul(hashL ^ bytes[0]!, 16777619) >>> 0;
      hashR = Math.imul(hashR ^ (bytes[0]! >>> 16), 16777619) >>> 0;
    }
    const hash = `${hashL.toString(16).padStart(8, "0")}${hashR.toString(16).padStart(8, "0")}`;
    expect(hash).toBe("e6cb495b83b6556c");
    let absSum = 0;
    for (let i = 0; i < out.length; i++) absSum += Math.abs(out[i]!);
    expect(absSum).toBeCloseTo(19578.905037, 5);
  });

  it("v2-only params at their defaults do not change the render (shape 0, dyn 0, key 0, punchHz 0, punchMix 1)", () => {
    const opts = { dispersion: 0.6, punch: 0.5, focusHz: 240, spread: 0.4, mix: 0.9 };
    const a = render(opts, 0.8, musicalInput);
    const b = render(
      { ...opts, shape: 0, dyn: 0, keyMode: 0, punchHz: 0, punchMix: 1, lfoDepth: 0 },
      0.8,
      musicalInput,
    );
    expect(a).toEqual(b);
  });
});

describe("SKRUTKA transient shaping (all-pass spreads a click, not a tone)", () => {
  it("an impulse spreads: dispersion 1 keeps its energy but pushes it past sample 100", () => {
    const impulse = (i: number) => (i === 0 ? 1 : 0);
    const shaped = render({ dispersion: 1, punch: 0, focusHz: 900, mix: 1 }, 0.1, impulse);
    const near = render({ dispersion: 0, punch: 0, focusHz: 900, mix: 1 }, 0.1, impulse);

    const totalEnergy = (signal: Float32Array): number => {
      let e = 0;
      for (const v of signal) e += v * v;
      return e;
    };
    const tailEnergy = (signal: Float32Array): number => {
      let e = 0;
      for (let i = 100; i < signal.length; i++) e += signal[i]! * signal[i]!;
      return e;
    };

    // All-pass: the total energy is preserved (phase-only), but the impulse
    // is spread — dispersion 1 carries energy past sample 100 while the
    // near-neutral chain keeps it concentrated around the short delay.
    expect(totalEnergy(shaped)).toBeGreaterThan(totalEnergy(near) * 0.98);
    expect(totalEnergy(shaped)).toBeLessThan(totalEnergy(near) * 1.02);
    expect(tailEnergy(shaped)).toBeGreaterThan(tailEnergy(near) * 10);
  });
});
