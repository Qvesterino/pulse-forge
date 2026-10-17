/**
 * Taste benchmark CLI (Wave E2).
 *
 *   npx vite-node scripts/taste-benchmark.mts          → run + compare to the
 *                                                        committed baseline;
 *                                                        exit 1 on any drift
 *   npx vite-node scripts/taste-benchmark.mts --write  → re-bless the baseline
 *                                                        (preserves humanGrades)
 *
 * The runner is the REAL deterministic pipeline: parser → plan → candidates →
 * gates → ranker (heuristic in this environment) → E1 rationale. No symbolic
 * prior, no ONNX, no network. See src/intent/taste-benchmark.ts for what the
 * score does and does not claim.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDefaultProject } from "../src/project-model/schema";
import { parseIntentText } from "../src/intent/text-parser";
import { generateAsyncResult } from "../src/intent/pipeline";
import {
  TASTE_BENCHMARK_CANDIDATE_COUNT,
  diffTasteBenchmark,
  runTasteBenchmark,
  type TasteBenchmarkCase,
  type TasteBenchmarkObservation,
  type TasteBenchmarkReport,
} from "../src/intent/taste-benchmark";

const BASELINE_PATH = path.resolve("scripts/data/taste-benchmark.baseline.json");

function readBaseline(): (TasteBenchmarkReport & { humanGrades?: unknown }) | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as TasteBenchmarkReport & { humanGrades?: unknown };
  } catch {
    return null;
  }
}

async function runCase(benchCase: TasteBenchmarkCase): Promise<TasteBenchmarkObservation> {
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

function printReport(report: TasteBenchmarkReport): void {
  for (const row of report.rows) {
    const marks = Object.entries(row.checks)
      .map(([name, ok]) => `${ok ? "✓" : "✗"} ${name}`)
      .join("  ");
    console.log(
      `${row.checks.accepted && row.checks.genre && row.checks.candidates ? "✓" : "✗"} ${row.id.padEnd(14)} ${marks}`,
    );
    console.log(
      `   genre=${row.genre} bpm=${row.bpm} candidates=${row.candidates} ranker=${row.rankerMode}/${row.rankerSource}`,
    );
    console.log(`   why: ${row.rationale ?? "(none)"}`);
  }
  const modes = [...new Set(report.rows.map((row) => `${row.rankerMode}/${row.rankerSource}`))];
  console.log(
    `\nscore ${report.summary.score} (${report.summary.checksPassed}/${report.summary.checksTotal} checks) · ` +
      `deterministic=${report.summary.deterministic} · prompts=${report.summary.prompts} · p95 ${report.summary.p95Ms} ms · ranker ${modes.join(",")}`,
  );
}

const report = await runTasteBenchmark(runCase);

if (process.argv.includes("--write")) {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  const previous = readBaseline();
  const payload = {
    ...report,
    // Never wipe human work with a machine re-bless.
    humanGrades: previous?.humanGrades ?? null,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  printReport(report);
  console.log(`\nbaseline written: ${path.relative(process.cwd(), BASELINE_PATH)}`);
} else {
  const baseline = readBaseline();
  if (baseline == null) {
    console.error(
      `No baseline at ${path.relative(process.cwd(), BASELINE_PATH)} — run with --write after reviewing the report.`,
    );
    process.exit(1);
  }
  printReport(report);
  const drift = diffTasteBenchmark(baseline, report);
  if (drift.length > 0) {
    console.error(`\nDRIFT vs baseline (${drift.length}):`);
    for (const entry of drift) {
      console.error(
        `  ${entry.id} · ${entry.field}: ${JSON.stringify(entry.baseline)} → ${JSON.stringify(entry.current)}`,
      );
    }
    console.error("Review the report, then re-bless deliberately with --write.");
    process.exit(1);
  }
  console.log("\nNo drift vs baseline.");
}
