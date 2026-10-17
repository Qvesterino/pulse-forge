/**
 * TASTE BENCHMARK (Wave E2) — a fixed prompt set, run end-to-end through the
 * REAL deterministic intent pipeline, scored against objective invariants and
 * compared to a committed baseline.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * This is NOT a claim about musical quality — no automated metric can grade
 * taste. What it grades is what CAN be proven: that a named genre lands in the
 * right genre, that a multi-candidate run actually produces a bank, that the
 * same seed reproduces the same winner (determinism), and that the E1 rationale
 * is present (the loop between "how it was chosen" and "why is explained" is
 * wired). Quality grading needs the human protocol in
 * `scripts/data/taste-benchmark.baseline.json#humanGrades`, which this harness
 * deliberately leaves empty rather than faking.
 *
 * The benchmark runs the DETERMINISTIC core on purpose (no symbolic prior, no
 * ONNX ranker): a model-dependent score could not be a stable committed
 * baseline, and a benchmark that drifts with a model swap would be noise, not
 * a regression signal. Each observation records the ranker mode it actually
 * ran under, so the report can never silently change meaning.
 *
 * Every case runs TWICE: the second run must reproduce the first run's winner
 * hash, otherwise the `deterministic` check fails.
 */

import type { Genre } from "../ai/types";

export const TASTE_BENCHMARK_HARNESS = "taste-benchmark.v1";
/** Multi-candidate runs need this many candidates to build a bank at all. */
export const TASTE_BENCHMARK_CANDIDATE_COUNT = 4;

export interface TasteBenchmarkCase {
  id: string;
  /** Free text, exactly as a user would type it (EN and SK both shipped). */
  prompt: string;
  /** Genre the prompt NAMES. Omitted when the prompt does not name one. */
  expectGenre?: Genre;
  /** How many candidates must survive the gates for the bank to be usable. */
  expectMinCandidates?: number;
}

/**
 * The fixed set. Prompts name their genre explicitly — the check is what the
 * prompt SAYS, not what the author hoped the parser would infer.
 */
export const TASTE_BENCHMARK_CASES: readonly TasteBenchmarkCase[] = [
  { id: "house-classic", prompt: "classic house beat at 124 BPM", expectGenre: "house", expectMinCandidates: 2 },
  {
    id: "techno-peak",
    prompt: "peak time techno, 140 BPM, hypnotic and driving",
    expectGenre: "techno",
    expectMinCandidates: 2,
  },
  { id: "trap-dark", prompt: "dark trap beat with 808 slides", expectGenre: "trap", expectMinCandidates: 2 },
  { id: "drill-uk", prompt: "UK drill, sliding 808 bass, 145 BPM", expectGenre: "drill", expectMinCandidates: 2 },
  {
    id: "ambient-drift",
    prompt: "ambient atmosphere, slow drifting pads",
    expectGenre: "ambient",
    expectMinCandidates: 2,
  },
  { id: "dnb-roller", prompt: "liquid drum and bass roller at 174 BPM", expectGenre: "dnb", expectMinCandidates: 2 },
  {
    id: "phonk-memphis",
    prompt: "memphis phonk, cowbell, dark and lo-fi",
    expectGenre: "phonk",
    expectMinCandidates: 2,
  },
  {
    id: "jersey-club",
    prompt: "jersey club, bed squeak sample, 135 BPM",
    expectGenre: "jersey",
    expectMinCandidates: 2,
  },
  { id: "sk-house", prompt: "sprav mi house beat s energickym klavirom", expectGenre: "house", expectMinCandidates: 2 },
  { id: "sk-trap", prompt: "trap v style tmavej noci, tazke 808", expectGenre: "trap", expectMinCandidates: 2 },
];

/** One execution of one case — what the runner observed. */
export interface TasteBenchmarkObservation {
  /** Generation status after repairs/gates ("accepted" | "repaired" | "fallback" | "rejected"). */
  status: string;
  accepted: boolean;
  genre: string | null;
  bpm: number | null;
  candidates: number;
  /** contentHash of the winning candidate — the determinism anchor. */
  selectedHash: string | null;
  /** E1 rationale attached to the selection (must never be empty). */
  rationale: string | null;
  /** Ranker mode the run actually executed under. */
  rankerMode: string;
  /** Who produced the order: "model" or "fallback" (heuristic). A committed
   *  baseline from the fallback path stays comparable only on that path —
   *  a model appearing later shows up as drift on this field, not as noise. */
  rankerSource: string;
  ms: number;
}

export type TasteBenchmarkRunner = (benchCase: TasteBenchmarkCase) => Promise<TasteBenchmarkObservation>;

export interface TasteBenchmarkRow {
  id: string;
  prompt: string;
  checks: Record<string, boolean>;
  genre: string | null;
  bpm: number | null;
  candidates: number;
  selectedHash: string | null;
  /** The determinism check's evidence: the same case run a second time. */
  secondRunHash: string | null;
  rationale: string | null;
  rankerMode: string;
  rankerSource: string;
  /** Informational only — excluded from baseline comparison. */
  ms: number;
}

