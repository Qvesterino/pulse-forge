/**
 * SUITE EXPECTATIONS LEDGER — the Chromium TestExpectations model, sized for
 * this repository.
 *
 * NOTE: no shebang on purpose. This module is imported by tests
 * (tests/suite-expectations.test.ts); a `#!/usr/bin/env node` first line
 * combined with CRLF line endings (any Windows checkout under
 * core.autocrlf=true) makes vite's transform throw
 * "Invalid or unexpected token" — reproducible: LF+shebang and
 * CRLF-without-shebang both parse, shebang+CRLF does not. Invoked as
 * `node scripts/suite-expectations.mjs` everywhere, so the shebang was
 * decorative anyway.
 *
 * Problem it solves: the suite carries a standing owned-red family (in-flight
 * concurrent waves, vendor owner-gates, artifact pins). When red is normal,
 * real regressions drown in the noise — the U0.5 tempo honesty regression
 * sat red-but-ignored for two days (CAMPAIGN_STATE.md, 2026-10-06).
 *
 * Contract (suite-expectations.json, repo root):
 *   - every test id that is EXPECTED to fail is listed with an owner + reason
 *     — an unclassified red is a process bug, never a resting state;
 *   - a failing test MISSING from the ledger  → FAIL  ("new red": fix it, or
 *     classify it in suite-expectations.json with owner + reason);
 *   - a ledgered test that now PASSES         → FAIL  ("cured": remove the
 *     entry — the baseline may only shrink);
 *   - entries with "flaky": true are exempt both ways (a red run is not a new
 *     red, a green run is not cured). Use sparingly; they still need
 *     owner + reason.
 *
 * Test ids are `<repo-relative file> > <vitest fullName>` where fullName is
 * vitest's space-joined suite/test path. Files that fail to COLLECT (import
 * errors) surface as `<file> > [collection error]` so they can never slip
 * under the test-level radar.
 *
 * Modes:
 *   node scripts/suite-expectations.mjs --run    run the full suite (JSON
 *     report + default reporter) then evaluate — the CI path
 *   node scripts/suite-expectations.mjs [report] evaluate an existing report
 *     (default .suite-expectations-report.json)
 *   … --bless                                    regenerate the ledger from
 *     the report: surviving ids keep their classification, flaky entries
 *     persist even on a green run, cured entries drop, NEW ids land as
 *     TODO — eval stays red until every TODO is classified by hand.
 *
 * Exit codes: 0 = reality matches the ledger · 1 = drift (new reds / cured /
 * unclassified entries) · 2 = tool error (bad report, missing vitest).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const DEFAULT_REPORT = resolve(REPO_ROOT, ".suite-expectations-report.json");
export const DEFAULT_LEDGER = resolve(REPO_ROOT, "suite-expectations.json");
const VITEST_ENTRY = resolve(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

const LEDGER_NOTE =
  "Owned-red ledger (Chromium TestExpectations model). Every entry needs owner + reason. " +
  "Ratchet: new reds fail the gate, cured reds demand removal. See scripts/suite-expectations.mjs.";

export class ExpectationsError extends Error {}

/**
 * Reporter file path → repo-relative, forward slashes. Tolerates reports
 * produced in a DIFFERENT tree (e.g. a verification worktree evaluated from
 * the main checkout): when the path doesn't sit under `root`, anchor at the
 * `/tests/` segment — every spec in this repo lives under `tests/`, so the
 * id stays identical regardless of which tree produced the report.
 */
export function normalizeFilePath(rawPath, root = REPO_ROOT) {
  let p = String(rawPath).replace(/\\/g, "/");
  const r = String(root).replace(/\\/g, "/");
  if (r !== "" && p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
  if (p.includes("/tests/")) {
    const anchor = p.indexOf("/tests/") + 1;
    p = p.slice(anchor);
  }
  return p;
}

/**
 * Parse a vitest `--reporter=json` output. Defensive by contract: garbage or
 * wrong-shaped input throws ExpectationsError (callers surface exit 2), an
 * empty run refuses to evaluate — blessing an empty report would wipe the
 * ledger and make the whole suite "green".
 */
export function parseVitestJsonReport(rawJson, root = REPO_ROOT) {
  let data;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    throw new ExpectationsError(`report is not valid JSON (${err.message})`);
  }
  if (data == null || typeof data !== "object" || !Array.isArray(data.testResults)) {
    throw new ExpectationsError(
      "not a vitest JSON report — expected testResults[] (run vitest with --reporter=json --outputFile=…)",
    );
  }
  const failedIds = new Set();
  let files = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const fileEntry of data.testResults) {
    if (fileEntry == null || typeof fileEntry.name !== "string") continue;
    files += 1;
    const rel = normalizeFilePath(fileEntry.name, root);
    const assertions = Array.isArray(fileEntry.assertionResults) ? fileEntry.assertionResults : [];
    let sawFailedAssertion = false;
    for (const assertion of assertions) {
      if (assertion == null || typeof assertion.fullName !== "string") continue;
      if (assertion.status === "failed") {
        sawFailedAssertion = true;
        failed += 1;
        failedIds.add(`${rel} > ${assertion.fullName}`);
      } else if (assertion.status === "passed") {
        passed += 1;
      } else {
        skipped += 1; // skipped / todo — deliberate, never ledgered
      }
    }
    if (fileEntry.status === "failed" && !sawFailedAssertion) {
      failedIds.add(`${rel} > [collection error]`);
    }
  }
  if (files === 0) {
    throw new ExpectationsError("report contains zero test files — refusing to evaluate an empty run");
  }
  return { files, passed, failed, skipped, failedIds: [...failedIds].sort() };
}

