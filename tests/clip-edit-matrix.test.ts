import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addAudioClip,
  moveAudioClip,
  resizeAudioClip,
  trimAudioClipStart,
  splitAudioClipAtTick,
  duplicateAudioClip,
  updateAudioClip,
  crossfadeAudioClips,
  nudgeClips,
  slipAudioClip,
  stretchAudioClip,
  toggleAudioClipsMute,
  buildClipClipboard,
  pasteClips,
  duplicateClips,
  cutClips,
  deleteAudioClip,
  groupClips,
  ungroupClips,
  setClipsLocked,
} from "../src/commands/commands";
import { normalizeProject, ticksPerBar } from "../src/project-model/schema";
import { audioClipDurationSec } from "../src/commands/audioClips";
import { audioClipSourceSecondsPerWallSecond } from "../src/project-model/audio-clip-warp";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { snapBarToTargets } from "../src/ui/snap";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE CLIP EDIT MATRIX.
 *
 * The audit's question is not "does the button move the clip" — it is "what
 * ELSE did that verb change, and can the user get it back".
 *
 * So every operation in the matrix is checked on THREE axes:
 *
 *   1. PROPERTY ISOLATION — the verb changes the fields it is supposed to
 *      change and NOTHING ELSE. A move that also rewrites the gain is a bug
 *      even though the clip looks right.
 *   2. UNDO / REDO — the document comes back EXACTLY (deep equality) and the
 *      redo re-applies exactly. One gesture, one history entry.
 *   3. PERSISTENCE — the edited clip survives a save/load round trip with the
 *      same position, length, source offset, fades, gain, mute and loop state.
 *
 * The short-clip column matters: the document model accepts any POSITIVE clip
 * length (a split fragment can be a fraction of a bar), but the command layer
 * used to carry a 0.25-bar UI floor. A floor in a command is a floor the user
 * feels: a verb that was asked to leave the length alone changes it anyway.
 */

/** The fields an edit can touch. Anything not listed cannot change at all. */
const WATCHED = [
  "startBar",
  "lengthBars",
  "offsetSec",
  "trimStart",
  "trimEnd",
  "gain",
  "fadeIn",
  "fadeOut",
  "stretchRate",
  "stretchMode",
  "pitchSemitones",
  "reverse",
  "loop",
  "loopPhaseOffsetSec",
  "muted",
  "fadeCurve",
  "bufferId",
] as const;

type Watched = (typeof WATCHED)[number];

function snapshotFields(clip: AudioClip): Record<Watched, unknown> {
  const out = {} as Record<Watched, unknown>;
  for (const field of WATCHED) out[field] = (clip as unknown as Record<string, unknown>)[field];
  return out;
}

/** Which watched fields differ between two clips. */
function changedFields(before: AudioClip, after: AudioClip): Watched[] {
  const a = snapshotFields(before);
  const b = snapshotFields(after);
  return WATCHED.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

const clipOf = (doc: ProjectDocument, id: string): AudioClip => doc.arrangement.audioClips!.find((c) => c.id === id)!;

/** A store with one audio clip on the first track. */
function storeWithClip(patch: NonNullable<Parameters<typeof addAudioClip>[5]> = {}): {
  store: ProjectStore;
  clipId: string;
} {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4, patch));
  return { store, clipId: store.doc.arrangement.audioClips![0]!.id };
}