export interface TasteBenchmarkReport {
  harness: string;
  generatedAt: string;
  mode: "deterministic-core";
  rows: TasteBenchmarkRow[];
  /**
   * Human grading lives HERE and only here — filled by the listening protocol
   * (same shape as the mastering preference packs), never by the harness. An
   * empty/null value is the honest state: no automated metric grades taste.
   */
  humanGrades?: unknown;
  summary: {
    /** Fraction of objective checks that passed. */
    score: number;
    checksPassed: number;
    checksTotal: number;
    /** Every case reproduced its own winner hash on the second run. */
    deterministic: boolean;
    prompts: number;
    /** Informational only — excluded from baseline comparison. */
    p95Ms: number;
  };
}

/** Checks a row is graded on, in report order. */
export const TASTE_BENCHMARK_CHECK_NAMES = ["accepted", "genre", "candidates", "deterministic", "rationale"] as const;

function gradeRow(
  benchCase: TasteBenchmarkCase,
  first: TasteBenchmarkObservation,
  second: TasteBenchmarkObservation,
): TasteBenchmarkRow {
  const deterministic = first.selectedHash != null && first.selectedHash === second.selectedHash;
  const checks: Record<string, boolean> = {
    accepted: first.accepted,
    // Skipped expectations are recorded as passed — they were not claimed.
    genre: benchCase.expectGenre === undefined || first.genre === benchCase.expectGenre,
    candidates: benchCase.expectMinCandidates === undefined || first.candidates >= benchCase.expectMinCandidates,
    deterministic,
    rationale: first.rationale != null && first.rationale.length > 0,
  };
  return {
    id: benchCase.id,
    prompt: benchCase.prompt,
    checks,
    genre: first.genre,
    bpm: first.bpm,
    candidates: first.candidates,
    selectedHash: first.selectedHash,
    secondRunHash: second.selectedHash,
    rationale: first.rationale,
    rankerMode: first.rankerMode,
    rankerSource: first.rankerSource,
    ms: first.ms,
  };
}

export async function runTasteBenchmark(
  runner: TasteBenchmarkRunner,
  options: { now?: Date; cases?: readonly TasteBenchmarkCase[] } = {},
): Promise<TasteBenchmarkReport> {
  const cases = options.cases ?? TASTE_BENCHMARK_CASES;
  const rows: TasteBenchmarkRow[] = [];
  for (const benchCase of cases) {
    const first = await runner(benchCase);
    const second = await runner(benchCase);
    rows.push(gradeRow(benchCase, first, second));
  }
  let checksPassed = 0;
  let checksTotal = 0;
  for (const row of rows) {
    for (const name of TASTE_BENCHMARK_CHECK_NAMES) {
      checksTotal += 1;
      if (row.checks[name] === true) checksPassed += 1;
    }
  }
  const timings = rows.map((row) => row.ms).sort((a, b) => a - b);
  const p95Index = timings.length === 0 ? 0 : Math.min(timings.length - 1, Math.floor(timings.length * 0.95));
  return {
    harness: TASTE_BENCHMARK_HARNESS,
    generatedAt: (options.now ?? new Date()).toISOString(),
    mode: "deterministic-core",
    rows,
    summary: {
      score: checksTotal === 0 ? 0 : Math.round((checksPassed / checksTotal) * 10_000) / 10_000,
      checksPassed,
      checksTotal,
      deterministic: rows.every((row) => row.checks.deterministic === true),
      prompts: rows.length,
      p95Ms: timings[p95Index] ?? 0,
    },
  };
}

/**
 * Compare a fresh report against a committed baseline. Ignores timing; ANY
 * other difference is drift: a changed winner hash, a lost rationale, a check
 * that flipped. Improvements are re-blessed deliberately
 * (`npx vite-node scripts/taste-benchmark.mts --write`), never silently.
 */
export interface TasteBenchmarkDrift {
  id: string;
  field: string;
  baseline: unknown;
  current: unknown;
}

export function diffTasteBenchmark(
  baseline: TasteBenchmarkReport,
  current: TasteBenchmarkReport,
): TasteBenchmarkDrift[] {
  const drift: TasteBenchmarkDrift[] = [];
  if (baseline.summary.score !== current.summary.score) {
    drift.push({ id: "*", field: "summary.score", baseline: baseline.summary.score, current: current.summary.score });
  }
  const byId = new Map(current.rows.map((row) => [row.id, row]));
  for (const baseRow of baseline.rows) {
    const currentRow = byId.get(baseRow.id);
    if (currentRow == null) {
      drift.push({ id: baseRow.id, field: "row", baseline: "present", current: "missing" });
      continue;
    }
    for (const field of [
      "genre",
      "bpm",
      "candidates",
      "selectedHash",
      "rationale",
      "rankerMode",
      "rankerSource",
    ] as const) {
      if (baseRow[field] !== currentRow[field]) {
        drift.push({ id: baseRow.id, field, baseline: baseRow[field], current: currentRow[field] });
      }
    }
    for (const name of TASTE_BENCHMARK_CHECK_NAMES) {
      if (baseRow.checks[name] !== currentRow.checks[name]) {
        drift.push({
          id: baseRow.id,
          field: `checks.${name}`,
          baseline: baseRow.checks[name],
          current: currentRow.checks[name],
        });
      }
    }
  }
  for (const currentRow of current.rows) {
    if (!baseline.rows.some((row) => row.id === currentRow.id)) {
      drift.push({ id: currentRow.id, field: "row", baseline: "missing", current: "present" });
    }
  }
  return drift;
}
