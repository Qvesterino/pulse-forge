import { describe, expect, it } from "vitest";
import { collectCountChecks, countSpecFiles, GENERATORS, parseCountRow, restoreDecision } from "../scripts/drift-check";

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
 * THE VOLATILE-PATH POLICY.
 *
 * `npm run status:report` writes two files: `docs/status.json` (the stable
 * payload the gate compares) and `docs/STATUS.md` (the same claims as a page,
 * whose header carries a generation timestamp).
 *
 * The timestamp makes STATUS.md VOLATILE: it can never be compared with HEAD,
 * because every regeneration differs. If it were OWNED, the gate would be red
 * on every single run — the flapping that made the file unusable as a
 * comparison target in the first place.
 *
 * But "not owned" is not "leave it dirty". The file was left dirty on every
 * gate run, and in a shared worktree a dirty generated file is a hazard: the
 * next session's `git add .` sweeps it into an unrelated commit. It is now
 * declared VOLATILE — restored after the check, never compared — and these
 * pins hold that distinction, because collapsing the two lists is the one
 * change that would put the gate back in the red.
 */
describe("the volatile-path policy", () => {
  const status = GENERATORS.find((section) => section.name === "status");

  it("declares the status section", () => {
    expect(status, "the status generator section is gone").toBeDefined();
  });

  it("never OWNS a volatile path — a timestamp cannot be compared with HEAD", () => {
    for (const section of GENERATORS) {
      for (const path of section.volatilePaths ?? []) {
        expect(section.ownedPaths, `${section.name} owns ${path} and declares it volatile`).not.toContain(path);
      }
    }
    expect(status!.ownedPaths).not.toContain("docs/STATUS.md");
  });

  it("RESTORES the volatile path, so a gate run leaves no trace", () => {
    expect(status!.volatilePaths).toContain("docs/STATUS.md");
  });

  it("keeps the stable payload owned — that one IS comparable", () => {
    expect(status!.ownedPaths).toContain("docs/status.json");
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
