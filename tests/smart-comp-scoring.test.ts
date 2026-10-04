import { describe, expect, it } from "vitest";
import { measureTake, scoreTake, scoreTakes } from "../src/audio-engine/take-scoring";

/**
 * SMART COMPING — known-answer tests on synthetic PCM.
 *
 * Every fixture is a signal whose WINNING property is constructed, not
 * asserted after the fact: a take with transients placed ON the 1/16 grid
 * must out-score the same take with transients off-grid; a clipped take
 * must lose; a take with a fan (noise floor) must lose to a quiet one; a
 * take that sags in pitch must lose to a stable one. If any of these flip,
 * the product decision (tightness > clipping > pitch > floor) flipped, and
 * the failure names the axis.
 */

const SAMPLE_RATE = 48_000;

/** Decaying transient at `timeSec`, exactly like a drum hit envelope.
 *  Deterministic pseudo-noise (LCG) — a pitched sine would make the take
 *  "voiced", which drums are not; the noise must be reproducible. */
function transient(data: Float32Array, timeSec: number, sampleRate: number, amplitude = 0.8): void {
  const start = Math.round(timeSec * sampleRate);
  const decay = Math.round(0.05 * sampleRate);
  let seed = 12345 + start;
  for (let i = 0; i < decay && start + i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    data[start + i] += amplitude * Math.exp(-i / (decay / 4)) * noise;
  }
}

/** 2 bars at 120 BPM = 4 s. */
function twoBarsAt120(): Float32Array {
  return new Float32Array(2 * SAMPLE_RATE);
}

