/**
 * Vocoder processor tests — filterbank analysis/synthesis + the
 * carrier/modulator routing contract.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals (the
 * same host pattern as tests/fx-expansion.test.ts). Every assertion is
 * deterministic: the DSP has no randomness, so live and offline parity is a
 * structural property rather than a seeded one.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface VocoderLike {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ) => boolean;
}

const SR = 44100;

function param(values: Record<string, number>): Record<string, Float32Array> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Float32Array.of(v)]));
}

function tone(freq: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

function silence(n: number): Float32Array {
  return new Float32Array(n);
}

function energyOf(block: Float32Array[]): number {
  let sum = 0;
  for (const ch of block) for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / block.reduce((a, c) => a + c.length, 0));
}

/** Goertzel: energy at one frequency in a block (spectral probe). */
function goertzel(data: Float32Array, freq: number): number {
  const k = Math.round((data.length * freq) / SR);
  const w = (2 * Math.PI * k) / data.length;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / data.length;
}

let vocoderFactory: (options?: { processorOptions?: unknown }) => VocoderLike;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "vocoder-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in vocoder-processor.js");
  vocoderFactory = ((options?: { processorOptions?: unknown }) =>
    new (captured as new (o?: unknown) => VocoderLike)(options)) as typeof vocoderFactory;
});

const BASE_PARAMS = {
  bands: 16,
  loFreq: 120,
  hiFreq: 7000,
  q: 5,
  attack: 0.003,
  release: 0.05,
  shift: 0,
  sibilance: 0,
  stereo: 0,
  level: 0,
  mix: 1,
};

/** Render a carrier through the vocoder with a modulator; returns the output. */
function render(
  carrier: Float32Array,
  modulator: Float32Array,
  patch: Record<string, number> = {},
  blocks = 8,
): Float32Array[] {
  const fx = vocoderFactory();
  const params = param({ ...BASE_PARAMS, ...patch });
  const n = carrier.length;
  const outL = new Float32Array(n * blocks);
  const outR = new Float32Array(n * blocks);
  for (let b = 0; b < blocks; b++) {
    // inputs = [input0, input1]; each input is an array of channels.
    const inputs: Float32Array[][] = [
      [carrier.slice(), carrier.slice()],
      [modulator.slice(), modulator.slice()],
    ];
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process(inputs, out, params);
    outL.set(out[0][0], b * n);
    outR.set(out[0][1], b * n);
  }
  return [outL, outR];
}

