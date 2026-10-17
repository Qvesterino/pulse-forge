import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  deleteArrangementClip,
  groupClips,
  splitArrangementClipAtTick,
} from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";

/**
 * Split of a GROUPED scene clip — group membership, undo fidelity and the
 * edge refusal. This started as a throwaway probe (the original walked the
 * path and asserted nothing); it is now the regression pin for the question
 * the probe asked: does splitting a grouped clip keep both fragments in the
 * group, and does undo restore the group exactly?
 */
describe("split of a grouped clip — membership, undo, edge refusal", () => {
  function groupedDoc() {
    let doc = createProjectFromTemplate("house");
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addAudioClip(doc, trackId, "buf-a", 0, 2).execute(doc);
    const arrId = doc.arrangement.clips[0]!.id;
    const audioId = (doc.arrangement.audioClips ?? [])[0]!.id;
    return { doc, arrId, audioId };
  }

  it("both fragments inherit the group and undo restores it exactly", () => {
    const { doc, arrId, audioId } = groupedDoc();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    const grouped = store.doc;
    const groupBefore = grouped.arrangement.clipGroups![0]!;
    expect(groupBefore.clipIds).toEqual([arrId, audioId]);

    store.execute(splitArrangementClipAtTick(grouped, arrId, 2 * BAR_TICKS));

    // Two scene fragments on 0..4 bars; the LEFT keeps the original id (so
    // every transition/selection pointing at it stays valid) and the RIGHT
    // joins the same group.
    const fragments = store.doc.arrangement.clips.filter((c) => c.startBar < 4);
    expect(fragments).toHaveLength(2);
    expect(fragments.some((c) => c.id === arrId)).toBe(true);
    const groupAfter = store.doc.arrangement.clipGroups!.find((g) => g.clipIds.includes(audioId))!;
    expect(groupAfter.clipIds).toHaveLength(3);
    expect(groupAfter.clipIds).toContain(arrId);

    // Undo restores the grouped pre-split arrangement exactly — same clip ids,
    // same group membership, no dangling fragment ids.
    store.undo();
    expect(store.doc.arrangement.clips.map((c) => c.id)).toEqual(grouped.arrangement.clips.map((c) => c.id));
    expect(store.doc.arrangement.clipGroups).toEqual(grouped.arrangement.clipGroups);
    const normalized = normalizeProject(store.doc);
    expect(normalized.arrangement.clipGroups).toEqual(grouped.arrangement.clipGroups);
    expect(normalized.arrangement.clips.map((c) => c.id)).toEqual(grouped.arrangement.clips.map((c) => c.id));
  });

  it("refuses a split at the left fragment's own end after the first split", () => {
    const { doc, arrId, audioId } = groupedDoc();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.execute(splitArrangementClipAtTick(store.doc, arrId, 2 * BAR_TICKS));

    // The original id now names the 0..2-bar left fragment; its end is no
    // longer a legal split point (a split must leave a whole bar on each side).
    expect(() => splitArrangementClipAtTick(store.doc, arrId, 2 * BAR_TICKS)).toThrow(/outside clip/);
  });
});
