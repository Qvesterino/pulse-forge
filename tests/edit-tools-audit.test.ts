import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addAudioClip,
  deleteAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  resizeAudioClip,
  splitAudioClipAtTick,
  updateAudioClip,
} from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * EDIT TOOLS AUDIT — invariant probes for the arrangement clip command
 * layer (DAW_EDIT_TOOLS_INTERACTION_AUDIT.md). Each test states an editing
 * invariant; failures are confirmed bugs, not test bugs.
 *
 * Invariants:
 *  I1  clip positions/durations are finite, ≥ 0, duration ≥ 0.25 bars
 *  I2  split: left.end === right.start (no gap, no overlap), totals preserved
 *  I3  split: fades at the split point are neutralised (left.fadeOut = 0,
 *      right.fadeIn = 0); outer fades survive
 *  I4  duplicate/split copies do not share mutable arrays (warpMarkers)
 *  I5  NaN/Infinity patches can never poison the document
 *  I6  fades stay within clip bounds after resize/update
 *  I7  every edit is undoable to the exact previous document
 *  I8  combined edit sequences keep the document internally valid
 *
 * NOTE: BAR_TICKS is 1920 (4 beats × 480 PPQ), warp-marker ticks are
 * ARRANGEMENT-ABSOLUTE.
 */

const BAR = BAR_TICKS;

const docWithClip = (patch: Partial<AudioClip> = {}): { doc: ProjectDocument; clipId: string } => {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const doc = addAudioClip(base, trackId, "buf-1", 4, 4, {
    fadeIn: 0,
    fadeOut: 0,
    ...patch,
  }).execute(base);
  const clip = clipsOf(doc).find((c) => c.bufferId === "buf-1")!;
  return { doc, clipId: clip.id };
};

const clipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];

describe("I1 finite/valid clip fields", () => {
  it("addAudioClip rejects NaN/Infinity position and duration", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const doc = addAudioClip(base, trackId, "buf-1", Number.NaN, Number.POSITIVE_INFINITY).execute(base);
    const clip = clipsOf(doc).find((c) => c.bufferId === "buf-1")!;
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(Number.isFinite(clip.lengthBars)).toBe(true);
    expect(clip.lengthBars).toBeGreaterThanOrEqual(0.25);
  });

  it("moveAudioClip cannot move to a negative or NaN position", () => {
    const { doc, clipId } = docWithClip();
    const moved = moveAudioClip(doc, clipId, -3).execute(doc);
    expect(clipsOf(moved).find((c) => c.id === clipId)!.startBar).toBe(0);
    const nan = moveAudioClip(doc, clipId, Number.NaN).execute(doc);
    expect(Number.isFinite(clipsOf(nan).find((c) => c.id === clipId)!.startBar)).toBe(true);
  });

  it("resizeAudioClip ignores non-finite lengths", () => {
    const { doc, clipId } = docWithClip();
    const next = resizeAudioClip(doc, clipId, Number.NaN).execute(doc);
    expect(clipsOf(next).find((c) => c.id === clipId)!.lengthBars).toBe(4);
  });
});

describe("I2/I3 split integrity", () => {
  it("split keeps left.end === right.start (adjacent, no gap/overlap)", () => {
    const { doc, clipId } = docWithClip();
    const splitTick = 4 * BAR + BAR / 2; // middle of the 4-bar clip
    const next = splitAudioClipAtTick(doc, clipId, splitTick).execute(doc);
    const clips = clipsOf(next).sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(2);
    const leftEnd = clips[0]!.startBar + clips[0]!.lengthBars;
    // Exact adjacency at command precision: no gap, no overlap.
    expect(leftEnd).toBeCloseTo(clips[1]!.startBar, 6);
    expect(clips[0]!.lengthBars + clips[1]!.lengthBars).toBeCloseTo(4, 2);
  });

  it("split neutralises fades at the split point, keeps outer fades", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 0.5, fadeOut: 0.7 });
    const next = splitAudioClipAtTick(doc, clipId, 4 * BAR + BAR / 2).execute(doc);
    const clips = clipsOf(next).sort((a, b) => a.startBar - b.startBar);
    expect(clips[0]!.fadeIn).toBeCloseTo(0.5); // outer fade survives
    expect(clips[0]!.fadeOut).toBe(0); // split point is neutral
    expect(clips[1]!.fadeIn).toBe(0); // split point is neutral
    expect(clips[1]!.fadeOut).toBeCloseTo(0.7); // outer fade survives
  });

  it("repeated splits stay adjacent and keep ids unique", () => {
    const { doc, clipId } = docWithClip();
    let working = splitAudioClipAtTick(doc, clipId, 5 * BAR).execute(doc);
    // target the right half (bars 5..8) for the next two splits
    const rightId = clipsOf(working).sort((a, b) => a.startBar - b.startBar)[1]!.id;
    working = splitAudioClipAtTick(working, rightId, 6 * BAR).execute(working);
    const againRight = clipsOf(working).sort((a, b) => a.startBar - b.startBar)[2]!.id;
    working = splitAudioClipAtTick(working, againRight, 7 * BAR).execute(working);
    const clips = clipsOf(working).sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(4);
    expect(new Set(clips.map((c) => c.id)).size).toBe(4);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i - 1]!.startBar + clips[i - 1]!.lengthBars).toBeCloseTo(clips[i]!.startBar, 6);
    }
  });

  it("split preserves source identity (bufferId, gain) on both fragments", () => {
    const { doc, clipId } = docWithClip({ gain: 1.4 });
    const next = splitAudioClipAtTick(doc, clipId, 4 * BAR + BAR / 2).execute(doc);
    for (const clip of clipsOf(next)) {
      expect(clip.bufferId).toBe("buf-1");
      expect(clip.gain).toBeCloseTo(1.4);
    }
  });
});

