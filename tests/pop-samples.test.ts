import { describe, it, expect } from "vitest";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";

/**
 * POP SAMPLE WAVE — 8 new factory assets (pop kick/clap stack/crash/floor
 * tom/rim/shaker + kalimba/music-box mallets): manifest, synth builder,
 * render duration and curated override all agree, so the full-kit contract
 * (coverage test) and the seed renderer keep working.
 */

const POP_SAMPLE_IDS = [
  "factory.kick.pop",
  "factory.clap.pop",
  "factory.crash.pop",
  "factory.tom.floor",
  "factory.rim.pop",
  "factory.perc.shaker.pop",
  "factory.mallet.kalimba",
  "factory.mallet.musicbox",
];

describe("pop sample wave (registry coherence)", () => {
  it("all eight assets are in the manifest with category, character and mood", () => {
    for (const id of POP_SAMPLE_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id);
      expect(asset, id).toBeDefined();
      expect(asset!.name.length).toBeGreaterThan(0);
      expect(asset!.character.length).toBeGreaterThan(0);
      expect(asset!.tags.length, id).toBeGreaterThan(0);
      expect(asset!.mood.length, id).toBeGreaterThan(0);
    }
  });

  it("every pop asset has a synth builder and a finite render duration", () => {
    for (const id of POP_SAMPLE_IDS) {
      expect(typeof BUILDERS[id], `${id} builder`).toBe("function");
      expect(Number.isFinite(DURATIONS[id]) && DURATIONS[id] > 0, `${id} duration`).toBe(true);
    }
  });

  it("every pop asset has exactly one curated override (WAV rendered by curated:seeds)", () => {
    for (const id of POP_SAMPLE_IDS) {
      const matches = CURATED_SAMPLES.filter((s) => s.id === id);
      expect(matches, id).toHaveLength(1);
      expect(matches[0].file).toBe(`${id}.wav`);
    }
  });
});
