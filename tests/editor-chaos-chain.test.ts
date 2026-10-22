import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { SelectionStore } from "../src/store/SelectionStore";
import {
  addAudioClip,
  moveAudioClip,
  resizeAudioClip,
  trimAudioClipStart,
  splitAudioClipAtTick,
  duplicateAudioClip,
  deleteAudioClip,
  updateAudioClip,
} from "../src/commands/commands";
import { nudgeClips } from "../src/commands/clipEditing";
import { audioClipPlayWindow } from "../src/audio-engine/warpManager";
import { audioClipDurationSec } from "../src/commands/audioClips";
import { audioClipSourceSecondsPerWallSecond } from "../src/project-model/audio-clip-warp";
import { ticksPerBar } from "../src/project-model/schema";
import { pruneDeadClipIds } from "../src/ui/useClipSelectionInvariant";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE REAL-USER CHAOS CHAIN.
 *
 * One session, one project, the operations a user actually performs, in the
 * order they actually perform them — and the project's invariants checked
 * after EVERY step.
 *
 *   import content → move → trim both sides → fade → split → duplicate →
 *   move the duplicate → multi-select → group move → delete → undo several
 *   times → redo → nudge → a post-undo action.
 *
 * WHAT IS CHECKED, EVERY STEP:
 *
 *   - every clip has a UNIQUE id,
 *   - every clip's geometry is VALID (finite start, positive length, start
 *     ≥ 0, no NaN/Infinity anywhere),
 *   - every clip's SOURCE WINDOW is playable (the engine can schedule it),
 *   - the SELECTION never names a clip that is not in the document,
 *   - the UNDO stack restores the document EXACTLY, and REDO re-applies it
 *     exactly (deep equality — a history frame that SHARES a nested object
 *     with the live document mutates it, and this is where that shows).
 *
 * A note on NO-OPS: a command that changes nothing creates no history entry
 * (that is the repo's "dead Ctrl+Z steps were the symptom" fix), so the
 * chain only ever moves a clip to a position it is not already in.
 */

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every invariant the editor promises, checked on the whole document. */
function assertInvariants(doc: ProjectDocument, selection: SelectionStore, label: string): void {
  const ids = new Set<string>();
  for (const clip of doc.arrangement.audioClips ?? []) {
    expect(clip.id, `${label}: clip id is unique`).toBeTruthy();
    expect(ids.has(clip.id), `${label}: duplicate clip id ${clip.id}`).toBe(false);
    ids.add(clip.id);

    expect(Number.isFinite(clip.startBar), `${label}: clip start is finite`).toBe(true);
    expect(Number.isFinite(clip.lengthBars), `${label}: clip length is finite`).toBe(true);
    expect(clip.startBar, `${label}: clip start is not negative`).toBeGreaterThanOrEqual(0);
    expect(clip.lengthBars, `${label}: clip length is positive`).toBeGreaterThan(0);
    expect(clip.lengthBars, `${label}: clip length is within the model ceiling`).toBeLessThanOrEqual(8192);

    expect(Number.isFinite(clip.offsetSec), `${label}: offsetSec is finite`).toBe(true);
    expect(clip.offsetSec, `${label}: offsetSec is not negative`).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(clip.trimStart), `${label}: trimStart is finite`).toBe(true);
    expect(clip.trimStart, `${label}: trimStart is not negative`).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(clip.trimEnd), `${label}: trimEnd is finite`).toBe(true);
    expect(clip.trimEnd, `${label}: trimEnd is not negative`).toBeGreaterThanOrEqual(0);
    expect(clip.stretchRate, `${label}: the stretch rate is in range`).toBeGreaterThanOrEqual(0.25);
    expect(clip.stretchRate, `${label}: the stretch rate is in range`).toBeLessThanOrEqual(4);

    // The fades must live inside the clip.
    const clipSec = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
    expect(clip.fadeIn, `${label}: fadeIn is inside the clip`).toBeGreaterThanOrEqual(0);
    expect(clip.fadeIn, `${label}: fadeIn is inside the clip`).toBeLessThanOrEqual(clipSec + 1e-6);
    expect(clip.fadeOut, `${label}: fadeOut is inside the clip`).toBeGreaterThanOrEqual(0);
    expect(clip.fadeOut, `${label}: fadeOut is inside the clip`).toBeLessThanOrEqual(clipSec + 1e-6);

    // The engine must be able to schedule it.
    const requested = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
    const win = audioClipPlayWindow(clip, 30, requested, 1);
    expect(Number.isFinite(win.playOffset), `${label}: the playhead is finite`).toBe(true);
    expect(win.playOffset, `${label}: the playhead is not negative`).toBeGreaterThanOrEqual(0);
    expect(win.duration, `${label}: the played duration is positive`).toBeGreaterThan(0);
  }

  // The selection never names a clip that is not there.
  for (const id of selection.getState().clipIds) {
    expect(ids.has(id), `${label}: the selection names a live clip`).toBe(true);
  }
}

