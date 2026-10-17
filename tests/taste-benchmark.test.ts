import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { parseIntentText } from "../src/intent/text-parser";
import { generateAsyncResult } from "../src/intent/pipeline";
import {
  TASTE_BENCHMARK_CANDIDATE_COUNT,
  TASTE_BENCHMARK_CASES,
  TASTE_BENCHMARK_HARNESS,
  diffTasteBenchmark,
  runTasteBenchmark,
  type TasteBenchmarkCase,
  type TasteBenchmarkObservation,
  type TasteBenchmarkReport,
} from "../src/intent/taste-benchmark";

/**
 * WAVE E2 — TASTE BENCHMARK LOCK.
 *
 * The baseline in scripts/data/taste-benchmark.baseline.json is the committed
 * score. This suite re-runs the REAL pipeline over the REAL case set and fails
 * on ANY drift that is not timing — a moved winner hash, a lost rationale, a
 * flipped check, or the ranker path changing under the benchmark. Improvements
 * are re-blessed deliberately via `npx vite-node scripts/taste-benchmark.mts
 * --write`, never by editing the baseline by hand.
 */

const BASELINE_PATH = path.resolve("scripts/data/taste-benchmark.baseline.json");

function readBaseline(): TasteBenchmarkReport & { humanGrades?: unknown } {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as TasteBenchmarkReport & { humanGrades?: unknown };
}

async function realRunner(benchCase: TasteBenchmarkCase): Promise<TasteBenchmarkObservation> {
  const started = Date.now();
  const doc = createDefaultProject();
  const parsed = parseIntentText(benchCase.prompt);
  const input = {
    ...(parsed?.input ?? {}),
    seed: `taste-benchmark:${benchCase.id}`,
    candidateCount: TASTE_BENCHMARK_CANDIDATE_COUNT,
    symbolicCandidates: 0,
    roles: ["drums", "bass"],
  } as Parameters<typeof generateAsyncResult>[1];
  const result = await generateAsyncResult(doc, input, { mode: "apply", includeBank: true });
  const selected = result.bank?.[0] ?? null;
  return {
    status: result.status,
    accepted: result.proposal != null,
    genre: result.plan.intent.genre ?? null,
    bpm: result.plan.resolvedBpm ?? null,
    candidates: result.bank?.length ?? 0,
    selectedHash: selected?.contentHash ?? null,
    rationale: result.selection?.rationale ?? null,
    rankerMode: String(result.selection?.mode ?? "unknown"),
    rankerSource: String(result.selection?.source ?? "unknown"),
    ms: Date.now() - started,
  };
}

describe("taste benchmark — the committed baseline holds", () => {
  it("reproduces the committed baseline exactly (timing excluded)", async () => {
    const baseline = readBaseline();
    expect(baseline.harness).toBe(TASTE_BENCHMARK_HARNESS);
    // The honest empty: no machine ever claims to have graded taste.
    expect(baseline.humanGrades ?? null).toBeNull();

    const report = await runTasteBenchmark(realRunner, {
      cases: baseline.rows.length > 0 ? TASTE_BENCHMARK_CASES : [],
    });
    const drift = diffTasteBenchmark(baseline, report);
    expect(drift, JSON.stringify(drift, null, 2)).toEqual([]);
    expect(report.summary.score).toBe(baseline.summary.score);
    expect(report.summary.deterministic).toBe(true);
  }, 120_000);

  it("keeps every case's rationale attached (the E1 loop stays wired)", async () => {
    const baseline = readBaseline();
    for (const row of baseline.rows) {
      expect(row.rationale, `${row.id} must carry a rationale`).toBeTruthy();
      expect(row.checks.rationale).toBe(true);
    }
  });
});

