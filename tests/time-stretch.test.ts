import { describe, expect, it } from "vitest";
import { pitchShiftPreserveDuration, timeStretch } from "../src/audio-engine/time-stretch";

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

describe("timeStretch", () => {
  it("stretches by factor 0.25 — the lowest supported rate (regression: was aliased to the input)", () => {
    // AudioEngine.computeStretchedBuffer clamps stretchRate to [0.25, 4].
    // At exactly 0.25 the guard used to hit the fallback path (`<= 0.25`),
    // returning the SOURCE array itself: the caller then reversed it in place
    // (corrupting the shared bank buffer) and AudioBuffer.set() with a
    // longer-than-destination source threw, killing the scheduler window.
    const data = makeSine(44100, 220, 0.5);
    const snapshot = Float32Array.from(data);
    const out = timeStretch(data, 44100, 0.25);
    expect(out).not.toBe(data);
    expect(out.length).toBeGreaterThanOrEqual(Math.round(data.length * 0.25) - 1);
    expect(out.length).toBeLessThanOrEqual(Math.round(data.length * 0.25) + 1);
    expect(Array.from(data)).toEqual(Array.from(snapshot));
  });

  it("doubles / halves length for factor 2 and 0.5 and never aliases the input", () => {
    const data = makeSine(44100, 220, 0.5);
    const up = timeStretch(data, 44100, 2);
    const down = timeStretch(data, 44100, 0.5);
    expect(up).not.toBe(data);
    expect(down).not.toBe(data);
    expect(up.length).toBeCloseTo(data.length * 2, -2);
    expect(down.length).toBeCloseTo(data.length * 0.5, -2);
  });

  it("preserves signal level (window overlap is normalized)", () => {
    const data = makeSine(44100, 220, 0.5);
    const out = timeStretch(data, 44100, 1.5);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(out)).toBeGreaterThan(rms(data) * 0.5);
    expect(rms(out)).toBeLessThan(rms(data) * 1.5);
  });

  it("returns the input array by reference on documented fallbacks (callers must not mutate)", () => {
    const data = makeSine(44100, 220, 0.2);
    expect(timeStretch(data, 44100, 0.24)).toBe(data); // below supported range
    expect(timeStretch(data, 44100, 5)).toBe(data); // above supported range
    expect(timeStretch(data, 44100, 1.005)).toBe(data); // within 1 cent of unity
    expect(timeStretch(new Float32Array(0), 44100, 2).length).toBe(0);
  });

  it("is deterministic (same input -> same output)", () => {
    const data = makeSine(44100, 330, 0.3);
    expect(timeStretch(data, 44100, 1.7)).toEqual(timeStretch(data, 44100, 1.7));
  });

  it("cubic grains stay finite and bounded on edgy material", () => {
    const data = makeSine(44100, 220, 0.5);
    data[0] = 1;
    data[1] = -1; // transient edge stresses grain-border interpolation
    const out = timeStretch(data, 44100, 1.7);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(1.5);
  });
});
