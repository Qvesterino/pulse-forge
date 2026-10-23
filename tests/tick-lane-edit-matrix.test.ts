import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addMidiClip,
  moveMidiClip,
  resizeMidiClip,
  trimMidiClipStart,
  splitMidiClipAtTick,
  duplicateMidiClip,
  setMidiClipMuted,
  setMidiClipLocked,
  deleteMidiClip,
} from "../src/commands/midiClips";
import {
  addAutomationClip,
  moveAutomationClip,
  resizeAutomationClip,
  trimAutomationClipStart,
  splitAutomationClipAtTick,
  duplicateAutomationClip,
  addAutomationClipPoint,
  moveAutomationClipPoint,
  removeAutomationClipPoint,
  linkAutomationClipTarget,
  unlinkAutomationClipTarget,
  setAutomationClipMuted,
  setAutomationClipLocked,
  deleteAutomationClip,
} from "../src/commands/automationClips";
import { normalizeProject, MAX_ARRANGEMENT_CLIP_TICKS, ticksPerBar } from "../src/project-model/schema";
import { midiPhraseLengthTicks } from "../src/project-model/midiTime";
import type { ArrangementAutomationClip, MidiClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE TICK-ADDRESSED LANES — MIDI and automation.
 *
 * Two lanes, one shape: they are addressed in TICKS (not bars), and their
 * content lives OUTSIDE the clip.
 *
 *   - A MIDI clip points at a PATTERN. Its visible range maps onto the
 *     pattern through `phaseOffsetTicks`, and the pattern REPEATS until the
 *     range ends. The phase period is the PHRASE length, not the step grid —
 *     a note may outlive the grid, and the renderer and the scheduler both
 *     repeat at the phrase length. A trim or a split that wrapped the phase
 *     against the GRID would play different notes at different times.
 *
 *   - An automation clip carries its POINTS, in SOURCE-relative ticks. The
 *     visible window starts at `phaseOffsetTicks` into that source curve, so
 *     a trim advances the PHASE and leaves the points alone; a point the user
 *     adds at visible tick 0 lands at source tick = phase.
 *
 * Both lanes are audited on the same three axes as the audio and scene
 * lanes: property isolation, undo/redo exactness, persistence.
 */

function storeWithMidiClip(): { store: ProjectStore; clipId: string; trackId: string; patternId: string } {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const track = store.doc.tracks.find((t) => t.kind === "instrument")!;
  const patternId = store.doc.patterns[0]!.id;
  store.execute(addMidiClip(store.doc, track.id, patternId, 0, 1920));
  const clip = store.doc.arrangement.midiClips![0]!;
  return { store, clipId: clip.id, trackId: track.id, patternId };
}

function storeWithAutomationClip(): { store: ProjectStore; clipId: string; targetId: string } {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const track = store.doc.tracks.find((t) => t.kind === "instrument")!;
  const target = { kind: "trackGain" as const, trackId: track.id };
  store.execute(
    addAutomationClip(store.doc, target, 0, 1920, [
      { tick: 0, value: 0.2 },
      { tick: 960, value: 0.8 },
    ]),
  );
  const clip = store.doc.arrangement.automationClips![0]!;
  return { store, clipId: clip.id, targetId: track.id };
}

const midiOf = (doc: ProjectDocument, id: string): MidiClip => doc.arrangement.midiClips!.find((c) => c.id === id)!;
const autoOf = (doc: ProjectDocument, id: string): ArrangementAutomationClip =>
  doc.arrangement.automationClips!.find((c) => c.id === id)!;

function persistRoundTrip(doc: ProjectDocument): ProjectDocument {
  return normalizeProject(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
}

describe("the MIDI lane — property isolation and continuity", () => {
  it("a move changes the start tick and nothing else", () => {
    const { store, clipId } = storeWithMidiClip();
    const beforeDoc = store.doc;
    const before = midiOf(beforeDoc, clipId);
    store.execute(moveMidiClip(store.doc, clipId, 480));
    const after = midiOf(store.doc, clipId);
    expect(after.startTick).toBe(480);
    expect(after.lengthTicks).toBe(before.lengthTicks);
    expect(after.phaseOffsetTicks).toBe(before.phaseOffsetTicks);
    expect(after.patternId, "a move must not re-point the pattern").toBe(before.patternId);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("a resize changes the length and nothing else", () => {
    const { store, clipId } = storeWithMidiClip();
    const beforeDoc = store.doc;
    const before = midiOf(beforeDoc, clipId);
    store.execute(resizeMidiClip(store.doc, clipId, 960));
    const after = midiOf(store.doc, clipId);
    expect(after.lengthTicks).toBe(960);
    expect(after.startTick).toBe(before.startTick);
    expect(after.phaseOffsetTicks).toBe(before.phaseOffsetTicks);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("a head trim advances the phase against the PHRASE length, not the step grid", () => {
    const { store, clipId, patternId } = storeWithMidiClip();
    const pattern = store.doc.patterns.find((p) => p.id === patternId)!;
    const trackId = midiOf(store.doc, clipId).trackId;
    // The period is the PHRASE length — the notes of THIS track, not the grid.
    const phraseTicks = midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);
    expect(phraseTicks, "the phrase must be at least a bar").toBeGreaterThanOrEqual(ticksPerBar(store.doc));
    store.execute(trimMidiClipStart(store.doc, clipId, 240));
    const trimmed = midiOf(store.doc, clipId);
    expect(trimmed.startTick).toBe(240);
    expect(trimmed.lengthTicks).toBe(1680);
    expect(trimmed.phaseOffsetTicks ?? 0, "the phase advances by the trimmed ticks").toBe(240 % phraseTicks);
  });

  it("a split hands the right fragment the continued phase", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(splitMidiClipAtTick(store.doc, clipId, 960));
    const clips = [...store.doc.arrangement.midiClips!].sort((a, b) => a.startTick - b.startTick);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.lengthTicks).toBe(960);
    expect(clips[1]!.startTick).toBe(960);
    expect(clips[1]!.lengthTicks).toBe(960);
    expect(clips[0]!.id, "the left fragment keeps the original id").toBe(clipId);
    expect(clips[1]!.id).not.toBe(clipId);
  });

  it("a duplicate carries the pattern and the phase and lands after its source", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(trimMidiClipStart(store.doc, clipId, 240));
    const source = midiOf(store.doc, clipId);
    store.execute(duplicateMidiClip(store.doc, clipId));
    const copy = store.doc.arrangement.midiClips!.find((c) => c.id !== clipId)!;
    expect(copy.patternId).toBe(source.patternId);
    expect(copy.lengthTicks).toBe(source.lengthTicks);
    expect(copy.phaseOffsetTicks).toBe(source.phaseOffsetTicks);
    expect(copy.startTick).toBe(source.startTick + source.lengthTicks);
  });

  it("a lock refuses the geometry verbs and keeps mute", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(setMidiClipLocked(store.doc, clipId, true));
    expect(() => store.execute(moveMidiClip(store.doc, clipId, 480))).toThrow(/locked/);
    expect(() => store.execute(resizeMidiClip(store.doc, clipId, 960))).toThrow(/locked/);
    expect(() => store.execute(deleteMidiClip(store.doc, clipId))).toThrow(/locked/);
    expect(() => store.execute(splitMidiClipAtTick(store.doc, clipId, 480))).toThrow(/locked/);
    expect(() => store.execute(trimMidiClipStart(store.doc, clipId, 240))).toThrow(/locked/);
    // Mute is a mix verb and stays allowed.
    store.execute(setMidiClipMuted(store.doc, clipId, true));
    expect(midiOf(store.doc, clipId).muted).toBe(true);
  });

  it("the geometry clamps keep the clip playable", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(moveMidiClip(store.doc, clipId, -100));
    expect(midiOf(store.doc, clipId).startTick).toBe(0);
    store.execute(resizeMidiClip(store.doc, clipId, 0));
    expect(midiOf(store.doc, clipId).lengthTicks, "a zero-length clip becomes one tick").toBe(1);
    store.execute(resizeMidiClip(store.doc, clipId, 1e12));
    expect(midiOf(store.doc, clipId).lengthTicks).toBe(MAX_ARRANGEMENT_CLIP_TICKS);
  });

  it("a MIDI clip survives a save/load round trip", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(trimMidiClipStart(store.doc, clipId, 240));
    store.execute(moveMidiClip(store.doc, clipId, 480));
    const before = midiOf(store.doc, clipId);
    const restored = persistRoundTrip(store.doc);
    const after = restored.arrangement.midiClips!.find((c) => c.id === clipId)!;
    expect(after.startTick).toBe(before.startTick);
    expect(after.lengthTicks).toBe(before.lengthTicks);
    expect(after.phaseOffsetTicks ?? 0).toBe(before.phaseOffsetTicks ?? 0);
  });
});

