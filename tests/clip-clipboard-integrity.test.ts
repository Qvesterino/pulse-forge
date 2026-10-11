import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addArrangementClip } from "../src/commands/arrangement";
import { addAudioClip } from "../src/commands/audioClips";
import { createScene, deleteScene } from "../src/commands/scenes";
import { buildClipClipboard, cutClips, pasteClips } from "../src/commands/clipClipboard";
import { deleteArrangementClip } from "../src/commands/arrangement";
import { normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS, type ProjectDocument } from "../src/project-model/types";

/**
 * §30 CLIPBOARD INTEGRITY — "clipboard payloads must not depend on transient
 * runtime objects that no longer exist".
 *
 * The clipboard payload is a deep clone taken at copy time, so it deliberately
 * OUTLIVES the document state it was cut from. That is what makes copy/paste
 * work at all (the originals may be deleted, moved or undone before the paste)
 * — and it is exactly why every reference the payload carries has to be
 * re-validated at paste time.
 */

function sceneDoc(): { doc: ProjectDocument; clipId: string; sceneId: string } {
  const doc = createProjectFromTemplate("house");
  const sceneId = doc.scenes[0]!.id;
  const withClip = doc.arrangement.clips.length > 0 ? doc : addArrangementClip(doc, sceneId, 4, 4).execute(doc);
  return { doc: withClip, clipId: withClip.arrangement.clips[0]!.id, sceneId };
}

describe("§30 clipboard — payload independence", () => {
  it("a copy is a deep clone: editing the live clip never rewrites the payload", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const next = moveArrangementClipSafe(doc, clipId);
    expect(payload.arrangementClips[0]!.startBar).toBe(doc.arrangement.clips[0]!.startBar);
    expect(next.arrangement.clips[0]!.startBar).not.toBe(doc.arrangement.clips[0]!.startBar);
  });

  it("copying nothing returns null and must not be treated as an empty clipboard", () => {
    const { doc } = sceneDoc();
    expect(buildClipClipboard(doc, ["not-a-real-clip"])).toBeNull();
  });
});

function moveArrangementClipSafe(doc: ProjectDocument, clipId: string): ProjectDocument {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId)!;
  const next = clip.startBar + 4;
  return {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, startBar: next } : c)),
    },
  };
}

describe("§30 clipboard — paste is one transaction", () => {
  it("paste is a single undo entry that restores the document verbatim", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const store = new ProjectStore(doc);
    store.execute(pasteClips(doc, payload, 8 * BAR_TICKS));
    expect(store.doc.arrangement.clips.length).toBe(doc.arrangement.clips.length + 1);
    store.undo();
    expect(store.doc.arrangement.clips).toEqual(doc.arrangement.clips);
  });

  it("cut removes and paste restores as two separate undo steps", () => {
    const { doc, clipId } = sceneDoc();
    const before = doc.arrangement.clips.length;
    const store = new ProjectStore(doc);
    const payload = buildClipClipboard(store.doc, [clipId])!;
    store.execute(cutClips(store.doc, [clipId]));
    expect(store.doc.arrangement.clips).toHaveLength(before - 1);
    store.execute(pasteClips(store.doc, payload, 8 * BAR_TICKS));
    expect(store.doc.arrangement.clips).toHaveLength(before);
    expect(
      store.doc.arrangement.clips.some((c) => c.id === clipId),
      "a paste is a NEW clip",
    ).toBe(false);
    expect(new Set(store.doc.arrangement.clips.map((c) => c.id)).size).toBe(before);
  });
});

