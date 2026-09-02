import { describe, expect, it } from "vitest";
import { quantizeInt16, quantizeInt16Sample, softClipSample } from "../src/export/quantize";
import { mulberry32 } from "../src/export/quantize";

describe("export soft-clip", () => {
  it("is transparent below the knee (−0.45 dBFS) and never exceeds ±1 above it", () => {
    for (let x = -0.95; x <= 0.95; x += 0.001) {
      expect(softClipSample(x)).toBe(x);
    }
    for (const x of [0.96, 1, 1.2, 2, 10, 1000]) {
      expect(softClipSample(x)).toBeLessThanOrEqual(1);
      expect(softClipSample(x)).toBeGreaterThan(0.95);
    }
    for (const x of [-0.96, -1, -2, -10, -1000]) {
      expect(softClipSample(x)).toBeGreaterThanOrEqual(-1);
      expect(softClipSample(x)).toBeLessThan(-0.95);
    }
  });

  it("is monotonic across the knee (no wiggle at the join)", () => {
    let prev = softClipSample(0.9);
    for (let x = 0.9; x <= 1.3; x += 0.005) {
      const v = softClipSample(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("export quantizeInt16", () => {
  it("keeps extreme inputs inside int16 with a soft ceiling (no hard-clip square)", () => {
    const input = new Float32Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = 5 * Math.sin((2 * Math.PI * 220 * i) / 44100); // 5× overshoot
    const out = quantizeInt16(input, 1234);
    let max = 0;
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeLessThanOrEqual(0x7fff);
      expect(out[i]).toBeGreaterThanOrEqual(-0x8000);
      max = Math.max(max, Math.abs(out[i]));
    }
    expect(max).toBeGreaterThan(31000); // rides just under full scale
  });

  it("is deterministic per seed and decorrelated between channels", () => {
    const input = new Float32Array(2048);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    const a = quantizeInt16(input, 77);
    const b = quantizeInt16(input, 77);
    const c = quantizeInt16(input, 78);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it("dithers quiet passages instead of truncating them to digital silence", () => {
    // amplitude far below ½ LSB — without dither every sample rounds to 0
    const input = new Float32Array(8192);
    for (let i = 0; i < input.length; i++) input[i] = 2e-5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = quantizeInt16(input, 42);
    let nonZero = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs(out[i])).toBeLessThanOrEqual(2); // dither noise floor ±1 LSB + signal
      if (out[i] !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(1000); // the tail is audible noise, not silence
  });
});

describe("wav 16-bit sample quantizer", () => {
  it("returns valid int16 samples from a shared PRNG stream", () => {
    const rand = mulberry32(0x57415631);
    for (const x of [0, 0.5, -0.99999, 1.4, -7]) {
      const v = quantizeInt16Sample(x, rand);
      expect(v).toBeLessThanOrEqual(0x7fff);
      expect(v).toBeGreaterThanOrEqual(-0x8000);
    }
  });
});