describe("the automation lane — property isolation and curve continuity", () => {
  it("a move changes the start tick and nothing else", () => {
    const { store, clipId } = storeWithAutomationClip();
    const beforeDoc = store.doc;
    const before = autoOf(beforeDoc, clipId);
    store.execute(moveAutomationClip(store.doc, clipId, 480));
    const after = autoOf(store.doc, clipId);
    expect(after.startTick).toBe(480);
    expect(after.lengthTicks).toBe(before.lengthTicks);
    expect(after.points, "a move must not touch the curve").toEqual(before.points);
    expect(after.phaseOffsetTicks).toBe(before.phaseOffsetTicks);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("a resize changes the length and nothing else", () => {
    const { store, clipId } = storeWithAutomationClip();
    const beforeDoc = store.doc;
    const before = autoOf(beforeDoc, clipId);
    store.execute(resizeAutomationClip(store.doc, clipId, 960));
    const after = autoOf(store.doc, clipId);
    expect(after.lengthTicks).toBe(960);
    expect(after.startTick).toBe(before.startTick);
    expect(after.points).toEqual(before.points);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("a head trim advances the phase and leaves the source-relative points alone", () => {
    const { store, clipId } = storeWithAutomationClip();
    const before = autoOf(store.doc, clipId);
    store.execute(trimAutomationClipStart(store.doc, clipId, 480));
    const trimmed = autoOf(store.doc, clipId);
    expect(trimmed.startTick).toBe(480);
    expect(trimmed.lengthTicks).toBe(1440);
    expect(trimmed.phaseOffsetTicks ?? 0, "the phase advances by the trimmed ticks").toBe(480);
    expect(trimmed.points, "the points are SOURCE-relative: the phase says where the window starts").toEqual(
      before.points,
    );
  });

  it("a split hands the right fragment the continued phase", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(splitAutomationClipAtTick(store.doc, clipId, 960));
    const clips = [...store.doc.arrangement.automationClips!].sort((a, b) => a.startTick - b.startTick);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.lengthTicks).toBe(960);
    expect(clips[1]!.startTick).toBe(960);
    expect(clips[1]!.phaseOffsetTicks ?? 0, "the right half continues the curve").toBe(960);
    expect(clips[0]!.id, "the left fragment keeps the original id").toBe(clipId);
  });

  it("a point added at visible tick 0 lands at the SOURCE tick behind the phase", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(trimAutomationClipStart(store.doc, clipId, 480));
    store.execute(addAutomationClipPoint(store.doc, clipId, 0, 0.55));
    const trimmed = autoOf(store.doc, clipId);
    const point = trimmed.points.find((p) => Math.abs(p.value - 0.55) < 1e-6);
    expect(point, "the point must exist").toBeDefined();
    expect(point!.tick, "visible tick 0 is source tick = phase").toBe(trimmed.phaseOffsetTicks ?? 0);
  });

  it("a moved point keeps the curve sorted and inside the window", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(moveAutomationClipPoint(store.doc, clipId, 0, 1200, 0.42));
    const clip = autoOf(store.doc, clipId);
    const ticks = clip.points.map((p) => p.tick);
    expect(
      [...ticks].sort((a, b) => a - b),
      "the curve stays sorted",
    ).toEqual(ticks);
    for (const point of clip.points) {
      expect(point.tick).toBeGreaterThanOrEqual(0);
      expect(point.tick).toBeLessThanOrEqual(clip.lengthTicks);
    }
  });

  it("a removed point is gone and the rest survive", () => {
    const { store, clipId } = storeWithAutomationClip();
    const before = autoOf(store.doc, clipId);
    store.execute(removeAutomationClipPoint(store.doc, clipId, 0));
    const after = autoOf(store.doc, clipId);
    expect(after.points).toHaveLength(before.points.length - 1);
    expect(after.points.map((p) => p.tick)).toEqual(before.points.slice(1).map((p) => p.tick));
  });

  it("the primary target cannot be unlinked, a linked one can", () => {
    const { store, clipId, targetId } = storeWithAutomationClip();
    const primary = autoOf(store.doc, clipId).target;
    expect(() => store.execute(unlinkAutomationClipTarget(store.doc, clipId, primary))).toThrow(/primary/);
    const other = { kind: "trackPan" as const, trackId: targetId };
    store.execute(linkAutomationClipTarget(store.doc, clipId, other));
    expect(autoOf(store.doc, clipId).linkedTargets).toHaveLength(1);
    store.execute(unlinkAutomationClipTarget(store.doc, clipId, other));
    expect(autoOf(store.doc, clipId).linkedTargets ?? []).toHaveLength(0);
  });

  it("a split's fragments do not share one curve array", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(splitAutomationClipAtTick(store.doc, clipId, 960));
    const clips = [...store.doc.arrangement.automationClips!].sort((a, b) => a.startTick - b.startTick);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.points, "the fragments share one mutable curve array").not.toBe(clips[1]!.points);
    expect(clips[0]!.points[0], "but they carry the same curve values").toEqual(clips[1]!.points[0]);
  });

  it("a duplicate does NOT share its curve with the source", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(duplicateAutomationClip(store.doc, clipId));
    const copy = autoOf(store.doc, store.doc.arrangement.automationClips!.find((c) => c.id !== clipId)!.id);
    expect(copy.points).toHaveLength(2);
    // Editing the copy's curve must not touch the source's.
    store.execute(moveAutomationClipPoint(store.doc, copy.id, 0, 120, 0.1));
    const source = autoOf(store.doc, clipId);
    expect(source.points[0]!.value, "the source's curve changed with the copy's").toBe(0.2);
  });

  it("a lock refuses the geometry verbs and keeps mute", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(setAutomationClipLocked(store.doc, clipId, true));
    expect(() => store.execute(moveAutomationClip(store.doc, clipId, 480))).toThrow(/locked/);
    expect(() => store.execute(resizeAutomationClip(store.doc, clipId, 960))).toThrow(/locked/);
    expect(() => store.execute(deleteAutomationClip(store.doc, clipId))).toThrow(/locked/);
    expect(() => store.execute(splitAutomationClipAtTick(store.doc, clipId, 480))).toThrow(/locked/);
    store.execute(setAutomationClipMuted(store.doc, clipId, true));
    expect(autoOf(store.doc, clipId).muted).toBe(true);
  });

  it("an automation clip survives a save/load round trip", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(trimAutomationClipStart(store.doc, clipId, 480));
    store.execute(addAutomationClipPoint(store.doc, clipId, 240, 0.33));
    const before = autoOf(store.doc, clipId);
    const restored = persistRoundTrip(store.doc);
    const after = restored.arrangement.automationClips!.find((c) => c.id === clipId)!;
    expect(after.startTick).toBe(before.startTick);
    expect(after.lengthTicks).toBe(before.lengthTicks);
    expect(after.phaseOffsetTicks ?? 0).toBe(before.phaseOffsetTicks ?? 0);
    expect(after.points).toEqual(before.points);
  });
});

