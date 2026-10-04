import { describe, it, expect } from "vitest";
import {
  MELODIC_FEATURES_VERSION_V3,
  MELODIC_V3_FEATURE_COUNT,
  buildMelodicFeatureRowV3,
  chordAtStep,
  type MelodicFeatureInputV3,
} from "../src/ai/symbolic/melodic-features-v3";
import { expandProgression } from "../src/ai/harmony";

/**
 * W1 — melodic-features v3 contract tests. The harmony-aware feature row
 * must be a fixed-order superset of v1 with chord context, resolution
 * targeting, syncopation-in-chord and motif memory. Deterministic (pure).
 */

const BASE: MelodicFeatureInputV3 = {
  genre: "techno",
  role: "bass",
  startStep: 0,
  prevDegree: 0,
  prevDuration: 4,
  prevPrevDegree: 5,
  chord: { degree: 0, quality: "min", duration: 4, func: "T" },
  nextChord: { degree: 5, quality: "maj", duration: 4, func: "S" },
  stepsIntoChord: 0,
  motifId: 1,
};

describe("melodic-features-v3", () => {
  it("feature count is deterministic and > v1 count", () => {
    expect(MELODIC_V3_FEATURE_COUNT).toBeGreaterThan(65); // v1 base 41 + ~24 new
    expect(MELODIC_FEATURES_VERSION_V3).toBe("melodic-features.v3");
  });

  it("buildMelodicFeatureRowV3 returns a row of exactly MELODIC_V3_FEATURE_COUNT values", () => {
    const row = buildMelodicFeatureRowV3(BASE);
    expect(row.length).toBe(MELODIC_V3_FEATURE_COUNT);
    expect(row.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("is deterministic: same input → same row", () => {
    const a = buildMelodicFeatureRowV3(BASE);
    const b = buildMelodicFeatureRowV3(BASE);
    expect(a).toEqual(b);
  });

  it("different chord → different chord-context features (but same v1 base)", () => {
    const chordMin = buildMelodicFeatureRowV3(BASE);
    const chordMaj = buildMelodicFeatureRowV3({ ...BASE, chord: { ...BASE.chord, quality: "maj" } });
    // the chord quality section (offset ~54-62) must differ
    const v3Start = 4 + 3 + 3 + 8 + 4 + 5; // after v1 base
    const minSlice = chordMin.slice(v3Start, v3Start + 20);
    const majSlice = chordMaj.slice(v3Start, v3Start + 20);
    expect(minSlice).not.toEqual(majSlice);
  });

  it("chordAtStep maps steps to the correct chord in the expanded progression", () => {
    const progression = {
      name: "test",
      genre: "techno",
      events: [
        { degree: 0, quality: "min" as const, duration: 4, func: "T" as const },
        { degree: 5, quality: "maj" as const, duration: 4, func: "S" as const },
      ],
    };
    const expanded = expandProgression(progression, 16);
    // step 0: chord 0 (degree 0, stepsIntoChord 0)
    const at0 = chordAtStep(expanded, 0);
    expect(at0.chord.degree).toBe(0);
    expect(at0.stepsIntoChord).toBe(0);
    // step 3: still chord 0 (stepsIntoChord 3)
    const at3 = chordAtStep(expanded, 3);
    expect(at3.chord.degree).toBe(0);
    expect(at3.stepsIntoChord).toBe(3);
    // step 4: chord 1 (degree 5)
    const at4 = chordAtStep(expanded, 4);
    expect(at4.chord.degree).toBe(5);
    expect(at4.stepsIntoChord).toBe(0);
    // step 12: chord 1 (degree 5) from the second loop
    const at12 = chordAtStep(expanded, 12);
    expect(at12.chord.degree).toBe(5);
    expect(at12.stepsIntoChord).toBe(0);
  });

  it("motif embedding is deterministic: same motifId → same values, different id → different", () => {
    const m1 = buildMelodicFeatureRowV3({ ...BASE, motifId: 1 });
    const m1b = buildMelodicFeatureRowV3({ ...BASE, motifId: 1 });
    const m2 = buildMelodicFeatureRowV3({ ...BASE, motifId: 2 });
    const tail = MELODIC_V3_FEATURE_COUNT - 8;
    expect(m1.slice(tail)).toEqual(m1b.slice(tail));
    expect(m1.slice(tail)).not.toEqual(m2.slice(tail));
  });

  it("chord boundary: stepsIntoChord=0 means chord start (sin(0)=0, cos(0)=1)", () => {
    const row = buildMelodicFeatureRowV3({ ...BASE, stepsIntoChord: 0 });
    const fracOffset = MELODIC_V3_FEATURE_COUNT - 8 - 3;
    expect(row[fracOffset]).toBeCloseTo(0, 5); // frac = 0
    expect(row[fracOffset + 1]).toBeCloseTo(0, 5); // sin(0)
    expect(row[fracOffset + 2]).toBeCloseTo(1, 5); // cos(0)
  });
});