describe("I4 copies own their mutable state", () => {
  it("addAudioClip preserves warp markers instead of dropping them", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const doc = addAudioClip(base, trackId, "buf-1", 4, 4, {
      warpMarkers: [{ timeSec: 0.5, tick: 4 * BAR + 240 }],
    }).execute(base);
    expect(clipsOf(doc).find((c) => c.bufferId === "buf-1")!.warpMarkers).toHaveLength(1);
  });

  it("duplicate deep-copies warpMarkers", () => {
    const warp = [{ timeSec: 0.5, tick: 4 * BAR + 240 }];
    const { doc, clipId } = docWithClip({ warpMarkers: warp });
    const next = duplicateAudioClip(doc, clipId).execute(doc);
    const sorted = clipsOf(next).sort((a, b) => a.startBar - b.startBar);
    expect(sorted[1]!.warpMarkers).not.toBe(sorted[0]!.warpMarkers);
  });

  it("split fragments do not share warpMarkers between each other", () => {
    const warp = [
      { timeSec: 0.5, tick: 4 * BAR + 240 },
      { timeSec: 1.5, tick: 5 * BAR },
    ];
    const { doc, clipId } = docWithClip({ warpMarkers: warp });
    const next = splitAudioClipAtTick(doc, clipId, 4 * BAR + BAR / 2).execute(doc);
    const [left, right] = clipsOf(next).sort((a, b) => a.startBar - b.startBar);
    expect(left!.warpMarkers).not.toBe(right!.warpMarkers);
  });
});

describe("I5 duplicate placement + overlap contract", () => {
  it("duplicate lands after the source with a fresh id, original untouched", () => {
    const { doc, clipId } = docWithClip();
    const next = duplicateAudioClip(doc, clipId).execute(doc);
    const sorted = clipsOf(next).sort((a, b) => a.startBar - b.startBar);
    expect(sorted).toHaveLength(2);
    expect(sorted[0]!.id).not.toBe(sorted[1]!.id);
    expect(sorted[1]!.startBar).toBe(8); // right after the 4-bar source
    expect(sorted[0]!.startBar).toBe(4);
  });

  it("OVERLAP CONTRACT: audio duplicates LAYER instead of teleporting past busy neighbours", () => {
    const seed = docWithClip();
    // A neighbour occupies bars 8..12 (exactly where a naive "after source"
    // copy would land). The old bump silently teleported the copy to 12..
    const trackId = seed.doc.tracks.find((t) => t.kind === "instrument")!.id;
    const withNeighbour = addAudioClip(seed.doc, trackId, "buf-neighbour", 8, 4).execute(seed.doc);
    const source = clipsOf(withNeighbour).find((c) => c.bufferId === "buf-1")!;
    // ONE command instance — snapshot commands are id-anchored inverse
    // patches; a second instance would mint a different uid and its undo
    // could not revert the first instance's copy.
    const cmd = duplicateAudioClip(withNeighbour, source.id);
    const next = cmd.execute(withNeighbour);
    const mine = clipsOf(next).filter((c) => c.bufferId === "buf-1").sort((a, b) => a.startBar - b.startBar);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.startBar).toBe(8); // adjacent to source — OVERLAPS neighbour (layering)
    expect(clipsOf(next)).toHaveLength(3); // neighbour untouched
    // undo restores the pre-duplicate state exactly
    expect(cmd.undo(next)).toEqual(withNeighbour);
  });

  it("audio clips may layer by design (add does not avoid, engine sums)", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    let working = addAudioClip(base, trackId, "buf-a", 0, 4).execute(base);
    working = addAudioClip(working, trackId, "buf-b", 2, 4).execute(working); // deliberate overlap
    const onTrack = clipsOf(working).filter((c) => c.trackId === trackId);
    expect(onTrack).toHaveLength(2); // both survive — layering is the contract
  });
});

