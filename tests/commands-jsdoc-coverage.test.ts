// JSDoc coverage regression for the command engine in src/commands/.
// Two guards: PIN existing JSDoc, INVENTORY follow-up baseline.
// Risk rationale: source edits are deferred until the parallel work on
// commands.ts stabilizes; whitelist keeps a deterministic regression now.

import { describe, it, expect, beforeAll } from "vitest";
import { readCommandLines, readCommandLineOwners } from "./helpers/commandSources";

function findExportLine(lines: string[], name: string): number | null {
  const re = new RegExp("^export\\s+(?:async\\s+)?function\\s+" + name + "\\b");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

/** Index of the line opening the JSDoc block above `exportLineIdx`, or -1 when there is none. */
function jsdocBlockStart(lines: string[], exportLineIdx: number, window = 8): number {
  const start = Math.max(0, exportLineIdx - window);
  for (let i = exportLineIdx - 1; i >= start; i--) {
    if (lines[i].trim() !== "*/") continue;
    for (let j = i - 1; j >= start; j--) {
      const s = lines[j].trim();
      if (s.startsWith("/**")) return j;
      if (s.startsWith("*") || s === "") continue;
      return -1;
    }
    // A `*/` with no `/**` inside the window is not a block this guard can claim.
    return -1;
  }
  return -1;
}

/**
 * Whether the export has its OWN doc block, as opposed to a module header that merely
 * happens to sit above it.
 *
 * Every domain module opens with a `/** ... *\/` header explaining the module, and the first
 * export often follows it immediately. The line-based predicate cannot separate the two cases,
 * so a module header used to be credited to the first function in the file: after setProjectName
 * moved into project.ts the follow-up inventory silently dropped 9 -> 8, i.e. the guard was
 * reporting one function as documented when nothing had been documented at all.
 *
 * A block is a module header when it is the file's first doc block AND it sits above the file's
 * first exported function. Anything else is a function's own doc.
 */
function hasFunctionJSDoc(lines: string[], owners: string[], exportLineIdx: number): boolean {
  const blockStart = jsdocBlockStart(lines, exportLineIdx);
  if (blockStart < 0) return false;
  const file = owners[exportLineIdx];
  const firstDoc = lines.findIndex((l, i) => owners[i] === file && l.trim().startsWith("/**"));
  const firstFn = lines.findIndex((l, i) => owners[i] === file && /^export\s+(?:async\s+)?function\b/.test(l));
  return !(blockStart === firstDoc && exportLineIdx === firstFn);
}

let lines: string[] = [];
let owners: string[] = [];

beforeAll(() => {
  // Barrel + every domain module it re-exports. This MUST NOT be commands.ts alone: the
  // follow-up inventory below skips names it cannot find, so a narrower search scope does not
  // fail the suite — it quietly stops checking the commands that moved out, which is the same
  // regression the guard exists to catch, one level up.
  lines = readCommandLines();
  owners = readCommandLineOwners();
});

const ANCHORS_WITH_JSDOC: string[] = [
  "sliceToPads",
  "applyKitToDrumTrack",
  "installPackSketch",
  "stealGrooveIntoPattern",
  "setStepLocks",
];

const FOLLOWUP_TARGETS: string[] = [
  "snapshot",
  "captureKitFromTrack",
  "setBpm",
  "setProjectName",
  "addNote",
  "deleteNote",
  "duplicateNotes",
  "quantizeNotes",
  "setSceneIntensityCurve",
];

const ANCHORS_OUTSIDE_FILE: string[] = [
  "setActivePatternId",
  "setTrackGain",
  "setTrackMute",
  "setTrackSolo",
  "setMasterGain",
  "setLoopBounds",
];

describe("commands.ts JSDoc baseline", () => {
  it("reads commands.ts", () => {
    expect(lines.length).toBeGreaterThan(100);
  });

  describe("pinned JSDoc — must keep", () => {
    for (const name of ANCHORS_WITH_JSDOC) {
      const title = name + " keeps its JSDoc block above the export line";
      it(title, () => {
        const idx = findExportLine(lines, name);
        if (idx === null) {
          throw new Error("Anchor " + name + " no longer exported from commands.ts — restore or update list");
        }
        expect(
          hasFunctionJSDoc(lines, owners, idx),
          name + " must keep its JSDoc block above the export line (line " + (idx + 1) + ")",
        ).toBe(true);
      });
    }
  });

  describe("follow-up baseline — pinned", () => {
    it("inventories currently-missing JSDoc across FOLLOWUP_TARGETS", () => {
      const missing: string[] = [];
      const present: string[] = [];
      for (const name of FOLLOWUP_TARGETS) {
        const idx = findExportLine(lines, name);
        if (idx === null) {
          // A target that cannot be resolved anywhere is a hole in the guard, not a pass.
          throw new Error("Follow-up target " + name + " not found in the command engine - update the list");
        }
        if (hasFunctionJSDoc(lines, owners, idx)) present.push(name);
        else missing.push(name);
      }
      // Every listed target must be accounted for: a shrinking denominator here means the
      // inventory is no longer measuring what it claims to measure.
      expect(present.length + missing.length).toBe(FOLLOWUP_TARGETS.length);
      expect(missing.length).toBeGreaterThan(0);

      const TRACKED_MISSING = new Set([
        "snapshot",
        "captureKitFromTrack",
        "setBpm",
        "setProjectName",
        "addNote",
        "deleteNote",
        "duplicateNotes",
        "quantizeNotes",
        "setSceneIntensityCurve",
      ]);
      for (const name of missing) {
        expect(
          TRACKED_MISSING.has(name),
          "New missing anchor " + name + " — either add to TRACKED_MISSING or write its JSDoc",
        ).toBe(true);
      }
      // The converse direction. Without it a FALSE POSITIVE is invisible: a name listed as
      // undocumented quietly stops being counted as missing, the denominator only shows up in a
      // console.info nobody reads, and the guard starts passing on a weaker measurement than the
      // one it was written against. Writing the JSDoc is a real fix — then drop the name here.
      for (const name of TRACKED_MISSING) {
        expect(missing, name + " is listed as undocumented but the predicate found a doc block above it").toContain(
          name,
        );
      }

      // Diagnostic
      // eslint-disable-next-line no-console
      console.info(
        "[jsdoc-baseline] commands.ts — pinned: " +
          ANCHORS_WITH_JSDOC.length +
          "/" +
          ANCHORS_WITH_JSDOC.length +
          ", follow-up missing: " +
          missing.length +
          "/" +
          FOLLOWUP_TARGETS.length,
      );
    });
  });

  describe("outside-file anchors", () => {
    it("ANCHORS_OUTSIDE_FILE entries either resolve or stay null", () => {
      for (const name of ANCHORS_OUTSIDE_FILE) {
        const idx = findExportLine(lines, name);
        expect(idx === null || idx >= 0).toBe(true);
        if (idx !== null && !FOLLOWUP_TARGETS.includes(name) && !ANCHORS_WITH_JSDOC.includes(name)) {
          throw new Error(
            "Anchor " + name + " resolves in commands.ts but is not in any tracked set (pinned/follow-up/outside)",
          );
        }
      }
    });
  });
});
