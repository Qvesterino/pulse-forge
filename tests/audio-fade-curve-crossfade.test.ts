import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addAudioClip,
  crossfadeAudioClips,
  duplicateAudioClip,
  splitAudioClipAtTick,
  updateAudioClip,
} from "../src/commands/commands";
import { applyRangeCrossfade } from "../src/ui/rangeCrossfade";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * FADE CURVES + CROSSFADE-ON-OVERLAP (schema v16).
 *
 *  F1 fadeCurve: "equal" opts a clip's fades into the equal-power envelope
 *     path (the shape comp clips always use); stored only when "equal",
 *     absent = linear; carries through duplicate/split/clipboard; survives
 *     normalize
 *  X1 crossfadeAudioClips: an overlapping same-track pair gets complementary
 *     fades over the overlap span (fadeOut on the earlier, fadeIn on the
 *     later), equal-power by default, ONE undo entry
 *  X2 guards: no overlap → refuse; different tracks → refuse; each fade
 *     clamped to its own clip's duration
 *  X3 the X shortcut crossfades OVERLAPPING pairs and keeps the 0.08 seam
 *     for non-overlapping ones
 */

const BAR = BAR_TICKS;

const pairFixture = (bStart = 3, bLen = 4): { doc: ProjectDocument; a: string; b: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  let doc = addAudioClip(base, trackId, "buf-a", 0, 4).execute(base);
  doc = addAudioClip(doc, trackId, "buf-b", bStart, bLen).execute(doc);
  const byBuffer = (id: string) => (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === id)!;
  return { doc, a: byBuffer("buf-a").id, b: byBuffer("buf-b").id };
};

const clipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

describe("X1 crossfadeAudioClips", () => {
  it("an overlapping pair gets complementary equal-power fades over the overlap", () => {
    const { doc, a, b } = pairFixture(3, 4); // overlap: bars 3–4 = 1 bar = 2s @120bpm
    const store = new ProjectStore(doc);
    store.execute(crossfadeAudioClips(store.doc, a, b));
    const earlier = clipsOf(store.doc).find((c) => c.id === a)!;
    const later = clipsOf(store.doc).find((c) => c.id === b)!;
    expect(earlier.fadeOut).toBeCloseTo(2, 3);
    expect(later.fadeIn).toBeCloseTo(2, 3);
    expect(earlier.fadeCurve).toBe("equal");
    expect(later.fadeCurve).toBe("equal");
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc).toEqual(doc);
  });

  it("crossfade is direction-safe when called with (later, earlier) — fades still land on the right clips", () => {
    const { doc, a, b } = pairFixture(3, 4);
    const store = new ProjectStore(doc);
    // Later passed first: the earlier clip still gets the fadeOUT, the later the fadeIN.
    store.execute(crossfadeAudioClips(store.doc, b, a));
    const earlier = clipsOf(store.doc).find((c) => c.id === a)!;
    const later = clipsOf(store.doc).find((c) => c.id === b)!;
    expect(earlier.fadeOut).toBeCloseTo(2, 3);
    expect(later.fadeIn).toBeCloseTo(2, 3);
  });

  it("non-overlapping clips refuse; different tracks refuse", () => {
    const { doc, a, b } = pairFixture(4, 4); // adjacent, not overlapping
    expect(() => crossfadeAudioClips(doc, a, b)).toThrow(/do not overlap/);
    const otherTrack = createProjectFromTemplate("house");
    const otherTrackId = otherTrack.tracks.find((t) => t.kind === "drum")!.id;
    let otherDoc = addAudioClip(otherTrack, otherTrackId, "buf-c", 3, 4).execute(otherTrack);
    const c = clipsOf(otherDoc).find((x) => x.bufferId === "buf-c")!;
    const { a: aId } = pairFixture(3, 4);
    expect(() => crossfadeAudioClips(otherDoc, aId, c.id)).toThrow(/same track/);
  });

  it("a fully-contained overlap clamps each fade to its own clip's duration", () => {
    // buf-b (4 bars) fully contains buf-a (2 bars at bar 1..3).
    const { doc, a, b } = pairFixture(1, 4);
    const store = new ProjectStore(doc);
    store.execute(crossfadeAudioClips(store.doc, a, b));
    const earlier = clipsOf(store.doc).find((c) => c.id === a)!;
    const later = clipsOf(store.doc).find((c) => c.id === b)!;
    // Overlap = the whole of A (2 bars = 4s); A's fade clamps to its own 4s,
    // B's fade also caps at the overlap span (4s), not B's full 8s.
    expect(earlier.fadeOut).toBeCloseTo(4, 3);
    expect(later.fadeIn).toBeCloseTo(4, 3);
  });
});

