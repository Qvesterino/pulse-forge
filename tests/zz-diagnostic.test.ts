import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip, splitAudioClipAtTick, duplicateAudioClip } from "../src/commands/commands";
import { ticksPerBar } from "../src/project-model/schema";

describe("diagnostic", () => {
  it("shows the short-fragment chain", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4));
    console.log(
      "after add:",
      store.doc.arrangement.audioClips!.map((c) => ({ id: c.id, s: c.startBar, l: c.lengthBars })),
    );

    store.execute(
      splitAudioClipAtTick(store.doc, store.doc.arrangement.audioClips![0]!.id, 0.05 * ticksPerBar(store.doc)),
    );
    console.log(
      "after split:",
      store.doc.arrangement.audioClips!.map((c) => ({ id: c.id, s: c.startBar, l: c.lengthBars })),
    );

    const frag = store.doc.arrangement.audioClips!.find((c) => c.lengthBars < 0.25)!;
    console.log("fragment:", { id: frag.id, s: frag.startBar, l: frag.lengthBars });

    const before = store.doc;
    store.execute(duplicateAudioClip(store.doc, frag.id));
    console.log(
      "after duplicate:",
      store.doc.arrangement.audioClips!.map((c) => ({ id: c.id, s: c.startBar, l: c.lengthBars })),
    );
    const beforeIds = new Set((before.arrangement.audioClips ?? []).map((c) => c.id));
    const added = (store.doc.arrangement.audioClips ?? []).filter((c) => !beforeIds.has(c.id));
    console.log(
      "added:",
      added.map((c) => ({ id: c.id, s: c.startBar, l: c.lengthBars })),
    );
    expect(true).toBe(true);
  });
});
