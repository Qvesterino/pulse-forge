import { describe, expect, it } from "vitest";
import { collectCountChecks, countSpecFiles, parseCountRow, restoreDecision } from "../scripts/drift-check";

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

describe("collectCountChecks (against the real docs/CURRENT-STATE.md)", () => {
  it("parses every tracked row and matches live code RIGHT NOW", () => {
    const checks = collectCountChecks(process.cwd());
    expect(checks.map((c) => c.label)).toEqual(["Effects", "Instruments", "Project templates", "Vitest spec files"]);
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
