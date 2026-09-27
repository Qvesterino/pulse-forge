import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { planSongForm } from "../src/intent/song";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * ROCK LANES — grunge, alternative rock, rapcore/nu metal and synth punk as
 * house-family grooves with the rock-radio SONG FORM (verse / pre-chorus /
 * chorus / bridge via ROCK_FORM_STYLES — a grunge song must not get the
 * club intro/build/drop shape). Reggaeton itself already ships as
 * house.dembow / house.dembowdom.
 */

describe("rock grooves", () => {
  const cases: Array<[string, string, [number, number]]> = [
    ["house.grunge", "Grunge", [95, 125]],
    ["house.altrock", "Alt Rock", [85, 125]],
    ["house.rapcore", "Rapcore", [90, 120]],
    ["house.synthpunk", "Synth Punk", [140, 168]],
  ];

  it("all four exist with researched pockets", () => {
    for (const [id, name, bpm] of cases) {
      const groove = getGrooveById(id);
      expect(groove, id).toBeDefined();
      expect(groove!.name, id).toBe(name);
      expect(groove!.bpm, id).toEqual(bpm);
    }
  });

  it("every rock groove is a backbeat (snare 2+4), not a dance floor", () => {
    for (const [id] of cases) {
      const groove = getGrooveById(id)!;
      const snarePads = [4, 5, 6]; // snare / snare tight / clap family
      const first = groove.patterns[0]!;
      const backbeat = snarePads.some((pad) => (first[pad]?.[4] ?? 0) > 0 && (first[pad]?.[12] ?? 0) > 0);
      expect(backbeat, `${id} must hit the 2+4 backbeat`).toBe(true);
    }
  });

  it("styles resolve deterministically", () => {
    expect(resolveGroove("house", "grunge").id).toBe("house.grunge");
    expect(resolveGroove("house", "altrock").id).toBe("house.altrock");
    expect(resolveGroove("house", "rapcore").id).toBe("house.rapcore");
    expect(resolveGroove("house", "synthpunk").id).toBe("house.synthpunk");
  });

  it("well-formed over the default kit", () => {
    for (const [id] of cases) {
      const groove = getGrooveById(id)!;
      for (const pattern of groove.patterns) {
        for (const [pad, row] of Object.entries(pattern)) {
          expect(Number(pad), id).toBeLessThanOrEqual(15);
          expect(row).toHaveLength(16);
          expect(
            row.some((v) => v > 0),
            id,
          ).toBe(true);
        }
      }
    }
  });
});

describe("rock parser", () => {
  it("grunge / alt rock / rapcore / synth punk route to their lanes", () => {
    expect(parseIntentText("grunge").input).toMatchObject({ genre: "house", style: "grunge" });
    expect(parseIntentText("alt rock").input).toMatchObject({ genre: "house", style: "altrock" });
    expect(parseIntentText("alternative rock").input.style).toBe("altrock");
    expect(parseIntentText("rapcore").input).toMatchObject({ genre: "house", style: "rapcore" });
    expect(parseIntentText("nu metal").input.style).toBe("rapcore");
    expect(parseIntentText("synth punk").input).toMatchObject({ genre: "house", style: "synthpunk" });
  });

  it("existing lanes stay put", () => {
    // post-punk keeps its techno routing; reggaeton keeps the dembow lane
    expect(parseIntentText("post-punk").input.genre).toBe("techno");
    expect(parseIntentText("reggaeton").input.style).toBe("dembow");
    expect(parseIntentText("pop punk").input.style).not.toBe("synthpunk");
  });
});

describe("rock song form", () => {
  it("rock styles get the verse / pre-chorus / chorus radio form", () => {
    for (const style of ["grunge", "altrock", "rapcore", "synthpunk"]) {
      const form = planSongForm(normalizeIntent({ genre: "house", style, seed: "rock-form" }));
      const labels = form.sections.map((s) => s.label);
      expect(labels, style).toContain("Pre-Chorus");
      expect(labels.filter((label) => label.startsWith("Chorus")).length, style).toBeGreaterThanOrEqual(2);
      // never the club build/drop shape
      expect(
        labels.some((label) => /DROP|BUILD A/.test(label)),
        style,
      ).toBe(false);
    }
  });
});

describe("rock artists", () => {
  it("grunge + alt rock resolve", () => {
    expect(matchArtistPreset("nirvana type beat")?.preset).toMatchObject({ style: "grunge", bpmRange: [95, 125] });
    expect(matchArtistPreset("pearl jam")?.preset.style).toBe("grunge");
    expect(matchArtistPreset("radiohead")?.preset.style).toBe("altrock");
    expect(matchArtistPreset("weezer")?.preset.bpmRange).toEqual([95, 130]);
  });

  it("rapcore + synth punk resolve", () => {
    expect(matchArtistPreset("rage against the machine type beat")?.preset).toMatchObject({
      style: "rapcore",
      bpmRange: [90, 110],
    });
    expect(matchArtistPreset("linkin park")?.preset.style).toBe("rapcore");
    expect(matchArtistPreset("the units")?.preset).toMatchObject({ style: "synthpunk", bpmRange: [140, 168] });
    expect(matchArtistPreset("the faint")?.preset.style).toBe("synthpunk");
  });
});
