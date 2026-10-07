import { describe, it } from "vitest";
import { createProjectFromTemplate, normalizeProject } from "../src/project-model/schema";
import { addAudioClip } from "../src/commands/commands";

describe("mu3 probe", () => {
  it("what keys does normalize leave on an unmuted clip", () => {
    const base = createProjectFromTemplate("house");
    const doc = addAudioClip(base, base.tracks[0].id, "buf-1", 0, 2).execute(base);
    const raw = doc.arrangement.audioClips![0]!;
    console.log("raw keys has muted:", "muted" in raw, JSON.stringify(Object.keys(raw)));
    const normalized = normalizeProject(doc);
    const clip = normalized.arrangement.audioClips![0]!;
    console.log("normalized has muted:", "muted" in clip, "value:", (clip as { muted?: unknown }).muted);
    console.log("normalized keys:", JSON.stringify(Object.keys(clip)));
  });
});
