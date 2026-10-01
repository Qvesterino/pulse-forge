import { describe, expect, it } from "vitest";
import { levelMatchGainsDb, MAX_LEVEL_MATCH_GAIN_DB } from "../src/analysis/levelMatch";

/** Quality roadmap P4 — LUFS level matching must be symmetric, clamped and
 * honest about unmeasurable sides (the page then plays native levels). */
describe("levelMatchGainsDb", () => {
  it("lands both sides on their mean loudness with symmetric gains", () => {
    const result = levelMatchGainsDb(-18, -12);
    expect(result.matched).toBe(true);
    expect(result.targetLufs).toBeCloseTo(-15, 6);
    expect(result.gainDbA).toBeCloseTo(3, 6); // the quieter side is raised…
    expect(result.gainDbB).toBeCloseTo(-3, 6); // …the louder side attenuated
    // Applying the gains puts both at the target.
    expect(-18 + result.gainDbA).toBeCloseTo(-15, 6);
    expect(-12 + result.gainDbB).toBeCloseTo(-15, 6);
  });

  it("returns zero gains for already-matched pairs", () => {
    const result = levelMatchGainsDb(-14, -14);
    expect(result.gainDbA).toBe(0);
    expect(result.gainDbB).toBe(0);
    expect(result.note).toContain("level-matched to -14.0 LUFS");
  });

  it("degrades honestly when either side is unmeasurable", () => {
    for (const [a, b] of [
      [null, -12],
      [-12, null],
      [null, null],
    ] as const) {
      const result = levelMatchGainsDb(a, b);
      expect(result.matched).toBe(false);
      expect(result.targetLufs).toBeNull();
      expect(result.gainDbA).toBe(0);
      expect(result.gainDbB).toBe(0);
      expect(result.note).toContain("not level-matched");
    }
  });

  it("refuses non-finite loudness", () => {
    expect(levelMatchGainsDb(Number.NaN, -12).matched).toBe(false);
    expect(levelMatchGainsDb(-12, Number.POSITIVE_INFINITY).matched).toBe(false);
  });

  it("clamps extreme mismatches at ±12 dB and says so", () => {
    const result = levelMatchGainsDb(-40, -8);
    expect(result.matched).toBe(true);
    expect(result.gainDbB).toBe(-MAX_LEVEL_MATCH_GAIN_DB);
    expect(result.gainDbA).toBe(MAX_LEVEL_MATCH_GAIN_DB);
    expect(result.note).toContain("clamped");
  });

  it("is deterministic", () => {
    expect(levelMatchGainsDb(-16.3, -13.7)).toEqual(levelMatchGainsDb(-16.3, -13.7));
  });
});
