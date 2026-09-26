// Source-grep regression for src/audio-engine/latencyProbe.ts.
//
// latencyProbe.ts hosts the audio-context roundtrip calibration that
// compensates for hardware/OS latency before transport scheduling kicks
// in. The probe synchronously schedules a click pattern, captures the
// detections, and folds them into a sample-rate-aware latency offset.
//
// A regression in this contract would either:
//   - break the calibration error class identity (callers catch by
//     name and would silently fall through to a generic Error)
//   - move internal helpers behind a public export (the calibration
//     pulse / abort helpers are timing-critical and outside file
//     callers would compose them with stale assumptions)
//   - mutate the PULSE_* constants mid-run (regression of the click
//     pattern would silently invalidate every measurement)
//
// Guards:
//   1. CONSTANTS - the 5 PULSE_* module-level constants must stay
//      `const` (not `let`) so the click pattern is immutable once
//      measured.
//   2. ERROR CLASS - AudioLatencyCalibrationError must stay `export
//      class` with name "AudioLatencyCalibrationError".
//   3. INTERNAL NOT-EXPORTED - helpers like makeCalibrationPulse,
//      throwIfAborted, pairDetections, wait stay non-exported.
//   4. WEAK-SET STATE - the probeModuleLoaded WeakSet must remain a
//      module-level state, never exported (exporting it would let
//      callers mutate the loaded-ctx set outside addModule's
//      once-only guard).
//   5. AUDIT - any novel `export function|class` outside the public
//      API fails.
//
// Risk rationale: 0 source changes. Source-grep regression only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "src/audio-engine/latencyProbe.ts");

let lines: string[] = [];

beforeAll(() => {
  lines = readFileSync(FILE, "utf8").split(/\r?\n/);
});

function findExportNamed(lines: string[], kind: "class" | "function" | "const" | "let", name: string): number | null {
  const re = new RegExp("^export\\s+" + kind + "\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function findAnyNamed(lines: string[], kind: "class" | "function" | "const" | "let" | "interface" | "type", name: string): number | null {
  const re = new RegExp("^(?:export\\s+)?" + kind + "\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

const PULSE_CONSTANTS: string[] = [
  "PULSE_COUNT",
  "PULSE_SPACING_SEC",
  "PULSE_LEAD_SEC",
  "PULSE_TAIL_SEC",
];

const PUBLIC_API: string[] = [
  "AudioLatencyCalibrationError", // class
];

const INTERNAL_HELPERS: string[] = [
  "makeCalibrationPulse",
  "throwIfAborted",
  "wait",
  "pairDetections",
];

const MODULE_STATE: string[] = [
  "probeModuleLoaded", // WeakSet, must stay module-private
];

describe("audio-engine/latencyProbe.ts — calibration baseline (source-grep)", () => {
  it("reads latencyProbe.ts", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  describe("pinned PULSE_* constants — must stay immutable", () => {
    for (const name of PULSE_CONSTANTS) {
      const title = name + " is `const` (never `let`)";
      it(title, () => {
        const idx = findAnyNamed(lines, "const", name);
        expect(idx, name + " must exist as a `const` in latencyProbe.ts").not.toBeNull();
        const letRe = new RegExp("^(?:export\\s+)?let\\s+" + name + "\\b");
        for (const ln of lines) {
          expect(
            !letRe.test(ln),
            name + " drifted to `let`. The click-pattern constants must be immutable once measured — a mid-run reassignment would silently invalidate every calibration reading.",
          ).toBe(true);
        }
        // Must not be exported (they're internal to the calibration).
        const expIdx = findExportNamed(lines, "const", name);
        expect(
          expIdx,
          name + " is now `export const`. Pulse parameters are calibration internals — leaking them lets callers compose click patterns with stale module assumptions. Demote back or wrap in a config parameter factory.",
        ).toBeNull();
      });
    }
  });

  describe("public API — AudioLatencyCalibrationError identity", () => {
    it("is exported as a class", () => {
      const idx = findExportNamed(lines, "class", "AudioLatencyCalibrationError");
      expect(idx, "AudioLatencyCalibrationError must be exported as a class").not.toBeNull();
    });

    it("class body sets `this.name = \"AudioLatencyCalibrationError\"` (used in checks)", () => {
      const idx = findExportNamed(lines, "class", "AudioLatencyCalibrationError");
      if (idx === null) throw new Error("class not exported");
      // Walk forward 30 lines looking for the name assignment.
      let found = false;
      for (let i = idx; i < idx + 30 && i < lines.length; i++) {
        if (/this\.name\s*=\s*"AudioLatencyCalibrationError"/.test(lines[i])) {
          found = true;
          break;
        }
      }
      expect(
        found,
        "AudioLatencyCalibrationError must set this.name so consumers can catch by name. Identical-to-generic-Error catches would leak the calibration flow into generic error paths.",
      ).toBe(true);
    });
  });

  describe("internal helpers — must NOT be exported", () => {
    for (const name of INTERNAL_HELPERS) {
      const title = name + " stays a non-exported internal helper";
      it(title, () => {
        const expFn = findExportNamed(lines, "function", name);
        expect(
          expFn,
          name + " is now `export function` from latencyProbe.ts. The probe helpers compose the click/detect/measure pipeline in a specific order; callers outside the file would couple to that order. Demote back or wrap with a calibration-flow factory.",
        ).toBeNull();
        const anyIdx = findAnyNamed(lines, "function", name);
        expect(anyIdx, name + " must still exist in latencyProbe.ts").not.toBeNull();
      });
    }
  });

  describe("module-level state — must stay private", () => {
    it("probeModuleLoaded is module-private (not exported)", () => {
      const expIdx = findExportNamed(lines, "const", "probeModuleLoaded");
      expect(
        expIdx,
        "probeModuleLoaded is now exported. The WeakSet of contexts that have loaded the probe module is a once-only guard — exporting it would let callers mutate the loaded-ctx set outside addModule, silently defeating the addModule once-only invariant.",
      ).toBeNull();
      const anyIdx = findAnyNamed(lines, "const", "probeModuleLoaded");
      expect(anyIdx, "probeModuleLoaded must still exist as a module-level const").not.toBeNull();
    });
  });

  describe("audit — every exported function/class in latencyProbe.ts is accounted for", () => {
    it("no orphan `export function|class` outside PUBLIC_API", () => {
      const re = /^export\s+(function|class)\s+(\w+)/;
      const seen: { name: string; kind: string }[] = [];
      for (const ln of lines) {
        const m = ln.match(re);
        if (m) seen.push({ name: m[2], kind: m[1] });
      }
      const known = new Set<string>(PUBLIC_API);
      const novel: string[] = [];
      for (const item of seen) {
        if (!known.has(item.name)) novel.push(item.name + ":" + item.kind);
      }
      if (novel.length > 0) {
        throw new Error(
          "Novel export(s) in latencyProbe.ts not yet tracked: " +
            novel.join(", ") +
            " — add to PUBLIC_API or INTERNAL_HELPERS before merging.",
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        "[latency-audit] latencyProbe.ts — exports: " + seen.length + " (" + seen.map((s) => s.name).join(", ") + ")",
      );
    });
  });
});
