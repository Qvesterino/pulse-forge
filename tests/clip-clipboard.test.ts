import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  buildClipClipboard,
  cutClips,
  deleteArrangementClip,
  moveAudioClip,
  pasteClips,
  setArrangementClipLoop,
  splitAudioClipAtTick,
  trimAudioClipStart,
  updateAudioClip,
} from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIP CLIPBOARD — copy/cut/paste for timeline clips.
 *
 * Invariants (the editing audit's §6 contract, now as a feature):
 *  C1  copy is a pure snapshot — mutating the live doc afterwards never
 *      rewrites the payload; dead ids are skipped; empty match → null
 *  C2  paste mints fresh ids and deep-clones mutable arrays (warpMarkers) —
 *      editing the paste never mutates the copied original (and vice versa)
 *  C3  paste at the playhead preserves relative spacing (multi-clip) and
 *      honors the audio lane's layering overlap contract
 *  C4  a paste whose owning track vanished falls back to the first live
 *      track; take-lane provenance is stripped (a paste is a plain clip)
 *  C5  arrangement clips paste on the no-overlap lane via the documented
 *      first-free-slot walk; the per-clip loop flag survives
 *  C6  cut = copy + delete as ONE undoable entry; undo restores exactly,
 *      redo re-removes
 *  C7  pasted clips keep trim/offset/fades from after a split/trim
 *  C8  repeated paste yields independent clips (no shared state)
 */

const BAR = BAR_TICKS;

const audioClipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

const docWithTones = (): { doc: ProjectDocument; trackId: string; a: string; b: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  let doc = addAudioClip(base, trackId, "buf-a", 0, 2, { fadeIn: 0.1, fadeOut: 0.2, gain: 0.9 }).execute(base);
  doc = addAudioClip(doc, trackId, "buf-b", 4, 2, { trimStart: 0.5 }).execute(doc);
  return {
    doc,
    trackId,
    a: audioClipsOf(doc).find((c) => c.bufferId === "buf-a")!.id,
    b: audioClipsOf(doc).find((c) => c.bufferId === "buf-b")!.id,
  };
};

describe("C1 copy snapshot purity", () => {
  it("captures a mixed selection; dead ids skipped; nothing matched → null", () => {
    const { doc, a, b } = docWithTones();
    let d2 = addArrangementClip(doc, doc.scenes[0]!.id, 12, 4).execute(doc);
    const arrId = d2.arrangement.clips[0]!.id;

    const payload = buildClipClipboard(d2, [a, arrId, "dead-id"])!;
    expect(payload.audioClips.map((c) => c.id)).toEqual([a]);
    expect(payload.arrangementClips.map((c) => c.id)).toEqual([arrId]);
    expect(payload.anchorTick).toBe(0);

    expect(buildClipClipboard(d2, ["dead-1", "dead-2"])).toBeNull();
    void b;
  });

  it("later edits of the live document never rewrite the captured payload", () => {
    const { doc, a } = docWithTones();
    const payload = buildClipClipboard(doc, [a])!;
    const afterMove = moveAudioClip(doc, a, 20).execute(doc);
    // Live doc moved; the payload still holds the original position.
    expect(audioClipsOf(afterMove).find((c) => c.id === a)!.startBar).toBe(20);
    expect(payload.audioClips[0]!.startBar).toBe(0);
  });
});

describe("C2/C3/C8 paste: fresh ids, deep clones, relative spacing, layering", () => {
  it("paste at playhead lands at playhead, keeps spacing, and stays editable independently", () => {
    const { doc, a, b } = docWithTones();
    const payload = buildClipClipboard(doc, [a, b])!;
    const store = new ProjectStore(doc);
    // Playhead at bar 8 (b was at 4 → pasted b at 12; spacing 0..4 preserved).
    store.execute(pasteClips(store.doc, payload, 8 * BAR));
    const pasted = audioClipsOf(store.doc).filter((c) => c.id !== a && c.id !== b);
    expect(pasted).toHaveLength(2);
    const ids = new Set(pasted.map((c) => c.id));
    expect(ids.size).toBe(2);
    expect(pasted.find((c) => c.bufferId === "buf-a")!.startBar).toBe(8);
    expect(pasted.find((c) => c.bufferId === "buf-b")!.startBar).toBe(12);
    // Field-level carry: fades/gain/trim ride along.
    expect(pasted.find((c) => c.bufferId === "buf-a")!.fadeIn).toBeCloseTo(0.1, 6);
    expect(pasted.find((c) => c.bufferId === "buf-a")!.gain).toBeCloseTo(0.9, 6);
    expect(pasted.find((c) => c.bufferId === "buf-b")!.trimStart).toBeCloseTo(0.5, 6);

    // Editing the paste never mutates the copied originals.
    const pastedA = pasted.find((c) => c.bufferId === "buf-a")!;
    store.execute(updateAudioClip(store.doc, pastedA.id, { gain: 1.7, trimStart: 2.5 }));
    expect(payload.audioClips[0]!.gain).toBeCloseTo(0.9, 6);
    expect(payload.audioClips[0]!.trimStart).toBe(0);
    expect(audioClipsOf(store.doc).find((c) => c.id === a)!.gain).toBeCloseTo(0.9, 6);
  });

  it("audio paste layers freely at an occupied target (the audio overlap contract)", () => {
    const { doc, a } = docWithTones();
    const payload = buildClipClipboard(doc, [a])!;
    const store = new ProjectStore(doc);
    // Playhead inside the FIRST clip: paste layers right on top of it.
    store.execute(pasteClips(store.doc, payload, BAR));
    const atBar1 = audioClipsOf(store.doc).filter((c) => c.startBar === 1);
    expect(atBar1).toHaveLength(1);
  });

  it("repeated paste produces independent clips (no shared mutable state)", () => {
    const { doc } = docWithTones();
    const withWarp = updateAudioClip(doc, audioClipsOf(doc)[0]!.id, {
      warpMarkers: [
        { timeSec: 0, tick: 0 },
        { timeSec: 1, tick: 960 },
      ],
    }).execute(doc);
    const clipId = audioClipsOf(withWarp)[0]!.id;
    const originalIds = new Set(audioClipsOf(withWarp).map((c) => c.id));
    const payload = buildClipClipboard(withWarp, [clipId])!;
    const store = new ProjectStore(withWarp);
    store.execute(pasteClips(store.doc, payload, 8 * BAR));
    store.execute(pasteClips(store.doc, payload, 16 * BAR));
    const pasted = audioClipsOf(store.doc).filter((c) => !originalIds.has(c.id));
    expect(pasted).toHaveLength(2);
    const [p1, p2] = pasted;
    expect(p1!.id).not.toBe(p2!.id);
    // Warp arrays must not be shared between the two pastes (or the original).
    expect(p1!.warpMarkers).not.toBe(p2!.warpMarkers);
    expect(p1!.warpMarkers![0]).not.toBe(p2!.warpMarkers![0]);
    // Mutating one paste's warp pin leaves the other paste intact.
    store.execute(updateAudioClip(store.doc, p1!.id, { warpMarkers: [{ timeSec: 5, tick: 5 }] }));
    expect(p2 && audioClipsOf(store.doc).find((c) => c.id === p2.id)!.warpMarkers![0]!.timeSec).toBe(0);
  });
});

describe("C4 paste across tracks / stripped take provenance", () => {
  it("a clip whose track vanished pastes onto the first live track", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const doc = addAudioClip(base, trackId, "buf-a", 0, 2).execute(base);
    const clipId = audioClipsOf(doc)[0]!.id;
    // Simulate the source track disappearing AFTER capture.
    const payload = buildClipClipboard(doc, [clipId])!;
    const stripped: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) };
    const store = new ProjectStore(stripped);
    store.execute(pasteClips(store.doc, payload, 4 * BAR));
    const pasted = audioClipsOf(store.doc)[0]!;
    expect(pasted.trackId).not.toBe(trackId);
    expect(stripped.tracks.some((t) => t.id === pasted.trackId)).toBe(true);
    expect(pasted.startBar).toBe(4);
  });

  it("take-lane provenance is not carried into the paste", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    // Hand-place a clip with take metadata (the comp commands' shape).
    const doc = addAudioClip(base, trackId, "buf-a", 0, 2).execute(base);
    const clip = audioClipsOf(doc)[0]!;
    const withTake: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [{ ...clip, takeGroupId: "tg-1", takeId: "take-1", compSourceTakeId: "take-0" }],
      },
    };
    const payload = buildClipClipboard(withTake, [clip.id])!;
    const store = new ProjectStore(withTake);
    store.execute(pasteClips(store.doc, payload, 4 * BAR));
    const pasted = audioClipsOf(store.doc).find((c) => c.id !== clip.id)!;
    expect(pasted.takeGroupId).toBeUndefined();
    expect(pasted.takeId).toBeUndefined();
    expect(pasted.compSourceTakeId).toBeUndefined();
  });
});

