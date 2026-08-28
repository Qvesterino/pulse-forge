/**
 * Test document fixtures — the canonical way to build ProjectDocuments in
 * tests. Born from three recurring pains in the test suite:
 *
 *   1. The house template ships an arrangement clip at bar 0, so every
 *      `addArrangementClip(doc, scene, 0, …)` in tests collided with it.
 *   2. `createProjectFromTemplate("house")` generates random ids per call,
 *      so commands created from one instance silently no-op'd when executed
 *      against another instance — and diffs were unreadable.
 *   3. Every test re-derived the same accessors (drumOf, instOf, …) with
 *      slightly different null-handling.
 *
 * Rules of the house:
 *   - `testDoc()` is house-based (musically rich) but with an EMPTY
 *     arrangement — place clips anywhere you like.
 *   - Build commands from the SAME doc instance you execute them on. The
 *     `Harness` helper makes that the path of least resistance.
 *   - For docs whose ids must align across instances (snapshot diffs,
 *     cross-instance round-trips), build them inside `deterministicIds()`.
 */
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { resetDeterministicIds, useDeterministicIds } from "../../src/shared/ids";
import type {
  DrumTrack,
  InstrumentTrack,
  Pattern,
  ProjectDocument,
  Scene,
} from "../../src/project-model/types";
import type { Command } from "../../src/commands/types";

export { useDeterministicIds, resetDeterministicIds };

/** House-based test document with an EMPTY arrangement (no overlap traps). */
export function testDoc(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  return { ...doc, arrangement: { clips: [] } };
}

/** testDoc built with deterministic ids — same construction order, same ids. */
export function deterministicTestDoc(): ProjectDocument {
  const restore = useDeterministicIds();
  resetDeterministicIds();
  try {
    return testDoc();
  } finally {
    restore();
  }
}

// ─── Accessors (throw with context instead of leaking undefined) ───────────

export function drumTrackOf(doc: ProjectDocument): DrumTrack {
  const track = doc.tracks.find((t) => t.kind === "drum");
  if (!track) throw new Error("fixture: doc has no drum track");
  return track;
}

export function instTrackOf(doc: ProjectDocument): InstrumentTrack {
  const track = doc.tracks.find((t) => t.kind === "instrument");
  if (!track) throw new Error("fixture: doc has no instrument track");
  return track;
}

export function trackAt(doc: ProjectDocument, index: number): ProjectDocument["tracks"][number] {
  const track = doc.tracks[index];
  if (!track) throw new Error(`fixture: no track at index ${index}`);
  return track;
}

export function activePatternOf(doc: ProjectDocument): Pattern {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("fixture: activePatternId does not resolve");
  return pattern;
}

export function patternAt(doc: ProjectDocument, index: number): Pattern {
  const pattern = doc.patterns[index];
  if (!pattern) throw new Error(`fixture: no pattern at index ${index}`);
  return pattern;
}

export function sceneAt(doc: ProjectDocument, index: number): Scene {
  const scene = doc.scenes[index];
  if (!scene) throw new Error(`fixture: no scene at index ${index}`);
  return scene;
}

export function padOf(doc: ProjectDocument, index: number): DrumTrack["pads"][number] {
  return drumTrackOf(doc).pads[index];
}

// ─── Command harness — mirrors ProjectStore semantics ──────────────────────

/**
 * Thin wrapper that keeps the "build from the same doc you execute on"
 * invariant mechanical: `h.run(cmd)` always dispatches against the harness's
 * current document, `h.undo()` applies the last command's undo, `h.reset(doc)`
 * swaps the base. Eliminates the whole class of cross-instance test bugs.
 */
export function commandHarness(start: ProjectDocument = testDoc()) {
  let doc = start;
  const undoStack: Command[] = [];
  return {
    get doc(): ProjectDocument {
      return doc;
    },
    run(command: Command): ProjectDocument {
      doc = command.execute(doc);
      undoStack.push(command);
      return doc;
    },
    undo(): ProjectDocument {
      const command = undoStack.pop();
      if (!command) return doc;
      doc = command.undo(doc);
      return doc;
    },
    reset(next: ProjectDocument = testDoc()): ProjectDocument {
      doc = next;
      undoStack.length = 0;
      return doc;
    },
  };
}
