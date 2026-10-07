import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip, slipAudioClip, trimAudioClipStart } from "../src/commands/commands";
import { audioClipPlayWindow } from "../src/audio-engine/AudioEngine";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * SLIP EDIT (Alt+drag in the clip body) — shift WHICH part of the source
 * plays without moving/resizing the clip.
 *
 * Invariants:
 *  SL1 slip changes ONLY offsetSec — trim windows, fades, gain, geometry
 *      and take metadata ride untouched
 *  SL2 offset clamps at ≥ 0; non-finite input is a no-op history entry
 *  SL3 undo/redo restores exactly
 *  SL4 the playable window follows the slip (audible source start =
 *      offsetSec + trimStart), so the drag preview matches what plays
 *  SL5 one gesture = one undo entry (the command is the gesture)
 */

const docWithTone = (patch: Partial<AudioClip> = {}): { doc: ProjectDocument; clipId: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const doc = addAudioClip(base, trackId, "buf-1", 0, 4, { fadeIn: 0.1, fadeOut: 0.2, gain: 0.9, ...patch }).execute(
    base,
  );
  return { doc, clipId: (doc.arrangement.audioClips ?? [])[0]!.id };
};

const clipOf = (doc: ProjectDocument, clipId: string): AudioClip =>
  (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId)!;

describe("SL1 slip changes only offsetSec", () => {
  it("geometry, trims, fades and gain ride untouched", () => {
    const { doc, clipId } = docWithTone({ trimStart: 0.3, trimEnd: 0.4 });
    const next = slipAudioClip(doc, clipId, 1.25).execute(doc);
    const slipped = clipOf(next, clipId);
    expect(slipped.offsetSec).toBeCloseTo(1.25, 6);
    expect(slipped.startBar).toBe(0);
    expect(slipped.lengthBars).toBe(4);
    expect(slipped.trimStart).toBeCloseTo(0.3, 6);
    expect(slipped.trimEnd).toBeCloseTo(0.4, 6);
    expect(slipped.fadeIn).toBeCloseTo(0.1, 6);
    expect(slipped.fadeOut).toBeCloseTo(0.2, 6);
    expect(slipped.gain).toBeCloseTo(0.9, 6);
  });

  it("slip composes after a trim: the user's trim is not dragged along", () => {
    const { doc, clipId } = docWithTone();
    const store = new ProjectStore(doc);
    store.execute(trimAudioClipStart(store.doc, clipId, { lengthBars: 3, trimStart: 0.5, offsetSec: 0 }));
    store.execute(slipAudioClip(store.doc, clipId, 2));
    const c = clipOf(store.doc, clipId);
    // Audible source start moved by the slip, the trim window survived.
    expect(c.trimStart).toBeCloseTo(0.5, 6);
    expect(c.offsetSec).toBeCloseTo(2, 6);
    expect(c.lengthBars).toBe(3);
  });
});

describe("SL2 clamps and no-ops", () => {
  it("negative offsets clamp to 0; non-finite keeps the current offset", () => {
    const { doc, clipId } = docWithTone({ offsetSec: 1 });
    const clamped = slipAudioClip(doc, clipId, -5).execute(doc);
    expect(clipOf(clamped, clipId).offsetSec).toBe(0);
    const noop = slipAudioClip(doc, clipId, Number.NaN).execute(doc);
    expect(clipOf(noop, clipId).offsetSec).toBe(1);
  });

  it("a slip to the current offset produces a no-op command (no history entry)", () => {
    const { doc, clipId } = docWithTone({ offsetSec: 1 });
    const store = new ProjectStore(doc);
    const before = store.undoStackLength;
    store.execute(slipAudioClip(store.doc, clipId, 1));
    expect(store.undoStackLength).toBe(before);
  });

  it("an unknown clip id throws", () => {
    const { doc } = docWithTone();
    expect(() => slipAudioClip(doc, "dead-id", 1)).toThrow(/not found/);
  });
});

describe("SL3 undo/redo exactness", () => {
  it("undo restores the pre-slip offset; redo re-slips", () => {
    const { doc, clipId } = docWithTone();
    const store = new ProjectStore(doc);
    const baseline = store.doc;
    store.execute(slipAudioClip(store.doc, clipId, 2.5));
    expect(clipOf(store.doc, clipId).offsetSec).toBeCloseTo(2.5, 6);
    store.undo();
    expect(store.doc).toEqual(baseline);
    store.redo();
    expect(clipOf(store.doc, clipId).offsetSec).toBeCloseTo(2.5, 6);
  });
});

describe("SL4 the playable window follows the slip", () => {
  it("audible source start = offsetSec + trimStart after a slip", () => {
    const { doc, clipId } = docWithTone({ trimStart: 0.5 });
    const store = new ProjectStore(doc);
    const windowBefore = audioClipPlayWindow(clipOf(store.doc, clipId), 8, 8, 1);
    store.execute(slipAudioClip(store.doc, clipId, 1.5));
    const slipped = clipOf(store.doc, clipId);
    const windowAfter = audioClipPlayWindow(slipped, 8, 8, 1);
    // The window shifted by exactly the slip amount.
    expect(windowAfter.playOffset - windowBefore.playOffset).toBeCloseTo(1.5, 6);
    // And equals offset + trim (the audible-start contract).
    expect(windowAfter.playOffset).toBeCloseTo(slipped.offsetSec + (slipped.trimStart ?? 0), 6);
  });
});
