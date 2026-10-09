import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addSceneAutomation,
  addSceneAutomationPoint,
  deleteArrangementClip,
  deleteScene,
  deleteTrack,
  duplicateArrangementClip,
  moveArrangementClip,
  nudgeClips,
  createScene,
  splitArrangementClipAtTick,
  trimArrangementClipStart,
} from "../src/commands/commands";
import { sceneBaseTickForClip } from "../src/project-model/events";
import { BAR_TICKS } from "../src/project-model/types";
import type { AutomationTarget, ProjectDocument, SceneAutomation } from "../src/project-model/types";

/**
 * AUTOMATION-VS-EDIT AUDIT — does scene automation follow the clip through
 * every editing verb, or silently desync?
 *
 * Model (verified against the scheduler + automationBridge):
 *  - a scene automation lane's points are ticks relative to the scene CONTENT,
 *    anchored in the arrangement at the clip's BASE tick
 *    (sceneBaseTickForClip = startBar*BAR − sceneOffsetTicks) — the scheduler
 *    passes exactly that base as sceneStartTick;
 *  - therefore: MOVE/NUDGE/DUPLICATE shift the base (the curve follows the
 *    clip), while TRIM-START/SPLIT advance sceneOffsetTicks so the base stays
 *    INVARIANT (the curve keeps its absolute timeline position — content
 *    continuity). Editing the clip and editing the curve can never desync.
 *
 * Pinned invariants (value = linear interpolation, mirrored from
 * applySceneAutomationLane):
 *  A1 move/nudge: every point's ABSOLUTE tick shifts by exactly the move delta
 *  A2 trim-left: every point's ABSOLUTE tick is INVARIANT; the first audible
 *     scene-local tick advances by the trimmed span (no restart from point[0])
 *  A3 split: left and right fragments share the base → the curve is seamless
 *     across the seam
 *  A4 duplicate: the copy's base shifts with the copy; the lane is shared
 *     (scene-keyed by design — documented, not an oversight)
 *  A5 deleteScene prunes the scene's lanes in-command (undo restores both)
 *  A6 deleteTrack prunes lanes targeting that track
 *  A7 a move→trim→split chain through a real store keeps everything exact
 */

const BAR = BAR_TICKS;

const target = (trackId: string): AutomationTarget => ({ kind: "trackGain", trackId });

interface Fixture {
  doc: ProjectDocument;
  store: ProjectStore;
  clipId: string;
  laneId: string;
  trackId: string;
}

const fixture = (): Fixture => {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
  const store = new ProjectStore(doc);
  store.execute(addSceneAutomation(store.doc, doc.scenes[0]!.id, target(trackId)));
  const laneId = (store.doc.sceneAutomation ?? [])[0]!.id;
  // A non-trivial curve: rise over bar 1, fall over bar 2.
  store.execute(addSceneAutomationPoint(store.doc, laneId, 1920, 0.9));
  store.execute(addSceneAutomationPoint(store.doc, laneId, 3840, 0.4));
  return { doc: store.doc, store, clipId: store.doc.arrangement.clips[0]!.id, laneId, trackId };
};

const laneOf = (doc: ProjectDocument): SceneAutomation => (doc.sceneAutomation ?? [])[0]!;

/** Value of the lane at an ABSOLUTE arrangement tick inside the given clip —
 *  mirrors applySceneAutomationLane's linear interpolation. */
const valueAt = (doc: ProjectDocument, clipId: string, absoluteTick: number): number => {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId)!;
  const lane = (doc.sceneAutomation ?? []).find((l) => l.sceneId === clip.sceneId)!;
  const local = absoluteTick - sceneBaseTickForClip(clip);
  const points = lane.points;
  if (local <= points[0]!.tick) return points[0]!.value;
  if (local >= points[points.length - 1]!.tick) return points[points.length - 1]!.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (local >= a.tick && local <= b.tick) {
      const span = b.tick - a.tick;
      return a.value + (b.value - a.value) * ((local - a.tick) / span);
    }
  }
  return points[points.length - 1]!.value;
};

describe("A1 move/nudge: the curve follows the clip", () => {
  it("moving a clip shifts every point's absolute tick by exactly the delta", () => {
    const f = fixture();
    // Point at scene-tick 1920 is audible at absolute 1920 in the base clip.
    expect(valueAt(f.doc, f.clipId, 1920)).toBeCloseTo(0.9, 6);
    f.store.execute(moveArrangementClip(f.doc, f.clipId, 2)); // +2 bars
    // Now audible at 1920 + 2*BAR — same scene-local position, same value.
    expect(valueAt(f.store.doc, f.clipId, 1920 + 2 * BAR)).toBeCloseTo(0.9, 6);
    // And the OLD absolute tick no longer sees the lane (clip moved away).
    expect(sceneBaseTickForClip(f.store.doc.arrangement.clips[0]!)).toBe(2 * BAR);
  });

  it("nudge behaves identically (same startBar mutation)", () => {
    const f = fixture();
    f.store.execute(nudgeClips(f.store.doc, [f.clipId], 1));
    expect(valueAt(f.store.doc, f.clipId, 1920 + BAR)).toBeCloseTo(0.9, 6);
  });
});

