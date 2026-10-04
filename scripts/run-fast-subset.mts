/**
 * `npm run test:fast` — the every-commit Vitest subset.
 *
 * Runs the curated FAST_SUBSET with a hard wall-clock budget. The budget is
 * deliberately generous (180 s) because shared CI/dev machines are often
 * co-tenanted; the point of the gate is "fails fast on the invariants", not
 * a stopwatch. When the budget is exceeded the script still reports the real
 * Vitest result and exits non-zero with a clear message so the subset can be
 * re-tuned instead of silently ignored.
 *
 * Usage:
 *   npm run test:fast
 *   npm run test:fast -- --budget=120
 *   npm run test:fast -- --list
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FAST_SUBSET, FAST_SUBSET_MAX_FILES } from "../src/testing/fast-subset";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const budgetArg = argv.find((a) => a.startsWith("--budget="));
const budgetSec = budgetArg ? Number(budgetArg.slice("--budget=".length)) : 180;
const listOnly = argv.includes("--list");

if (listOnly) {
  for (const file of FAST_SUBSET) console.log(file);
  process.exit(0);
}

if (FAST_SUBSET.length > FAST_SUBSET_MAX_FILES) {
  console.error(
    `[test:fast] FAST_SUBSET has ${FAST_SUBSET.length} files (ceiling ${FAST_SUBSET_MAX_FILES}). ` +
      "The subset must stay fast — remove entries instead of raising the ceiling.",
  );
  process.exit(1);
}

const missing = FAST_SUBSET.filter((rel) => !existsSync(path.join(root, rel)));
if (missing.length > 0) {
  console.error(`[test:fast] FAST_SUBSET references missing files:\n  ${missing.join("\n  ")}`);
  console.error("Fix src/testing/fast-subset.ts (the guard test would catch this in the full suite).");
  process.exit(1);
}

const started = Date.now();
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestBin, "run", ...FAST_SUBSET], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, FAST_SUBSET_RUN: "1" },
});
const elapsedSec = (Date.now() - started) / 1000;
const status = result.status ?? 1;

console.log(
  `\n[test:fast] ${FAST_SUBSET.length} files in ${elapsedSec.toFixed(1)}s ` +
    `(budget ${budgetSec}s) — ${status === 0 ? "PASS" : "FAIL"}`,
);
if (status === 0 && elapsedSec > budgetSec) {
  console.error(
    `[test:fast] Budget exceeded: ${elapsedSec.toFixed(1)}s > ${budgetSec}s. ` +
      "Trim the subset or move slow specs to the release gate.",
  );
  process.exit(1);
}
process.exit(status);
