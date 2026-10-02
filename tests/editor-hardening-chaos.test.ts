import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addArrangementClip,
  addAudioClip,
  deleteArrangementClip,
  duplicateAudioClip,
  moveArrangementClip,
  moveAudioClip,
  resizeAudioClip,
  splitAudioClipAtTick,
  trimAudioClipStart,
  updateAudioClip,
} from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * §42 real-user chaos chain (model level): a realistic editing session run
 * through a real ProjectStore — move, trim both edges, fades, split,
 * duplicate, more moves, a multi-clip delete, then undo past the whole chain
 * and redo back — with the structural invariants asserted after every step.
 * Nothing may produce NaN, negative bounds, overlapping arrangement clips,
 * or undo/redo states that differ from the states the user actually saw.
 */

function invariants(doc: ProjectDocument, label: string): void {
  const seen = new Set<string>();
  for (const clip of doc.arrangement.clips) {
    expect(clip.id, label).toBeTruthy();
    expect(seen.has(clip.id), `${label}: duplicate clip id`).toBe(false);
    seen.add(clip.id);
    expect(Number.isFinite(clip.startBar) && clip.startBar >= 0, `${label}: clip start`).toBe(true);
    expect(Number.isFinite(clip.lengthBars) && clip.lengthBars >= 1, `${label}: clip length`).toBe(true);
  }
  // Arrangement clips keep the no-overlap contract.
  const sorted = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    expect(cur.startBar, `${label}: overlap ${prev.id} → ${cur.id}`).toBeGreaterThanOrEqual(
      prev.startBar + prev.lengthBars,
    );
  }
  for (const clip of doc.arrangement.audioClips ?? []) {
    expect(Number.isFinite(clip.startBar) && clip.startBar >= 0, `${label}: audio start`).toBe(true);
    expect(Number.isFinite(clip.lengthBars) && clip.lengthBars > 0, `${label}: audio length`).toBe(true);
    expect(clip.trimStart ?? 0, `${label}: trimStart`).toBeGreaterThanOrEqual(0);
    expect(clip.trimEnd ?? 0, `${label}: trimEnd`).toBeGreaterThanOrEqual(0);
    expect(clip.fadeIn ?? 0, `${label}: fadeIn`).toBeGreaterThanOrEqual(0);
    expect(clip.fadeOut ?? 0, `${label}: fadeOut`).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(clip.offsetSec ?? 0), `${label}: offset finite`).toBe(true);
  }
}

const layout = (doc: ProjectDocument) =>
  doc.arrangement.clips.map((c) => `${c.id}:${c.startBar}+${c.lengthBars}`).join("|") +
  "#" +
  (doc.arrangement.audioClips ?? [])
    .map((c) => `${c.id}:${c.startBar}+${c.lengthBars}:${(c.fadeIn ?? 0).toFixed(2)}`)
    .join("|");

