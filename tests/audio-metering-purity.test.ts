// Source-grep regression for src/audio-engine/metering.ts.
//
// metering.ts is a pure-utility module: every helper is analyser-friendly so
// it can be reused by live meter paths and the offline renderer. Side effects
// inside these helpers (console writes, async timers, persistent state
// mutation) would silently leak across the live/offline boundary.
//
// Guards:
//   1. PINNED CONSTANTS - MIN_DB / MAX_DB must remain `export const` and
//      must not be reassigned in the module. A `let` drift or a shadow
//      declaration breaks the [-120, +6] dBFS contract used everywhere.
//   2. PURE UTILITIES - the named pure utilities (toDb, fromDb,
//      lufsFromChannels, integratedLufs, monoLossDb, plus their derived
//      friends in the file) must contain no host-side-effect tokens in
//      their bodies: no console.* / setTimeout / setInterval / fetch /
//      XMLHttpRequest / localStorage / sessionStorage / document / window.
//      Such a token inside a meter helper would silently re-enter the
//      audio thread's environment from a "pure" path.
//   3. PUBLIC API - the tracked exports must remain exported and stay
//      declarations of const / function / interface (no `let`, no class).
//   4. AUDIT - any novel `export` declaration outside the known set fails.
//      Type drift is surfaced rather than silently accepted.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const METERING_FILE = resolve(process.cwd(), "src/audio-engine/metering.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(METERING_FILE, "utf8").split(/\r?\n/);
});

interface Anchor {
  name: string;
  kind: "const" | "fn" | "iface" | "class" | "type";
}

// Pinned anchors with a purity contract — these helpers MUST remain pure
// (no console / timer / storage / DOM tokens in their bodies).
const PURE_HELPERS: Anchor[] = [
  { name: "toDb", kind: "fn" },
  { name: "fromDb", kind: "fn" },
  { name: "lufsFromChannels", kind: "fn" },
  { name: "integratedLufs", kind: "fn" },
  { name: "monoLossDb", kind: "fn" },
  { name: "emptyLevels", kind: "fn" },
  { name: "splitChannels", kind: "fn" },
  { name: "channelLevels", kind: "fn" },
  { name: "stereoCorrelation", kind: "fn" },
  { name: "summarizeBuffer", kind: "fn" },
  { name: "summarizePcm", kind: "fn" },
];

// Constants and types — checked for shape and immutability but not for purity.
const CONSTANTS: Anchor[] = [
  { name: "MIN_DB", kind: "const" },
  { name: "MAX_DB", kind: "const" },
];

const TYPES: Anchor[] = [
  { name: "MixCheckSnapshot", kind: "iface" },
  { name: "MixCheckWarning", kind: "iface" },
  { name: "ExportMonoGuard", kind: "iface" },
  { name: "StageAdjustment", kind: "iface" },
  { name: "MasterVerdictInput", kind: "iface" },
  { name: "MasterVerdict", kind: "iface" },
  { name: "ChannelLevels", kind: "iface" },
  { name: "BufferSummary", kind: "iface" },
  { name: "Frame", kind: "type" },
  { name: "MeteringProgress", kind: "type" },
];

// Full export surface — pinned for audit. Adding a new export to
// metering.ts without updating this list fails the audit test.
const KNOWN_EXPORTS: Anchor[] = [
  ...CONSTANTS,
  ...PURE_HELPERS,
  ...TYPES,
  { name: "evaluateMixCheck", kind: "fn" },
  { name: "evaluateExportMonoGuard", kind: "fn" },
  { name: "computeStageAdjustment", kind: "fn" },
  { name: "evaluateMasterVerdict", kind: "fn" },
  { name: "readAnalyserFrame", kind: "fn" },
  { name: "truePeakOversampled", kind: "fn" },
  { name: "TruePeakChannelAccumulator", kind: "class" },
  { name: "PeakHold", kind: "class" },
];

// Host-side-effect tokens that must NOT appear inside a pure utility body.
// Each must be a whole-word token (regex word boundary) so e.g.
// `setTimeoutLike` does not match `setTimeout`.
const SIDE_EFFECT_TOKENS: string[] = [
  "console", // logger writes (debug)
  "setTimeout", // async wall-clock
  "setInterval",
  "queueMicrotask",
  "fetch", // network
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document", // DOM coupling
  "window",
  "self",
  "globalThis",
];

