import { describe, expect, it } from "vitest";
import {
  PRESET_GAIN_DB_LIMIT,
  clampPresetGainDb,
  dbToLinear,
  presetNormalizationGainDb,
} from "../src/presets/normalization";
import { FACTORY_PRESET_GAIN_DB, PRESET_LOUDNESS_TARGET_LUFS } from "../src/presets/preset-loudness.generated";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { getPresetMetadata } from "../src/presets/catalog";

/**
 * Preset loudness normalization (factory-content pass):
 * - the generated map covers every factory preset, values within clamp;
 * - the helper clamps, rounds and falls back to 0 dB for unknown ids;
 * - per-useCase targets exist for every family that has presets.
 */

describe("preset loudness normalization", () => {
  it("clampPresetGainDb clamps to ±limit, rounds to 0.1 dB and neutralizes garbage", () => {
    expect(clampPresetGainDb(0)).toBe(0);
    expect(clampPresetGainDb(3.14159)).toBe(3.1);
    expect(clampPresetGainDb(50)).toBe(PRESET_GAIN_DB_LIMIT);
    expect(clampPresetGainDb(-50)).toBe(-PRESET_GAIN_DB_LIMIT);
    expect(clampPresetGainDb(Number.NaN)).toBe(0);
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(20)).toBeCloseTo(10, 6);
  });

  it("presetNormalizationGainDb looks up the map and falls back to 0 dB", () => {
    const [sampleId, sampleGain] = Object.entries(FACTORY_PRESET_GAIN_DB)[0];
    expect(presetNormalizationGainDb(sampleId)).toBe(sampleGain);
    expect(presetNormalizationGainDb("factory.does.not.exist")).toBe(0);
    expect(presetNormalizationGainDb(null)).toBe(0);
    expect(presetNormalizationGainDb(undefined)).toBe(0);
  });

  it("the generated map covers every factory preset within the clamp", () => {
    // PACK presets (real piano, VSCO orchestral) load their samples from a
    // git-ignored locally converted pack — the measurement harness has no
    // pack on a fresh checkout, so pack presets render at unity gain (0 dB
    // fallback in presetNormalizationGainDb) until measured with the pack
    // present (see scripts/convert-*.mjs + the license gate).
    const isPackPreset = (id: string) => id.startsWith("factory.piano.") || id.startsWith("factory.vsco.");
    const packPresets = FACTORY_PRESETS.filter((p) => isPackPreset(p.id));
    const measuredPresets = FACTORY_PRESETS.filter((p) => !isPackPreset(p.id));
    for (const preset of packPresets) {
      // Pack presets fall back to unity gain — 0 dB, defined, not clamped.
      expect(Math.abs(presetNormalizationGainDb(preset.id))).toBeLessThanOrEqual(PRESET_GAIN_DB_LIMIT + 0.001);
    }
    for (const preset of measuredPresets) {
      const gain = FACTORY_PRESET_GAIN_DB[preset.id];
      expect(gain, `${preset.id} missing from the loudness map`).toBeDefined();
      expect(Math.abs(gain)).toBeLessThanOrEqual(PRESET_GAIN_DB_LIMIT + 0.001);
    }
    expect(Object.keys(FACTORY_PRESET_GAIN_DB).length).toBeGreaterThanOrEqual(measuredPresets.length);
  });

  it("every preset family has a loudness target", () => {
    const families = new Set(FACTORY_PRESETS.map((preset) => getPresetMetadata(preset).useCase));
    for (const family of families) {
      expect(PRESET_LOUDNESS_TARGET_LUFS[family], `${family} target missing`).toBeDefined();
    }
  });
});
