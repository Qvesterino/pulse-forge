/**
 * INVARIANT: a clip's fade must never outlive the clip itself.
 *
 *   fadeIn  <= duration(clip)
 *   fadeOut <= duration(clip)
 *
 * A fade longer than its clip is not a cosmetic problem. The engine clamps it
 * audibly, so what the user HEARS and what the fade HANDLE shows diverge, and
 * the stored document contradicts itself. Three structural clip commands built
 * their fragments by spreading the parent clip (`...clip`) and overwriting only
 * `startBar` / `lengthBars`, so a long parent fade was inherited verbatim by a
 * fragment that can be orders of magnitude shorter.
 *
 * duration(clip) = lengthBars * BAR_TICKS * 60 / (bpm * PPQ)
 */
import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { BAR_TICKS, PPQ } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";
import {
  addAudioClip,
  sliceAudioClipToArrangement,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  updateAudioClip,
} from "../src/commands/commands";

/** Timeline duration of a clip in seconds — mirrors the command-layer formula. */
function clipDurationSec(doc: ProjectDocument, clip: AudioClip): number {
  return (clip.lengthBars * BAR_TICKS * 60) / (doc.bpm * PPQ);
}

/** Every clip in the doc must satisfy the fade-bounds invariant. */
function expectFadeBoundsHold(doc: ProjectDocument, context: string): void {
  for (const clip of doc.arrangement.audioClips ?? []) {
    const dur = clipDurationSec(doc, clip);
    expect(clip.fadeIn, `${context}: fadeIn on clip ${clip.id} (dur=${dur.toFixed(3)}s)`).toBeLessThanOrEqual(dur);
    expect(clip.fadeOut, `${context}: fadeOut on clip ${clip.id} (dur=${dur.toFixed(3)}s)`).toBeLessThanOrEqual(dur);
  }
}

/** An 8-bar clip (16s at the default 120 BPM) carrying a 4s fade-in. */
function docWithLongFade(): { doc: ProjectDocument; clipId: string; trackId: string } {
  const base = createDefaultProject();
  const trackId = base.tracks[0].id;
  const withClip = addAudioClip(base, trackId, "factory.kick", 0, 8).execute(base);
  const clipId = withClip.arrangement.audioClips![0].id;
  const doc = updateAudioClip(withClip, clipId, { fadeIn: 4, fadeOut: 3 }).execute(withClip);
  expect(doc.arrangement.audioClips![0].fadeIn).toBe(4);
  return { doc, clipId, trackId };
}

describe("clip fade-bounds invariant", () => {
  it("BASELINE: the parent clip satisfies the invariant before any edit", () => {
    const { doc } = docWithLongFade();
    expectFadeBoundsHold(doc, "baseline");
  });

  it("splitAudioClipAtTick: the LEFT fragment does not inherit a parent fade longer than itself", () => {
    const { doc, clipId } = docWithLongFade();
    // Split 0.1 bar in → left fragment is 0.2s, parent fadeIn is 4s.
    const splitTick = 0.1 * BAR_TICKS;
    const next = splitAudioClipAtTick(doc, clipId, splitTick).execute(doc);

    const left = next.arrangement.audioClips!.find((c) => c.startBar < 1)!;
    expect(left.lengthBars).toBeCloseTo(0.1, 6);
    const dur = clipDurationSec(next, left);
    expect(dur, "left fragment is genuinely tiny").toBeLessThan(0.5);
    // THE DEFECT: 4s fadeIn stored on a 0.2s clip.
    expect(left.fadeIn).toBeLessThanOrEqual(dur);
    expectFadeBoundsHold(next, "split/left");
  });

  it("splitAudioClipAtTick: the RIGHT fragment does not inherit a parent fade longer than itself", () => {
    const { doc, clipId } = docWithLongFade();
    // Split 0.1 bar from the end → right fragment is 0.2s, parent fadeOut is 3s.
    const endTick = 8 * BAR_TICKS;
    const splitTick = endTick - 0.1 * BAR_TICKS;
    const next = splitAudioClipAtTick(doc, clipId, splitTick).execute(doc);

    const right = next.arrangement.audioClips!.find((c) => c.startBar > 7)!;
    const dur = clipDurationSec(next, right);
    expect(dur, "right fragment is genuinely tiny").toBeLessThan(0.5);
    // THE DEFECT: 3s fadeOut stored on a 0.2s clip.
    expect(right.fadeOut).toBeLessThanOrEqual(dur);
    expectFadeBoundsHold(next, "split/right");
  });

  it("sliceAudioClipToArrangement: slices do not inherit a parent fade longer than themselves", () => {
    const { doc, clipId } = docWithLongFade();
    // Slice at 8s and 14s of a 16s clip → segments of 8s, 6s, 2s.
    const next = sliceAudioClipToArrangement(doc, clipId, [8, 14]).execute(doc);
    expect(next.arrangement.audioClips!.length).toBeGreaterThan(1);
    // THE DEFECT: every short slice carries the parent's 4s fadeIn / 3s fadeOut.
    expectFadeBoundsHold(next, "slice");
  });

  it("sliceAudioClipToArrangement: a sub-second slice cannot keep a multi-second fade", () => {
    const { doc, clipId } = docWithLongFade();
    // A tight pair of slices on a 16s clip: the first fragment is ~0.2s.
    const next = sliceAudioClipToArrangement(doc, clipId, [0.2, 8, 14]).execute(doc);
    const shortest = next.arrangement.audioClips!.reduce((a, b) =>
      clipDurationSec(next, a) <= clipDurationSec(next, b) ? a : b,
    );
    expect(clipDurationSec(next, shortest)).toBeLessThan(0.5);
    // THE DEFECT.
    expectFadeBoundsHold(next, "slice/tight");
  });

  it("stripSilenceAudioClip: stripped segments do not inherit a parent fade longer than themselves", () => {
    const { doc, clipId } = docWithLongFade();
    // A 0.1s non-silent blip inside a 16s clip.
    const next = stripSilenceAudioClip(doc, clipId, [
      { startSec: 0, endSec: 0.1 },
      { startSec: 15.9, endSec: 16 },
    ]).execute(doc);
    expect(next.arrangement.audioClips!.length).toBe(2);
    // THE DEFECT: 4s fadeIn + 3s fadeOut on ~0.1s clips.
    expectFadeBoundsHold(next, "stripSilence");
  });

  it("survives undo: undoing a split restores a doc that still satisfies the invariant", () => {
    const { doc, clipId } = docWithLongFade();
    const splitTick = 0.1 * BAR_TICKS;
    const command = splitAudioClipAtTick(doc, clipId, splitTick);
    const next = command.execute(doc);
    const undone = command.undo(next);
    expect(undone.arrangement.audioClips!.length).toBe(1);
    expectFadeBoundsHold(undone, "split/undo");
    expect(undone.arrangement.audioClips![0].fadeIn).toBe(4);
  });
});