describe("§30 clipboard — stale references", () => {
  it("CONTROL: an audio clip pastes onto a live track", () => {
    const { doc } = sceneDoc();
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    const withClip = addAudioClip(doc, trackId, "cb-buf", 0, 2, {}).execute(doc);
    const audioId = withClip.arrangement.audioClips![0]!.id;
    const payload = buildClipClipboard(withClip, [audioId])!;
    const pasted = pasteClips(withClip, payload, 4 * BAR_TICKS).execute(withClip);
    expect(pasted.arrangement.audioClips).toHaveLength(2);
    expect(pasted.arrangement.audioClips![1]!.trackId).toBe(trackId);
  });

  it("an audio clip whose track was deleted falls back to a live track (documented contract)", () => {
    const { doc } = sceneDoc();
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    const withClip = addAudioClip(doc, trackId, "cb-buf", 0, 2, {}).execute(doc);
    const audioId = withClip.arrangement.audioClips![0]!.id;
    const payload = buildClipClipboard(withClip, [audioId])!;

    const otherTrack = doc.tracks.find((t) => t.kind !== "group" && t.id !== trackId)!;
    const withoutTrack: ProjectDocument = {
      ...withClip,
      tracks: withClip.tracks.filter((t) => t.id !== trackId),
    };
    const pasted = pasteClips(withoutTrack, payload, 4 * BAR_TICKS).execute(withoutTrack);
    expect(pasted.arrangement.audioClips![1]!.trackId, "must not land on a dead track").toBe(otherTrack.id);
  });

  it("REFUSES an arrangement clip whose scene was deleted after the copy", () => {
    // Measured before the fix: the paste succeeded, wrote a clip whose
    // sceneId named a deleted scene, and `normalizeProject` — the save/load
    // pass — dropped it on the next reload. The clip looked fine, played at
    // doc.bpm, and then silently vanished.
    const { doc, clipId, sceneId } = sceneDoc();
    const withSecond = createScene(doc, "Second").execute(doc);
    const payload = buildClipClipboard(withSecond, [clipId])!;

    const afterDelete = deleteScene(withSecond, sceneId).execute(withSecond);
    expect(afterDelete.scenes.some((s) => s.id === sceneId)).toBe(false);
    expect(afterDelete.arrangement.clips).toHaveLength(0);

    expect(() => pasteClips(afterDelete, payload, 0)).toThrow(/scene/i);

    // The refusal is total: nothing lands, so nothing can be lost later.
    const untouched = afterDelete;
    expect(() => pasteClips(afterDelete, payload, 0)).toThrow();
    expect(untouched.arrangement.clips).toHaveLength(0);
    expect(normalizeProject(untouched).arrangement.clips).toHaveLength(0);
  });

  it("a pasted clip survives a save/load round-trip (the defect's real damage)", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const pasted = pasteClips(doc, payload, 8 * BAR_TICKS).execute(doc);
    const reloaded = normalizeProject(pasted);
    expect(reloaded.arrangement.clips.length, "a pasted clip must not evaporate on save").toBe(
      pasted.arrangement.clips.length,
    );
    expect(reloaded.arrangement.clips.every((c) => reloaded.scenes.some((s) => s.id === c.sceneId))).toBe(true);
  });
});

describe("§30 clipboard — repeated use", () => {
  it("pasting the same payload twice yields two independent, non-overlapping copies", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const store = new ProjectStore(doc);
    store.execute(pasteClips(store.doc, payload, 8 * BAR_TICKS));
    store.execute(pasteClips(store.doc, payload, 12 * BAR_TICKS));
    const ids = store.doc.arrangement.clips.map((c) => c.id);
    expect(new Set(ids).size, "ids stay unique across repeated pastes").toBe(ids.length);
    const sorted = [...store.doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startBar).toBeGreaterThanOrEqual(sorted[i - 1]!.startBar + sorted[i - 1]!.lengthBars);
    }
  });

  it("editing one pasted copy never rewrites the other or the payload", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const store = new ProjectStore(doc);
    store.execute(pasteClips(store.doc, payload, 8 * BAR_TICKS));
    store.execute(pasteClips(store.doc, payload, 12 * BAR_TICKS));
    const before = store.doc;
    const target = [...before.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[1]!;
    const edited = moveArrangementClipSafe(before, target.id);

    expect(payload.arrangementClips[0]!.startBar, "the payload must not follow an edit").toBe(
      doc.arrangement.clips[0]!.startBar,
    );
    // Every OTHER clip — original included — is byte-identical after the edit.
    const others = (d: ProjectDocument) =>
      d.arrangement.clips
        .filter((c) => c.id !== target.id)
        .map((c) => ({ id: c.id, startBar: c.startBar, lengthBars: c.lengthBars, sceneId: c.sceneId }));
    expect(others(edited)).toEqual(others(before));
    expect(edited.arrangement.clips.find((c) => c.id === target.id)!.startBar).toBe(target.startBar + 4);
  });

  it("deleteArrangementClip leaves the clipboard payload intact for a later paste", () => {
    const { doc, clipId } = sceneDoc();
    const payload = buildClipClipboard(doc, [clipId])!;
    const emptied = deleteArrangementClip(doc, clipId).execute(doc);
    expect(emptied.arrangement.clips).toHaveLength(0);
    const pasted = pasteClips(emptied, payload, 8 * BAR_TICKS).execute(emptied);
    expect(pasted.arrangement.clips).toHaveLength(1);
    expect(pasted.arrangement.clips[0]!.id).not.toBe(clipId);
  });
});
