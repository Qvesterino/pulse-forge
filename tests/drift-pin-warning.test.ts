/**
 * The pre-commit drift-pin guard counts from the INDEX, and it never blocks.
 *
 * WHY THIS SPEC EXISTS. The guard replaced the hook that was switched off in
 * 2026-09-19 (it blocked commits whenever another agent's in-flight work had
 * type errors). So it has to carry the two properties that made the old hook
 * unusable in a shared worktree:
 *
 *   1. it counts the tree as it will be COMMITTED — the index — not the
 *      working tree. Otherwise another session's uncommitted spec files would
 *      be reported against their commit, for something that is not their work.
 *   2. it WARNS and never blocks: the exit code is 0 whatever it finds.
 *
 * The peer audit flagged the same gap for the machine-load guard ("no spec
 * covers the calibration"). A guard whose behaviour is only ever observed in
 * production is a guard nobody can reason about.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(process.cwd(), "scripts", "drift-pin-warning.mjs");

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** A repository whose INDEX carries `pin` and `specFiles`. */
function makeRepo(pin: number, specFiles: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "kyx-drift-pin-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "docs", "CURRENT-STATE.md"),
    `| **Vitest spec files**                                 | **${pin}** | measured |\n`,
    "utf8",
  );
  for (const file of specFiles) writeFileSync(join(root, "tests", file), "// spec\n", "utf8");
  git(root, "add", "-A");
  return root;
}

function runGuard(root: string): { code: number; out: string } {
  const result = spawnSync(process.execPath, [GUARD, root], { encoding: "utf8" });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("the pre-commit drift-pin guard", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts the tree as it will be committed, not the working tree", () => {
    const root = makeRepo(1, ["one.test.ts"]);
    roots.push(root);
    // Another session's UNCOMMITTED spec file: it must not be counted, and
    // it must not turn into a warning against this commit.
    writeFileSync(join(root, "tests", "someone-elses-wip.test.ts"), "// not mine\n", "utf8");
    const result = runGuard(root);
    expect(result.out).not.toContain("WARNING");
    expect(result.code).toBe(0);
  });

  it("warns when the pin does not match the tree being committed", () => {
    const root = makeRepo(5, ["one.test.ts"]);
    roots.push(root);
    const result = runGuard(root);
    expect(result.out).toContain("WARNING");
    expect(result.out).toContain("claims 5");
    expect(result.out).toContain("carries 1");
    // A warning, never a block.
    expect(result.code).toBe(0);
  });

  it("excludes tests/e2e from the count, like the drift gate does", () => {
    const root = makeRepo(1, ["one.test.ts"]);
    roots.push(root);
    mkdirSync(join(root, "tests", "e2e"), { recursive: true });
    writeFileSync(join(root, "tests", "e2e", "smoke.test.ts"), "// e2e\n", "utf8");
    git(root, "add", "-A");
    const result = runGuard(root);
    expect(result.out).not.toContain("WARNING");
  });

  it("reads the pin out of a CURRENT-STATE.md larger than Node's spawn buffer", () => {
    // The real CURRENT-STATE.md outgrew the default 1 MB spawn buffer once,
    // and the guard went SILENT — the one moment it had to speak. A document
    // with a long row must not silence it.
    const root = makeRepo(7, ["one.test.ts"]);
    roots.push(root);
    const filler = "x".repeat(2 * 1024 * 1024);
    writeFileSync(
      join(root, "docs", "CURRENT-STATE.md"),
      `| **Vitest spec files**                                 | **7** | measured |\n${filler}\n`,
      "utf8",
    );
    git(root, "add", "-A");
    const result = runGuard(root);
    expect(result.out).toContain("claims 7");
    expect(result.out).toContain("carries 1");
    expect(result.code).toBe(0);
  });
});
