import { describe, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { addArrangementClip, addAudioClip, deleteArrangementClip, groupClips, splitArrangementClipAtTick } from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";

describe("probe split undo", () => {
  it("probe", () => {
    let doc = createProjectFromTemplate("house");
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addAudioClip(doc, trackId, "buf-a", 0, 2).execute(doc);
    const arrId = doc.arrangement.clips[0]!.id;
    const audioId = (doc.arrangement.audioClips ?? [])[0]!.id;

    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    console.log("after group:", JSON.stringify(store.doc.arrangement.clipGroups));
    store.execute(splitArrangementClipAtTick(store.doc, arrId, 2 * BAR_TICKS));
    console.log("after split:", JSON.stringify(store.doc.arrangement.clipGroups));

    const cmd = splitArrangementClipAtTick(store.doc, arrId, 2 * BAR_TICKS);
    const undoneRaw = cmd.undo(store.doc);
    console.log("undone RAW groups:", JSON.stringify(undoneRaw.arrangement.clipGroups));
    const undoneNormalized = normalizeProject(undoneRaw);
    console.log("undone NORMALIZED groups:", JSON.stringify(undoneNormalized.arrangement.clipGroups));
    console.log("undone NORMALIZED clips:", JSON.stringify(undoneNormalized.arrangement.clips.map((c) => c.id)));

    store.undo();
    console.log("STORE after undo groups:", JSON.stringify(store.doc.arrangement.clipGroups));
    console.log("STORE after undo clips:", JSON.stringify(store.doc.arrangement.clips.map((c) => c.id)));
  });
});
