import { describe, expect, it } from "vitest";
import { MAJOR_PROFILE, MINOR_PROFILE, pearson, rotateProfile } from "../src/reference/dsp/keyProfiles";
import { computeOnsetEnvelopes, calculateSpectralFlux, removeBaseline } from "../src/reference/dsp/spectralFlux";
import { estimateTempoCandidates, tempoPrior } from "../src/reference/analysis/tempoCandidates";

/**
 * Reference-audio DSP edge matrix (T4 audio reference chain: key → tempo →
 * onsets). These functions feed INTENT conditioning, so adversarial inputs
 * (silence, DC, impulses, degenerate profiles) must degrade to finite,
 * deterministic values — never NaN into the patch or a wedgeged analysis.
 */

const SR = 48000;

describe("keyProfiles — Krumhansl-Schmuckler", () => {
  it("profiles are 12-long, positive, and peak on the tonic", () => {
    for (const profile of [MAJOR_PROFILE, MINOR_PROFILE]) {
      expect(profile).toHaveLength(12);
      expect(Math.min(...profile)).toBeGreaterThan(0);
    }
    expect(MAJOR_PROFILE[0]).toBe(Math.max(...MAJOR_PROFILE)); // classic profile shape
  });

  it("rotateProfile: tonic 0 is identity, tonic 12 wraps to identity", () => {
    expect(rotateProfile(MAJOR_PROFILE, 0)).toEqual([...MAJOR_PROFILE]);
    expect(rotateProfile(MAJOR_PROFILE, 12)).toEqual(rotateProfile(MAJOR_PROFILE, 0));
  });

  it("rotateProfile is a rotation — same multiset out, tonic lands at index 0", () => {
    const rotated = rotateProfile(MAJOR_PROFILE, 5);
    expect(rotated[0]).toBe(MAJOR_PROFILE[(0 - 5 + 12) % 12]);
    expect([...rotated].sort((a, b) => a - b)).toEqual([...MAJOR_PROFILE].sort((a, b) => a - b));
    // Every rotation of the major profile keeps F# as its minimum (3.48 at index 3 →
    // index (3+tonic) after rotation) — a rotation, not a reweighting.
    for (let tonic = 0; tonic < 12; tonic++) {
      const r = rotateProfile(MAJOR_PROFILE, tonic);
      expect(Math.min(...r)).toBeCloseTo(2.23, 10);
    }
  });

  it("pearson: perfect positive, perfect negative, exact zero, and the zero-variance guard", () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
    // [1,4,4,1] is exactly orthogonal to the linear ramp → 0.
    expect(pearson([1, 2, 3, 4], [1, 4, 4, 1])).toBeCloseTo(0, 10);
    // A constant vector has zero variance — the guard returns 0, never NaN.
    expect(pearson([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
    expect(pearson([5, 5, 5, 5], [5, 5, 5, 5])).toBe(0);
  });

  it("pearson is scale-invariant (the chroma-normalization contract)", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(
      pearson(
        a,
        a.map((v) => v * 100),
      ),
    ).toBeCloseTo(1, 10);
    expect(
      pearson(
        a,
        a.map((v) => v + 1000),
      ),
    ).toBeCloseTo(1, 10);
  });
});

describe("spectralFlux — onset envelopes under adversarial input", () => {
  const FFT = 1024;
  const HOP = 256;

  it("silence produces all-zero envelopes (no phantom onsets)", () => {
    const silence = new Float32Array(SR); // 1 s of silence
    const env = computeOnsetEnvelopes(silence, SR, FFT, HOP);
    expect(env.frameCount).toBeGreaterThan(0);
    for (const channel of [env.full, env.low, env.high, env.combined]) {
      for (const v of channel) expect(v).toBe(0);
    }
  });

  it("a signal shorter than one FFT window yields zero frames (no negative indexing)", () => {
    const tiny = new Float32Array(64);
    tiny[0] = 1;
    const env = computeOnsetEnvelopes(tiny, SR, FFT, HOP);
    expect(env.frameCount).toBe(0);
    expect(env.full.length).toBe(0);
  });

  it("a constant DC offset produces no flux (no positive spectral differences)", () => {
    const dc = new Float32Array(SR).fill(0.5);
    const env = computeOnsetEnvelopes(dc, SR, FFT, HOP);
    expect(Math.max(...env.combined)).toBe(0);
  });

  it("an impulse train lands flux peaks at the impulse frames", () => {
    const length = SR * 2;
    const signal = new Float32Array(length);
    const impulsePeriod = Math.round(SR * 0.5); // 2 Hz — 2 impulses
    for (let s = impulsePeriod; s < length; s += impulsePeriod) signal[s] = 1;
    const env = computeOnsetEnvelopes(signal, SR, FFT, HOP);
    expect(env.frameCount).toBe(Math.floor((length - FFT) / HOP) + 1);
    // Flux must rise somewhere around each impulse (±4 frames: the log-mag
    // jump peaks when the impulse crosses into the Hann window's weighted
    // region, ~3 frames after the first partial contact).
    const peaks = [...env.combined.keys()].filter((i) => env.combined[i] > 0.5);
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    const firstImpulseFrame = impulsePeriod / HOP;
    expect(peaks.some((p) => Math.abs(p - firstImpulseFrame) <= 4)).toBe(true);
  });

  it("removeBaseline: constant input rectifies to zeros; impulse survives; length preserved", () => {
    const constant = new Float32Array(64).fill(3);
    const zeroed = removeBaseline(constant, 8);
    expect(zeroed).toHaveLength(64);
    expect(Array.from(zeroed).every((v) => v === 0)).toBe(true);

    const impulse = new Float32Array(64);
    impulse[32] = 10;
    const out = removeBaseline(impulse, 8);
    expect(out).toHaveLength(64);
    expect(out[32]).toBeGreaterThan(0);
    expect(out.every((v) => v >= 0)).toBe(true); // half-wave rectified
    // windowSize < 1 clamps to a 1-sample baseline (no divide-by-zero).
    const degenerate = removeBaseline(impulse, 0);
    expect(degenerate.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("calculateSpectralFlux returns the combined envelope", () => {
    const signal = new Float32Array(FFT * 4);
    for (let i = 0; i < signal.length; i += 512) signal[i] = 1;
    const flux = calculateSpectralFlux(signal, SR, FFT, HOP);
    expect(flux).toBeInstanceOf(Float32Array);
    expect(flux.length).toBe(Math.floor((signal.length - FFT) / HOP) + 1);
    expect(flux.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });
});

describe("tempoCandidates — prior and estimation", () => {
  it("tempoPrior peaks at 120 BPM with Gaussian decay (σ=55 → e^-0.5 at ±55, e^-2 at ±110)", () => {
    expect(tempoPrior(120)).toBeCloseTo(1, 12);
    // Custom center/spread normalize the same way.
    expect(tempoPrior(140, 140, 20)).toBeCloseTo(1, 12);
    // Symmetric around the center.
    expect(tempoPrior(65)).toBeCloseTo(tempoPrior(175), 12);
    expect(tempoPrior(65)).toBeCloseTo(Math.exp(-0.5), 10); // exactly 1σ out
    expect(tempoPrior(10)).toBeCloseTo(tempoPrior(230), 12);
    expect(tempoPrior(10)).toBeCloseTo(Math.exp(-2), 10); // exactly 2σ out
    // Strictly monotonic away from the center.
    expect(tempoPrior(120)).toBeGreaterThan(tempoPrior(90));
    expect(tempoPrior(90)).toBeGreaterThan(tempoPrior(65));
    expect(tempoPrior(65)).toBeGreaterThan(tempoPrior(20));
    expect(tempoPrior(20)).toBeGreaterThan(tempoPrior(2));
  });

  it("short envelopes bail out cleanly", () => {
    expect(estimateTempoCandidates(new Float32Array(7), 100, 70, 180)).toEqual([]);
    expect(estimateTempoCandidates(new Float32Array(0), 100, 70, 180)).toEqual([]);
  });

  it("an impossible lag window returns no candidates", () => {
    // frameRate 1, tempoMin huge → maxLag ≤ minLag
    expect(estimateTempoCandidates(new Float32Array(64), 1, 6000, 7000)).toEqual([]);
  });

  it("a 2 Hz pulse train at frameRate 100 yields ≈120 BPM as the top candidate", () => {
    const frameRate = 100;
    const length = 800;
    const envelope = new Float32Array(length);
    for (let i = 50; i < length; i += 50) envelope[i] = 1; // 120 BPM
    const candidates = estimateTempoCandidates(envelope, frameRate, 70, 180, 6);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(6);
    // Top candidate at/near 120 (parabolic refinement may nudge a hair).
    expect(Math.abs(candidates[0]!.bpm - 120)).toBeLessThan(3);
    for (const c of candidates) {
      expect(Number.isFinite(c.bpm)).toBe(true);
      expect(Number.isFinite(c.score)).toBe(true);
      expect(c.score).toBeGreaterThanOrEqual(0);
    }
    // Sorted by score, strongest first.
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1]!.score).toBeGreaterThanOrEqual(candidates[i]!.score);
    }
  });

  it("a silent envelope produces finite, empty-or-zero-score output (never NaN)", () => {
    const candidates = estimateTempoCandidates(new Float32Array(400), 100, 70, 180, 6);
    for (const c of candidates) {
      expect(Number.isFinite(c.bpm)).toBe(true);
      expect(Number.isFinite(c.score)).toBe(true);
    }
  });
});
