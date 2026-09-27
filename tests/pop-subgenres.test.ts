import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset, parseVibeBlend } from "../src/intent/artists";

/**
 * POP SUB-GENRES (country pop / afro-pop / latin pop) + COMBINATIONS —
 * three dedicated house grooves (countrypop train beat, afropop 3+3+2,
 * dembow chop), parser phrases (incl. SK stems) and researched artists.
 * The combinations block pins that sub-genre × disco word mixes and
 * cross-lane artist blends resolve sensibly.
 */

describe("sub-genre grooves", () => {
  it("afropop is the pop pocket, distinct from afro house", () => {
    const afropop = getGrooveById("house.afropop");
    const afrohouse = getGrooveById("house.afro");
    expect(afropop).toBeDefined();
    expect(afropop!.bpm).toEqual([98, 112]);
    expect(afrohouse!.bpm![0]).toBeGreaterThan(afropop!.bpm![1]); // afro house is club-side
    expect(resolveGroove("house", "afropop").id).toBe("house.afropop");
    expect(resolveGroove("house", "afro").id).toBe("house.afro");
  });

  it("dembow carries the chop at latin-pop tempo", () => {
    const dembow = getGrooveById("house.dembow");
    expect(dembow).toBeDefined();
    expect(dembow!.bpm).toEqual([88, 100]);
    expect(resolveGroove("house", "dembow").id).toBe("house.dembow");
  });

  it("countrypop is the train beat at 96-126", () => {
    const country = getGrooveById("house.countrypop");
    expect(country).toBeDefined();
    expect(country!.bpm).toEqual([96, 126]);
    expect(resolveGroove("house", "countrypop").id).toBe("house.countrypop");
  });

  it("all three are well-formed over the default kit", () => {
    for (const id of ["house.afropop", "house.dembow", "house.countrypop"]) {
      const groove = getGrooveById(id)!;
      expect(groove.patterns.length).toBeGreaterThanOrEqual(3);
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

describe("sub-genre parser phrases", () => {
  it("afro pop / afrobeats ride the pop pocket", () => {
    for (const text of ["afro pop", "afropop", "afrobeats", "afrobeats pop"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("afropop");
    }
  });

  it("reggaeton / latin pop ride the dembow chop (incl. SK)", () => {
    for (const text of ["reggaeton", "reggaeton pop", "latin pop", "pop latino", "latinský pop", "dembow"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("dembow");
    }
  });

  it("country pop rides the train beat (bare country keeps legacy)", () => {
    for (const text of ["country pop", "pop country", "countrypop", "nashville pop"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("countrypop");
    }
    const trapCountry = parseIntentText("country trap");
    expect(trapCountry.input.genre).toBe("trap");
  });

  it("existing lanes stay put: afro house, afroswing, amapiano style", () => {
    expect(parseIntentText("afro house").input.style).toBe("afro");
    expect(parseIntentText("afro swing").input.style).toBe("afroswing");
  });
});

describe("sub-genre combinations", () => {
  it("× disco mixes resolve to the disco groove (style order wins)", () => {
    for (const text of ["afro disco", "country disco", "latin disco", "disco country"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("disco");
    }
  });

  it("afro pop × disco: disco wins (global style order — any 'X disco' is disco)", () => {
    // Deliberate precedence: the disco entry sits above the afro family, so
    // every "<sub-genre> disco" compound resolves to the disco groove. That
    // keeps word-mix behavior PREDICTABLE (the last-named flavor wins) —
    // pinned so a reorder is a conscious decision, not an accident.
    const parsed = parseIntentText("afro pop disco");
    expect(parsed.input.style).toBe("disco");
  });

  it("cross-lane artist blends resolve with A's lane + blended sliders", () => {
    // disco × dembow
    const blend = parseVibeBlend("kylie minogue stretne shakira");
    expect(blend).not.toBeNull();
    expect(blend!.presetA.label).toBe("kylie minogue");
    expect(blend!.presetB.label).toBe("shakira");
    // country × afropop
    const blend2 = parseVibeBlend("shania twain mixed with burna boy");
    expect(blend2?.presetA.label).toBe("shania twain");
    expect(blend2?.presetB.label).toBe("afrobeats");
  });
});

describe("sub-genre artists", () => {
  it("country pop quartet resolves with researched ranges", () => {
    expect(matchArtistPreset("shania twain type beat")?.preset.bpmRange).toEqual([96, 122]);
    expect(matchArtistPreset("kacey musgraves")?.preset.style).toBe("countrypop");
    expect(matchArtistPreset("the chicks type beat")?.preset.bpmRange).toEqual([100, 130]);
    expect(matchArtistPreset("carrie underwood")?.preset.style).toBe("countrypop");
  });

  it("latin pop quartet resolves on the dembow lane", () => {
    expect(matchArtistPreset("shakira type beat")?.preset.bpmRange).toEqual([92, 105]);
    expect(matchArtistPreset("karol g")?.preset.style).toBe("dembow");
    expect(matchArtistPreset("despacito")?.preset.label).toBe("luis fonsi");
    expect(matchArtistPreset("rauw alejandro")?.preset.bpmRange).toEqual([90, 104]);
  });

  it("existing lanes upgraded: afrobeats → afropop, latin urban → dembow", () => {
    const afrobeats = matchArtistPreset("burna boy type beat")!;
    expect(afrobeats.preset.label).toBe("afrobeats");
    expect(afrobeats.preset.style).toBe("afropop");
    expect(afrobeats.preset.bpmRange).toEqual([100, 112]);

    const latin = matchArtistPreset("j balvin type beat")!;
    expect(latin.preset.label).toBe("latin urban");
    expect(latin.preset.style).toBe("dembow");
  });

  it("amapiano lane rides its own log drum genre", () => {
    const amapiano = matchArtistPreset("amapiano")!;
    expect(amapiano.preset.label).toBe("amapiano");
    // promoted from the house lane when the amapiano genre landed
    expect(amapiano.preset.genre).toBe("amapiano");
    expect(amapiano.preset.style).toBe("yanos");
  });
});
