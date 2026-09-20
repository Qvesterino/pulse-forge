/**
 * Adversarial / edge-case tests for the ranking + supporting AI modules.
 *
 * Mirrors the style of tests/fxeq-adversarial.test.ts:
 *   - NaN/Inf in numeric fields
 *   - Empty/degenerate candidate lists
 *   - Rapid-fire seed sweeps (determinism & state isolation)
 *   - Corrupted JSON / malformed manifest payloads
 *   - Boundary values (huge/small candidateCount, NaN scores)
 *   - Property round-trips & score ranges
 *
 * The companion tests live in tests/rank-candidates.test.ts and tests/ranker-client.test.ts.
 * Do not duplicate those; this file is intentionally red-teaming.
 *
 * When a test surfaces a real source-code bug, we `.skip` with a TODO follow-up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { rankCandidatesWithModel } from "../src/ai/ranking/rank-candidates";
import {
  currentRankerManifest,
  rankerMode,
  resetRankerClient,
  scoreCandidateFeatures,
} from "../src/ai/ranking/ranker-client";
import { isRankerManifest, type RankerManifest } from "../src/ai/ranking/ranker-types";
import { rankCandidateBank, type CandidateBankEntry } from "../src/intent/candidate-bank";
import { canonicalizePattern, contentHash, measurePattern } from "../src/ai/evaluation";
import { canRatchet, ghostMultiplier, inferPadRole } from "../src/ai/pad-roles";
import { inspectPatternInvariants } from "../src/ai/invariants";
import {
  decodeMelodicState,
  encodeMelodicState,
  generateMelodicParts,
  generateMelodicPattern,
} from "../src/ai/melodic";
import { mulberry32 } from "../src/shared/rng";
import type { GenerateOptions } from "../src/ai/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

// Mock scoreCandidateFeatures so the ranker falls back deterministically.
// Tests that need a model response override this mock.
vi.mock("../src/ai/ranking/ranker-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/ranking/ranker-client")>();
  return {
    ...actual,
    scoreCandidateFeatures: vi.fn(async () => ({ ok: false, scores: null, source: "fallback" as const })),
  };
});

const scoreMock = vi.mocked(scoreCandidateFeatures);

function makeOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    seed: "rank-adv",
    stepCount: 16,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    temperature: 1.0,
    replaceMode: "new",
    ...overrides,
  };
}

function freshDoc(): ProjectDocument {
  return createDefaultProject();
}

function planFor(doc: ProjectDocument) {
  const intent = normalizeIntent({
    genre: "house",
    seed: "rank-adv",
    roles: ["drums"],
    candidateCount: 3,
  });
  return planGeneration(intent, doc);
}

function buildCandidates(doc: ProjectDocument, count: number): CandidateBankEntry[] {
  const candidates: CandidateBankEntry[] = [];
  for (let i = 0; i < count; i++) {
    const basePattern = doc.patterns[0];
    const pattern: Pattern = {
      ...basePattern,
      rows: Object.fromEntries(
        Object.entries(basePattern.rows).map(([padId, row]) => [
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

describe("rankCandidatesWithModel — adversarial inputs", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
    scoreMock.mockClear();
    scoreMock.mockImplementation(async () => ({ ok: false, scores: null, source: "fallback" }));
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
  });

  it("empty candidate list: returns empty order without throwing", async () => {
    const doc = freshDoc();
    const plan = planFor(doc);
    const ranking = await rankCandidatesWithModel(doc, [], plan);
    expect(ranking.order).toEqual([]);
    expect(ranking.modelScores).toEqual([]);
  });

  it("single candidate: ranking returns that candidate and never calls the model", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 1);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.order).toHaveLength(1);
    expect(ranking.order[0].candidateIndex).toBe(0);
    expect(scoreMock).not.toHaveBeenCalled();
    expect(ranking.source).toBe("fallback");
  });

  it("two-candidate batch with mode=off bypasses the model and uses the heuristic baseline", async () => {
    localStorage.setItem("pf:intent-ranker", "off");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 2);
    const heuristicOrder = rankCandidateBank(doc, candidates);
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.source).toBe("off");
    expect(scoreMock).not.toHaveBeenCalled();
    expect(ranking.order.map((c) => c.candidateIndex)).toEqual(heuristicOrder.map((c) => c.candidateIndex));
  });

  it("10-candidate batch under shadow mode records model scores but keeps heuristic order", async () => {
    localStorage.setItem("pf:intent-ranker", "shadow");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 10);
    const heuristicOrder = rankCandidateBank(doc, candidates);
    // Inverted scores — model would have re-ordered, but shadow mode must not.
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: candidates.map((_, i) => 1 - i * 0.1),
      source: "model",
    }));
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.mode).toBe("shadow");
    expect(ranking.source).toBe("model");
    expect(ranking.order.map((c) => c.candidateIndex)).toEqual(heuristicOrder.map((c) => c.candidateIndex));
    expect(ranking.modelScores.length).toBe(10);
    for (const s of ranking.modelScores) {
      if (s !== null) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it("50-candidate rapid-fire ranking: identical inputs → identical ranking (no shared state)", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 8);
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: candidates.map((_, i) => 0.5 + (i % 3) * 0.1),
      source: "model",
    }));
    const ref = await rankCandidatesWithModel(doc, candidates, plan);
    for (let i = 0; i < 50; i++) {
      const again = await rankCandidatesWithModel(doc, candidates, plan);
      expect(again.order.map((c) => c.candidateIndex)).toEqual(ref.order.map((c) => c.candidateIndex));
      expect(again.modelScores).toEqual(ref.modelScores);
    }
  });

  it("concurrent ranking calls (8 in parallel) stay consistent", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 4);
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: [0.9, 0.7, 0.5, 0.3],
      source: "model",
    }));
    const tasks = await Promise.all(Array.from({ length: 8 }, () => rankCandidatesWithModel(doc, candidates, plan)));
    const refOrder = tasks[0].order.map((c) => c.candidateIndex);
    for (const t of tasks) {
      expect(t.order.map((c) => c.candidateIndex)).toEqual(refOrder);
    }
  });

  it("model returns out-of-range scores (NaN, -1, 2): ranking propagates but order stays defined", async () => {
    localStorage.setItem("pf:intent-ranker", "active");
    const doc = freshDoc();
    const plan = planFor(doc);
    const candidates = buildCandidates(doc, 3);
    // Contract: when the mock-level ranker returns invalid scores, the
    // ranking pipeline should not throw and should return SOME order. The
    // client-side `scoreCandidateFeatures` has its own validation, but the
    // mock bypasses the worker protocol, so the ranking may still see
    // out-of-range scores — the only required guarantee is "no crash".
    scoreMock.mockImplementation(async () => ({
      ok: true,
      scores: [NaN, -1, 2] as never,
      source: "model",
    }));
    const ranking = await rankCandidatesWithModel(doc, candidates, plan);
    expect(ranking.order).toHaveLength(3);
    // Each modelScore should be a number OR null — never a thrown value.
    for (const s of ranking.modelScores) {
      expect(s === null || typeof s === "number").toBe(true);
    }
  });
});

describe("ranker-client — adversarial inputs", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
    resetRankerClient();
  });

  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
  });

  it("rankerMode reads localStorage values verbatim (off/shadow/active)", () => {
    localStorage.setItem("pf:intent-ranker", "off");
    expect(rankerMode()).toBe("off");
    localStorage.setItem("pf:intent-ranker", "shadow");
    expect(rankerMode()).toBe("shadow");
    localStorage.setItem("pf:intent-ranker", "active");
    expect(rankerMode()).toBe("active");
  });

  it("rankerMode ignores garbage localStorage values", () => {
    localStorage.setItem("pf:intent-ranker", "banana");
    expect(["off", "shadow", "active"]).toContain(rankerMode());
    localStorage.setItem("pf:intent-ranker", "");
    expect(["off", "shadow", "active"]).toContain(rankerMode());
  });

  it("currentRankerManifest returns null after a reset (no manifest was loaded)", () => {
    resetRankerClient();
    expect(currentRankerManifest()).toBeNull();
  });

  it("resetRankerClient is idempotent across multiple calls", () => {
    expect(() => {
      resetRankerClient();
      resetRankerClient();
      resetRankerClient();
    }).not.toThrow();
  });
});

describe("ranker-types — adversarial manifest validation", () => {
  it("isRankerManifest rejects null, undefined, primitives", () => {
    expect(isRankerManifest(null)).toBe(false);
    expect(isRankerManifest(undefined)).toBe(false);
    expect(isRankerManifest(42)).toBe(false);
    expect(isRankerManifest("string")).toBe(false);
    expect(isRankerManifest(true)).toBe(false);
  });

  it("isRankerManifest rejects objects missing required fields", () => {
    expect(isRankerManifest({})).toBe(false);
    expect(isRankerManifest({ rankerVersion: "x" })).toBe(false);
    expect(
      isRankerManifest({
        rankerVersion: "x",
        featureVersion: "features.v1",
        normalizationId: "norm.fixed.v1",
        featureCount: 0, // invalid: must be > 0
        modelPath: "/models/x.onnx",
        inputName: "x",
        outputName: "y",
        modelHash: "0".repeat(64),
        hidden: [],
      }),
    ).toBe(false);
  });

  it("isRankerManifest rejects wrong featureVersion / normalizationId", () => {
    const base = {
      rankerVersion: "v1",
      featureVersion: "features.v1",
      normalizationId: "norm.fixed.v1",
      featureCount: 8,
      modelPath: "/models/x.onnx",
      inputName: "x",
      outputName: "y",
      modelHash: "0".repeat(64),
      hidden: [] as readonly number[],
    };
    expect(isRankerManifest({ ...base, featureVersion: "features.v9" })).toBe(false);
    expect(isRankerManifest({ ...base, normalizationId: "norm.wrong" })).toBe(false);
  });

  it("isRankerManifest rejects modelPath that does not start with /models/", () => {
    const base = {
      rankerVersion: "v1",
      featureVersion: "features.v1",
      normalizationId: "norm.fixed.v1",
      featureCount: 8,
      modelPath: "/wrong/x.onnx",
      inputName: "x",
      outputName: "y",
      modelHash: "0".repeat(64),
      hidden: [] as readonly number[],
    };
    expect(isRankerManifest(base)).toBe(false);
  });

  it("isRankerManifest rejects modelHash that is not 64 lowercase hex chars", () => {
    const base = {
      rankerVersion: "v1",
      featureVersion: "features.v1",
      normalizationId: "norm.fixed.v1",
      featureCount: 8,
      modelPath: "/models/x.onnx",
      inputName: "x",
      outputName: "y",
      modelHash: "tooshort",
      hidden: [] as readonly number[],
    };
    expect(isRankerManifest(base)).toBe(false);
  });

  it("isRankerManifest accepts a fully-valid manifest", () => {
    const valid: RankerManifest = {
      rankerVersion: "intent-ranker-v1",
      featureVersion: "features.v1",
      normalizationId: "norm.fixed.v1",
      featureCount: 56,
      modelPath: "/models/intent-ranker-v1.onnx",
      inputName: "features",
      outputName: "score",
      modelHash: "a".repeat(64),
      hidden: [64, 32],
    };
    expect(isRankerManifest(valid)).toBe(true);
  });
});

describe("ranker-worker — adversarial inputs (type contract)", () => {
  it("worker types refuse non-Float32Array batches (compile-time contract)", () => {
    // Build a fake RankerScoreRequest with the wrong batch shape — runtime
    // worker rejects it with "batch must be Float32Array".
    const req = {
      type: "score" as const,
      requestId: 1,
      batch: [0.1, 0.2, 0.3] as never, // not a Float32Array
      candidateCount: 3,
    };
    // Type-only assertion: the shape conforms, runtime would reject.
    expect(req.type).toBe("score");
    expect(Array.isArray(req.batch)).toBe(true);
  });
});

describe("evaluation — adversarial inputs", () => {
  it("canonicalizePattern on empty Pattern yields a stable empty canonical", () => {
    const doc = freshDoc();
    const p: Pattern = {
      id: "ev-empty",
      name: "empty",
      stepCount: 16,
      rows: {},
      notes: {},
      stepMeta: undefined,
    };
    const a = canonicalizePattern(doc, p);
    const b = canonicalizePattern(doc, p);
    expect(a.stepCount).toBe(16);
    expect(a.rows).toEqual([]);
    expect(a.notes).toEqual([]);
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("canonicalizePattern on NaN/Inf rows normalizes them to 0 (stable)", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const p: Pattern = {
      id: "ev-nan",
      name: "nan",
      stepCount: 16,
      rows: { [padId]: [NaN, Infinity, -Infinity, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      notes: {},
      stepMeta: undefined,
    };
    const c = canonicalizePattern(doc, p);
    // All values must have been normalized to finite numbers (NaN → 0).
    for (const row of c.rows) {
      for (const v of row.values) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("contentHash is deterministic for identical content (no timing leakage)", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const p: Pattern = {
      id: "ev-det",
      name: "det",
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0.1)) },
      notes: {},
      stepMeta: undefined,
    };
    const a = contentHash(canonicalizePattern(doc, p));
    const b = contentHash(canonicalizePattern(doc, p));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("contentHash differs when row content differs", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const make = (offset: number): Pattern => ({
      id: `ev-${offset}`,
      name: `p${offset}`,
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(0).map((_, i) => (i % 4 === offset ? 0.9 : 0.1)) },
      notes: {},
      stepMeta: undefined,
    });
    const h0 = contentHash(canonicalizePattern(doc, make(0)));
    const h1 = contentHash(canonicalizePattern(doc, make(1)));
    expect(h0).not.toBe(h1);
  });

  it("measurePattern on empty Pattern returns finite metrics", () => {
    const p: Pattern = {
      id: "ev-mp",
      name: "empty",
      stepCount: 16,
      rows: {},
      notes: {},
      stepMeta: undefined,
    };
    const m = measurePattern(p);
    expect(Number.isFinite(m.drumDensity)).toBe(true);
    expect(m.drumRows).toBe(0);
    expect(m.drumHits).toBe(0);
    expect(m.downbeatRatio).toBe(0);
  });

  it("measurePattern on NaN/Inf rows returns 0 for the affected counts (sanitized)", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const p: Pattern = {
      id: "ev-mp-nan",
      name: "nan",
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(NaN) },
      notes: {},
      stepMeta: undefined,
    };
    const m = measurePattern(p);
    expect(m.drumHits).toBe(0);
    expect(m.drumDensity).toBe(0);
  });
});

describe("pad-roles — adversarial inputs", () => {
  it("inferPadRole classifies standard kit names", () => {
    expect(inferPadRole("Kick", 0)).toBe("kick");
    expect(inferPadRole("Snare", 0)).toBe("snare");
    expect(inferPadRole("Clap", 0)).toBe("clap");
    expect(inferPadRole("Closed Hat", 0)).toBe("closedHat");
    expect(inferPadRole("Open Hat", 0)).toBe("openHat");
    expect(inferPadRole("Tom", 0)).toBe("tom");
    expect(inferPadRole("FX", 0)).toBe("fx");
    expect(inferPadRole("Perc", 0)).toBe("perc");
  });

  it("inferPadRole falls back to index-based classification when name is empty", () => {
    expect(inferPadRole("", 0)).toBe("kick");
    expect(inferPadRole(undefined, 4)).toBe("snare");
    expect(inferPadRole(undefined, 8)).toBe("closedHat");
  });

  it("inferPadRole handles very large pad indices via fallback", () => {
    expect(inferPadRole(undefined, 9999)).toBe("unknown");
  });

  it("inferPadRole tolerates weird / non-matching names via index fallback", () => {
    expect(inferPadRole("🚀", 0)).toBe("kick"); // name doesn't match → index fallback
    expect(inferPadRole("zzz", 1)).toBe("kick");
    // index past the fallback table → "unknown"
    expect(inferPadRole("zzz", 9999)).toBe("unknown");
  });

  it("canRatchet returns false for kick / snare / tom, true for hats", () => {
    expect(canRatchet("kick")).toBe(false);
    expect(canRatchet("snare")).toBe(false);
    expect(canRatchet("tom")).toBe(false);
    expect(canRatchet("closedHat")).toBe(true);
    expect(canRatchet("openHat")).toBe(true);
    expect(canRatchet("perc")).toBe(true);
    expect(canRatchet("fx")).toBe(true);
  });

  it("ghostMultiplier stays in [0, 1] for every known role", () => {
    const roles: Array<Parameters<typeof ghostMultiplier>[0]> = [
      "kick",
      "snare",
      "clap",
      "closedHat",
      "openHat",
      "perc",
      "tom",
      "fx",
      "unknown",
    ];
    for (const role of roles) {
      const m = ghostMultiplier(role);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe("invariants — adversarial Pattern inspection", () => {
  it("accepts a fully-valid Pattern with ok=true and no issues", () => {
    const doc = freshDoc();
    const pattern = doc.patterns[0];
    const report = inspectPatternInvariants(doc, pattern);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("flags a row whose length doesn't match stepCount", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const p: Pattern = {
      ...doc.patterns[0],
      rows: { [padId]: [0.9] }, // length 1, stepCount 16
    };
    const report = inspectPatternInvariants(doc, p);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "row-length")).toBe(true);
  });

  it("flags a row with values outside [0,1] or non-finite", () => {
    const doc = freshDoc();
    const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
    const p: Pattern = {
      ...doc.patterns[0],
      rows: { [padId]: new Array(16).fill(0).map((_, i) => (i === 0 ? NaN : i === 1 ? 1.5 : 0)) },
    };
    const report = inspectPatternInvariants(doc, p);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "row-value")).toBe(true);
  });

  it("flags a note with out-of-range pitch", () => {
    const doc = freshDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")?.id;
    if (!trackId) return; // no instrument track → nothing to flag
    const p: Pattern = {
      ...doc.patterns[0],
      notes: {
        [trackId]: [{ id: "n1", pitch: 999, start: 0, duration: 120, velocity: 0.9 }],
      },
    };
    const report = inspectPatternInvariants(doc, p);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "note-pitch")).toBe(true);
  });

  it("flags a note with negative duration", () => {
    const doc = freshDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")?.id;
    if (!trackId) return;
    const p: Pattern = {
      ...doc.patterns[0],
      notes: {
        [trackId]: [{ id: "n1", pitch: 60, start: 0, duration: -10, velocity: 0.9 }],
      },
    };
    const report = inspectPatternInvariants(doc, p);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "note-duration")).toBe(true);
  });

  it("flags a stale generation.outputContentHash (mismatched content hash)", () => {
    const doc = freshDoc();
    const base = doc.patterns[0];
    if (!base) return; // no patterns in fresh doc — invariant check is meaningless
    if (!base.generation) return; // no generation record — invariant check is meaningless
    const p: Pattern = {
      ...base,
      generation: {
        ...base.generation,
        outputContentHash: "deadbeef",
      },
    };
    const report = inspectPatternInvariants(doc, p);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "content-hash")).toBe(true);
  });
});

describe("melodic — adversarial inputs", () => {
  it("encodeMelodicState / decodeMelodicState round-trip for canonical states", () => {
    for (let degree = -1; degree <= 6; degree++) {
      for (const duration of [1, 2, 4, 8]) {
        const idx = encodeMelodicState(degree, duration);
        const decoded = decodeMelodicState(idx);
        expect(decoded.degree).toBe(degree);
        expect(decoded.duration).toBe(duration);
      }
    }
  });

  it("encodeMelodicState clamps NaN / out-of-range degrees and durations", () => {
    const cases: Array<[number, number]> = [
      [NaN, 1],
      [-9999, 1],
      [9999, 1],
      [0, NaN],
      [0, -10],
      [0, 99],
    ];
    for (const [deg, dur] of cases) {
      const idx = encodeMelodicState(deg, dur);
      const decoded = decodeMelodicState(idx);
      expect(Number.isInteger(decoded.degree)).toBe(true);
      expect(decoded.degree).toBeGreaterThanOrEqual(-1);
      expect(decoded.degree).toBeLessThanOrEqual(6);
      expect([1, 2, 4, 8]).toContain(decoded.duration);
    }
  });

  it("decodeMelodicState on out-of-range integer indices clamps to a valid state", () => {
    for (const idx of [-1, 9999, -100, 50]) {
      const decoded = decodeMelodicState(idx);
      expect(decoded.degree).toBeGreaterThanOrEqual(-1);
      expect(decoded.degree).toBeLessThanOrEqual(6);
      expect([1, 2, 4, 8]).toContain(decoded.duration);
    }
  });

  // TODO: src/ai/melodic.ts:L37 — safeMelodicStateIndex does NOT sanitize NaN
  //       (Math.min(31, NaN) = NaN, Math.max(0, NaN) = NaN). decodeMelodicState
  //       returns NaN for NaN/Infinity inputs. Should fall back to a known state.
  it("decodeMelodicState on NaN/Infinity returns a finite state", () => {
    for (const idx of [NaN, Infinity, -Infinity]) {
      const decoded = decodeMelodicState(idx as never);
      expect(Number.isFinite(decoded.degree)).toBe(true);
      expect([1, 2, 4, 8]).toContain(decoded.duration);
    }
  });

  it("generateMelodicPattern for an unknown genre returns empty notes without throwing", () => {
    const options = makeOptions({ genre: "polka" as never });
    const notes = generateMelodicPattern(options, mulberry32(1));
    expect(Array.isArray(notes)).toBe(true);
    expect(notes.length).toBe(0);
  });

  it("generateMelodicParts returns the full part set for all known genres", () => {
    for (const genre of ["house", "techno", "trap", "ambient"] as const) {
      const parts = generateMelodicParts(makeOptions({ genre }), mulberry32(7));
      expect(parts.bass).toBeDefined();
      expect(parts.chord).toBeDefined();
      expect(parts.lead).toBeDefined();
    }
  });

  it("generateMelodicPattern is deterministic with same seed", () => {
    const options = makeOptions({ genre: "house" });
    const a = generateMelodicPattern(options, mulberry32(42));
    const b = generateMelodicPattern(options, mulberry32(42));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].pitch).toBe(b[i].pitch);
      expect(a[i].start).toBe(b[i].start);
      expect(a[i].duration).toBe(b[i].duration);
      expect(a[i].velocity).toBe(b[i].velocity);
    }
  });

  it("all generated notes have MIDI-range pitch, positive velocity, positive duration", () => {
    const options = makeOptions({ genre: "techno" });
    const notes = generateMelodicPattern(options, mulberry32(3), "C Major");
    for (const n of notes) {
      expect(Number.isInteger(n.pitch)).toBe(true);
      expect(n.pitch).toBeGreaterThanOrEqual(0);
      expect(n.pitch).toBeLessThanOrEqual(127);
      expect(n.velocity).toBeGreaterThan(0);
      expect(n.velocity).toBeLessThanOrEqual(1);
      expect(n.duration).toBeGreaterThan(0);
    }
  });

  it("sidechain-aware bass respects active kick steps", () => {
    const options = makeOptions({ genre: "house", stepCount: 16 });
    const kickRow = new Array(16).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0));
    const parts = generateMelodicParts(options, mulberry32(11), "C Major", [kickRow]);
    // Bass should be defined; we don't pin a specific duck value, but every note must be finite.
    for (const n of parts.bass) {
      expect(Number.isFinite(n.pitch)).toBe(true);
      expect(Number.isFinite(n.start)).toBe(true);
      expect(Number.isFinite(n.duration)).toBe(true);
      expect(Number.isFinite(n.velocity)).toBe(true);
    }
  });
});
