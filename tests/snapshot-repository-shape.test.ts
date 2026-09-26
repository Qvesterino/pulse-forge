// Source-grep regression for src/persistence/SnapshotRepository.ts.
//
// SnapshotRepository backs the "restore to yesterday" safety net: every
// project document version stored under `${projectId}:${ts}` is a
// structured-clone copy of the doc at that point. Mutations go through
// the same `tx()` helper as ProjectRepository - a regression that
// bypasses atomicity corrupts both the user snapshot and the persistent
// in-memory index.
//
// Pure helper `shouldAutoSnapshot` decides whether an autosnapshot is
// due. The snapshot cadence is part of the recovery contract; a side
// effect inside it would drift every autosave decision in the codebase.
//
// Guards:
//   1. PUBLIC INTERFACE - ProjectSnapshot must stay `export interface`.
//   2. PUBLIC CONSTANTS - SNAPSHOTS_PER_PROJECT and
//      AUTO_SNAPSHOT_MIN_INTERVAL_MS must stay immutable `export const`.
//   3. PURE HELPER - shouldAutoSnapshot(newestCreatedAt, now?, min?) must
//      stay pure: no console / timer / storage / fetch tokens in body.
//   4. PUBLIC CLASS - SnapshotRepository is exported and its 5 public
//      methods (save, list, get, delete, prune) stay on the class.
//   5. PRIVATE METHODS - db, nextSeq, indexKeysFor stay private.
//   6. TRANSACTION GUARD - mutating methods (save, delete, prune) must
//      each contain a tx(...) call.
//   7. AUDIT - any novel export class / function / interface / const
//      outside the known sets fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/persistence/SnapshotRepository.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExport(lines: string[], kind: "class" | "interface" | "function" | "const", name: string): number | null {
  const re = new RegExp("^export\\s+" + kind + "\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findClassMethod(
  lines: string[],
  classIdx: number,
  methodName: string,
  visibility: "public" | "private",
): number | null {
  const explicitRe = new RegExp("^\\s+(public|private)\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  const implicitRe = new RegExp("^\\s+(?:async\\s+)?" + methodName + "\\s*\\(");
  for (let i = classIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (visibility === "public") {
      if (explicitRe.test(ln) && /^\s+public\s+/.test(ln)) return i;
      if (!/^\s+private\s+/.test(ln) && implicitRe.test(ln)) return i;
    } else {
      if (explicitRe.test(ln) && /^\s+private\s+/.test(ln)) return i;
    }
  }
  return null;
}

function readBody(lines: string[], startIdx: number): string[] {
  // Step 1: walk forward past the signature to find the body's opening
  // `{` (after parens are balanced). This avoids false-positive matches of
  // patterns like `): Type {` inside object literals or JSDoc comments.
  let openParens = 0;
  let bodyStart = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    for (const c of ln) {
      if (c === "(") openParens++;
      else if (c === ")") openParens--;
    }
    if (openParens <= 0 && /\{/.test(ln)) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart < 0) return [];
  // Step 2: from bodyStart, count braces. Depth <= 0 ends the body.
  const buf: string[] = [];
  let depth = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const ln = lines[i];
    depth += (ln.match(/\{/g) || []).length;
    depth -= (ln.match(/\}/g) || []).length;
    buf.push(ln);
    if (depth <= 0) break;
  }
  return buf;
}

const INTERFACE = "ProjectSnapshot";
const PUBLIC_CONSTS = ["SNAPSHOTS_PER_PROJECT", "AUTO_SNAPSHOT_MIN_INTERVAL_MS"];
const PURE_HELPERS = ["shouldAutoSnapshot"];
const CLASS_API_PUBLIC = ["save", "list", "get", "delete", "prune"];
const CLASS_API_PRIVATE = ["db", "nextSeq", "indexKeysFor"];
const TX_REQUIRED_METHODS = ["save", "delete", "prune"];

const SIDE_EFFECT_TOKENS = [
  "console",
  "setTimeout",
  "setInterval",
  "queueMicrotask",
  "fetch",
  "XMLHttpRequest",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document",
  // `window` is a true host-side-effect on the live thread; pure helpers
  // reach for `Date.now()` / `Math.random()` etc. but never `window.foo`.
  "window",
  "self",
  "globalThis",
];
describe("persistence/SnapshotRepository.ts — autosnapshot contract (source-grep)", () => {
  it("reads SnapshotRepository.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("public interface — ProjectSnapshot", () => {
    it("is `export interface`", () => {
      const idx = findExport(lines, "interface", "ProjectSnapshot");
      expect(idx, "ProjectSnapshot must be exported as an interface").not.toBeNull();
      const classIdx = findExport(lines, "class", "ProjectSnapshot");
      expect(classIdx, "ProjectSnapshot must not drift to `export class`").toBeNull();
    });
  });

  describe("public constants — must remain immutable", () => {
    for (const name of PUBLIC_CONSTS) {
      const title = name + " is `export const` (never `let`)";
      it(title, () => {
        const idx = findExport(lines, "const", name);
        if (idx === null) {
          throw new Error("Constant " + name + " no longer exported from SnapshotRepository.ts");
        }
        // No `let` may exist anywhere for this name.
        const letRe = new RegExp("^(?:export\\s+)?let\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !letRe.test(ln),
            name +
              " drifted to `let`. The autosnapshot thresholds are immutable - a mid-run reassignment would silently change the recovery cadence for every project.",
          ).toBe(true);
        }
      });
    }
  });

  describe("pure helper — shouldAutoSnapshot", () => {
    it("body has no console / timer / storage / DOM tokens", () => {
      const idx = findExport(lines, "function", "shouldAutoSnapshot");
      if (idx === null) {
        throw new Error("shouldAutoSnapshot no longer exported - restore it or update PURE_HELPERS");
      }
      const body = readBody(lines, idx);
      const debugReport: string[] = [];
      for (const ln of body) {
        // Strip `Date.foo(...)` and `Math.foo(...)` calls - the clock /
        // math library is synchronous and host-free, allowed in a pure
        // helper. Once stripped, the remaining text must not contain a
        // side-effect token.
        const stripped = ln.replace(/\b(?:Date|Math)\.\w+\s*\([^)]*\)/g, "PURE_CALL");
        for (const token of SIDE_EFFECT_TOKENS) {
          const re = new RegExp("\\b" + token + "\\b");
          if (re.test(stripped)) {
            debugReport.push("L: " + JSON.stringify(stripped) + " matched " + token);
          }
        }
      }
      if (debugReport.length > 0) {
        throw new Error(
          "shouldAutoSnapshot body has side-effect tokens: " +
            JSON.stringify(debugReport) +
            " - a drift would silently change every autosave decision.",
        );
      }
    });
  });

  describe("public class — SnapshotRepository surface", () => {
    it("class is exported", () => {
      const idx = findExport(lines, "class", "SnapshotRepository");
      expect(idx, "SnapshotRepository must be exported as a class").not.toBeNull();
    });

    describe("public methods — stay on the class", () => {
      for (const method of CLASS_API_PUBLIC) {
        const title = "SnapshotRepository." + method + " is a public method";
        it(title, () => {
          const classIdx = findExport(lines, "class", "SnapshotRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          expect(methodIdx, "SnapshotRepository." + method + " missing or drifted to private.").not.toBeNull();
        });
      }
    });

    describe("private methods — stay private", () => {
      for (const method of CLASS_API_PRIVATE) {
        const title = "SnapshotRepository." + method + " stays private";
        it(title, () => {
          const classIdx = findExport(lines, "class", "SnapshotRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "private");
          expect(
            methodIdx,
            "SnapshotRepository." +
              method +
              " must stay `private`. db() holds db-promise caching, nextSeq() owns the monotonic counter, indexKeysFor() encodes the in-memory index key shape.",
          ).not.toBeNull();
        });
      }
    });

    describe("transaction guard — mutating methods must use tx(...)", () => {
      for (const method of TX_REQUIRED_METHODS) {
        const title = "SnapshotRepository." + method + " body uses tx(...)";
        it(title, () => {
          const classIdx = findExport(lines, "class", "SnapshotRepository");
          if (classIdx === null) throw new Error("class not exported");
          const methodIdx = findClassMethod(lines, classIdx, method, "public");
          if (methodIdx === null) throw new Error("method " + method + " missing");
          const body = readBody(lines, methodIdx);
          const matches = body.filter((ln) => /\btx\s*\(/.test(ln));
          expect(
            matches.length,
            "SnapshotRepository." +
              method +
              " must open its work via tx(...). Found " +
              matches.length +
              " tx(...) call site(s).",
          ).toBeGreaterThan(0);
        });
      }
    });
  });

  describe("audit — every export class/function/interface/const is accounted for", () => {
    it("no orphan outside the known sets", () => {
      const re = /^export\s+(class|function|interface|const|type)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const tracked = new Set<string>([INTERFACE, ...PUBLIC_CONSTS, ...PURE_HELPERS, "SnapshotRepository"]);
      const novel: string[] = [];
      for (const item of seen) {
        if (!tracked.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in SnapshotRepository.ts not yet tracked: " +
            novel.join(", ") +
            " — add to the appropriate whitelist before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[snapshot-audit] SnapshotRepository.ts — exports: " +
          seen.length +
          " (" +
          seen.map((s) => s.name).join(", ") +
          "), public methods: " +
          CLASS_API_PUBLIC.length +
          ", private: " +
          CLASS_API_PRIVATE.length,
      );
    });
  });
});
