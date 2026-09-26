import { describe, it, expect } from "vitest";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { FACTORY_PRESET_GAIN_DB, FACTORY_PRESET_LOUDNESS } from "../src/presets/preset-loudness.generated";

/**
 * POP PRESET PACK (Wave 3) — 24 vocal-first presets (bright keys/plucks,
 * lush pads, marimba/celesta/nylon/rhodes/wurli/sad-piano carriers, round
 * basses, tuned 808s, soft leads, FM bells).
 *
 * Locks: exact roster by id, valid genre/mood/tags, sampler carriers resolve
 * to real factory samples, and every pop preset is measured in the loudness
 * map (the regen ships with the pack — no new orphans).
 */

const POP_PRESET_IDS = [
  "factory.keys.house.poppiano",
  "factory.keys.house.poprhodes",
  "factory.pluck.house.poppick",
  "factory.pluck.house.guitarpluck",
  "factory.texture.house.lushpad",
  "factory.texture.ambient.bedroompad",
  "factory.spectral.house.airypad",
  "factory.sampler.house.marimba",
  "factory.sampler.house.celesta",
  "factory.sampler.house.nylon",
  "factory.sampler.house.rhodespop",
  "factory.sampler.house.wurlipop",
  "factory.sampler.ambient.sadpop",
  "factory.sampler.house.padpop",
  "factory.bass.house.popbass",
  "factory.bass.house.deepsub",
  "factory.808.trap.pop808",
  "factory.808.trap.slidesub",
  "factory.analog.house.popstab",
  "factory.analog.house.softlead",
  "factory.fm.house.popbell",
  "factory.fm.house.softkeys",
  "factory.texture.trap.popcloud",
  "factory.texture.ambient.popkeys",
];

describe("pop preset pack (Wave 3)", () => {
  it("ships exactly the 24 pop presets with unique ids", () => {
    const found = FACTORY_PRESETS.filter((p) => POP_PRESET_IDS.includes(p.id));
    expect(found.map((p) => p.id).sort()).toEqual([...POP_PRESET_IDS].sort());
  });

  it("every pop preset carries a known genre and non-empty mood", () => {
    const genres = new Set(["house", "trap", "ambient"]);
    for (const id of POP_PRESET_IDS) {
      const preset = FACTORY_PRESETS.find((p) => p.id === id)!;
      expect(genres.has(preset.genre as string), id).toBe(true);
      expect(preset.mood.length, id).toBeGreaterThan(0);
    }
  });

  it("sampler carriers resolve to real factory samples", () => {
    const assetIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    const samplers = FACTORY_PRESETS.filter((p) => POP_PRESET_IDS.includes(p.id) && p.instrument === "sampler");
    expect(samplers.length).toBeGreaterThan(0);
    for (const preset of samplers) {
      expect(assetIds.has(preset.sampleId!), preset.id).toBe(true);
    }
  });

  it("every pop preset is measured in the loudness map (no new orphans)", () => {
    for (const id of POP_PRESET_IDS) {
      expect(FACTORY_PRESET_LOUDNESS[id], `${id} missing loudness`).toBeDefined();
      expect(FACTORY_PRESET_GAIN_DB[id], `${id} missing gain`).toBeDefined();
    }
  });
});
