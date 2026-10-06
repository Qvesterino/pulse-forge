import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffExpectations,
  ExpectationsError,
  ledgerViolations,
  parseVitestJsonReport,
  regenerateLedger,
  type LedgerEntry,
} from "../scripts/suite-expectations.mjs";

/**
 * SUITE EXPECTATIONS LEDGER — the Chromium TestExpectations model for this
 * repo. These pins hold the ratchet core: parsing a vitest JSON report,
 * diffing it against the ledger (new reds AND cured reds both fail), flaky
 * exemption, the TODO-owner guard, bless metadata preservation, and the CLI
 * exit-code contract.
 */

function assertion(fullName: string, status: "passed" | "failed" | "skipped") {
  return { fullName, title: fullName.split(" ").at(-1) ?? fullName, status, ancestorTitles: [] };
}

function reportFile(name: string, assertions: ReturnType<typeof assertion>[], status?: string) {
  const derived = status ?? (assertions.some((a) => a.status === "failed") ? "failed" : "passed");
  return { name, status: derived, assertionResults: assertions };
}

function report(...files: ReturnType<typeof reportFile>[]) {
  return JSON.stringify({ numTotalTests: 3, success: false, testResults: files });
}

describe("parseVitestJsonReport", () => {
  it("turns absolute reporter paths into repo-relative test ids with counts", () => {
    const parsed = parseVitestJsonReport(
      report(
        reportFile("D:/pulse-forge/tests/a.test.ts", [
          assertion("suite one pass", "passed"),
          assertion("suite one bad", "failed"),
        ]),
        reportFile("D:/pulse-forge/tests/b.test.ts", [assertion("suite two skip", "skipped")]),
      ),
      "D:/pulse-forge",
    );
    expect(parsed.failedIds).toEqual(["tests/a.test.ts > suite one bad"]);
    expect(parsed).toMatchObject({ files: 2, passed: 1, failed: 1, skipped: 1 });
  });

  it("normalizes windows backslash paths", () => {
    const parsed = parseVitestJsonReport(
      report(reportFile("D:\\pulse-forge\\tests\\a.test.ts", [assertion("boom", "failed")])),
      "D:/pulse-forge",
    );
    expect(parsed.failedIds).toEqual(["tests/a.test.ts > boom"]);
  });

  it("anchors cross-tree reports at tests/ so a worktree report evaluates from the main checkout", () => {
    // A report produced in D:/pf-verify (verification worktree) evaluated
    // with the script's root at D:/pulse-forge must yield the SAME ids.
    const parsed = parseVitestJsonReport(
      report(reportFile("D:/pf-verify/tests/a.test.ts", [assertion("boom", "failed")])),
      "D:/pulse-forge",
    );
    expect(parsed.failedIds).toEqual(["tests/a.test.ts > boom"]);
  });

  it("represents collection errors as pseudo ids (file failed, zero failed assertions)", () => {
    const parsed = parseVitestJsonReport(
      report(reportFile("D:/pulse-forge/tests/c.test.ts", [], "failed")),
      "D:/pulse-forge",
    );
    expect(parsed.failedIds).toEqual(["tests/c.test.ts > [collection error]"]);
  });

  it("refuses garbage JSON, wrong shapes, and empty runs", () => {
    expect(() => parseVitestJsonReport("{not json")).toThrow(ExpectationsError);
    expect(() => parseVitestJsonReport('{"nope": 1}')).toThrow(ExpectationsError);
    expect(() => parseVitestJsonReport('{"testResults": []}')).toThrow(ExpectationsError);
  });
});

describe("diffExpectations (the ratchet)", () => {
  const entry = (id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id,
    owner: "someone",
    reason: "why",
    ...extra,
  });

  it("exact match passes clean", () => {
    const diff = diffExpectations(["a > b"], [entry("a > b")]);
    expect(diff).toEqual({ newReds: [], cured: [], flakyRed: [] });
  });

  it("a red missing from the ledger is a NEW RED (exit-1 direction)", () => {
    const diff = diffExpectations(["a > b", "x > y"], [entry("a > b")]);
    expect(diff.newReds).toEqual(["x > y"]);
    expect(diff.cured).toEqual([]);
  });

  it("a ledgered test that now passes is CURED (ratchet direction)", () => {
    const diff = diffExpectations(["a > b"], [entry("a > b"), entry("x > y")]);
    expect(diff.cured).toEqual(["x > y"]);
    expect(diff.newReds).toEqual([]);
  });

  it("flaky entries are exempt both ways", () => {
    const flaky = entry("f > g", { flaky: true });
    expect(diffExpectations(["f > g"], [flaky]).newReds).toEqual([]);
    expect(diffExpectations(["f > g"], [flaky]).flakyRed).toEqual(["f > g"]);
    expect(diffExpectations([], [flaky]).cured).toEqual([]);
  });
});

