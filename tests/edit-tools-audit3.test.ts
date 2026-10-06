import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  deleteArrangementClip,
  deleteAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  splitAudioClipAtTick,
  trimAudioClipStart,
  updateAudioClip,
} from "../src/commands/commands";
import { applyRangeCrossfade } from "../src/ui/rangeCrossfade";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * EDIT TOOLS AUDIT 3 — interaction/undo-granularity probes for the editing
 * surface (edit-tools & interaction audit, 2026-10-06). Companion to
 * edit-tools-audit (command invariants I1–I8), edit-tools-geometry-refs-audit
 * (windows/markers/boundaries) and edit-tools-notes-steps-audit (notes/steps).
 *
 * Invariants probed here:
 *  X1  one crossfade keypress (X) = ONE undo entry; one undo reverts all of it
 *  X2  repeated X presses are idempotent — no dead history entries pile up
 *  X3  X over nothing is a true no-op (zero history entries)
 *  T1  trimming a clip's left edge and expanding it back restores the exact
 *      source window (offsetSec + trimStart), fades always inside the length
 *  D1  a duplicate is fully independent: editing either clip never mutates
 *      the other (fields beyond warpMarkers)
 *  S1  combined edit chain stays internally valid through undo-all/redo-all
 */

const BAR = BAR_TICKS;

const audioClipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

interface CrossfadeDoc {
  doc: ProjectDocument;
  trackId: string;
  /** Whole gesture range: everything the doc's own clips plus the appended pair span. */
  range: { fromTick: number; toTick: number };
  emptyRange: { fromTick: number; toTick: number };
}

/**
 * House template + two adjacent audio clips (buf-a bars 0–4, buf-b bars 4–8)
 * + one adjacent scene-clip pair at bars 0–8. The template's own arrangement
 * clips (and any transitions between them) are removed first so the gesture
 * range covers exactly the fixture's content — template pairs inside the
 * range would otherwise gain transitions of their own and make every count
 * assertion template-dependent.
 */
const crossfadeDoc = (): CrossfadeDoc => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  let doc = addAudioClip(base, trackId, "buf-a", 0, 4, { fadeIn: 0, fadeOut: 0 }).execute(base);
  doc = addAudioClip(doc, trackId, "buf-b", 4, 4, { fadeIn: 0, fadeOut: 0 }).execute(doc);
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const sceneId = doc.scenes[0]!.id;
  doc = addArrangementClip(doc, sceneId, 0, 4).execute(doc);
  doc = addArrangementClip(doc, sceneId, 4, 4).execute(doc);
  return {
    doc,
    trackId,
    range: { fromTick: 0, toTick: 8 * BAR },
    emptyRange: { fromTick: 100 * BAR, toTick: 104 * BAR },
  };
};

describe("X1 crossfade gesture undo granularity", () => {
  it("one X press = one undo entry; a single undo reverts every fade and the transition", () => {
    const { doc, range } = crossfadeDoc();
    const transitionsBefore = (doc.arrangement.transitions ?? []).length;
    const store = new ProjectStore(doc);
    const did = applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    expect(did).toBe(true);
    expect(store.undoStackLength).toBe(1);
    for (const c of audioClipsOf(store.doc)) {
      if (c.bufferId !== "buf-a" && c.bufferId !== "buf-b") continue;
      expect(c.fadeIn).toBe(0.08);
      expect(c.fadeOut).toBe(0.08);
    }
    expect((store.doc.arrangement.transitions ?? []).length).toBe(transitionsBefore + 1);
    store.undo();
    expect(store.undoStackLength).toBe(0);
    expect((store.doc.arrangement.transitions ?? []).length).toBe(transitionsBefore);
    for (const c of audioClipsOf(store.doc)) {
      if (c.bufferId !== "buf-a" && c.bufferId !== "buf-b") continue;
      expect(c.fadeIn).toBe(0);
      expect(c.fadeOut).toBe(0);
    }
  });

  it("undo → redo round-trips the whole gesture exactly", () => {
    const { doc, range } = crossfadeDoc();
    const store = new ProjectStore(doc);
    applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    const afterX = store.doc;
    store.undo();
    store.redo();
    expect(store.doc).toEqual(afterX);
  });
});

