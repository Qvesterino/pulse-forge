import { describe, it, expect } from "vitest";
import { GENRES } from "../src/ai/types";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { parseIntentText } from "../src/intent/text-parser";
import { planSongForm } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { GENRE_KIT_SWAPS, GENRE_FEEL } from "../src/intent/genre-kit";
import { genreMasterTiltDb } from "../src/intent/mix";
import { selectProgression } from "../src/ai/harmony";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { resolveGroove } from "../src/ai/generator";
import { ARTIST_PRESETS } from "../src/intent/artists";

/**
 * Post-rock promotion — the texture-over-melody genre becomes first-class
 * with its Wikipedia-documented school tree: textured (first wave: Slint /
 * Talk Talk / Tortoise), crescendo (second wave cinematic: Explosions in
 * the Sky / Mogwai / Mono), orchestral (Montreal chamber: GY!BE / Silver
 * Mt. Zion), postmetal (heavy fusion: Cult of Luna / Isis / Russian Circles),
 * math (Slint / Don Caballero angularity) and ambient (Kranky label:
 * Labradford / Stars of the Lid).
 *
 * The defining quality: dramatic quiet-loud dynamics ("climactic endings
 * alongside buildups of textures and timbres" — Wikipedia).
 */

const SCHOOLS = ["textured", "crescendo", "orchestral", "postmetal", "math", "ambient"] as const;

describe("postrock promotion (the quiet-loud crescendo genre)", () => {
  it("GENRES carries postrock", () => {
    expect(GENRES).toContain("postrock");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("postrock");
    // "At least the documented six, all unique" rather than an exact count —
    // the vocabulary-gap waves legitimately add schools to a promoted genre
    // (postrock is at 7 after the slowcore wave), and an exact-count lock goes
    // red on that growth while proving nothing. Every documented school still
    // has to resolve as a real groove with unique ids and 16-step rows.
    expect(grooves.length).toBeGreaterThanOrEqual(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`postrock.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("postrock");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("every school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("postrock")) {
      const byId = resolveGroove("postrock", groove.id.slice("postrock.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("postrock", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    for (const school of SCHOOLS) {
      expect(getStyleNamesForGenre("postrock"), school).toContain(getGrooveById(`postrock.${school}`)!.name);
    }
  });

  it("schools are genuinely different pockets (BPM, density, dynamic range)", () => {
    const textured = getGrooveById("postrock.textured")!;
    const crescendo = getGrooveById("postrock.crescendo")!;
    const math = getGrooveById("postrock.math")!;

    // The first wave sits at 70-90 BPM.
    expect(textured.bpm[0]).toBeGreaterThanOrEqual(68);
    expect(textured.bpm[1]).toBeLessThanOrEqual(92);
    // The math school is the FASTEST (Don Caballero angularity).
    expect(math.bpm[0]).toBeGreaterThanOrEqual(88);
    // The crescendo school has the WIDEST dynamic range (quiet → loud).
    const crescendoRows = crescendo.patterns.map((p) => Math.max(...Object.values(p).map((r) => Math.max(...r))));
    expect(Math.max(...crescendoRows) - Math.min(...crescendoRows)).toBeGreaterThan(0.1);
  });

  it("parser routes the genre and school phrases", () => {
    expect(parseIntentText("post rock beat").input.genre).toBe("postrock");
    expect(parseIntentText("postrock beat").input.genre).toBe("postrock");
    expect(parseIntentText("post rock beat").input.style).toBe("textured");
    expect(parseIntentText("crescendo postrock").input.style).toBe("crescendo");
    expect(parseIntentText("ambient postrock").input.style).toBe("ambient");
    expect(parseIntentText("orchestral postrock").input.style).toBe("orchestral");
  });

  it("postrock has the quiet-loud crescendo song shape", () => {
    const form = planSongForm(normalizeIntent({ genre: "postrock", seed: "pr" }));
    const labels = form.sections.map((s) => s.label);
    // The defining template: Hush → Build → Peak → Collapse → Build → Peak → Fade.
    expect(labels).toContain("Hush");
    expect(labels).toContain("Peak 1");
    expect(labels).toContain("Peak 2");
    expect(labels).toContain("Collapse");
    expect(labels).toContain("Fade");
    // The quiet-loud dynamics: Hush intensity is far below Peak 1.
    const hush = form.sections.find((s) => s.label === "Hush")!;
    const peak1 = form.sections.find((s) => s.label === "Peak 1")!;
    expect(hush.intensity).toBeLessThan(peak1.intensity * 0.5);
    // Collapse drops back to near-silence.
    const collapse = form.sections.find((s) => s.label === "Collapse")!;
    expect(collapse.intensity).toBeLessThan(peak1.intensity * 0.5);
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.postrock ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    // Post-rock is the most humanized genre (live drummers, dynamic playing).
    expect(GENRE_FEEL.postrock).toBeDefined();
    expect(GENRE_FEEL.postrock!.humanizeTiming).toBeGreaterThan(GENRE_FEEL.house!.humanizeTiming);
    expect(GENRE_FEEL.postrock!.humanizeVelocity).toBeGreaterThan(GENRE_FEEL.house!.humanizeVelocity);
    // Warm tone default (the whole point is texture).
    expect(genreMasterTiltDb("postrock")).toBeGreaterThan(0);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("postrock", 0);
    expect(progression.genre).toBe("postrock");
    expect(progression.events.length).toBeGreaterThanOrEqual(2);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    // First wave
    expect(byLabel.get("post-rock first wave")?.genre).toBe("postrock");
    expect(byLabel.get("post-rock first wave")?.style).toBe("textured");
    // Crescendo (the existing generic entry + the school entry)
    expect(byLabel.get("post-rock")?.genre).toBe("postrock");
    expect(byLabel.get("post-rock crescendo")?.genre).toBe("postrock");
    // Orchestral (GY!BE)
    expect(byLabel.get("post-rock dark")?.genre).toBe("postrock");
    expect(byLabel.get("post-rock dark")?.style).toBe("orchestral");
    // Post-metal / math / ambient
    expect(byLabel.get("post-metal")?.genre).toBe("postrock");
    expect(byLabel.get("post-metal")?.style).toBe("postmetal");
    expect(byLabel.get("post-rock math")?.style).toBe("math");
    expect(byLabel.get("post-rock ambient")?.style).toBe("ambient");
  });
});
