import { describe, expect, it } from "vitest";
import { FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import { createPreferenceObservation } from "../src/intent/preference-ledger";
import {
  fitPersonalPreferenceModel,
  isPreferenceReasonRankable,
  preferenceFeatureIndicesForReason,
  rerankWithPersonalPreferences,
} from "../src/intent/personal-ranker";
import type { PreferenceContext, PreferenceObservationV1, PreferenceReason } from "../src/intent/preference-ledger";

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
  reason?: PreferenceReason,
): PreferenceObservationV1 {
  const observation = createPreferenceObservation(
    context,
    { contentHash: aHash, features: a },
    { contentHash: bHash, features: b },
    choice,
    { createdAt: at, ...(reason ? { reason } : {}) },
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

  it("does not count an explicit choice between feature-identical candidates as learnable evidence", () => {
    const same = vector(0.5);
    const observations = [pair("a", vector(0.9), "b", vector(0.1), "a", 1), pair("c", same, "d", same, "a", 2)];
    expect(fitPersonalPreferenceModel(observations, context)).toBeNull();
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
    expect(replay.map((candidate) => candidate.candidateIndex)).toEqual(
      first.map((candidate) => candidate.candidateIndex),
    );
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

  it("trains reason-tagged choices only on that reason's measured feature dimensions", () => {
    const grooveIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    const melodyIndex = FEATURE_NAMES.indexOf("melodic.noteDensity");
    const preferred = vector(0.5);
    const rejected = vector(0.5);
    preferred[grooveIndex] = 0.9;
    rejected[grooveIndex] = 0.1;
    // Deliberately point an unrelated melodic dimension in the opposite direction.
    preferred[melodyIndex] = 0.1;
    rejected[melodyIndex] = 0.9;
    const observations = [
      pair("a", preferred, "b", rejected, "a", 1, "groove"),
      pair("c", preferred, "d", rejected, "a", 2, "groove"),
    ];
    const model = fitPersonalPreferenceModel(observations, context, "groove");

    expect(model).not.toBeNull();
    expect(model?.reason).toBe("groove");
    expect(model?.weights[grooveIndex]).toBeGreaterThan(0);
    expect(model?.weights[melodyIndex]).toBe(0);
    // A labeled comparison must not silently become a whole-pattern vote.
    expect(fitPersonalPreferenceModel(observations, context)).toBeNull();
    expect(fitPersonalPreferenceModel(observations, context, "melody")).toBeNull();
  });

  it("uses a reason adapter to reorder candidates while preserving global bounds", () => {
    const grooveIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    const preferred = vector(0.5);
    const rejected = vector(0.5);
    preferred[grooveIndex] = 0.9;
    rejected[grooveIndex] = 0.1;
    const observations = [
      pair("a", preferred, "b", rejected, "a", 1, "groove"),
      pair("c", preferred, "d", rejected, "a", 2, "groove"),
    ];
    const candidates = [
      { candidateIndex: 0, contentHash: "fresh-rejected" },
      { candidateIndex: 1, contentHash: "fresh-preferred" },
    ];
    const features = new Map([
      ["fresh-rejected", rejected],
      ["fresh-preferred", preferred],
    ]);
    const order = rerankWithPersonalPreferences(candidates, [0.5, 0.5], features, observations, context);

    expect(order.map((candidate) => candidate.contentHash)).toEqual(["fresh-preferred", "fresh-rejected"]);
    expect(order).toHaveLength(candidates.length);
  });

  it("does not claim to learn reasons absent from the current feature contract", () => {
    const high = vector(0.9);
    const low = vector(0.1);
    const observations = [pair("a", high, "b", low, "a", 1, "bass"), pair("c", high, "d", low, "a", 2, "bass")];
    const candidates = [
      { candidateIndex: 0, contentHash: "first" },
      { candidateIndex: 1, contentHash: "second" },
    ];
    const features = new Map([
      ["first", high],
      ["second", low],
    ]);

    expect(isPreferenceReasonRankable("bass")).toBe(false);
    expect(preferenceFeatureIndicesForReason("harmony")).toBeNull();
    expect(fitPersonalPreferenceModel(observations, context, "bass")).toBeNull();
    expect(rerankWithPersonalPreferences(candidates, [0.4, 0.6], features, observations, context)).toEqual(candidates);
  });

  it("caps the combined reason adapters so they cannot overturn a strong global lead", () => {
    const reasons: PreferenceReason[] = ["groove", "drums", "melody", "space", "energy", "novelty"];
    const preferred = vector(1);
    const rejected = vector(0);
    const observations = reasons.flatMap((reason) => [
      pair(`a-${reason}`, preferred, `b-${reason}`, rejected, "a", 1, reason),
      pair(`c-${reason}`, preferred, `d-${reason}`, rejected, "a", 2, reason),
    ]);
    const candidates = [
      { candidateIndex: 0, contentHash: "personal-favorite" },
      { candidateIndex: 1, contentHash: "global-leader" },
    ];
    const features = new Map([
      ["personal-favorite", preferred],
      ["global-leader", rejected],
    ]);

    const order = rerankWithPersonalPreferences(candidates, [0.39, 0.61], features, observations, context);
    expect(order[0].contentHash).toBe("global-leader");
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
