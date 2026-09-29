import { describe, it, expect } from "vitest";
import {
  addAudioClip,
  updateAudioClip,
  moveAudioClip,
  resizeAudioClip,
  duplicateAudioClip,
  deleteAudioClip,
  splitAudioClipAtTick,
  stretchAudioClip,
} from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIP EDITING INTERACTION AUDIT — focused edge cases over the audio clip
 * command layer. Every case probes a boundary from the editing-interaction
 * audit goal: NaN/invalid values, trim/fade boundaries, split integrity,
 * duplicate state isolation, undo/redo round-trips and persistence shape.
 */

import { BAR_TICKS } from "../src/project-model/types";

function docWithClip(overrides: Partial<AudioClip> = {}): { doc: ProjectDocument; clipId: string } {
  const doc = testDoc();
  const cmd = addAudioClip(doc, doc.tracks[0]!.id, "buf-audit", 4, 4, { gain: 1 });
  const next = cmd.execute(doc);
  const clip = (next.arrangement.audioClips ?? [])[0]!;
  const patched: ProjectDocument = {
    ...next,
    arrangement: {
      ...next.arrangement,
      audioClips: (next.arrangement.audioClips ?? []).map((c) => (c.id === clip.id ? { ...c, ...overrides } : c)),
    },
  };
  return { doc: patched, clipId: clip.id };
}

const clipOf = (doc: ProjectDocument, clipId: string): AudioClip =>
  (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId)!;

describe("audit: updateAudioClip NaN/invalid sanitization", () => {
  it("drops NaN/Infinity in every numeric field without poisoning the doc", () => {
    const { doc, clipId } = docWithClip({ gain: 1, trimStart: 0.5 });
    const before = JSON.stringify(clipOf(doc, clipId));
    const cmd = updateAudioClip(doc, clipId, {
      offsetSec: NaN,
      trimStart: Infinity,
      trimEnd: -5,
      gain: NaN,
      fadeIn: NaN,
      fadeOut: NaN,
      stretchRate: NaN,
    });
    const next = cmd.execute(doc);
    const clip = clipOf(next, clipId);
    // nothing changed — every field was rejected
    expect(JSON.stringify(clip)).toBe(before);
  });

  it("clamps gain to [0,2] and stretchRate to [0.25,4]", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, { gain: 99, stretchRate: 999 }).execute(doc);
    const clip = clipOf(next, clipId);
    expect(clip.gain).toBe(2);
    expect(clip.stretchRate).toBe(4);
    const next2 = updateAudioClip(next, clipId, { gain: -3, stretchRate: 0.001 }).execute(next);
    const clip2 = clipOf(next2, clipId);
    expect(clip2.gain).toBe(0);
    expect(clip2.stretchRate).toBe(0.25);
  });

  it("fade clamp respects the CURRENT clip duration, not a constant", () => {
    const { doc, clipId } = docWithClip();
    const durSec = (clipOf(doc, clipId).lengthBars * BAR_TICKS * 60) / (doc.bpm * 480);
    const next = updateAudioClip(doc, clipId, { fadeIn: 999, fadeOut: 999 }).execute(doc);
    const clip = clipOf(next, clipId);
    expect(clip.fadeIn).toBeCloseTo(durSec, 1);
    expect(clip.fadeOut).toBeCloseTo(durSec, 1);
  });

  it("reverse clears loopPhaseOffsetSec (reversed loop phase is meaningless)", () => {
    const { doc, clipId } = docWithClip({ loop: true, loopPhaseOffsetSec: 2.5 });
    const next = updateAudioClip(doc, clipId, { reverse: true }).execute(doc);
    const clip = clipOf(next, clipId);
    expect(clip.reverse).toBe(true);
    expect(clip.loopPhaseOffsetSec).toBeUndefined();
  });

  it("loop off also clears loopPhaseOffsetSec", () => {
    const { doc, clipId } = docWithClip({ loop: true, loopPhaseOffsetSec: 1.5 });
    const next = updateAudioClip(doc, clipId, { loop: false }).execute(doc);
    expect(clipOf(next, clipId).loop).toBe(false);
    expect(clipOf(next, clipId).loopPhaseOffsetSec).toBeUndefined();
  });
});

describe("audit: trim/offset integrity", () => {
  it("trim values clamp at 0 — negative trims never poison the doc", () => {
    const { doc, clipId } = docWithClip({ trimStart: 1 });
    const next = updateAudioClip(doc, clipId, { trimStart: -2 }).execute(doc);
    expect(clipOf(next, clipId).trimStart).toBe(0);
  });

  it("gain 0 silences without deleting; gain 2 is the ceiling", () => {
    const { doc, clipId } = docWithClip();
    const muted = updateAudioClip(doc, clipId, { gain: 0 }).execute(doc);
    expect(clipOf(muted, clipId).gain).toBe(0);
    expect((muted.arrangement.audioClips ?? []).length).toBeGreaterThan(0);
  });

  it("undo restores the exact pre-edit clip state", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 0.1, gain: 0.8, trimStart: 0.2 });
    const before = clipOf(doc, clipId);
    const cmd = updateAudioClip(doc, clipId, { gain: 1.5, fadeIn: 2, trimStart: 0.8 });
    const next = cmd.execute(doc);
    expect(clipOf(next, clipId).gain).toBe(1.5);
    const undone = cmd.undo(next);
    expect(clipOf(undone, clipId)).toEqual(before);
  });
});

