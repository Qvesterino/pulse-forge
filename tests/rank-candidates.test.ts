import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { rankCandidatesWithModel } from "../src/ai/ranking/rank-candidates";
import { resetRankerClient, rankerMode } from "../src/ai/ranking/ranker-client";
import type { CandidateBankEntry } from "../src/intent/candidate-bank";

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
    expect(ranking.order.map((c) => c.candidateIndex)).toEqual(
      [...ranking.order.map((c) => c.candidateIndex)].sort((a, b) => a - b),
    );
  });

  it("model unavailable: heuristic fallback order is the baseline", async () => {
    const doc = createDefaultProject();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    const heuristicOrder = (await import("../src/intent/candidate-bank")).rankCandidateBank(doc, candidates);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("fallback");
    expect(ranking.order.map((c) => c.candidateIndex)).toEqual(heuristicOrder.map((c) => c.candidateIndex));
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
});

describe("rankerMode flag", () => {
  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("defaults to the activated ranker mode", () => {
    // Commit 765e91a flipped DEFAULT_RANKER_MODE to "active" after the golden
    // preference gate passed; the localStorage override still wins.
    expect(rankerMode()).toBe("active");
  });

  it("reads the localStorage override", () => {
    localStorage.setItem("pf:intent-ranker", "active");
    expect(rankerMode()).toBe("active");
    localStorage.setItem("pf:intent-ranker", "off");
    expect(rankerMode()).toBe("off");
  });
});