describe("Vocoder processor", () => {
  it("passes the carrier through 1:1 when no modulator is connected", () => {
    const fx = vocoderFactory();
    const car = tone(440, 4096);
    const out: Float32Array[][] = [[new Float32Array(4096), new Float32Array(4096)]];
    // One input only (carrier); no modulator input.
    fx.process([[car, car]], out, param(BASE_PARAMS));
    for (let i = 0; i < 4096; i += 97) {
      expect(out[0][0][i]).toBeCloseTo(car[i], 6);
      expect(out[0][1][i]).toBeCloseTo(car[i], 6);
    }
  });

  it("passes only the carrier bands the modulator excites", () => {
    const n = 8192;
    const blocks = 6;
    // Carrier: two tones — one inside the modulator's band (~1 kHz), one far
    // above it. Modulator: a 1 kHz tone.
    const car = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      car[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.4 + Math.sin((2 * Math.PI * 5000 * i) / SR) * 0.4;
    }
    const [out] = render(car, tone(1000, n), {}, blocks);
    const tail = out.slice(n * (blocks - 2));
    const atModulated = goertzel(tail, 1000);
    const atFar = goertzel(tail, 5000);
    // The 1 kHz band is driven by the modulator; the 5 kHz band is not —
    // that is the transfer characteristic in one assertion.
    expect(atModulated).toBeGreaterThan(atFar * 3);
  });

  it("FORMANT shift moves the modulator's band onto a different carrier band", () => {
    const n = 8192;
    const blocks = 6;
    // Modulator 1 kHz. Carrier carries energy at 1 kHz and at 2 kHz.
    const car = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      car[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.4 + Math.sin((2 * Math.PI * 2000 * i) / SR) * 0.4;
    }
    const mod = tone(1000, n);
    const [flat] = render(car, mod, { shift: 0, loFreq: 60, hiFreq: 2000 }, blocks);
    const [shifted] = render(car, mod, { shift: 12, loFreq: 60, hiFreq: 2000 }, blocks);
    const tailFlat = flat.slice(n * (blocks - 2));
    const tailShift = shifted.slice(n * (blocks - 2));
    // Shift 0 → the 1 kHz carrier band is the excited one.
    expect(goertzel(tailFlat, 1000)).toBeGreaterThan(goertzel(tailFlat, 2000));
    // Shift +12 st → the modulator band moves to 2 kHz, so the 2 kHz carrier
    // band gains relative to the 1 kHz band.
    const flatRatio = goertzel(tailFlat, 2000) / Math.max(1e-9, goertzel(tailFlat, 1000));
    const shiftRatio = goertzel(tailShift, 2000) / Math.max(1e-9, goertzel(tailShift, 1000));
    expect(shiftRatio).toBeGreaterThan(flatRatio * 1.5);
  });

  it("silences bands the modulator does not excite", () => {
    const n = 8192;
    const blocks = 6;
    // Modulator: silence → nothing should drive any band envelope.
    const [out] = render(tone(440, n), silence(n), {}, blocks);
    const tail = out.slice(n * (blocks - 2));
    expect(energyOf([tail])).toBeLessThan(0.01);
  });

  it("FORMANT shift changes which carrier band the modulator excites", () => {
    const n = 8192;
    const blocks = 6;
    const mod = tone(2000, n);
    const car = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      car[i] = Math.sin((2 * Math.PI * 2000 * i) / SR) * 0.4 + Math.sin((2 * Math.PI * 4000 * i) / SR) * 0.4;
    }
    const [flat] = render(car, mod, { shift: 0, loFreq: 60, hiFreq: 4000 }, blocks);
    const [shifted] = render(car, mod, { shift: 12, loFreq: 60, hiFreq: 4000 }, blocks);
    const tailFlat = flat.slice(n * (blocks - 2));
    const tailShift = shifted.slice(n * (blocks - 2));
    // A +12 st shift moves the 2 kHz modulator peak onto the 4 kHz carrier
    // band; the 4 kHz carrier should gain relative to the 2 kHz carrier.
    const flatRatio = goertzel(tailFlat, 4000) / Math.max(1e-9, goertzel(tailFlat, 2000));
    const shiftRatio = goertzel(tailShift, 4000) / Math.max(1e-9, goertzel(tailShift, 2000));
    expect(shiftRatio).toBeGreaterThan(flatRatio);
  });

  it("SIBILANCE passes high-frequency modulator content the filterbank would drop", () => {
    const n = 4096;
    const blocks = 4;
    const carrier = silence(n); // no carrier content → only sibilance can output
    const mod = tone(8000, n); // above hiFreq → filterbank can't reproduce it
    const [withSib] = render(carrier, mod, { sibilance: 1 }, blocks);
    const [withoutSib] = render(carrier, mod, { sibilance: 0 }, blocks);
    const tailWith = withSib.slice(n * (blocks - 2));
    const tailWithout = withoutSib.slice(n * (blocks - 2));
    expect(energyOf([tailWith])).toBeGreaterThan(energyOf([tailWithout]) * 5);
  });

  it("MIX blends back toward the dry carrier", () => {
    const n = 4096;
    const blocks = 4;
    const carrier = tone(440, n);
    const mod = tone(1000, n);
    const [wet] = render(carrier, mod, { mix: 1 }, blocks);
    const [dry] = render(carrier, mod, { mix: 0 }, blocks);
    // Fully dry = the untouched carrier (sample-exact).
    for (let i = 0; i < n; i += 211) {
      expect(dry[i]).toBeCloseTo(carrier[i], 5);
    }
    expect(energyOf([wet.slice(n * 2)])).not.toBeCloseTo(energyOf([dry.slice(n * 2)]), 4);
  });

  it("band count changes the spectral resolution (8 vs 16 are audibly different)", () => {
    const n = 8192;
    const blocks = 6;
    const mod = tone(1000, n);
    const carrier = tone(440, n);
    const [eight] = render(carrier, mod, { bands: 8 }, blocks);
    const [sixteen] = render(carrier, mod, { bands: 16 }, blocks);
    let diff = 0;
    for (let i = n * 2; i < n * blocks; i++) diff += Math.abs(eight[i] - sixteen[i]);
    expect(diff / (n * (blocks - 2))).toBeGreaterThan(0.001);
  });

  it("is deterministic (no RNG) and stays finite under extremes", () => {
    const n = 4096;
    const carrier = tone(440, n, 0.9);
    const mod = tone(1000, n, 0.9);
    const a = render(carrier, mod, { bands: 16, q: 16, shift: 24, sibilance: 1, level: 12, mix: 1 }, 3);
    const b = render(carrier, mod, { bands: 16, q: 16, shift: 24, sibilance: 1, level: 12, mix: 1 }, 3);
    expect(Array.from(a[0])).toEqual(Array.from(b[0]));
    for (const v of a[0]) expect(Number.isFinite(v)).toBe(true);
  });

  it("missing parameters fall back to descriptor defaults (back-compat)", () => {
    const fx = vocoderFactory();
    const n = 2048;
    const car = tone(440, n);
    const mod = tone(1000, n);
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    // Only a legacy subset of params present.
    expect(() =>
      fx.process([[car, car], [mod, mod]], out, param({ bands: 16, loFreq: 120, hiFreq: 7000, mix: 1 })),
    ).not.toThrow();
    expect(energyOf(out[0])).toBeGreaterThan(0);
  });
});
