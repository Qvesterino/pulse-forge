import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioTakeClip } from "../src/commands/audioClips";
import { createLiveSet, setLiveSetOptions } from "../src/commands/liveSets";
import { deleteTrack } from "../src/commands/tracks";

/**
 * DELETE TRACK + UNDO must not silently destroy the take lanes or the Live
 * Set routing.
 *
 * The take lanes and the Live Set point AT the track, and the post-apply
 * normalize pass prunes both OUTSIDE the captured undo delta. So Ctrl+Z
 * brought the track and its clips back but NOT the lane structure: every
 * take was audible at once (a wrong mix), the lanes were gone for good, and
 * the Live Set had lost its destination - all without a word to the user.
 *
 * The cross-references have to be removed INSIDE the command, so they are
 * part of the delta and the backward delta restores them with the track.
 */

describe("delete track + undo keeps the take lanes and the Live Set routing", () => {
  it("restores the take group and the Live Set destination with the track", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const trackId = store.doc.tracks.find((track) => track.kind === "instrument")!.id;

    store.execute(addAudioTakeClip(store.doc, "group-1", "take-1", trackId, "factory.kick", 0, 4));
    store.execute(addAudioTakeClip(store.doc, "group-1", "take-2", trackId, "factory.kick", 0, 4));
    store.execute(createLiveSet(store.doc, "Set"));
    const setId = store.doc.liveSets![0].id;
    store.execute(setLiveSetOptions(store.doc, setId, { trackId }));

    expect(store.doc.arrangement.takeGroups?.length).toBe(1);
    expect(store.doc.liveSets?.[0].trackId).toBe(trackId);

    store.execute(deleteTrack(store.doc, trackId));

    // With the track gone, the lanes have nothing to own.
    expect(store.doc.arrangement.takeGroups).toBeUndefined();
    expect(store.doc.liveSets?.[0].trackId).toBeUndefined();

    store.undo();

    // The undo must bring back the LANES, not just the clips.
    const groups = store.doc.arrangement.takeGroups;
    expect(groups?.length).toBe(1);
    expect(groups?.[0].trackId).toBe(trackId);
    expect(groups?.[0].activeTakeId).toBeTruthy();
    const takes = (store.doc.arrangement.audioClips ?? []).filter((clip) => clip.takeGroupId === "group-1");
    expect(takes.length).toBe(2);
    // The Live Set points at the restored track again.
    expect(store.doc.liveSets?.[0].trackId).toBe(trackId);
  });
});