/** The save/load round trip: JSON on disk, then the loader's normalizer. */
function persistRoundTrip(doc: ProjectDocument): ProjectDocument {
  return normalizeProject(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
}

/**
 * The three axes every operation must pass.
 *
 * `expectedChanged` is the set of fields the verb is allowed to touch. It is
 * an ALLOW-list, not a description of what happens: an unexpected field in
 * the diff fails the test.
 *
 * `beforeDoc` is the document as it stood BEFORE the edit — the undo has to
 * land there exactly.
 */
function expectEditIsSound(
  store: ProjectStore,
  clipId: string,
  beforeDoc: ProjectDocument,
  expectedChanged: Watched[],
  label: string,
): void {
  const before = beforeDoc.arrangement.audioClips!.find((c) => c.id === clipId)!;
  const after = clipOf(store.doc, clipId);
  const changed = changedFields(before, after);
  expect(
    changed.filter((f) => !expectedChanged.includes(f)),
    `${label}: the edit touched a field the verb does not own`,
  ).toEqual([]);

  // Undo restores the document EXACTLY.
  const afterEdit = JSON.stringify(store.doc);
  store.undo();
  expect(JSON.stringify(store.doc), `${label}: undo did not restore the exact document`).toBe(
    JSON.stringify(beforeDoc),
  );
  // Redo re-applies exactly.
  store.redo();
  expect(JSON.stringify(store.doc), `${label}: redo did not re-apply the exact document`).toBe(afterEdit);

  // The edit survives a save/load round trip.
  const restored = persistRoundTrip(store.doc);
  const restoredClip = restored.arrangement.audioClips!.find((c) => c.id === clipId);
  expect(restoredClip, `${label}: the clip did not survive persistence`).toBeDefined();
  expect(changedFields(clipOf(store.doc, clipId), restoredClip!), `${label}: persistence changed the clip`).toEqual([]);
}

/** The id of the clip that a command ADDED (the one that was not there before). */
function addedClipId(before: ProjectDocument, after: ProjectDocument): string {
  const beforeIds = new Set((before.arrangement.audioClips ?? []).map((c) => c.id));
  const added = (after.arrangement.audioClips ?? []).filter((c) => !beforeIds.has(c.id));
  expect(added, "the command must add exactly one clip").toHaveLength(1);
  return added[0]!.id;
}

describe("the clip edit matrix — property isolation", () => {
  it("move changes the position and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2, fadeOut: 0.3, reverse: true });
    const beforeDoc = store.doc;
    store.execute(moveAudioClip(store.doc, clipId, 2.5));
    expect(clipOf(store.doc, clipId).startBar).toBe(2.5);
    expectEditIsSound(store, clipId, beforeDoc, ["startBar"], "move");
  });

  it("resize changes the length and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2, offsetSec: 1.25 });
    const beforeDoc = store.doc;
    store.execute(resizeAudioClip(store.doc, clipId, 2));
    expect(clipOf(store.doc, clipId).lengthBars).toBe(2);
    expectEditIsSound(store, clipId, beforeDoc, ["lengthBars", "fadeIn", "fadeOut"], "resize");
  });

  it("slip changes the source offset and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2 });
    const beforeDoc = store.doc;
    store.execute(slipAudioClip(store.doc, clipId, 1.25));
    expect(clipOf(store.doc, clipId).offsetSec).toBe(1.25);
    expectEditIsSound(store, clipId, beforeDoc, ["offsetSec"], "slip");
  });

  it("mute changes the mute flag and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2 });
    const beforeDoc = store.doc;
    store.execute(toggleAudioClipsMute(store.doc, [clipId])!);
    expect(clipOf(store.doc, clipId).muted).toBe(true);
    expectEditIsSound(store, clipId, beforeDoc, ["muted"], "mute");
  });

  it("stretch changes the length and the rate and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, offsetSec: 1.25 });
    const beforeDoc = store.doc;
    store.execute(stretchAudioClip(store.doc, clipId, 8, 0.5));
    const clip = clipOf(store.doc, clipId);
    expect(clip.lengthBars).toBe(8);
    expect(clip.stretchRate).toBe(0.5);
    expectEditIsSound(store, clipId, beforeDoc, ["lengthBars", "stretchRate", "fadeIn", "fadeOut"], "stretch");
  });

  it("gain changes the gain and nothing else", () => {
    const { store, clipId } = storeWithClip({ fadeIn: 0.2 });
    const beforeDoc = store.doc;
    store.execute(updateAudioClip(store.doc, clipId, { gain: 0.25 }));
    expect(clipOf(store.doc, clipId).gain).toBe(0.25);
    expectEditIsSound(store, clipId, beforeDoc, ["gain"], "gain");
  });

  it("a fade changes the fade and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5 });
    const beforeDoc = store.doc;
    store.execute(updateAudioClip(store.doc, clipId, { fadeIn: 0.4, fadeOut: 0.6 }));
    const clip = clipOf(store.doc, clipId);
    expect(clip.fadeIn).toBe(0.4);
    expect(clip.fadeOut).toBe(0.6);
    expectEditIsSound(store, clipId, beforeDoc, ["fadeIn", "fadeOut"], "fade");
  });

  it("reverse changes the flag and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5 });
    const beforeDoc = store.doc;
    store.execute(updateAudioClip(store.doc, clipId, { reverse: true }));
    expect(clipOf(store.doc, clipId).reverse).toBe(true);
    expectEditIsSound(store, clipId, beforeDoc, ["reverse"], "reverse");
  });

  it("a nudge changes the position and nothing else", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2 });
    const beforeDoc = store.doc;
    store.execute(nudgeClips(store.doc, [clipId], 0.25));
    expect(clipOf(store.doc, clipId).startBar).toBe(0.25);
    expectEditIsSound(store, clipId, beforeDoc, ["startBar"], "nudge");
  });
});

