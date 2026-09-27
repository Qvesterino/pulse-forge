// Source-grep regression for Command shape consistency in src/commands/commands.ts.
//
// Three guards:
//
//   1. PINNED mutating factories must declare a `Command` return type.
//   2. PURE queries must NOT declare a Command return type (they are read-only
//      helpers — returning a Command-shape would leak an undo entry for nothing).
//   3. STRUCTURAL: a sample of well-known factories must actually contain an
//      `execute:` and `undo:` member inside their function body so the source
//      contract matches the runtime Command interface.
//
// Risk rationale: any change in the exports / signatures of commands.ts during
// a busy parallel session is a regression vector. The whitelist + structural
// subset keeps this regression deterministic — no time-based, no flaky patterns.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMANDS_FILE = resolve(process.cwd(), "src/commands/commands.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(COMMANDS_FILE, "utf8").split(/\r?\n/);
});

/** 0-indexed line of `export function NAME(`, or null. */
function findExportFn(lines: string[], name: string): number | null {
  const re = new RegExp("^export\\s+(?:async\\s+)?function\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

/**
 * Concatenate the signature lines (allowing multi-line). Walks from `startIdx`
 * forward until parentheses balance and a return-type colon line is found.
 * Caps at 30 lines for safety.
 */
function readSignature(lines: string[], startIdx: number): string {
  let sig = "";
  let openParens = 0;
  let i = startIdx;
  let foundClose = false;
  while (i < lines.length && i - startIdx < 30) {
    sig += lines[i] + "\n";
    for (const c of lines[i]) {
      if (c === "(") openParens++;
      else if (c === ")") openParens--;
    }
    // Once parens closed, look for `: ReturnType` on the closing line or next.
    if (openParens === 0 && /\)\s*:/.test(lines[i])) {
      foundClose = true;
      break;
    }
    i++;
  }
  // If no inline `:` return type, the return type may be on a continuation line.
  if (!foundClose) {
    while (i < lines.length && i - startIdx < 35) {
      sig += lines[i] + "\n";
      if (/^\s*\)\s*:/.test(lines[i]) || /^\s*\)\s*\{/.test(lines[i])) break;
      if (lines[i].includes("{")) break;
      i++;
    }
  }
  return sig;
}

function returnsCommand(sig: string): boolean {
  // Look for `): Command` or `): ... | Command` etc.
  return /:\s*[^()\n]*\bCommand\b/.test(sig);
}

