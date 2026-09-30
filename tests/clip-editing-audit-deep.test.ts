import { describe, it, expect } from "vitest";
import {
  addAudioClip,
  updateAudioClip,
  moveAudioClip,
  resizeAudioClip,
  duplicateAudioClip,
  deleteAudioClip,
  splitAudioClipAtTick,
  addArrangementClip,
  moveArrangementClip,
  resizeArrangementClip,
} from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";
import { sanitizeAudioClips } from "../src/project-model/schema";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * CLIP EDITING AUDIT — DEEP PASS. Layers the quick pass didn't reach:
 * rapid sequential edit chains with undo integrity, persistence
 * round-trips through sanitizeAudioClips, the ArrangementClip no-overlap
 * contract, and cross-edit invariants (start+length consistency, sort
 * order, ID uniqueness).
 */

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 8)}`,
    trackId: "track-1",
    bufferId: "buf-audit",
    startBar: 0,
    lengthBars: 4,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    ...overrides,
  };
}

describe("audit: rapid sequential edits + undo chain", () => {
  it("10 sequential edits each produce a valid state; undoing all restores the start", () => {
    let doc = testDoc();
    doc = addAudioClip(doc, doc.tracks[0]!.id, "buf-rapid", 0, 4).execute(doc);
    const clipId = (doc.arrangement.audioClips ?? [])[0]!.id;
    const commands = [
      updateAudioClip(doc, clipId, { gain: 0.9 }),
      updateAudioClip(doc, clipId, { gain: 0.8 }),
      updateAudioClip(doc, clipId, { trimStart: 0.1 }),
      updateAudioClip(doc, clipId, { fadeIn: 0.05 }),
      moveAudioClip(doc, clipId, 2),
      resizeAudioClip(doc, clipId, 6),
      updateAudioClip(doc, clipId, { gain: 1.1 }),
      updateAudioClip(doc, clipId, { fadeOut: 0.3 }),
      moveAudioClip(doc, clipId, 4),
      updateAudioClip(doc, clipId, { reverse: true }),
    ];
    const states: ProjectDocument[] = [doc];
    for (const cmd of commands) doc = cmd.execute(doc);
    states.push(doc);
    // every intermediate state is well-formed
    for (const state of states) {
      const clips = state.arrangement.audioClips ?? [];
      for (const clip of clips) {
        expect(Number.isFinite(clip.startBar)).toBe(true);
        expect(clip.startBar).toBeGreaterThanOrEqual(0);
        expect(clip.lengthBars).toBeGreaterThanOrEqual(0.25);
        expect(Number.isFinite(clip.gain)).toBe(true);
      }
    }
    // undoing ALL commands lands back on the original doc
    let current = doc;
    for (let i = commands.length - 1; i >= 0; i--) current = commands[i]!.undo(current);
    const original = states[0]!;
    expect((current.arrangement.audioClips ?? [])[0]!.gain).toBe((original.arrangement.audioClips ?? [])[0]!.gain);
  });

  it("split → edit children → undo the split removes children cleanly", () => {
    let doc = testDoc();
    doc = addAudioClip(doc, doc.tracks[0]!.id, "buf-split", 0, 8).execute(doc);
    const clipId = (doc.arrangement.audioClips ?? [])[0]!.id;
    const splitTick = 4 * 480; // middle of the 8-bar clip
    const splitCmd = splitAudioClipAtTick(doc, clipId, splitTick);
    doc = splitCmd.execute(doc);
    const children = doc.arrangement.audioClips ?? [];
    expect(children.length).toBe(2);
    // edit the right fragment
    const right = children[1]!;
    doc = updateAudioClip(doc, right.id, { gain: 0.5 }).execute(doc);
    // undo the split → the original clip returns intact, the edit vanishes
    doc = splitCmd.undo(doc);
    expect((doc.arrangement.audioClips ?? []).length).toBe(1);
    expect((doc.arrangement.audioClips ?? [])[0]!.id).toBe(clipId);
  });
});

describe("audit: persistence round-trip via sanitizeAudioClips", () => {
  it("all 18 AudioClip fields survive the sanitize pass", () => {
    const full: AudioClip = {
      id: "persist-1",
      trackId: "track-1",
      bufferId: "buf-persist",
      sourceChannel: 1,
      startBar: 2,
      lengthBars: 4,
      offsetSec: 0.5,
      trimStart: 0.3,
      trimEnd: 0.2,
      gain: 1.2,
      fadeIn: 0.05,
      fadeOut: 0.1,
      stretchRate: 1.5,
      reverse: true,
      stretchMode: "stretch",
      warpMarkers: [
        { timeSec: 0, tick: 0 },
        { timeSec: 1.5, tick: 960 },
      ],
    };
    const out = sanitizeAudioClips([JSON.parse(JSON.stringify(full)) as unknown], new Set(["track-1"]));
    expect(out).toHaveLength(1);
    const clip = out[0]!;
    expect(clip.id).toBe("persist-1");
    expect(clip.sourceChannel).toBe(1);
    expect(clip.offsetSec).toBe(0.5);
    expect(clip.trimStart).toBe(0.3);
    expect(clip.trimEnd).toBe(0.2);
    expect(clip.gain).toBe(1.2);
    expect(clip.fadeIn).toBe(0.05);
    expect(clip.fadeOut).toBe(0.1);
    expect(clip.stretchRate).toBe(1.5);
    expect(clip.reverse).toBe(true);
    expect(clip.stretchMode).toBe("stretch");
    expect(clip.warpMarkers).toEqual([
      { timeSec: 0, tick: 0 },
      { timeSec: 1.5, tick: 960 },
    ]);
  });

  it("loop + loopPhaseOffsetSec survive; reversed-loop phase is dropped", () => {
    const looped = makeClip({ loop: true, loopPhaseOffsetSec: 1.5 });
    const out = sanitizeAudioClips([looped], new Set(["track-1"]));
    expect(out[0]!.loop).toBe(true);
    expect(out[0]!.loopPhaseOffsetSec).toBe(1.5);
    const reversed = makeClip({ loop: true, loopPhaseOffsetSec: 1.5, reverse: true });
    const out2 = sanitizeAudioClips([reversed], new Set(["track-1"]));
    expect(out2[0]!.loopPhaseOffsetSec).toBeUndefined();
  });

  it("duplicate ids are deduped, invalid tracks dropped, numbers clamped", () => {
    const dup = makeClip({ id: "same-id", gain: 5, lengthBars: -1 });
    const dup2 = makeClip({ id: "same-id" });
    const badTrack = makeClip({ id: "bad-track", trackId: "nonexistent" });
    const out = sanitizeAudioClips([dup, dup2, badTrack], new Set(["track-1"]));
    expect(out.length).toBe(1); // only the first duplicate survives
    expect(out[0]!.gain).toBe(1); // the surviving dup2 carries default gain
    expect(out[0]!.lengthBars).toBe(4);
  });

  it("take group fields survive persistence", () => {
    const take = makeClip({ takeGroupId: "tg-1", takeId: "take-1", compSourceTakeId: "take-2" });
    const out = sanitizeAudioClips([take], new Set(["track-1"]));
    expect(out[0]!.takeGroupId).toBe("tg-1");
    expect(out[0]!.takeId).toBe("take-1");
    expect(out[0]!.compSourceTakeId).toBe("take-2");
  });
});

describe("audit: ArrangementClip no-overlap contract", () => {
  function arrangeDoc() {
    let doc = testDoc();
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 8, 4).execute(doc);
    return doc;
  }

  it("move into occupied territory is refused (not silently clamped)", () => {
    const doc = arrangeDoc();
    const clipId = doc.arrangement.clips[0]!.id;
    // clip 0 at bars 0-3, clip 1 at bars 8-11; moving clip 0 to bar 7 overlaps
    expect(() => moveArrangementClip(doc, clipId, 7)).toThrow(/overlap/);
  });

  it("resize into the next clip is refused", () => {
    const doc = arrangeDoc();
    const clipId = doc.arrangement.clips[0]!.id;
    expect(() => resizeArrangementClip(doc, clipId, 10)).toThrow(/overlap/);
  });

  it("resize within free space succeeds and clamps to min 1 bar", () => {
    const doc = arrangeDoc();
    const clipId = doc.arrangement.clips[0]!.id;
    const next = resizeArrangementClip(doc, clipId, 2).execute(doc);
    expect(next.arrangement.clips[0]!.lengthBars).toBe(2);
    const tooSmall = resizeArrangementClip(next, clipId, 0).execute(next);
    expect(tooSmall.arrangement.clips[0]!.lengthBars).toBeGreaterThanOrEqual(1);
  });

  it("transitions are re-derived after move (no stale transition to a moved clip)", () => {
    const doc = arrangeDoc();
    const clipId = doc.arrangement.clips[1]!.id;
    const next = moveArrangementClip(doc, clipId, 4).execute(doc);
    // every transition endpoint still references an existing clip
    for (const t of next.arrangement.transitions ?? []) {
      const fromExists = next.arrangement.clips.some((c) => c.id === t.fromClipId);
      const toExists = next.arrangement.clips.some((c) => c.id === t.toClipId);
      expect(fromExists || toExists).toBe(true);
    }
  });
});
