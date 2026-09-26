import { describe, expect, it } from "vitest";
import { FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import { evaluatePersonalPreferences } from "../src/intent/preference-evaluation";
import { createPreferenceObservation } from "../src/intent/preference-ledger";
import type { PreferenceContext, PreferenceObservationV1 } from "../src/intent/preference-ledger";

const context: PreferenceContext = {
  genre: "trap",
  productionProfile: null,
  task: "pattern",
  roleScope: ["drums", "lead"],
  key: "1234abcd",
};
const GLOBAL_VERSION = "global-selector.v1:heuristic";
const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");

function features(syncopation: number): number[] {
  const result = new Array<number>(FEATURE_COUNT).fill(0.5);
  result[syncopationIndex] = syncopation;
  return result;
}

function pair(
  prefix: string,
  syncA: number,
  syncB: number,
  scoreA: number,
  scoreB: number,
  choice: "a" | "b" | "neither" | "both",
  createdAt: number,
): PreferenceObservationV1 {
  const observation = createPreferenceObservation(
    context,
    {
      contentHash: `${prefix}-a`,
      features: features(syncA),
      globalScore: scoreA,
      globalScoreVersion: GLOBAL_VERSION,
    },
    {
      contentHash: `${prefix}-b`,
      features: features(syncB),
      globalScore: scoreB,
      globalScoreVersion: GLOBAL_VERSION,
    },
    choice,
    { createdAt },
  );
  if (!observation) throw new Error("test preference observation is invalid");
  return observation;
}

describe("Producer DNA held-out evaluation", () => {
  it("compares future preference predictions against the captured global selector", () => {
    const observations = [
      pair("train-01", 0.9, 0.1, 0.49, 0.5, "a", 100),
      pair("train-02", 0.9, 0.1, 0.49, 0.5, "a", 200),
      pair("test-03", 0.9, 0.1, 0.49, 0.5, "a", 300),
    ];

    const report = evaluatePersonalPreferences(observations);

    expect(report.inputObservations).toBe(3);
    expect(report.validObservations).toBe(3);
    expect(report.explicitChoiceObservations).toBe(3);
    expect(report.evaluatedComparisons).toBe(1);
    expect(report.globalAccuracy).toBe(0);
    expect(report.personalAccuracy).toBe(1);
    expect(report.personalLift).toBe(1);
    expect(report.uncertainty95.globalAccuracy).toEqual({ lower: 0, upper: 1 });
    expect(report.uncertainty95.personalAccuracy).toEqual({ lower: 0, upper: 1 });
    expect(report.uncertainty95.personalLift).toEqual({ lower: -1, upper: 1 });
    expect(report.globalScoreVersions).toEqual([GLOBAL_VERSION]);
    expect(report.skipped.insufficientPriorChoices).toBe(2);
    expect(report.caveat).toMatch(/prompt\/session groups are not stored/);
  });

  it("does not let observations with the same timestamp train one another", () => {
    const observations = [
      pair("same-time-01", 0.9, 0.1, 0.5, 0.4, "a", 100),
      pair("same-time-02", 0.9, 0.1, 0.5, 0.4, "a", 100),
      pair("later-03", 0.9, 0.1, 0.49, 0.5, "a", 200),
    ];

    const report = evaluatePersonalPreferences(observations);

    expect(report.evaluatedComparisons).toBe(1);
    expect(report.skipped.insufficientPriorChoices).toBe(2);
  });

  it("excludes held-out pairs that reuse previously seen candidate content", () => {
    const first = pair("train-01", 0.9, 0.1, 0.49, 0.5, "a", 100);
    const second = pair("train-02", 0.9, 0.1, 0.49, 0.5, "a", 200);
    const reused = createPreferenceObservation(
      context,
      {
        contentHash: first.candidateA.contentHash,
        features: first.candidateA.features,
        globalScore: 0.49,
        globalScoreVersion: GLOBAL_VERSION,
      },
      {
        contentHash: "new-candidate-b",
        features: features(0.1),
        globalScore: 0.5,
        globalScoreVersion: GLOBAL_VERSION,
      },
      "a",
      { createdAt: 300 },
    );
    if (!reused) throw new Error("reused test observation is invalid");

    const report = evaluatePersonalPreferences([first, second, reused]);

    expect(report.evaluatedComparisons).toBe(0);
    expect(report.skipped.previouslySeenCandidate).toBe(1);
  });

  it("reports missing baseline metadata instead of guessing the global result", () => {
    const observations = [
      pair("train-01", 0.9, 0.1, 0.49, 0.5, "a", 100),
      pair("train-02", 0.9, 0.1, 0.49, 0.5, "a", 200),
      createPreferenceObservation(
        context,
        { contentHash: "legacy-a", features: features(0.9) },
        { contentHash: "legacy-b", features: features(0.1) },
        "a",
        { createdAt: 300 },
      )!,
    ];

    const report = evaluatePersonalPreferences(observations);

    expect(report.evaluatedComparisons).toBe(0);
    expect(report.globalAccuracy).toBeNull();
    expect(report.skipped.missingGlobalScore).toBe(1);
  });
});
