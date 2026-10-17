/**
 * Status report generator (Prestige plan §2.2).
 *
 *   npm run status:report            → run the cheap claims, rewrite docs/STATUS.md + docs/status.json
 *   npm run status:report -- --check → run the cheap claims and DIFF the stable payload against the
 *                                      committed status.json (the drift section calls this)
 *
 * Only cheap, deterministic claims run here (seam coverage, spec counts, the
 * taste benchmark, the protocol end-to-end). Anything slow is LISTED with its
 * command and never implied to have run — see src/services/statusReport.ts for
 * the honesty rules this generator feeds.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStatusReport, type ManualGate, type StatusClaim } from "../src/services/statusReport";
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
import { parseIntentText } from "../src/intent/text-parser";
import { generateAsyncResult } from "../src/intent/pipeline";
import { createDefaultProject } from "../src/project-model/schema";

const STATUS_JSON = path.resolve("docs/status.json");
const STATUS_MD = path.resolve("docs/STATUS.md");
const MANUAL_GATES = path.resolve("docs/status/manual-gates.json");

function run(command: string, args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function claim(
  id: string,
  text: string,
  command: string,
  result: { code: number; output: string },
  summarize: (output: string) => string,
): StatusClaim {
  return {
    id,
    claim: text,
    command,
    state: result.code === 0 ? "pass" : "fail",
    summary: summarize(result.output),
    freshness: "drift-checked",
  };
}

function seamClaim(): StatusClaim {
  const command = "node scripts/check-seam-coverage.mjs";
  const result = run(process.execPath, ["scripts/check-seam-coverage.mjs"]);
  return claim(
    "seam-coverage",
    "Every user-facing seam is declared with an entry-point spec and a negative assertion",
    command,
    result,
    (output) => {
      const match = output.match(/SEAM COVERAGE GATE (PASSED|FAILED) — (\d+) checks, (\d+) seams/);
      return match ? `${match[2]} check(s), ${match[3]} seams` : `exit ${result.code}`;
    },
  );
}

function countsClaim(): StatusClaim {
  const command = "git ls-files tests (spec-file count vs docs/CURRENT-STATE.md)";
  const listed = run("git", ["ls-files", "tests"]);
  const files = listed.output.split("\n").filter(Boolean);
  const measured = files.filter(
    (file) => (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) && !file.startsWith("tests/e2e/"),
  ).length;
  const state = readFileSync("docs/CURRENT-STATE.md", "utf8");
  const row = state.split("\n").find((line) => line.includes("Vitest spec files")) ?? "";
  const claimed = Number((row.match(/\*\*(\d+)\*\*/) ?? [])[1] ?? Number.NaN);
  const pass = Number.isFinite(claimed) && claimed === measured;
  return {
    id: "spec-counts",
    claim: "docs/CURRENT-STATE.md's spec-file count equals the committed tree",
    command,
    state: pass ? "pass" : "fail",
    summary: `${claimed} claimed, ${measured} measured`,
    freshness: "drift-checked",
  };
}

async function tasteClaim(): Promise<StatusClaim> {
  const command = "npm run taste:benchmark (harness re-run + committed baseline diff)";
  const runCase = async (benchCase: TasteBenchmarkCase): Promise<TasteBenchmarkObservation> => {
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
  };
  const baseline = JSON.parse(
    readFileSync("scripts/data/taste-benchmark.baseline.json", "utf8"),
  ) as TasteBenchmarkReport;
  const report = await runTasteBenchmark(runCase, { cases: TASTE_BENCHMARK_CASES });
  const drift = diffTasteBenchmark(baseline, report);
  return {
    id: "taste-benchmark",
    claim: "The deterministic taste benchmark still matches its committed baseline",
    command,
    state: drift.length === 0 && report.harness === TASTE_BENCHMARK_HARNESS ? "pass" : "fail",
    summary: `score ${report.summary.score} · deterministic=${report.summary.deterministic} · ${drift.length} drift row(s)`,
    freshness: "drift-checked",
  };
}

