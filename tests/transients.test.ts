import { describe, expect, it } from "vitest";
import {
  detectTransients,
  gridSlicePoints,
  snapToGrid,
  pointsToSlices,
  slicesFromOnsets,
  zeroCrossSnap,
} from "../src/audio-engine/transients";

const SR = 44100;

/** Synthetic break: decaying 60 Hz "kick" bursts at the given times over a noise floor. */
function makeBreak(timesSec: number[], durationSec = 2, floor = 0.004): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * SR));
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 8) / 8388608 - 1) * 0.5;
  };
  for (let i = 0; i < data.length; i++) data[i] = floor * rand();
  for (const t of timesSec) {
    const start = Math.floor(t * SR);
    for (let i = 0; i < 0.25 * SR; i++) {
      const idx = start + i;
      if (idx >= data.length) break;
      const env = Math.exp(-i / (0.03 * SR));
      data[idx] += 0.8 * env * Math.sin((2 * Math.PI * 60 * i) / SR);
    }
  }
  return data;
}

describe("detectTransients", () => {
  it("finds onsets of a synthetic break within ±40 ms", () => {
    const hits = [0.1, 0.6, 1.1, 1.35];
    const onsets = detectTransients(makeBreak(hits), SR);
    expect(onsets.length).toBeGreaterThanOrEqual(hits.length - 1);
    for (const hit of hits.slice(0, 3)) {
      // At least one detected onset lands near each expected hit (the
      // detector back-tracks half a window ≈ 12 ms).
      expect(onsets.some((o) => Math.abs(o - hit) < 0.04)).toBe(true);
    }
  });

  it("returns no onsets for silence or noise-only input", () => {
    const silence = new Float32Array(SR * 2);
    expect(detectTransients(silence, SR)).toEqual([]);
    const noise = makeBreak([], 2, 0.01);
    expect(detectTransients(noise, SR)).toEqual([]);
  });

  it("yields exactly one marker for a single hit (re-armed decay)", () => {
    const onsets = detectTransients(makeBreak([0.5]), SR);
    expect(onsets.length).toBe(1);
  });

  it("is robust to overall level (log-domain flux)", () => {
    const loud = makeBreak([0.3, 0.8]);
    const quiet = new Float32Array(loud.length);
    for (let i = 0; i < loud.length; i++) quiet[i] = loud[i] * 0.05;
    const onsetsLoud = detectTransients(loud, SR);
    const onsetsQuiet = detectTransients(quiet, SR);
    expect(onsetsQuiet.length).toBe(onsetsLoud.length);
  });
});

describe("grid + slice helpers", () => {
  it("gridSlicePoints locks to BPM divisions", () => {
    // 120 BPM, 1/16 → 8 slices per second → over 1.5 s: points at 0, 0.125, …
    const points = gridSlicePoints(120, 4, 1.5);
    expect(points[0]).toBe(0);
    expect(points[1]).toBeCloseTo(0.125, 5);
    expect(points.length).toBe(12); // 0 … 1.375
  });

  it("snapToGrid lands on grid lines and deduplicates", () => {
    // 0.05 → 0 (nearest line), 0.14 → 0.125, 0.36 → 0.375 at 120 BPM 1/16.
    const snapped = snapToGrid([0.05, 0.14, 0.36], 120, 4);
    expect(snapped).toEqual([0, 0.125, 0.375].map((v) => +v.toFixed(6)));
    expect(snapToGrid([0.11, 0.14], 120, 4)).toEqual([0.125]);
  });

  it("pointsToSlices covers the whole duration with [start, end) regions", () => {
    const slices = pointsToSlices([0, 0.25, 0.5], 1.0);
    expect(slices).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.5 },
      { start: 0.5, end: 1.0 },
    ]);
  });

  it("zeroCrossSnap lands on a crossing, falls back when silent", () => {
    const data = new Float32Array(44100);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    // 0.1 s is mid-cycle for 440 Hz — snap must move to a nearby crossing.
    const snapped = zeroCrossSnap(data, SR, 0.1);
    expect(Math.abs(snapped - 0.1)).toBeLessThan(256 / SR + 1e-9);
    const idx = Math.round(snapped * SR);
    expect(Math.abs(data[Math.max(0, idx - 1)]) + Math.abs(data[Math.min(data.length - 1, idx)])).toBeLessThan(0.2);
    expect(zeroCrossSnap(new Float32Array(44100), SR, 0.5)).toBe(0.5);
  });

  it("slicesFromOnsets leads with zero, dedupes and snaps", () => {
    const data = new Float32Array(SR);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    const slices = slicesFromOnsets([0.25, 0.25, 0.5, NaN, 99], 1.0, data, SR);
    expect(slices[0].start).toBe(0);
    expect(slices[slices.length - 1].end).toBe(1.0);
    // 0.25/0.25 deduped, NaN + out-of-range dropped → starts {0, ~0.25, ~0.5}.
    expect(slices.map((s) => s.start)).toHaveLength(3);
    for (const slice of slices) expect(slice.end).toBeGreaterThan(slice.start);
  });

  it("slicesFromOnsets works without audio (grid fallback path)", () => {
    expect(slicesFromOnsets([0.5], 1.0)).toEqual([
      { start: 0, end: 0.5 },
      { start: 0.5, end: 1.0 },
    ]);
    expect(slicesFromOnsets([], 1.0)).toEqual([{ start: 0, end: 1.0 }]);
  });
});

