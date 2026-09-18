import { describe, expect, it } from "vitest";
import { clampWarpRate, phaseVocoderWarpChannel, warpRateEnvelope } from "../src/audio-engine/phase-vocoder";

const SR = 44100;

function makeSine(freq: number, seconds: number, amp = 0.8): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function zeroCrossRate(data: Float32Array): number {
  // Middle 80% — skips the edge fade of the first/last analysis windows.
  const from = Math.floor(data.length * 0.1);
  const to = Math.ceil(data.length * 0.9);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (data[i] === 0) crossings++;
    else if (data[i] * data[i - 1] < 0) crossings++;
  }
  return crossings / ((to - from) / SR);
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

describe("warpRateEnvelope", () => {
  it("picks the spanning interval and clamps edges", () => {
    const at = warpRateEnvelope([
      { startSec: 1, endSec: 2, rate: 1.5 },
      { startSec: 2, endSec: 4, rate: 0.5 },
    ]);
    expect(at(0)).toBe(1.5);
    expect(at(1.5)).toBe(1.5);
    expect(at(3)).toBe(0.5);
    expect(at(99)).toBe(0.5);
  });

  it("clamps rates into range and defaults empty to 1", () => {
    expect(clampWarpRate(99)).toBe(4);
    expect(clampWarpRate(0)).toBe(0.25);
    expect(clampWarpRate(NaN)).toBe(1);
    expect(warpRateEnvelope([])(1.2)).toBe(1);
    expect(warpRateEnvelope([{ startSec: 0, endSec: 1, rate: 99 }])(0.5)).toBe(4);
  });
});

describe("phaseVocoderWarpChannel", () => {
  it("stretches ×1.5 with pitch and level preserved (440 Hz sine)", () => {
    const data = makeSine(440, 0.4);
    const outLen = Math.round(data.length * 1.5);
    const out = phaseVocoderWarpChannel(data, SR, () => 1.5, outLen);
    expect(out.length).toBe(outLen);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    const ratio = zeroCrossRate(out) / zeroCrossRate(data);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
    expect(rms(out) / rms(data)).toBeGreaterThan(0.4);
    expect(rms(out) / rms(data)).toBeLessThan(1.6);
    expect(peak(out)).toBeLessThan(1.5);
  });

  it("compresses ×0.7 with pitch preserved", () => {
    const data = makeSine(330, 0.5);
    const outLen = Math.round(data.length * 0.7);
    const out = phaseVocoderWarpChannel(data, SR, () => 0.7, outLen);
    expect(out.length).toBe(outLen);
    const ratio = zeroCrossRate(out) / zeroCrossRate(data);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
    expect(rms(out) / rms(data)).toBeGreaterThan(0.4);
  });

  it("rate 1.0 is near-transparent", () => {
    const data = makeSine(220, 0.5);
    const out = phaseVocoderWarpChannel(data, SR, () => 1, data.length);
    const ratio = zeroCrossRate(out) / zeroCrossRate(data);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
    expect(rms(out) / rms(data)).toBeGreaterThan(0.7);
    expect(rms(out) / rms(data)).toBeLessThan(1.3);
  });

  it("follows a time-varying envelope at exact length", () => {
    const data = makeSine(277, 0.6);
    const at = warpRateEnvelope([
      { startSec: 0, endSec: 0.3, rate: 1.5 },
      { startSec: 0.3, endSec: 0.6, rate: 0.75 },
    ]);
    const out = phaseVocoderWarpChannel(data, SR, at, data.length);
    expect(out.length).toBe(data.length);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    // No energy collapse across the rate seam (windowed RMS per eighth).
    let min = Infinity;
    for (let s = 0; s < 8; s++) {
      const seg = out.subarray(Math.floor((s * out.length) / 8), Math.floor(((s + 1) * out.length) / 8));
      min = Math.min(min, rms(seg));
    }
    expect(min).toBeGreaterThan(rms(data) * 0.15);
    expect(peak(out)).toBeLessThan(1.5);
  });

  it("maps silence to silence", () => {
    const out = phaseVocoderWarpChannel(new Float32Array(SR >> 1), SR, () => 1.7, SR);
    expect(peak(out)).toBeLessThan(1e-6);
  });

  it("handles empty input and invalid sizes", () => {
    expect(phaseVocoderWarpChannel(new Float32Array(0), SR, () => 2, 100).length).toBe(100);
    expect(phaseVocoderWarpChannel(makeSine(440, 0.2), SR, () => 1, 0).length).toBe(0);
    expect(() => phaseVocoderWarpChannel(makeSine(440, 0.2), SR, () => 1, 100, { fftSize: 1000 })).toThrow();
  });

  it("is deterministic (same input -> bit-identical output)", () => {
    const data = makeSine(311, 0.3);
    const at = warpRateEnvelope([{ startSec: 0, endSec: 1, rate: 1.3 }]);
    expect(phaseVocoderWarpChannel(data, SR, at, 8000)).toEqual(phaseVocoderWarpChannel(data, SR, at, 8000));
  });

  it("renders 2 s of mono inside the unit-test budget", () => {
    const data = makeSine(196, 2);
    const out = phaseVocoderWarpChannel(data, SR, () => 1.3, Math.round(data.length * 1.3));
    expect(out.length).toBe(Math.round(data.length * 1.3));
    const ratio = zeroCrossRate(out) / zeroCrossRate(data);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });
});
