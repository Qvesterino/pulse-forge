import { beforeEach, describe, expect, it } from "vitest";
import { FEATURE_COUNT } from "../src/ai/features/pattern-features";
import { normalizeIntent } from "../src/intent/normalize";
import {
  buildPreferenceLedgerPack,
  clearPreferenceLedger,
  createPreferenceObservation,
  isPreferenceFeatureVersion,
  isPreferenceLearningEnabled,
  PREFERENCE_LEDGER_KEY,
  preferenceContextForIntent,
  readPreferenceLedger,
  recordPreferenceObservation,
  setPreferenceLearningEnabled,
  isValidPreferenceObservation,
} from "../src/intent/preference-ledger";
import type { PreferenceContext } from "../src/intent/preference-ledger";
import { FEATURE_V2_COUNT } from "../src/ai/features/pattern-features-v2";

const context: PreferenceContext = {
  genre: "trap",
  productionProfile: null,
  task: "pattern",
  roleScope: ["drums", "lead"],
  key: "1234abcd",
};

function feature(value: number): number[] {
  return new Array(FEATURE_COUNT).fill(value);
}

function observation(at = 100) {
  return createPreferenceObservation(
    context,
    { contentHash: "z-candidate", features: feature(0.9) },
    { contentHash: "a-candidate", features: feature(0.1) },
    "a",
    { createdAt: at, reason: "groove" },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("Producer DNA preference ledger", () => {
  it("canonicalizes pair order and choice while storing only versioned feature snapshots", () => {
    const saved = observation();
    expect(saved).not.toBeNull();
    expect(saved!.candidateA.contentHash).toBe("a-candidate");
    expect(saved!.choice).toBe("b");
    expect(saved!.candidateA.features).toHaveLength(FEATURE_COUNT);
    expect(JSON.stringify(saved)).not.toContain("private prompt");
    expect(JSON.stringify(saved)).not.toContain("project json");
  });

  it("stores a validated global-selector score while accepting legacy snapshots without one", () => {
    const scored = createPreferenceObservation(
      context,
      {
        contentHash: "baseline-a",
        features: feature(0.8),
        globalScore: 0.62,
        globalScoreVersion: "global-selector.v1:heuristic",
      },
      {
        contentHash: "baseline-b",
        features: feature(0.2),
        globalScore: 0.41,
        globalScoreVersion: "global-selector.v1:heuristic",
      },
      "a",
    );
    const invalid = createPreferenceObservation(
      context,
      {
        contentHash: "invalid-a",
        features: feature(0.8),
        globalScore: 1.1,
        globalScoreVersion: "global-selector.v1:heuristic",
      },
      { contentHash: "invalid-b", features: feature(0.2) },
      "a",
    );

    expect(scored?.candidateA.globalScore).toBe(0.62);
    expect(scored?.candidateA.globalScoreVersion).toBe("global-selector.v1:heuristic");
    expect(observation()?.candidateA.globalScore).toBeUndefined();
    expect(invalid).toBeNull();
  });

  it("records explicit comparisons, dedupes the same pair, and exports a versioned pack", () => {
    expect(recordPreferenceObservation(observation(100)!)).toBe(true);
    expect(recordPreferenceObservation(observation(200)!)).toBe(true);
    expect(readPreferenceLedger()).toHaveLength(1);
    expect(readPreferenceLedger()[0].createdAt).toBe(200);
    const pack = buildPreferenceLedgerPack(300);
    expect(pack.version).toBe(1);
    // W4: the pack advertises the NEWEST contract this build produces; the
    // observation itself keeps the version it was actually recorded under, so
    // a legacy pack is never re-interpreted.
    expect(pack.featureVersion).toBe("features.v2");
    expect(pack.observations[0].candidateA.featureVersion).toBe("features.v1");
    expect(pack.exportedAt).toBe(300);
    expect(pack.observations).toHaveLength(1);
  });

  it("accepts both stored preference feature contracts for offline evaluation", () => {
    expect(isPreferenceFeatureVersion("features.v1")).toBe(true);
    expect(isPreferenceFeatureVersion("features.v2")).toBe(true);
    expect(isPreferenceFeatureVersion("features.v3")).toBe(false);
    expect(isPreferenceFeatureVersion(null)).toBe(false);
  });

  it("W4 dual-read: accepts a v2 vector and keeps a v1 observation valid", () => {
    // A v2-width vector is stamped features.v2 and must survive validation.
    const v2 = createPreferenceObservation(
      context,
      { contentHash: "v2-a", features: new Array(FEATURE_V2_COUNT).fill(0.4) },
      { contentHash: "v2-b", features: new Array(FEATURE_V2_COUNT).fill(0.6) },
      "a",
    );
    expect(v2).not.toBeNull();
    expect(v2!.candidateA.featureVersion).toBe("features.v2");
    expect(isValidPreferenceObservation(v2)).toBe(true);

    // A legacy v1 observation stays valid — the contract bump must not
    // invalidate stored taste.
    const v1 = createPreferenceObservation(
      context,
      { contentHash: "v1-a", features: new Array(FEATURE_COUNT).fill(0.4) },
      { contentHash: "v1-b", features: new Array(FEATURE_COUNT).fill(0.6) },
      "a",
    );
    expect(v1).not.toBeNull();
    expect(v1!.candidateA.featureVersion).toBe("features.v1");
    expect(isValidPreferenceObservation(v1)).toBe(true);

    // A vector of the wrong width for its declared version is still rejected.
    const mismatched = { ...v2, candidateA: { ...v2!.candidateA, features: new Array(FEATURE_COUNT).fill(0.4) } };
    expect(isValidPreferenceObservation(mismatched)).toBe(false);
  });

  it("pauses writes without discarding previous choices and clears the local ledger", () => {
    expect(isPreferenceLearningEnabled()).toBe(true);
    setPreferenceLearningEnabled(false);
    expect(isPreferenceLearningEnabled()).toBe(false);
    expect(recordPreferenceObservation(observation()!)).toBe(false);
    expect(readPreferenceLedger()).toEqual([]);

    setPreferenceLearningEnabled(true);
    expect(recordPreferenceObservation(observation()!)).toBe(true);
    clearPreferenceLedger();
    expect(readPreferenceLedger()).toEqual([]);
    expect(localStorage.getItem(PREFERENCE_LEDGER_KEY)).toBeNull();
  });

  it("fails closed on malformed storage and rejects malformed feature data", () => {
    localStorage.setItem(PREFERENCE_LEDGER_KEY, "{");
    expect(readPreferenceLedger()).toEqual([]);
    const invalid = createPreferenceObservation(
      context,
      { contentHash: "a", features: [Number.NaN] },
      { contentHash: "b", features: feature(0.5) },
      "a",
    );
    expect(invalid).toBeNull();
  });

  it("builds a coarse context without persisting prompt text or the random seed", () => {
    const intent = normalizeIntent({
      genre: "trap",
      text: "private prompt that must not persist",
      seed: "session-specific-seed",
      roles: ["lead", "drums", "lead"],
      preserve: ["drums"],
    });
    const result = preferenceContextForIntent(intent);
    expect(result.genre).toBe("trap");
    expect(result.roleScope).toEqual(["lead"]);
    expect(JSON.stringify(result)).not.toContain("private prompt");
    expect(JSON.stringify(result)).not.toContain("session-specific-seed");
  });
});
