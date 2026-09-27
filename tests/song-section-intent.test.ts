import { describe, expect, it } from "vitest";
import { normalizeIntent } from "../src/intent/normalize";
import { createSongSectionIntent } from "../src/intent/song-section-intent";

describe("createSongSectionIntent", () => {
  it("changes only section-owned fields and preserves full producer conditioning", () => {
    const base = normalizeIntent({
      genre: "trap",
      style: "rolling",
      productionProfile: "spacey-dark-trap",
      artist: "travis scott",
      flow: "triplet",
      mood: "dark",
      text: "travis scott type beat, triplet flow, dark cinematic synths",
      energy: 0.72,
      density: 0.51,
      complexity: 0.46,
      variation: 0.38,
      seed: "same-producer-brief",
      key: "C Natural Minor",
      bpmRange: [130, 140],
      candidateCount: 2,
      symbolicCandidates: 1,
      roles: ["drums", "bass", "chords", "lead"],
      preserve: ["bass"],
      targetTracks: { drumTrackId: "drum-track", instrumentTrackIds: ["lead-track"] },
      constraints: { preserveAnchors: true, allowGhosts: false, allowSwing: true },
      controls: { ghostWeight: 0.6, microWeight: 0.3, velocityVariation: 0.7, temperature: 0.8 },
      sourcePatternId: "source-pattern",
    });

    const section = createSongSectionIntent(base, {
      index: 3,
      role: "chorus",
      bars: 8,
      energy: 0.94,
      density: 0.62,
      complexity: 0.7,
      candidateCount: 3,
      roles: ["drums", "chords", "lead"],
    });

    expect(section).toMatchObject({
      genre: "trap",
      style: "rolling",
      productionProfile: "spacey-dark-trap",
      artist: "travis scott",
      flow: "triplet",
      mood: "dark",
      text: "travis scott type beat, triplet flow, dark cinematic synths",
      energy: 0.94,
      density: 0.62,
      complexity: 0.7,
      variation: 0.38,
      seed: "same-producer-brief|song:3:chorus",
      key: "C Natural Minor",
      bpmRange: [130, 140],
      length: 128,
      candidateCount: 3,
      symbolicCandidates: 1,
      roles: ["drums", "chords", "lead"],
      preserve: ["bass"],
      targetTracks: { drumTrackId: "drum-track", instrumentTrackIds: ["lead-track"] },
      constraints: { preserveAnchors: true, allowGhosts: false, allowSwing: true },
      controls: { ghostWeight: 0.6, microWeight: 0.3, velocityVariation: 0.7, temperature: 0.8 },
      sourcePatternId: "source-pattern",
    });
  });
});