describe("X2/X3 crossfade idempotence and no-op hygiene", () => {
  it("a second identical press changes nothing and leaves NO extra history entry", () => {
    const { doc, range } = crossfadeDoc();
    const store = new ProjectStore(doc);
    applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    expect(store.undoStackLength).toBe(1);
    const did2 = applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    expect(did2).toBe(false);
    expect(store.undoStackLength).toBe(1);
  });

  it("a partial re-press updates only the differing clips, still in one entry", () => {
    const { doc, range } = crossfadeDoc();
    // buf-a already carries the crossfade pair; buf-b does not.
    const first = audioClipsOf(doc).find((c) => c.bufferId === "buf-a")!;
    const prepped = updateAudioClip(doc, first.id, { fadeIn: 0.08, fadeOut: 0.08 }).execute(doc);
    const store = new ProjectStore(prepped);
    const did = applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    expect(did).toBe(true);
    expect(store.undoStackLength).toBe(1);
    for (const c of audioClipsOf(store.doc)) {
      if (c.bufferId !== "buf-a" && c.bufferId !== "buf-b") continue;
      expect(c.fadeIn).toBe(0.08);
      expect(c.fadeOut).toBe(0.08);
    }
  });

  it("X over an empty region is a true no-op: zero history entries", () => {
    const { doc, emptyRange } = crossfadeDoc();
    const store = new ProjectStore(doc);
    const did = applyRangeCrossfade(store, store.doc, { timeRange: emptyRange, clipIds: [] });
    expect(did).toBe(false);
    expect(store.undoStackLength).toBe(0);
  });

  it("a dead id riding in the clip selection neither throws nor marks the gesture dirty", () => {
    const { doc } = crossfadeDoc();
    const transitionsBefore = (doc.arrangement.transitions ?? []).length;
    const store = new ProjectStore(doc);
    const liveId = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-a")!.id;
    const did = applyRangeCrossfade(store, store.doc, { timeRange: null, clipIds: ["dead-clip", liveId] });
    expect(did).toBe(true);
    expect(store.undoStackLength).toBe(1);
    const clips = audioClipsOf(store.doc);
    expect(clips.find((c) => c.id === liveId)!.fadeIn).toBe(0.08);
    expect(clips.find((c) => c.bufferId === "buf-b")!.fadeIn).toBe(0);
    expect((store.doc.arrangement.transitions ?? []).length).toBe(transitionsBefore);
  });
});

describe("T1 trim re-expansion restores the source window", () => {
  it("trim left then expand back reveals the original source region (offsetSec+trimStart)", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const store = new ProjectStore(base);
    store.execute(addAudioClip(store.doc, trackId, "buf-1", 0, 4, { offsetSec: 0.5, fadeIn: 0.2, fadeOut: 0.3 }));
    const clipId = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-1")!.id;
    const windowAt = (d: ProjectDocument) => {
      const c = audioClipsOf(d).find((x) => x.id === clipId)!;
      return { audibleStart: c.offsetSec + c.trimStart, length: c.lengthBars };
    };
    const original = windowAt(store.doc);
    expect(original).toEqual({ audibleStart: 0.5, length: 4 });

    // Trim the left edge right by 1 bar and 1.2s into the source.
    store.execute(trimAudioClipStart(store.doc, clipId, { lengthBars: 3, trimStart: 1.2, offsetSec: 0.5 }));
    const trimmed = windowAt(store.doc);
    expect(trimmed.audibleStart).toBeCloseTo(1.7, 6);
    // Inherited fades stay inside the trimmed length (3 bars = 6s @120bpm; fade 0.2/0.3 fit).
    const trimmedClip = audioClipsOf(store.doc).find((x) => x.id === clipId)!;
    expect(trimmedClip.fadeIn).toBeLessThanOrEqual(trimmed.length * 2);
    expect(trimmedClip.fadeOut).toBeLessThanOrEqual(trimmed.length * 2);

    // Drag the left edge back out: the original source window must reappear.
    store.execute(trimAudioClipStart(store.doc, clipId, { lengthBars: 4, trimStart: 0, offsetSec: 0.5 }));
    expect(windowAt(store.doc)).toEqual(original);

    store.undo();
    expect(windowAt(store.doc)).toEqual(trimmed);
    store.undo();
    expect(windowAt(store.doc)).toEqual(original);
  });

  it("an over-long inherited fade is re-clamped by the trimmed length, per gesture", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const store = new ProjectStore(base);
    // fadeIn 3s on a 4-bar (8s @120bpm) clip; trimming to 1 bar (2s) must bound it.
    store.execute(addAudioClip(store.doc, trackId, "buf-1", 0, 4, { fadeIn: 3, fadeOut: 3 }));
    const clipId = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-1")!.id;
    store.execute(trimAudioClipStart(store.doc, clipId, { lengthBars: 1, trimStart: 0.5, offsetSec: 0 }));
    const c = audioClipsOf(store.doc).find((x) => x.id === clipId)!;
    expect(c.fadeIn).toBeLessThanOrEqual(2);
    expect(c.fadeOut).toBeLessThanOrEqual(2);
  });
});

