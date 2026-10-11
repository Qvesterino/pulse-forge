import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAudioClip } from "../src/commands/audioClips";
import { setClipsLocked } from "../src/commands/clipGroups";
import {
  consolidateAudioClips,
  crossfadeAudioClips,
  fitAudioClipTempo,
  sliceAudioClipToArrangement,
  stripSilenceAudioClip,
  updateAudioClip,
} from "../src/commands/clipEditing";
import { moveAudioClip, resizeAudioClip, deleteAudioClip } from "../src/commands/audioClips";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * §29 LOCKING — "locked entities cannot be modified through drag, trim,
 * delete, keyboard shortcuts, context menus, multi-select actions, or ripple
 * edits. Lock semantics should be centralized and consistent."
 *
 * The contract itself is documented in `src/commands/clipGroups.ts`:
 *
 *   "Direct editing verbs (move/resize/trim/split/slip/stretch/delete) refuse
 *    locked clips; non-destructive verbs (mute, duplicate, selection) stay
 *    allowed."
 *
 * `assertClipEditable` is that contract's single choke point. This file pins
 * that EVERY verb the contract names actually routes through it — the defect
 * class here is not "the guard is missing" but "the guard exists in the
 * primitive verbs and was never added to the compound ones".
 *
 * Each test is a CONTRACT test, not a regression pin for a specific bug: the
 * verbs are enumerated from the contract text above, so a future verb added
 * to that enumeration must be added here too.
 */

function fixture(): { doc: ProjectDocument; trackId: string; a: AudioClip; b: AudioClip } {
  let doc = createProjectFromTemplate("house");
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addAudioClip(doc, trackId, "lock-buf", 0, 2, {}).execute(doc);
  // Overlapping on purpose: `crossfadeAudioClips` refuses non-overlapping
  // clips, so a packed fixture would make the crossfade assertions vacuous.
  doc = addAudioClip(doc, trackId, "lock-buf", 1, 2, {}).execute(doc);
  const clips = doc.arrangement.audioClips!;
  const a = clips[0]!;
  const b = clips[1]!;
  return { doc, trackId, a, b };
}

/** Same fixture with every clip locked. */
function lockedFixture(): { doc: ProjectDocument; trackId: string; a: AudioClip; b: AudioClip } {
  const f = fixture();
  const locked = setClipsLocked(f.doc, [f.a.id, f.b.id], true).execute(f.doc);
  return { ...f, doc: locked };
}

const REFUSES_LOCK = /locked/i;

describe("§29 clip lock — the verbs the contract names", () => {
  it("CONTROL: the primitive verbs refuse a locked clip (the guard works)", () => {
    const { doc, a } = lockedFixture();
    expect(() => moveAudioClip(doc, a.id, 8)).toThrow(REFUSES_LOCK);
    expect(() => resizeAudioClip(doc, a.id, 6)).toThrow(REFUSES_LOCK);
    expect(() => deleteAudioClip(doc, a.id)).toThrow(REFUSES_LOCK);
  });

  it("CONTROL: an UNLOCKED clip passes every verb (the refusals above are about the lock, not the args)", () => {
    const { doc, a, b } = fixture();
    expect(() => moveAudioClip(doc, a.id, 8)).not.toThrow();
    expect(() => resizeAudioClip(doc, a.id, 6)).not.toThrow();
    expect(() => sliceAudioClipToArrangement(doc, a.id, [0.5]).execute(doc)).not.toThrow();
    expect(() => stripSilenceAudioClip(doc, a.id, [{ startSec: 0, endSec: 1 }], 10).execute(doc)).not.toThrow();
    expect(() => fitAudioClipTempo(doc, a.id, 128).execute(doc)).not.toThrow();
    expect(() => consolidateAudioClips(doc, [a.id, b.id], "lock-buf").execute(doc)).not.toThrow();
    expect(() => crossfadeAudioClips(doc, a.id, b.id)).not.toThrow();
  });

  it("SLICE refuses a locked clip — it deletes the clip and writes fragments in its place", () => {
    const { doc, a } = lockedFixture();
    expect(() => sliceAudioClipToArrangement(doc, a.id, [0.5])).toThrow(REFUSES_LOCK);
  });

  it("STRIP SILENCE refuses a locked clip — it deletes the clip and writes segments in its place", () => {
    const { doc, a } = lockedFixture();
    expect(() => stripSilenceAudioClip(doc, a.id, [{ startSec: 0, endSec: 1 }], 10)).toThrow(REFUSES_LOCK);
  });

  it("CONSOLIDATE refuses when ANY selected clip is locked — it deletes them all", () => {
    const { doc, a, b } = lockedFixture();
    expect(() => consolidateAudioClips(doc, [a.id, b.id], "lock-buf")).toThrow(REFUSES_LOCK);
  });

  it("FIT TEMPO refuses a locked clip — stretch is a direct editing verb", () => {
    const { doc, a } = lockedFixture();
    expect(() => fitAudioClipTempo(doc, a.id, 128)).toThrow(REFUSES_LOCK);
  });

  it("the generic patch verb refuses SLIP/TRIM/STRETCH fields on a locked clip", () => {
    const { doc, a } = lockedFixture();
    expect(() => updateAudioClip(doc, a.id, { offsetSec: 1 })).toThrow(REFUSES_LOCK);
    expect(() => updateAudioClip(doc, a.id, { trimStart: 0.5 })).toThrow(REFUSES_LOCK);
    expect(() => updateAudioClip(doc, a.id, { stretchRate: 1.5 })).toThrow(REFUSES_LOCK);
  });

  it("the generic patch verb still allows NON-destructive fields on a locked clip", () => {
    const { doc, a } = lockedFixture();
    // mute is explicitly named as staying allowed; gain/fade/source props are
    // not in the contract's verb list, so they must not be blocked by it.
    expect(() => updateAudioClip(doc, a.id, { muted: true })).not.toThrow();
    expect(() => updateAudioClip(doc, a.id, { gain: 0.5 })).not.toThrow();
    expect(() => updateAudioClip(doc, a.id, { fadeIn: 0.2 })).not.toThrow();
  });

  it("a refusal never mutates the document", () => {
    const { doc, a } = lockedFixture();
    const before = doc;
    expect(() => stripSilenceAudioClip(doc, a.id, [{ startSec: 0, endSec: 1 }], 10)).toThrow();
    expect(doc, "commands are pure — a throw must leave the input doc untouched").toBe(before);
    expect(doc.arrangement.audioClips).toHaveLength(2);
  });
});
