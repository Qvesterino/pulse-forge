#!/usr/bin/env node
/**
 * SEAM COVERAGE GATE
 *
 * A test that asserts a behavior can still be green while the behavior is
 * broken, when the defect lives in a SEAM the test never entered. Five
 * corrections in three days (2026-10-13 → 2026-10-15) were all that shape:
 *
 *   e25d7cad  EQ curve: 16/16 green. Tests covered hitEqBand/eqPointToDb —
 *             pure math. The defect was in onPointerDown: a click without a
 *             drag wrote -1.09 dB into the document.
 *   21524e1d  Reaction bridge: 19/19 green. Tests shaped rows; the CALLER fed
 *             it nothing, so the rows were content-free.
 *   9d315e41  "the dead-parameter column was measuring the instrument, not
 *             the wiring"
 *
 * This gate encodes the two properties those tests lacked, from
 * tests/seam-manifest.json:
 *
 *   1. ENTER — the spec must drive the real entry point, not an inner unit.
 *   2. ASSERT THE NEGATIVE — a seam spec that only proves the happy path
 *      cannot catch "click without drag commits something". The reference
 *      example (eq-curve-gesture) has 8 of 12 specs negative; arrangement-
 *      drag-commit has 0.
 *
 * Statuses:
 *   COVERED              — claimed good. The gate FAILS unless the spec exists
 *                          and carries a no-op/refusal assertion.
 *   COVERED_NO_NEGATIVE  — an HONEST admission that the seam is entered but the
 *                          negative case is missing. Reported, never failed.
 *                          Declaring this is the honest move; the gate's job is
 *                          to stop a FALSE claim, not to demand new tests.
 *   OPEN                 — no seam-entering spec at all. Reported, not failed.
 *
 * HONEST SCOPE: this gate checks naming and file presence. It cannot prove the
 * spec really enters the seam — only a mutation can. See
 * docs/audits/2026-10-15-seam-coverage/SEAM-COVERAGE.md §Known limits.
 *
 * Usage: node scripts/check-seam-coverage.mjs
 * Exit:  0 = no false coverage claim · 1 = at least one
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "tests/seam-manifest.json");

if (!existsSync(MANIFEST)) {
  console.error(`FAIL  seam manifest missing: ${MANIFEST}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const negation = new RegExp(manifest.negationPattern, "i");

/**
 * Every spec file a seam's coverage may come from. Supports a leading glob
 * segment (e.g. "tests/mcp-*.test.ts") so a 37-file seam can be declared
 * honestly instead of by cherry-picking one representative file.
 */
function resolveSpecs(spec) {
  if (!spec.includes("*")) return existsSync(resolve(ROOT, spec)) ? [spec] : [];
  const dirPart = spec.split("/").slice(0, -1).join("/");
  const pattern = spec.split("/").pop();
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
  return readdirSync(resolve(ROOT, dirPart))
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => `${dirPart}/${f}`)
    .sort();
}

/** Spec titles carrying a no-op / refusal / cancel / "nothing happened" claim. */
function negativeSpecCount(specFile) {
  const text = readFileSync(resolve(ROOT, specFile), "utf8");
  let count = 0;
  for (const line of text.split("\n")) {
    const m = /\b(?:it|test)\s*\(\s*(["'`])(.*?)\1/.exec(line);
    if (m && negation.test(m[2])) count += 1;
  }
  return count;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

const falseClaims = [];
const reported = [];

/**
 * A seam claim is only as good as its THREE declarations, and the gate
 * verifies all three:
 *
 *   spec         the spec file (or glob) that enters the seam
 *   seamEvent    a token that MUST appear in it — the gesture/call that proves
 *                the spec enters the seam rather than an inner unit
 *   negativeSpec a substring of the no-op / refusal spec title
 *
 * The third is what the EQ-curve defect needed and never had. The second is
 * what a first draft of this gate got wrong: counting negative specs ANYWHERE
 * in a file let a spec that never dispatches a pointer event "cover" a
 * gesture seam. Verified by falsification, not assumed.
 */
for (const seam of manifest.seams) {
  if (seam.status === "OPEN") {
    reported.push(`OPEN              ${seam.id}`);
    continue;
  }
  if (seam.spec == null) {
    falseClaims.push(`${seam.id}: status=${seam.status} but no spec file declared`);
    continue;
  }
  const files = resolveSpecs(seam.spec);
  if (files.length === 0) {
    falseClaims.push(`${seam.id}: declared spec matches no file — ${seam.spec}`);
    continue;
  }
  if (seam.status !== "COVERED") {
    reported.push(`${seam.status.padEnd(18)}${seam.id}`);
    continue;
  }
  // COVERED must satisfy all three declarations.
  const contents = files.map((f) => ({ f, text: readFileSync(resolve(ROOT, f), "utf8") }));
  const entersSeam = seam.seamEvent == null || contents.some((c) => c.text.includes(seam.seamEvent));
  const hasNegative = seam.negativeSpec != null && contents.some((c) => c.text.includes(seam.negativeSpec));
  const anyNegative = contents.reduce((n, c) => n + negativeSpecCount(c.f), 0);

  if (!entersSeam) {
    falseClaims.push(
      `${seam.id}: declared COVERED but ${seam.spec} never contains "${seam.seamEvent}" — the spec does not enter this seam, so its passing proves nothing about it.`,
    );
  } else if (!hasNegative) {
    falseClaims.push(
      `${seam.id}: declared COVERED but no spec title contains "${seam.negativeSpec}" in ${seam.spec} — a seam test that only proves the happy path is what let the EQ-curve defect ship. Add the no-move/cancel case, or downgrade the status to COVERED_NO_NEGATIVE (an honest admission).`,
    );
  } else {
    reported.push(`covered           ${seam.id}  (${files.length} spec file(s), ${anyNegative} negative)`);
  }
}

console.log("");
console.log(
  `seams: ${manifest.seams.length}  ·  claims checked: ${manifest.seams.filter((s) => s.status === "COVERED").length}`,
);
console.log("");

for (const claim of falseClaims) {
  check(`false coverage claim: ${claim}`, false);
}
if (falseClaims.length === 0) {
  check("no seam claims COVERED without a negative assertion", true);
}

console.log("");
console.log("seam ledger:");
for (const line of reported) console.log(`  ${line}`);
console.log("");

const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`SEAM COVERAGE GATE FAILED — ${failed} false coverage claim(s).`);
  process.exit(1);
}
console.log(`SEAM COVERAGE GATE PASSED — ${results.length} checks, ${reported.length} seams accounted for.`);
