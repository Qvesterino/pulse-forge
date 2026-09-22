import { describe, expect, it } from "vitest";
import {
  addAudioClip,
  addEffect,
  createGenerativeTrack,
  splitAudioClipAtTick,
  updateAudioClip,
} from "../src/commands/commands";
import { createDefaultProject } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";

describe("generated AudioClip workflow", () => {
  it("keeps generated material on the normal trim/split/stretch/reverse/FX path", () => {
    let doc = createDefaultProject();
    doc = createGenerativeTrack(doc).execute(doc);
    const track = doc.tracks.find((candidate) => candidate.kind === "generative");
    if (!track) throw new Error("generative track fixture missing");

    doc = addEffect(doc, track.id, "reverb").execute(doc);
    doc = addAudioClip(doc, track.id, "generated-test-asset", 1, 4).execute(doc);
    const original = doc.arrangement.audioClips?.[0];
    if (!original) throw new Error("generated clip fixture missing");

    doc = updateAudioClip(doc, original.id, {
      trimStart: 0.125,
      trimEnd: 0.25,
      fadeIn: 0.05,
      fadeOut: 0.05,
      stretchMode: "stretch",
      stretchRate: 1.5,
      reverse: true,
    }).execute(doc);
    const edited = doc.arrangement.audioClips?.find((clip) => clip.id === original.id);
    expect(edited).toMatchObject({
      bufferId: "generated-test-asset",
      trimStart: 0.125,
      trimEnd: 0.25,
      stretchMode: "stretch",
      stretchRate: 1.5,
      reverse: true,
    });

    doc = splitAudioClipAtTick(doc, original.id, original.startBar * BAR_TICKS + 2 * BAR_TICKS).execute(doc);
    const split = doc.arrangement.audioClips?.filter((clip) => clip.trackId === track.id) ?? [];
    expect(split).toHaveLength(2);
    expect(split.every((clip) => clip.bufferId === "generated-test-asset")).toBe(true);
    expect(split.every((clip) => clip.reverse)).toBe(true);
    expect(split.every((clip) => clip.stretchRate === 1.5)).toBe(true);
    expect(doc.tracks.find((candidate) => candidate.id === track.id)?.effects).toHaveLength(1);
  });
});