describe("C5 arrangement paste: first-free-slot walk, loop flag carried", () => {
  const arrangementFixture = () => {
    let doc = createProjectFromTemplate("house");
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const sceneId = doc.scenes[0]!.id;
    doc = addArrangementClip(doc, sceneId, 0, 4).execute(doc);
    doc = addArrangementClip(doc, sceneId, 8, 4).execute(doc);
    const [arrA, arrB] = doc.arrangement.clips.map((c) => c.id);
    return { doc, arrA, arrB };
  };

  it("free target preserves position; occupied target walks forward; loop flag survives", () => {
    const { doc, arrA, arrB } = arrangementFixture();
    const store = new ProjectStore(doc);
    // Arm the loop flag on the source clip first (a fresh literal used to
    // silently drop it — the audit's regression).
    const withLoop = setArrangementClipLoop(store.doc, arrA, true).execute(store.doc);
    store.replaceDoc(withLoop);
    const payload = buildClipClipboard(store.doc, [arrA])!;
    // Playhead at bar 16 — free: pastes exactly there.
    store.execute(pasteClips(store.doc, payload, 16 * BAR));
    const firstPaste = store.doc.arrangement.clips.filter((c) => c.id !== arrA && c.id !== arrB)[0]!;
    expect(firstPaste.startBar).toBe(16);
    expect(firstPaste.loop).toBe(true);
    store.undo();

    // Playhead inside the clip at bars 0..4 — occupied: the walk steps by the
    // clip's own length against BOTH fixture clips: target 2 (overlaps
    // 0..4) → 6 (overlaps 8..12) → 10 (overlaps 8..12) → 14 (free).
    store.execute(pasteClips(store.doc, payload, 2 * BAR));
    const pastedArrangementClips = store.doc.arrangement.clips.filter((c) => c.id !== arrA && c.id !== arrB);
    expect(pastedArrangementClips).toHaveLength(1);
    expect(pastedArrangementClips[0]!.startBar).toBe(14);
  });

  it("multi-clip arrangement paste keeps relative order and spacing", () => {
    let doc = createProjectFromTemplate("house");
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const sceneId = doc.scenes[0]!.id;
    doc = addArrangementClip(doc, sceneId, 0, 2).execute(doc);
    doc = addArrangementClip(doc, sceneId, 4, 2).execute(doc);
    const [x, y] = doc.arrangement.clips.map((c) => c.id);
    const payload = buildClipClipboard(doc, [x, y])!;
    const store = new ProjectStore(doc);
    store.execute(pasteClips(store.doc, payload, 10 * BAR));
    const pasted = store.doc.arrangement.clips.filter((c) => c.id !== x && c.id !== y);
    expect(pasted.map((c) => c.startBar).sort((p, q) => p - q)).toEqual([10, 14]);
  });
});

