import { describe, it, expect } from "vitest";
import { buildFavoriteRankerGroups } from "../src/intent/ranker-favorites";
import type { FavoritesPack } from "../src/intent/favorites-core";

/**
 * QA-1 C2 coverage — the ranker preference path (favorite = winner, three
 * same-intent siblings = alternatives, features.v1) previously had NO test:
 * only the drum/melodic converters were covered (favorites-ledger.test.ts).
 * A synthetic pack exercises the real pipeline (generate → gate → rank →
 * featurize) without training anything.
 */

function entry(seed: string) {
  return {
    savedAt: 1727000000000,
    seed,
    genre: "house",
    grooveId: "house.deep",
    energy: 0.8,
    density: 0.6,
    complexity: 0.5,
    variation: 0.3,
    padIds: [],
    padNames: [],
    rows: {},
    length: 32 as number | undefined,
    style: "deep" as string | null | undefined,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    temperature: 1.0,
    key: null as string | null | undefined,
  };
}

function pack(seeds: string[]): FavoritesPack {
  return { version: 1, exportedAt: 1727000000000, entries: seeds.map(entry) };
}

describe("buildFavoriteRankerGroups (C2 ranker preference groups)", () => {
  it("turns one favorite into a winner + 3 siblings group with features.v1", () => {
    const built = buildFavoriteRankerGroups(pack(["qa1-fav"]));
    expect(built.datasetVersion).toBe("intent-ranker-favorites.v1");
    expect(built.featureVersion).toBe("features.v1");
    expect(built.sourceEntries).toBe(1);
    expect(built.skippedEntries).toBe(0);
    expect(built.groupCount).toBe(1);
    expect(built.groups).toHaveLength(1);

    const group = built.groups[0] as Record<string, unknown>;
    expect(group.favorite).toBe(true);
    expect(typeof group.groupKey === "string" && (group.groupKey as string).startsWith("favorite:house:")).toBe(true);
    const candidates = group.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(4); // favorite + 3 rejected siblings
    const winners = candidates.filter((c) => c.favorite === true);
    expect(winners).toHaveLength(1);
    expect(candidates[group.winnerIndex as number]).toBe(winners[0]);
    expect(winners[0].seed).toBe("qa1-fav");
    expect(winners[0].heuristicScore).toBe(1); // preference label replaces the score
    for (const candidate of candidates) {
      expect((candidate.features as number[]).length).toBe(54); // features.v1 contract
    }
  });

  it("an empty pack builds zero groups (the CLI guard path)", () => {
    const built = buildFavoriteRankerGroups(pack([]));
    expect(built.groups).toHaveLength(0);
    expect(built.groupCount).toBe(0);
  });

  it("is deterministic for the same pack", () => {
    const a = buildFavoriteRankerGroups(pack(["qa1-fav"]));
    const b = buildFavoriteRankerGroups(pack(["qa1-fav"]));
    expect(a).toEqual(b);
  });
});