function protocolClaim(): StatusClaim {
  const command =
    "npm run verify:wav:fixture -- <tmp>/stamped.wav && node tools/kyx-verify/kyx-verify.mjs <tmp>/stamped.wav";
  const dir = mkdtempSync(path.join(tmpdir(), "kyx-status-"));
  const wav = path.join(dir, "stamped.wav");
  // vite-node's own entry, not `npx`: npx is a .cmd shim on Windows and needs a
  // shell, which execFileSync refuses (and `shell: true` is a security smell).
  const fixture = run(process.execPath, [
    "node_modules/vite-node/vite-node.mjs",
    "scripts/make-stamped-wav-fixture.mts",
    wav,
  ]);
  if (fixture.code !== 0) {
    return {
      id: "protocol-end-to-end",
      claim: "A stamped master verifies offline with the published verifier",
      command,
      state: "fail",
      summary: `fixture failed (exit ${fixture.code})`,
      freshness: "drift-checked",
    };
  }
  const verified = run(process.execPath, ["tools/kyx-verify/kyx-verify.mjs", wav]);
  const ok = verified.code === 0 && verified.output.includes("VERIFIED");
  return {
    id: "protocol-end-to-end",
    claim: "A stamped master verifies offline with the published verifier",
    command,
    state: ok ? "pass" : "fail",
    summary: ok ? "VERIFIED (exit 0, hash recomputed from the file)" : `exit ${verified.code}`,
    freshness: "drift-checked",
  };
}

function manualGates(): ManualGate[] {
  try {
    const parsed = JSON.parse(readFileSync(MANUAL_GATES, "utf8")) as { gates?: ManualGate[] };
    return (parsed.gates ?? []).map((gate) => ({
      id: gate.id,
      claim: gate.claim,
      command: gate.command,
      state: gate.state === "pass" || gate.state === "fail" ? gate.state : "pending",
      note: typeof gate.note === "string" ? gate.note : "",
    }));
  } catch {
    return [];
  }
}

const claims: StatusClaim[] = [seamClaim(), countsClaim(), await tasteClaim(), protocolClaim()];
const report = buildStatusReport({
  generatedAt: new Date(),
  claims,
  manualGates: manualGates(),
  runByCi: [
    { claim: "Strict typecheck", command: "npm run typecheck" },
    { claim: "Full Vitest suite + expectations ledger", command: "npm run test:expectations" },
    { claim: "All derivable artifacts (mirrors, goldens, counts)", command: "npm run drift:check" },
    { claim: "Golden doctor (frozen artifacts match their hashes)", command: "npm run goldens:doctor" },
    { claim: "Production build + bundle budgets", command: "npm run build" },
    { claim: "Real-browser audio verifier", command: "npm run test:browser" },
  ],
});

const checkMode = process.argv.includes("--check");
if (checkMode) {
  const committed = JSON.parse(readFileSync(STATUS_JSON, "utf8")) as { claims?: StatusClaim[] };
  const fresh = report.json.claims;
  const same = JSON.stringify(committed.claims ?? []) === JSON.stringify(fresh);
  if (!same) {
    console.error("[status] DRIFT — docs/status.json is stale against a live run:");
    console.error(`  committed: ${JSON.stringify(committed.claims ?? [])}`);
    console.error(`  live:      ${JSON.stringify(fresh)}`);
    process.exit(1);
  }
  console.log("[status] no drift — docs/status.json matches a live check of the cheap claims");
} else {
  mkdirSync(path.dirname(STATUS_JSON), { recursive: true });
  writeFileSync(STATUS_JSON, `${JSON.stringify(report.json, null, 2)}\n`, "utf8");
  writeFileSync(STATUS_MD, `${report.markdown}\n`, "utf8");
  console.log(report.markdown);
  console.log(`\nwrote docs/status.json + docs/STATUS.md (${report.counts.pass} pass, ${report.counts.fail} fail)`);
}
