import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { rankCandidatesWithModel } from "../src/ai/ranking/rank-candidates";
import { resetRankerClient, rankerMode } from "../src/ai/ranking/ranker-client";
import type { CandidateBankEntry } from "../src/intent/candidate-bank";
import { extractPatternFeatures } from "../src/ai/features/pattern-features";
import { FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import { rankCandidateBank } from "../src/intent/candidate-bank";
import { candidateFeatureDistance, diversifyCandidateOrder } from "../src/intent/candidate-diversity";
import {
  createPreferenceObservation,
  preferenceContextForIntent,
  recordPreferenceObservation,
} from "../src/intent/preference-ledger";

/**
 * Fáze 4/5 gates without a real worker: the model path must FALL BACK
 * deterministically to the heuristic ranking (worker unavailable here —
 * jsdom has no Worker), the heuristic order must stay the baseline, and
 * the stable-sort contract must hold.
 */

vi.mock("../src/ai/ranking/ranker-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/ranking/ranker-client")>();
  return {
    ...actual,
    // Default: model unavailable → fallback. Individual tests override.
    scoreCandidateFeatures: vi.fn(async () => ({ ok: false, scores: null, source: "fallback" })),
  };
});

import { scoreCandidateFeatures } from "../src/ai/ranking/ranker-client";
const scoreMock = vi.mocked(scoreCandidateFeatures);

function buildCandidates(doc: ReturnType<typeof createDefaultProject>, count: number): CandidateBankEntry[] {
  const candidates: CandidateBankEntry[] = [];
  for (let i = 0; i < count; i++) {
    const pattern = {
      ...doc.patterns[0],
      rows: Object.fromEntries(
        Object.entries(doc.patterns[0].rows).map(([padId, row]) => [
          padId,
          row.map((v, step) => (step % 4 === 0 && (step / 4 + i) % (count + 1) === 0 ? 0.8 : v)),
        ]),
      ),
    };
    candidates.push({
      candidateIndex: i,
      seed: `seed-${i}`,
      pattern,
      status: "accepted",
      repairs: [],
      score: 0,
      contentHash: "",
    });
  }
  return candidates;
}

describe("rankCandidatesWithModel — fallback + shadow contracts", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
    scoreMock.mockClear();
    scoreMock.mockImplementation(async () => ({ ok: false, scores: null, source: "fallback" }));
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    localStorage.removeItem("pf:producer-dna-preferences");
    localStorage.removeItem("pf:producer-dna-learning");
  });

  function planFor(doc: ReturnType<typeof createDefaultProject>) {
    const intent = normalizeIntent({
      genre: "house",
      seed: "rank-test",
      roles: ["drums"],
      candidateCount: 3,
    });
    return planGeneration(intent, doc);
  }

  it("mode off: heuristic order, model never consulted", async () => {
    localStorage.setItem("pf:intent-ranker", "off");
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("off");
    expect(scoreMock).not.toHaveBeenCalled();
    expect(ranking.order[0].candidateIndex).toBe(0);
    expect(new Set(ranking.order.map((c) => c.candidateIndex))).toEqual(new Set([0, 1, 2]));
  });

  it("model unavailable: heuristic fallback order is the baseline", async () => {
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    const heuristicOrder = (await import("../src/intent/candidate-bank")).rankCandidateBank(doc, candidates);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("fallback");
    expect(ranking.order[0].candidateIndex).toBe(heuristicOrder[0].candidateIndex);
    expect(new Set(ranking.order.map((c) => c.candidateIndex))).toEqual(
      new Set(heuristicOrder.map((candidate) => candidate.candidateIndex)),
    );
  });

  it("shadow mode: model scores recorded but the heuristic winner is unchanged", async () => {
    localStorage.setItem("pf:intent-ranker", "shadow");
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    const heuristicOrder = (await import("../src/intent/candidate-bank")).rankCandidateBank(doc, candidates);
    // Model scores invert the heuristic order.
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: [0.1, 0.5, 0.9],
      source: "model",
    }));
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("model");
    expect(ranking.mode).toBe("shadow");
    // Winner UNCHANGED despite the model preferring the last candidate.
    expect(ranking.order[0].candidateIndex).toBe(heuristicOrder[0].candidateIndex);
    expect(ranking.modelScores[2]).toBe(0.9);
  });

  it("active mode: combined score re-orders deterministically with stable tie-breaking", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: [0.1, 0.9, 0.5],
      source: "model",
    }));
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("model");
    expect(ranking.mode).toBe("active");
    // Deterministic re-run: identical scores → identical order.
    const again = await rankCandidatesWithModel(doc, candidates, plan);
    expect(again.order.map((c) => c.candidateIndex)).toEqual(ranking.order.map((c) => c.candidateIndex));
  });

  it("single candidate: heuristic baseline untouched regardless of ranker version (non-goal)", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 1);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.order).toHaveLength(1);
    expect(ranking.order[0].candidateIndex).toBe(candidates[0].candidateIndex);
  });

  it("applies explicit local pairwise preferences after global ranking, even with ONNX off", async () => {
    localStorage.setItem("pf:intent-ranker", "off");
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    const baseline = rankCandidateBank(doc, candidates);
    const patterns = baseline.map((candidate) => candidate.pattern);
    const vectors = baseline.map((candidate) =>
      extractPatternFeatures({
        doc,
        pattern: candidate.pattern,
        intent: plan.intent,
        options: plan.options,
        resolvedBpm: plan.resolvedBpm,
        batch: patterns,
      }),
    );
    const preferredIndex = 1;
    const preferred = baseline[preferredIndex];
    const preferredFeatures = vectors[preferredIndex];
    for (let index = 0; index < baseline.length; index++) {
      if (index === preferredIndex) continue;
      const observation = createPreferenceObservation(
        preferenceContextForIntent(plan.intent),
        { contentHash: preferred.contentHash, features: preferredFeatures.values },
        { contentHash: baseline[index].contentHash, features: vectors[index].values },
        "a",
        { createdAt: index + 1 },
      );
      expect(observation).not.toBeNull();
      expect(recordPreferenceObservation(observation!)).toBe(true);
    }

    const personalized = await rankCandidatesWithModel(doc, candidates, plan);
    expect(personalized.source).toBe("off");
    expect(personalized.order[0].contentHash).toBe(preferred.contentHash);
    expect(personalized.order).toHaveLength(baseline.length);
  });
});

