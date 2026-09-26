import { describe, expect, it } from "vitest";
import { FEATURE_COUNT } from "../src/ai/features/pattern-features";
import { createPreferenceObservation } from "../src/intent/preference-ledger";
import { fitPersonalPreferenceModel, rerankWithPersonalPreferences } from "../src/intent/personal-ranker";
import type { PreferenceContext, PreferenceObservationV1 } from "../src/intent/preference-ledger";

const context: PreferenceContext = {
  genre: "trap",
  productionProfile: null,
  task: "pattern",
  roleScope: ["drums", "lead"],
  key: "1234abcd",
};

function vector(value: number): number[] {
  return new Array(FEATURE_COUNT).fill(value);
}

function pair(
  aHash: string,
  a: number[],
  bHash: string,
  b: number[],
  choice: "a" | "b" | "neither" | "both" = "a",
  at = 1,
): PreferenceObservationV1 {
  const observation = createPreferenceObservation(
    context,
    { contentHash: aHash, features: a },
    { contentHash: bHash, features: b },
    choice,
    { createdAt: at },
  );
  if (!observation) throw new Error("test observation invalid");
  return observation;
}

describe("personal pairwise selector", () => {
  it("uses global ordering until it has at least two explicit, relevant comparisons", () => {
    const high = vector(0.9);
    const low = vector(0.1);
    const single = [pair("a", high, "b", low)];
    const candidates = [
      { candidateIndex: 0, contentHash: "fresh-high" },
      { candidateIndex: 1, contentHash: "fresh-low" },
    ];
    const features = new Map([
      ["fresh-high", high],
      ["fresh-low", low],
    ]);
    expect(fitPersonalPreferenceModel(single, context)).toBeNull();
    expect(rerankWithPersonalPreferences(candidates, [0.5, 0.6], features, single, context)).toEqual(candidates);
  });

  it("learns deterministic direction from A/B choices and only reorders supplied valid candidates", () => {
    const high = vector(0.9);
    const low = vector(0.1);
    const observations = [pair("a", high, "b", low, "a", 1), pair("c", high, "d", low, "a", 2)];
    const candidates = [
      { candidateIndex: 4, contentHash: "fresh-high" },
      { candidateIndex: 2, contentHash: "fresh-low" },
    ];
    const features = new Map([
      ["fresh-high", high],
      ["fresh-low", low],
    ]);
    const first = rerankWithPersonalPreferences(candidates, [0.5, 0.505], features, observations, context);
    const replay = rerankWithPersonalPreferences(candidates, [0.5, 0.505], features, observations, context);
    expect(first.map((candidate) => candidate.contentHash)).toEqual(["fresh-high", "fresh-low"]);
    expect(replay.map((candidate) => candidate.candidateIndex)).toEqual(first.map((candidate) => candidate.candidateIndex));
    expect(first).toHaveLength(candidates.length);
  });

  it("does not learn from neither/both or unrelated genres", () => {
    const high = vector(0.9);
    const low = vector(0.1);
    const ties = [pair("a", high, "b", low, "neither"), pair("c", high, "d", low, "both", 2)];
    expect(fitPersonalPreferenceModel(ties, context)).toBeNull();

    const otherGenre = { ...context, genre: "house", key: "deadbeef" };
    const choices = [pair("e", high, "f", low, "a"), pair("g", high, "h", low, "a", 2)];
    expect(fitPersonalPreferenceModel(choices, otherGenre)).toBeNull();
  });

  it("keeps the residual bounded instead of overpowering a strong global lead", () => {
    const high = vector(1);
    const low = vector(0);
    const observations = [pair("a", high, "b", low), pair("c", high, "d", low, "a", 2)];
    const candidates = [
      { candidateIndex: 0, contentHash: "preferred" },
      { candidateIndex: 1, contentHash: "other" },
    ];
    const features = new Map([
      ["preferred", high],
      ["other", low],
    ]);
    const order = rerankWithPersonalPreferences(candidates, [0.1, 0.9], features, observations, context);
    expect(order[0].contentHash).toBe("other");
  });
});
