import { describe, it, expect } from "vitest";
import { GENRES } from "../src/ai/types";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { parseIntentText } from "../src/intent/text-parser";
import { planSongForm } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { GENRE_KIT_SWAPS, GENRE_FEEL } from "../src/intent/genre-kit";
import { planMixProfile } from "../src/intent/mix";
import { selectProgression } from "../src/ai/harmony";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { resolveGroove } from "../src/ai/generator";

/**
 * First-class genre promotion: hyperpop (the maximalist 140-170 lane that
 * lived in trap.hyper) and ukg (the swung 130-140 2-step lane that lived in
 * house.ukg). A promoted genre must be complete: grooves that resolve, a song
 * form, a BPM default, parser routing, kit colouring, feel, mix character and
 * harmony - otherwise it is a label, not a genre.
 */

describe("first-class genre promotion (hyperpop + ukg)", () => {
  it("GENRES carries both promoted genres", () => {
    expect(GENRES).toContain("hyperpop");
    expect(GENRES).toContain("ukg");
  });

  it("each promoted genre owns real grooves with unique ids", () => {
    for (const genre of ["hyperpop", "ukg"] as const) {
      const grooves = getGroovesForGenre(genre);
      expect(grooves.length, genre).toBeGreaterThanOrEqual(3);
      for (const groove of grooves) {
        expect(groove.genre, groove.id).toBe(genre);
        expect(groove.patterns.length).toBeGreaterThan(0);
        for (const pattern of groove.patterns) {
          for (const row of Object.values(pattern)) {
            expect(row).toHaveLength(16);
          }
        }
      }
      const ids = grooves.map((g) => g.id);
      expect(new Set(ids).size, `${genre} unique ids`).toBe(ids.length);
    }
  });

  it("every promoted style resolves through resolveGroove by id and by name", () => {
    for (const genre of ["hyperpop", "ukg"] as const) {
      for (const groove of getGroovesForGenre(genre)) {
        expect(getGrooveById(groove.id), groove.id).toBeDefined();
        const byId = resolveGroove(genre, groove.id.slice(genre.length + 1), () => 0);
        expect(byId.id, groove.id).toBe(groove.id);
        const byName = resolveGroove(genre, groove.name.toLowerCase(), () => 0);
        expect(byName.id, groove.name).toBe(groove.id);
      }
    }
  });

  it("parser routes the genre words to the promoted genres", () => {
    expect(parseIntentText("hyperpop beat").input.genre).toBe("hyperpop");
    expect(parseIntentText("hyper pop beat").input.genre).toBe("hyperpop");
    expect(parseIntentText("deconstructed club at 155").input.genre).toBe("hyperpop");
    expect(parseIntentText("ukg beat").input.genre).toBe("ukg");
    expect(parseIntentText("2-step garage at 132").input.genre).toBe("ukg");
    expect(parseIntentText("speed garage at 134").input.genre).toBe("ukg");
    expect(parseIntentText("bassline house at 136").input.genre).toBe("ukg");
    // guards: bare "hyper" stays a style word, dnb two-step keeps dnb
    expect(parseIntentText("hyper drill at 155").input.genre).toBe("drill");
    expect(parseIntentText("hyper trap at 150").input.genre).toBe("trap");
    expect(parseIntentText("two step dnb at 174").input.genre).toBe("dnb");
  });

  it("each promoted genre has a song form and a BPM default", () => {
    const hyper = planSongForm(normalizeIntent({ genre: "hyperpop", seed: "promo" }));
    const ukg = planSongForm(normalizeIntent({ genre: "ukg", seed: "promo" }));
    expect(hyper.sections.length).toBeGreaterThanOrEqual(4);
    expect(ukg.sections.length).toBeGreaterThanOrEqual(4);
    // hyperpop is drop-first: the intro IS a drop
    expect(hyper.sections[0].label.toLowerCase()).toContain("drop");
    // ukg is a groove form: no "drop" labels
    expect(ukg.sections.some((s) => s.label.toLowerCase().includes("drop"))).toBe(false);
  });

  it("each promoted genre has kit colouring, feel and mix character", () => {
    expect(GENRE_KIT_SWAPS.hyperpop?.length).toBeGreaterThan(0);
    expect(GENRE_KIT_SWAPS.ukg?.length).toBeGreaterThan(0);
    expect(GENRE_FEEL.hyperpop).toBeDefined();
    expect(GENRE_FEEL.ukg).toBeDefined();

    // Kit swaps must reference assets that exist (coherence, like the other waves)
    for (const genre of ["hyperpop", "ukg"] as const) {
      for (const swap of GENRE_KIT_SWAPS[genre] ?? []) {
        expect(
          FACTORY_ASSETS.some((a) => a.id === swap.assetId),
          `${genre} pad ${swap.index} asset ${swap.assetId}`,
        ).toBe(true);
      }
    }

    // Mix: ukg pumps at dance energy, hyperpop stays dry
    const ukgMix = planMixProfile(normalizeIntent({ genre: "ukg", seed: "promo", energy: 0.8 }));
    expect(ukgMix.summary.some((s) => s.startsWith("pump:"))).toBe(true);
  });

  it("each promoted genre has harmony progressions", () => {
    for (const genre of ["hyperpop", "ukg"] as const) {
      const progression = selectProgression(genre, 0);
      expect(progression.genre, genre).toBe(genre);
      expect(progression.events.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("style names for each promoted genre are non-empty", () => {
    for (const genre of ["hyperpop", "ukg"] as const) {
      expect(getStyleNamesForGenre(genre).length, genre).toBeGreaterThanOrEqual(3);
    }
  });
});
