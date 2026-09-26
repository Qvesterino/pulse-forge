import { describe, it, expect } from "vitest";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { FACTORY_PRESET_GAIN_DB, FACTORY_PRESET_LOUDNESS } from "../src/presets/preset-loudness.generated";

/**
 * POP PRESET DELTA (Wave 3b) — the second slice of the pop pack, filling the
 * holes the first 24-preset pack left: an intimate upright for ballad
 * verses, kalimba + music box carriers for the two orphaned factory.mallet
 * assets, a funky moving bass, a bright dance-pop saw lead, an FM DX-style
 * piano and a vocal-chop adlib voice.
 *
 * Locks: exact roster by id, valid genre/mood, the mallet orphans are now
 * consumed, NO tonal/mallet factory asset is left without a preset consumer,
 * loudness-map coverage (regen ships with the pack) and sonic distinctness
 * across the whole factory catalog.
 */

const DELTA_IDS = [
  "factory.keys.house.uprightpop",
  "factory.sampler.house.kalimba",
  "factory.sampler.house.musicbox",
  "factory.bass.house.funkypop",
  "factory.analog.house.popsaw",
  "factory.fm.house.dxpiano",
  "factory.vocalchop.house.popadlib",
];

describe("pop preset delta pack (Wave 3b)", () => {
  it("ships exactly the 7 delta presets with unique ids", () => {
    const found = FACTORY_PRESETS.filter((p) => DELTA_IDS.includes(p.id));
    expect(found.map((p) => p.id).sort()).toEqual([...DELTA_IDS].sort());
  });

  it("every delta preset carries a known genre and non-empty mood", () => {
    const genres = new Set(["house", "trap", "ambient"]);
    for (const id of DELTA_IDS) {
      const preset = FACTORY_PRESETS.find((p) => p.id === id)!;
      expect(genres.has(preset.genre as string), id).toBe(true);
      expect(preset.mood.length, id).toBeGreaterThan(0);
    }
  });

  it("kalimba and music box consume the previously orphaned mallet assets", () => {
    const assetIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    expect(assetIds.has("factory.mallet.kalimba")).toBe(true);
    expect(assetIds.has("factory.mallet.musicbox")).toBe(true);
    const kalimba = FACTORY_PRESETS.find((p) => p.id === "factory.sampler.house.kalimba")!;
    const musicbox = FACTORY_PRESETS.find((p) => p.id === "factory.sampler.house.musicbox")!;
    expect(kalimba.sampleId).toBe("factory.mallet.kalimba");
    expect(musicbox.sampleId).toBe("factory.mallet.musicbox");
  });

  it("no tonal/mallet factory asset is left without a preset consumer", () => {
    // Perc assets are kit-pool/curated material (drum slots, not presets) —
    // the tonal and mallet families are the preset-carrier families.
    const consumed = new Set(FACTORY_PRESETS.map((p) => p.sampleId).filter(Boolean));
    const orphans = FACTORY_ASSETS.filter(
      (a) => (a.id.startsWith("factory.tonal.") || a.id.startsWith("factory.mallet.")) && !consumed.has(a.id),
    );
    expect(orphans.map((a) => a.id)).toEqual([]);
  });

  it("every delta preset is measured in the loudness map (no new orphans)", () => {
    for (const id of DELTA_IDS) {
      expect(FACTORY_PRESET_LOUDNESS[id], `${id} missing loudness`).toBeDefined();
      expect(FACTORY_PRESET_GAIN_DB[id], `${id} missing gain`).toBeDefined();
    }
  });

  it("delta presets are sonically distinct from every other preset", () => {
    // Scoped to the delta roster: the wider catalog still carries a
    // pre-existing duplicate (drumsynth.jersey.snare) that predates this wave.
    const signatures = FACTORY_PRESETS.map((preset) => ({
      id: preset.id,
      signature: `${preset.instrument}|${JSON.stringify(preset.params)}`,
    }));
    for (const id of DELTA_IDS) {
      const self = signatures.find((entry) => entry.id === id)!;
      const twin = signatures.find((entry) => entry.id !== id && entry.signature === self.signature);
      expect(twin?.id ?? null, `${id} duplicates ${twin?.id}`).toBeNull();
    }
  });
});
