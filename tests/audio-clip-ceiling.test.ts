import { describe, expect, it } from "vitest";
import { MAX_ARRANGEMENT_CLIP_BARS, normalizeProject } from "../src/project-model/schema";
import { resizeAudioClip, stretchAudioClip, addAudioClip } from "../src/commands/audioClips";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * AUDIO CLIP CEILING (audit 2026-10-19) — the worst defect this audit found,
 * because it is silent and unrecoverable.
 *
 * `sanitizeAudioClips` DROPS any clip longer than MAX_ARRANGEMENT_CLIP_BARS, and
 * `ProjectStore.applyCommand` runs `normalizeProject` after EVERY command. The
 * audio-clip commands clamped only the lower bound, so:
 *
 *     drag an audio clip past the limit
 *       → resizeAudioClip stores lengthBars = 20000
 *       → applyCommand normalizes
 *       → sanitizeAudioClips `continue`s past it
 *       → the clip is gone from the store: no error, no undo entry
 *
 * The scene-clip sibling (`resizeArrangementClip`, arrangement.ts:140) clamps
 * with the same expression and documents why. This file pins that the audio
 * half now holds the same invariant.
 */

function docWithClip(): { doc: ProjectDocument; clipId: string } {
  const base = testDoc();
  const track = base.tracks[0];
  if (!track) throw new Error("fixture has no track");
  const doc = addAudioClip(base, track.id, "buf-test", 0, 4, {}).execute(base);
  const clipId = doc.arrangement.audioClips?.[0]?.id;
  if (!clipId) throw new Error("fixture produced no audio clip");
  return { doc, clipId };
}

describe("audio clip ceiling — a resize must not delete the clip", () => {
  it("the normalizer really does drop an oversized clip (why the command must clamp)", () => {
    const { doc } = docWithClip();
    const oversized: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: (doc.arrangement.audioClips ?? []).map((clip) => ({ ...clip, lengthBars: 20000 })),
      },
    };
    // The precondition that made the bug destructive, measured: a document
    // value over the ceiling does not survive normalization — the clip is
    // DROPPED, silently. No error, no clamp, nothing to undo. That is why the
    // command has to refuse to write such a value in the first place.
    expect(oversized.arrangement.audioClips?.[0]?.lengthBars).toBe(20000);
    const normalized = normalizeProject(oversized);
    expect(normalized.arrangement.audioClips ?? []).toHaveLength(0);
  });

  it("resizeAudioClip clamps to the ceiling, so the clip survives the round-trip", () => {
    const { doc, clipId } = docWithClip();
    const resized = resizeAudioClip(doc, clipId, 20000).execute(doc);
    const clip = resized.arrangement.audioClips?.[0];
    expect(clip, "the clip must still exist after an oversized resize").toBeDefined();
    expect(clip!.lengthBars).toBe(MAX_ARRANGEMENT_CLIP_BARS);
    // And the clamp is load-bearing: normalize keeps exactly this clip.
    expect(normalizeProject(resized).arrangement.audioClips).toHaveLength(1);
  });

  it("stretchAudioClip clamps the same way", () => {
    const { doc, clipId } = docWithClip();
    const stretched = stretchAudioClip(doc, clipId, 50000, 2).execute(doc);
    const clip = stretched.arrangement.audioClips?.[0];
    expect(clip).toBeDefined();
    expect(clip!.lengthBars).toBe(MAX_ARRANGEMENT_CLIP_BARS);
    expect(normalizeProject(stretched).arrangement.audioClips).toHaveLength(1);
  });

  it("a normal resize is untouched — the clamp does not change ordinary behaviour", () => {
    const { doc, clipId } = docWithClip();
    const resized = resizeAudioClip(doc, clipId, 8).execute(doc);
    expect(resized.arrangement.audioClips?.[0]?.lengthBars).toBe(8);
  });

  it("the lower bound still holds (a resize can never shrink a clip to nothing)", () => {
    const { doc, clipId } = docWithClip();
    const resized = resizeAudioClip(doc, clipId, 0.01).execute(doc);
    expect(resized.arrangement.audioClips?.[0]?.lengthBars).toBeGreaterThanOrEqual(0.25);
  });
});