describe("D1 duplicate independence (fields beyond warpMarkers)", () => {
  it("editing a duplicate never mutates the original, and editing the original never mutates the duplicate", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const store = new ProjectStore(base);
    store.execute(
      addAudioClip(store.doc, trackId, "buf-1", 0, 4, {
        gain: 0.8,
        trimStart: 0.4,
        loop: true,
        fadeIn: 0.2,
        fadeOut: 0.1,
      }),
    );
    const originalId = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-1")!.id;
    store.execute(duplicateAudioClip(store.doc, originalId));
    const dup = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-1" && c.id !== originalId)!;
    expect(dup.startBar).toBeCloseTo(4, 6);
    expect(dup.gain).toBe(0.8);
    expect(dup.trimStart).toBe(0.4);
    expect(dup.loop).toBe(true);
    expect(dup.fadeIn).toBe(0.2);
    expect(dup.fadeOut).toBe(0.1);

    // Mutate the ORIGINAL: the duplicate must not move. (normalizeProject
    // stores `loop: false` as an absent field — false ≡ absent by contract.)
    store.execute(
      updateAudioClip(store.doc, originalId, { gain: 1.7, trimStart: 2.5, loop: false, fadeIn: 0.02, fadeOut: 0.02 }),
    );
    const dupAfter = audioClipsOf(store.doc).find((c) => c.id === dup.id)!;
    expect(dupAfter.gain).toBe(0.8);
    expect(dupAfter.trimStart).toBe(0.4);
    expect(dupAfter.loop).toBe(true);
    expect(dupAfter.fadeIn).toBe(0.2);
    expect(dupAfter.fadeOut).toBe(0.1);

    // Mutate the DUPLICATE: the original keeps its edited values.
    store.execute(updateAudioClip(store.doc, dup.id, { gain: 0.2, trimStart: 1.5, fadeIn: 0.05 }));
    const origAfter = audioClipsOf(store.doc).find((c) => c.id === originalId)!;
    expect(origAfter.gain).toBe(1.7);
    expect(origAfter.trimStart).toBe(2.5);
    expect(origAfter.loop).not.toBe(true);
    const dupFinal = audioClipsOf(store.doc).find((c) => c.id === dup.id)!;
    expect(dupFinal.gain).toBe(0.2);
    expect(dupFinal.trimStart).toBe(1.5);
  });
});

describe("S1 combined editing stress sweep", () => {
  it("crossfade → split → move → duplicate → delete → scene-clip delete survives undo-all/redo-all", () => {
    const { doc, range } = crossfadeDoc();
    const store = new ProjectStore(doc);
    const baseline = store.doc; // constructor-normalized template — the undo-all target
    const sceneClipA = store.doc.arrangement.clips[0]!.id;

    applyRangeCrossfade(store, store.doc, { timeRange: range, clipIds: [] });
    // Split buf-a at bar 2, move the right fragment, duplicate it, delete the copy.
    const firstClip = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-a")!;
    store.execute(splitAudioClipAtTick(store.doc, firstClip.id, 2 * BAR));
    const rightFragment = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-a" && c.startBar === 2)!;
    store.execute(moveAudioClip(store.doc, rightFragment.id, 12));
    const moved = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-a" && c.startBar === 12)!;
    store.execute(duplicateAudioClip(store.doc, moved.id));
    // The duplicate lands exactly after its source: 12 + 2 = 14.
    const copy = audioClipsOf(store.doc).find((c) => c.bufferId === "buf-a" && c.startBar === 14)!;
    store.execute(deleteAudioClip(store.doc, copy.id));
    // Deleting the first appended scene clip must prune the crossfade transition too.
    store.execute(deleteArrangementClip(store.doc, sceneClipA));

    const beforeUndo = store.doc;
    expect((beforeUndo.arrangement.transitions ?? []).length).toBe((doc.arrangement.transitions ?? []).length);
    for (const c of audioClipsOf(beforeUndo)) {
      expect(Number.isFinite(c.startBar)).toBe(true);
      expect(Number.isFinite(c.lengthBars)).toBe(true);
      expect(c.fadeIn).toBeLessThanOrEqual(c.lengthBars * 2);
      expect(c.fadeOut).toBeLessThanOrEqual(c.lengthBars * 2);
    }

    const depth = store.undoStackLength;
    expect(depth).toBeGreaterThanOrEqual(6);
    while (store.canUndo) store.undo();
    expect(store.doc).toEqual(baseline);
    while (store.undoStackLength < depth) store.redo();
    expect(store.doc).toEqual(beforeUndo);
  });
});
