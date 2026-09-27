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
 * Amapiano promotion — the South African log-drum genre promoted from
 * `house.amapiano` to a first-class genre with its Wikipedia-documented
 * school tree: yanos (core), soulful (private school piano / Kelvin Momo),
 * s'gija (stripped gqom-adjacent), bacardi (new-age Pretoria mutation),
 * quantum (gqom 2.0 / taxi kick) and popiano (the pop-facing variant, Tyla).
 */

const SCHOOLS = ["yanos", "soulful", "sgija", "bacardi", "quantum", "popiano"] as const;

describe("amapiano promotion (the log-drum genre)", () => {
  it("GENRES carries amapiano", () => {
    expect(GENRES).toContain("amapiano");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("amapiano");
    expect(grooves.length).toBe(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`amapiano.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("amapiano");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("every school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("amapiano")) {
      const byId = resolveGroove("amapiano", groove.id.slice("amapiano.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("amapiano", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    expect(getStyleNamesForGenre("amapiano").length).toBe(SCHOOLS.length);
  });

  it("schools are genuinely different pockets (BPM, kick, log-drum voice)", () => {
    const yanos = getGrooveById("amapiano.yanos")!;
    const soulful = getGrooveById("amapiano.soulful")!;
    const sgija = getGrooveById("amapiano.sgija")!;
    const quantum = getGrooveById("amapiano.quantum")!;

    // The core log-drum pocket sits at 110-116.
    expect(yanos.bpm[0]).toBeGreaterThanOrEqual(108);
    expect(yanos.bpm[1]).toBeLessThanOrEqual(116);
    // Soulful is slower than yanos (the patient private-school tempo).
    expect(soulful.bpm[0]).toBeLessThan(yanos.bpm[0]);
    // S'gija and quantum kick harder than yanos (the taxi-kick school).
    const yanosKick = yanos.patterns[0][0][0];
    expect(sgija.patterns[0][0][0]).toBeGreaterThan(yanosKick);
    expect(quantum.patterns[0][1][0], "quantum doubles the punch").toBeGreaterThan(0);
    // Every school carries the log-drum toms (12/13) — the genre's voice.
    for (const school of SCHOOLS) {
      const groove = getGrooveById(`amapiano.${school}`)!;
      const hasLog = groove.patterns.some((p) => p[12] !== undefined || p[13] !== undefined);
      expect(hasLog, `${school} must carry the log drum`).toBe(true);
    }
  });

  it("parser routes every school phrase to amapiano", () => {
    expect(parseIntentText("amapiano beat").input.genre).toBe("amapiano");
    expect(parseIntentText("yanos beat").input.genre).toBe("amapiano");
    expect(parseIntentText("yanos beat").input.style).toBe("yanos");
    expect(parseIntentText("private school piano").input.genre).toBe("amapiano");
    expect(parseIntentText("private school piano").input.style).toBe("soulful");
    expect(parseIntentText("s'gija beat").input.genre).toBe("amapiano");
    expect(parseIntentText("new age bacardi").input.style).toBe("bacardi");
    expect(parseIntentText("quantum sound").input.style).toBe("quantum");
    expect(parseIntentText("popiano beat").input.style).toBe("popiano");
    expect(parseIntentText("amapiano beat").input.bpmRange).toEqual([110, 116]);
  });

  it("amapiano has a long-form song shape and a BPM default", () => {
    const form = planSongForm(normalizeIntent({ genre: "amapiano", seed: "ap" }));
    expect(form.sections.length).toBeGreaterThanOrEqual(6);
    // The yanos shape: 16-bar groove sections, 8-bar intro/outro, no drops.
    expect(form.sections.some((s) => s.bars === 16)).toBe(true);
    expect(form.sections.some((s) => s.label.toLowerCase().includes("drop"))).toBe(false);
    expect(form.sections.some((s) => s.label.includes("Soulful"))).toBe(true);
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.amapiano ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    expect(GENRE_FEEL.amapiano).toBeDefined();
    // Warm log-drum tone + character-genre treatment.
    expect(genreMasterTiltDb("amapiano")).toBeGreaterThan(0);
    const mix = planMixProfile(normalizeIntent({ genre: "amapiano", seed: "ap", energy: 0.8 }));
    expect(mix.summary.some((s) => s.startsWith("pump:"))).toBe(true);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("amapiano", 0);
    expect(progression.genre).toBe("amapiano");
    expect(progression.events.length).toBeGreaterThanOrEqual(3);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    // Yanos core
    expect(byLabel.get("kabza de small / maphorisa")?.genre).toBe("amapiano");
    expect(byLabel.get("kabza de small / maphorisa")?.style).toBe("yanos");
    expect(byLabel.get("mdu aka mas")?.genre).toBe("amapiano");
    expect(byLabel.get("yanos hitmakers")?.style).toBe("yanos");
    // Soulful
    expect(byLabel.get("kelvin momo")?.genre).toBe("amapiano");
    expect(byLabel.get("kelvin momo")?.style).toBe("soulful");
    // Bacardi / quantum / popiano
    expect(byLabel.get("new age bacardi")?.style).toBe("bacardi");
    expect(byLabel.get("quantum sound")?.style).toBe("quantum");
    expect(byLabel.get("popiano")?.style).toBe("popiano");
    expect(byLabel.get("popiano")?.names).toContain("tyla");
    // S'gija
    expect(byLabel.get("sgija")?.style).toBe("sgija");
  });
});