describe("ledgerViolations (no unclassified reds)", () => {
  it("rejects empty/TODO owners, missing reasons, duplicate ids", () => {
    const violations = ledgerViolations([
      { id: "a", owner: "TODO — classify me", reason: "x" },
      { id: "b", owner: "owner", reason: "" },
      { id: "c", owner: "owner", reason: "y" },
      { id: "c", owner: "owner", reason: "y" },
    ]);
    expect(violations).toEqual(["a — owner not classified (empty/TODO)", "b — missing reason", "duplicate id: c"]);
  });

  it("a classified ledger is clean", () => {
    expect(ledgerViolations([{ id: "a", owner: "wave owner", reason: "in-flight retrain" }])).toEqual([]);
  });
});

describe("regenerateLedger (--bless)", () => {
  it("keeps classification for survivors, TODO for new ids, drops cured, keeps green flaky", () => {
    const existing: LedgerEntry[] = [
      { id: "keep > red", owner: "wave", reason: "in-flight" },
      { id: "cured > now-green", owner: "wave", reason: "old" },
      { id: "flaky > green-now", owner: "wave", reason: "co-run TDZ flake", flaky: true },
    ];
    const next = regenerateLedger(existing, ["keep > red", "brand > new"], {
      recordedAgainst: "abc1234",
      date: "2026-10-06",
    });
    expect(next.recordedAgainst).toBe("abc1234");
    const byId = new Map(next.expectations.map((e) => [e.id, e]));
    expect(byId.get("keep > red")?.owner).toBe("wave");
    expect(byId.get("brand > new")?.owner).toMatch(/^TODO/);
    expect(byId.has("cured > now-green")).toBe(false);
    expect(byId.has("flaky > green-now")).toBe(true);
  });
});

describe("CLI contract (exit codes)", () => {
  // vitest transforms import.meta.url to a non-file URL — resolve from the
  // process cwd, which vitest.config.ts keeps at the repo root.
  const script = resolve(process.cwd(), "scripts/suite-expectations.mjs");

  function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), "suite-expectations-"));
    const reportPath = join(dir, "report.json");
    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(
      reportPath,
      report(
        reportFile("tests/a.test.ts", [assertion("owned red", "failed")]),
        reportFile("tests/c.test.ts", [assertion("surprise red", "failed")]),
        reportFile("tests/b.test.ts", [assertion("fine", "passed")]),
      ),
    );
    return { dir, reportPath, ledgerPath };
  }

  it("exit 0 when the failure set exactly matches the ledger", () => {
    const { reportPath, ledgerPath } = fixtures();
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        recordedAgainst: "test",
        date: "2026-10-06",
        note: "",
        expectations: [
          { id: "tests/a.test.ts > owned red", owner: "wave", reason: "in-flight" },
          { id: "tests/c.test.ts > surprise red", owner: "another wave", reason: "vendor SDK owner gate" },
        ],
      }),
    );
    const res = spawnSync(process.execPath, [script, reportPath, "--ledger", ledgerPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ledger matches reality");
  });

  it("exit 1 on a NEW red AND on a CURED entry (both ratchet directions)", () => {
    const { reportPath, ledgerPath } = fixtures();
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        recordedAgainst: "test",
        date: "2026-10-06",
        note: "",
        expectations: [
          { id: "tests/a.test.ts > owned red", owner: "wave", reason: "in-flight" },
          { id: "tests/gone.test.ts > cured entry", owner: "wave", reason: "old" },
        ],
      }),
    );
    const res = spawnSync(process.execPath, [script, reportPath, "--ledger", ledgerPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("NEW REDS");
    expect(res.stdout).toContain("tests/c.test.ts > surprise red");
    expect(res.stdout).toContain("CURED");
    expect(res.stdout).toContain("tests/gone.test.ts > cured entry");
  });

  it("exit 1 when a ledger entry is still TODO-classified", () => {
    const { reportPath, ledgerPath } = fixtures();
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        recordedAgainst: "test",
        date: "2026-10-06",
        note: "",
        expectations: [{ id: "tests/a.test.ts > owned red", owner: "TODO — classify me", reason: "?" }],
      }),
    );
    const res = spawnSync(process.execPath, [script, reportPath, "--ledger", ledgerPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("owner not classified");
  });

  it("exit 2 on a malformed report", () => {
    const { dir, ledgerPath } = fixtures();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json at all");
    const res = spawnSync(process.execPath, [script, bad, "--ledger", ledgerPath], { encoding: "utf8" });
    expect(res.status).toBe(2);
  });

  it("--bless writes TODO entries and preserves an existing classification", () => {
    const { reportPath, ledgerPath } = fixtures();
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        recordedAgainst: "old",
        date: "2026-10-05",
        note: "",
        expectations: [{ id: "tests/a.test.ts > owned red", owner: "wave", reason: "in-flight" }],
      }),
    );
    const res = spawnSync(process.execPath, [script, reportPath, "--ledger", ledgerPath, "--bless"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { expectations: LedgerEntry[] };
    const byId = new Map(ledger.expectations.map((e) => [e.id, e]));
    expect(byId.get("tests/a.test.ts > owned red")?.owner).toBe("wave");
  });
});
