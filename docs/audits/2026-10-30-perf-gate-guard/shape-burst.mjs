/**
 * The FALSIFICATION AXIS for the perf gate that reads the shape of the render
 * distribution.
 *
 * It replays each measured 14-template corpus with ONE template 2.6x slower —
 * the per-item spread actually measured on this repo (the same template
 * measured 6642 ms and 17460 ms in two adjacent runs) — and asks which
 * statistic would have gone red at the 3x budget.
 *
 * Run:  node docs/audits/2026-10-30-perf-gate-guard/shape-burst.mjs
 *
 * The verdict this produces is the reason the gate reads the mean of the
 * three heaviest templates instead of the single heaviest one. See README.md
 * in this folder.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "docs", "audits");
const TEMPLATE_COST = /perf: \S+ . 8-bar render (?:cost|within budget) . (\d+)ms for/;
const BURST = 2.6;
const BUDGET = 3;

function logFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...logFiles(path));
    else if (path.endsWith(".log")) out.push(path);
  }
  return out.sort();
}

function templateCosts(text) {
  const seen = new Set();
  const costs = [];
  for (const line of text.split("\n")) {
    const match = TEMPLATE_COST.exec(line);
    if (!match) continue;
    const ms = Number(match[1]);
    if (seen.has(ms)) continue;
    seen.add(ms);
    costs.push(ms);
  }
  return costs;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const topKMean = (values, k) => mean([...values].sort((a, b) => b - a).slice(0, k));

const rows = [];
for (const file of logFiles(ROOT)) {
  const costs = templateCosts(readFileSync(file, "utf8"));
  if (costs.length !== 14) continue;
  // The burst lands on the heaviest template: the worst case for a gate that
  // reads the tail of the distribution.
  const heaviest = Math.max(...costs);
  const bursted = costs.map((ms) => (ms === heaviest ? ms * BURST : ms));
  const burstAvg = mean(bursted);
  rows.push({
    file: file.replace(`${ROOT}\\`, ""),
    heaviestOverAvg: Math.max(...bursted) / burstAvg,
    top2OverAvg: topKMean(bursted, 2) / burstAvg,
    top3OverAvg: topKMean(bursted, 3) / burstAvg,
  });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`one template x${BURST} slower — the statistic bands at a ${BUDGET}x budget\n`);
console.log(`${pad("file", 56)} ${pad("heaviest/avg", 14)} ${pad("top2/avg", 10)} top3/avg`);
for (const row of rows) {
  console.log(
    `${pad(row.file, 56)} ${pad(row.heaviestOverAvg.toFixed(3), 14)} ${pad(row.top2OverAvg.toFixed(3), 10)} ${row.top3OverAvg.toFixed(
      3,
    )}`,
  );
}

console.log("\n--- verdicts under the burst ---");
for (const key of ["heaviestOverAvg", "top2OverAvg", "top3OverAvg"]) {
  const values = rows.map((row) => row[key]);
  const max = Math.max(...values);
  const over = values.filter((value) => value >= BUDGET).length;
  console.log(
    `${key}: min=${Math.min(...values).toFixed(3)} max=${max.toFixed(3)} — over the ${BUDGET}x budget in ${over} of ${values.length} sets${
      over === 0 ? " (survives everywhere)" : " (a false red)"
    }`,
  );
}
