import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * KUDURO/BATIDA + TROPICAL (researched wave) — the Luanda carnival engine
 * (upbeat driving kick with frantic syncopated percussion; the rap rides
 * HALF-TIME on top as melody, 130-140) and the beach lane (a soft
 * four-floor under light claps and steel-pan pings, 100-110).
 */

describe("kuduro + tropical grooves", () => {
  it("kuduro drives the upbeat carnival floor", () => {
    const kuduro = getGrooveById("house.kuduro")!;
    expect(kuduro).toBeDefined();
    expect(kuduro.bpm).toEqual([130, 140]);
    // upbeat driving kick — the four-floor grid holds (the half-time rap is
    // melodic content, not a drum pattern)
    for (const pattern of kuduro.patterns) {
      expect(kuduro.patterns.length).toBeGreaterThanOrEqual(3);
      expect((pattern[0] ?? []).some((v) => v > 0)).toBe(true);
    }
    expect(kuduro.activePads).toContain(15); // the carnival blip
    expect(resolveGroove("house", "kuduro").id).toBe("house.kuduro");
    // "batida" maps to the kuduro style at the parser level
    expect(parseIntentText("batida").input.style).toBe("kuduro");
  });

  it("tropical is the soft beach pocket below the club lanes", () => {
    const tropical = getGrooveById("house.tropical")!;
    const dancefloor = getGrooveById("house.dancefloor")!;
    expect(tropical).toBeDefined();
    expect(tropical.bpm).toEqual([100, 110]);
    expect(tropical.bpm![0]).toBeLessThan(dancefloor.bpm![0]);
    // gentle kick — the beach lane never bangs
    for (const pattern of tropical.patterns) {
      for (const velocity of pattern[0] ?? []) {
        expect(velocity).toBeLessThanOrEqual(0.75);
      }
    }
    expect(tropical.activePads).toContain(15); // the steel-pan ping
    expect(resolveGroove("house", "tropical").id).toBe("house.tropical");
  });

  it("both grooves are well-formed over the default kit", () => {
    for (const id of ["house.kuduro", "house.tropical"]) {
      const groove = getGrooveById(id)!;
      expect(groove.patterns.length, id).toBeGreaterThanOrEqual(3);
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

describe("kuduro + tropical parser", () => {
  it("kuduro / batida / tropical route to their lanes", () => {
    expect(parseIntentText("kuduro").input).toMatchObject({ genre: "house", style: "kuduro" });
    expect(parseIntentText("batida").input.style).toBe("kuduro");
    expect(parseIntentText("tropical house").input).toMatchObject({ genre: "house", style: "tropical" });
    expect(parseIntentText("tropical").input.style).toBe("tropical");
  });

  it("neighbours stay put", () => {
    expect(parseIntentText("gqom").input.style).toBe("gqom");
    expect(parseIntentText("afro house").input.style).toBe("afro");
    expect(parseIntentText("afropop").input.style).toBe("afropop");
  });
});

describe("kuduro + tropical artists", () => {
  it("the Lisbon + beach lanes resolve", () => {
    expect(matchArtistPreset("buraka som sistema")?.preset).toMatchObject({
      style: "kuduro",
      bpmRange: [130, 140],
    });
    expect(matchArtistPreset("kygo")?.preset).toMatchObject({ style: "tropical", bpmRange: [100, 110] });
    expect(matchArtistPreset("klingande")?.preset.style).toBe("tropical");
    expect(matchArtistPreset("matoma")?.preset.bpmRange).toEqual([100, 110]);
  });
});