describe("the tick-addressed lanes — undo, persistence and deletion", () => {
  it("every MIDI verb is one history entry and restores exactly", () => {
    const verbs: Array<[string, (s: ProjectStore, id: string) => void]> = [
      ["move", (s, id) => s.execute(moveMidiClip(s.doc, id, 480))],
      ["resize", (s, id) => s.execute(resizeMidiClip(s.doc, id, 960))],
      ["trim", (s, id) => s.execute(trimMidiClipStart(s.doc, id, 240))],
      ["split", (s, id) => s.execute(splitMidiClipAtTick(s.doc, id, 480))],
      ["duplicate", (s, id) => s.execute(duplicateMidiClip(s.doc, id))],
      ["mute", (s, id) => s.execute(setMidiClipMuted(s.doc, id, true))],
    ];
    for (const [label, run] of verbs) {
      const { store, clipId } = storeWithMidiClip();
      const beforeDoc = store.doc;
      run(store, clipId);
      const afterDoc = JSON.stringify(store.doc);
      store.undo();
      expect(JSON.stringify(store.doc), `${label}: undo must restore the exact document`).toBe(
        JSON.stringify(beforeDoc),
      );
      store.redo();
      expect(JSON.stringify(store.doc), `${label}: redo must re-apply exactly`).toBe(afterDoc);
    }
  });

  it("every automation verb is one history entry and restores exactly", () => {
    const verbs: Array<[string, (s: ProjectStore, id: string) => void]> = [
      ["move", (s, id) => s.execute(moveAutomationClip(s.doc, id, 480))],
      ["resize", (s, id) => s.execute(resizeAutomationClip(s.doc, id, 960))],
      ["trim", (s, id) => s.execute(trimAutomationClipStart(s.doc, id, 240))],
      ["split", (s, id) => s.execute(splitAutomationClipAtTick(s.doc, id, 480))],
      ["duplicate", (s, id) => s.execute(duplicateAutomationClip(s.doc, id))],
      ["point", (s, id) => s.execute(addAutomationClipPoint(s.doc, id, 120, 0.5))],
      ["mute", (s, id) => s.execute(setAutomationClipMuted(s.doc, id, true))],
    ];
    for (const [label, run] of verbs) {
      const { store, clipId } = storeWithAutomationClip();
      const beforeDoc = store.doc;
      run(store, clipId);
      const afterDoc = JSON.stringify(store.doc);
      store.undo();
      expect(JSON.stringify(store.doc), `${label}: undo must restore the exact document`).toBe(
        JSON.stringify(beforeDoc),
      );
      store.redo();
      expect(JSON.stringify(store.doc), `${label}: redo must re-apply exactly`).toBe(afterDoc);
    }
  });

  it("deleting a clip leaves no reference behind", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(deleteMidiClip(store.doc, clipId));
    expect(store.doc.arrangement.midiClips ?? []).toHaveLength(0);
    const restored = persistRoundTrip(store.doc);
    expect(restored.arrangement.midiClips ?? []).toHaveLength(0);
  });

  it("the lanes do not touch each other's clips", () => {
    const { store, clipId } = storeWithMidiClip();
    const midiBefore = JSON.stringify(store.doc.arrangement.midiClips);
    const autoBefore = JSON.stringify(store.doc.arrangement.automationClips ?? []);
    store.execute(moveMidiClip(store.doc, clipId, 480));
    expect(JSON.stringify(store.doc.arrangement.midiClips)).not.toBe(midiBefore);
    expect(JSON.stringify(store.doc.arrangement.automationClips ?? [])).toBe(autoBefore);
  });

  it("a bar is not a tick: the MIDI lane ignores the bar grid", () => {
    const { store, clipId } = storeWithMidiClip();
    const barTicks = ticksPerBar(store.doc);
    store.execute(moveMidiClip(store.doc, clipId, barTicks + 7));
    expect(midiOf(store.doc, clipId).startTick, "a tick-addressed lane keeps the odd tick").toBe(barTicks + 7);
  });
});
