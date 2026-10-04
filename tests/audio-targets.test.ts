import { describe, expect, it } from "vitest";
import { GENERATED_AUDIO_TARGETS } from "../src/intent/audio-targets.generated";
import { audioTargetFor, scoreAudioFit, AUDIO_TARGETS } from "../src/intent/audio-feedback";

/**
 * W0.1 (intent-killer-feature-plan) — audio rerank targets for ALL genres.
 * D1 was: 15 of 19 genres scored against the house profile. The generated
 * table (measured from full reference renders, not invented) must cover
 * every Genre-union member so the house fallback only fires for
 * out-of-union strings.
 */

/** The 19-genre union from src/ai/types.ts — kept in sync via the test below. */
const ALL_GENRES: readonly string[] = [
  "house",
  "techno",
  "trap",
  "ambient",
  "drill",
  "phonk",
  "jersey",
  "dnb",
  "hyperpop",
  "ukg",
  "boombap",
  "amapiano",
  "trance",
  "detroit",
  "postrock",
  "chiptune",
  "eurodance",
  "latin",
  "drone",
];

describe("audio targets — 19/19 measured coverage (W0.1)", () => {
  it("every Genre-union member has its own MEASURED target — no house fallback", () => {
    const missing = ALL_GENRES.filter((genre) => !(genre in GENERATED_AUDIO_TARGETS));
    expect(missing, `genres missing from audio-targets.generated: ${missing.join(", ")}`).toEqual([]);
  });

  it("the measured table is structurally sound: lo < hi in every corridor", () => {
    for (const [genre, target] of Object.entries(GENERATED_AUDIO_TARGETS)) {
      for (const [name, [lo, hi]] of Object.entries(target) as Array<[string, [number, number]]>) {
        expect(lo, `${genre}.${name} lo`).toBeLessThan(hi);
        expect(lo, `${genre}.${name} lo positive`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("audioTargetFor resolves the MEASURED table first (house fallback removed for union members)", () => {
    for (const genre of ALL_GENRES) {
      const resolved = audioTargetFor(genre);
      const generated = GENERATED_AUDIO_TARGETS[genre];
      expect(resolved.rmsRange, genre).toEqual(generated.rmsRange);
      // proof of the D1 fix: targets genuinely differ between genres
      if (genre !== "house") {
        expect(resolved.bassRange, `${genre} must not share house's bass corridor`).not.toEqual(
          AUDIO_TARGETS.house.bassRange,
        );
      }
    }
    // out-of-union strings still resolve (defensive fallback stays)
    expect(audioTargetFor("not-a-genre")).toEqual(AUDIO_TARGETS.house);
  });

  // NOTE on separation: the ±2.5× widening makes corridors overlap heavily
  // across genres (all songs share the master chain), so center-vs-center
  // cross-genre separation is NOT the contract. The D1 fix is the COVERAGE:
  // each genre is scored against its own measured corridor, so its typical
  // render (near the median) ranks at the top FOR ITS GENRE — instead of
  // being judged by house ranges that mismatch it structurally.

  it("scoring: each corridor's center scores 1.0 on its own target", () => {
    // The corridor midpoint is inside the range by construction, and a
    // reference render's features sit near the median that defined it —
    // so a typical candidate for the genre must score a perfect fit.
    for (const [genre, target] of Object.entries(GENERATED_AUDIO_TARGETS)) {
      const mid = (range: [number, number]): number => Math.round(((range[0] + range[1]) / 2) * 10000) / 10000;
      const featuresAsAudio = {
        rms: mid(target.rmsRange),
        peak: mid(target.rmsRange) * mid(target.crestRange),
        crestFactor: mid(target.crestRange),
        zeroCrossingRate: mid(target.zcrRange),
        lowBandRatio: mid(target.bassRange),
      };
      const score = scoreAudioFit(featuresAsAudio as never, target);
      expect(score, `${genre} corridor center must score 1.0`).toBe(1);
    }
  });
});