describe("C6 cut = one undoable entry; C7 paste after split/trim", () => {
  it("cut removes a mixed selection in ONE undo entry; undo restores exactly; redo re-removes", () => {
    const { doc, a, b } = docWithTones();
    let d2 = addArrangementClip(doc, doc.scenes[0]!.id, 12, 4).execute(doc);
    const arrId = d2.arrangement.clips[0]!.id;
    const store = new ProjectStore(d2);
    const baseline = store.doc;
    const payload = buildClipClipboard(store.doc, [a, arrId])!;
    store.execute(cutClips(store.doc, [a, arrId]));
    expect(store.undoStackLength).toBe(1);
    expect(audioClipsOf(store.doc).find((c) => c.id === a)).toBeUndefined();
    expect(store.doc.arrangement.clips.find((c) => c.id === arrId)).toBeUndefined();
    // The payload matches the cut content (a cut paste round-trip).
    expect(payload.audioClips[0]!.id).toBe(a);
    store.undo();
    expect(store.doc).toEqual(baseline);
    store.redo();
    expect(audioClipsOf(store.doc).find((c) => c.id === a)).toBeUndefined();
    void b;
  });

  it("a split fragment pasted elsewhere keeps its trim/offset/fades", () => {
    const { doc, a } = docWithTones();
    const store = new ProjectStore(doc);
    store.execute(splitAudioClipAtTick(store.doc, a, BAR)); // split at bar 1
    const right = audioClipsOf(store.doc).find((c) => c.startBar === 1)!;
    store.execute(trimAudioClipStart(store.doc, right.id, { lengthBars: 0.5, trimStart: 0.25, offsetSec: 0 }));
    const payload = buildClipClipboard(store.doc, [right.id])!;
    store.execute(pasteClips(store.doc, payload, 8 * BAR));
    const pasted = audioClipsOf(store.doc).find((c) => c.startBar === 8 && c.id !== right.id)!;
    expect(pasted.trimStart).toBeCloseTo(0.25, 6);
    expect(pasted.lengthBars).toBeCloseTo(0.5, 6);
    expect(pasted.id).not.toBe(right.id);
  });
});
