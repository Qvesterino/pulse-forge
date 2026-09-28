import { describe, it, expect } from "vitest";
import { GENRES } from "../src/ai/types";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { parseIntentText } from "../src/intent/text-parser";
import { planSongForm } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { GENRE_KIT_SWAPS, GENRE_FEEL } from "../src/intent/genre-kit";
import { planMixProfile, genreMasterTiltDb } from "../src/intent/mix";
import { selectProgression } from "../src/ai/harmony";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { resolveGroove } from "../src/ai/generator";
import { ARTIST_PRESETS } from "../src/intent/artists";

/**
 * Drone / neo-classical promotion — the biggest fold in ambient (17 entries
 * were hiding on ambient/drifting) becomes a first-class genre with its
 * Wikipedia-documented texture-composition school tree: drone (sustained
 * tone), minimalism (pulsing repetition), neoclassical (piano + strings),
 * isolationism (one hit then silence), electroacoustic (clicks + ticks) and
 * score (film-score cues). The defining quality: texture over beat — the
 * drums are atmosphere, not groove.
 */

const SCHOOLS = ["drone", "minimalism", "neoclassical", "isolationism", "electroacoustic", "score"] as const;

describe("drone/neo-classical promotion (the texture-over-beat genre)", () => {
  it("GENRES carries drone", () => {
    expect(GENRES).toContain("drone");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("drone");
    expect(grooves.length).toBe(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`drone.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("drone");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("every school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("drone")) {
      const byId = resolveGroove("drone", groove.id.slice("drone.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("drone", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    expect(getStyleNamesForGenre("drone").length).toBe(SCHOOLS.length);
  });

  it("schools are genuinely sparse — texture over beat", () => {
    for (const school of SCHOOLS) {
      const groove = getGrooveById(`drone.${school}`)!;
      // Every pattern must be thin (the whole point: drums are atmosphere).
      for (const pattern of groove.patterns) {
        const hits = Object.values(pattern).reduce((sum, row) => sum + row.filter((v) => v > 0).length, 0);
        expect(hits, `${groove.id} too dense for a texture genre`).toBeLessThanOrEqual(24);
      }
    }
    // The electroacoustic school has NO kick (clicks and ticks only).
    const electro = getGrooveById("drone.electroacoustic")!;
    for (const pattern of electro.patterns) {
      expect(pattern[0], "electroacoustic has no drums").toBeUndefined();
      expect(pattern[4], "electroacoustic has no backbeat").toBeUndefined();
    }
    // Minimalism is the fastest school; drone the slowest.
    expect(getGrooveById("drone.minimalism")!.bpm[1]).toBeGreaterThan(
      getGrooveById("drone.drone")!.bpm[1],
    );
  });

  it("parser routes the genre and school phrases", () => {
    expect(parseIntentText("drone beat").input.genre).toBe("drone");
    expect(parseIntentText("drone beat").input.style).toBe("drone");
    expect(parseIntentText("dark ambient drone").input.genre).toBe("drone");
    expect(parseIntentText("neo-classical piano").input.genre).toBe("drone");
    expect(parseIntentText("neo-classical piano").input.style).toBe("neoclassical");
    expect(parseIntentText("modern classical beat").input.style).toBe("neoclassical");
    expect(parseIntentText("minimalism beat").input.style).toBe("minimalism");
    expect(parseIntentText("isolationism beat").input.style).toBe("isolationism");
    expect(parseIntentText("electroacoustic beat").input.style).toBe("electroacoustic");
    expect(parseIntentText("film score cue").input.style).toBe("score");
  });

  it("guards: the relaxed-lifestyle phrases stay ambient", () => {
    expect(parseIntentText("new age meditation").input.genre).toBe("ambient");
    expect(parseIntentText("ambient beat").input.genre).toBe("ambient");
  });

  it("drone has the long-form swell song shape (no drops)", () => {
    const form = planSongForm(normalizeIntent({ genre: "drone", seed: "dr" }));
    const labels = form.sections.map((s) => s.label);
    // The texture dialect: Emergence → Swell → Decay → Fade.
    expect(labels).toContain("Emergence");
    expect(labels).toContain("Swell");
    expect(labels).toContain("Decay");
    expect(labels).toContain("Fade");
    expect(labels.some((l) => l.toLowerCase().includes("drop"))).toBe(false);
    // Long sections: the intro alone is 16 bars, the texture sections 32.
    expect(form.sections[0].bars).toBeGreaterThanOrEqual(16);
    expect(form.sections.some((s) => s.bars === 32)).toBe(true);
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.drone ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    // The soft kick is the texture floor — never the punch.
    expect(swaps.some((s) => s.assetId === "factory.kick.soft")).toBe(true);
    expect(GENRE_FEEL.drone).toBeDefined();
    // Cold-air tone default (high-end shimmer, no warmth).
    expect(genreMasterTiltDb("drone")).toBeLessThan(0);
    // No pump (there is no floor to pump — the drums are atmosphere).
    const mix = planMixProfile(normalizeIntent({ genre: "drone", seed: "dr", energy: 0.85 }));
    expect(mix.summary.some((s) => s.startsWith("pump:"))).toBe(false);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("drone", 0);
    expect(progression.genre).toBe("drone");
    expect(progression.events.length).toBeGreaterThanOrEqual(1);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    // The big 17-entry move off ambient/drifting.
    expect(byLabel.get("dark drone")?.genre).toBe("drone");
    expect(byLabel.get("dark drone")?.style).toBe("drone");
    expect(byLabel.get("stars of the lid")?.genre).toBe("drone");
    expect(byLabel.get("basinski")?.genre).toBe("drone");
    expect(byLabel.get("isolationism")?.style).toBe("isolationism");
    expect(byLabel.get("isolationist")?.style).toBe("isolationism");
    expect(byLabel.get("4th world")?.style).toBe("minimalism");
    expect(byLabel.get("minimalist avant")?.genre).toBe("drone");
    expect(byLabel.get("minimalist")?.style).toBe("minimalism");
    expect(byLabel.get("neoclassical")?.genre).toBe("drone");
    expect(byLabel.get("modern score")?.genre).toBe("drone");
    expect(byLabel.get("orchestral score")?.style).toBe("score");
    expect(byLabel.get("electroacoustic")?.style).toBe("electroacoustic");
    // New school entries.
    expect(byLabel.get("musique concrete")?.style).toBe("electroacoustic");
    expect(byLabel.get("minimalism proper")?.style).toBe("minimalism");
    expect(byLabel.get("film score composers")?.style).toBe("score");
    expect(byLabel.get("solo-instrument loops")?.style).toBe("neoclassical");
    // Brian Eno stays ambient — he coined the word; Music for Airports is
    // his ambient record, not a drone.
    expect(byLabel.get("ambient pioneer")?.genre).toBe("ambient");
  });
});
