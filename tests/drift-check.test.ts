import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectCountChecks,
  comparable,
  countSpecFiles,
  GENERATORS,
  parseCountRow,
  restoreDecision,
} from "../scripts/drift-check";

/**
 * DRIFT CHECK — the derivable-artifact gate (Chromium-style regeneration
 * diff). These pins hold the pure core: CURRENT-STATE row parsing, the
 * shared-tree restore-safety decision (never touch a sibling's dirty
 * paths), the spec-file counter contract, and that the live count checks
 * parse against the real docs/CURRENT-STATE.md.
 */

const MARKDOWN = [
  "| Foo | notes |",
  "| **Effects** (registry entries) | **52** | something |",
  "| **Instruments** (melodic track kind) | **22** |",
  "| **Project templates** | **14** |",
  "| **Vitest spec files**                         | **830** | long |",
  "| **No number here** | text |",
].join("\n");

describe("parseCountRow", () => {
  it("reads the second-column bold number after the label", () => {
    expect(parseCountRow(MARKDOWN, "Effects")).toBe(52);
    expect(parseCountRow(MARKDOWN, "Instruments")).toBe(22);
    expect(parseCountRow(MARKDOWN, "Project templates")).toBe(14);
    expect(parseCountRow(MARKDOWN, "Vitest spec files")).toBe(830);
  });

  it("returns null for missing rows and rows without a number", () => {
    expect(parseCountRow(MARKDOWN, "No number here")).toBeNull();
    expect(parseCountRow(MARKDOWN, "Nonexistent")).toBeNull();
  });

  it("does not match a label as a substring of another label", () => {
    // "Effects" must not grab a hypothetical "Effects (legacy)" row above it.
    const tricky = "| **Effects (legacy)** | **1** |\n| **Effects** | **52** |";
    expect(parseCountRow(tricky, "Effects")).toBe(52);
  });
});

describe("restoreDecision (shared-tree guardrail)", () => {
  it("never restores a path that was dirty before the check", () => {
    expect(restoreDecision(false, true)).toBe("skip");
    expect(restoreDecision(false, false)).toBe("skip");
  });

  it("clean paths: silently restore when identical, keep the diff when stale", () => {
    expect(restoreDecision(true, false)).toBe("restore");
    expect(restoreDecision(true, true)).toBe("keep-diff");
  });
});

describe("countSpecFiles", () => {
  it("counts the repo spec files excluding tests/e2e (the CURRENT-STATE contract)", () => {
    const count = countSpecFiles(process.cwd());
    expect(count).toBeGreaterThan(800);
    // e2e specs live under tests/e2e and are Playwright-owned — not counted.
    expect(count).not.toBe(0);
  });
});

/**
 * THE SECOND HALF OF THE SPEC COUNT.
 *
 * The spec-file count lives in TWO places: the hand-maintained number in
 * docs/CURRENT-STATE.md (which the gate READS) and the generated snapshot in
 * docs/status.json (which records what the check MEASURED). Moving the number
 * by hand and forgetting the snapshot made the [status] section red — and that
 * red arrived as a CI job, hours after the commit that caused it, on a machine
 * that had no way to explain itself.
 *
 * The drift gate does catch it. But that gate takes minutes and runs in CI.
 * This check asks the same question in milliseconds, in the unit suite: does
 * the committed payload still describe the tree we are standing in?
 *
 * It is the fast half of the slow gate, and it is the half that fires while
 * the session that made the mistake is still running.
 */
describe("the committed status payload's spec-count claim", () => {
  it("matches the live count RIGHT NOW", () => {
    const payload = JSON.parse(readFileSync(join(process.cwd(), "docs/status.json"), "utf8")) as {
      claims?: { id: string; summary: string }[];
    };
    const claim = payload.claims?.find((c) => c.id === "spec-counts");
    expect(claim, "docs/status.json has no spec-counts claim").toBeDefined();
    const live = countSpecFiles(process.cwd());
    expect(claim!.summary, "the committed status snapshot does not describe the current tree").toBe(
      `${live} claimed, ${live} measured`,
    );
  });
});

/**
 * THE TIMESTAMP IS IGNORED; THE LIVE ROWS ARE NOT.
 *
 * `npm run status:report` writes two files: `docs/status.json` (the stable
 * payload the gate compares) and `docs/STATUS.md` (the same claims as a page).
 *
 * The page carries a generation timestamp in its header, so it can never be
 * compared byte-for-byte with HEAD — every run would differ. The first answer
 * to that was to leave the page out of the comparison entirely. It was the
 * WRONG answer: the page also carries the LIVE claim rows, and a row that sat
 * at 1319 while the tree said 1323 is a stale number on a published page that
 * NO GATE COULD SEE.
 *
 * The right answer is to ignore exactly one thing — the volatile line — and
 * compare the rest. The timestamp never decides the verdict; the live rows
 * always do.
 */
describe("the status page's comparison policy", () => {
  const status = GENERATORS.find((section) => section.name === "status");

  it("declares the status section", () => {
    expect(status, "the status generator section is gone").toBeDefined();
  });

  it("OWNS the page — a published file with live rows must be compared", () => {
    expect(status!.ownedPaths).toContain("docs/STATUS.md");
    expect(status!.ownedPaths).toContain("docs/status.json");
  });

  it("ignores the generation timestamp and nothing else", () => {
    const section = status!;
    const a = "Generated 2026-10-28T13:30:46.976Z\n| count | 1323 |\n";
    const b = "Generated 2026-10-28T16:45:21.290Z\n| count | 1323 |\n";
    // A different timestamp is the SAME file.
    expect(comparable(a, section)).toBe(comparable(b, section));
    // A different claim row is a DIFFERENT file — and that is the whole point.
    const c = "Generated 2026-10-28T13:30:46.976Z\n| count | 1319 |\n";
    expect(comparable(a, section)).not.toBe(comparable(c, section));
  });

  it("the stable payload has no ignored lines at all", () => {
    expect(status!.ignoreCompareLines).toBeDefined();
    expect(GENERATORS.find((s) => s.name === "mcp-mirrors")!.ignoreCompareLines).toBeUndefined();
  });
});

describe("collectCountChecks (against the real docs/CURRENT-STATE.md)", () => {
  it("parses every tracked row and matches live code RIGHT NOW", () => {
    const checks = collectCountChecks(process.cwd());
    // The sample-library rows (assets / categories / kits) joined this list in
    // 2026-10-13. They were the hole in the gate: the dusty jazz wave moved
    // assets 151->155 and categories 14->15 and nothing here noticed either.
    // Pinning the label list is the point of the test — a NEW count added to
    // collectCountChecks without a CURRENT-STATE row (or the reverse) has to
    // turn this red, which is what it did on the first run of that wave.
    expect(checks.map((c) => c.label)).toEqual([
      "Effects",
      "Instruments",
      "Project templates",
      "Vitest spec files",
      "Factory assets",
      "Asset categories",
      "Genre kits",
    ]);
    for (const check of checks) {
      expect(check.claimed, `${check.label} row must exist in CURRENT-STATE`).not.toBeNull();
      expect(check.actual, `${check.label} live count must be positive`).toBeGreaterThan(0);
      // The whole point of the gate: claimed === actual at a clean HEAD.
      expect(check.claimed, `${check.label}: CURRENT-STATE says ${check.claimed}, code measures ${check.actual}`).toBe(
        check.actual,
      );
    }
  });
});
