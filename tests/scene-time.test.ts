import { describe, expect, it } from "vitest";
import { effectiveSceneBpm, sceneBarsToSeconds, sceneSecondsToBars } from "../src/project-model/scene-time";

describe("scene-time (wall-clock authoring helpers)", () => {
  it("converts bars to seconds at the given tempo", () => {
    // 1 bar of 4/4 at 120 BPM = 2 s; at 240 BPM = 1 s.
    expect(sceneBarsToSeconds(1, 120)).toBe(2);
    expect(sceneBarsToSeconds(4, 240)).toBe(4);
    expect(sceneBarsToSeconds(16, 120)).toBe(32);
  });

  it("converts seconds to bars (the SCENE SECS authoring direction)", () => {
    // 30 s at 120 BPM = 15 bars; 32 s at 124 = 16.53… bars (fractional, the
    // caller rounds to whole bars).
    expect(sceneSecondsToBars(30, 120)).toBe(15);
    expect(sceneSecondsToBars(32, 124)).toBeCloseTo(16.533, 3);
  });

  it("round-trips bars → seconds → bars", () => {
    for (const bpm of [80, 120, 124, 174, 240]) {
      for (const bars of [1, 4, 15, 32]) {
        expect(sceneSecondsToBars(sceneBarsToSeconds(bars, bpm), bpm)).toBeCloseTo(bars, 9);
      }
    }
  });

  it("effective tempo prefers the scene pin and falls back to the project tempo", () => {
    expect(effectiveSceneBpm(160, 120)).toBe(160);
    expect(effectiveSceneBpm(undefined, 120)).toBe(120);
    // Hostile values fall back too — a NaN pin must not poison the math.
    expect(effectiveSceneBpm(Number.NaN, 120)).toBe(120);
    expect(effectiveSceneBpm(0, 120)).toBe(120);
  });
});
