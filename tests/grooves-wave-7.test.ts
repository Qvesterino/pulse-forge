import { describe, it, expect } from "vitest";
import { getGrooveById, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";
import { testDoc } from "./fixtures/doc";
import type { GrooveData } from "../src/ai/types";
import { parseIntentText, styleCandidatesForPrompt } from "../src/intent/text-parser";

/**
 * GENRE WAVE 7 — the vocabulary-gap completion wave (user task list):
 * the seven families that were fully absent, riding their parent floors
 * per the established route (afrobeats→house precedent):
 *
 *   African roots   highlife / soukous / zouk / kizomba / coupé-décalé (house)
 *   Eurodance +3    eurobeat / oldskool rave / breakbeat hardcore
 *   Folk family     folk / bluegrass / gospel (house)
 *   Jazz proper     bebop / swing / big band + turntablism (boombap)
 *   Bass exotics    complextro / Melbourne bounce / future funk (house),
 *                   glitch hop (dnb)
 *   Balkan          turbofolk / chalga / manele (eurodance)
 *   Emo/digicore    digicore / dariacore (hyperpop), emo rap (trap)
 *   Niches          dungeon synth (drone), singeli / mahraganat (house),
 *                   makina (techno), hardwave (trap), slowcore (postrock)
 *
 * Locks: registration + ids, 16-step valid rows, generation smoke through
 * the real engine, and parser routing (the style words resolve to the lane,
 * the genre words resolve to the parent genre).
 */

const WAVE_7_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
  /** A text phrase that must route to this lane. */
  phrase: string;
}> = [
  // African roots (house)
  { id: "house.highlife", genre: "house", name: "Highlife", bpm: [110, 130], phrase: "highlife beat" },
  { id: "house.soukous", genre: "house", name: "Soukous", bpm: [115, 140], phrase: "soukous" },
  { id: "house.zouk", genre: "house", name: "Zouk", bpm: [95, 112], phrase: "zouk" },
  { id: "house.kizomba", genre: "house", name: "Kizomba", bpm: [90, 108], phrase: "kizomba" },
  {
    id: "house.coupledecale",
    genre: "house",
    name: "Coupé-Décalé",
    bpm: [105, 122],
    phrase: "coupe decale",
  },
  // Eurodance family completion
  { id: "eurodance.eurobeat", genre: "eurodance", name: "Eurobeat", bpm: [148, 160], phrase: "eurobeat" },
  { id: "eurodance.rave", genre: "eurodance", name: "Rave", bpm: [130, 142], phrase: "old skool rave" },
  {
    id: "eurodance.bhc",
    genre: "eurodance",
    name: "Breakbeat Hardcore",
    bpm: [160, 175],
    phrase: "breakbeat hardcore",
  },
  // Folk family (house)
  { id: "house.folk", genre: "house", name: "Folk", bpm: [90, 120], phrase: "folk" },
  { id: "house.bluegrass", genre: "house", name: "Bluegrass", bpm: [108, 140], phrase: "bluegrass" },
  { id: "house.gospel", genre: "house", name: "Gospel", bpm: [72, 96], phrase: "gospel" },
  // Jazz proper + turntablism (boombap)
  { id: "boombap.bebop", genre: "boombap", name: "Bebop", bpm: [200, 260], phrase: "bebop" },
  { id: "boombap.swing", genre: "boombap", name: "Swing", bpm: [120, 180], phrase: "swing jazz" },
  { id: "boombap.bigband", genre: "boombap", name: "Big Band", bpm: [130, 190], phrase: "big band" },
  {
    id: "boombap.turntablism",
    genre: "boombap",
    name: "Turntablism",
    bpm: [85, 100],
    phrase: "turntablism",
  },
  // Bass exotics
  { id: "house.complextro", genre: "house", name: "Complextro", bpm: [126, 132], phrase: "complextro" },
  {
    id: "house.melbournebounce",
    genre: "house",
    name: "Melbourne Bounce",
    bpm: [126, 130],
    phrase: "melbourne bounce",
  },
  { id: "house.futurefunk", genre: "house", name: "Future Funk", bpm: [116, 122], phrase: "future funk" },
  { id: "dnb.glitchhop", genre: "dnb", name: "Glitch Hop", bpm: [80, 100], phrase: "glitch hop" },
  // Balkan (eurodance)
  { id: "eurodance.turbofolk", genre: "eurodance", name: "Turbofolk", bpm: [100, 130], phrase: "turbofolk" },
  { id: "eurodance.chalga", genre: "eurodance", name: "Chalga", bpm: [100, 132], phrase: "chalga" },
  { id: "eurodance.manele", genre: "eurodance", name: "Manele", bpm: [95, 125], phrase: "manele" },
  // Emo / digicore
  { id: "hyperpop.digicore", genre: "hyperpop", name: "Digicore", bpm: [150, 170], phrase: "digicore" },
  { id: "hyperpop.dariacore", genre: "hyperpop", name: "Dariacore", bpm: [160, 200], phrase: "dariacore" },
  { id: "trap.emorap", genre: "trap", name: "Emo Rap", bpm: [130, 150], phrase: "emo rap" },
  // Niches
  {
    id: "drone.dungeonsynth",
    genre: "drone",
    name: "Dungeon Synth",
    bpm: [60, 90],
    phrase: "dungeon synth",
  },
  { id: "house.singeli", genre: "house", name: "Singeli", bpm: [180, 220], phrase: "singeli" },
  {
    id: "house.mahraganat",
    genre: "house",
    name: "Mahraganat",
    bpm: [100, 140],
    phrase: "mahraganat",
  },
  { id: "techno.makina", genre: "techno", name: "Makina", bpm: [170, 185], phrase: "makina" },
  { id: "trap.hardwave", genre: "trap", name: "Hardwave", bpm: [120, 140], phrase: "hardwave" },
  { id: "postrock.slowcore", genre: "postrock", name: "Slowcore", bpm: [55, 75], phrase: "slowcore" },
];

