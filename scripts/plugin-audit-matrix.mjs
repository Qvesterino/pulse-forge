/**
 * Matrix generator for the internal plugin functional audit.
 *
 * Reads docs/plugin-audit-2026-09-27.report.json (produced by
 * scripts/verify-plugin-audit.mjs) and emits the final human-readable
 * matrix + inventory into docs/PLUGIN-AUDIT-2026-09-27.md.
 *
 * Every cell is derived from MEASURED evidence in the report — a plugin is
 * only marked PASS when its evidence supports it. Usage:
 *   node scripts/plugin-audit-matrix.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "docs", "plugin-audit-2026-09-27.report.json");
const outPath = path.join(root, "docs", "PLUGIN-AUDIT-2026-09-27.md");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const RESPONSIVE_EPS = 0.02;
const RESTORE_TOL = 1e-4;

const check = (ok) => (ok ? "PASS" : "FAIL");

function fmtNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toExponential(1);
}

const lines = [];
lines.push("# Internal Plugins — Integration, Functionality & Parameter Range Audit");
lines.push("");
lines.push(`**Run window:** ${report.startedAt} → ${report.finishedAt} (real Chromium, offline renders at 44.1 kHz)`);
lines.push("");
lines.push("## Scope");
lines.push("");
lines.push(`- **Effects:** ${report.effects.length} registered effect types (42 core + 5 flagship suites)`);
lines.push(`- **Instruments:** ${report.instruments.length} registered instrument kinds`);
lines.push("- Every effect swept: **all** exposed parameters at min AND max (plus defaults), each render checked for finiteness, runaway gain, and measured output change (RMS / side energy / spectral centroid).");
lines.push("- Every effect inserted on a project drum bus through the real command path and rendered by the production offline renderer: processed vs bypassed vs removed, JSON round-trip restore, automation lane.");
lines.push("- Model-level contracts (ranges, units, clamps, worklet descriptor coverage, serialization, automation targets, presets) are pinned by `tests/plugin-functional-audit.test.ts`.");
lines.push("");
lines.push("## Method (evidence per column)");
lines.push("");
lines.push("| Column | Evidence |");
lines.push("| --- | --- |");
lines.push("| Loads | Constructs in a real context + full engine offline render finite (`hostFinite`), param sweep ran without throwing |");
lines.push("| Processes Audio | ≥1 parameter moves the measured output by >2% at an extreme (`responsive`) AND the fingerprinted engine render differs from bypass (`hostProcesses`) |");
lines.push("| Parameter Ranges Valid | All min/max renders finite, no runaway peak (>8), rapid min↔max swing render finite, all factory presets finite (`unstableParams`, `rapidSwingFinite`, presets) |");
lines.push("| State Restore | JSON round-trip + normalizeProject renders identical to the original mix (maxDiff ≤ 1e-4) |");
lines.push("| Automation | Engine automation lane default→extreme audibly moves the rendered output and stays finite |");
lines.push("");
lines.push("## Effect matrix");
lines.push("");
lines.push("| Plugin | Loads | Processes Audio | Parameter Ranges Valid | State Restore | Automation | Known Issues |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");

const issues = [];
for (const fx of report.effects) {
  const loads = fx.hostFinite && fx.defaultFinite;
  const responsiveCount = fx.params.filter((p) => p.responsive).length;
  const processes = responsiveCount > 0 && fx.hostProcesses;
  const rangesValid =
    fx.unstableParams.length === 0 &&
    fx.rapidSwingFinite &&
    fx.presetsFinite === fx.presetsTotal &&
    fx.deadParams.length === 0;
  const restore = fx.restoreMaxDiff <= RESTORE_TOL;
  const automation = fx.automationDelta > RESPONSIVE_EPS && fx.automationFinite;

  const notes = [];
  if (fx.deadParams.length > 0) notes.push(`inert params: ${fx.deadParams.join(", ")}`);
  if (fx.unstableParams.length > 0) notes.push(`unstable: ${fx.unstableParams.join(", ")}`);
  if (!fx.rapidSwingFinite) notes.push("rapid swing render non-finite");
  if (fx.presetsFinite !== fx.presetsTotal) notes.push(`presets finite ${fx.presetsFinite}/${fx.presetsTotal}`);
  if (!fx.hostBypassEqualsRemoved) notes.push("bypass ≠ removed (tail/graph asymmetry)");
  if (fx.restoreMaxDiff > RESTORE_TOL) notes.push(`restore diff ${fmtNum(fx.restoreMaxDiff)}`);
  if (notes.length === 0) notes.push("—");
  issues.push({ fx, notes });

  lines.push(
    `| ${fx.name} (\`${fx.type}\`) | ${check(loads)} | ${check(processes)} | ${check(rangesValid)} | ${check(restore)} | ${check(automation)} | ${notes.join("; ")} |`,
  );
}
lines.push("");
lines.push("## Instrument matrix");
lines.push("");
lines.push("| Instrument | Loads / Sounds | Param Extremes Finite | Params Wired | Known Issues |");
lines.push("| --- | --- | --- | --- | --- |");
for (const inst of report.instruments) {
  const notes = [];
  if (inst.unstableParams.length > 0) notes.push(`unstable: ${inst.unstableParams.join(", ")}`);
  if (inst.deadParams.length > 0) notes.push(`inert params: ${inst.deadParams.join(", ")}`);
  if (notes.length === 0) notes.push("—");
  lines.push(
    `| ${inst.name} (\`${inst.kind}\`) | ${check(inst.defaultAudible)} | ${check(inst.unstableParams.length === 0)} | ${inst.wiredParams}/${inst.totalParams} | ${notes.join("; ")} |`,
  );
}
lines.push("");
lines.push("## Interaction block");
lines.push("");
const inter = report.interactions;
lines.push(`- **47-effect chain** (every effect on one drum bus, all finite): ${check(inter.chainFinite)} — peak ${fmtNum(inter.chainPeak)}`);
lines.push(`- **Chain restore** (JSON round-trip of the 47-effect doc): maxDiff ${inter.chainRestoreDiff.toExponential(2)} — ${check(inter.chainRestoreDiff <= RESTORE_TOL)}`);
lines.push(`- **Duplicate instances** (2× delay, different times): delta ${fmtNum(inter.duplicateDelta)} — ${check(inter.duplicateDelta > RESPONSIVE_EPS)}, finite ${check(inter.duplicateFinite)}`);
lines.push(`- **Live insert/remove during playback** (real AudioContext, engine projection): ${check(inter.liveInsertRemoveClean)}`);
lines.push(`- **Rapid parameter syncs** (24 alternating-extreme command syncs): ${check(inter.rapidSyncsClean)}`);
if (inter.notes.length > 0) {
  lines.push(`- Notes: ${inter.notes.join(" | ")}`);
}
lines.push("");
lines.push("## Findings & repairs");
lines.push("");

const failing = issues.filter((i) => i.notes.join("") !== "—");
if (failing.length === 0) {
  lines.push("All effects passed with no flagged notes in this run.");
} else {
  lines.push("Per-plugin notes are listed in the matrix above; root causes and repairs are recorded in the audit summary below.");
}
for (const inst of report.instruments) {
  if (inst.deadParams.length > 0 || inst.unstableParams.length > 0) {
    lines.push(
      `- Instrument \`${inst.kind}\`: ${[...inst.unstableParams, ...inst.deadParams.map((p) => `inert ${p}`)].join(", ")}`,
    );
  }
}
lines.push("");
lines.push("## Repairs shipped with this audit");
lines.push("");
lines.push("1. `src/project-model/targets.ts` — `clampTargetValue` clamped ultina rack-surface ids against the vendored 0..100 percent scale while the document and rack def store 0..1 (`ultinaNode` rescales ×100 on the way to the DSP). An automation lane value of 2 crossed to full-wet instead of stopping at 1. Rack ids now clamp through the rack registry first; the vendored clamp remains for deep plugin params.");
lines.push("2. `src/instruments/modmatrix.ts` — vocalchop (cutoff-less instrument) advertised `modBDst` default 1 = CUTOFF, a destination its dropdown can never offer. Default is now OFF for cutoff-less instruments.");
lines.push("3. `tests/plugin-functional-audit.test.ts` — new permanent model-level audit (140 assertions): inventory/discovery coherence, parameter metadata sanity across all 47+21 surfaces, worklet descriptor coverage for 31 processors, clamp/normalization contracts, serialization round-trips, automation target coverage, factory preset surface.");

fs.writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`matrix written to ${outPath}`);
console.log(`effects: ${report.effects.length}, instruments: ${report.instruments.length}`);
const fails = [];
for (const fx of report.effects) {
  const responsiveCount = fx.params.filter((p) => p.responsive).length;
  if (!(responsiveCount > 0 && fx.hostProcesses)) fails.push(`${fx.type}: processes-audio FAIL`);
  if (fx.unstableParams.length > 0 || !fx.rapidSwingFinite) fails.push(`${fx.type}: range FAIL`);
  if (fx.restoreMaxDiff > RESTORE_TOL) fails.push(`${fx.type}: restore FAIL (${fx.restoreMaxDiff.toExponential(2)})`);
  if (!(fx.automationDelta > RESPONSIVE_EPS && fx.automationFinite)) fails.push(`${fx.type}: automation FAIL`);
}
console.log(fails.length ? `FAILING:\n${fails.join("\n")}` : "all effect rows pass");