function returnsNonCommandReturn(sig: string): boolean {
  // Find the `: Type` after `)`. We look for any non-void named return.
  const m = sig.match(/\)\s*:\s*([^\n{]+)/);
  if (!m) return false;
  const t = m[1]
    .trim()
    .replace(/[;{].*/, "")
    .trim();
  if (!t) return false;
  if (/\bCommand\b/.test(t)) return false;
  if (t === "void") return false;
  return true;
}

interface StructCheckResult {
  hasExecute: boolean;
  hasUndo: boolean;
  hasApplyToYDoc: boolean;
  hasType: boolean;
  hasLabel: boolean;
  hasSnapshotReturn: boolean;
}

/**
 * Walk the function body until the closing brace. Detect presence of the
 * canonical Command members (`execute:`, `undo:`, optional `type:`, `label:`,
 * `applyToYDoc:`) on any line inside the body.
 */
function scanBody(lines: string[], startIdx: number): StructCheckResult {
  let depth = 0;
  let sawOpen = false;
  const result: StructCheckResult = {
    hasExecute: false,
    hasUndo: false,
    hasApplyToYDoc: false,
    hasType: false,
    hasLabel: false,
    hasSnapshotReturn: false,
  };
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    for (const c of ln) {
      if (c === "{") {
        depth++;
        sawOpen = true;
      } else if (c === "}") depth--;
    }
    if (sawOpen) {
      // Match property name followed by colon (key: …) — discriminator for the
      // returned object literal so we don't catch e.g. destructured `execute(`
      // function calls.
      if (/^\s*execute\s*:\s/.test(ln) || /\bexecute\s*:\s/.test(ln)) result.hasExecute = true;
      if (/^\s*undo\s*:\s/.test(ln) || /\bundo\s*:\s/.test(ln)) result.hasUndo = true;
      if (/\bapplyToYDoc\s*:/.test(ln)) result.hasApplyToYDoc = true;
      if (/^\s*type\s*:\s/.test(ln)) result.hasType = true;
      if (/^\s*label\s*:\s/.test(ln)) result.hasLabel = true;
      // Helper delegation: `return snapshot(...)` or `return snapshot<Type>(...)`.
      if (/^\s*return\s+snapshot[\s(]/.test(ln)) result.hasSnapshotReturn = true;
    }
    if (sawOpen && depth === 0) break;
  }
  return result;
}

// ----------------------------------------------------------------------------
// Whitelists — pinned regression anchors. Adding a new command? Add it to the
// correct set below (or write a sibling test that asserts its shape).
// ----------------------------------------------------------------------------

const MUTATING_FACTORIES: string[] = [
  // Top exports + previously-inventoried verbs.
  "snapshot",
  "setProjectName",
  "setBpm",
  "toggleStep",
  "setStepVelocityCommand",
  "prepareRecordPattern",
  "sliceToPads",
  "setPadParams",
  "setTrackParams",
  "createPattern",
  "duplicatePattern",
  "duplicatePatternForScene",
  "deletePattern",
  "reorderPattern",
  "renamePattern",
  "setActivePattern",
  "setPatternLength",
  "clearPattern",
  "pastePattern",
  "setGroove",
  "setStepLocks",
  "createFill",
  "createDrumTrack",
  "createInstrumentTrack",
  "createGroupTrack",
  "createGenerativeTrack",
  "addToGroup",
  "addNote",
  "deleteNote",
  "deleteNotes",
  "duplicateNotes",
  "quantizeNotes",
  "setSceneIntensityCurve",
  "applyKitToDrumTrack",
  "installPackSketch",
  "stealGrooveIntoPattern",
];

const PURE_QUERIES: string[] = [
  "captureKitFromTrack", // returns KitPadCapture[] — no undo entry expected.
];

// Smaller subset for structural integrity.
// Two flavors:
//  - DIRECT: factories that return an object literal with `execute:` / `undo:`.
//  - HELPER: factories that delegate to `snapshot(...)` — execute/undo live in
//    the helper body, not here. We verify the delegation + the helper itself.
const STRUCTURAL_DIRECT: string[] = ["setProjectName", "setBpm", "setStepVelocityCommand"];
const STRUCTURAL_HELPER: string[] = ["createPattern", "duplicatePattern"];

describe("commands.ts — Command shape consistency (source-grep baseline)", () => {
  it("reads commands.ts", () => {
    expect(lines.length).toBeGreaterThan(100);
  });

  describe("pinned mutating factories — return Command", () => {
    for (const name of MUTATING_FACTORIES) {
      const title = name + " declares a Command return type";
      it(title, () => {
        const idx = findExportFn(lines, name);
        if (idx === null) {
          throw new Error(
            "Mutating factory " + name + " no longer exported from commands.ts — restore or update MUTATING_FACTORIES",
          );
        }
        const sig = readSignature(lines, idx);
        expect(
          returnsCommand(sig),
          name + " must declare `: Command` (or a union containing Command). Got signature:\n" + sig,
        ).toBe(true);
      });
    }
  });

  describe("pinned pure queries — return non-Command", () => {
    for (const name of PURE_QUERIES) {
      const title = name + " stays a pure query (no Command return)";
      it(title, () => {
        const idx = findExportFn(lines, name);
        if (idx === null) {
          throw new Error(
            "Pure query " + name + " no longer exported from commands.ts — restore or update PURE_QUERIES",
          );
        }
        const sig = readSignature(lines, idx);
        expect(
          returnsCommand(sig),
          name + " must NOT declare a Command return type (it is a read-only helper). Got:\n" + sig,
        ).toBe(false);
        expect(
          returnsNonCommandReturn(sig),
          name + " must declare a non-void return type so callers can use the value. Got:\n" + sig,
        ).toBe(true);
      });
    }
  });

  describe("structural integrity — direct-shape factories declare execute + undo", () => {
    for (const name of STRUCTURAL_DIRECT) {
      const title = name + " body declares execute: and undo: properties";
      it(title, () => {
        const idx = findExportFn(lines, name);
        if (idx === null) {
          throw new Error("Structural anchor " + name + " not found in commands.ts");
        }
        const body = scanBody(lines, idx);
        expect(body.hasExecute, name + " must contain an `execute:` property in its returned Command shape").toBe(true);
        expect(body.hasUndo, name + " must contain an `undo:` property in its returned Command shape").toBe(true);
        expect(
          body.hasType || body.hasLabel,
          name + " should also declare `type:` / `label:` in its returned Command",
        ).toBe(true);
      });
    }
  });

  describe("structural integrity — helper-delegated factories call snapshot()", () => {
    for (const name of STRUCTURAL_HELPER) {
      const title = name + " body delegates via return snapshot(...)";
      it(title, () => {
        const idx = findExportFn(lines, name);
        if (idx === null) {
          throw new Error("Structural anchor " + name + " not found in commands.ts");
        }
        const body = scanBody(lines, idx);
        expect(
          body.hasSnapshotReturn,
          name + " must `return snapshot(...)` so execute/undo flow through the helper",
        ).toBe(true);
        // The returned Command shape lives in `snapshot()` — verify that helper
        // itself contains execute + undo so the contract is preserved transitively.
        const helperIdx = findExportFn(lines, "snapshot");
        expect(helperIdx, "snapshot helper must be exported").not.toBeNull();
        const helperBody = scanBody(lines, helperIdx!);
        expect(helperBody.hasExecute, "snapshot helper must contain `execute:` (transitive Command contract)").toBe(
          true,
        );
        expect(helperBody.hasUndo, "snapshot helper must contain `undo:` (transitive Command contract)").toBe(true);
      });
    }
  });

  describe("audit — whitelist integrity", () => {
    it("every MUTATING_FACTORY in whitelist resolves and returns Command", () => {
      // Practical side of the audit: every name we trust as a mutating factory
      // must be both present and Command-returning. The whitelist is the
      // ground truth — adding a factory to MUTATING_FACTORIES is the
      // explicit decision a maintainer makes.
      for (const name of MUTATING_FACTORIES) {
        const idx = findExportFn(lines, name);
        expect(idx, name + " must be exported from commands.ts").not.toBeNull();
        if (idx === null) continue;
        const sig = readSignature(lines, idx);
        expect(returnsCommand(sig), name + " must return a Command (or a union containing Command). Got:\n" + sig).toBe(
          true,
        );
      }
    });

    it("every PURE_QUERY in whitelist resolves and does NOT return Command", () => {
      for (const name of PURE_QUERIES) {
        const idx = findExportFn(lines, name);
        expect(idx, name + " must be exported from commands.ts").not.toBeNull();
        if (idx === null) continue;
        const sig = readSignature(lines, idx);
        expect(returnsCommand(sig), name + " must NOT return Command — it is a read-only helper. Got:\n" + sig).toBe(
          false,
        );
        expect(returnsNonCommandReturn(sig), name + " must declare a non-void return type. Got:\n" + sig).toBe(true);
      }
    });

    it("scans for additional Command-returners outside the whitelist (diagnostic)", () => {
      // commands.ts carries ~130+ Command-returning factories. Pinning them
      // all in MUTATING_FACTORIES would make every commit a maintenance chore.
      // Instead we acknowledge them as discovered and surface a diagnostic
      // report: a novel Command-returner outside our explicit whitelist is a
      // sign maintainers should consider promoting it to MUTATING_FACTORIES.
      //
      // This is intentionally not a fail. It is a trend-signal for the next
      // cleanup pass.
      const known = new Set<string>([
        ...MUTATING_FACTORIES,
        ...PURE_QUERIES,
        ...STRUCTURAL_DIRECT,
        ...STRUCTURAL_HELPER,
      ]);
      const re = /^export\s+(?:async\s+)?function\s+(\w+)/;
      const discovered: string[] = [];
      let totalCommandReturners = 0;
      let totalExports = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        totalExports++;
        const name = m[1];
        if (name.startsWith("__")) continue;
        const sig = readSignature(lines, i);
        if (!returnsCommand(sig)) continue;
        totalCommandReturners++;
        if (!known.has(name)) discovered.push(name);
      }
      // eslint-disable-next-line no-console
      console.info(
        "[shape-audit] commands.ts — exports: " +
          totalExports +
          ", Command-returners: " +
          totalCommandReturners +
          ", whitelisted: " +
          known.size +
          ", additional: " +
          discovered.length,
      );
      if (discovered.length > 0) {
        // eslint-disable-next-line no-console
        console.info(
          "[shape-audit] additional factories (not yet in MUTATING_FACTORIES, sample): " +
            discovered.slice(0, 12).join(", "),
        );
      }
      // No assertion — this is a trend signal, not a regression gate.
    });
  });
});
