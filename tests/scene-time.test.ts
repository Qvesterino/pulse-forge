import { describe, expect, it } from "vitest";
import { effectiveSceneBpm, sceneBarsToSeconds, sceneSecondsToBars } from "../src/project-model/scene-time";
import { ticksPerBarFor } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";

/**
 * The scene-time helpers take the document's BAR LENGTH IN TICKS (ADR 0056),
 * not a fixed 4/4 bar. A helper that assumed four quarter notes per bar
 * silently measured a 6/8 document in the wrong unit — every "32 second scene"
 * was 1/3 too long, and the authored bar count did not match the audible one.
 *
 * These specs pin the unit explicitly: the 4/4 cases pass the 4/4 bar length,
 * and the 6/8 case proves the helper actually honours the meter it is given.
 */
const FOUR_FOUR = ticksPerBarFor({ numerator: 4, denominator: 4 }); // 1920
const SIX_EIGHT = ticksPerBarFor({ numerator: 6, denominator: 8 }); // 1440 (three quarter notes)

describe("scene-time (wall-clock authoring helpers)", () => {
  it("converts bars to seconds at the given tempo", () => {
    // 1 bar of 4/4 at 120 BPM = 2 s; at 240 BPM = 1 s.
    expect(sceneBarsToSeconds(1, 120, FOUR_FOUR)).toBe(2);
    expect(sceneBarsToSeconds(4, 240, FOUR_FOUR)).toBe(4);
    expect(sceneBarsToSeconds(16, 120, FOUR_FOUR)).toBe(32);
  });

  it("converts seconds to bars (the SCENE SECS authoring direction)", () => {
    // 30 s at 120 BPM = 15 bars; 32 s at 124 = 16.53… bars (fractional, the
    // caller rounds to whole bars).
    expect(sceneSecondsToBars(30, 120, FOUR_FOUR)).toBe(15);
    expect(sceneSecondsToBars(32, 124, FOUR_FOUR)).toBeCloseTo(16.533, 3);
  });

  it("round-trips bars → seconds → bars", () => {
    for (const bpm of [80, 120, 124, 174, 240]) {
      for (const bars of [1, 4, 15, 32]) {
        expect(sceneSecondsToBars(sceneBarsToSeconds(bars, bpm, FOUR_FOUR), bpm, FOUR_FOUR)).toBeCloseTo(bars, 9);
      }
    }
  });

  it("measures a 6/8 document in 6/8 bars, not 4/4 bars (ADR 0056)", () => {
    // A 6/8 bar is three quarter notes: 1.5 s at 120 BPM, half of a 4/4 bar.
    expect(sceneBarsToSeconds(1, 120, SIX_EIGHT)).toBe(1.5);
    expect(sceneBarsToSeconds(16, 120, SIX_EIGHT)).toBe(24);
    // 30 s of 6/8 music is 20 bars, not the 15 a 4/4 reading would give.
    expect(sceneSecondsToBars(30, 120, SIX_EIGHT)).toBe(20);
    // Same seconds, different meter → different bar count. This is the whole
    // point of the bar unit being a parameter instead of a constant.
    expect(sceneSecondsToBars(30, 120, FOUR_FOUR)).toBe(15);
    expect(sceneSecondsToBars(30, 120, SIX_EIGHT)).not.toBe(sceneSecondsToBars(30, 120, FOUR_FOUR));
  });

  it("keeps the 4/4 bar length equal to the legacy constant", () => {
    // The migration must not silently change 4/4 documents.
    expect(FOUR_FOUR).toBe(BAR_TICKS);
  });

  it("effective tempo prefers the scene pin and falls back to the project tempo", () => {
    expect(effectiveSceneBpm(160, 120)).toBe(160);
    expect(effectiveSceneBpm(undefined, 120)).toBe(120);
    // Hostile values fall back too — a NaN pin must not poison the math.
    expect(effectiveSceneBpm(Number.NaN, 120)).toBe(120);
    expect(effectiveSceneBpm(0, 120)).toBe(120);
  });
});
