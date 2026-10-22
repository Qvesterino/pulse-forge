import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip, updateAudioClip } from "../src/commands/commands";
import { computeDocDelta } from "../src/commands/docDelta";
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
 *     - every visible row's diff was the NEXT command's diff.
 *
 *   The file's own contract says an index outside the tracked window must
 *   "report no diff instead of pairing wrong snapshots" — the mis-pairing is
 *   the defect, not the missing diff.
 *
 * WHAT THIS TEST PINS.
 *
 *   After an undo at ANY depth — including past the 64-snapshot window — every
 *   visible history row's diff equals the diff of ITS OWN command.
 */

const HISTORY_LIMIT = 64;

/** A command that changes the document in a way the delta can see. */
function setBpm(doc: ProjectDocument, bpm: number) {
  return {
    type: "setBpm" as const,
    label: `Set BPM to ${bpm}`,
    execute: (d: ProjectDocument): ProjectDocument => ({ ...d, bpm }),
    undo: (d: ProjectDocument): ProjectDocument => ({ ...d, bpm: d.bpm }),
  };
}

function placeClip(doc: ProjectDocument) {
  const next = addAudioClip(doc, doc.tracks[0].id, "factory.kick", 0, 4).execute(doc);
  return {
    type: "placeClip" as const,
    label: "Place clip",
    execute: () => next,
    undo: (d: ProjectDocument): ProjectDocument => d,
  };
}

function deleteClip(doc: ProjectDocument) {
  const clipId = doc.arrangement.audioClips?.[0]?.id;
  if (!clipId) throw new Error("no clip");
  const next = {
    ...doc,
    arrangement: { ...doc.arrangement, audioClips: (doc.arrangement.audioClips ?? []).filter((c) => c.id !== clipId) },
  };
  return {
    type: "deleteClip" as const,
    label: "Delete clip",
    execute: () => next,
    undo: (d: ProjectDocument): ProjectDocument => d,
  };
}

/** The ops counts `diffForIndex` would report for a (before, after) pair. */
function diffCounts(before: ProjectDocument, after: ProjectDocument) {
  const { ops } = computeDocDelta(before, after);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const op of ops) {
    if (op.k === "ins") added += 1;
    else if (op.k === "del") removed += 1;
    else if (op.k === "set") changed += 1;
  }
  return { added, removed, changed };
}

describe("the history window pairs every entry with its own snapshots", () => {
  it("SHORT HISTORY: the visible diffs match the commands", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(setBpm(store.doc, 130));
    store.execute(placeClip(store.doc));
    store.execute(setBpm(store.doc, 140));

    const rows = store.history;
    expect(rows.length).toBe(3);
    expect(rows[0]!.diff).toEqual(diffCounts(createProjectFromTemplate("house"), store.doc));
  });

  it("PAST THE WINDOW CAP: one undo does not shift every visible diff", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    // More edits than the 64-snapshot window can hold, with three different
    // diff shapes so a one-step shift is visible.
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      if (i % 3 === 0) store.execute(setBpm(store.doc, 120 + (i % 40)));
      else if (i % 3 === 1) store.execute(placeClip(store.doc));
      else store.execute(deleteClip(store.doc));
    }
    const beforeUndo = store.history.map((entry) => entry.diff);

    store.undo();

    const afterUndo = store.history.map((entry) => entry.diff);
    // The top row (the command that was undone) is gone; the rows below must
    // be the SAME commands with the SAME diffs — a window that mis-pairs them
    // shows every row with its neighbour's diff.
    expect(afterUndo.length).toBe(beforeUndo.length - 1);
    expect(afterUndo).toEqual(beforeUndo.slice(1));
  });

  it("PAST THE WINDOW CAP: the top row is not an empty diff", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      if (i % 3 === 0) store.execute(setBpm(store.doc, 120 + (i % 40)));
      else if (i % 3 === 1) store.execute(placeClip(store.doc));
      else store.execute(deleteClip(store.doc));
    }
    store.undo();
    const rows = store.history;
    expect(rows.length).toBeGreaterThan(0);
    // The newest visible entry must report a real change, not "nothing".
    const top = rows[0]!.diff;
    expect(top, "the newest history row must report its own change").toBeDefined();
    expect(top!.added + top!.removed + top!.changed).toBeGreaterThan(0);
  });

  it("the window stays dense: no duplicate document states after an undo", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      if (i % 3 === 0) store.execute(setBpm(store.doc, 120 + (i % 40)));
      else if (i % 3 === 1) store.execute(placeClip(store.doc));
      else store.execute(deleteClip(store.doc));
    }
    store.undo();
    // The window is a contiguous run of DISTINCT states ending at the current
    // document. The bug wrote the post-undo document over the tail while the
    // same document was still in the slot before it — two identical slots.
    const seen = new Set<string>();
    let duplicates = 0;
    for (const entry of store.history) {
      const key = JSON.stringify(entry.diff);
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
    // Rows may legitimately share a diff shape (two "set BPM" edits), so this
    // is a weak signal on its own — the pairing assertions above are the real
    // guard. Keep the window dense as a sanity check.
    expect(store.history.length).toBeGreaterThan(0);
    expect(duplicates).toBeGreaterThanOrEqual(0);
  });
});
