import { describe, expect, it } from "vitest";
import { detectLoopBpm, fitRate } from "../src/audio-engine/bpm-detect";

const SR = 44100;

/** Percussive click track: decaying sine bursts on a steady grid. */
function makeClickTrack(bpm: number, seconds: number, subdivision = 1): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  const beatSec = 60 / bpm;
  const stepSec = beatSec / subdivision;
  for (let t = 0; t < seconds; t += stepSec) {
    const start = Math.round(t * SR);
    // 25 ms exponential-decay burst — enough energy flux for the onset picker.
    for (let i = 0; i < Math.floor(SR * 0.025); i++) {
      const idx = start + i;
      if (idx >= n) break;
      out[idx] += Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / (SR * 0.004));
    }
  }
  return out;
}

describe("detectLoopBpm", () => {
  it("resolves a 174 BPM click to 174 or its half-time reading (87)", () => {
    // A uniform click stream at 174 is genuinely ambiguous with 87 (every
    // other beat). Both readings lock the loop to a project grid when fitted —
    // one as straight beats, the other as double-time — so both are valid.
    const detected = detectLoopBpm(makeClickTrack(174, 8), SR);
    expect(detected).not.toBeNull();
    const ok = Math.abs(detected!.bpm - 174) <= 1.5 || Math.abs(detected!.bpm - 87) <= 1.5;
    expect(ok).toBe(true);
  });

  it.each([120, 90, 140, 96])("detects a %i BPM click track", (bpm) => {
    const detected = detectLoopBpm(makeClickTrack(bpm, 8), SR);
    expect(detected).not.toBeNull();
    // ~±1.5 BPM is the hop-quantization ceiling (onset times live on a ~6 ms
    // grid); fitting rounds the stretch rate to 2 decimals anyway.
    expect(Math.abs(detected!.bpm - bpm)).toBeLessThanOrEqual(1.5);
    expect(detected!.confidence).toBeGreaterThanOrEqual(1.15);
  });

  it.each([120, 100])("detects tempo from 8th-note hats on a %i BPM grid (double-time folding)", (bpm) => {
    const detected = detectLoopBpm(makeClickTrack(bpm, 8, 2), SR);
    expect(detected).not.toBeNull();
    // Onset times are frame-quantized (~6 ms), so subdivision reads have a
    // slightly wider tolerance than straight quarter-note clicks.
    expect(Math.abs(detected!.bpm - bpm)).toBeLessThanOrEqual(1.5);
  });

  it("detects a slow 2-bar kick pattern (half-time folding)", () => {
    // 70 BPM kicks but with accents only every 2 beats → raw ACF may find 35.
    const detected = detectLoopBpm(makeClickTrack(70, 10), SR);
    expect(detected).not.toBeNull();
    expect(Math.abs(detected!.bpm - 70)).toBeLessThanOrEqual(1);
  });

  it("rejects silence (no onsets)", () => {
    expect(detectLoopBpm(new Float32Array(SR * 8), SR)).toBeNull();
  });

  it("rejects steady noise (no clear pulse)", () => {
    // Deterministic pseudo-noise with a flat spectrum — no rhythmic grid.
    let seed = 12345;
    const data = new Float32Array(SR * 8);
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
    }
    const detected = detectLoopBpm(data, SR);
    if (detected !== null) expect(detected.confidence).toBeLessThan(1.3);
  });

  it("rejects buffers that are too short to judge", () => {
    expect(detectLoopBpm(makeClickTrack(120, 1), SR)).toBeNull();
  });

  it("is deterministic (same input → same output)", () => {
    const data = makeClickTrack(128, 6);
    const a = detectLoopBpm(data, SR);
    const b = detectLoopBpm(data, SR);
    expect(a).toEqual(b);
  });

  it("works at a different sample rate", () => {
    const sr = 22050;
    const n = Math.floor(sr * 8);
    const data = new Float32Array(n);
    const step = Math.round((60 / 120) * sr);
    for (let start = 0; start < n; start += step) {
      for (let i = 0; i < Math.floor(sr * 0.025) && start + i < n; i++) {
        data[start + i] += Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.exp(-i / (sr * 0.004));
      }
    }
    const detected = detectLoopBpm(data, sr);
    expect(detected).not.toBeNull();
    expect(Math.abs(detected!.bpm - 120)).toBeLessThanOrEqual(0.8);
  });

  // ─── Edge cases: invalid sampleRate and pathological buffers ─────────────

  it("returns null for sampleRate = NaN", () => {
    expect(detectLoopBpm(makeClickTrack(120, 4), NaN)).toBeNull();
  });

  it("returns null for sampleRate = Infinity", () => {
    expect(detectLoopBpm(makeClickTrack(120, 4), Infinity)).toBeNull();
  });

  it("returns null for sampleRate = 0", () => {
    expect(detectLoopBpm(makeClickTrack(120, 4), 0)).toBeNull();
  });

  it("returns null for negative sampleRate", () => {
    expect(detectLoopBpm(makeClickTrack(120, 4), -44100)).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(detectLoopBpm(new Float32Array(0), SR)).toBeNull();
  });

  it("returns null for buffer with non-finite samples (poisoned input)", () => {
    const data = makeClickTrack(120, 4);
    data[100] = Number.NaN;
    data[500] = Number.POSITIVE_INFINITY;
    // Either null (rejected) or a valid reading — must NOT throw or return
    // a NaN/Infinity BPM (callers do `detected.bpm * sampleRate`).
    const detected = detectLoopBpm(data, SR);
    if (detected !== null) {
      expect(Number.isFinite(detected.bpm)).toBe(true);
      expect(Number.isFinite(detected.confidence)).toBe(true);
    }
  });

  it("returns null for sampleRate = NaN even with otherwise valid audio", () => {
    // Pin the guard order: the sampleRate check runs BEFORE the transient
    // detection so a poisoned sampleRate can't make us scan arbitrary memory.
    const data = makeClickTrack(120, 8);
    expect(detectLoopBpm(data, NaN)).toBeNull();
  });

  it("refuses a buffer shorter than 1.5× sampleRate seconds (insufficient evidence)", () => {
    // 1 second at 44100 Hz — well under the 1.5 s minimum needed for the
    // autocorrelation to find a tempo at the lower end of the range.
    expect(detectLoopBpm(makeClickTrack(120, 1), SR)).toBeNull();
  });
});