// ─── Edge cases: malformed inputs / extreme parameters ─────────────────────

describe("transients — malformed inputs", () => {
  it("detectTransients returns [] for sampleRate = NaN (poisoned rate)", () => {
    // A NaN sampleRate would propagate into every window size and frame
    // count, producing NaN envelopes and a NaN flux. Pin that the guard
    // catches it before any arithmetic.
    expect(detectTransients(makeBreak([0.1, 0.6, 1.1, 1.35]), NaN)).toEqual([]);
  });

  it("detectTransients returns [] for sampleRate = 0 (no window fits)", () => {
    expect(detectTransients(makeBreak([0.1, 0.6, 1.1, 1.35]), 0)).toEqual([]);
  });

  it("detectTransients returns [] for sampleRate = Infinity", () => {
    // Infinity sampleRate → 0 frames (data.length / Infinity = 0) → the
    // frames < 4 guard catches it.
    expect(detectTransients(makeBreak([0.1, 0.6, 1.1, 1.35]), Infinity)).toEqual([]);
  });

  it("detectTransients handles options.sensitivity at the boundaries", () => {
    // sensitivity = 0 makes the threshold zero — every non-zero flux
    // frame fires, which can return a huge list but must not throw.
    // sensitivity = 100 effectively disables the detector (threshold
    // higher than any realistic flux). Both are tolerated.
    const data = makeBreak([0.1, 0.6, 1.1, 1.35]);
    expect(() => detectTransients(data, SR, { sensitivity: 0 })).not.toThrow();
    const insensitive = detectTransients(data, SR, { sensitivity: 100 });
    expect(insensitive.length).toBeLessThanOrEqual(4);
  });

  it("detectTransients handles a buffer of non-finite samples without throwing", () => {
    // FFT-style windowing on a NaN sample is a NaN — the envelope goes
    // NaN and the detector returns an empty array (or a sparse list).
    // Either way, the function must not crash.
    const data = makeBreak([0.1, 0.6, 1.1, 1.35]);
    data[100] = Number.NaN;
    data[500] = Number.POSITIVE_INFINITY;
    let onsets: number[] = [];
    expect(() => {
      onsets = detectTransients(data, SR);
    }).not.toThrow();
    expect(Array.isArray(onsets)).toBe(true);
  });

  it("gridSlicePoints handles BPM = 0 without divide-by-zero", () => {
    // BPM = 0 would make `step = 60/0/divisions` = Infinity. The result
    // would be a single point at 0 (no further ticks) — must not throw.
    expect(() => gridSlicePoints(0, 4, 1.0)).not.toThrow();
    expect(gridSlicePoints(0, 4, 1.0)).toEqual([]);
  });

  it("gridSlicePoints handles BPM = NaN without throwing", () => {
    expect(() => gridSlicePoints(NaN, 4, 1.0)).not.toThrow();
  });

  it("snapToGrid handles BPM = 0 without poisoning the output with NaN", () => {
    // BPM = 0 → step = 60/0/4 = Infinity → times.map would otherwise
    // produce Math.round(0.05/Infinity)*Infinity = 0*Infinity = NaN.
    // The guard collapses the result to an empty array (no valid grid
    // line exists at "infinite step") rather than poisoning downstream
    // consumers with NaN.
    const out = snapToGrid([0.05, 0.14, 0.36], 0, 4);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("pointsToSlices handles a single-point array (one slice covering duration)", () => {
    expect(pointsToSlices([0.5], 1.0)).toEqual([{ start: 0.5, end: 1.0 }]);
  });

  it("zeroCrossSnap on silent data falls back to the input time", () => {
    // With no zero crossings the search window exhausts without a hit —
    // the function must return the original time, not Infinity or NaN.
    const silent = new Float32Array(1024);
    const out = zeroCrossSnap(silent, SR, 0.5);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBe(0.5);
  });

  it("slicesFromOnsets handles sampleRate = NaN (falls back to grid-only path)", () => {
    // NaN sampleRate would skip the zero-cross snap (the guard checks
    // Number.isFinite(sampleRate) && sampleRate > 0). The function must
    // still produce valid grid-only slices.
    const out = slicesFromOnsets([0.25, 0.5], 1.0, new Float32Array(SR), NaN);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBe(1.0);
  });
});
