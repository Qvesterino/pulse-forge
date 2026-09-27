import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * AMAPIANO + ORGANIC HOUSE (researched wave) — the log drum genre gets its
 * own groove (quiet four-floor + semiquaver shaker + syncopated log-drum
 * toms, 110-116) instead of riding the afro-house pocket, and the
 * Anjunadeep/Keinemusik organic wave lands beside it (hand-drum hypnotia,
 * 118-124). Private school piano is the refined amapiano sub-style.
 */

describe("amapiano + organic grooves", () => {
  it("amapiano carries the log drum answer on the toms", () => {
    const piano = getGrooveById("amapiano.yanos")!;
    expect(piano).toBeDefined();
    expect(piano.bpm).toEqual([110, 116]);
    // quiet kick (never above 0.8 — the floor sits UNDER the log drum)
    for (const pattern of piano.patterns) {
      for (const velocity of pattern[0] ?? []) {
        expect(velocity).toBeLessThanOrEqual(0.8);
      }
    }
    // the log drum lives on the toms (12 low / 13 high)
    expect(piano.activePads).toContain(12);
    expect(resolveGroove("amapiano", "yanos").id).toBe("amapiano.yanos");
  });

  it("organic house is its own pocket beside afro house", () => {
    const organic = getGrooveById("house.organic")!;
    const afro = getGrooveById("house.afro")!;
    expect(organic).toBeDefined();
    expect(organic.bpm).toEqual([118, 124]);
    expect(organic.swing).not.toBe(afro.swing); // a different lilt, not a copy
    expect(resolveGroove("house", "organic").id).toBe("house.organic");
    expect(resolveGroove("house", "afro").id).toBe("house.afro");
  });

  it("both grooves are well-formed over the default kit", () => {
    for (const id of ["amapiano.yanos", "house.organic"]) {
      const groove = getGrooveById(id)!;
      expect(groove.patterns.length, id).toBeGreaterThanOrEqual(1);
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

describe("amapiano + organic parser", () => {
  it("amapiano / private school piano ride the dedicated groove", () => {
    for (const text of ["amapiano", "private school piano"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("amapiano");
    }
    expect(parseIntentText("amapiano").input.style).toBe("yanos");
    // "private school piano" is the soulful school now (Kelvin Momo).
    expect(parseIntentText("private school piano").input.style).toBe("soulful");
  });

  it("organic house resolves; bare organic ambient stays ambient", () => {
    expect(parseIntentText("organic house").input).toMatchObject({ genre: "house", style: "organic" });
    expect(parseIntentText("organic ambient").input.genre).toBe("ambient");
    // the classic afro house lane stays put
    expect(parseIntentText("afro house").input.style).toBe("afro");
  });
});

describe("amapiano + organic artists", () => {
  it("the amapiano lane rides its own genre now", () => {
    expect(matchArtistPreset("amapiano")?.preset.genre).toBe("amapiano");
    expect(matchArtistPreset("amapiano")?.preset.style).toBe("yanos");
    expect(matchArtistPreset("amapiano")?.preset.bpmRange).toEqual([110, 116]);
  });

  it("log drum / private school / organic artists resolve", () => {
    expect(matchArtistPreset("mdu aka mas")?.preset).toMatchObject({ genre: "amapiano", bpmRange: [110, 116] });
    expect(matchArtistPreset("mfr souls")?.preset.genre).toBe("amapiano");
    expect(matchArtistPreset("daliwonga")?.preset.genre).toBe("amapiano");
    expect(matchArtistPreset("adam port")?.preset).toMatchObject({ style: "organic", bpmRange: [120, 124] });
    expect(matchArtistPreset("hugel")?.preset.style).toBe("organic");
  });

  it("keinemusik upgraded to organic; black coffee stays afro house", () => {
    expect(matchArtistPreset("keinemusik")?.preset.style).toBe("organic");
    expect(matchArtistPreset("black coffee")?.preset.style).toBe("afro");
  });
});
