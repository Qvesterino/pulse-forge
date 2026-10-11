/**
 * INTENT MINING CYCLE — the mining→retraining loop as ONE command.
 *
 *   npm run intent:cycle                       # collect + classify + report
 *   npm run intent:cycle -- --from export.json # read a specific export
 *   npm run intent:cycle -- --train            # + dataset → train → gate
 *
 * The producer's side: play, let the panel mine (every clarify and
 * model-miss lands in the local ring buffer), then devtools
 * `__kyxIntentFailures.export()` → save as scripts/data/intent-mined.json.
 * This script turns that export into:
 *
 *   scripts/data/intent-mined-corpus.json   — resolved rows for the dataset
 *   scripts/data/intent-cycle-report.json   — the full classification report
 *
 * RESOLVED rows (mined prompts that TODAY route to a real action) feed the
 * dataset generator as teacher pairs — every past failure the engine learned
 * to handle becomes a pinned regression row. STILL-FAILING rows are the
 * human work list (label them or fix the engine). --train chains
 * intent:dataset → intent-model:train → intent-model:validate (the gate);
 * python/GPU is the training machine's prerequisite, missing env fails the
 * step HONESTLY without touching the shipped model artifact.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMiningCycleReport, buildMinedCorpus, guessLang } from "../src/intent/mining-cycle";
import type { IntentMiningEvent } from "../src/intent/failure-log";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const withTrain = args.has("--train");
const explicitFrom = process.argv.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
const fromPath = explicitFrom ?? path.join(ROOT, "scripts", "data", "intent-mined.json");
const dataDir = path.join(ROOT, "scripts", "data");

if (!existsSync(fromPath)) {
  console.error(`[intent-cycle] no mining export at ${path.relative(ROOT, fromPath)}`);
  console.error("[intent-cycle] in the browser: devtools → __kyxIntentFailures.export() → save it there.");
  process.exit(1);
}

const parsed: unknown = JSON.parse(readFileSync(fromPath, "utf8"));
const events: IntentMiningEvent[] = Array.isArray(parsed)
  ? (parsed as IntentMiningEvent[])
  : ((parsed as { events?: IntentMiningEvent[] }).events ?? []);

if (events.length === 0) {
  console.error("[intent-cycle] the export contains no events — mine first (play, miss, export).");
  process.exit(1);
}

// The routing doc: the FIXED dataset document keeps the classification
// stable across runs (the same convention the dataset teacher uses).
const { datasetDoc } = await import("./intent-sft-doc.mts");
const doc = datasetDoc();

const report = buildMiningCycleReport(events, doc);

console.log(
  `[intent-cycle] events: ${report.totalEvents} · unique misses: ${report.misses} · model hits: ${report.modelHits}`,
);
console.log(`[intent-cycle] RESOLVED (dataset-ready): ${report.resolved.length}`);
for (const row of report.resolved.slice(0, 15)) {
  console.log(`  ✓ ${row.hits}× "${row.prompt}" → ${row.routeKind} (${row.routed})`);
}
if (report.resolved.length > 15) console.log(`  … +${report.resolved.length - 15} more`);
console.log(`[intent-cycle] STILL-FAILING (human work): ${report.stillFailing.length}`);
for (const row of report.stillFailing.slice(0, 15)) {
  console.log(`  ✗ ${row.hits}× "${row.prompt}" → ${row.routeKind}`);
}
if (report.stillFailing.length > 15) console.log(`  … +${report.stillFailing.length - 15} more`);

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const corpus = buildMinedCorpus(report);
corpus.generatedAt = Date.now();
const corpusPath = path.join(dataDir, "intent-mined-corpus.json");
writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
const reportPath = path.join(dataDir, "intent-cycle-report.json");
writeFileSync(reportPath, JSON.stringify({ ...report, generatedAt: Date.now() }, null, 2));
console.log(`[intent-cycle] wrote ${path.relative(ROOT, corpusPath)} (${corpus.rows.length} rows)`);
console.log(`[intent-cycle] wrote ${path.relative(ROOT, reportPath)}`);

// LANG guess sanity: the corpus module guesses per row; the report mirrors it.
if (corpus.rows.length > 0) {
  const sk = corpus.rows.filter((row) => guessLang(row.instruction) === "sk").length;
  console.log(`[intent-cycle] langs: ${corpus.rows.length - sk} en / ${sk} sk`);
}

if (!withTrain) {
  console.log("[intent-cycle] next: npm run intent:dataset (picks up the mined corpus), then intent:cycle -- --train");
  process.exit(0);
}

// ── TRAIN CHAIN — the same commands the manual loop ran, gated honestly. ──
const chain: Array<[string, string[]]> = [
  ["intent:dataset", ["npm", "run", "intent:dataset"]],
  ["intent-model:train", ["npm", "run", "intent-model:train"]],
  ["intent-model:validate", ["npm", "run", "intent-model:validate"]],
];
for (const [label, command] of chain) {
  console.log(`[intent-cycle] ${label}…`);
  const run = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: "inherit", shell: true });
  if (run.status !== 0) {
    console.error(
      `[intent-cycle] ${label} FAILED (exit ${run.status}) — the shipped model artifact is untouched; fix and re-run.`,
    );
    process.exit(1);
  }
}
console.log(
  "[intent-cycle] train + gate complete — a NEW gatePassed artifact is validated; ship it via the manifest regen flow.",
);