describe("the clip edit matrix — a trim keeps the source window coherent", () => {
  it("trimming the head moves the start, shortens the clip and advances the source once", () => {
    const { store, clipId } = storeWithClip();
    const before = clipOf(store.doc, clipId);
    const wallSec = audioClipDurationSec(store.doc, 1, before.startBar);
    const sourceDelta = wallSec * audioClipSourceSecondsPerWallSecond(before);
    store.execute(
      trimAudioClipStart(store.doc, clipId, {
        startBar: before.startBar + 1,
        lengthBars: before.lengthBars - 1,
        trimStart: before.trimStart,
        offsetSec: before.offsetSec + sourceDelta,
      }),
    );
    const after = clipOf(store.doc, clipId);
    expect(after.startBar).toBe(1);
    expect(after.lengthBars).toBe(3);
    expect(after.offsetSec).toBeCloseTo(sourceDelta, 6);
    expect(after.trimStart, "the trim must not advance the trim window as well").toBe(before.trimStart);
  });

  it("trimming the head does not change the clip's END edge", () => {
    const { store, clipId } = storeWithClip();
    const before = clipOf(store.doc, clipId);
    const endBefore = before.startBar + before.lengthBars;
    store.execute(
      trimAudioClipStart(store.doc, clipId, {
        startBar: before.startBar + 1,
        lengthBars: before.lengthBars - 1,
        trimStart: before.trimStart,
        offsetSec: before.offsetSec + 1,
      }),
    );
    const after = clipOf(store.doc, clipId);
    expect(after.startBar + after.lengthBars).toBeCloseTo(endBefore, 6);
  });

  it("a trim past the file's start is refused", () => {
    const { store, clipId } = storeWithClip();
    expect(() =>
      store.execute(
        trimAudioClipStart(store.doc, clipId, {
          startBar: 0,
          lengthBars: 4,
          trimStart: 0,
          offsetSec: -1,
        }),
      ),
    ).toThrow(/before the file starts/);
  });
});

describe("the clip edit matrix — split", () => {
  it("a split produces two fragments that tile the original's source", () => {
    const { store, clipId } = storeWithClip();
    const before = clipOf(store.doc, clipId);
    const unit = ticksPerBar(store.doc);
    store.execute(splitAudioClipAtTick(store.doc, clipId, before.startBar * unit + 2 * unit));
    const clips = store.doc.arrangement.audioClips!;
    expect(clips).toHaveLength(2);
    const left = clips[0]!;
    const right = clips[1]!;
    expect(left.startBar).toBe(before.startBar);
    expect(right.startBar).toBe(before.startBar + 2);
    expect(left.lengthBars + right.lengthBars).toBeCloseTo(before.lengthBars, 6);
    // The right fragment's source continues where the left one stopped.
    expect(right.offsetSec).toBeGreaterThan(left.offsetSec);
    // Both fragments are playable.
    for (const clip of clips) {
      expect(Number.isFinite(clip.offsetSec)).toBe(true);
      expect(clip.lengthBars).toBeGreaterThan(0);
    }
  });

  it("a split does not change the material it did not touch", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, reverse: true });
    const before = clipOf(store.doc, clipId);
    const unit = ticksPerBar(store.doc);
    store.execute(splitAudioClipAtTick(store.doc, clipId, before.startBar * unit + 2 * unit));
    for (const clip of store.doc.arrangement.audioClips!) {
      expect(clip.gain, "a split must not change the gain").toBe(0.5);
      expect(clip.reverse, "a split must not change the direction").toBe(true);
      expect(clip.bufferId).toBe(before.bufferId);
    }
  });

  it("a repeated split keeps the fragments' source windows contiguous", () => {
    const { store, clipId } = storeWithClip();
    const unit = ticksPerBar(store.doc);
    store.execute(splitAudioClipAtTick(store.doc, clipId, 2 * unit));
    const middle = store.doc.arrangement.audioClips!.find((c) => c.startBar === 2)!;
    store.execute(splitAudioClipAtTick(store.doc, middle.id, 3 * unit));
    const clips = [...store.doc.arrangement.audioClips!].sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(3);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]!.offsetSec, `fragment ${i} must continue where fragment ${i - 1} stopped`).toBeGreaterThan(
        clips[i - 1]!.offsetSec,
      );
      expect(clips[i]!.startBar).toBeCloseTo(clips[i - 1]!.startBar + clips[i - 1]!.lengthBars, 6);
    }
  });
});

