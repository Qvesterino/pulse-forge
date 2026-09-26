// Source-grep regression for src/audio-engine/transients.ts.
//
// transients.ts hosts the onset-detection pipeline that the Slice /
// Beat-Slicer / Chop-to-Pads features depend on. None of these
// helpers may touch host state, log to console, or schedule async
// work inside their bodies; they receive a Float32Array and return
// either an index array or a snapped grid slice. A side-effect would
// re-enter the audio thread from a "pure" util path and either drift
// the onset list or leak between online / offline renders.
//
// Guards:
//   1. PUBLIC INTERFACE - TransientOptions stays `export interface`.
//   2. PUBLIC FUNCTIONS - 6 utilities (detectTransients, gridSlicePoints,
//      snapToGrid, pointsToSlices, zeroCrossSnap, slicesFromOnsets)
//      stay `export function`.
//   3. PURE HELPERS - no console / timer / storage / DOM tokens in
//      their bodies. Date.foo() / Math.foo() calls are stripped
//      before the side-effect scan.
//   4. PUBLIC FUNCTION RETURNS - selected functions keep their return
//      type (detectTransients -> number[], gridSlicePoints ->
//      number[], snapToGrid -> number[]).
//   5. AUDIT - any novel export class / function / interface / const
//      outside the known sets fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/audio-engine/transients.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExport(lines: string[], kind: "class" | "interface" | "function" | "const", name: string): number | null {
  const prefix = "export " + kind + " " + name;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith(prefix)) return i;
  }
  return null;
}

function readBody(lines: string[], startIdx: number): string[] {
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

function readSignature(lines: string[], startIdx: number, maxLines = 12): string {
  let sig = "";
  let openParens = 0;
  let i = startIdx;
  while (i < lines.length && i - startIdx < maxLines) {
    sig += lines[i] + "\n";
    for (const c of lines[i]) {
      if (c === "(") openParens++;
      else if (c === ")") openParens--;
    }
    if (openParens === 0 && /\)(\s*:|\s*\{)/.test(lines[i])) return sig;
    i++;
  }
  return sig;
}

function signatureReturnsArrayOf(sig: string, elementType: string): boolean {
  // Match `: number[]` or `: <Type>[]`. Compound generic <Type>[] also matches.
  const re = new RegExp(":\\s*(?:[A-Za-z_<>,\\s\\[\\]]*\\b)?" + elementType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
  return re.test(sig);
}

const PUBLIC_INTERFACES = ["TransientOptions"];
const PUBLIC_FUNCTIONS = [
  "detectTransients",
  "gridSlicePoints",
  "snapToGrid",
  "pointsToSlices",
  "zeroCrossSnap",
  "slicesFromOnsets",
];
const RETURN_TYPE_HELPERS = [
  { name: "detectTransients", returns: "number" },
  { name: "gridSlicePoints", returns: "number" },
  { name: "snapToGrid", returns: "number" },
];

const SIDE_EFFECT_TOKENS = [
  "console",
  "setTimeout",
  "setInterval",
  "queueMicrotask",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document",
  "window",
  "self",
  "globalThis",
];

describe("audio-engine/transients.ts — pure-utility baseline (source-grep)", () => {
  it("reads transients.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("public interface — TransientOptions", () => {
    it("is `export interface`", () => {
      const idx = findExport(lines, "interface", "TransientOptions");
      expect(idx, "TransientOptions must be `export interface`").not.toBeNull();
      const classIdx = findExport(lines, "class", "TransientOptions");
      expect(classIdx, "TransientOptions must not drift to `export class`").toBeNull();
    });
  });

  describe("public functions — must stay `export function`", () => {
    for (const name of PUBLIC_FUNCTIONS) {
      const title = name + " is an exported function";
      it(title, () => {
        const idx = findExport(lines, "function", name);
        if (idx === null) {
          throw new Error("Function " + name + " no longer exported from transients.ts. Restore it or update PUBLIC_FUNCTIONS — the Slice / Beat-Slicer / Chop-to-Pads features reach this symbol by name.");
        }
      });
    }
  });

  describe("pure utility bodies — no host side-effects", () => {
    for (const name of PUBLIC_FUNCTIONS) {
      const title = name + " body has no console / timer / storage / DOM tokens";
      it(title, () => {
        const idx = findExport(lines, "function", name);
        if (idx === null) throw new Error("function " + name + " missing");
        const body = readBody(lines, idx);
        const debugReport: string[] = [];
        for (const ln of body) {
          // Skip comment-only lines (// line comments and JSDoc `*` lines).
          const trimmed = ln.trimStart();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          const stripped = ln.replace(/\b(?:Date|Math)\.\w+\s*\([^)]*\)/g, "PURE_CALL");
          for (const token of SIDE_EFFECT_TOKENS) {
            const re = new RegExp("\\b" + token + "\\b");
            if (re.test(stripped)) {
              debugReport.push("token " + token + " in " + JSON.stringify(stripped));
            }
          }
        }
        if (debugReport.length > 0) {
          throw new Error(
            "Pure utility '" +
              name +
              "' body has side-effect tokens: " +
              JSON.stringify(debugReport) +
              ". transients.ts is the live/offline seam - a side-effect inside an onset helper silently re-enters the audio thread environment.",
          );
        }
      });
    }
  });

  describe("return-shape coverage — selected public functions", () => {
    for (const entry of RETURN_TYPE_HELPERS) {
      const title = entry.name + " declares a number[]-style return";
      it(title, () => {
        const idx = findExport(lines, "function", entry.name);
        if (idx === null) throw new Error("function " + entry.name + " missing");
        const sig = readSignature(lines, idx);
        expect(
          signatureReturnsArrayOf(sig, entry.returns) || /:.*\[\]/.test(sig),
          entry.name + " must declare an array-of-" + entry.returns + " return. Got:\n" + sig,
        ).toBe(true);
      });
    }
  });

  describe("audit — every export is accounted for", () => {
    it("no orphan const / function / class / interface / type outside the known sets", () => {
      const re = /^export\s+(const|function|class|interface|type)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const tracked = new Set<string>([...PUBLIC_INTERFACES, ...PUBLIC_FUNCTIONS]);
      const novel: string[] = [];
      for (const item of seen) {
        if (!tracked.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in transients.ts not yet tracked: " +
            novel.join(", ") +
            " — add to PUBLIC_INTERFACES or PUBLIC_FUNCTIONS before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[transients-audit] transients.ts — exports: " +
          seen.length +
          " (" +
          seen.map((s) => s.name).join(", ") +
          ")",
      );
    });
  });
});
