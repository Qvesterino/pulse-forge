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
 * Trance promotion — the genre that was ONE style on techno (techno.trance)
 * becomes first-class with its Wikipedia-documented school tree: uplifting
 * (the anthem school), progressive (the smooth end), psy (the Goa lineage),
 * tech (the warehouse crossover), acid (the 303 school) and dream (Robert
 * Miles). The defining song form is the breakdown-build-anthem template.
 */

const SCHOOLS = ["uplifting", "progressive", "psy", "tech", "acid", "dream"] as const;

describe("trance promotion (the breakdown-build-anthem genre)", () => {
  it("GENRES carries trance", () => {
    expect(GENRES).toContain("trance");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("trance");
    expect(grooves.length).toBe(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`trance.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("trance");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("every school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("trance")) {
      const byId = resolveGroove("trance", groove.id.slice("trance.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("trance", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    expect(getStyleNamesForGenre("trance").length).toBe(SCHOOLS.length);
  });

  it("schools are genuinely different pockets (BPM, kick, offbeat mask)", () => {
    const uplifting = getGrooveById("trance.uplifting")!;
    const progressive = getGrooveById("trance.progressive")!;
    const psy = getGrooveById("trance.psy")!;
    const dream = getGrooveById("trance.dream")!;

    // The anthem pocket sits at 136-142.
    expect(uplifting.bpm[0]).toBeGreaterThanOrEqual(134);
    expect(uplifting.bpm[1]).toBeLessThanOrEqual(144);
    // Progressive is the SLOWEST school; psy the fastest.
    expect(progressive.bpm[1]).toBeLessThan(uplifting.bpm[0]);
    expect(psy.bpm[0]).toBeGreaterThanOrEqual(136);
    // Dream is the softest kick (never a hard transient).
    for (const pattern of dream.patterns) {
      for (const velocity of pattern[0] ?? []) {
        expect(velocity).toBeLessThanOrEqual(0.85);
      }
    }
    // Uplifting carries the offbeat open-hat mask (the genre's signature).
    const offbeatMask = uplifting.patterns.some((p) => (p[10] ?? []).some((v) => v > 0));
    expect(offbeatMask, "uplifting must carry the offbeat open-hat mask").toBe(true);
  });

  it("parser routes every school phrase to trance", () => {
    expect(parseIntentText("trance beat").input.genre).toBe("trance");
    expect(parseIntentText("trance beat").input.style).toBe("uplifting");
    expect(parseIntentText("uplifting trance").input.style).toBe("uplifting");
    expect(parseIntentText("progressive trance").input.style).toBe("progressive");
    expect(parseIntentText("psytrance").input.genre).toBe("trance");
    expect(parseIntentText("psytrance").input.style).toBe("psy");
    expect(parseIntentText("goa trance").input.style).toBe("psy");
    expect(parseIntentText("tech trance").input.style).toBe("tech");
    expect(parseIntentText("acid trance").input.style).toBe("acid");
    expect(parseIntentText("dream trance").input.style).toBe("dream");
    expect(parseIntentText("trance beat").input.bpmRange).toEqual([136, 142]);
  });

  it("guards: trance compounds never fall into the techno acid/tech lanes", () => {
    // "acid trance" is trance, not techno acid.
    expect(parseIntentText("acid trance").input.genre).toBe("trance");
    // "tech trance" is trance, not techno.
    expect(parseIntentText("tech trance").input.genre).toBe("trance");
    // bare "acid" keeps its techno reading.
    expect(parseIntentText("acid line").input.genre).toBe("techno");
  });

  it("trance has the breakdown-build-anthem song shape", () => {
    const form = planSongForm(normalizeIntent({ genre: "trance", seed: "tr" }));
    const labels = form.sections.map((s) => s.label);
    // The defining template: breakdown → build → drop.
    expect(labels).toContain("Breakdown");
    expect(labels).toContain("Build");
    expect(labels).toContain("Drop");
    const breakdown = form.sections.find((s) => s.label === "Breakdown")!;
    // The breakdown STRIPS the drums — melody only.
    expect(breakdown.instrumentation).not.toContain("drums");
    // Breakdown intensity sits far below the drop (the template's whole point).
    const drop = form.sections.find((s) => s.label === "Drop")!;
    expect(breakdown.intensity).toBeLessThan(drop.intensity * 0.5);
    // The build carries the riser, the drop the impact.
    expect(form.sections.find((s) => s.label === "Build")!.transitionIn).toBe("riser");
    expect(drop.transitionIn).toBe("impact");
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.trance ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    expect(GENRE_FEEL.trance).toBeDefined();
    // Trance is grid-locked (the machine read is the genre).
    expect(GENRE_FEEL.trance!.humanizeTiming).toBeLessThan(GENRE_FEEL.house!.humanizeTiming);
    // Bright euphoric tone + character-genre treatment.
    expect(genreMasterTiltDb("trance")).toBeLessThan(0);
    const mix = planMixProfile(normalizeIntent({ genre: "trance", seed: "tr", energy: 0.85 }));
    expect(mix.summary.some((s) => s.startsWith("pump:"))).toBe(true);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("trance", 0);
    expect(progression.genre).toBe("trance");
    expect(progression.events.length).toBeGreaterThanOrEqual(3);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    expect(byLabel.get("trance")?.genre).toBe("trance");
    expect(byLabel.get("trance")?.style).toBe("uplifting");
    expect(byLabel.get("above and beyond")?.style).toBe("progressive");
    expect(byLabel.get("psytrance")?.genre).toBe("trance");
    expect(byLabel.get("psytrance")?.style).toBe("psy");
    expect(byLabel.get("dream trance")?.style).toBe("dream");
    expect(byLabel.get("tech trance")?.style).toBe("tech");
    expect(byLabel.get("acid trance")?.style).toBe("acid");
  });
});
