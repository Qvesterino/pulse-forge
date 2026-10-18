import { describe, expect, it } from "vitest";
import {
  addAudioClip,
  assignLivePad,
  createLiveSet,
  deleteLiveSet,
  duplicateLiveSet,
  renameLiveSet,
  selectLiveSet,
  setLiveSetOptions,
} from "../src/commands/commands";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";

describe("project-local Live Sets", () => {
  it("creates, assigns, duplicates, selects, renames and deletes with undoable commands", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    store.execute(createLiveSet(store.doc, "Club loops"));
    const set = store.doc.liveSets![0]!;
    const trackId = store.doc.tracks.find((track) => track.kind !== "generative")!.id;

    store.execute(setLiveSetOptions(store.doc, set.id, { trackId, loopBars: 8 }));
    store.execute(assignLivePad(store.doc, set.id, { slot: 5, bufferId: "user.loop-1", name: "Night loop", bpm: 124, loop: true }));
    expect(store.doc.liveSets![0]!.pads).toEqual([
      { slot: 5, bufferId: "user.loop-1", name: "Night loop", bpm: 124, loop: true },
    ]);
    expect(store.doc.liveSets![0]!.loopBars).toBe(8);

    store.execute(duplicateLiveSet(store.doc, set.id));
    const duplicate = store.doc.liveSets![1]!;
    expect(duplicate.id).not.toBe(set.id);
    expect(duplicate.name).toBe("Club loops copy");
    expect(duplicate.pads).toEqual(store.doc.liveSets![0]!.pads);
    store.execute(renameLiveSet(store.doc, duplicate.id, "Festival"));
    store.execute(selectLiveSet(store.doc, set.id));
    expect(store.doc.activeLiveSetId).toBe(set.id);

    store.execute(deleteLiveSet(store.doc, set.id));
    expect(store.doc.liveSets).toHaveLength(1);
    expect(store.doc.activeLiveSetId).toBe(duplicate.id);
    store.undo();
    expect(store.doc.liveSets).toHaveLength(2);
    expect(store.doc.liveSets![0]!.id).toBe(set.id);
  });

  it("normalizes assignments and migrates v37 projects without manufacturing a set", () => {
    const base = createProjectFromTemplate("house");
    const malformed = normalizeProject({
      ...base,
      liveSets: [
        {
          id: "live-set-a",
          name: "  Set A  ",
          trackId: "missing-track",
          loopBars: 3,
          pads: [
            { slot: 0, bufferId: " user.loop-1 ", name: "  Loop  ", bpm: 260, loop: true },
            { slot: 0, bufferId: "user.loop-2", name: "Duplicate slot" },
            { slot: 19, bufferId: "user.loop-3", name: "Out of range" },
          ],
        },
      ],
      activeLiveSetId: "missing-set",
    });
    expect(malformed.liveSets).toEqual([
      {
        id: "live-set-a",
        name: "Set A",
        loopBars: 4,
        pads: [{ slot: 0, bufferId: "user.loop-1", name: "Loop", loop: true }],
      },
    ]);
    expect(malformed.activeLiveSetId).toBe("live-set-a");
    expect(normalizeProject(malformed)).toBe(malformed);

    const old = { ...base, schemaVersion: 37, liveSets: undefined, activeLiveSetId: undefined };
    const migrated = migrateProject(old);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.liveSets).toBeUndefined();
    expect(migrated.activeLiveSetId).toBeUndefined();
  });

  it("keeps Live Pad origin metadata on the editable arrangement audio clip", () => {
    const doc = createProjectFromTemplate("house");
    const trackId = doc.tracks.find((track) => track.kind !== "generative")!.id;
    const next = addAudioClip(doc, trackId, "user.loop-1", 2, 4, {
      loop: true,
      liveSetId: "live-set-a",
      livePadSlot: 7,
    }).execute(doc);
    const clip = next.arrangement.audioClips![0]!;
    expect(clip.liveSetId).toBe("live-set-a");
    expect(clip.livePadSlot).toBe(7);
    expect(normalizeProject(next).arrangement.audioClips![0]).toMatchObject({ liveSetId: "live-set-a", livePadSlot: 7 });
  });
});
