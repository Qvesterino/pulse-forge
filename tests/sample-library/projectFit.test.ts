import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { projectSoundContext, rankByProjectSoundFit, scoreProjectSoundFit } from "../../src/sample-library/projectFit";

describe("project sound fit", () => {
  it("uses saved brief, project tags, effective BPM, and key without treating unknowns as mismatches", () => {
    const doc = createProjectFromTemplate("house");
    doc.tags = ["techno"];
    doc.key = "A Natural Minor";
    doc.producerBrief = {
      version: 1,
      savedAt: "2026-10-24T00:00:00.000Z",
      facts: [
        { field: "genre", section: "preference", value: "house", origin: "user", confidence: "confirmed" },
        { field: "mood", section: "preference", value: "dark", origin: "user", confidence: "confirmed" },
      ],
    };
    const context = projectSoundContext(doc, 126);

    expect(context.genreTokens).toEqual(new Set(["techno", "house"]));
    expect(context.moodTokens).toEqual(new Set(["dark"]));
    expect(context.bpm).toBe(126);
    expect(context.keyRoot).toBe("A");

    const score = scoreProjectSoundFit(
      { genres: ["house"], moods: ["dark"], bpmRange: { min: 120, max: 130 }, key: "Am" },
      context,
    );
    expect(score).toBe(9);
    expect(scoreProjectSoundFit({}, context)).toBe(0);
  });

  it("ranks compatible sounds first and retains every unknown or incompatible result", () => {
    const doc = createProjectFromTemplate("house");
    doc.tags = ["house"];
    const context = projectSoundContext(doc, 124);
    const sounds = [
      { id: "unknown", descriptor: {} },
      { id: "far", descriptor: { genres: ["dnb"], bpm: 170 } },
      { id: "fit", descriptor: { genres: ["house"], moods: ["deep"], bpmRange: { min: 120, max: 128 } } },
    ];

    const ranked = rankByProjectSoundFit(sounds, (sound) => sound.descriptor, context);
    expect(ranked.map((sound) => sound.id)).toEqual(["fit", "unknown", "far"]);
    expect(ranked).toHaveLength(sounds.length);
  });
});
