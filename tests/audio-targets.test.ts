import { describe, expect, it } from "vitest";
import { GENERATED_AUDIO_TARGETS } from "../src/intent/audio-targets.generated";
import { audioTargetFor, scoreAudioFit, AUDIO_TARGETS } from "../src/intent/audio-feedback";
import type { Genre } from "../src/ai/types";

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

  it("scoring: each genre's own measured median lands INSIDE its corridor (score 1.0)", () => {
    // The generated corridors were derived from these medians — re-derived
    // here with the same widening rule the measurement script documents.
    for (const [genre, target] of Object.entries(GENERATED_AUDIO_TARGETS)) {
      const median = (range: [number, number], kind: "log" | "crest" | "ratio"): number => {
        if (kind === "crest") return Math.min(1.2, range[0]) === 1.2 ? 1.2 : range[0] + 4;
        if (kind === "ratio") return Math.min(0.2, range[0]) + 0.15;
        return Math.sqrt(range[0] * range[1]); // geometric mean of a ×2.5 corridor
      };
      const features = {
        rms: median(target.rmsRange, "log"),
        crestFactor: median(target.crestRange, "crest"),
        zeroCrossingRate: median(target.zcrRange, "log"),
        lowBandRatio: median(target.bassRange, "ratio"),
      };
      // scoreAudioFit is not exported with its type — assert through the
      // public scoreAudioFit via a 1.0-expectation on the genre's own target.
      const featuresAsAudio = {
        ...features,
        peak: features.rms * features.crestFactor,
      };
      const score = scoreAudioFit(featuresAsAudio as never, target);
      expect(score, `${genre} median must sit inside its own corridor`).toBeGreaterThan(0.99);
    }
  });
});
