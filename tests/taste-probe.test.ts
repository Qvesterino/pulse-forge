import { describe, expect, it } from "vitest";
import { FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import {
  orderTasteProbeSides,
  suggestTasteProbePair,
  tasteProbePairKey,
  type TasteProbeCandidate,
} from "../src/intent/taste-probe";

const GLOBAL_VERSION = "global-selector.v1:heuristic";
const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");

function vector(syncopation = 0.5, fill = 0.5): number[] {
  const values = new Array<number>(FEATURE_COUNT).fill(fill);
  values[syncopationIndex] = syncopation;
  return values;
}

function candidate(
  candidateIndex: number,
  features: number[],
  globalScore: number | undefined = 0.5,
  globalScoreVersion: string | undefined = GLOBAL_VERSION,
  contentHash = `content-${candidateIndex}`,
): TasteProbeCandidate<number> {
  return {
    candidate: candidateIndex,
    candidateIndex,
    contentHash,
    features,
    ...(globalScore !== undefined ? { globalScore } : {}),
    ...(globalScoreVersion !== undefined ? { globalScoreVersion } : {}),
  };
}

describe("Taste Probe suggestion", () => {
  it("keeps A/B assignment independent from candidate rank when sides are randomized", () => {
    const result = suggestTasteProbePair([candidate(0, vector(0.1)), candidate(1, vector(0.9))]);
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected a probe pair");

    expect(orderTasteProbeSides(result, false).map((side) => side.candidateIndex)).toEqual([0, 1]);
    expect(orderTasteProbeSides(result, true).map((side) => side.candidateIndex)).toEqual([1, 0]);
  });

  it("selects a different eligible pair when the best pair was already compared or skipped", () => {
    const candidates = [
      candidate(0, vector(0.1), 0.5),
      candidate(1, vector(0.9), 0.51),
      candidate(2, vector(0.5), 0.52),
    ];
    const first = suggestTasteProbePair(candidates);
    expect(first).not.toBeNull();
    if (!first) throw new Error("expected an initial probe pair");

    const excluded = new Set([tasteProbePairKey(first.candidateB.contentHash, first.candidateA.contentHash)]);
    const next = suggestTasteProbePair(candidates, excluded);
    expect(next).not.toBeNull();
    expect(next && tasteProbePairKey(next.candidateA.contentHash, next.candidateB.contentHash)).not.toBe(
      tasteProbePairKey(first.candidateA.contentHash, first.candidateB.contentHash),
    );

    const allPairs = new Set<string>();
    for (let left = 0; left < candidates.length; left++) {
      for (let right = left + 1; right < candidates.length; right++) {
        allPairs.add(tasteProbePairKey(candidates[left]!.contentHash, candidates[right]!.contentHash));
      }
    }
    expect(suggestTasteProbePair(candidates, allPairs)).toBeNull();
  });

  it("selects a near-tied pair with a dominant supported groove contrast", () => {
    const result = suggestTasteProbePair([
      candidate(8, vector(0.9), 0.54),
      candidate(2, vector(0.1), 0.51),
      candidate(5, vector(0.1), 0.9),
    ]);

    expect(result?.candidateA.candidateIndex).toBe(2);
    expect(result?.candidateB.candidateIndex).toBe(8);
    expect(result?.reason).toBe("groove");
    expect(result?.axisDelta).toBeGreaterThan(result?.offAxisDelta ?? 1);
    expect(result?.globalScoreGap).toBeCloseTo(0.03);
  });

  it("refuses pairs with a mismatched global policy or a large selector-score gap", () => {
    expect(
      suggestTasteProbePair([
        candidate(0, vector(0.1), 0.5, GLOBAL_VERSION),
        candidate(1, vector(0.9), 0.51, "global-selector.v2:hybrid"),
      ]),
    ).toBeNull();
    expect(suggestTasteProbePair([candidate(0, vector(0.1), 0.2), candidate(1, vector(0.9), 0.5)])).toBeNull();
  });

  it("rejects a broadly confounded change instead of claiming one reason", () => {
    expect(suggestTasteProbePair([candidate(0, vector(0.1, 0.1)), candidate(1, vector(0.9, 0.9))])).toBeNull();
  });

  it("does not suggest legacy candidates without global-score provenance", () => {
    const legacyA = { ...candidate(0, vector(0.1)), globalScore: undefined, globalScoreVersion: undefined };
    const legacyB = { ...candidate(1, vector(0.9)), globalScore: undefined, globalScoreVersion: undefined };
    expect(suggestTasteProbePair([legacyA, legacyB])).toBeNull();
  });
});
