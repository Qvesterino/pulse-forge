import { describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { pruneDeadClipIds } from "../../src/ui/useClipSelectionInvariant";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { deleteArrangementClip, addArrangementClip } from "../../src/commands/commands";

/**
 * INVARIANT: every id in the selection names a live object.
 *
 * The selection is UI state and document commands are pure
 * `ProjectDocument → Command`, so neither can see the other: a destructive
 * action has to drop the dead ids at its own call site. The track half of
 * that contract already existed (`SelectionStore.pruneTrack` /
 * `retainTracks`, covered by tests/selection-store-dead-refs.test.ts).
 *
 * The clip half did not. `App.tsx`'s keyboard Delete called
 * `selectionStore.clear()`, but the context menu, the DEL buttons and
 * `deleteClipsWithToast` cleared only the panel's local `selectedClipId` /
 * `selectedAudioClipId` — `selection.clipIds` kept naming a clip that was
 * gone. The measured consequences:
 *
 *  - Dead undo entries: the next Delete maps `selection.clipIds` through the
 *    live id sets and matches nothing, leaving the document untouched, yet
 *    the caller still executes its `deleteClips` command against an unchanged
 *    document — a history entry the user must Ctrl+Z through.
 *  - The context menu keeps reporting `hasClips` for a deleted clip, so
 *    Duplicate / Consolidate / Split stay enabled over a dead selection.
 *
 * `pruneDeadClipIds` is the production code that enforces this; it is
 * exercised directly here rather than through a mounted panel, because the
 * invariant lives in `App.tsx` (which owns the SelectionStore) and mounting
 * the whole app to assert a two-line predicate would test far too little for
 * its cost.
 */
function setup(): {
  project: ProjectStore;
  selectionStore: SelectionStore;
  doc: ReturnType<typeof createProjectFromTemplate>;
} {
  const doc = createProjectFromTemplate("house");
  return { project: new ProjectStore(doc), selectionStore: new SelectionStore(), doc };
}

describe("clip selection — dead references (SelectionStore.retainClips)", () => {
  it("keeps a live id and drops only the dead one", () => {
    const store = new SelectionStore();
    store.setClips(["live", "dead"]);
    store.retainClips(["live", "other"]);
    expect(store.getState().clipIds).toEqual(["live"]);
  });

  it("drops everything when nothing is live", () => {
    const store = new SelectionStore();
    store.setClips(["a", "b"]);
    store.retainClips([]);
    expect(store.getState().clipIds).toEqual([]);
  });

  it("does not emit when every selected id is still live", () => {
    const store = new SelectionStore();
    store.setClips(["a"]);
    let emissions = 0;
    store.subscribe(() => emissions++);
    store.retainClips(["a", "b"]);
    expect(store.getState().clipIds).toEqual(["a"]);
    // The guard matters: re-rendering every selection subscriber on every
    // document mutation for no state change is a real cost in the timeline.
    expect(emissions).toBe(0);
  });

  it("leaves trackIds and noteSelections alone", () => {
    const store = new SelectionStore();
    store.setTracks(["t1"]);
    store.setNotes({ trackId: "t1", noteIds: ["n1"] }, "replace");
    store.setClips(["dead"]);
    store.retainClips([]);
    expect(store.getState().trackIds).toEqual(["t1"]);
    expect(store.getState().noteSelections).toEqual([{ trackId: "t1", noteIds: ["n1"] }]);
  });
});

describe("pruneDeadClipIds — the invariant App.tsx applies on every mutation", () => {
  it("drops a clip id whose clip was deleted (the confirmed defect)", () => {
    const { project, selectionStore, doc } = setup();
    const clipId = doc.arrangement.clips[0]!.id;

    // The timeline arms the shared selection on pointerdown.
    selectionStore.setClips([clipId]);
    expect(selectionStore.getState().clipIds).toEqual([clipId]);

    // The DEL button / context menu deletes the clip. The document changes;
    // the selection is not touched at that call site.
    project.execute(deleteArrangementClip(doc, clipId));
    expect(project.getDoc().arrangement.clips.some((c) => c.id === clipId)).toBe(false);

    pruneDeadClipIds(project, selectionStore);

    // THE DEFECT (pre-fix): clipIds still held the deleted id.
    expect(selectionStore.getState().clipIds).toEqual([]);
  });

  it("keeps a still-live sibling in a multi-clip selection", () => {
    const { project, selectionStore, doc } = setup();
    // Arrangement clips are no-overlap, so the second one goes on the first
    // free bar rather than a guessed one.
    const firstFreeBar = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
    project.execute(addArrangementClip(doc, doc.scenes[0]!.id, firstFreeBar));
    const [first, second] = project.getDoc().arrangement.clips;
    selectionStore.setClips([first!.id, second!.id]);

    project.execute(deleteArrangementClip(project.getDoc(), first!.id));
    pruneDeadClipIds(project, selectionStore);

    expect(selectionStore.getState().clipIds).toEqual([second!.id]);
  });

  it("drops a clip id whose clip no longer exists, whatever retired it", () => {
    const { project, selectionStore, doc } = setup();
    const parent = doc.arrangement.clips[0]!;
    selectionStore.setClips([parent.id]);
    // Structural edits that REPLACE a clip's identity (split retires the
    // parent id and mints two new ones) reach the same dead-id state without
    // any delete at all — which is why the prune is at the store boundary and
    // not on the delete button.
    project.execute(deleteArrangementClip(doc, parent.id));
    pruneDeadClipIds(project, selectionStore);

    expect(selectionStore.getState().clipIds).not.toContain(parent.id);
  });

  it("is a no-op when nothing is selected (the hot path on every mutation)", () => {
    const { project, selectionStore } = setup();
    let emissions = 0;
    selectionStore.subscribe(() => emissions++);
    pruneDeadClipIds(project, selectionStore);
    expect(emissions).toBe(0);
  });

  it("keeps audio clip ids alive — the two clip systems share one selection", () => {
    const { project, selectionStore } = setup();
    const audioId = "audioClip-not-real";
    // An id that is NOT in either live set must go, proving the union is read
    // from both `arrangement.clips` and `arrangement.audioClips`.
    selectionStore.setClips([audioId]);
    pruneDeadClipIds(project, selectionStore);
    expect(selectionStore.getState().clipIds).toEqual([]);
  });
});
