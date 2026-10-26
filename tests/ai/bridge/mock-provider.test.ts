import { describe, expect, it } from "vitest";
import { generateBatch } from "../../../src/ai/bridge/mockProvider";
import { findRecipe, getRecipe, RECIPES } from "../../../src/ai/bridge/recipes";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { testDoc } from "../../fixtures/doc";

/**
 * V-3 — the mock provider (recipe registry → command batch) gets its own
 * suite. The provider is the AI layer's PROMPT CONTRACT: the reason codes
 * here are surfaced verbatim in the AI chat panel, the first-match rule
 * decides which recipe a sentence means, and the determinism contract
 * ("same project + same prefs → identical batch", stated in every recipe's
 * header) is the bridge's whole point — none of it was pinned before.
 */

describe("generateBatch reason contract", () => {
  it("an empty prompt declines with empty-prompt", () => {
    const result = generateBatch("", { doc: testDoc(), userPreferences: EMPTY_PREFERENCES });
    expect(result.ok).toBe(false);
    expect(result.batch).toBeNull();
    expect(result.reason).toBe("empty-prompt");
  });

  it("a prompt no recipe claims declines with no-recipe-match", () => {
    const result = generateBatch("make me a sandwich", { doc: testDoc(), userPreferences: EMPTY_PREFERENCES });
    expect(result.ok).toBe(false);
    expect(result.batch).toBeNull();
    expect(result.reason).toBe("no-recipe-match");
  });

  it("a matched recipe whose build yields nothing declines with recipe-applied-no-commands", () => {
    // testDoc() has no tracks named snare/hat — the snares-vs-hates guard
    // finds neither side and returns zero commands. The provider reports
    // this EARLY (before the executor's no-track-match) so the UI can say
    // "I don't see a hi-hat here".
    const result = generateBatch("snares vs hates", { doc: testDoc(), userPreferences: EMPTY_PREFERENCES });
    expect(result.ok).toBe(false);
    expect(result.batch).toBeNull();
    expect(result.reason).toBe("recipe-applied-no-commands");
  });

  it("a match returns a batch with a recipe id, a label, a rationale and an impact estimate", () => {
    const doc = testDoc();
    const result = generateBatch("make the drums punchier", { doc, userPreferences: EMPTY_PREFERENCES });
    expect(result.ok).toBe(true);
    const batch = result.batch!;
    expect(batch.recipeId).toBe("punchier-drums");
    expect(batch.commands.length).toBeGreaterThan(0);
    expect(batch.label).toContain("punchier-drums");
    expect(batch.rationale.length).toBeGreaterThan(0);
    expect(Number.isFinite(batch.estimatedImpact.peakDeltaDb)).toBe(true);
    expect(Number.isFinite(batch.estimatedImpact.rmsDeltaDb)).toBe(true);
  });
});

describe("findRecipe matching", () => {
  it("matches case-insensitively and through DAW slang", () => {
    expect(findRecipe("SNARES VS HATES")?.id).toBe("snares-vs-hates");
    expect(findRecipe("the snare and the hat clash")?.id).toBe("snares-vs-hates");
    expect(findRecipe("hat masking the snare")?.id).toBe("snares-vs-hates");
  });

  it("the registry order decides: the first recipe whose pattern matches wins", () => {
    for (let i = 1; i < RECIPES.length; i++) {
      for (const pattern of RECIPES[i]!.intentPatterns) {
        // No earlier recipe may also claim this sentence — otherwise the
        // first-match rule silently re-routes it.
        for (const earlier of RECIPES.slice(0, i)) {
          const claimed = earlier.intentPatterns.some((p) => new RegExp(p, "i").test(pattern));
          expect(claimed, `recipe "${RECIPES[i]!.id}" pattern "${pattern}" is shadowed by "${earlier.id}"`).toBe(false);
        }
      }
    }
  });

  it("getRecipe resolves every registered id and refuses unknown ones", () => {
    for (const recipe of RECIPES) {
      expect(getRecipe(recipe.id)?.id).toBe(recipe.id);
    }
    expect(getRecipe("no-such-recipe")).toBeNull();
  });
});

describe("the determinism contract", () => {
  it("the same prompt and input produce an identical batch, twice", () => {
    const doc = testDoc();
    const a = generateBatch("make the drums punchier", { doc, userPreferences: EMPTY_PREFERENCES });
    const b = generateBatch("make the drums punchier", { doc, userPreferences: EMPTY_PREFERENCES });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(JSON.stringify(b.batch)).toBe(JSON.stringify(a.batch));
  });
});
