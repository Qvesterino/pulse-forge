import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip } from "../src/commands/commands";

describe("D", () => {
  it("prints", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    console.log("before:", JSON.stringify(store.doc.arrangement.audioClips));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0].id, "factory.kick", 0, 4));
    console.log(
      "after:",
      JSON.stringify(store.doc.arrangement.audioClips?.map((c) => ({ id: c.id, track: c.trackId, buf: c.bufferId, start: c.startBar }))),
    );
    console.log("tracks:", JSON.stringify(store.doc.tracks.map((t) => t.id)));
    expect(true).toBe(true);
  });
});
