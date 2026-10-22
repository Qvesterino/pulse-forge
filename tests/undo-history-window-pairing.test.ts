import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE HISTORY WINDOW MUST PAIR EACH ENTRY WITH ITS OWN SNAPSHOTS.
 *
 * THE DEFECT (P2 — the history panel reports the wrong diff for every row).
 *
 *   `ProjectStore.historyDocs` is a contiguous run of document states ENDING
 *   at the current document: each adjacent pair is the (before, after) of one
 *   command. `diffForIndex` pairs them by
 *   `offset = undoStack.length + 1 - historyDocs.length` and reports
 *   `computeDocDelta(historyDocs[i], historyDocs[i+1])` for command `i`.
 *
 *   `undo()` popped a command but then TRUNCATED the window with
 *   `Math.min(historyDocs.length, undoStack.length + 1)` and overwrote the
 *   tail in place. That truncation is a no-op once the window sits at its
 *   64-snapshot cap (`HISTORY_LIMIT`) — the undo stack outgrew it — so:
 *
 *     - the window stayed one snapshot too early,
 *     - the post-undo document was written over the tail while the SAME
 *       document was still present in the slot before it, and
 *     - every visible row's diff became the NEXT command's diff.
 *
 *   A row's LABEL comes from the undo stack and its DIFF comes from the
 *   snapshot window, so the mis-pairing shows as a label that no longer
 *   matches its own diff — "Delete clip" reporting a tempo change because the
 *   row below it changed the tempo.
 *
 *   The file's own contract says an index outside the tracked window must
 *   "report no diff instead of pairing wrong snapshots" — the mis-pairing is
 *   the defect, not the missing diff.
 *
 * WHAT THIS TEST PINS.
 *
 *   After an undo at ANY depth — including past the 64-snapshot window — every
 *   visible history row keeps its own diff, and the rows visible before AND
 *   after the undo are the same commands with the same diffs.
 */

const HISTORY_LIMIT = 64;

/** A command that changes the tempo — one scalar field. */
function setBpm(doc: ProjectDocument, bpm: number) {
  const before = doc;
  return {
    type: "setBpm" as const,
    label: `Set BPM to ${bpm}`,
    execute: (): ProjectDocument => ({ ...doc, bpm }),
    undo: (): ProjectDocument => before,
  };
}

/** A command that adds a clip — one inserted entity. */
function placeClip(doc: ProjectDocument) {
  const before = doc;
  const next = addAudioClip(doc, doc.tracks[0].id, "factory.kick", 0, 4).execute(doc);
  return {
    type: "placeClip" as const,
    label: "Place clip",
    execute: (): ProjectDocument => next,
    undo: (): ProjectDocument => before,
  };
}

/** A command that removes a clip — one deleted entity. */
function deleteClip(doc: ProjectDocument) {
  const before = doc;
  const clipId = doc.arrangement.audioClips?.[0]?.id;
  if (!clipId) throw new Error("no clip");
  const next = {
    ...doc,
    arrangement: { ...doc.arrangement, audioClips: (doc.arrangement.audioClips ?? []).filter((c) => c.id !== clipId) },
  };
  return {
    type: "deleteClip" as const,
    label: "Delete clip",
    execute: (): ProjectDocument => next,
    undo: (): ProjectDocument => before,
  };
}

/**
 * A document that already carries one audio clip.
 *
 * The clip matters for the DIFF SHAPES: with `arrangement.audioClips` absent,
 * the delta reports the whole array as one "changed" op instead of an inserted
 * entity, and the three shapes this test relies on would collapse into two.
 */
function docWithOneClip(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 4).execute(base);
}

/**
 * Fill the undo stack past the 64-snapshot window with three diff shapes, so
 * a one-step shift in the pairing is visible in the output.
 */
function fillPastTheWindow(store: ProjectStore): void {
  for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
    if (i % 3 === 0) store.execute(setBpm(store.doc, 120 + (i % 40)));
    else if (i % 3 === 1) store.execute(placeClip(store.doc));
    else store.execute(deleteClip(store.doc));
  }
}

const rows = (store: ProjectStore) => store.history.map((entry) => ({ label: entry.label, diff: entry.diff }));

describe("the history window pairs every entry with its own snapshots", () => {
  it("SHORT HISTORY: each visible row's diff belongs to its own label", () => {
    const store = new ProjectStore(docWithOneClip());
    store.execute(placeClip(store.doc));
    store.execute(setBpm(store.doc, 130));
    store.execute(deleteClip(store.doc));

    const visible = rows(store);
    expect(visible.length).toBe(3);
    expect(visible[0]!.diff!.added, "Place clip must report an insertion").toBe(1);
    expect(visible[1]!.diff!.changed, "Set BPM must report a change").toBe(1);
    expect(visible[2]!.diff!.removed, "Delete clip must report a removal").toBe(1);
  });

  it("PAST THE WINDOW CAP: an undo does not shift every visible diff", () => {
    const store = new ProjectStore(docWithOneClip());
    fillPastTheWindow(store);
    const before = rows(store);

    store.undo();

    const after = rows(store);
    // The visible window slides by one: the rows visible before AND after the
    // undo are the same commands and must keep the same diffs.
    //
    // THE DEFECT (pre-fix): every row showed the NEXT command's diff, so this
    // comparison fails — the labels line up but the diffs do not.
    expect(after.slice(1)).toEqual(before.slice(0, before.length - 1));
  });

  it("PAST THE WINDOW CAP: every row's diff matches its own label", () => {
    const store = new ProjectStore(docWithOneClip());
    fillPastTheWindow(store);
    store.undo();
    for (const row of rows(store)) {
      const diff = row.diff;
      if (!diff) continue;
      if (row.label === "Place clip") expect(diff.added, `"${row.label}" must report an insertion`).toBeGreaterThan(0);
      if (row.label === "Delete clip") expect(diff.removed, `"${row.label}" must report a removal`).toBeGreaterThan(0);
      if (row.label.startsWith("Set BPM"))
        expect(diff.changed, `"${row.label}" must report a change`).toBeGreaterThan(0);
    }
  });

  it("the window keeps sliding: a second undo still pairs correctly", () => {
    const store = new ProjectStore(docWithOneClip());
    fillPastTheWindow(store);
    const before = rows(store);

    store.undo();
    const afterOne = rows(store);
    store.undo();
    const afterTwo = rows(store);

    expect(afterOne.slice(1)).toEqual(before.slice(0, before.length - 1));
    expect(afterTwo.slice(1)).toEqual(afterOne.slice(0, afterOne.length - 1));
  });

  it("the undo still restores the document (the window fix does not break it)", () => {
    const store = new ProjectStore(docWithOneClip());
    fillPastTheWindow(store);
    const before = store.doc;
    store.undo();
    expect(store.doc).not.toBe(before);
    expect(store.canUndo).toBe(true);
  });
});