describe("the clip edit matrix — copy / duplicate / paste", () => {
  it("a duplicate carries every property of its original", () => {
    const { store, clipId } = storeWithClip({
      gain: 0.5,
      fadeIn: 0.3,
      fadeOut: 0.4,
      reverse: true,
      loop: true,
      offsetSec: 1.5,
      trimStart: 0.25,
      trimEnd: 0.5,
      stretchRate: 1.5,
      pitchSemitones: 3,
      fadeCurve: "equal",
    });
    const original = clipOf(store.doc, clipId);
    const beforeDoc = store.doc;
    store.execute(duplicateAudioClip(store.doc, clipId));
    const copy = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(copy.id, "a duplicate must get its own id").not.toBe(original.id);
    expect(copy.lengthBars).toBe(original.lengthBars);
    expect(copy.offsetSec).toBe(original.offsetSec);
    expect(copy.trimStart).toBe(original.trimStart);
    expect(copy.trimEnd).toBe(original.trimEnd);
    expect(copy.gain).toBe(original.gain);
    expect(copy.fadeIn).toBe(original.fadeIn);
    expect(copy.fadeOut).toBe(original.fadeOut);
    expect(copy.stretchRate).toBe(original.stretchRate);
    expect(copy.pitchSemitones).toBe(original.pitchSemitones);
    expect(copy.reverse).toBe(original.reverse);
    expect(copy.loop).toBe(original.loop);
    expect(copy.fadeCurve).toBe(original.fadeCurve);
    expect(copy.bufferId).toBe(original.bufferId);
  });

  it("a duplicate does not share mutable state with its original", () => {
    const { store, clipId } = storeWithClip();
    const original = clipOf(store.doc, clipId);
    const beforeDoc = store.doc;
    store.execute(duplicateAudioClip(store.doc, clipId));
    const copy = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    store.execute(updateAudioClip(store.doc, copy.id, { gain: 0.25 }));
    expect(clipOf(store.doc, original.id).gain, "editing a copy changed the original").toBe(1);
  });

  it("a pasted clip carries every property of its source", () => {
    const { store, clipId } = storeWithClip({
      gain: 0.5,
      fadeIn: 0.3,
      fadeOut: 0.4,
      reverse: true,
      loop: true,
      offsetSec: 1.5,
      trimStart: 0.25,
      trimEnd: 0.5,
      stretchRate: 1.5,
      pitchSemitones: 3,
      fadeCurve: "equal",
    });
    const original = clipOf(store.doc, clipId);
    const clipboard = buildClipClipboard(store.doc, [clipId])!;
    const beforeDoc = store.doc;
    store.execute(pasteClips(store.doc, clipboard, 8 * ticksPerBar(store.doc)));
    const pasted = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(pasted.id).not.toBe(original.id);
    expect(pasted.lengthBars).toBe(original.lengthBars);
    expect(pasted.offsetSec).toBe(original.offsetSec);
    expect(pasted.trimStart).toBe(original.trimStart);
    expect(pasted.trimEnd).toBe(original.trimEnd);
    expect(pasted.gain).toBe(original.gain);
    expect(pasted.fadeIn).toBe(original.fadeIn);
    expect(pasted.fadeOut).toBe(original.fadeOut);
    expect(pasted.stretchRate).toBe(original.stretchRate);
    expect(pasted.pitchSemitones).toBe(original.pitchSemitones);
    expect(pasted.reverse).toBe(original.reverse);
    expect(pasted.loop).toBe(original.loop);
    expect(pasted.fadeCurve).toBe(original.fadeCurve);
    expect(pasted.bufferId).toBe(original.bufferId);
  });

  it("the mixed-selection duplicate carries every property too", () => {
    const { store, clipId } = storeWithClip({
      gain: 0.5,
      fadeIn: 0.3,
      fadeOut: 0.4,
      reverse: true,
      loop: true,
      offsetSec: 1.5,
      trimStart: 0.25,
      trimEnd: 0.5,
      stretchRate: 1.5,
      pitchSemitones: 3,
      fadeCurve: "equal",
    });
    const original = clipOf(store.doc, clipId);
    const beforeDoc = store.doc;
    store.execute(duplicateClips(store.doc, [clipId])!);
    const copy = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(copy.lengthBars).toBe(original.lengthBars);
    expect(copy.offsetSec).toBe(original.offsetSec);
    expect(copy.trimStart).toBe(original.trimStart);
    expect(copy.trimEnd).toBe(original.trimEnd);
    expect(copy.gain).toBe(original.gain);
    expect(copy.fadeIn).toBe(original.fadeIn);
    expect(copy.fadeOut).toBe(original.fadeOut);
    expect(copy.stretchRate).toBe(original.stretchRate);
    expect(copy.pitchSemitones).toBe(original.pitchSemitones);
    expect(copy.reverse).toBe(original.reverse);
    expect(copy.loop).toBe(original.loop);
    expect(copy.fadeCurve).toBe(original.fadeCurve);
    expect(copy.bufferId).toBe(original.bufferId);
  });

  it("a cut removes the clip and a paste brings it back with its properties", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.3, reverse: true });
    const original = clipOf(store.doc, clipId);
    const clipboard = buildClipClipboard(store.doc, [clipId])!;
    store.execute(cutClips(store.doc, [clipId]));
    expect((store.doc.arrangement.audioClips ?? []).some((c) => c.id === clipId)).toBe(false);
    const beforePaste = store.doc;
    store.execute(pasteClips(store.doc, clipboard, 8 * ticksPerBar(store.doc)));
    const pasted = clipOf(store.doc, addedClipId(beforePaste, store.doc));
    expect(pasted.gain).toBe(original.gain);
    expect(pasted.fadeIn).toBe(original.fadeIn);
    expect(pasted.reverse).toBe(original.reverse);
  });
});