describe("groove wave 7 — vocabulary-gap completion", () => {
  it("all 31 grooves resolve by id with genre, name, and researched BPM range", () => {
    for (const expected of WAVE_7_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre, `${expected.id}: genre`).toBe(expected.genre);
      expect(groove!.name, `${expected.id}: name`).toBe(expected.name);
      expect(groove!.bpm[0], `${expected.id}: bpm lo`).toBe(expected.bpm[0]);
      expect(groove!.bpm[1], `${expected.id}: bpm hi`).toBe(expected.bpm[1]);
    }
  });

  it("every groove has 16-step rows on valid pad indices with pattern variety", () => {
    for (const expected of WAVE_7_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.patterns.length, `${expected.id}: ≥2 patterns`).toBeGreaterThanOrEqual(2);
      for (const pattern of groove.patterns) {
        // Patterns may vary their pad subsets (breakdown bars drop pads) —
        // every USED pad must be declared in activePads.
        for (const pad of Object.keys(pattern)) {
          expect(groove.activePads.map(String), `${expected.id}: pad ${pad} declared`).toContain(pad);
        }
        for (const [pad, row] of Object.entries(pattern)) {
          expect(row.length, `${expected.id} pad ${pad}: 16 steps`).toBe(16);
          for (const v of row) {
            expect(v, `${expected.id} pad ${pad}: velocity 0..1`).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("every lane name appears in its genre's style list and resolves through resolveGroove", () => {
    for (const expected of WAVE_7_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre), `${expected.id}: in style list`).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id, `${expected.id}: resolveGroove`).toBe(expected.id);
    }
  });

  it("parser routes every wave phrase to its lane", () => {
    for (const expected of WAVE_7_GROOVES) {
      const candidates = styleCandidatesForPrompt(expected.phrase);
      // STYLE_PHRASES carry the lane id (lowercase, e.g. "highlife"), not the
      // display name ("Highlife") — the lane id is the part after the dot.
      expect(candidates[0], `${expected.phrase} → lane`).toBe(expected.id.split(".")[1]);
    }
  });

  it("keeps breakbeat hardcore on its Eurodance lane", () => {
    const parsed = parseIntentText("breakbeat hardcore beat");
    expect(parsed.input.genre).toBe("eurodance");
    expect(parsed.input.style).toBe("bhc");
  });

  it("generation smoke: a representative lane per family generates a real pattern", async () => {
    const doc = testDoc();
    const representatives = [
      "house.highlife",
      "eurodance.eurobeat",
      "house.gospel",
      "boombap.bebop",
      "house.complextro",
      "eurodance.manele",
      "hyperpop.dariacore",
      "drone.dungeonsynth",
      "techno.makina",
      "postrock.slowcore",
    ];
    for (const id of representatives) {
      const groove = getGrooveById(id)!;
      const intent = normalizeIntent({ genre: groove.genre, seed: `wave7-${id}` });
      const plan = planGeneration(intent, doc);
      const pattern = generatePattern(doc, { ...plan.options, seed: `wave7-${id}` });
      expect(pattern.rows, `${id}: generates rows`).toBeDefined();
      expect(Object.keys(pattern.rows ?? {}).length, `${id}: non-empty rows`).toBeGreaterThan(0);
    }
  });
});