describe("measureTake — known-answer fixtures", () => {
  it("scores a grid-locked take as tight and a wandering take as loose", () => {
    const onGrid = twoBarsAt120();
    // 1/16 at 120 BPM = 0.125 s; place every transient exactly on it.
    for (let i = 0; i < 32; i++) transient(onGrid, i * 0.125, SAMPLE_RATE);
    const wandering = twoBarsAt120();
    // Human-sloppy: every hit lands at a DIFFERENT offset from the grid
    // (deterministic LCG). A constant +40 ms shift is a deliberate late
    // feel and must NOT read as loose — only spread does (that is why the
    // tightness is measured against the take's own median).
    let seed = 987654321;
    for (let i = 0; i < 32; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const wander = ((seed / 0xffffffff) * 2 - 1) * 0.05;
      transient(wandering, i * 0.125 + wander, SAMPLE_RATE);
    }

    const tight = measureTake(onGrid, SAMPLE_RATE, 120);
    const loose = measureTake(wandering, SAMPLE_RATE, 120);

    expect(tight.onsetCount).toBeGreaterThan(8);
    expect(tight.grooveTightness).toBeGreaterThan(0.8);
    expect(loose.grooveTightness).toBeLessThan(tight.grooveTightness);
    // The LOCK reading is the spread around the take's own median — the
    // wandering take must be measurably looser there.
    expect(loose.grooveSpreadSec).toBeGreaterThan(tight.grooveSpreadSec);
  });

  it("penalizes a clipped take on its clipped share, not on groove", () => {
    const clean = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(clean, i * 0.125, SAMPLE_RATE);
    const clipped = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(clipped, i * 0.125, SAMPLE_RATE);
    // Clamp 5 % of samples at full scale.
    for (let i = 0; i < clipped.length; i += 20) clipped[i] = 1;

    const cleanMetrics = measureTake(clean, SAMPLE_RATE, 120);
    const clippedMetrics = measureTake(clipped, SAMPLE_RATE, 120);

    expect(clippedMetrics.clippedShare).toBeGreaterThan(0);
    expect(clippedMetrics.clippedShare).toBeGreaterThan(cleanMetrics.clippedShare);
    // The comp killer is measurable in isolation:
    expect(scoreTake(clippedMetrics).score).toBeLessThan(scoreTake(cleanMetrics).score);
  });

  it("ranks a quiet take above one with a noise floor (fan/hiss)", () => {
    const quiet = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(quiet, i * 0.125, SAMPLE_RATE);
    const noisy = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(noisy, i * 0.125, SAMPLE_RATE);
    // Constant fan: −45 dBFS noise, clearly audible between hits.
    for (let i = 0; i < noisy.length; i++) noisy[i] += 0.0056 * Math.sin(i * 0.01);

    const quietMetrics = measureTake(quiet, SAMPLE_RATE, 120);
    const noisyMetrics = measureTake(noisy, SAMPLE_RATE, 120);

    expect(noisyMetrics.noiseFloorDb).toBeGreaterThan(quietMetrics.noiseFloorDb);
    expect(scoreTake(noisyMetrics).score).toBeLessThan(scoreTake(quietMetrics).score);
  });

  it("detects pitch sag across a take (drift) and rewards stability", () => {
    // 220 Hz for the first half, a quarter tone lower (0.25 st) for the
    // second: the classic "singing under the note by the end" comping loss.
    const sagging = twoBarsAt120();
    const sagHz = 220 * Math.pow(2, -0.25 / 12);
    for (let i = 0; i < sagging.length; i++) {
      const hz = i < sagging.length / 2 ? 220 : sagHz;
      sagging[i] = 0.5 * Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * hz);
    }
    const stable = twoBarsAt120();
    for (let i = 0; i < stable.length; i++) stable[i] = 0.5 * Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220);

    const sagMetrics = measureTake(sagging, SAMPLE_RATE, 120);
    const stableMetrics = measureTake(stable, SAMPLE_RATE, 120);

    expect(sagMetrics.voicedFrames).toBeGreaterThanOrEqual(2);
    expect(sagMetrics.pitchDriftSemitones).toBeGreaterThan(0.15);
    expect(Number.isFinite(stableMetrics.pitchDriftSemitones)).toBe(true);
    expect(sagMetrics.pitchDriftSemitones).toBeGreaterThan(stableMetrics.pitchDriftSemitones);
  });

  it("does not invent pitch evidence for unvoiced (drum) takes", () => {
    const drums = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(drums, i * 0.125, SAMPLE_RATE);
    const metrics = measureTake(drums, SAMPLE_RATE, 120);
    // Drums must not be punished for having no fundamental — the honest
    // fallback is "no pitch axis", not a zero.
    expect(metrics.voicedFrames).toBe(0);
    expect(Number.isFinite(metrics.pitchDriftSemitones)).toBe(false);
    const scored = scoreTake(metrics);
    expect(scored.evidence.some((line) => line.includes("no voiced pitch"))).toBe(true);
  });

  it("returns honest NaN metrics for degenerate input instead of throwing", () => {
    const metrics = measureTake(new Float32Array(0), SAMPLE_RATE, 120);
    expect(metrics.onsetCount).toBe(0);
    expect(Number.isFinite(metrics.grooveTightness)).toBe(false);
    expect(metrics.clippedShare).toBe(0);
  });
});

describe("scoreTakes — relative ranking within a group", () => {
  it("ranks a tight, clean take first and reports evidence for each", () => {
    const good = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(good, i * 0.125, SAMPLE_RATE);
    const bad = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(bad, i * 0.125 + 0.05, SAMPLE_RATE);
    for (let i = 0; i < bad.length; i += 20) bad[i] = 1;

    const [goodScore, badScore] = scoreTakes(
      [
        { data: good, sampleRate: SAMPLE_RATE },
        { data: bad, sampleRate: SAMPLE_RATE },
      ],
      120,
    );

    expect(goodScore.score).toBeGreaterThan(badScore.score);
    expect(badScore.evidence.join(" ")).toContain("CLIPPED");
    expect(goodScore.evidence.length).toBeGreaterThan(2);
  });

  it("is deterministic — the same PCM scores identically across runs", () => {
    const take = twoBarsAt120();
    for (let i = 0; i < 32; i++) transient(take, i * 0.125, SAMPLE_RATE);
    const first = scoreTake(measureTake(take, SAMPLE_RATE, 120));
    const second = scoreTake(measureTake(take, SAMPLE_RATE, 120));
    expect(first.score).toBe(second.score);
    expect(first.evidence).toEqual(second.evidence);
  });
});
