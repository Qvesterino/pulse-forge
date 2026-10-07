import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addArrangementTransition,
  addAudioClip,
  deleteArrangementClip,
  deleteAudioClip,
  removeArrangementTransition,
} from "../src/commands/commands";
import { applyDocDelta, computeDocDelta } from "../src/commands/docDelta";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * UNDO INTEGRITY — restoring the LAST element of an optional array.
 *
 * Found by the browser live-editing pass (S5, undo-during-playback): the
 * store runs every executed command's result through normalizeProject, and
 * normalize strips optional arrays that became empty (sanitizeAudioClips
 * returns undefined for []). A snapshot command's backward delta describes
 * the restore as an `ins` op anchored on the array path — applying it to a
 * document where the key no longer exists used to be a SILENT NO-OP, so
 *
 *    delete the last audio clip → Ctrl+Z
 *
 * consumed the history entry but left the clip deleted (same for any other
 * empty-stripped optional array, e.g. transitions). The docDelta engine now
 * materializes an absent anchor array for `ins`.
 */

const docWithClip = (): ProjectDocument => {
  const base = createDefaultProject();
  const trackId = base.tracks[0]!.id;
  return addAudioClip(base, trackId, "buf-1", 0, 4, { fadeIn: 0, fadeOut: 0 }).execute(base);
};

const clipCount = (doc: ProjectDocument): number => (doc.arrangement.audioClips ?? []).length;

describe("undo restores the last element of an empty-stripped array", () => {
  it("store: delete the last audio clip → undo → clip is back", () => {
    const store = new ProjectStore(docWithClip());
    const clipId = (store.doc.arrangement.audioClips ?? [])[0]!.id;
    store.execute(deleteAudioClip(store.doc, clipId));
    expect(clipCount(store.doc)).toBe(0);
    store.undo();
    expect(clipCount(store.doc)).toBe(1);
    expect((store.doc.arrangement.audioClips ?? [])[0]!.id).toBe(clipId);
  });

  it("store: same through replaceDoc (project-switch shape)", () => {
    const store = new ProjectStore(createDefaultProject());
    store.replaceDoc(docWithClip());
    const clipId = (store.doc.arrangement.audioClips ?? [])[0]!.id;
    store.execute(deleteAudioClip(store.doc, clipId));
    store.undo();
    expect(clipCount(store.doc)).toBe(1);
    // And redo re-deletes cleanly.
    store.redo();
    expect(clipCount(store.doc)).toBe(0);
    store.undo();
    expect(clipCount(store.doc)).toBe(1);
  });

  it("store: delete the last arrangement transition → undo → transition is back", () => {
    let doc = createDefaultProject();
    // The default project ships arrangement clips from bar 0 — clear them so
    // the fixture owns the timeline (same pattern as edit-tools-audit3).
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 4, 4).execute(doc);
    const clipA = doc.arrangement.clips[0]!.id;
    const clipB = doc.arrangement.clips[1]!.id;
    doc = addArrangementTransition(doc, clipA, clipB, "custom", 1).execute(doc);
    const store = new ProjectStore(doc);
    const transitionId = (store.doc.arrangement.transitions ?? [])[0]!.id;
    store.execute(removeArrangementTransition(store.doc, transitionId));
    expect((store.doc.arrangement.transitions ?? []).length).toBe(0);
    store.undo();
    expect((store.doc.arrangement.transitions ?? []).length).toBe(1);
    expect((store.doc.arrangement.transitions ?? [])[0]!.id).toBe(transitionId);
  });

  it("docDelta: an ins op into an absent array key materializes the array", () => {
    const before = docWithClip();
    const after = { ...before, arrangement: { ...before.arrangement, audioClips: undefined } } as ProjectDocument;
    const backward = computeDocDelta(after, before);
    const restored = applyDocDelta(after, backward.ops);
    expect(clipCount(restored)).toBe(clipCount(before));
  });
});
