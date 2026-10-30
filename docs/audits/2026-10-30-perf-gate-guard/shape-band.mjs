/**
 * The measured DISTRIBUTION SHAPE of the 14-template render corpus.
 *
 * Reads every committed run log under docs/audits/ that carries the 14
 * per-template render costs, and computes three statistics of the same set:
 * the single heaviest template, the mean of the two heaviest, and the mean of
 * the three heaviest — each against the corpus average.
 *
 * Run:  node docs/audits/2026-10-30-perf-gate-guard/shape-band.mjs
 *
 * Why it exists: the perf gate that reads the shape of the render
 * distribution changed its statistic in fe7c3473, and this is the measurement
 * that decided it. See README.md in this folder.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "docs", "audits");
const TEMPLATE_COST = /perf: \S+ . 8-bar render (?:cost|within budget) . (\d+)ms for/;

/** Every .log under docs/audits, recursively. */
function logFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...logFiles(path));
    else if (path.endsWith(".log")) out.push(path);
  }
  return out.sort();
}

/** The per-template costs of one log, first occurrence of each value only. */
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
/** The mean of the k heaviest values. */
const topKMean = (values, k) => mean([...values].sort((a, b) => b - a).slice(0, k));

const rows = [];
for (const file of logFiles(ROOT)) {
  const costs = templateCosts(readFileSync(file, "utf8"));
  if (costs.length !== 14) continue; // not a full 14-template corpus
  const avg = mean(costs);
  rows.push({
    file: file.replace(`${ROOT}\\`, ""),
    avg: Math.round(avg),
    heaviest: Math.max(...costs),
    heaviestOverAvg: Math.max(...costs) / avg,
    top2OverAvg: topKMean(costs, 2) / avg,
    top3OverAvg: topKMean(costs, 3) / avg,
  });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(
  `${pad("file", 56)} ${pad("avg", 8)} ${pad("heaviest", 9)} ${pad("heaviest/avg", 14)} ${pad("top2/avg", 10)} top3/avg`,
);
for (const row of rows) {
  console.log(
    `${pad(row.file, 56)} ${pad(row.avg, 8)} ${pad(row.heaviest, 9)} ${pad(row.heaviestOverAvg.toFixed(3), 14)} ${pad(
      row.top2OverAvg.toFixed(3),
      10,
    )} ${row.top3OverAvg.toFixed(3)}`,
  );
}

console.log("\n--- bands (budget 3x) ---");
for (const key of ["heaviestOverAvg", "top2OverAvg", "top3OverAvg"]) {
  const values = rows.map((row) => row[key]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  console.log(`${key}: n=${values.length} min=${min.toFixed(3)} max=${max.toFixed(3)} band=${(max / min).toFixed(3)}x`);
}
