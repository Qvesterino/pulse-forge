// Source-grep regression for src/commands/docDelta.ts.
//
// docDelta describes id-anchored structural deltas between immutably-built
// documents. Each DeltaOp carries a discriminant `k` ("set" | "del" | "ins"
// | "move") and the apply / diff walk is a pure tree reduce.
//
// Guards:
//   1. DeltaOp UNION — the type must list exactly the four discriminant
//      shapes declared at the top of the module. A novel op-kind added
//      without registering here would skip the runtime guard and silently
//      fall through applyOp without a handler.
//   2. PUBLIC API — computeDocDelta and applyDocDelta are the two entry
//      points used by commands / collab. They must remain exported and
//      retain their `(...): DocDelta` / `(...): ProjectDocument` return
//      contracts.
//   3. PURE HELPERS — deepEqualRef and deepFreeze are pure utility
//      re-exports. Their signature must not drift to mutating returns.
//   4. INTERNAL NOT-EXPORTED — diff* and applyOp/descend/applyLeaf/moveById
//      walk the tree. Leaking them would let UI bypass computeDocDelta's
//      prune-by-reference pass and apply an under-specified patch.
//   5. AUDIT — any novel `export function` outside the public-API set
//      fails this test.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DELTA_FILE = resolve(process.cwd(), "src/commands/docDelta.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(DELTA_FILE, "utf8").split(/\r?\n/);
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
  while (i < lines.length && i - startIdx < 40) {
    sig += lines[i] + "\n";
    if (/^\s*\)\s*:/.test(lines[i]) || /^\s*\)\s*\{/.test(lines[i])) return sig;
    if (lines[i].includes("{")) return sig;
    i++;
  }
  return sig;
}

function returnsType(sig: string, typeName: string): boolean {
  return new RegExp(":\\s*[^()\\n]*\\b" + typeName + "\\b").test(sig);
}

const PUBLIC_API: string[] = [
  "computeDocDelta",
  "applyDocDelta",
  "deepEqualRef",
  "deepFreeze",
];

const INTERNAL_HELPERS: string[] = [
  "isPlainObject",
  "idOf",
  "isEntityList",
  "diffAny",
  "diffObject",
  "diffEntityArray",
  "diffPlainArray",
  "applyOp",
  "descend",
  "applyLeaf",
  "moveById",
];

// Discriminant kinds declared in DeltaOp. Any new op-kind must be tracked.
const DELTA_OP_KINDS: string[] = ["set", "del", "ins", "move"];

describe("docDelta.ts — public surface (source-grep)", () => {
  it("reads docDelta.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("DeltaOp union — discriminant kinds", () => {
    it("declares exactly four op-kinds in the body", () => {
      // Count the union cases in the `export type DeltaOp = ...` block.
      // The source convention: `{ k: "set"; ... } | { k: "del"; ... } | ...`.
      const kinds = new Set<string>();
      for (const ln of lines) {
        const m = ln.match(/\bk:\s*"([a-z]+)"\s*;/);
        if (m) kinds.add(m[1]);
      }
      // Found kinds must equal the tracked set. New kinds without updating
      // the constant here will surface as a regression.
      for (const k of DELTA_OP_KINDS) {
        expect(kinds.has(k), "DeltaOp must still declare kind " + k).toBe(true);
      }
      // And vice versa — a stray `k: "x"` outside our set fails this test.
      for (const k of kinds) {
        expect(
          DELTA_OP_KINDS.includes(k),
          "Novel DeltaOp kind '" + k + "' not tracked in DELTA_OP_KINDS. Add it before merging (runtime applyOp may not handle it).",
        ).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.info("[delta-audit] DeltaOp kinds declared: [" + Array.from(kinds).sort().join(", ") + "]");
    });
  });

  describe("public API — return types", () => {
    it("computeDocDelta returns DocDelta", () => {
      const idx = findExportFn(lines, "computeDocDelta");
      if (idx === null) throw new Error("computeDocDelta no longer exported");
      const sig = readSignature(lines, idx);
      expect(returnsType(sig, "DocDelta"), "computeDocDelta must return DocDelta. Got:\n" + sig).toBe(true);
    });

    it("applyDocDelta returns ProjectDocument", () => {
      const idx = findExportFn(lines, "applyDocDelta");
      if (idx === null) throw new Error("applyDocDelta no longer exported");
      const sig = readSignature(lines, idx);
      expect(
        returnsType(sig, "ProjectDocument"),
        "applyDocDelta must return ProjectDocument (pure tree-reduce). Got:\n" + sig,
      ).toBe(true);
    });

    it("deepEqualRef + deepFreeze remain pure utilities (no ProjectDocument return)", () => {
      for (const name of ["deepEqualRef", "deepFreeze"]) {
        const idx = findExportFn(lines, name);
        if (idx === null) throw new Error(name + " no longer exported");
        const sig = readSignature(lines, idx);
        // Pure utility — must NOT return ProjectDocument. A drift to that
        // return type signals the function stopped being a side-effect free
        // helper, which is the whole point of the module.
        expect(
          !returnsType(sig, "ProjectDocument"),
          name + " is no longer a pure utility. Returning ProjectDocument means callers can hand it a doc and observe doc-shaped output — that's applyDocDelta's job. Got:\n" + sig,
        ).toBe(true);
      }
    });
  });

  describe("internal helpers — must NOT be exported", () => {
    for (const name of INTERNAL_HELPERS) {
      const title = name + " stays a non-exported internal helper";
      it(title, () => {
        const expIdx = findExportFn(lines, name);
        expect(
          expIdx,
          name + " is now exported from docDelta.ts. The diff/apply walk helpers are an implementation detail — leaking them past computeDocDelta lets UI/CAFs bypass the reference-pruning pass and apply an under-specified patch. Demote back or wrap with a re-validation factory.",
        ).toBeNull();
        const anyIdx = findAnyFn(lines, name);
        expect(anyIdx, name + " must still exist in docDelta.ts").not.toBeNull();
      });
    }
  });

  describe("audit — every export function in docDelta.ts is accounted for", () => {
    it("no orphan `export function` outside PUBLIC_API", () => {
      const re = /^export\s+(?:async\s+)?function\s+(\w+)/;
      const seen: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) seen.push(m[1]);
      }
      const known = new Set<string>(PUBLIC_API);
      const knownHelpers = new Set<string>(INTERNAL_HELPERS);
      const novel: string[] = [];
      for (const name of seen) {
        if (!known.has(name) && !knownHelpers.has(name)) novel.push(name);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in docDelta.ts not yet tracked: " +
            novel.join(", ") +
            " — add to PUBLIC_API (if mutating) or INTERNAL_HELPERS (if internal).",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[delta-audit] docDelta.ts — exports: " +
          seen.length +
          " (" +
          seen.join(", ") +
          "), internal helpers: " +
          knownHelpers.size,
      );
    });
  });
});