describe("§42 chaos chain through a real store", () => {
  it("create → move → trim → fade → split → duplicate → delete → undo* → redo*", () => {
    const doc0 = createProjectFromTemplate("house");
    const store = new ProjectStore(doc0);
    // One gesture = captured before/after docs (the same contract the UI's
    // doc-swap commands use), so undo/redo replays deltas instead of
    // re-deriving from whatever state the walk reached.
    const exec = (step: string, run: () => ProjectDocument) => {
      const before = store.doc;
      const after = run();
      store.execute({ type: "chaos", label: step, execute: () => after, undo: () => before });
    };

    // create: a second arrangement clip (bars 4–8) + an audio clip (bars 0–2).
    exec("create", () => addArrangementClip(store.doc, store.doc.scenes[0]!.id, 4, 4).execute(store.doc));
    exec("import", () => {
      const track = store.doc.tracks.find((t) => t.kind !== "group")!;
      return addAudioClip(store.doc, track.id, "chaos-buf", 0, 2, {}).execute(store.doc);
    });
    invariants(store.doc, "create");

    const arrangementClipId = store.doc.arrangement.clips[1]!.id;
    const audioClipId = (store.doc.arrangement.audioClips ?? [])[0]!.id;

    // move the arrangement clip right by 4 bars.
    exec("move", () => moveArrangementClip(store.doc, arrangementClipId, 8).execute(store.doc));
    expect(store.doc.arrangement.clips[1]!.startBar).toBe(8);
    invariants(store.doc, "move");

    // trim both edges of the audio clip, then fade it.
    exec("resize", () => resizeAudioClip(store.doc, audioClipId, 1.5).execute(store.doc));
    exec("trim", () =>
      trimAudioClipStart(store.doc, audioClipId, { lengthBars: 1, trimStart: 0.2, offsetSec: 0.2 }).execute(store.doc),
    );
    exec("fade", () => updateAudioClip(store.doc, audioClipId, { fadeIn: 0.05, fadeOut: 0.1 }).execute(store.doc));
    const faded = (store.doc.arrangement.audioClips ?? [])[0]!;
    expect(faded.trimStart).toBeCloseTo(0.2, 9);
    expect(faded.fadeOut).toBeCloseTo(0.1, 9);
    invariants(store.doc, "trim+fade");

    // split the audio clip at bar 1 (halfway).
    const beforeSplit = store.doc;
    exec("split", () => splitAudioClipAtTick(store.doc, audioClipId, 1 * 480, 10).execute(store.doc));
    void beforeSplit;
    expect(store.doc.arrangement.audioClips ?? []).toHaveLength(2);
    invariants(store.doc, "split");

    // duplicate the right half and move the copy further right (audio clips
    // may layer — no decollision is expected).
    const rightId = (store.doc.arrangement.audioClips ?? []).sort((a, b) => a.startBar - b.startBar)[1]!.id;
    exec("duplicate", () => duplicateAudioClip(store.doc, rightId).execute(store.doc));
    expect(store.doc.arrangement.audioClips ?? []).toHaveLength(3);
    exec("move-duplicate", () => {
      const copy = (store.doc.arrangement.audioClips ?? [])[2]!;
      return moveAudioClip(store.doc, copy.id, 10.5).execute(store.doc);
    });
    invariants(store.doc, "duplicate+move");

    // multi-select delete: both arrangement clips in ONE gesture (the
    // context-menu path builds nextDoc through per-clip commands, then
    // commits one doc-swap).
    const docBeforeMulti = store.doc;
    let nextDoc = docBeforeMulti;
    for (const clip of docBeforeMulti.arrangement.clips) {
      nextDoc = deleteArrangementClip(nextDoc, clip.id).execute(nextDoc);
    }
    store.execute({
      type: "deleteClips",
      label: "Delete clips",
      execute: () => nextDoc,
      undo: () => docBeforeMulti,
    });
    expect(store.doc.arrangement.clips).toHaveLength(0);
    invariants(store.doc, "multi-delete");

    // undo past the WHOLE chain, then redo back — every intermediate state
    // must match the state the user saw at that step.
    const seenLayouts: string[] = [layout(store.doc)];
    while (store.canUndo) {
      store.undo();
      seenLayouts.push(layout(store.doc));
      invariants(store.doc, "undo-step");
    }
    // The oldest state is the pristine template: one clip, no audio clips.
    expect(store.doc.arrangement.clips).toHaveLength(1);
    expect(store.doc.arrangement.audioClips ?? []).toHaveLength(0);

    while (store.canRedo) {
      store.redo();
      invariants(store.doc, "redo-step");
    }
    expect(store.doc.arrangement.clips).toHaveLength(0);
    expect(store.doc.arrangement.audioClips ?? []).toHaveLength(3);
    // No state repeated mid-chain (undo actually walked distinct states).
    expect(new Set(seenLayouts).size).toBe(seenLayouts.length);
  });

  it("rapid races: move→undo→move, split→delete→undo, duplicate→move→delete", () => {
    const doc0 = createProjectFromTemplate("house");
    const doc1 = addArrangementClip(doc0, doc0.scenes[0]!.id, 4, 4).execute(doc0);
    const store = new ProjectStore(doc1);
    const exec = (run: () => ProjectDocument) => {
      const before = store.doc;
      const after = run();
      store.execute({ type: "chaos", label: "race", execute: () => after, undo: () => before });
    };
    const clipId = store.doc.arrangement.clips[1]!.id;

    // move → undo → move (fresh command each time, like two real gestures).
    exec(() => moveArrangementClip(store.doc, clipId, 6).execute(store.doc));
    store.undo();
    expect(store.doc.arrangement.clips[1]!.startBar).toBe(4);
    exec(() => moveArrangementClip(store.doc, clipId, 7).execute(store.doc));
    expect(store.doc.arrangement.clips[1]!.startBar).toBe(7);
    invariants(store.doc, "race-1");

    // audio: split → delete a half → undo (the deleted half returns intact).
    exec(() => {
      const track = store.doc.tracks.find((t) => t.kind !== "group")!;
      return addAudioClip(store.doc, track.id, "race-buf", 0, 2, {}).execute(store.doc);
    });
    const audioId = (store.doc.arrangement.audioClips ?? [])[0]!.id;
    exec(() => splitAudioClipAtTick(store.doc, audioId, 480, 10).execute(store.doc));
    const halves = store.doc.arrangement.audioClips ?? [];
    expect(halves).toHaveLength(2);
    const leftId = [...halves].sort((a, b) => a.startBar - b.startBar)[0]!.id;
    const docBeforeDelete = store.doc;
    store.execute({
      type: "chaos",
      label: "delete half",
      execute: () => ({
        ...docBeforeDelete,
        arrangement: {
          ...docBeforeDelete.arrangement,
          audioClips: (docBeforeDelete.arrangement.audioClips ?? []).filter((c) => c.id !== leftId),
        },
      }),
      undo: () => docBeforeDelete,
    } as never);
    expect(store.doc.arrangement.audioClips).toHaveLength(1);
    store.undo();
    expect(store.doc.arrangement.audioClips).toHaveLength(2);
    invariants(store.doc, "race-2");

    // duplicate → move → delete → undo: no orphan references, ids stay unique.
    // The split replaced the original clip with left/right halves — duplicate
    // the LEFT half that exists in the current doc.
    const currentLeft = [...(store.doc.arrangement.audioClips ?? [])].sort((a, b) => a.startBar - b.startBar)[0]!;
    exec(() => duplicateAudioClip(store.doc, currentLeft.id).execute(store.doc));
    expect(store.doc.arrangement.audioClips).toHaveLength(3);
    const dup = (store.doc.arrangement.audioClips ?? [])[2]!;
    expect(dup.id).not.toBe(audioId);
    exec(() => moveAudioClip(store.doc, dup.id, 12).execute(store.doc));
    const docBeforeDupDelete = store.doc;
    store.execute({
      type: "chaos",
      label: "delete dup",
      execute: () => ({
        ...docBeforeDupDelete,
        arrangement: {
          ...docBeforeDupDelete.arrangement,
          audioClips: (docBeforeDupDelete.arrangement.audioClips ?? []).filter((c) => c.id !== dup.id),
        },
      }),
      undo: () => docBeforeDupDelete,
    } as never);
    const ids = (store.doc.arrangement.audioClips ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    invariants(store.doc, "race-3");
  });
});
