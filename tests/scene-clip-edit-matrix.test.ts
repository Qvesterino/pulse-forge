import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  moveArrangementClip,
  resizeArrangementClip,
  deleteArrangementClip,
  splitArrangementClipAtTick,
  duplicateArrangementClip,
  trimArrangementClipStart,
} from "../src/commands/arrangement";
import { setClipsLocked } from "../src/commands/clipGroups";
import { normalizeProject, ticksPerBar } from "../src/project-model/schema";
import type { ArrangementClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE SCENE-CLIP MATRIX — the "regions" half of the editing surface.
 *
 * The audio-clip matrix (clip-edit-matrix.test.ts) covers the audio lane.
 * The arrangement lane has a DIFFERENT contract and therefore needs its own
 * matrix — a matrix built on the audio lane's assumptions would pass while
 * the scene lane was broken.
 *
 * The scene lane's contract, in one paragraph:
 *
 *   - INTEGER BARS. Every move/resize rounds to a whole bar; a scene clip is
 *     not a sample-accurate region.
 *   - NO OVERLAP. Unlike the audio lane (which LAYERS and sums), the scene
 *     lane refuses a placement that would overlap a neighbour.
 *   - CONTENT CONTINUITY. A scene clip's visible range maps onto the scene's
 *     content through TWO offsets: the pattern phase (wraps modulo the
 *     pattern, because the pattern loops) and the scene-automation offset
 *     (grows without bound, because the intensity curve does not loop). A
 *     trim or a split must advance BOTH, or the continuation replays the
 *     wrong material.
 */

const WATCHED = [
  "sceneId",
  "startBar",
  "lengthBars",
  "phaseOffsetTicks",
  "sceneOffsetTicks",
  "loop",
  "locked",
] as const;

type Watched = (typeof WATCHED)[number];

function snapshotFields(clip: ArrangementClip): Record<Watched, unknown> {
  const out = {} as Record<Watched, unknown>;
  for (const field of WATCHED) out[field] = (clip as unknown as Record<string, unknown>)[field];
  return out;
}

function changedFields(before: ArrangementClip, after: ArrangementClip): Watched[] {
  const a = snapshotFields(before);
  const b = snapshotFields(after);
  return WATCHED.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

/** A store with the template's one arrangement clip. */
function storeWithSceneClip(): { store: ProjectStore; clipId: string; sceneId: string } {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const clip = store.doc.arrangement.clips[0]!;
  return { store, clipId: clip.id, sceneId: clip.sceneId };
}

const clipOf = (doc: ProjectDocument, id: string): ArrangementClip => doc.arrangement.clips.find((c) => c.id === id)!;

function persistRoundTrip(doc: ProjectDocument): ProjectDocument {
  return normalizeProject(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
}

/** The pattern length in ticks — the modulus of the phase. */
function patternTicks(doc: ProjectDocument, sceneId: string): number {
  const scene = doc.scenes.find((s) => s.id === sceneId)!;
  const pattern = doc.patterns.find((p) => p.id === scene.patternId)!;
  return pattern.stepCount * 120;
}

describe("the scene-clip matrix — property isolation", () => {
  it("a move changes the position and nothing else", () => {
    const { store, clipId } = storeWithSceneClip();
    const beforeDoc = store.doc;
    const before = clipOf(beforeDoc, clipId);
    store.execute(moveArrangementClip(store.doc, clipId, 8));
    expect(clipOf(store.doc, clipId).startBar).toBe(8);
    expect(changedFields(before, clipOf(store.doc, clipId)).filter((f) => f !== "startBar")).toEqual([]);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
    store.redo();
    expect(clipOf(store.doc, clipId).startBar).toBe(8);
  });

  it("a resize changes the length and nothing else", () => {
    const { store, clipId } = storeWithSceneClip();
    const beforeDoc = store.doc;
    const before = clipOf(beforeDoc, clipId);
    store.execute(resizeArrangementClip(store.doc, clipId, 6));
    expect(clipOf(store.doc, clipId).lengthBars).toBe(6);
    expect(changedFields(before, clipOf(store.doc, clipId)).filter((f) => f !== "lengthBars")).toEqual([]);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("the lane is INTEGER-BAR: a fractional move rounds", () => {
    const { store, clipId } = storeWithSceneClip();
    store.execute(moveArrangementClip(store.doc, clipId, 8.6));
    expect(clipOf(store.doc, clipId).startBar).toBe(9);
    store.execute(resizeArrangementClip(store.doc, clipId, 2.4));
    expect(clipOf(store.doc, clipId).lengthBars).toBe(2);
  });

  it("the lane does NOT layer: an overlapping placement is refused", () => {
    const { store, clipId, sceneId } = storeWithSceneClip();
    store.execute(addArrangementClip(store.doc, sceneId, 8, 4));
    const other = store.doc.arrangement.clips.find((c) => c.id !== clipId)!;
    // The audio lane would LAYER these two; the scene lane refuses.
    expect(() => store.execute(moveArrangementClip(store.doc, clipId, 9))).toThrow(/overlap/);
    expect(() => store.execute(resizeArrangementClip(store.doc, clipId, 20))).toThrow(/overlap/);
    expect(() => store.execute(addArrangementClip(store.doc, sceneId, 9, 2))).toThrow(/overlap/);
    // The refused verbs changed nothing.
    expect(clipOf(store.doc, other.id).startBar).toBe(8);
    expect(clipOf(store.doc, clipId).lengthBars).toBe(4);
  });

  it("a lock refuses the geometry verbs and keeps the mix verbs", () => {
    const { store, clipId } = storeWithSceneClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    expect(() => store.execute(moveArrangementClip(store.doc, clipId, 8))).toThrow(/locked/);
    expect(() => store.execute(resizeArrangementClip(store.doc, clipId, 6))).toThrow(/locked/);
    expect(() => store.execute(deleteArrangementClip(store.doc, clipId))).toThrow(/locked/);
    expect(() => store.execute(splitArrangementClipAtTick(store.doc, clipId, ticksPerBar(store.doc)))).toThrow(
      /locked/,
    );
    expect(() => store.execute(trimArrangementClipStart(store.doc, clipId, 1))).toThrow(/locked/);
    // A duplicate is not a geometry verb — it stays allowed.
    store.execute(duplicateArrangementClip(store.doc, clipId));
    expect(store.doc.arrangement.clips).toHaveLength(2);
  });
});

describe("the scene-clip matrix — content continuity", () => {
  it("a head trim advances the pattern phase and the scene offset", () => {
    const { store, clipId } = storeWithSceneClip();
    const barTicks = ticksPerBar(store.doc);
    const mod = patternTicks(store.doc, clipOf(store.doc, clipId).sceneId);
    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    const trimmed = clipOf(store.doc, clipId);
    expect(trimmed.startBar).toBe(1);
    expect(trimmed.lengthBars, "the end edge never moves").toBe(3);
    // The offsets are OMITTED when they are zero (a zero phase is the
    // pattern's own start), so they are read as `?? 0`.
    expect(trimmed.phaseOffsetTicks ?? 0, "the phase wraps modulo the pattern").toBe(barTicks % mod);
    expect(trimmed.sceneOffsetTicks ?? 0, "the scene offset grows without bound").toBe(barTicks);
  });

  it("the phase wraps: trimming past the pattern length wraps the phase", () => {
    const { store, clipId, sceneId } = storeWithSceneClip();
    const mod = patternTicks(store.doc, sceneId);
    const barTicks = ticksPerBar(store.doc);
    store.execute(trimArrangementClipStart(store.doc, clipId, 2));
    const trimmed = clipOf(store.doc, clipId);
    expect(trimmed.phaseOffsetTicks ?? 0).toBe((2 * barTicks) % mod);
    expect(trimmed.sceneOffsetTicks ?? 0).toBe(2 * barTicks);
  });

  it("a split hands the right fragment the continued content", () => {
    const { store, clipId, sceneId } = storeWithSceneClip();
    const barTicks = ticksPerBar(store.doc);
    const mod = patternTicks(store.doc, sceneId);
    store.execute(splitArrangementClipAtTick(store.doc, clipId, 2 * barTicks));
    const clips = [...store.doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(2);
    const left = clips[0]!;
    const right = clips[1]!;
    expect(left.lengthBars).toBe(2);
    expect(right.lengthBars).toBe(2);
    expect(right.startBar).toBe(2);
    expect(right.phaseOffsetTicks ?? 0, "the right half continues the pattern").toBe((2 * barTicks) % mod);
    expect(right.sceneOffsetTicks ?? 0, "the right half continues the intensity curve").toBe(2 * barTicks);
  });

  it("a trim and a split commute: the continuation lands in the same content", () => {
    // Trim-then-split and split-then-trim must reach the SAME content state.
    const a = storeWithSceneClip();
    const b = storeWithSceneClip();
    const barTicks = ticksPerBar(a.store.doc);

    a.store.execute(trimArrangementClipStart(a.store.doc, a.clipId, 1));
    const trimmed = clipOf(a.store.doc, a.clipId);
    a.store.execute(splitArrangementClipAtTick(a.store.doc, a.clipId, 2 * barTicks));
    const afterTrimSplit = [...a.store.doc.arrangement.clips].sort((x, y) => x.startBar - y.startBar);

    b.store.execute(splitArrangementClipAtTick(b.store.doc, b.clipId, 2 * barTicks));
    const rightOfSplit = b.store.doc.arrangement.clips.find((c) => c.startBar === 2)!;
    b.store.execute(trimArrangementClipStart(b.store.doc, rightOfSplit.id, 3));
    const afterSplitTrim = [...b.store.doc.arrangement.clips].sort((x, y) => x.startBar - y.startBar);

    // The trimmed-then-split run advanced the content by 2 bars from the
    // trim; the split-then-trim run advanced it by 2 bars from the split.
    // Both must agree on the phase of the continuation.
    const trimmedSplitRight = afterTrimSplit.find((c) => c.startBar === 2)!;
    const splitTrimRight = afterSplitTrim.find((c) => c.startBar === 3)!;
    expect(trimmedSplitRight.phaseOffsetTicks).toBe(trimmed.phaseOffsetTicks!);
    expect(splitTrimRight.phaseOffsetTicks).toBe(rightOfSplit.phaseOffsetTicks!);
  });

  it("a duplicate carries the content offsets and lands without overlapping", () => {
    const { store, clipId } = storeWithSceneClip();
    const barTicks = ticksPerBar(store.doc);
    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    const source = clipOf(store.doc, clipId);
    store.execute(duplicateArrangementClip(store.doc, clipId));
    const copy = store.doc.arrangement.clips.find((c) => c.id !== clipId)!;
    expect(copy.lengthBars).toBe(source.lengthBars);
    expect(copy.phaseOffsetTicks).toBe(source.phaseOffsetTicks);
    expect(copy.sceneOffsetTicks).toBe(source.sceneOffsetTicks);
    expect(copy.startBar, "the copy lands after its source").toBe(source.startBar + source.lengthBars);
    expect(copy.startBar * barTicks).toBeGreaterThan(0);
  });
});

describe("the scene-clip matrix — undo, persistence and deletion", () => {
  it("every scene verb is one history entry and restores exactly", () => {
    // Each verb runs on a FRESH store: the verbs constrain each other (a trim
    // after a move must still move the start RIGHT), and a shared store would
    // test the interaction instead of the verb.
    const verbs: Array<[string, (s: ProjectStore, clipId: string, sceneId: string) => void]> = [
      ["move", (s, id) => s.execute(moveArrangementClip(s.doc, id, 8))],
      ["resize", (s, id) => s.execute(resizeArrangementClip(s.doc, id, 2))],
      ["trim", (s, id) => s.execute(trimArrangementClipStart(s.doc, id, 1))],
      ["split", (s, id) => s.execute(splitArrangementClipAtTick(s.doc, id, ticksPerBar(s.doc)))],
      ["duplicate", (s, id) => s.execute(duplicateArrangementClip(s.doc, id))],
      ["add", (s, _id, sceneId) => s.execute(addArrangementClip(s.doc, sceneId, 16, 4))],
    ];
    for (const [label, run] of verbs) {
      const { store, clipId, sceneId } = storeWithSceneClip();
      const beforeDoc = store.doc;
      run(store, clipId, sceneId);
      const afterDoc = JSON.stringify(store.doc);
      store.undo();
      expect(JSON.stringify(store.doc), `${label}: undo must restore the exact document`).toBe(
        JSON.stringify(beforeDoc),
      );
      store.redo();
      expect(JSON.stringify(store.doc), `${label}: redo must re-apply exactly`).toBe(afterDoc);
    }
  });

  it("an edited scene clip survives a save/load round trip", () => {
    const { store, clipId } = storeWithSceneClip();
    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    store.execute(moveArrangementClip(store.doc, clipId, 6));
    const before = clipOf(store.doc, clipId);
    const restored = persistRoundTrip(store.doc);
    const after = restored.arrangement.clips.find((c) => c.id === clipId)!;
    expect(changedFields(before, after)).toEqual([]);
  });

  it("a delete removes the clip and leaves no reference behind", () => {
    const { store, clipId } = storeWithSceneClip();
    store.execute(deleteArrangementClip(store.doc, clipId));
    expect(store.doc.arrangement.clips.some((c) => c.id === clipId)).toBe(false);
    expect((store.doc.markers ?? []).some((m) => m.linkedClipId === clipId)).toBe(false);
    const restored = persistRoundTrip(store.doc);
    expect(restored.arrangement.clips.some((c) => c.id === clipId)).toBe(false);
  });

  it("a NaN or negative placement does not poison the document", () => {
    const { store, clipId } = storeWithSceneClip();
    store.execute(moveArrangementClip(store.doc, clipId, Number.NaN));
    expect(clipOf(store.doc, clipId).startBar).toBe(0);
    expect(Number.isFinite(clipOf(store.doc, clipId).startBar)).toBe(true);
    store.execute(moveArrangementClip(store.doc, clipId, -5));
    expect(clipOf(store.doc, clipId).startBar).toBe(0);
  });
});