describe("candidate-bank creative diversity", () => {
  function vector(structuralValue: number, intentValue = 0.5): Float32Array {
    const values = new Float32Array(FEATURE_COUNT).fill(0.5);
    FEATURE_NAMES.forEach((name, index) => {
      if (name.startsWith("drums.") || name.startsWith("melodic.")) values[index] = structuralValue;
      if (name === "intent.energyFit") values[index] = intentValue;
    });
    return values;
  }

  const ranked = [
    { candidateIndex: 0, contentHash: "best" },
    { candidateIndex: 1, contentHash: "near-duplicate" },
    { candidateIndex: 2, contentHash: "distinct" },
    { candidateIndex: 3, contentHash: "tail" },
  ];
  const features = new Map([
    ["best", vector(0.5)],
    ["near-duplicate", vector(0.5)],
    ["distinct", vector(0.05)],
    ["tail", vector(0.9)],
  ]);

  it("keeps the global winner first and moves a distinct valid option ahead of a near-duplicate", () => {
    const diverse = diversifyCandidateOrder(ranked, features);
    expect(diverse.slice(0, 3).map((candidate) => candidate.contentHash)).toEqual([
      "best",
      "distinct",
      "near-duplicate",
    ]);
    expect(diverse).toHaveLength(ranked.length);
    expect(new Set(diverse)).toEqual(new Set(ranked));
  });

  it("represents SAFE, PERSONAL and EXPERIMENTAL before repeating a lane", () => {
    const laneRanked = [
      { candidateIndex: 0, contentHash: "best", search: { lane: "safe" } },
      { candidateIndex: 1, contentHash: "safe-again", search: { lane: "safe" } },
      { candidateIndex: 2, contentHash: "personal", search: { lane: "personal" } },
      { candidateIndex: 3, contentHash: "experimental", search: { lane: "experimental" } },
    ];
    const laneFeatures = new Map(features);
    laneFeatures.set("safe-again", vector(0.48));
    laneFeatures.set("personal", vector(0.1));
    laneFeatures.set("experimental", vector(0.9));
    const diverse = diversifyCandidateOrder(laneRanked, laneFeatures);
    expect(diverse[0].candidateIndex).toBe(0);
    expect(new Set(diverse.slice(0, 3).map((candidate) => candidate.search.lane))).toEqual(
      new Set(["safe", "personal", "experimental"]),
    );
  });

  it("measures structural distance without letting prompt-fit dimensions fake novelty", () => {
    const baseline = vector(0.5, 0.2);
    const intentOnlyChange = vector(0.5, 0.95);
    expect(candidateFeatureDistance(baseline, intentOnlyChange)).toBe(0);
    expect(candidateFeatureDistance(baseline, vector(0.1))).toBeGreaterThan(0.3);
  });

  it("falls back to the deterministic input order if feature vectors are missing", () => {
    expect(diversifyCandidateOrder(ranked, new Map()).map((candidate) => candidate.contentHash)).toEqual(
      ranked.map((candidate) => candidate.contentHash),
    );
  });
});

describe("rankerMode flag", () => {
  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("is ACTIVE after the independent golden evaluation passed (2026-09-22)", () => {
    // ranker:activate flipped shadow → active once the listening-room golden
    // orders mapped to exact dataset groups and the independent holdout
    // (48 pairs / 8 groups) reached goldenHoldoutPairwiseAccuracy 0.75.
    // Revert via ranker-client.ts DEFAULT_RANKER_MODE if the gate regresses.
    expect(rankerMode()).toBe("active");
  });

  it("reads the localStorage override", () => {
    localStorage.setItem("pf:intent-ranker", "active");
    expect(rankerMode()).toBe("active");
    localStorage.setItem("pf:intent-ranker", "off");
    expect(rankerMode()).toBe("off");
  });
});
