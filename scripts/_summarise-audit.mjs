/**
 * Summarise a plugin-audit report JSON into only what needs a decision.
 * Run: node scripts/_summarise-audit.mjs [path]
 * Exits non-zero when a hard failure class is present, so it can gate.
 */
import fs from "node:fs";

const path = process.argv[2] ?? "docs/plugin-audit-2026-09-27.report.json";
if (!fs.existsSync(path)) {
  console.log(`no report at ${path}`);
  process.exit(0);
}
const r = JSON.parse(fs.readFileSync(path, "utf8"));
const fx = r.effects ?? [];
const ins = r.instruments ?? [];

const rows = fx.map((e) => ({
  type: e.type,
  name: e.name,
  sweepErr: e.sweepError,
  hostErr: e.hostError,
  exempt: e.sweepExemptReason ?? e.hostExemptReason,
  notFinite: e.defaultFinite === false,
  hostFinite: e.hostFinite === false,
  bypassMismatch: e.hostBypassEqualsRemoved === false,
  notProcessing: e.hostProcesses === false,
  autoNaN: e.automationFinite === false,
  unstable: (e.unstableParams ?? []).length,
  dead: (e.deadParams ?? []).length,
  rapidNaN: e.rapidSwingFinite === false,
  presetNaN: e.presetsTotal > 0 && e.presetsFinite < e.presetsTotal,
  restoreDiff: e.restoreMaxDiff,
}));

// P1: correctness. P2: significant but not catastrophic.
const hard = rows.filter(
  (x) => x.sweepErr || x.hostErr || x.notFinite || x.hostFinite || x.bypassMismatch || x.autoNaN || x.rapidNaN,
);
const soft = rows.filter((x) => x.unstable > 0 || x.dead > 0 || x.presetNaN || (x.restoreDiff ?? 0) > 1e-6);

console.log(`EFFECTS: ${rows.length} | INSTRUMENTS: ${ins.length}`);
console.log(`HARD (P1): ${hard.length} | SOFT (P2): ${soft.length}`);

if (hard.length) {
  console.log("\n== HARD ==");
  for (const x of hard) {
    const why = [
      x.sweepErr && `sweepError`,
      x.hostErr && `hostError`,
      x.notFinite && `default non-finite`,
      x.hostFinite && `host non-finite`,
      x.bypassMismatch && `bypass != removed`,
      x.autoNaN && `automation non-finite`,
      x.rapidNaN && `rapid swing non-finite`,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${x.type.padEnd(18)} ${why}`);
    if (x.sweepErr) console.log(`      sweep: ${String(x.sweepErr).slice(0, 160)}`);
    if (x.hostErr) console.log(`      host:  ${String(x.hostErr).slice(0, 160)}`);
  }
}
if (soft.length) {
  console.log("\n== SOFT ==");
  for (const x of soft) {
    const bits = [];
    if (x.unstable) bits.push(`${x.unstable} unstable`);
    if (x.dead) bits.push(`${x.dead} dead`);
    if (x.presetNaN) bits.push(`presets ${x.presetsFinite}/${x.presetsTotal}`);
    if ((x.restoreDiff ?? 0) > 1e-6) bits.push(`restoreDiff ${x.restoreDiff.toExponential(2)}`);
    console.log(`  ${x.type.padEnd(18)} ${bits.join(", ")}`);
    if (x.unstable) console.log(`      unstable: ${(x.unstableList ?? []).slice(0, 6).join(" ")}`);
  }
}

const badIns = ins.filter((i) => !i.defaultAudible || (i.unstableParams ?? []).length);
console.log(`\nINSTRUMENT PROBLEMS: ${badIns.length}`);
for (const i of badIns) {
  console.log(
    `  ${i.kind.padEnd(14)} audible=${i.defaultAudible} dead=${(i.deadParams ?? []).length} unstable=${(i.unstableParams ?? []).length}`,
  );
}
if (r.interactions) {
  const it = r.interactions;
  console.log(`\nINTERACTIONS: ${JSON.stringify(it).slice(0, 600)}`);
} else {
  console.log("\nINTERACTIONS: (not run)");
}
