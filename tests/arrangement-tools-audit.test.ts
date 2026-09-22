import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addArrangementClip,
  deleteArrangementClipRipple,
  moveArrangementClipRipple,
  resizeArrangementClipRipple,
  setArrangementClipLoop,
  setArrangementClipScene,
} from "../src/commands/commands";
import type { ArrangementClip, ProjectDocument } from "../src/project-model/types";

/**
 * ARRANGEMENT-AS-A-TOOL audit — the command layer behind the arrangement
 * wave (variant swap, ripple move/resize/delete, loop flag). Contract
 * under test (audit §13): arrangement clips are NO-OVERLAP — every
 * operation must keep the layout gap-exact and transition-consistent.
 *
 * The house template ships with a full song arrangement (clips from the
 * song builder) — probes address clips by position, not by index guesses.
 */

const docWithClips = (): ProjectDocument => {
  // Template content drifts (the parallel session rewrites builders) — the
  // probe paints a deterministic 4-clip strip AFTER whatever the template
  // ships, alternating the first two scenes when both exist.
  let doc = createProjectFromTemplate("house");
  const existingEnd = clips(doc).reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  const sceneIds = [...new Set(doc.scenes.map((s) => s.id))];
  const sceneA = sceneIds[0]!;
  const sceneB = sceneIds[1] ?? sceneIds[0]!;
  for (let i = 0; i < 4; i++) {
    doc = addArrangementClip(doc, i % 2 === 0 ? sceneA : sceneB, existingEnd + i * 4, 4).execute(doc);
  }
  return doc;
};

const clips = (doc: ProjectDocument): ArrangementClip[] =>
  [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);

const expectNoOverlap = (doc: ProjectDocument) => {
  const list = clips(doc);
  for (let i = 1; i < list.length; i++) {
    expect(list[i - 1]!.startBar + list[i - 1]!.lengthBars).toBeLessThanOrEqual(list[i]!.startBar);
  }
};

describe("setArrangementClipScene (variant swap)", () => {
  it("swaps the scene under a clip — position, length, neighbours untouched", () => {
    const doc = docWithClips();
    const clip = clips(doc).find((c) => doc.scenes.some((s) => s.id !== c.sceneId));
    if (!clip) return; // template with a single scene — swap is untestable here
    const otherScene = doc.scenes.find((s) => s.id !== clip.sceneId)!;
    const next = setArrangementClipScene(doc, clip.id, otherScene.id).execute(doc);
    const swapped = clips(next).find((c) => c.id === clip.id)!;
    expect(swapped.sceneId).toBe(otherScene.id);
    expect(swapped.startBar).toBe(clip.startBar);
    expect(swapped.lengthBars).toBe(clip.lengthBars);
    expectNoOverlap(next);
  });

  it("is a no-op when the clip already references that scene", () => {
    const doc = docWithClips();
    const clip = clips(doc)[0]!;
    const cmd = setArrangementClipScene(doc, clip.id, clip.sceneId);
    expect(cmd.execute(doc)).toBe(doc);
  });

  it("undoes back to the original sceneId", () => {
    const doc = docWithClips();
    const clip = clips(doc).find((c) => doc.scenes.some((s) => s.id !== c.sceneId));
    if (!clip) return;
    const otherScene = doc.scenes.find((s) => s.id !== clip.sceneId)!;
    const cmd = setArrangementClipScene(doc, clip.id, otherScene.id);
    const next = cmd.execute(doc);
    expect(cmd.undo(next)).toEqual(doc);
  });
});

describe("ripple edit", () => {
  it("ripple move shifts the clip AND every later clip by the same delta", () => {
    const doc = docWithClips();
    const list = clips(doc);
    const first = list[0]!;
    const later = list.slice(1).map((c) => c.startBar);
    const targetBar = 40; // far right of the original layout
    const next = moveArrangementClipRipple(doc, first.id, targetBar).execute(doc);
    const moved = clips(next).find((c) => c.id === first.id)!;
    expect(moved.startBar).toBe(targetBar);
    const nextList = clips(next);
    for (let i = 1; i < nextList.length; i++) {
      // gaps preserved: neighbour distances identical to before
      expect(nextList[i]!.startBar - nextList[i - 1]!.startBar).toBe(list[i]!.startBar - list[i - 1]!.startBar);
    }
    void later;
  });

  it("ripple resize pushes later clips by the grown amount", () => {
    const doc = docWithClips();
    const list = clips(doc);
    const first = list[0]!;
    const secondBefore = list[1]!.startBar;
    const next = resizeArrangementClipRipple(doc, first.id, first.lengthBars + 6).execute(doc);
    const grown = clips(next).find((c) => c.id === first.id)!;
    expect(grown.lengthBars).toBe(first.lengthBars + 6);
    expect(clips(next).find((c) => c.id === list[1]!.id)!.startBar).toBe(secondBefore + 6);
    expectNoOverlap(next);
  });

  it("ripple delete closes the gap — later clips slide left", () => {
    const doc = docWithClips();
    const list = clips(doc);
    const first = list[0]!;
    const secondStartBefore = list[1]!.startBar;
    const next = deleteArrangementClipRipple(doc, first.id).execute(doc);
    const remaining = clips(next);
    expect(remaining).toHaveLength(list.length - 1);
    expect(remaining[0]!.startBar).toBe(Math.max(0, secondStartBefore - first.lengthBars));
    expectNoOverlap(next);
  });

  it("ripple delete of a middle clip keeps later relative spacing", () => {
    const doc = docWithClips();
    const list = clips(doc);
    if (list.length < 3) return; // template shape guard
    const middle = list[1]!;
    const next = deleteArrangementClipRipple(doc, middle.id).execute(doc);
    const remaining = clips(next);
    expect(remaining).toHaveLength(list.length - 1);
    // clips after the removed one keep their pairwise gaps
    for (let i = 2; i < list.length; i++) {
      const before = list[i]!.startBar - list[i - 1]!.startBar;
      const after = (remaining[i - 1] ?? remaining[remaining.length - 1])!.startBar -
        (remaining[i - 2] ?? remaining[0])!.startBar;
      if (i - 2 >= 1) expect(after).toBe(before);
    }
    expectNoOverlap(next);
  });

  it("ripple delete → undo restores the exact layout", () => {
    const doc = docWithClips();
    const first = clips(doc)[0]!;
    const cmd = deleteArrangementClipRipple(doc, first.id);
    const next = cmd.execute(doc);
    expect(cmd.undo(next)).toEqual(doc);
  });
});

describe("loop flag", () => {
  it("toggles per-clip loop without moving anything", () => {
    const doc = docWithClips();
    const clip = clips(doc)[0]!;
    const next = setArrangementClipLoop(doc, clip.id, true).execute(doc);
    const looped = clips(next).find((c) => c.id === clip.id)!;
    expect(looped.loop).toBe(true);
    expect(looped.startBar).toBe(clip.startBar);
  });
});
