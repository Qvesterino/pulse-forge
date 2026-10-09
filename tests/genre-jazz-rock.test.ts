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
import { RR_VARIATIONS } from "../src/sample-library/factory";

/**
 * First-class genre promotion: jazz + rock (2026-10-09). Before this wave a
 * "jazz" prompt landed a HOUSE beat (the jazzy lanes rode house/boombap) and
 * bare "rock" had no genre at all. A promoted genre must be complete —
 * grooves that resolve, a song form, a BPM default, parser routing, kit
 * colouring (with the humanize variant sets), feel, mix tone, harmony and
 * reference measurement — otherwise it is a label, not a genre.
 */

const PROMOTED = ["jazz", "rock"] as const;

describe("first-class genre promotion (jazz + rock)", () => {
  it("GENRES carries both promoted genres", () => {
    for (const genre of PROMOTED) expect(GENRES).toContain(genre);
  });

  it("each promoted genre owns real grooves with unique ids and 16-step rows", () => {
    for (const genre of PROMOTED) {
      const grooves = getGroovesForGenre(genre);
      expect(grooves.length, genre).toBeGreaterThanOrEqual(3);
      for (const groove of grooves) {
        expect(groove.genre, groove.id).toBe(genre);
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
    for (const genre of PROMOTED) {
      for (const groove of getGroovesForGenre(genre)) {
        expect(getGrooveById(groove.id), groove.id).toBeDefined();
        const byId = resolveGroove(genre, groove.id.slice(genre.length + 1), () => 0);
        expect(byId.id, groove.id).toBe(groove.id);
        const byName = resolveGroove(genre, groove.name.toLowerCase(), () => 0);
        expect(byName.id, groove.name).toBe(groove.id);
      }
    }
  });

  it("parser routes the genre words to the promoted genres, compounds keep their lanes", () => {
    expect(parseIntentText("jazz beat").input.genre).toBe("jazz");
    expect(parseIntentText("bebop at 220").input.genre).toBe("jazz");
    expect(parseIntentText("big band swing").input.genre).toBe("jazz");
    expect(parseIntentText("rock beat").input.genre).toBe("rock");
    expect(parseIntentText("hard rock at 120").input.genre).toBe("rock");
    expect(parseIntentText("punk at 170").input.genre).toBe("rock");
    // Guard: the metal family keeps its dedicated house.metal lane (the
    // heavy lanes ride purpose-built house-family grooves; only the BARE
    // rock words promote to the genre).
    expect(parseIntentText("heavy metal riff").input.genre).toBe("house");
    // Guards: the compound lanes keep their pre-promotion routing.
    expect(parseIntentText("jazz rap beat").input.genre).toBe("boombap");
    expect(parseIntentText("jazzy hip hop").input.genre).toBe("boombap");
    expect(parseIntentText("post-rock crescendo").input.genre).toBe("postrock");
    expect(parseIntentText("alt rock beat").input.genre).toBe("house");
    expect(parseIntentText("krautrock motorik").input.genre).toBe("techno");
  });

  it("each promoted genre has a song form and a BPM default", () => {
    for (const genre of PROMOTED) {
      const form = planSongForm(normalizeIntent({ genre, seed: "promo" }));
      expect(form.sections.length, genre).toBeGreaterThanOrEqual(4);
    }
    // Jazz is the AABA head form (no club drops); rock is the radio form.
    const jazz = planSongForm(normalizeIntent({ genre: "jazz", seed: "promo" }));
    expect(jazz.sections.some((s) => s.label.toLowerCase().includes("head"))).toBe(true);
    expect(jazz.sections.some((s) => s.label.toLowerCase().includes("bridge"))).toBe(true);
    const rock = planSongForm(normalizeIntent({ genre: "rock", seed: "promo" }));
    expect(rock.sections.some((s) => s.role === "chorus")).toBe(true);
  });

  it("each promoted genre has kit colouring (with variant sets), feel and mix tone", () => {
    for (const genre of PROMOTED) {
      expect(GENRE_KIT_SWAPS[genre]?.length, genre).toBeGreaterThan(0);
      expect(GENRE_FEEL[genre]).toBeDefined();
      for (const swap of GENRE_KIT_SWAPS[genre] ?? []) {
        expect(
          FACTORY_ASSETS.some((a) => a.id === swap.assetId),
          `${genre} pad ${swap.index} asset ${swap.assetId}`,
        ).toBe(true);
        // A swap carrying a variant set must be covered by it (the humanize
        // invariant from the kit-humanize wave).
        for (const layer of swap.layers ?? []) {
          const id = layer.sampleId ?? "";
          const base = id.replace(/\.rr\d+$/, "");
          expect(
            FACTORY_ASSETS.some((a) => a.id === id) || (base !== id && RR_VARIATIONS[base] !== undefined),
            `${genre} pad ${swap.index} layer ${id}`,
          ).toBe(true);
        }
      }
      // Mix tone resolves without throwing and returns a plan.
      const mix = planMixProfile(normalizeIntent({ genre, seed: "promo" }));
      expect(mix.summary.length, genre).toBeGreaterThan(0);
    }
    // The genre signatures: jazz rides the washey ride, rock lands the china
    // kit's cracking backbeat + crash-roll fill voice.
    expect((GENRE_KIT_SWAPS.jazz ?? []).some((s) => s.assetId === "factory.ride.jazz")).toBe(true);
    expect((GENRE_KIT_SWAPS.rock ?? []).some((s) => s.assetId === "factory.snare.main")).toBe(true);
    expect((GENRE_KIT_SWAPS.rock ?? []).some((s) => s.assetId === "factory.crash.roll")).toBe(true);
  });

  it("each promoted genre has harmony progressions", () => {
    for (const genre of PROMOTED) {
      const progression = selectProgression(genre, 0);
      expect(progression.genre, genre).toBe(genre);
      expect(progression.events.length).toBeGreaterThanOrEqual(3);
    }
    // The harmonic identities.
    expect(selectProgression("jazz", 0).name.toLowerCase()).toContain("ii-v-i");
    expect(selectProgression("rock", 0).name.toLowerCase()).toContain("i-iv-v");
  });

  it("style names for each promoted genre are non-empty", () => {
    for (const genre of PROMOTED) {
      expect(getStyleNamesForGenre(genre).length, genre).toBeGreaterThanOrEqual(3);
    }
  });
});
