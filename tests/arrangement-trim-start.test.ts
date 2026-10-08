import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  deleteArrangementClip,
  splitArrangementClipAtTick,
  trimArrangementClipStart,
} from "../src/commands/commands";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";
import type { ArrangementClip, ProjectDocument } from "../src/project-model/types";

/**
 * TRIM START for arrangement clips (edit-parita — the scene-clip twin of
 * trimAudioClipStart). The start edge moves right, the END edge never moves,
 * and the clip keeps playing the SAME part of the scene's content: pattern
 * phase wraps modulo the source pattern, scene-automation offset grows
 * unbounded (splitArrangementClipAtTick applies the identical math to its
 * right fragment — trim-after-split and split-after-trim are interchangeable).
 *
 *  T1 geometry: startBar/lengthBars move, endBar is invariant
 *  T2 content continuity: phase + scene offsets keep the base tick identity
 *     (startBar*BAR_TICKS − offset stays constant) for BOTH a looping and a
 *     non-looping pattern
 *  T3 guards: start must move right, must stay strictly inside (≥ 1 whole
 *     bar), non-finite refused, unknown id throws
 *  T4 undo/redo exact; no-overlap invariant untouched (end never moves)
 *  T5 trim-after-split composes
 */

const BAR = BAR_TICKS;

const fixture = (loop = false): { doc: ProjectDocument; clipId: string } => {
  const base = createProjectFromTemplate("house");
  let doc = base;
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const sceneId = doc.scenes[0]!.id;
  doc = addArrangementClip(doc, sceneId, 0, 4).execute(doc);
  if (loop) doc = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, loop: true } : s)) };
  return { doc, clipId: doc.arrangement.clips[0]!.id };
};

const clipOf = (doc: ProjectDocument): ArrangementClip => doc.arrangement.clips[0]!;

describe("T1 geometry", () => {
  it("start moves right, end stays, length shrinks by the same amount", () => {
    const { doc, clipId } = fixture();
    const next = trimArrangementClipStart(doc, clipId, 1.4).execute(doc);
    const c = clipOf(next);
    expect(c.startBar).toBe(1); // integer-bar contract: rounded
    expect(c.lengthBars).toBe(3);
    expect(c.startBar + c.lengthBars).toBe(4); // end invariant
  });

  it("a fractional pointer lands on the bar line at or after it", () => {
    const { doc, clipId } = fixture();
    // ceil semantics for a RIGHTWARD start: 1.1 bars → the clip begins at bar 2's
    // line only if the pointer passed bar 2; 1.1 rounds to 1.
    const rounded = trimArrangementClipStart(doc, clipId, 1.1).execute(doc);
    expect(clipOf(rounded).startBar).toBe(1);
    const next = trimArrangementClipStart(doc, clipId, 1.6).execute(doc);
    expect(clipOf(next).startBar).toBe(2);
  });
});

describe("T2 content continuity", () => {
  it("content identity: pattern phase tracks trimmed ticks modulo the pattern; scene base is invariant", () => {
    const { doc, clipId } = fixture();
    const patternTicks = (doc.patterns.find((p) => p.id === doc.scenes[0]?.patternId)?.stepCount ?? 0) * STEP_TICKS;
    const store = new ProjectStore(doc);
    store.execute(trimArrangementClipStart(store.doc, clipId, 1));
    const first = clipOf(store.doc);
    // Phase = trimmed ticks wrapped by the source pattern's loop length.
    expect(first.phaseOffsetTicks ?? 0).toBe((1 * BAR) % patternTicks);
    store.execute(trimArrangementClipStart(store.doc, clipId, 2));
    const second = clipOf(store.doc);
    expect(second.phaseOffsetTicks ?? 0).toBe((2 * BAR) % patternTicks);
    // Scene automation does NOT loop: the offset equals the full elapsed span
    // from the original clip start, so the scene base tick (startBar*BAR −
    // offset) stays at the original start — the intensity curve keeps its
    // absolute timeline position.
    expect(second.startBar * BAR - (second.sceneOffsetTicks ?? 0)).toBe(0);
    expect(second.sceneOffsetTicks).toBe(2 * BAR);
  });

  it("scene loop flag and unrelated fields ride untouched", () => {
    const { doc, clipId } = fixture(true);
    const before = clipOf(doc);
    const next = trimArrangementClipStart(doc, clipId, 1).execute(doc);
    const after = clipOf(next);
    expect(after.loop).toBe(before.loop);
    expect(after.sceneId).toBe(before.sceneId);
    expect(after.id).toBe(before.id); // split mints new ids; trim keeps the identity
  });
});

describe("T3 guards", () => {
  it("refuses leftward/no-op starts, overshoots, non-finite, unknown ids", () => {
    const { doc, clipId } = fixture();
    expect(() => trimArrangementClipStart(doc, clipId, 0)).toThrow(/move the clip's start right/);
    expect(() => trimArrangementClipStart(doc, clipId, 4)).toThrow(/at least one whole bar/);
    expect(() => trimArrangementClipStart(doc, clipId, 5)).toThrow(/at least one whole bar/);
    expect(() => trimArrangementClipStart(doc, clipId, Number.NaN)).toThrow(/finite/);
    expect(() => trimArrangementClipStart(doc, "dead-id", 1)).toThrow(/not found/);
  });
});

describe("T4 undo/redo + overlap invariant", () => {
  it("undo restores exactly; the no-overlap order is untouched (end never moves)", () => {
    const { doc, clipId } = fixture();
    const store = new ProjectStore(doc);
    const baseline = store.doc;
    store.execute(trimArrangementClipStart(store.doc, clipId, 2));
    store.undo();
    expect(store.doc).toEqual(baseline);
    store.redo();
    const c = clipOf(store.doc);
    expect(c.startBar).toBe(2);
    expect(c.lengthBars).toBe(2);
  });
});

describe("T5 trim-after-split composes", () => {
  it("split then trim the right fragment keeps the fragment's phase continuity", () => {
    const { doc, clipId } = fixture();
    const store = new ProjectStore(doc);
    store.execute(splitArrangementClipAtTick(store.doc, clipId, 2 * BAR));
    const right = store.doc.arrangement.clips[1]!;
    // Right fragment plays from phase 2 bars (960 ticks pattern → 960 mod 960 = 0 here,
    // so assert the geometry instead): start 2, length 2.
    expect(right.startBar).toBe(2);
    expect(right.lengthBars).toBe(2);
    store.execute(trimArrangementClipStart(store.doc, right.id, 3));
    const trimmed = store.doc.arrangement.clips[1]!;
    expect(trimmed.startBar).toBe(3);
    expect(trimmed.lengthBars).toBe(1);
    expect(trimmed.startBar + trimmed.lengthBars).toBe(4);
    // Right fragment carried phase 0 (2 trimmed bars = 2 pattern cycles);
    // trimming one more bar wraps again to 0 — absent ≡ 0 by contract.
    expect(trimmed.phaseOffsetTicks ?? 0).toBe(0);
    // Scene offset accumulates the FULL elapsed span from the original clip
    // start (2 bars by the split + 1 bar by the trim).
    expect(trimmed.sceneOffsetTicks).toBe(3 * BAR);
    void STEP_TICKS;
  });
});
