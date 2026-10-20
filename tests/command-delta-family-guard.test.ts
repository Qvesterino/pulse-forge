import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * NO WHOLE-DOCUMENT PINNING IN COMMANDS.
 *
 * Measured 2026-10-20 (edit-tools audit): `cutClips`, `pasteClips` and
 * `duplicateClips` were the last three commands in `src/commands/` that
 * still returned
 *
 *   { execute: () => next, undo: () => doc }
 *
 * — pinning BOTH whole documents. `src/commands/docDelta.ts` documents
 * that exact pattern as a defect family:
 *
 *   "`snapshot()`-style commands used to pin BOTH whole documents
 *    (`execute: () => next, undo: () => prev`). That made every dispatch
 *    a wholesale replacement: an async dispatch (e.g. the freeze render)
 *    silently reverted anything that changed between command creation and
 *    execution, and the undo stack kept whole document chains alive."
 *
 * The clipboard commands were the holdout: they predate the migration and
 * nobody went looking for them, because the family was believed closed.
 *
 * Two measured consequences, both now covered by
 * `tests/clip-clipboard-undo-fidelity.test.ts`:
 *   1. a change that lands between command creation and execution is
 *      silently discarded (the async revert), and
 *   2. one Ctrl+Z wipes every edit made after the command (the undo
 *      replaces the whole document with the pre-command one).
 *
 * This guard keeps the family closed. It reads the SOURCE, because the
 * shape that matters is syntactic: a command factory that returns
 * `execute: () => <doc>` pins a document.
 *
 * The one legitimate site is the fallback INSIDE `snapshot()` itself
 * (`src/commands/core.ts`), which exists for the case where the delta
 * engine cannot represent the change. That site is allowed, by name.
 */

const COMMANDS_DIR = resolve(process.cwd(), "src/commands");

/** The fallback inside `snapshot()` — the only allowed whole-document pin. */
const ALLOWED_FILES = new Set(["core.ts"]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Blank out comments while preserving line count. */
function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

describe("command family: no whole-document pinning (audit 2026-10-20)", () => {
  const files = collectTsFiles(COMMANDS_DIR);

  it("the scan sees the command sources", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("no command factory returns execute: () => <document>", () => {
    const violations: string[] = [];
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()!;
      if (ALLOWED_FILES.has(name)) continue;
      const src = stripComments(readFileSync(file, "utf-8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // `execute: () => next` / `execute: () => pasted` — a captured
        // document handed back wholesale.
        if (!/\bexecute\s*:\s*\(\s*\)\s*=>/.test(lines[i]!)) continue;
        violations.push(`${name}:${i + 1}  ${lines[i]!.trim()}`);
      }
    }
    expect(
      violations,
      `A command must capture the CHANGE, not the document. Use snapshot() from ` +
        `src/commands/core.ts — it stores the id-anchored delta and applies it to ` +
        `whatever document is current at execution time. A whole-document pin ` +
        `silently reverts concurrent edits and makes one undo wipe every later ` +
        `edit. Offending sites:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no command factory returns undo: () => <document>", () => {
    const violations: string[] = [];
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()!;
      if (ALLOWED_FILES.has(name)) continue;
      const src = stripComments(readFileSync(file, "utf-8"));
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!/\bundo\s*:\s*\(\s*\)\s*=>/.test(lines[i]!)) continue;
        violations.push(`${name}:${i + 1}  ${lines[i]!.trim()}`);
      }
    }
    expect(
      violations,
      `A command's undo must apply the INVERSE delta to the current document, not ` +
        `restore a pinned snapshot of the whole document — the pinned version wipes ` +
        `every edit made after the command. Use snapshot() from src/commands/core.ts. ` +
        `Offending sites:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: the scan detects a whole-document pin", () => {
    const synthetic = [
      "export function fakeCut(doc) {",
      "  const next = { ...doc };",
      "  return {",
      '    type: "fakeCut",',
      "    label: "Fake",",
      "    execute: () => next,",
      "    undo: () => doc,",
      "  };",
      "}",
    ].join("\n");
    const lines = stripComments(synthetic).split(/\r?\n/);
    const executePins = lines.filter((l) => /\bexecute\s*:\s*\(\s*\)\s*=>/.test(l));
    const undoPins = lines.filter((l) => /\bundo\s*:\s*\(\s*\)\s*=>/.test(l));
    expect(executePins.length).toBe(1);
    expect(undoPins.length).toBe(1);
  });

  it("POSITIVE CONTROL: the allowed fallback in core.ts is the only pin", () => {
    // The guard must not be satisfied by allowing everything: exactly one
    // file may pin, and it is the delta engine's own fallback.
    const pinningFiles = files.filter((file) => {
      const name = file.split(/[\\/]/).pop()!;
      if (ALLOWED_FILES.has(name)) return false;
      const src = stripComments(readFileSync(file, "utf-8"));
      return /\bexecute\s*:\s*\(\s*\)\s*=>/.test(src);
    });
    expect(pinningFiles).toEqual([]);
    // And the fallback really is there — if it is removed, the allowlist
    // entry is dead and needs re-review.
    const core = stripComments(readFileSync(join(COMMANDS_DIR, "core.ts"), "utf-8"));
    expect(core).toMatch(/execute:\s*\(\)\s*=>\s*next/);
  });
});