describe("the clip edit matrix — a legal short clip is not silently lengthened", () => {
  /**
   * The document model accepts any POSITIVE clip length: a split fragment can
   * be a fraction of a bar, and a recorded comp fragment can be shorter than
   * the UI's 0.25-bar floor. A command that carries the floor as a CLAMP
   * changes a length the user never asked to change.
   */
  function storeWithShortFragment(): { store: ProjectStore; fragmentId: string } {
    const { store, clipId } = storeWithClip();
    store.execute(splitAudioClipAtTick(store.doc, clipId, 0.05 * ticksPerBar(store.doc)));
    const fragment = store.doc.arrangement.audioClips!.find((c) => c.lengthBars < 0.25)!;
    expect(fragment, "the fixture must produce a fragment below the UI floor").toBeDefined();
    return { store, fragmentId: fragment.id };
  }

  it("the model accepts a sub-floor fragment at all", () => {
    const { store, fragmentId } = storeWithShortFragment();
    expect(clipOf(store.doc, fragmentId).lengthBars).toBeLessThan(0.25);
    const restored = persistRoundTrip(store.doc);
    expect(restored.arrangement.audioClips!.find((c) => c.id === fragmentId)).toBeDefined();
  });

  it("a resize that asks for the SAME length does not change it", () => {
    const { store, fragmentId } = storeWithShortFragment();
    const before = clipOf(store.doc, fragmentId).lengthBars;
    store.execute(resizeAudioClip(store.doc, fragmentId, before));
    expect(clipOf(store.doc, fragmentId).lengthBars, "a no-op resize changed the length").toBe(before);
  });

  it("a trim that asks for the SAME length does not change it", () => {
    const { store, fragmentId } = storeWithShortFragment();
    const clip = clipOf(store.doc, fragmentId);
    store.execute(
      trimAudioClipStart(store.doc, fragmentId, {
        startBar: clip.startBar,
        lengthBars: clip.lengthBars,
        trimStart: clip.trimStart,
        offsetSec: clip.offsetSec,
      }),
    );
    expect(clipOf(store.doc, fragmentId).lengthBars, "a no-op trim changed the length").toBe(clip.lengthBars);
  });

  it("a duplicate keeps the fragment's length", () => {
    const { store, fragmentId } = storeWithShortFragment();
    const before = clipOf(store.doc, fragmentId).lengthBars;
    const beforeDoc = store.doc;
    store.execute(duplicateAudioClip(store.doc, fragmentId));
    const copy = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(copy.lengthBars, "the duplicate changed the fragment's length").toBe(before);
  });

  it("the mixed-selection duplicate keeps the fragment's length", () => {
    const { store, fragmentId } = storeWithShortFragment();
    const before = clipOf(store.doc, fragmentId).lengthBars;
    const beforeDoc = store.doc;
    store.execute(duplicateClips(store.doc, [fragmentId])!);
    const copy = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(copy.lengthBars, "the duplicate changed the fragment's length").toBe(before);
  });

  it("a paste keeps the fragment's length", () => {
    const { store, fragmentId } = storeWithShortFragment();
    const before = clipOf(store.doc, fragmentId).lengthBars;
    const clipboard = buildClipClipboard(store.doc, [fragmentId])!;
    const beforeDoc = store.doc;
    store.execute(pasteClips(store.doc, clipboard, 20 * ticksPerBar(store.doc)));
    const pasted = clipOf(store.doc, addedClipId(beforeDoc, store.doc));
    expect(pasted.lengthBars, "the paste changed the fragment's length").toBe(before);
  });
});