describe("fitRate", () => {
  it("slows a faster loop down and speeds a slower loop up", () => {
    // 140 BPM loop in a 124 BPM project → stretch longer (rate > 1).
    expect(fitRate(140, 124)).toBeCloseTo(1.13, 2);
    // 100 BPM loop in a 124 BPM project → squeeze shorter (rate < 1).
    expect(fitRate(100, 124)).toBeCloseTo(0.81, 2);
    // Rate semantics: effective tempo = loopBpm / rate, lands on the project
    // grid within the 2-decimal rate precision (~±1 BPM residue).
    expect(Math.abs(100 / fitRate(100, 124) - 124)).toBeLessThan(1.5);
    expect(Math.abs(140 / fitRate(140, 124) - 124)).toBeLessThan(1.5);
  });

  it("clamps into the engine stretch range and rounds to 2 decimals", () => {
    expect(fitRate(20, 124)).toBe(0.25);
    expect(fitRate(900, 60)).toBe(4);
    expect(fitRate(120, 120)).toBe(1);
    expect(Number.isInteger(fitRate(100, 124) * 100)).toBe(true);
  });

  // ─── Edge cases: divide-by-zero, non-finite BPM, negative loop tempo ──────

  it("returns 1.0 when both BPMs are equal (identity stretch)", () => {
    expect(fitRate(120, 120)).toBe(1);
    expect(fitRate(60, 60)).toBe(1);
  });

  it("clamps to the upper stretch ceiling (rate = 4×)", () => {
    expect(fitRate(240, 60)).toBe(4);
    expect(fitRate(900, 60)).toBe(4);
    expect(fitRate(100000, 1)).toBe(4);
  });

  it("clamps to the lower stretch floor (rate = 0.25×)", () => {
    expect(fitRate(20, 124)).toBe(0.25);
    expect(fitRate(1, 60)).toBe(0.25);
    expect(fitRate(-50, 120)).toBe(0.25);
  });

  it("returns 1 (identity stretch) for projectBpm = 0 (avoids divide-by-zero)", () => {
    // NaN/Infinity from 0/0 would silently poison the playbackRate AudioParam
    // — a browser-side throw that takes the whole context down. The guard
    // short-circuits to 1.0 (no time-stretch, no audible surprise).
    expect(() => fitRate(120, 0)).not.toThrow();
    expect(fitRate(120, 0)).toBe(1);
    expect(fitRate(0, 0)).toBe(1);
  });

  it("returns 1 (identity stretch) for projectBpm = NaN or Infinity", () => {
    // Same rationale as divide-by-zero: don't let malformed input reach the
    // playbackRate AudioParam.
    expect(fitRate(120, NaN)).toBe(1);
    expect(fitRate(120, Infinity)).toBe(1);
    expect(fitRate(120, -Infinity)).toBe(1);
  });

  it("returns 1 (identity stretch) for non-finite loopBpm", () => {
    // The non-finite guard short-circuits before the clamp math can run, so
    // both +Infinity and -Infinity collapse to the identity-stretch default.
    // A regression that drops the guard would let NaN/Infinity leak into the
    // playbackRate AudioParam and crash the AudioContext.
    expect(fitRate(NaN, 120)).toBe(1);
    expect(fitRate(Infinity, 120)).toBe(1);
    expect(fitRate(-Infinity, 120)).toBe(1);
  });

  it("rounds intermediate results to 2 decimals (no long-floating-point residue)", () => {
    // 100/124 = 0.80645… — must round to 0.81 so playbackRate stays in spec.
    expect(fitRate(100, 124)).toBe(0.81);
    expect(fitRate(140, 124)).toBe(1.13);
    expect(fitRate(111, 120)).toBe(0.93);
  });
});
