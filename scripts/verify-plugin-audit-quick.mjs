/**
 * Quick plugin-audit gate — validates the COMMITTED report without re-rendering.
 *
 * A full audit takes about an hour (57 effects, 25 instruments, a param sweep
 * each). That is the right price for evidence, and the wrong price for a gate
 * someone actually runs. This checks the report that is already on disk in
 * seconds, which is what makes "the audit stops rotting" enforceable rather than
 * aspirational.
 *
 * The load-bearing part is the harness fingerprint. If the measuring code
 * changed since the report was written, the report is not evidence any more —
 * not because it is old, but because its numbers mean something else. That is
 * the failure this whole chain started from: a report full of rows measured
 * while the offline render was returning silence, every one of which passed
 * every health filter.
 *
 * Usage: node scripts/verify-plugin-audit-quick.mjs [report-path]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeHarnessHash, evaluateAuditGate } from "./lib/plugin-audit-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "docs", "plugin-audit-2026-09-27.report.json");

if (!fs.existsSync(reportPath)) {
  console.error(`[gate] no report at ${reportPath} — run: npm run test:browser:plugin-audit`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`[gate] report is not readable JSON: ${String(error).slice(0, 200)}`);
  process.exit(1);
}

const current = computeHarnessHash(root);
const recorded = report.harness ?? null;

if (recorded !== current) {
  console.error(
    `[gate] STALE REPORT — it was measured by harness ${recorded ?? "unfingerprinted"}, current is ${current}.`,
  );
  console.error("[gate] Its numbers describe different code. Re-run: npm run test:browser:plugin-audit");
  process.exit(1);
}

if (!report.finishedAt) {
  console.error(
    "[gate] report has no finishedAt — the last run did not complete. Re-run: npm run test:browser:plugin-audit",
  );
  process.exit(1);
}

const gate = evaluateAuditGate(report);
const { stats } = gate;

console.log(`[gate] report: ${path.relative(root, reportPath)}`);
console.log(`[gate] measured by harness ${recorded}, finished ${report.finishedAt}`);
console.log(
  `[gate] ${stats.effects} effects, ${stats.instruments} instruments, interactions ${stats.interactions ? "yes" : "MISSING"}`,
);
console.log(
  `[gate] ${stats.deadParameters} dead parameters across ${stats.deadByEffect.filter((e) => e.dead > 0).length} effects`,
);
if (stats.notProcessing.length > 0) {
  console.log(
    `[gate] not processing in the host graph (${stats.notProcessing.length}): ${stats.notProcessing.join(", ")}`,
  );
}
if (stats.silentInstruments.length > 0) {
  console.log(`[gate] silent by default (${stats.silentInstruments.length}): ${stats.silentInstruments.join(", ")}`);
}

if (!gate.ok) {
  console.error(`[gate] FAILED — ${gate.failures.length} problem(s):`);
  for (const failure of gate.failures.slice(0, 25)) console.error(`  ! ${failure}`);
  process.exit(1);
}

console.log(`[gate] PASSED — every measured effect processed and stayed finite`);