describe("the clip edit matrix — edge cases", () => {
  it("a NaN position does not poison the document", () => {
    const { store, clipId } = storeWithClip();
    store.execute(moveAudioClip(store.doc, clipId, Number.NaN));
    const clip = clipOf(store.doc, clipId);
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(Number.isFinite(clip.lengthBars)).toBe(true);
  });

  it("a negative position clamps to the timeline start", () => {
    const { store, clipId } = storeWithClip();
    store.execute(moveAudioClip(store.doc, clipId, -5));
    expect(clipOf(store.doc, clipId).startBar).toBe(0);
  });

  it("a huge position stays inside the model", () => {
    const { store, clipId } = storeWithClip();
    store.execute(moveAudioClip(store.doc, clipId, 1e12));
    const clip = clipOf(store.doc, clipId);
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(clip.startBar).toBeGreaterThanOrEqual(0);
  });

  it("a zero-length resize keeps a playable clip", () => {
    const { store, clipId } = storeWithClip();
    store.execute(resizeAudioClip(store.doc, clipId, 0));
    const clip = clipOf(store.doc, clipId);
    expect(clip.lengthBars).toBeGreaterThan(0);
    expect(Number.isFinite(clip.lengthBars)).toBe(true);
  });

  it("a fade longer than the clip is bounded by the clip", () => {
    const { store, clipId } = storeWithClip();
    store.execute(updateAudioClip(store.doc, clipId, { fadeIn: 999, fadeOut: 999 }));
    const clip = clipOf(store.doc, clipId);
    const dur = audioClipDurationSec(store.doc, clip.lengthBars, clip.startBar);
    expect(clip.fadeIn).toBeLessThanOrEqual(dur + 1e-6);
    expect(clip.fadeOut).toBeLessThanOrEqual(dur + 1e-6);
  });

  it("deleting a clip leaves no reference to it behind", () => {
    const { store, clipId } = storeWithClip();
    store.execute(deleteAudioClip(store.doc, clipId));
    expect((store.doc.arrangement.audioClips ?? []).some((c) => c.id === clipId)).toBe(false);
    const restored = persistRoundTrip(store.doc);
    expect((restored.arrangement.audioClips ?? []).some((c) => c.id === clipId)).toBe(false);
  });

  it("a rapid burst of edits keeps the document valid and fully reversible", () => {
    const { store, clipId } = storeWithClip();
    const beforeBurst = JSON.stringify(store.doc);
    const snapshots: string[] = [];
    for (let i = 0; i < 12; i++) {
      store.execute(moveAudioClip(store.doc, clipId, i + 1));
      snapshots.push(JSON.stringify(store.doc));
      store.execute(resizeAudioClip(store.doc, clipId, 2 + (i % 5)));
      snapshots.push(JSON.stringify(store.doc));
      store.execute(updateAudioClip(store.doc, clipId, { gain: 0.5 + i * 0.01 }));
      snapshots.push(JSON.stringify(store.doc));
      const clip = clipOf(store.doc, clipId);
      expect(Number.isFinite(clip.startBar)).toBe(true);
      expect(Number.isFinite(clip.lengthBars)).toBe(true);
      expect(clip.lengthBars).toBeGreaterThan(0);
    }
    // One command, one history entry: undoing N times walks the states back
    // one command at a time, and the last undo lands on the pre-burst doc.
    for (let i = snapshots.length - 1; i > 0; i--) {
      store.undo();
      expect(JSON.stringify(store.doc), `undo to state ${i - 1}`).toBe(snapshots[i - 1]!);
    }
    store.undo();
    expect(JSON.stringify(store.doc), "the last undo must land on the pre-burst document").toBe(beforeBurst);
    for (let i = 0; i < snapshots.length; i++) {
      store.redo();
      expect(JSON.stringify(store.doc), `redo ${i + 1}`).toBe(snapshots[i]!);
    }
  });
});