export function diffExpectations(failedIds, entries) {
  const failed = new Set(Array.isArray(failedIds) ? failedIds : []);
  const list = Array.isArray(entries) ? entries : [];
  const stable = new Set(list.filter((e) => e && e.id && !e.flaky).map((e) => e.id));
  const flaky = new Set(list.filter((e) => e && e.id && e.flaky).map((e) => e.id));
  return {
    newReds: (Array.isArray(failedIds) ? failedIds : []).filter((id) => !stable.has(id) && !flaky.has(id)).sort(),
    cured: [...stable].filter((id) => !failed.has(id)).sort(),
    flakyRed: (Array.isArray(failedIds) ? failedIds : []).filter((id) => flaky.has(id)).sort(),
  };
}

/** A ledger entry without a real owner+reason is an unclassified red. */
export function ledgerViolations(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const violations = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry == null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id === "") {
      violations.push("entry without an id");
      continue;
    }
    if (seen.has(entry.id)) violations.push(`duplicate id: ${entry.id}`);
    seen.add(entry.id);
    const owner = String(entry.owner ?? "").trim();
    if (owner === "" || /^todo/i.test(owner)) violations.push(`${entry.id} — owner not classified (empty/TODO)`);
    if (String(entry.reason ?? "").trim() === "") violations.push(`${entry.id} — missing reason`);
  }
  return violations;
}

/**
 * Regenerate the ledger from a report (the --bless path). Surviving ids keep
 * their classification; cured stable entries drop (that IS the ratchet); new
 * ids land as TODO so eval keeps failing until a human classifies them; flaky
 * entries persist even on a green run — flakiness is a statement about the
 * test, not about one run.
 */
export function regenerateLedger(existingEntries, failedIds, meta) {
  const byId = new Map(
    (Array.isArray(existingEntries) ? existingEntries : []).filter(Boolean).map((entry) => [entry.id, entry]),
  );
  const ids = [...new Set(Array.isArray(failedIds) ? failedIds : [])].sort();
  const expectations = [];
  for (const id of ids) {
    const prev = byId.get(id);
    expectations.push(
      prev
        ? { ...prev }
        : {
            id,
            owner: "TODO — classify me",
            reason: "TODO — who owns this red and why is it not fixed?",
            addedAt: meta.date,
          },
    );
  }
  for (const entry of byId.values()) {
    if (entry.flaky && !ids.includes(entry.id)) expectations.push({ ...entry });
  }
  expectations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: 1, recordedAgainst: meta.recordedAgainst, date: meta.date, note: LEDGER_NOTE, expectations };
}

function gitHeadShort() {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

/**
 * IN-FLIGHT ATTRIBUTION (reporting only — the exit code never changes here).
 *
 * Multiple agent sessions share this working tree, so a full-suite run can go
 * red because ANOTHER session is mid-edit (measured 2026-10-17: 10 new reds,
 * none from the session that ran the gate, one of them a spec whose transitive
 * import had a duplicate export at that moment). Without attribution the
 * triage burns an hour; with it the runner sees "dirty: those files" and knows
 * whose wave it is. `--bless` still refuses; this only labels.
 */
export function gitDirtyPaths() {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (res.status !== 0) return new Set();
  const dirty = new Set();
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.length < 4) continue;
    let path = trimmed.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").pop().trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    dirty.add(path.replace(/\\/g, "/"));
  }
  return dirty;
}

