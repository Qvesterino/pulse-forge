import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { generateAsyncResult, generateLocalResult } from "../src/intent/pipeline";
import { resetRankerClient } from "../src/ai/ranking/ranker-client";

/**
 * Active/shadow ranker participation through the CANONICAL async path, with
 * the worker client mocked (controlled model scores). Complements
 * tests/rank-candidates.test.ts, which pins the weighting at the ranking
 * module level — here we pin what the product pipeline records and selects.
 */

vi.mock("../src/ai/ranking/ranker-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/ranking/ranker-client")>();
  return {
    ...actual,
    scoreCandidateFeatures: vi.fn(async () => ({ ok: false, scores: null, source: "fallback" as const })),
  };
});

vi.mock("../src/ai/ranking/rank-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/ranking/rank-candidates")>();
  return {
    ...actual,
    // Individual tests override; default delegates to the real implementation.
    rankCandidatesWithModel: vi.fn(actual.rankCandidatesWithModel),
  };
});

import { scoreCandidateFeatures } from "../src/ai/ranking/ranker-client";
import { rankCandidatesWithModel } from "../src/ai/ranking/rank-candidates";

const scoreMock = vi.mocked(scoreCandidateFeatures);
const rankWithModelMock = vi.mocked(rankCandidatesWithModel);

function passThroughActual() {
  return async (
    ...args: Parameters<typeof rankCandidatesWithModel>
  ): Promise<Awaited<ReturnType<typeof rankCandidatesWithModel>>> => {
    const actual = await vi.importActual<typeof import("../src/ai/ranking/rank-candidates")>(
      "../src/ai/ranking/rank-candidates",
    );
    return actual.rankCandidatesWithModel(...args);
  };
}

const INTENT = {
  genre: "house" as const,
  style: "Driving",
  seed: "active-ranker-test",
  length: 32,
  candidateCount: 3,
  roles: ["drums", "bass"] as const,
};

function hashOf(doc: ReturnType<typeof createDefaultProject>, r: Awaited<ReturnType<typeof generateAsyncResult>>) {
  return contentHash(canonicalizePattern(doc, r.proposal!.pattern));
}

describe("active ranker participation in the canonical path", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
    rankWithModelMock.mockReset();
    rankWithModelMock.mockImplementation(passThroughActual());
    scoreMock.mockReset();
    scoreMock.mockImplementation(async () => ({ ok: false, scores: null, source: "fallback" as const }));
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  it("active + model participation: neutral model scores preserve the heuristic winner, provenance records the model", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = createDefaultProject();
    const heuristic = generateLocalResult(doc, INTENT);
    // Equal model scores shift every candidate equally: 0.6·h + 0.4·0.5 —
    // the heuristic winner MUST survive (weighting contract), while the
    // provenance records genuine model participation.
    scoreMock.mockImplementation(async (_batch, count) => ({
      ok: true,
      scores: Array.from({ length: count }, () => 0.5),
      source: "model" as const,
    }));

    const active = await generateAsyncResult(doc, INTENT);
    const ranker = active.proposal!.pattern.generation?.ranker;
    expect(ranker).toMatchObject({ mode: "active", source: "model" });
    expect(active.diagnostics.warnings).toContain("ranker:model:active");
    expect(hashOf(doc, active)).toBe(hashOf(doc, heuristic));
    const banner = active.diagnostics.warnings.find((w) => w.startsWith("candidate-bank-selected:"));
    expect(banner).toBe(`candidate-bank-selected:${ranker!.selectedIndex}:template`);
  });

  it("active + model participation: boosted candidate selection is deterministic across reruns", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = createDefaultProject();
    // The heuristic winner sits at position 0 of the ranked bank; score it 0
    // and everything else 1 — the strongest possible model push against it.
    scoreMock.mockImplementation(async (_batch, count) => ({
      ok: true,
      scores: Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1)),
      source: "model" as const,
    }));

    const first = await generateAsyncResult(doc, INTENT);
    const second = await generateAsyncResult(doc, INTENT);
    // Equal inputs + equal model scores → identical outcome (no promise-order drift).
    expect(hashOf(doc, first)).toBe(hashOf(doc, second));
    expect(first.proposal!.pattern.generation?.ranker).toMatchObject({ mode: "active", source: "model" });
    // Pattern ids are random uids per generation run — musical content
    // (content hash + provenance), not object identity, is the determinism
    // contract. The exact 0.6·heuristic + 0.4·model arithmetic is pinned in
    // tests/rank-candidates.test.ts with crafted entries.
  });

  it("shadow + model scores: heuristic winner unchanged, provenance records shadow (no selection influence)", async () => {
    localStorage.setItem("pf:intent-ranker", "shadow");
    const doc = createDefaultProject();
    const heuristic = generateLocalResult(doc, INTENT);
    scoreMock.mockImplementation(async () => ({ ok: true, scores: [0, 0, 1], source: "model" as const }));

    const shadow = await generateAsyncResult(doc, INTENT);
    expect(hashOf(doc, shadow)).toBe(hashOf(doc, heuristic));
    expect(shadow.proposal!.pattern.generation?.ranker).toMatchObject({ mode: "shadow", source: "model" });
    expect(shadow.diagnostics.warnings).toContain("ranker-shadow:model");
  });

  it("a ranker-pipeline exception degrades to the heuristic winner with a truthful warning", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = createDefaultProject();
    const heuristic = generateLocalResult(doc, INTENT);
    rankWithModelMock.mockImplementation(async () => {
      throw new Error("synthetic ranker pipeline failure");
    });

    const result = await generateAsyncResult(doc, INTENT);
    expect(hashOf(doc, result)).toBe(hashOf(doc, heuristic)); // generation never broke
    expect(result.proposal!.pattern.generation?.ranker).toMatchObject({ mode: "active", source: "fallback" });
    expect(result.diagnostics.warnings.some((w) => w.startsWith("ranker-pipeline-error:"))).toBe(true);
  });
});