describe("the clip edit matrix — lock", () => {
  it("a locked clip refuses every GEOMETRY verb", () => {
    const { store, clipId } = storeWithClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    expect(clipOf(store.doc, clipId).locked).toBe(true);
    expect(() => store.execute(moveAudioClip(store.doc, clipId, 1))).toThrow(/locked/);
    expect(() => store.execute(resizeAudioClip(store.doc, clipId, 2))).toThrow(/locked/);
    expect(() => store.execute(deleteAudioClip(store.doc, clipId))).toThrow(/locked/);
    expect(() => store.execute(splitAudioClipAtTick(store.doc, clipId, ticksPerBar(store.doc)))).toThrow(/locked/);
    expect(() => store.execute(slipAudioClip(store.doc, clipId, 1))).toThrow(/locked/);
    expect(() => store.execute(stretchAudioClip(store.doc, clipId, 8, 0.5))).toThrow(/locked/);
    expect(() =>
      store.execute(trimAudioClipStart(store.doc, clipId, { startBar: 1, lengthBars: 3, trimStart: 0, offsetSec: 1 })),
    ).toThrow(/locked/);
    // The refused verbs changed nothing.
    expect(clipOf(store.doc, clipId).startBar).toBe(0);
    expect(clipOf(store.doc, clipId).lengthBars).toBe(4);
  });

  it("a locked clip is still MIXABLE — gain, fades and mute stay editable", () => {
    // The lock contract (§29) names the GEOMETRY verbs only: a locked clip
    // must stay mixable, or a locked take could never be rebalanced.
    const { store, clipId } = storeWithClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    store.execute(updateAudioClip(store.doc, clipId, { gain: 0.5 }));
    expect(clipOf(store.doc, clipId).gain).toBe(0.5);
    store.execute(updateAudioClip(store.doc, clipId, { fadeIn: 0.25 }));
    expect(clipOf(store.doc, clipId).fadeIn).toBe(0.25);
    store.execute(toggleAudioClipsMute(store.doc, [clipId])!);
    expect(clipOf(store.doc, clipId).muted).toBe(true);
  });

  it("a locked clip refuses a source-position patch", () => {
    const { store, clipId } = storeWithClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    expect(() => store.execute(updateAudioClip(store.doc, clipId, { offsetSec: 1 }))).toThrow(/locked/);
    expect(() => store.execute(updateAudioClip(store.doc, clipId, { trimStart: 0.5 }))).toThrow(/locked/);
    expect(() => store.execute(updateAudioClip(store.doc, clipId, { stretchRate: 2 }))).toThrow(/locked/);
  });

  it("locking touches nothing but the lock flag", () => {
    const { store, clipId } = storeWithClip({ gain: 0.5, fadeIn: 0.2, reverse: true });
    const beforeDoc = store.doc;
    const before = clipOf(beforeDoc, clipId);
    store.execute(setClipsLocked(store.doc, [clipId], true));
    const changed = changedFields(before, clipOf(store.doc, clipId));
    expect(changed).toEqual([]);
    expect(clipOf(store.doc, clipId).locked).toBe(true);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("unlocking restores editability", () => {
    const { store, clipId } = storeWithClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    store.execute(setClipsLocked(store.doc, [clipId], false));
    expect(clipOf(store.doc, clipId).locked).toBeFalsy();
    store.execute(moveAudioClip(store.doc, clipId, 1));
    expect(clipOf(store.doc, clipId).startBar).toBe(1);
  });

  it("the lock survives persistence", () => {
    const { store, clipId } = storeWithClip();
    store.execute(setClipsLocked(store.doc, [clipId], true));
    const restored = persistRoundTrip(store.doc);
    expect(restored.arrangement.audioClips!.find((c) => c.id === clipId)!.locked).toBe(true);
  });
});

describe("the clip edit matrix — group and ungroup", () => {
  function twoClips(): { store: ProjectStore; firstId: string; secondId: string } {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4, { gain: 0.5 }));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.snare", 4, 4, { gain: 0.75 }));
    const clips = store.doc.arrangement.audioClips!;
    return { store, firstId: clips[0]!.id, secondId: clips[1]!.id };
  }

  it("grouping changes no property of the grouped clips", () => {
    const { store, firstId, secondId } = twoClips();
    const beforeFirst = { ...clipOf(store.doc, firstId) };
    const beforeSecond = { ...clipOf(store.doc, secondId) };
    store.execute(groupClips(store.doc, [firstId, secondId], "duo"));
    expect(changedFields(beforeFirst, clipOf(store.doc, firstId))).toEqual([]);
    expect(changedFields(beforeSecond, clipOf(store.doc, secondId))).toEqual([]);
    expect(store.doc.arrangement.clipGroups?.some((g) => g.clipIds.includes(firstId))).toBe(true);
  });

  it("ungrouping leaves the clips exactly as they were", () => {
    const { store, firstId, secondId } = twoClips();
    store.execute(groupClips(store.doc, [firstId, secondId], "duo"));
    const beforeDoc = store.doc;
    store.execute(ungroupClips(store.doc, [firstId, secondId]));
    expect(store.doc.arrangement.clipGroups ?? []).toHaveLength(0);
    expect(changedFields(clipOf(beforeDoc, firstId), clipOf(store.doc, firstId))).toEqual([]);
    expect(changedFields(clipOf(beforeDoc, secondId), clipOf(store.doc, secondId))).toEqual([]);
  });

  it("grouping is reversible", () => {
    const { store, firstId, secondId } = twoClips();
    const beforeDoc = store.doc;
    store.execute(groupClips(store.doc, [firstId, secondId], "duo"));
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
    store.redo();
    expect(store.doc.arrangement.clipGroups?.length).toBe(1);
  });

  it("a group that falls below two members dies with the clip", () => {
    const { store, firstId, secondId } = twoClips();
    store.execute(groupClips(store.doc, [firstId, secondId], "duo"));
    store.execute(deleteAudioClip(store.doc, firstId));
    expect(store.doc.arrangement.clipGroups ?? []).toHaveLength(0);
  });

  it("group membership survives persistence", () => {
    const { store, firstId, secondId } = twoClips();
    store.execute(groupClips(store.doc, [firstId, secondId], "duo"));
    const restored = persistRoundTrip(store.doc);
    expect(restored.arrangement.clipGroups?.length).toBe(1);
    expect(restored.arrangement.clipGroups?.[0]!.clipIds).toEqual([firstId, secondId]);
  });
});