describe("A2 trim-left: absolute curve position is invariant", () => {
  it("trimming 1 bar advances sceneOffset; every point stays at its absolute tick", () => {
    const f = fixture();
    const baseBefore = sceneBaseTickForClip(f.doc.arrangement.clips[0]!);
    f.store.execute(trimArrangementClipStart(f.store.doc, f.clipId, 1));
    const clip = f.store.doc.arrangement.clips[0]!;
    const baseAfter = sceneBaseTickForClip(clip);
    expect(baseAfter).toBe(baseBefore); // content base invariant
    // The clip now STARTS at bar 1 — the first audible value is the value at
    // scene-tick 1920 (0.9), NOT a restart from point[0] (0.2).
    expect(valueAt(f.store.doc, f.clipId, BAR)).toBeCloseTo(0.9, 6);
    // The old absolute position of the 0.9 point (absolute 1920) is no longer
    // inside the clip (clip starts at bar 1 = 1920 — boundary: exactly at it).
    expect(valueAt(f.store.doc, f.clipId, 1920 + 960)).toBeCloseTo(0.9 + (0.4 - 0.9) * 0.5, 6);
  });
});

describe("A3 split: the curve is seamless across the seam", () => {
  it("left and right fragments share the base — value just before == just after", () => {
    const f = fixture();
    f.store.execute(splitArrangementClipAtTick(f.store.doc, f.clipId, 2 * BAR));
    const [left, right] = f.store.doc.arrangement.clips;
    // Same content base → the curve does not jump at the seam.
    expect(sceneBaseTickForClip(right!)).toBe(sceneBaseTickForClip(left!));
    const justBefore = valueAt(f.store.doc, left.id, 2 * BAR - 1);
    const justAfter = valueAt(f.store.doc, right!.id, 2 * BAR + 1);
    expect(Math.abs(justAfter - justBefore)).toBeLessThan(0.002);
  });
});

describe("A4 duplicate: shifted copy, shared lane by design", () => {
  it("the duplicate's base shifts with it; the lane stays scene-keyed", () => {
    const f = fixture();
    f.store.execute(duplicateArrangementClip(f.store.doc, f.clipId));
    const copy = f.store.doc.arrangement.clips[1]!;
    expect(sceneBaseTickForClip(copy)).toBe(sceneBaseTickForClip(f.store.doc.arrangement.clips[0]!) + 8 * BAR);
    // Same sceneId → the SAME lane plays inside both windows (scene-keyed by
    // design: a duplicate plays the same scene content, automation included).
    expect(copy.sceneId).toBe(f.store.doc.arrangement.clips[0]!.sceneId);
  });
});

describe("A5/A6 dangling-lane pruning", () => {
  it("deleteScene prunes the scene's lanes in-command (undo restores both)", () => {
    const f = fixture();
    // The fixture has only ONE scene — create a spare so scenes[0] can go.
    f.store.execute(createScene(f.store.doc, { name: "Spare" }));
    f.store.execute(addArrangementClip(f.store.doc, f.store.doc.scenes[1]!.id, 16, 4));
    f.store.execute(deleteScene(f.store.doc, f.store.doc.scenes[0]!.id));
    expect((f.store.doc.sceneAutomation ?? []).filter((l) => l.id === f.laneId)).toHaveLength(0);
    f.store.undo();
    expect((f.store.doc.sceneAutomation ?? []).find((l) => l.id === f.laneId)).toBeDefined();
  });

  it("deleteTrack prunes lanes targeting that track (undo restores)", () => {
    const f = fixture();
    f.store.execute(deleteTrack(f.store.doc, f.trackId));
    expect((f.store.doc.sceneAutomation ?? []).filter((l) => l.target.trackId === f.trackId)).toHaveLength(0);
    f.store.undo();
    expect((f.store.doc.sceneAutomation ?? []).find((l) => l.id === f.laneId)).toBeDefined();
  });

  it("normalize drops lanes for unknown scenes/targets (hand-edited files)", () => {
    const f = fixture();
    const polluted = {
      ...f.doc,
      sceneAutomation: [
        ...(f.doc.sceneAutomation ?? []),
        { id: "ghost", sceneId: "dead-scene", target: target(f.trackId), points: [{ tick: 0, value: 0.5 }] },
      ],
    };
    const normalized = normalizeProject(polluted);
    expect((normalized.sceneAutomation ?? []).find((l) => l.id === "ghost")).toBeUndefined();
    expect((normalized.sceneAutomation ?? []).find((l) => l.id === f.laneId)).toBeDefined();
  });
});

describe("A7 combined chain through a real store", () => {
  it("move → trim → split → undo ×3 → redo ×3 keeps automation and clips exact", () => {
    const f = fixture();
    const baseline = f.store.doc;
    f.store.execute(moveArrangementClip(f.store.doc, f.clipId, 1));
    f.store.execute(trimArrangementClipStart(f.store.doc, f.clipId, 2));
    f.store.execute(splitArrangementClipAtTick(f.store.doc, f.clipId, 3 * BAR));
    const afterChain = f.store.doc;
    // Continuity across the seam of the trimmed+split chain.
    const [left, right] = afterChain.arrangement.clips;
    expect(sceneBaseTickForClip(right!)).toBe(sceneBaseTickForClip(left!));
    const before = valueAt(afterChain, left!.id, 3 * BAR - 1);
    const after = valueAt(afterChain, right!.id, 3 * BAR + 1);
    expect(Math.abs(after - before)).toBeLessThan(0.002);

    for (let i = 0; i < 3; i++) f.store.undo();
    expect(f.store.doc).toEqual(baseline);
    for (let i = 0; i < 3; i++) f.store.redo();
    expect(f.store.doc).toEqual(afterChain);
  });
});