describe("audit: move / resize / duplicate", () => {
  it("move clamps negative positions to 0 and no-ops on NaN", () => {
    const { doc, clipId } = docWithClip();
    const moved = moveAudioClip(doc, clipId, -5).execute(doc);
    expect(clipOf(moved, clipId).startBar).toBe(0);
    const nan = moveAudioClip(doc, clipId, NaN);
    const same = nan.execute(moved);
    expect(clipOf(same, clipId).startBar).toBe(clipOf(moved, clipId).startBar);
  });

  it("resize clamps to 0.25 min and clamps fades into the new duration", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 4, fadeOut: 4 });
    // 120 BPM, 4 bars = 8s; shrink to 0.25 bars = 0.5s — fades must clamp
    const next = resizeAudioClip(doc, clipId, 0.25).execute(doc);
    const clip = clipOf(next, clipId);
    expect(clip.lengthBars).toBe(0.25);
    expect(clip.fadeIn!).toBeLessThanOrEqual(0.5 + 0.001);
    expect(clip.fadeOut!).toBeLessThanOrEqual(0.5 + 0.001);
  });

  it("duplicate assigns a fresh unique id and deep-copies warp markers", () => {
    const doc0 = testDoc();
    const seeded: ProjectDocument = {
      ...doc0,
      arrangement: {
        ...doc0.arrangement,
        audioClips: [
          {
            id: "orig",
            trackId: doc0.tracks[0]!.id,
            bufferId: "buf",
            startBar: 4,
            lengthBars: 4,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 0,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
            warpMarkers: [{ timeSec: 0.5, tick: 480 }],
          },
        ],
      },
    };
    const next = duplicateAudioClip(seeded, "orig").execute(seeded);
    const clips = next.arrangement.audioClips ?? [];
    expect(clips).toHaveLength(2);
    const [orig, copy] = clips as [AudioClip, AudioClip];
    expect(copy.id).not.toBe(orig.id);
    // mutate the copy's warp markers — the original must stay untouched
    copy.warpMarkers![0]!.timeSec = 99;
    expect((next.arrangement.audioClips ?? [])[0]!.warpMarkers![0]!.timeSec).toBe(0.5);
  });

  it("duplicate lands exactly after the source (layering contract)", () => {
    const { doc, clipId } = docWithClip();
    const orig = clipOf(doc, clipId);
    const next = duplicateAudioClip(doc, clipId).execute(doc);
    const copy = (next.arrangement.audioClips ?? []).find((c) => c.id !== clipId)!;
    expect(copy.startBar).toBe(orig.startBar + orig.lengthBars);
  });

  it("delete removes exactly one clip and undo restores the full list", () => {
    const { doc, clipId } = docWithClip();
    const before = (doc.arrangement.audioClips ?? []).length;
    const cmd = deleteAudioClip(doc, clipId);
    const next = cmd.execute(doc);
    expect((next.arrangement.audioClips ?? []).length).toBe(before - 1);
    const undone = cmd.undo(next);
    expect((undone.arrangement.audioClips ?? []).length).toBe(before);
  });
});

describe("audit: split integrity", () => {
  it("split produces two clips whose combined length equals the original", () => {
    const { doc, clipId } = docWithClip();
    const orig = clipOf(doc, clipId);
    const splitTick = orig.startBar * BAR_TICKS + (orig.lengthBars / 2) * BAR_TICKS; // middle of the 4-bar clip
    const next = splitAudioClipAtTick(doc, clipId, splitTick).execute(doc);
    const all = next.arrangement.audioClips ?? [];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const children = all.filter((c) => c.id !== clipId);
    const totalBars = children.reduce((sum, c) => sum + c.lengthBars, 0);
    expect(totalBars).toBeCloseTo(orig.lengthBars, 1);
  });

  it("split refuses edges and non-finite ticks with clear errors", () => {
    const { doc, clipId } = docWithClip();
    const orig = clipOf(doc, clipId);
    expect(() => splitAudioClipAtTick(doc, clipId, orig.startBar * BAR_TICKS)).toThrow(/outside/);
    expect(() => splitAudioClipAtTick(doc, clipId, NaN)).toThrow(/finite/);
  });
});

describe("audit: stretch", () => {
  it("stretch keeps the start pinned on right-edge drag and clamps the rate", () => {
    const { doc, clipId } = docWithClip({ stretchRate: 1 });
    const orig = clipOf(doc, clipId);
    const cmd = stretchAudioClip(doc, clipId, orig.lengthBars * 2, 50);
    const next = cmd.execute(doc);
    const clip = clipOf(next, clipId);
    expect(clip.startBar).toBe(orig.startBar);
    expect(clip.stretchRate).toBe(4);
  });
});
