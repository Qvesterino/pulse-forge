import { beforeEach, describe, expect, it } from "vitest";
import {
  automaticStyleLearningEnabled,
  clearStyleExamples,
  countStyleExamples,
  isValidStyleExample,
  preferredStyleGenre,
  readStyleExamples,
  recordStyleExample,
  setAutomaticStyleLearningEnabled,
  setPreferredStyleGenre,
  STYLE_AUTO_LEARN_KEY,
  STYLE_EXAMPLE_LEDGER_CAP,
  STYLE_EXAMPLE_LEDGER_KEY,
  type StyleExampleV1,
} from "../src/intent/style-example-ledger";

/**
 * LEARN LOCAL PRODUCER STYLE FROM EDITS (commit 020a721d) — the ledger half.
 *
 * This is the store that turns a human's pattern edits into a compact taste
 * signal the semantic corpus and style vector consume. The tests pin the
 * properties that keep it safe:
 *   - only valid, GENRE-tagged, [0,1]-bounded summaries are accepted,
 *   - re-teaching the same content refreshes its timestamp instead of duplicating,
 *   - the ledger is capped and privacy-safe (no notes, no project payload),
 *   - the auto-learn switch is honored and defaults on.
 */

function example(overrides: Partial<StyleExampleV1> = {}): StyleExampleV1 {
  return {
    version: 1,
    contentHash: "abcdef01",
    savedAt: 1000,
    genre: "techno",
    grooveId: "techno.rolling",
    energy: 0.7,
    density: 0.5,
    complexity: 0.4,
    variation: 0.3,
    ...overrides,
  };
}

describe("style example ledger", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("accepts a valid summary and rejects malformed ones", () => {
    expect(isValidStyleExample(example())).toBe(true);
    // unknown genre
    expect(isValidStyleExample(example({ genre: "polka" }))).toBe(false);
    // out-of-range slider
    expect(isValidStyleExample(example({ energy: 1.5 }))).toBe(false);
    // non-hex content hash
    expect(isValidStyleExample(example({ contentHash: "NOT-HEX!!" }))).toBe(false);
    // wrong version
    expect(isValidStyleExample({ ...example(), version: 2 })).toBe(false);
    expect(isValidStyleExample(null)).toBe(false);
    expect(isValidStyleExample("nope")).toBe(false);
  });

  it("round-trips a valid example through localStorage", () => {
    expect(recordStyleExample(example())).toBe(true);
    const stored = readStyleExamples();
    expect(stored).toHaveLength(1);
    expect(stored[0].contentHash).toBe("abcdef01");
    expect(stored[0].genre).toBe("techno");
  });

  it("refuses to store an invalid example", () => {
    expect(recordStyleExample(example({ density: Number.NaN }))).toBe(false);
    expect(countStyleExamples()).toBe(0);
  });

  it("re-teaching the same content in the same genre refreshes, not duplicates", () => {
    recordStyleExample(example({ savedAt: 1000 }));
    recordStyleExample(example({ savedAt: 2000 }));
    const stored = readStyleExamples();
    expect(stored).toHaveLength(1);
    expect(stored[0].savedAt).toBe(2000);
  });

  it("keeps the same content hash under a DIFFERENT genre as a separate example", () => {
    recordStyleExample(example({ genre: "techno" }));
    recordStyleExample(example({ genre: "house" }));
    expect(countStyleExamples()).toBe(2);
  });

  it("caps the ledger at the documented ceiling", () => {
    for (let i = 0; i < STYLE_EXAMPLE_LEDGER_CAP + 10; i++) {
      recordStyleExample(example({ contentHash: i.toString(16).padStart(8, "0"), savedAt: i }));
    }
    expect(countStyleExamples()).toBe(STYLE_EXAMPLE_LEDGER_CAP);
  });

  it("drops corrupt rows on read instead of throwing", () => {
    localStorage.setItem(
      STYLE_EXAMPLE_LEDGER_KEY,
      JSON.stringify([example(), { junk: true }, { ...example(), energy: 9 }, example({ genre: "jersey" })]),
    );
    const stored = readStyleExamples();
    expect(stored).toHaveLength(2);
  });

  it("treats an oversized ledger blob as empty (DoS guard)", () => {
    localStorage.setItem(STYLE_EXAMPLE_LEDGER_KEY, "x".repeat(300_000));
    expect(readStyleExamples()).toEqual([]);
  });

  it("clear removes examples and the preferred genre", () => {
    recordStyleExample(example());
    setPreferredStyleGenre("techno");
    expect(clearStyleExamples()).toBe(true);
    expect(countStyleExamples()).toBe(0);
    expect(preferredStyleGenre()).toBeNull();
  });

  it("stores only a valid preferred genre", () => {
    setPreferredStyleGenre("techno");
    expect(preferredStyleGenre()).toBe("techno");
    setPreferredStyleGenre("not-a-genre");
    expect(preferredStyleGenre()).toBe("techno"); // unchanged
  });
});

describe("automatic style learning switch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults ON and can be paused + resumed", () => {
    expect(automaticStyleLearningEnabled()).toBe(true);
    expect(setAutomaticStyleLearningEnabled(false)).toBe(true);
    expect(automaticStyleLearningEnabled()).toBe(false);
    expect(localStorage.getItem(STYLE_AUTO_LEARN_KEY)).toBe("off");
    setAutomaticStyleLearningEnabled(true);
    expect(automaticStyleLearningEnabled()).toBe(true);
  });
});