describe("the clip edit matrix — overlap and layering", () => {
  it("two overlapping clips both stay and both play", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.snare", 2, 4));
    const ids = store.doc.arrangement.audioClips!.map((c) => c.id);
    expect(ids).toHaveLength(2);
    // The audio lane LAYERS: overlapping clips are summed, not swapped.
    expect(audioClipsForPlayback(store.doc.arrangement)).toHaveLength(2);
    const first = clipOf(store.doc, ids[0]!);
    const second = clipOf(store.doc, ids[1]!);
    expect(first.startBar + first.lengthBars).toBeGreaterThan(second.startBar);
  });

  it("moving a clip onto another does not displace or delete it", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.snare", 8, 4));
    const [first, second] = store.doc.arrangement.audioClips!;
    store.execute(moveAudioClip(store.doc, first!.id, 9));
    expect(store.doc.arrangement.audioClips).toHaveLength(2);
    expect(clipOf(store.doc, second!.id).startBar).toBe(8);
    expect(clipOf(store.doc, first!.id).startBar).toBe(9);
  });
});

describe("the clip edit matrix — multi-select edits", () => {
  it("a nudge moves every selected clip by the same delta", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.snare", 4, 4));
    const ids = store.doc.arrangement.audioClips!.map((c) => c.id);
    const beforeDoc = store.doc;
    store.execute(nudgeClips(store.doc, ids, 0.5));
    for (const id of ids) expect(clipOf(store.doc, id).startBar).toBeCloseTo(clipOf(beforeDoc, id).startBar + 0.5, 6);
    store.undo();
    expect(JSON.stringify(store.doc)).toBe(JSON.stringify(beforeDoc));
  });

  it("a multi-select edit is ONE history entry", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.snare", 4, 4));
    const ids = store.doc.arrangement.audioClips!.map((c) => c.id);
    const beforeDoc = store.doc;
    store.execute(nudgeClips(store.doc, ids, 0.5));
    store.undo();
    expect(JSON.stringify(store.doc), "one undo must undo the whole multi-select nudge").toBe(
      JSON.stringify(beforeDoc),
    );
  });
});

describe("the clip edit matrix — snapping", () => {
  it("a neighbouring edge within the pull threshold wins over the grid", () => {
    // The grid would put the clip on bar 2 (0.06 away); the neighbour's edge
    // is closer, so it wins — "snap my start to the neighbour".
    expect(snapBarToTargets(2.06, 1, [2.1], 0.2)).toBe(2.1);
  });

  it("a target outside the pull threshold does not win", () => {
    expect(snapBarToTargets(2.05, 1, [4], 0.2)).toBe(2);
  });

  it("with the grid off the pointer is free", () => {
    expect(snapBarToTargets(2.05, null, [2.125], 0.2)).toBe(2.05);
  });

  it("the grid is the default answer when nothing is closer", () => {
    expect(snapBarToTargets(2.4, 0.5, [8], 0.2)).toBe(2.5);
  });

  it("a MARKER is a snap target like any other edge", () => {
    // The panel feeds the marker ticks into the same target list as the
    // neighbouring clips' edges — one snap rule, one threshold.
    const markerBar = 3;
    expect(snapBarToTargets(3.06, 1, [markerBar], 0.2)).toBe(markerBar);
  });

  it("the playhead is a snap target too", () => {
    expect(snapBarToTargets(5.04, 1, [5], 0.2)).toBe(5);
  });
});

describe("the clip edit matrix — crossfade", () => {
  it("a crossfade writes a fade on each side of the overlap and nothing else", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 2, 4));
    const [earlier, later] = store.doc.arrangement.audioClips!;
    const beforeEarlier = { ...earlier! };
    const beforeLater = { ...later! };
    store.execute(crossfadeAudioClips(store.doc, earlier!.id, later!.id));
    const afterEarlier = clipOf(store.doc, earlier!.id);
    const afterLater = clipOf(store.doc, later!.id);
    expect(afterEarlier.fadeOut, "the earlier clip must fade out").toBeGreaterThan(0);
    expect(afterLater.fadeIn, "the later clip must fade in").toBeGreaterThan(0);
    expect(changedFields(beforeEarlier, afterEarlier).filter((f) => f !== "fadeOut" && f !== "fadeCurve")).toEqual([]);
    expect(changedFields(beforeLater, afterLater).filter((f) => f !== "fadeIn" && f !== "fadeCurve")).toEqual([]);
  });

  it("a crossfade of clips that do not overlap is refused", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 8, 4));
    const [a, b] = store.doc.arrangement.audioClips!;
    expect(() => store.execute(crossfadeAudioClips(store.doc, a!.id, b!.id))).toThrow(/do not overlap/);
  });
});
