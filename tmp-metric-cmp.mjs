/**
 * tmp-metric-cmp.mjs - 2026-10-04 before/after table for the redundancy
 * metric correction in scripts/audit-samples.mts.
 *
 * Recomputes the NEW feature distance for the pairs the OLD metric flagged
 * (as read from tmp-audit-3.log) and prints the dominant axes, so the
 * re-triage can be audited line by line. Scratch tool - not part of the
 * shipped test surface.
 */
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync("tmp-audit-4.json", "utf8"));
const oldLog = readFileSync("tmp-audit-3.log", "utf8");

const BANDS = ["sub", "low", "lowmid", "mid", "himid", "high", "air"];
const DIMS = [...BANDS, "crest", "loud", "brightness", "tilt", "attack"];
const SCALE = [60, 60, 60, 60, 60, 60, 60, 20, 1000, 4, 1000, 40];
const ATTACK_FLOOR = -30;

const feat = (r) => [
  ...BANDS.map((n) => r.bands[n]),
  r.crestDb,
  r.loudMs,
  Math.log2(Math.max(r.bands.centroid, 1)),
  (r.tailSilenceMs - r.leadSilenceMs) / 1000,
  Math.max(r.attackDb, ATTACK_FLOOR),
];
const byId = new Map(rows.map((r) => [r.id, r]));
const short = (id) => id.replace("factory.", "");

const oldMap = new Map();
for (const m of oldLog.matchAll(/d=([0-9.]+)\s+([\w.]+) <-> ([\w.]+)/g))
  oldMap.set([m[2], m[3]].sort().join("|"), m[1]);

const CANDIDATES = [
  ["factory.kick.knock", "factory.kick.lofi"],
  ["factory.kick.dnb", "factory.kick.phonk"],
  ["factory.snare.drill", "factory.snare.main"],
  ["factory.snare.dnb", "factory.snare.main"],
  ["factory.hat.closed", "factory.hat.open.short"],
  ["factory.hat.pedal", "factory.hat.phonk"],
  ["factory.crash.dark", "factory.crash.main"],
  ["factory.fx.downlifter", "factory.fx.riser"],
  ["factory.clap.main", "factory.clap.pop"],
  ["factory.tonal.erhu", "factory.tonal.trumpet"],
  ["factory.bass.dist", "factory.bass.fm"],
];

const line = (label, value, width = 34) => `${label.padEnd(width)} ${value}`;
console.log("PAIR (old top-2 flag)          old d    new d*  dominant axes (new)");
console.log("-".repeat(110));
for (const [a, b] of CANDIDATES) {
  const A = byId.get(a);
  const B = byId.get(b);
  if (!A || !B) {
    console.log(line(`${short(a)} <-> ${short(b)}`, "MISSING ROW"));
    continue;
  }
  const fa = feat(A);
  const fb = feat(B);
  const contrib = fa.map((v, k) => [Math.abs(v - fb[k]) / SCALE[k], DIMS[k]]);
  const d = Math.sqrt(contrib.reduce((s, [c]) => s + c * c, 0));
  const axes = contrib
    .sort((p, q) => q[0] - p[0])
    .slice(0, 3)
    .map(([c, n]) => `${n} ${c.toFixed(3)}`)
    .join(" | ");
  const old = oldMap.get([short(a), short(b)].sort().join("|")) ?? "-";
  console.log(
    line(
      `${short(a)} <-> ${short(b)}`,
      `${String(old).padStart(5)}    ${d.toFixed(3)}${d < 0.15 ? "*" : " "}   ${axes}`,
    ),
  );
}
console.log("\n* = under 0.15 (one full step on a single axis) - the de-dup watchlist.");
console.log("old d '-' = the pair was not in the old metric's top-2 for its category.");
