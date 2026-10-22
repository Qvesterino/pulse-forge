import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAudioClip } from "../src/commands/commands";
import { sliceAudioClipToArrangement } from "../src/commands/clipEditing";
import { audioClipDurationSec } from "../src/commands/audioClips";
import { audioClipSourceSecondsPerWallSecond } from "../src/project-model/audio-clip-warp";
import { audioClipPlayWindow } from "../src/audio-engine/warpManager";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * A SLICE'S FRAGMENT MUST PLAY EXACTLY THE SEGMENT IT WAS CUT FROM.
 *
 * THE DEFECT (P2 — the slices overlapped audibly).
 *
 *   `sliceAudioClipToArrangement` built each fragment's SOURCE position from
 *   the segment's true start (`sourceStart + seg.startSec * sourcePerWall`) but
 *   its WALL LENGTH from `Math.max(0.25, segBars)` — a floor in BARS.
 *
 *   A segment shorter than the floor therefore produced a fragment LONGER than
 *   the segment: the fragment played past its own material, into the NEXT
 *   segment's, while its waveform showed one region. The slices overlapped
 *   audibly — two fragments sounding the same material at once — and the last
 *   fragment read past the end of the parent clip's own source.
 *
 *   `stripSilenceAudioClip` had the same shape with a 0.05-bar floor.
 *
 *   The document model accepts any positive clip length ON PURPOSE:
 *   "Recorded comp fragments can be shorter than the normal UI clip-size
 *   floor" (`sanitizeAudioClips`). The floor belonged to the UI's clip
 *   creation, not to a fragment that has to match its segment exactly.
 *
 * WHAT THIS TEST PINS.
 *
 *   Every fragment's playable source window is exactly its segment's source
 *   span, and the fragments tile the parent's source without overlapping.
 */

function docWithClip(): { doc: ProjectDocument; clipId: string } {
  const base = createProjectFromTemplate("house");
  const clip = addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 4).execute(base);
  return { doc: clip, clipId: clip.arrangement.audioClips![0]!.id };
}

const clipOf = (doc: ProjectDocument, id: string): AudioClip => doc.arrangement.audioClips!.find((c) => c.id === id)!;

/**
 * The source span a clip actually plays, in original-sample seconds.
 *
 * `audioClipPlayWindow` answers in PLAY-BUFFER seconds; for a resample clip
 * the play buffer IS the original, and its length is the requested duration
 * multiplied by the playback rate — so the original-sample span divides that
 * back out by the rate.
 */
function playedSpan(doc: ProjectDocument, clip: AudioClip): { start: number; end: number } {
  const requested = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
  const win = audioClipPlayWindow(clip, 1000, requested, 1);
  const rate = clip.stretchRate ?? 1;
  return { start: win.playOffset, end: win.playOffset + win.bufferDuration / rate };
}

describe("a slice's fragment plays exactly the segment it was cut from", () => {
  // The fragment lengths are TICK-ALIGNED, so two adjacent fragments can meet
  // with a half-tick of rounding between them. One tick is the model's own
  // precision; the defect this guards was three orders of magnitude larger
  // (a 0.25-BAR floor on a sub-bar segment).
  const TICK_SLACK_SEC = 0.002;

  it("the fragments tile the parent's source without overlapping", () => {
    const { doc, clipId } = docWithClip();

    // Slice at 0.4 s and 0.9 s: every segment is far below the old 0.25-bar
    // floor at this tempo, so the floor used to fire for all of them.
    const sliced = sliceAudioClipToArrangement(doc, clipId, [0.4, 0.9]).execute(doc);
    const fragments = sliced.arrangement.audioClips!.filter((c) => c.id !== clipId);
    expect(fragments.length).toBe(3);

    const spans = fragments.map((fragment) => playedSpan(sliced, fragment)).sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start, `fragment ${i} must not replay fragment ${i - 1}'s material`).toBeGreaterThanOrEqual(
        spans[i - 1]!.end - TICK_SLACK_SEC,
      );
    }
  });

  it("each fragment's wall length equals its segment's length", () => {
    const { doc, clipId } = docWithClip();
    const parent = clipOf(doc, clipId);
    const sourcePerWall = audioClipSourceSecondsPerWallSecond(parent);

    const sliced = sliceAudioClipToArrangement(doc, clipId, [0.4, 0.9]).execute(doc);
    const fragments = sliced.arrangement
      .audioClips!.filter((c) => c.id !== clipId)
      .sort((a, b) => a.startBar - b.startBar);

    // The parent plays four bars; the segments are 0.4 s, 0.5 s and the rest.
    const segmentWallSec = [0.4, 0.5, null];
    for (const [index, fragment] of fragments.entries()) {
      const span = playedSpan(sliced, fragment);
      const sourceSec = span.end - span.start;
      const wallSec = sourceSec / sourcePerWall;
      if (segmentWallSec[index] !== null) {
        expect(wallSec, `fragment ${index} must play exactly its segment`).toBeCloseTo(segmentWallSec[index]!, 2);
      }
    }
  });

  it("no fragment is longer than its own material", () => {
    const { doc, clipId } = docWithClip();
    const parent = clipOf(doc, clipId);
    const parentSpan = playedSpan(doc, parent);

    const sliced = sliceAudioClipToArrangement(doc, clipId, [0.4, 0.9]).execute(doc);
    const fragments = sliced.arrangement.audioClips!.filter((c) => c.id !== clipId);

    for (const fragment of fragments) {
      const span = playedSpan(sliced, fragment);
      expect(span.start, "a fragment must not start before the parent's source").toBeGreaterThanOrEqual(
        parentSpan.start - TICK_SLACK_SEC,
      );
      expect(span.end, "a fragment must not read past the parent's source").toBeLessThanOrEqual(
        parentSpan.end + TICK_SLACK_SEC,
      );
    }
  });
});
