import { describe, expect, it } from "vitest";
import { pitchShiftPreserveDuration } from "../src/audio-engine/time-stretch";

function makeSine(sampleRate: number, freq: number, seconds: number): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function zeroCrossRate(data: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] === 0) crossings++;
    else if (data[i] * data[i - 1] < 0) crossings++;
  }
  return crossings / (data.length / sampleRate);
}

describe("pitchShiftPreserveDuration", () => {
  it("keeps the output length equal to the input", () => {
    const data = makeSine(44100, 220, 0.5);
    const out = pitchShiftPreserveDuration(data, 44100, 12);
    expect(out.length).toBe(data.length);
  });

  it("raises pitch by +12 semitones (2x zero-cross rate)", () => {
    const data = makeSine(44100, 220, 0.5);
    const out = pitchShiftPreserveDuration(data, 44100, 12);
    const base = zeroCrossRate(data, 44100);
    const shifted = zeroCrossRate(out, 44100);
    // 220 Hz -> 440 Hz: ratio ~2
    expect(shifted / base).toBeGreaterThan(1.7);
    expect(shifted / base).toBeLessThan(2.3);
  });

  it("lowers pitch by -12 semitones (0.5x zero-cross rate)", () => {
    const data = makeSine(44100, 440, 0.5);
    const out = pitchShiftPreserveDuration(data, 44100, -12);
    const base = zeroCrossRate(data, 44100);
    const shifted = zeroCrossRate(out, 44100);
    expect(shifted / base).toBeGreaterThan(0.4);
    expect(shifted / base).toBeLessThan(0.6);
  });

  it("returns empty for empty input", () => {
    expect(pitchShiftPreserveDuration(new Float32Array(0), 44100, 5).length).toBe(0);
  });

  it("is deterministic (same input -> same output)", () => {
    const data = makeSine(44100, 330, 0.3);
    const a = pitchShiftPreserveDuration(data, 44100, 7);
    const b = pitchShiftPreserveDuration(data, 44100, 7);
    expect(a).toEqual(b);
  });
});