const clipOf = (doc: ProjectDocument, index = 0): AudioClip => doc.arrangement.audioClips![index]!;

/**
 * Trim a clip's start by `bars`, the way the ARRANGEMENT PANEL's gesture does:
 * the start edge moves right, the end edge never moves, and the source
 * position advances by the WALL delta converted to source seconds.
 */
function trimStartBy(doc: ProjectDocument, clipId: string, bars: number) {
  const clip = doc.arrangement.audioClips!.find((c) => c.id === clipId)!;
  const wallSec = audioClipDurationSec(doc, bars, clip.startBar);
  const sourceDelta = wallSec * audioClipSourceSecondsPerWallSecond(clip);
  return trimAudioClipStart(doc, clipId, {
    startBar: clip.startBar + bars,
    lengthBars: clip.lengthBars - bars,
    trimStart: clip.trimStart ?? 0,
    offsetSec: (clip.offsetSec ?? 0) + sourceDelta,
  });
}

describe("the real-user chaos chain keeps every invariant", () => {
  it("runs the whole session without breaking an invariant", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const selection = new SelectionStore();
    // The APP's own selection invariant, mounted exactly as `App.tsx` mounts
    // it: every document mutation prunes the ids that no longer name a live
    // object. Without it the selection would keep naming the fragments the
    // split replaced — which is exactly the stale-selection state the editor
    // must not have.
    const unsubscribe = store.subscribe(() => pruneDeadClipIds(store, selection));
    try {
      // 1. IMPORT CONTENT.
      store.execute(addAudioClip(store.doc, store.doc.tracks[0].id, "factory.kick", 0, 4));
      store.execute(addAudioClip(store.doc, store.doc.tracks[1].id, "factory.kick", 4, 4));
      assertInvariants(store.doc, selection, "after import");
      const firstClipId = clipOf(store.doc, 0).id;

      // 2. MOVE.
      store.execute(moveAudioClip(store.doc, firstClipId, 2));
      assertInvariants(store.doc, selection, "after move");

      // 3. TRIM BOTH SIDES.
      store.execute(trimStartBy(store.doc, firstClipId, 1));
      store.execute(resizeAudioClip(store.doc, firstClipId, 2));
      assertInvariants(store.doc, selection, "after trim");

      // 4. FADE.
      store.execute(updateAudioClip(store.doc, firstClipId, { fadeIn: 0.4, fadeOut: 0.6 }));
      assertInvariants(store.doc, selection, "after fade");

      // 5. SPLIT — at the clip's own middle, so the split is inside it whatever
      // the preceding moves and trims did to its geometry.
      const beforeSplit = store.doc.arrangement.audioClips!.length;
      const splitClip = clipOf(store.doc, 0);
      const splitTick = Math.round((splitClip.startBar + splitClip.lengthBars / 2) * ticksPerBar(store.doc));
      store.execute(splitAudioClipAtTick(store.doc, firstClipId, splitTick));
      expect(store.doc.arrangement.audioClips!.length, "the split produced two clips").toBe(beforeSplit + 1);
      assertInvariants(store.doc, selection, "after split");

      // 6. DUPLICATE — of a clip that still EXISTS. The split replaced the
      // original with two fragments under NEW ids, so the pre-split id is dead
      // (a good thing to assert: the selection must not follow it either).
      const beforeDuplicate = store.doc.arrangement.audioClips!.length;
      const liveId = store.doc.arrangement.audioClips![0]!.id;
      expect(
        store.doc.arrangement.audioClips!.some((c) => c.id === firstClipId),
        "the split kept the original id",
      ).toBe(false);
      store.execute(duplicateAudioClip(store.doc, liveId));
      expect(store.doc.arrangement.audioClips!.length, "the duplicate added a clip").toBe(beforeDuplicate + 1);
      assertInvariants(store.doc, selection, "after duplicate");

      // 7. MOVE THE DUPLICATE.
      const duplicateId = store.doc.arrangement.audioClips!.at(-1)!.id;
      store.execute(moveAudioClip(store.doc, duplicateId, 12));
      assertInvariants(store.doc, selection, "after moving the duplicate");

      // 8. MULTI-SELECT + GROUP MOVE.
      selection.setClips(store.doc.arrangement.audioClips!.map((c) => c.id));
      assertInvariants(store.doc, selection, "after multi-select");
      store.execute(nudgeClips(store.doc, selection.getState().clipIds, 0.25));
      assertInvariants(store.doc, selection, "after the group move");

      // 9. DELETE.
      const beforeDelete = store.doc.arrangement.audioClips!.length;
      store.execute(deleteAudioClip(store.doc, duplicateId));
      expect(store.doc.arrangement.audioClips!.length, "the delete removed exactly one clip").toBe(beforeDelete - 1);
      selection.setClips(store.doc.arrangement.audioClips!.map((c) => c.id));
      assertInvariants(store.doc, selection, "after delete");

      // 10. UNDO SEVERAL TIMES — the document must come back EXACTLY.
      const snapshots: ProjectDocument[] = [];
      for (let i = 0; i < 8; i++) {
        snapshots.push(store.doc);
        store.undo();
        assertInvariants(store.doc, selection, `after undo ${i + 1}`);
      }
      // Walk back up and check every restored frame is identical to the frame it
      // replaced.
      for (let i = snapshots.length - 1; i >= 0; i--) {
        store.redo();
        assertInvariants(store.doc, selection, `after redo ${snapshots.length - i}`);
        expect(deepEqual(store.doc, snapshots[i]!), `redo ${snapshots.length - i} restored the exact document`).toBe(
          true,
        );
      }

      // 11. A NEW ACTION AFTER AN UNDO MUST CLEAR THE REDO STACK.
      store.undo();
      expect(store.canRedo, "the redo stack survives an undo").toBe(true);
      const anyLiveClip = store.doc.arrangement.audioClips![0]!.id;
      store.execute(moveAudioClip(store.doc, anyLiveClip, 16));
      expect(store.canRedo, "a new action must clear the redo stack").toBe(false);
      assertInvariants(store.doc, selection, "after the post-undo action");

      // 12. THE FINAL STATE IS STILL COHERENT.
      expect(store.doc.arrangement.audioClips!.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it("a rapid move → undo → move sequence never corrupts the geometry", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0].id, "factory.kick", 0, 4));
    const clipId = store.doc.arrangement.audioClips![0]!.id;
    const selection = new SelectionStore();

    for (let i = 0; i < 12; i++) {
      expect(
        store.doc.arrangement.audioClips!.some((c) => c.id === clipId),
        `the clip vanished before move ${i}`,
      ).toBe(true);
      // Always a REAL change: a move to the position the clip already has is a
      // no-op, and a no-op correctly creates no undo entry — so undoing it
      // would undo the IMPORT instead.
      store.execute(moveAudioClip(store.doc, clipId, i + 1));
      assertInvariants(store.doc, selection, `move ${i}`);
      store.undo();
      assertInvariants(store.doc, selection, `undo ${i}`);
      expect(
        store.doc.arrangement.audioClips!.some((c) => c.id === clipId),
        `the clip vanished after undo ${i}`,
      ).toBe(true);
      store.execute(moveAudioClip(store.doc, clipId, i + 1.5));
      assertInvariants(store.doc, selection, `re-move ${i}`);
    }
    // Undoing EVERYTHING removes the import too — the document returns to the
    // template, and the invariants still hold on that empty state.
    while (store.canUndo) store.undo();
    expect(store.doc.arrangement.audioClips ?? [], "undoing everything restores the empty arrangement").toHaveLength(0);
    assertInvariants(store.doc, selection, "after undoing everything");
  });

  it("a duplicate's source window is independent of its original", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0].id, "factory.kick", 0, 4));
    const originalId = store.doc.arrangement.audioClips![0]!.id;
    store.execute(duplicateAudioClip(store.doc, originalId));
    const copyId = store.doc.arrangement.audioClips!.at(-1)!.id;

    // Trim the copy's start: the original must not move.
    const originalBefore = { ...clipOf(store.doc, 0) };
    store.execute(trimStartBy(store.doc, copyId, 1));
    expect(clipOf(store.doc, 0), "editing a copy must not change the original").toEqual(originalBefore);
    expect(clipOf(store.doc, 1).offsetSec, "the copy advanced its own source position").toBeGreaterThan(0);
  });
});
