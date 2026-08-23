import { describe, expect, it } from "vitest";
import { detectTransients, gridSlicePoints, snapToGrid, pointsToSlices } from "../src/audio-engine/transients";

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
});
