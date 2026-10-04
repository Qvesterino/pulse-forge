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
import type { ArtistPreset } from "../src/intent/artists";

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
    // "At least the documented six, all unique" rather than an exact count —
    // the vocabulary-gap waves legitimately add schools to a promoted genre
    // (drone is at 7 after the dungeon-synth wave), and an exact-count lock
    // goes red on that growth while proving nothing. The invariants that
    // matter are below: documented schools resolve, ids stay unique, every
    // groove stays IN the genre, rows are 16 steps.
    expect(grooves.length).toBeGreaterThanOrEqual(SCHOOLS.length);
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
    for (const school of SCHOOLS) {
      expect(getStyleNamesForGenre("drone"), school).toContain(getGrooveById(`drone.${school}`)!.name);
    }
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
    expect(getGrooveById("drone.minimalism")!.bpm[1]).toBeGreaterThan(getGrooveById("drone.drone")!.bpm[1]);
  });

  it("parser routes the genre and school phrases", () => {
    expect(parseIntentText("drone beat").input.genre).toBe("drone");
    expect(parseIntentText("drone beat").input.style).toBe("drone");
    // The parser's documented precedence: an explicit ambient compound wins
    // over the standalone drone genre, so "dark ambient drone" stays in the
    // ambient family (text-parser.ts:120) rather than flipping to drone on
    // the word "drone". A bare "drone" is the drone genre.
    expect(parseIntentText("dark ambient drone").input.genre).toBe("ambient");
    expect(parseIntentText("dark drone").input.genre).toBe("drone");
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
    // Pump is energy-gated (mix.ts: drone sits in the pump-capable set from
    // energy >= 0.55 — a high-energy drone beat with real drums does pump).
    // What the texture identity forbids is a pump at LOW energy: sparse
    // drone is all pad/noise-floor, with nothing to key the sidechain off.
    const mixLow = planMixProfile(normalizeIntent({ genre: "drone", seed: "dr", energy: 0.2 }));
    expect(
      mixLow.summary.some((s) => s.startsWith("pump:")),
      "low-energy drone must not pump",
    ).toBe(false);
    const mix = planMixProfile(normalizeIntent({ genre: "drone", seed: "dr", energy: 0.85 }));
    // The texture promises still hold at high energy: cold air, no warmth.
    expect(mix.summary).toContain("tone: cold");
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("drone", 0);
    expect(progression.genre).toBe("drone");
    expect(progression.events.length).toBeGreaterThanOrEqual(1);
  });

  it("the school tree is populated by real artists", () => {
    // Keyed by the UI chip label, which is what these assertions historically
    // locked. One label is deliberately shared: "basinski" is both the artist
    // lane (drone/drone) and the record-title prompt "disintegration loops"
    // (ambient/drifting, documented in artists.ts) — so a Map keyed by label
    // reads the album prompt last. Assert the ARTIST lane is present rather
    // than "the last row with this label", which is what made this lock read
    // the ambient record prompt and fail on a correct routing decision.
    const byLabel = new Map<string, ArtistPreset[]>();
    for (const preset of ARTIST_PRESETS) {
      const rows = byLabel.get(preset.label) ?? [];
      rows.push(preset);
      byLabel.set(preset.label, rows);
    }
    const lanes = (label: string) => byLabel.get(label) ?? [];
    // The big 17-entry move off ambient/drifting.
    expect(lanes("dark drone").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("dark drone").some((p) => p.style === "drone")).toBe(true);
    expect(lanes("stars of the lid").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("basinski").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("isolationism").some((p) => p.style === "isolationism")).toBe(true);
    expect(lanes("isolationist").some((p) => p.style === "isolationism")).toBe(true);
    expect(lanes("4th world").some((p) => p.style === "minimalism")).toBe(true);
    expect(lanes("minimalist avant").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("minimalist").some((p) => p.style === "minimalism")).toBe(true);
    expect(lanes("neoclassical").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("modern score").some((p) => p.genre === "drone")).toBe(true);
    expect(lanes("orchestral score").some((p) => p.style === "score")).toBe(true);
    expect(lanes("electroacoustic").some((p) => p.style === "electroacoustic")).toBe(true);
    // New school entries.
    expect(lanes("musique concrete").some((p) => p.style === "electroacoustic")).toBe(true);
    expect(lanes("minimalism proper").some((p) => p.style === "minimalism")).toBe(true);
    expect(lanes("film score composers").some((p) => p.style === "score")).toBe(true);
    expect(lanes("solo-instrument loops").some((p) => p.style === "neoclassical")).toBe(true);
    // Brian Eno stays ambient — he coined the word; Music for Airports is
    // his ambient record, not a drone.
    expect(lanes("ambient pioneer").some((p) => p.genre === "ambient")).toBe(true);
  });
});
