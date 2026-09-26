import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * DISCO POP (sub-genre wave) — nu-disco / disco-pop: the octave-bass grooves
 * of the Future Nostalgia / Padam / Le Freak school. Rides house.disco (new
 * groove), parser phrases (disco / nu-disco / disko → house + style disco)
 * and four researched artists (Kylie, Bee Gees, Chic, Jessie Ware).
 */

describe("house.disco groove", () => {
  const disco = getGrooveById("house.disco");

  it("exists with the disco character", () => {
    expect(disco).toBeDefined();
    expect(disco!.genre).toBe("house");
    expect(disco!.name).toBe("Disco");
    expect(disco!.bpm).toEqual([112, 124]);
    // disco lilt — swung, not straight
    expect(disco!.swing).toBeGreaterThan(0.05);
  });

  it("patterns are well-formed 16-step rows over kit pads", () => {
    expect(disco!.patterns.length).toBeGreaterThanOrEqual(3);
    for (const pattern of disco!.patterns) {
      for (const [pad, row] of Object.entries(pattern)) {
        expect(Number(pad)).toBeLessThanOrEqual(15); // default kit pad ceiling
        expect(row).toHaveLength(16);
        expect(row.some((v) => v > 0)).toBe(true);
      }
    }
  });

  it("style 'disco' resolves to it deterministically", () => {
    expect(resolveGroove("house", "disco").id).toBe("house.disco");
    expect(resolveGroove("house", "Disco").id).toBe("house.disco");
  });

  it("does not disturb existing house grooves", () => {
    expect(resolveGroove("house", "pop").id).toBe("house.pop");
    expect(resolveGroove("house", "funky").id).toBe("house.funky");
  });
});

describe("disco parser phrases", () => {
  it("nu-disco / disco pop / disko route to house with the disco style", () => {
    for (const text of ["nu-disco", "nu disco banger", "disco pop at 120", "popové disco", "disko na 118"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("disco");
    }
  });

  it("disco funk stays disco (not stolen by the funky style)", () => {
    const parsed = parseIntentText("disco funk groove");
    expect(parsed.input.genre).toBe("house");
    expect(parsed.input.style).toBe("disco");
  });

  it("bare disco resolves, generic pop unchanged", () => {
    expect(parseIntentText("disco").input.style).toBe("disco");
    const plain = parseIntentText("pop at 122");
    expect(plain.input.genre).toBe("house");
    expect(plain.input.style).toBe("pop");
  });
});

describe("disco pop artists", () => {
  it("kylie / bee gees / chic / jessie ware resolve with researched ranges", () => {
    const kylie = matchArtistPreset("kylie minogue type beat");
    expect(kylie?.preset.label).toBe("kylie minogue");
    expect(kylie?.preset.style).toBe("disco");
    expect(kylie?.preset.bpmRange).toEqual([115, 128]);

    const gees = matchArtistPreset("bee gees type beat");
    expect(gees?.preset.bpmRange).toEqual([100, 110]);

    const chic = matchArtistPreset("nile rodgers groove");
    expect(chic?.preset.label).toBe("chic");
    expect(chic?.preset.bpmRange).toEqual([115, 125]);

    const ware = matchArtistPreset("jessie ware");
    expect(ware?.preset.style).toBe("disco");
    expect(ware?.preset.bpmRange).toEqual([108, 124]);
  });

  it("sophie still resolves to PC Music (no ellis-bextor collision)", () => {
    expect(matchArtistPreset("sophie type beat")?.preset.label).toBe("sophie");
  });
});
