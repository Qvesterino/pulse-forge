import { describe, expect, it } from "vitest";
import {
  personalStyleDescription,
  personalStyleIntentSuggestions,
  personalStyleProfile,
  personalStyleProfileFromExamples,
  personalStyleProfilesFromExamples,
} from "../src/intent/personal-style";
import { recordStyleExample, setPreferredStyleGenre, type StyleExampleV1 } from "../src/intent/style-example-ledger";

/**
 * LEARN LOCAL PRODUCER STYLE FROM EDITS — the profile half.
 *
 * Distills the example ledger into a per-genre slider profile + prompt ideas.
 * Pinned here: recency weighting, the "3 examples before suggesting" floor, and
 * the fact that the profile only ever sees valid, genre-matching examples.
 */

function example(overrides: Partial<StyleExampleV1> = {}): StyleExampleV1 {
  return {
    version: 1,
    contentHash: "abcdef01",
    savedAt: 1000,
    genre: "techno",
    grooveId: "techno.rolling",
    energy: 0.8,
    density: 0.6,
    complexity: 0.4,
    variation: 0.5,
    ...overrides,
  };
}

describe("personal style profile", () => {
  it("returns null without examples or for an unknown genre", () => {
    expect(personalStyleProfileFromExamples([], "techno")).toBeNull();
    expect(personalStyleProfileFromExamples([example()], "polka")).toBeNull();
  });

  it("averages the matching genre's examples only", () => {
    const profile = personalStyleProfileFromExamples(
      [
        example({ energy: 0.8, savedAt: 1000 }),
        example({ energy: 0.4, savedAt: 1000, contentHash: "abcdef02" }),
        example({ genre: "house", energy: 0.1, contentHash: "abcdef03" }),
      ],
      "techno",
    )!;
    expect(profile.exampleCount).toBe(2);
    // Equal timestamps ⇒ equal weight ⇒ plain mean of the two techno examples.
    expect(profile.energy).toBeCloseTo(0.6, 4);
  });

  it("weights recent examples more heavily (recency half-life)", () => {
    const day = 24 * 60 * 60 * 1000;
    const profile = personalStyleProfileFromExamples(
      [
        example({ energy: 0.9, savedAt: day * 400, contentHash: "abcdef0a" }),
        example({ energy: 0.1, savedAt: 0, contentHash: "abcdef0b" }),
      ],
      "techno",
    )!;
    // The recent example dominates, so the mean sits well above the midpoint.
    expect(profile.energy).toBeGreaterThan(0.5);
  });

  it("confidence ramps to 1 at the minimum example count", () => {
    const one = personalStyleProfileFromExamples([example()], "techno")!;
    expect(one.confidence).toBeLessThan(1);
    const three = personalStyleProfileFromExamples(
      [
        example({ contentHash: "11111111" }),
        example({ contentHash: "22222222" }),
        example({ contentHash: "33333333" }),
      ],
      "techno",
    )!;
    expect(three.confidence).toBe(1);
  });

  it("builds one profile per genre present, sorted by genre", () => {
    const profiles = personalStyleProfilesFromExamples([
      example({ genre: "techno" }),
      example({ genre: "house", contentHash: "44444444" }),
      example({ genre: "techno", contentHash: "55555555" }),
    ]);
    expect(profiles.map((profile) => profile.genre)).toEqual(["house", "techno"]);
    expect(profiles.find((profile) => profile.genre === "techno")!.exampleCount).toBe(2);
  });

  it("reads the live ledger via personalStyleProfile (preferred genre wins)", () => {
    localStorage.clear();
    recordStyleExample(example({ genre: "techno" }));
    recordStyleExample(example({ genre: "house", contentHash: "44444444" }));
    setPreferredStyleGenre("house");
    expect(personalStyleProfile()!.genre).toBe("house");
    expect(personalStyleProfile("techno")!.genre).toBe("techno");
  });
});

describe("personal style suggestions", () => {
  it("offers nothing below the 3-example floor", () => {
    const profile = personalStyleProfileFromExamples([example(), example({ contentHash: "b" })], "techno");
    expect(personalStyleIntentSuggestions(profile)).toEqual([]);
  });

  it("offers three concrete prompt ideas once the floor is met", () => {
    const profile = personalStyleProfileFromExamples(
      [
        example({ energy: 0.85, density: 0.7, contentHash: "aaaaaaa1" }),
        example({ energy: 0.8, density: 0.65, contentHash: "bbbbbbb2" }),
        example({ energy: 0.9, density: 0.75, contentHash: "ccccccc3" }),
      ],
      "techno",
    );
    const suggestions = personalStyleIntentSuggestions(profile);
    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((s) => s.id)).toEqual(["signature", "more-driving", "more-space"]);
    // Every prompt is runnable text anchored in the learned genre.
    for (const suggestion of suggestions) {
      expect(suggestion.prompt).toContain("techno");
      expect(suggestion.label.length).toBeGreaterThan(0);
    }
  });

  it("describes the profile in the same vocabulary the prompts use", () => {
    const energetic = personalStyleProfileFromExamples(
      [example({ energy: 0.9, density: 0.8, complexity: 0.7, variation: 0.7 })],
      "techno",
    )!;
    const description = personalStyleDescription(energetic);
    expect(description).toMatch(/energick/);
    expect(description).toMatch(/hust/);
  });
});
