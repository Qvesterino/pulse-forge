import { describe, expect, it } from "vitest";
import { validateGoldenPreferences } from "../scripts/validate-intent-ranker-golden.mjs";

const group = {
  groupKey: "house:deep:seed-01",
  candidates: [{ index: 0 }, { index: 1 }, { index: 2 }],
};

function golden(order: number[]) {
  return {
    reviewed: true,
    reviewedBy: "test reviewer",
    reviewedAt: "2026-09-20",
    combos: [{ combo: "house:deep", groupKey: group.groupKey, order }],
  };
}

describe("intent ranker golden preference gate", () => {
  it("accepts a complete order tied to one exact dataset group", () => {
    expect(validateGoldenPreferences(golden([2, 0, 1]), [group])).toMatchObject({
      errors: [],
      matchedGroups: 1,
      matchedCandidates: 3,
    });
  });

  it("rejects missing exact group keys instead of applying one ranking to other seeds", () => {
    const preferences = golden([2, 0, 1]);
    delete (preferences.combos[0] as { groupKey?: string }).groupKey;
    const result = validateGoldenPreferences(preferences, [group]);
    expect(result.matchedCandidates).toBe(0);
    expect(result.errors.join(" ")).toMatch(/missing exact groupKey/i);
  });

  it.each([
    [[2, 2, 1], /every candidate index exactly once/i],
    [[0, 1], /every candidate index exactly once/i],
    [[0, 1, 3], /every candidate index exactly once/i],
  ])("rejects duplicate, missing, or unknown candidate indices", (order, expectedError) => {
    const result = validateGoldenPreferences(golden(order as number[]), [group]);
    expect(result.errors.join(" ")).toMatch(expectedError as RegExp);
  });

  it("rejects a reviewed preference set that maps to no current dataset group", () => {
    const result = validateGoldenPreferences(golden([2, 0, 1]), [{ ...group, groupKey: "house:deep:other" }]);
    expect(result.matchedCandidates).toBe(0);
    expect(result.errors.join(" ")).toMatch(/does not exist in the current dataset/i);
  });
});