describe("I6 fade bounds", () => {
  it("updateAudioClip clamps fades to the clip duration", () => {
    const { doc, clipId } = docWithClip();
    // 4-bar clip at house tempo ≈ 7.7 s; ask for a 100 s fade.
    const next = updateAudioClip(doc, clipId, { fadeIn: 100, fadeOut: 100 }).execute(doc);
    const clip = clipsOf(next).find((c) => c.id === clipId)!;
    const durSec = (clip.lengthBars * BAR * 60) / doc.bpm / 480;
    expect(clip.fadeIn).toBeLessThanOrEqual(durSec + 1e-6);
    expect(clip.fadeOut).toBeLessThanOrEqual(durSec + 1e-6);
  });

  it("resize to shorter than the fades clamps fades safely", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 3, fadeOut: 3 });
    const next = resizeAudioClip(doc, clipId, 0.25).execute(doc);
    const clip = clipsOf(next).find((c) => c.id === clipId)!;
    const durSec = (clip.lengthBars * BAR * 60) / doc.bpm / 480;
    expect(clip.fadeIn).toBeLessThanOrEqual(durSec + 1e-6);
    expect(clip.fadeOut).toBeLessThanOrEqual(durSec + 1e-6);
  });

  it("trim patches survive (trimStart/trimEnd stay finite and ≥ 0)", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, {
      trimStart: Number.NaN,
      trimEnd: Number.POSITIVE_INFINITY,
      offsetSec: -5,
    }).execute(doc);
    const clip = clipsOf(next).find((c) => c.id === clipId)!;
    expect(clip.trimStart).toBe(0);
    expect(clip.trimEnd).toBe(0);
    expect(clip.offsetSec).toBe(0);
  });
});

describe("I7 undo integrity", () => {
  it("split → undo restores the exact previous document", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 0.4, fadeOut: 0.4 });
    const cmd = splitAudioClipAtTick(doc, clipId, 4 * BAR + BAR / 2);
    const next = cmd.execute(doc);
    expect(cmd.undo(next)).toEqual(doc);
  });

  it("duplicate → undo restores the exact previous document", () => {
    const { doc, clipId } = docWithClip({ warpMarkers: [{ timeSec: 0.5, tick: 4 * BAR + 240 }] });
    const cmd = duplicateAudioClip(doc, clipId);
    const next = cmd.execute(doc);
    expect(cmd.undo(next)).toEqual(doc);
  });

  it("resize-with-fade-clamp → undo restores original fades", () => {
    const { doc, clipId } = docWithClip({ fadeIn: 3, fadeOut: 3 });
    const cmd = resizeAudioClip(doc, clipId, 0.25);
    const next = cmd.execute(doc);
    expect(cmd.undo(next)).toEqual(doc);
  });
});

describe("I8 combined stress sequence", () => {
  it("move → split → duplicate → move duplicate → delete → undo×2 → redo×2 stays valid", () => {
    const seed = docWithClip({ fadeIn: 0.3, fadeOut: 0.5 });
    let doc = seed.doc;
    const stack: import("../src/commands/types").Command[] = [];
    const redo: import("../src/commands/types").Command[] = [];
    const apply = (cmd: import("../src/commands/types").Command) => {
      stack.push(cmd);
      redo.length = 0;
      doc = cmd.execute(doc);
    };
    const undo = () => {
      const cmd = stack.pop();
      if (!cmd) return;
      redo.push(cmd);
      doc = cmd.undo(doc);
    };
    const redoStep = () => {
      const cmd = redo.pop();
      if (!cmd) return;
      stack.push(cmd);
      doc = cmd.execute(doc);
    };

    // 1) move the original right
    apply(moveAudioClip(doc, seed.clipId, 8));
    // 2) split at the middle (bar 10)
    apply(splitAudioClipAtTick(doc, seed.clipId, 10 * BAR));
    expect(clipsOf(doc)).toHaveLength(2);
    const halves = clipsOf(doc).sort((a, b) => a.startBar - b.startBar);
    // 3) duplicate the right half and park the copy far right
    apply(duplicateAudioClip(doc, halves[1]!.id));
    const dup = clipsOf(doc).sort((a, b) => a.startBar - b.startBar).at(-1)!;
    apply(moveAudioClip(doc, dup.id, 20));
    // 4) delete the duplicate, then the right half
    apply(deleteAudioClip(doc, dup.id));
    apply(deleteAudioClip(doc, halves[1]!.id));
    expect(clipsOf(doc)).toHaveLength(1);
    // 5) undo the two deletes → 3 clips back (left half, right half, dup)
    undo();
    undo();
    expect(clipsOf(doc)).toHaveLength(3);
    // 6) redo them → back to 1 clip
    redoStep();
    redoStep();
    expect(clipsOf(doc)).toHaveLength(1);
    const survivor = clipsOf(doc)[0]!;
    expect(survivor.bufferId).toBe("buf-1");
    expect(survivor.startBar).toBe(8);
    expect(Number.isFinite(survivor.lengthBars)).toBe(true);
  });
});