/** Repo-relative paths of a spec file's first-level relative imports that exist on disk. */
export function firstLevelImports(specPath) {
  const out = new Set();
  let text;
  try {
    text = readFileSync(resolve(REPO_ROOT, specPath), "utf8");
  } catch {
    return out;
  }
  const re = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(text))) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const base = resolve(REPO_ROOT, dirname(specPath), specifier);
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      resolve(base, "index.ts"),
    ];
    const hit = candidates.find((candidate) => existsSync(candidate));
    if (hit) out.add(relative(REPO_ROOT, hit).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Label each new red with the dirty file that most plausibly explains it: the
 * spec itself, else one of its first-level imports. Pure given the dirty set.
 */
export function annotateInFlight(newReds, dirty = gitDirtyPaths()) {
  return newReds.map((id) => {
    const file = String(id).split(" > ")[0];
    if (dirty.has(file)) return { id, inFlight: true, reason: `${file} is dirty` };
    for (const imported of firstLevelImports(file)) {
      if (dirty.has(imported)) return { id, inFlight: true, reason: `${imported} (imported) is dirty` };
    }
    return { id, inFlight: false, reason: null };
  });
}

function loadLedger(path) {
  if (!existsSync(path)) {
    return { version: 1, recordedAgainst: "none", date: "none", note: LEDGER_NOTE, expectations: [] };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ExpectationsError(`ledger ${path} is not valid JSON (${err.message})`);
  }
  if (data == null || typeof data !== "object" || !Array.isArray(data.expectations)) {
    throw new ExpectationsError(`ledger ${path} is malformed — expected { expectations: [...] }`);
  }
  return data;
}

function printVerdict({ parsed, diff, violations, ledger }) {
  const ledgered = ledger.expectations.length;
  console.log(
    `suite run: ${parsed.files} files · ${parsed.passed} passed · ${parsed.failed} failed · ${parsed.skipped} skipped` +
      ` | ledger: ${ledgered} entries (against ${ledger.recordedAgainst})`,
  );
  let bad = false;
  if (diff.newReds.length > 0) {
    bad = true;
    console.log(
      `\n✗ NEW REDS (${diff.newReds.length}) — fix, or classify in suite-expectations.json with owner + reason:`,
    );
    const annotated = annotateInFlight(diff.newReds);
    const inFlightCount = annotated.filter((item) => item.inFlight).length;
    for (const item of annotated) {
      console.log(`    - ${item.id}${item.inFlight ? `  [IN-FLIGHT: ${item.reason}]` : ""}`);
    }
    if (inFlightCount > 0) {
      const dirty = [...gitDirtyPaths()].filter((path) => /^(src|tests|scripts|desktop|server)\//.test(path));
      console.log(
        `\n  ${inFlightCount} of these touch DIRTY files — another session is mid-edit in this shared tree`,
        `(measured 2026-10-17: a runner's 10 "new reds" were all another wave's).`,
        `\n  Verify with \`git status --porcelain\` before "fixing" anything. In-flight now (${dirty.length}):`,
      );
      for (const path of dirty.slice(0, 20)) console.log(`    ~ ${path}`);
      if (dirty.length > 20) console.log(`    ~ … +${dirty.length - 20} more`);
    }
  }
  if (diff.cured.length > 0) {
    bad = true;
    console.log(`\n✗ CURED (${diff.cured.length}) — ratchet: remove from suite-expectations.json:`);
    for (const id of diff.cured) console.log(`    - ${id}`);
  }
  if (violations.length > 0) {
    bad = true;
    console.log(`\n✗ LEDGER PROBLEMS (${violations.length}):`);
    for (const v of violations) console.log(`    - ${v}`);
  }
  if (diff.flakyRed.length > 0) {
    console.log(`\n~ flaky entries seen red this run (${diff.flakyRed.length}) — exempt by classification`);
  }
  if (!bad) console.log(`\n✓ ledger matches reality — ratchet holds (baseline ${ledgered})`);
  return bad ? 1 : 0;
}

function runVitest(reportPath) {
  if (!existsSync(VITEST_ENTRY)) {
    console.error(`vitest entry not found at ${VITEST_ENTRY} — run npm install first`);
    process.exit(2);
  }
  const res = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (res.error) {
    console.error(`failed to spawn vitest: ${res.error.message}`);
    process.exit(2);
  }
  // A non-zero vitest exit just means reds exist — the ledger decides.
}

function main(argv) {
  const positional = [];
  let modeRun = false;
  let modeBless = false;
  let ledgerPath = DEFAULT_LEDGER;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run") modeRun = true;
    else if (arg === "--bless") modeBless = true;
    else if (arg === "--ledger") ledgerPath = resolve(argv[++i] ?? "");
    else positional.push(arg);
  }
  const reportPath = positional.length > 0 ? resolve(positional[0]) : DEFAULT_REPORT;

  if (modeRun) runVitest(reportPath);
  if (!existsSync(reportPath)) {
    console.error(`report not found: ${reportPath} — run with --run or pass a vitest JSON report path`);
    return 2;
  }

  let parsed;
  let ledger;
  try {
    parsed = parseVitestJsonReport(readFileSync(reportPath, "utf8"));
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    console.error(err instanceof ExpectationsError ? err.message : String(err));
    return 2;
  }

  if (modeBless) {
    const next = regenerateLedger(ledger.expectations, parsed.failedIds, {
      recordedAgainst: gitHeadShort(),
      date: new Date().toISOString().slice(0, 10),
    });
    writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    const todos = next.expectations.filter((e) => /^todo/i.test(String(e.owner ?? "")));
    console.log(
      `blessed ${ledgerPath}: ${next.expectations.length} entries against ${next.recordedAgainst}` +
        ` (${todos.length} TODO — classify before eval can pass)`,
    );
    return 0;
  }

  const diff = diffExpectations(parsed.failedIds, ledger.expectations);
  const violations = ledgerViolations(ledger.expectations);
  return printVerdict({ parsed, diff, violations, ledger });
}

// CLI guard: only execute when invoked directly (node scripts/suite-expectations.mjs …)
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) process.exit(main(process.argv.slice(2)));