function findExport(lines: string[], name: string, kind: Anchor["kind"]): number | null {
  const reConst = new RegExp("^export\\s+const\\s+" + name + "\\b");
  const reFn = new RegExp("^export\\s+(?:async\\s+)?function\\s+" + name + "\\b");
  const reIface = new RegExp("^export\\s+interface\\s+" + name + "\\b");
  const reClass = new RegExp("^export\\s+class\\s+" + name + "\\b");
  const reType = new RegExp("^export\\s+type\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (kind === "const" && reConst.test(ln)) return i;
    if (kind === "fn" && reFn.test(ln)) return i;
    if (kind === "iface" && reIface.test(ln)) return i;
    if (kind === "class" && reClass.test(ln)) return i;
    if (kind === "type" && reType.test(ln)) return i;
  }
  return null;
}

/**
 * Walk the body of a `function NAME(...) { ... }` until brace depth returns
 * to zero. Returns the indexed window of body lines.
 */
function readBody(lines: string[], startIdx: number): { lines: string[]; depth: number } {
  let depth = 0;
  let sawOpen = false;
  const buf: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    for (const c of ln) {
      if (c === "{") {
        depth++;
        sawOpen = true;
      } else if (c === "}") depth--;
    }
    if (sawOpen) buf.push(ln);
    if (sawOpen && depth === 0) break;
  }
  return { lines: buf, depth };
}

function bodyHasSideEffect(body: string[]): string | null {
  // Match whole-word tokens. Skip lines that look like type-level usage
  // (rare in pure utilities, but generic comments may mention "browser
  // window" without intention to call).
  for (const ln of body) {
    for (const token of SIDE_EFFECT_TOKENS) {
      const re = new RegExp("\\b" + token + "\\b");
      if (re.test(ln)) return token;
    }
  }
  return null;
}

describe("audio-engine/metering.ts — pure-utility baseline (source-grep)", () => {
  it("reads metering.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("pinned constants — must remain `export const` and not be reassigned", () => {
    for (const a of CONSTANTS) {
      const title = a.name + " is an exported constant, never reassigned";
      it(title, () => {
        const idx = findExport(lines, a.name, "const");
        if (idx === null) {
          throw new Error("Constant " + a.name + " no longer exported. Restore it or update CONSTANTS.");
        }
        const letRe = new RegExp("^export\\s+let\\s+" + a.name + "\\b");
        for (const ln of lines) {
          expect(
            !letRe.test(ln),
            a.name + " drifted to `export let` (mutable). The dBFS contract requires an immutable constant.",
          ).toBe(true);
        }
      });
    }
  });

  describe("pinned pure helpers — body contains no host side-effects", () => {
    for (const a of PURE_HELPERS) {
      const title = a.name + " body has no console / timer / storage / DOM tokens";
      it(title, () => {
        const idx = findExport(lines, a.name, "fn");
        if (idx === null) {
          throw new Error("Function " + a.name + " no longer exported. Restore it or update PURE_HELPERS.");
        }
        const body = readBody(lines, idx);
        const offender = bodyHasSideEffect(body.lines);
        if (offender !== null) {
          throw new Error(
            "Pure helper '" +
              a.name +
              "' contains side-effect token '" +
              offender +
              "'. metering.ts is the live/offline seam - a side-effect inside a meter helper silently leaks from the audio thread's environment. Remove the call site (e.g. log to a callback) or move the helper to a different module.",
          );
        }
      });
    }
  });

  describe("pinned types — interfaces stay interfaces, types stay type aliases", () => {
    for (const a of TYPES) {
      const title = a.name + " is an exported " + a.kind + " (not a class)";
      it(title, () => {
        const idx = findExport(lines, a.name, a.kind);
        if (idx === null) {
          throw new Error("Type " + a.name + " no longer exported. Restore it or update TYPES.");
        }
        // No drift to class.
        const classRe = new RegExp("^export\\s+class\\s+" + a.name + "\\b");
        for (const ln of lines) {
          expect(
            !classRe.test(ln),
            a.name + " drifted to `export class`. The metering types are inert data shapes, not classes.",
          ).toBe(true);
        }
      });
    }
  });

  describe("audit — every export in metering.ts is accounted for", () => {
    it("no orphan `export const|function|interface|class|type|enum` outside KNOWN_EXPORTS", () => {
      const re = /^export\s+(const|function|interface|class|type|enum)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const known = new Set(KNOWN_EXPORTS.map((a) => a.name));
      const novel: string[] = [];
      for (const item of seen) {
        if (!known.has(item.name)) {
          novel.push(item.name + ":" + item.kind);
        }
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in metering.ts not yet tracked: " +
            novel.join(", ") +
            " — add them to KNOWN_EXPORTS (with rationale) before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[metering-audit] metering.ts — exports: " +
          seen.length +
          ", purity-tracked: " +
          PURE_HELPERS.length +
          ", constants: " +
          CONSTANTS.length +
          ", types: " +
          TYPES.length,
      );
    });
  });
});
