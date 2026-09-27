// Source-grep regression for src/commands/layerCommands.ts.
//
// Sister test to commands-shape-consistency.test.ts but scoped to the
// velocity-layer / randomize-instrument helpers. layerCommands.ts is a
// small (~80 line) sibling of commands.ts with two factories that both
// delegate through the shared `snapshot()` helper from commands.ts.
//
// Guards:
//   1. Both mutating factories must declare `: Command` return.
//   2. Both factories must delegate via `return snapshot(...)` so the
//      Command contract (execute / undo) flows through the shared helper.
//   3. `sanitizeLayers` is internal-only and must NOT be exported (it
//      operates on untrusted JSON, leaking it would bypass the snapshot
//      guardrail).
//   4. Audit — any novel `export function` outside the whitelist is a
//      signal that the surface drifted.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LAYER_FILE = resolve(process.cwd(), "src/commands/layerCommands.ts");
const COMMANDS_FILE = resolve(process.cwd(), "src/commands/commands.ts");

let layerLines: string[] = [];
let commandsLines: string[] = [];

beforeAll(() => {
  layerLines = readFileSync(LAYER_FILE, "utf8").split(/\r?\n/);
  commandsLines = readFileSync(COMMANDS_FILE, "utf8").split(/\r?\n/);
});

function findExportFn(lines: string[], name: string): number | null {
  const re = new RegExp("^export\\s+(?:async\\s+)?function\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findAnyFn(lines: string[], name: string): number | null {
  const re = new RegExp("^(?:export\\s+)?(?:async\\s+)?function\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function readSignature(lines: string[], startIdx: number): string {
  let sig = "";
  let openParens = 0;
  let i = startIdx;
  while (i < lines.length && i - startIdx < 30) {
    sig += lines[i] + "\n";
    for (const c of lines[i]) {
      if (c === "(") openParens++;
      else if (c === ")") openParens--;
    }
    if (openParens === 0 && /\)\s*:/.test(lines[i])) return sig;
    i++;
  }
  // Multi-line: append the closing lines until we find `): Type` or `{`.
  while (i < lines.length && i - startIdx < 40) {
    sig += lines[i] + "\n";
    if (/^\s*\)\s*:/.test(lines[i]) || /^\s*\)\s*\{/.test(lines[i])) return sig;
    if (lines[i].includes("{")) return sig;
    i++;
  }
  return sig;
}

function returnsCommand(sig: string): boolean {
  return /:\s*[^()\n]*\bCommand\b/.test(sig);
}

function scanBody(
  lines: string[],
  startIdx: number,
): {
  hasExecute: boolean;
  hasUndo: boolean;
  hasSnapshotReturn: boolean;
} {
  let depth = 0;
  let sawOpen = false;
  const result = { hasExecute: false, hasUndo: false, hasSnapshotReturn: false };
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    for (const c of ln) {
      if (c === "{") {
        depth++;
        sawOpen = true;
      } else if (c === "}") depth--;
    }
    if (sawOpen) {
      if (/\bexecute\s*:/.test(ln)) result.hasExecute = true;
      if (/\bundo\s*:/.test(ln)) result.hasUndo = true;
      if (/^\s*return\s+snapshot[\s(]/.test(ln)) result.hasSnapshotReturn = true;
    }
    if (sawOpen && depth === 0) break;
  }
  return result;
}

const LAYER_COMMANDS: string[] = ["setVelocityLayersCommand", "randomizeInstrumentCommand"];

const INTERNAL_HELPERS: string[] = [
  "sanitizeLayers", // untrusted-JSON filter, must remain non-exported.
];

describe("layerCommands.ts — Command shape (source-grep)", () => {
  it("reads layerCommands.ts", () => {
    expect(layerLines.length).toBeGreaterThan(20);
  });

  describe("pinned layer factories — return Command", () => {
    for (const name of LAYER_COMMANDS) {
      const title = name + " declares : Command return";
      it(title, () => {
        const idx = findExportFn(layerLines, name);
        if (idx === null) {
          throw new Error("Layer factory " + name + " no longer exported — restore it or update LAYER_COMMANDS");
        }
        const sig = readSignature(layerLines, idx);
        expect(returnsCommand(sig), name + " must declare `: Command`. Got:\n" + sig).toBe(true);
      });
    }
  });

  describe("layer factories — delegate via snapshot(...)", () => {
    for (const name of LAYER_COMMANDS) {
      const title = name + " body contains `return snapshot(...)`";
      it(title, () => {
        const idx = findExportFn(layerLines, name);
        if (idx === null) {
          throw new Error("Layer factory " + name + " not found");
        }
        const body = scanBody(layerLines, idx);
        expect(
          body.hasSnapshotReturn,
          name + " must `return snapshot(...)` so execute/undo flow through the helper",
        ).toBe(true);
      });
    }
  });

  describe("snapshot helper — executable in commands.ts (transitive contract)", () => {
    it("shared snapshot helper still has execute + undo", () => {
      const idx = findExportFn(commandsLines, "snapshot");
      expect(idx, "snapshot helper must be exported from commands.ts").not.toBeNull();
      const body = scanBody(commandsLines, idx!);
      expect(body.hasExecute, "snapshot must contain `execute:`").toBe(true);
      expect(body.hasUndo, "snapshot must contain `undo:`").toBe(true);
    });
  });

  describe("internal helpers — must NOT be exported", () => {
    for (const name of INTERNAL_HELPERS) {
      const title = name + " stays a non-exported internal helper";
      it(title, () => {
        // Exported?
        const expIdx = findExportFn(layerLines, name);
        expect(
          expIdx,
          name +
            " is now exported from layerCommands.ts. sanitizeLayers operates on untrusted JSON — leaking it past the snapshot guardrail is a regression. Demote it back to an internal helper or wrap with a factory that re-validates at apply time.",
        ).toBeNull();
        // Must still be defined as a function in the file.
        const anyIdx = findAnyFn(layerLines, name);
        expect(anyIdx, name + " must still exist in layerCommands.ts").not.toBeNull();
      });
    }
  });

  describe("audit — every exported function in layerCommands.ts is accounted for", () => {
    it("no orphan `export function` outside LAYER_COMMANDS", () => {
      const re = /^export\s+(?:async\s+)?function\s+(\w+)/;
      const seen: string[] = [];
      for (let i = 0; i < layerLines.length; i++) {
        const m = layerLines[i].match(re);
        if (m) seen.push(m[1]);
      }
      const known = new Set<string>(LAYER_COMMANDS);
      const knownHelpers = new Set<string>(INTERNAL_HELPERS); // not exported, but tracked
      const novelExports: string[] = [];
      for (const name of seen) {
        if (!known.has(name) && !knownHelpers.has(name)) {
          novelExports.push(name);
        }
      }
      if (novelExports.length > 0) {
        throw new Error(
          "Novel export(s) in layerCommands.ts not yet tracked: " +
            novelExports.join(", ") +
            " — add to LAYER_COMMANDS (if mutating) or INTERNAL_HELPERS (if internal).",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[layer-audit] layerCommands.ts — exports: " +
          seen.length +
          " (" +
          seen.join(", ") +
          "), internal helpers tracked: " +
          knownHelpers.size,
      );
    });
  });
});
