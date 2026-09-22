import { describe, expect, it } from "vitest";
import { addAudioClip, createGenerativeTrack } from "../src/commands/commands";
import { createDefaultProject } from "../src/project-model/schema";
import { assertGenerativeExportSources } from "../src/rendering/renderer";

function fixture() {
  const base = createDefaultProject();
  const doc = createGenerativeTrack(base).execute(base);
  const track = doc.tracks.find((candidate) => candidate.kind === "generative");
  if (!track || track.kind !== "generative") throw new Error("missing generative track");
  return { doc, track };
}

function bank(ids: string[]) {
  return { has: (id: string | null) => id !== null && ids.includes(id) } as never;
}

describe("generative offline export boundary", () => {
  it("refuses a live provider track without a captured clip", () => {
    const { doc } = fixture();
    expect(() => assertGenerativeExportSources(doc, bank([]))).toThrow(/Capture the track/u);
  });

  it("accepts a captured clip only when its durable asset is present", () => {
    const { doc, track } = fixture();
    const next = addAudioClip(doc, track.id, "generated-take-1", 0, 4).execute(doc);
    expect(() => assertGenerativeExportSources(next, bank(["generated-take-1"]))).not.toThrow();
    expect(() => assertGenerativeExportSources(next, bank([]))).toThrow(/missing audio asset/u);
  });

  it("allows a muted generative track to export without a provider take", () => {
    const { doc, track } = fixture();
    const muted = {
      ...doc,
      tracks: doc.tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, mute: true } : candidate)),
    };
    expect(() => assertGenerativeExportSources(muted, bank([]))).not.toThrow();
  });
});