describe("taste benchmark — the harness grades honestly", () => {
  const caseA: TasteBenchmarkCase = { id: "case-a", prompt: "house", expectGenre: "house", expectMinCandidates: 2 };

  function observation(overrides: Partial<TasteBenchmarkObservation> = {}): TasteBenchmarkObservation {
    return {
      status: "accepted",
      accepted: true,
      genre: "house",
      bpm: 124,
      candidates: 4,
      selectedHash: "hash-1",
      rationale: "Highest deterministic fit score in the bank (0.9).",
      rankerMode: "active",
      rankerSource: "fallback",
      ms: 5,
      ...overrides,
    };
  }

  it("fails the determinism check when the second run picks a different winner", async () => {
    let call = 0;
    const report = await runTasteBenchmark(
      async () => {
        call += 1;
        return observation({ selectedHash: call === 1 ? "hash-1" : "hash-2" });
      },
      { cases: [caseA] },
    );
    expect(report.rows[0]!.checks.deterministic).toBe(false);
    expect(report.summary.deterministic).toBe(false);
    expect(report.summary.score).toBeLessThan(1);
  });

  it("fails the genre and candidate checks instead of smoothing them over", async () => {
    const report = await runTasteBenchmark(async () => observation({ genre: "techno", candidates: 1 }), {
      cases: [caseA],
    });
    expect(report.rows[0]!.checks.genre).toBe(false);
    expect(report.rows[0]!.checks.candidates).toBe(false);
    expect(report.rows[0]!.checks.accepted).toBe(true);
  });

  it("fails the rationale check when the why is missing", async () => {
    const report = await runTasteBenchmark(async () => observation({ rationale: null }), { cases: [caseA] });
    expect(report.rows[0]!.checks.rationale).toBe(false);
  });

  it("skips the expectations a case does not claim", async () => {
    const report = await runTasteBenchmark(async () => observation({ genre: null, candidates: 1 }), {
      cases: [{ id: "bare", prompt: "something" }],
    });
    expect(report.rows[0]!.checks.genre).toBe(true);
    expect(report.rows[0]!.checks.candidates).toBe(true);
  });
});

describe("taste benchmark — drift detection", () => {
  function reportWith(overrides: Partial<TasteBenchmarkReport["rows"][number]>): TasteBenchmarkReport {
    return {
      harness: TASTE_BENCHMARK_HARNESS,
      generatedAt: "2026-10-17T00:00:00.000Z",
      mode: "deterministic-core",
      rows: [
        {
          id: "row-1",
          prompt: "house",
          checks: { accepted: true, genre: true, candidates: true, deterministic: true, rationale: true },
          genre: "house",
          bpm: 124,
          candidates: 4,
          selectedHash: "hash-1",
          secondRunHash: "hash-1",
          rationale: "Highest deterministic fit score in the bank (0.9).",
          rankerMode: "active",
          rankerSource: "fallback",
          ms: 5,
          ...overrides,
        },
      ],
      summary: { score: 1, checksPassed: 5, checksTotal: 5, deterministic: true, prompts: 1, p95Ms: 5 },
    };
  }

  it("reports a moved winner hash, a lost rationale and a flipped check", () => {
    const baseline = reportWith({});
    const current = reportWith({
      selectedHash: "hash-2",
      rationale: null,
      checks: { accepted: true, genre: true, candidates: true, deterministic: true, rationale: false },
    });
    current.summary = { ...current.summary, score: 0.8, checksPassed: 4 };
    const drift = diffTasteBenchmark(baseline, current);
    expect(drift.map((entry) => entry.field).sort()).toEqual([
      "checks.rationale",
      "rationale",
      "selectedHash",
      "summary.score",
    ]);
  });

  it("reports the ranker path changing under the benchmark", () => {
    const baseline = reportWith({});
    const current = reportWith({ rankerSource: "model" });
    const drift = diffTasteBenchmark(baseline, current);
    expect(drift.some((entry) => entry.field === "rankerSource")).toBe(true);
  });

  it("reports added and removed cases", () => {
    const baseline = reportWith({});
    const current = reportWith({ id: "row-2" });
    const drift = diffTasteBenchmark(baseline, current);
    expect(drift.filter((entry) => entry.field === "row")).toHaveLength(2);
  });

  it("ignores timing differences", () => {
    const baseline = reportWith({});
    const current = reportWith({ ms: 999 });
    current.summary = { ...current.summary, p95Ms: 999 };
    expect(diffTasteBenchmark(baseline, current)).toEqual([]);
  });
});
