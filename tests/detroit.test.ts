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
 * Detroit promotion — the machine-funk lineage (Detroit techno + electro)
 * becomes first-class with its Wikipedia-documented school tree: belleville
 * (the Three), second wave (UR / Mills / Hood), techno bass (AUX 88 /
 * electro-bass), electro (Cybotron / Egyptian Lover / Drexciya), ghettotech
 * (the Detroit/Chicago fusion) and minimal (the reductionist line).
 */

const SCHOOLS = ["belleville", "secondwave", "technobass", "electro", "ghettotech", "minimal"] as const;

describe("detroit promotion (the machine-funk lineage)", () => {
  it("GENRES carries detroit", () => {
    expect(GENRES).toContain("detroit");
  });

  it("all six schools exist as real grooves with unique ids and 16-step rows", () => {
    const grooves = getGroovesForGenre("detroit");
    expect(grooves.length).toBe(SCHOOLS.length);
    expect(new Set(grooves.map((g) => g.id)).size).toBe(grooves.length);
    for (const school of SCHOOLS) {
      expect(getGrooveById(`detroit.${school}`), school).toBeDefined();
    }
    for (const groove of grooves) {
      expect(groove.genre).toBe("detroit");
      for (const pattern of groove.patterns) {
        for (const row of Object.values(pattern)) {
          expect(row, groove.id).toHaveLength(16);
        }
      }
    }
  });

  it("every school resolves through resolveGroove by id and by name", () => {
    for (const groove of getGroovesForGenre("detroit")) {
      const byId = resolveGroove("detroit", groove.id.slice("detroit.".length), () => 0);
      expect(byId.id, groove.id).toBe(groove.id);
      const byName = resolveGroove("detroit", groove.name.toLowerCase(), () => 0);
      expect(byName.id, groove.name).toBe(groove.id);
    }
    expect(getStyleNamesForGenre("detroit").length).toBe(SCHOOLS.length);
  });

  it("schools are genuinely different pockets (BPM, kick, low end)", () => {
    const belleville = getGrooveById("detroit.belleville")!;
    const ghettotech = getGrooveById("detroit.ghettotech")!;
    const minimal = getGrooveById("detroit.minimal")!;
    const electro = getGrooveById("detroit.electro")!;

    // The first-wave pocket sits at 122-132.
    expect(belleville.bpm[0]).toBeGreaterThanOrEqual(120);
    expect(belleville.bpm[1]).toBeLessThanOrEqual(134);
    // Ghettotech is the FASTEST school; minimal the sparsest.
    expect(ghettotech.bpm[0]).toBeGreaterThanOrEqual(138);
    const minimalRows = Object.values(minimal.patterns[0]).filter((r) => r.some((v) => v > 0)).length;
    const electroRows = Object.values(electro.patterns[0]).filter((r) => r.some((v) => v > 0)).length;
    expect(minimalRows).toBeLessThan(electroRows);
    // Belleville carries the tom talk (the machine-funk signature).
    const hasTom = belleville.patterns.some((p) => (p[12] ?? []).some((v) => v > 0) || (p[13] ?? []).some((v) => v > 0));
    expect(hasTom, "belleville must carry the tom talk").toBe(true);
  });

  it("parser routes the genre and school phrases", () => {
    expect(parseIntentText("detroit techno").input.genre).toBe("detroit");
    expect(parseIntentText("detroit electro").input.genre).toBe("detroit");
    expect(parseIntentText("electro beat").input.genre).toBe("detroit");
    expect(parseIntentText("electro beat").input.style).toBe("electro");
    expect(parseIntentText("techno bass").input.style).toBe("technobass");
    expect(parseIntentText("underground resistance").input.style).toBe("secondwave");
    expect(parseIntentText("belleville beat").input.style).toBe("belleville");
    // Ghettotech keeps its own house lane (house.ghettotech groove predates
    // this promotion and remains the Detroit-booty house dialect).
    expect(parseIntentText("ghettotech beat").input.style).toBe("ghettotech");
  });

  it("guards: electro compounds keep their own lanes", () => {
    // "electro house" / "electro pop" / "electro hip hop" never fall to detroit.
    expect(parseIntentText("electro house").input.genre).toBe("house");
    expect(parseIntentText("electro pop").input.genre).toBe("house");
    expect(parseIntentText("electro hip hop").input.genre).toBe("trap");
  });

  it("detroit has an instrumental song shape and a BPM default", () => {
    const form = planSongForm(normalizeIntent({ genre: "detroit", seed: "de" }));
    const labels = form.sections.map((s) => s.label);
    // The machine-funk shape: 16-bar sections, a lead theme, a breakdown.
    expect(labels).toContain("Lead Theme");
    expect(labels).toContain("Breakdown");
    expect(form.sections[0].bars).toBe(16);
    expect(labels.some((l) => l.toLowerCase().includes("drop"))).toBe(false);
  });

  it("kit colouring + feel + mix character land on real assets", () => {
    const swaps = GENRE_KIT_SWAPS.detroit ?? [];
    expect(swaps.length).toBeGreaterThan(0);
    for (const swap of swaps) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === swap.assetId),
        `pad ${swap.index} asset ${swap.assetId}`,
      ).toBe(true);
    }
    // The 808 kick is the Detroit low end.
    expect(swaps.some((s) => s.assetId.startsWith("factory.kick.808"))).toBe(true);
    expect(GENRE_FEEL.detroit).toBeDefined();
    // Cold machine-funk tone default.
    expect(genreMasterTiltDb("detroit")).toBeLessThan(0);
    const mix = planMixProfile(normalizeIntent({ genre: "detroit", seed: "de", energy: 0.85 }));
    expect(mix.summary.some((s) => s.startsWith("pump:"))).toBe(true);
  });

  it("harmony progressions exist for the genre", () => {
    const progression = selectProgression("detroit", 0);
    expect(progression.genre).toBe("detroit");
    expect(progression.events.length).toBeGreaterThanOrEqual(3);
  });

  it("the school tree is populated by real artists", () => {
    const byLabel = new Map(ARTIST_PRESETS.map((p) => [p.label, p]));
    // Belleville
    expect(byLabel.get("derrick may")?.genre).toBe("detroit");
    expect(byLabel.get("derrick may")?.style).toBe("belleville");
    expect(byLabel.get("kevin saunderson")?.style).toBe("belleville");
    expect(byLabel.get("octave one")?.genre).toBe("detroit");
    // Second wave
    expect(byLabel.get("jeff mills")?.genre).toBe("detroit");
    expect(byLabel.get("jeff mills")?.style).toBe("secondwave");
    expect(byLabel.get("underground resistance")?.style).toBe("secondwave");
    // Electro / techno bass
    expect(byLabel.get("juan atkins")?.style).toBe("electro");
    expect(byLabel.get("drexciya")?.style).toBe("electro");
    expect(byLabel.get("aux 88")?.style).toBe("technobass");
    // Ghettotech / minimal
    expect(byLabel.get("dj godfather")?.genre).toBe("detroit");
    expect(byLabel.get("dj godfather")?.style).toBe("ghettotech");
    expect(byLabel.get("robert hood")?.genre).toBe("detroit");
    expect(byLabel.get("robert hood")?.style).toBe("minimal");
  });
});