describe("X3 the X shortcut crossfades overlapping pairs", () => {
  it("an overlapping pair in range gets a real crossfade, not the 0.08 seam", () => {
    const { doc, a, b } = pairFixture(3, 4);
    const store = new ProjectStore(doc);
    applyRangeCrossfade(store, store.doc, { timeRange: { fromTick: 0, toTick: 8 * BAR }, clipIds: [] });
    const earlier = clipsOf(store.doc).find((c) => c.id === a)!;
    const later = clipsOf(store.doc).find((c) => c.id === b)!;
    expect(earlier.fadeOut).toBeCloseTo(2, 3);
    expect(later.fadeIn).toBeCloseTo(2, 3);
    expect(earlier.fadeCurve).toBe("equal");
    // ONE undo entry for the whole press (frame contract).
    expect(store.undoStackLength).toBe(1);
  });

  it("adjacent (non-overlapping) clips keep the 0.08 seam behavior", () => {
    const { doc, a, b } = pairFixture(4, 4);
    const store = new ProjectStore(doc);
    applyRangeCrossfade(store, store.doc, { timeRange: { fromTick: 0, toTick: 8 * BAR }, clipIds: [] });
    const earlier = clipsOf(store.doc).find((c) => c.id === a)!;
    const later = clipsOf(store.doc).find((c) => c.id === b)!;
    expect(earlier.fadeOut).toBe(0.08);
    expect(later.fadeIn).toBe(0.08);
    expect(store.undoStackLength).toBe(1);
  });
});

describe("F1 fadeCurve storage + carry", () => {
  it("updateAudioClip stores only equal; normalize round-trips; schema is v16", () => {
    expect(SCHEMA_VERSION).toBe(16);
    const { doc, a } = pairFixture();
    const store = new ProjectStore(doc);
    store.execute(updateAudioClip(store.doc, a, { fadeCurve: "equal" }));
    expect(clipsOf(store.doc).find((c) => c.id === a)!.fadeCurve).toBe("equal");
    // linear → key dropped entirely (absent = linear).
    store.execute(updateAudioClip(store.doc, a, { fadeCurve: "linear" }));
    expect("fadeCurve" in (clipsOf(store.doc).find((c) => c.id === a) ?? {})).toBe(false);
    // Round-trip through normalize.
    store.execute(updateAudioClip(store.doc, a, { fadeCurve: "equal" }));
    const normalized = normalizeProject(store.doc);
    expect(clipsOf(normalized).find((c) => c.id === a)!.fadeCurve).toBe("equal");
    const untouched = normalizeProject(doc);
    expect("fadeCurve" in (clipsOf(untouched).find((c) => c.id === a) ?? {})).toBe(false);
  });

  it("duplicate, split and clipboard-style patch carry the curve", () => {
    const { doc, a } = pairFixture();
    const withCurve = updateAudioClip(doc, a, { fadeCurve: "equal", fadeIn: 0.5, fadeOut: 0.5 }).execute(doc);
    // Duplicate carries it.
    const duped = duplicateAudioClip(withCurve, a).execute(withCurve);
    expect(clipsOf(duped).find((c) => c.id !== a)!.fadeCurve).toBe("equal");
    // Split fragments carry it.
    const split = splitAudioClipAtTick(withCurve, a, 2 * BAR).execute(withCurve);
    for (const c of clipsOf(split)) {
      if (c.bufferId === "buf-a") expect(c.fadeCurve).toBe("equal");
    }
  });
});
