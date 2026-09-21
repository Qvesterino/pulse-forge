import { describe, expect, it } from "vitest";
import { EFFECT_DEFS, FLAGSHIP_EFFECT_ORDER } from "../src/effects/registry";
import { presetsForEffect } from "../src/effects/presets";
import { EFFECT_BLURBS } from "../src/effects/blurbs";
import type { EffectType } from "../src/project-model/types";

/**
 * FX catalog completeness (FX-ADD-REWORK-ROADMAP A1 + C1): every device the
 * add surface can offer must be DESCRIBED (blurb) and must LAND sounding
 * right (≥2 presets). Preset params are clamped to the registry's ParamDef
 * metadata — a preset that lies about ranges would corrupt the popover.
 */

// Flagships carry their own panels and preset systems — out of this gate.
const FLAGSHIP_PANELS = new Set<EffectType>([...FLAGSHIP_EFFECT_ORDER, "fxeq", "ultina", "ozvena", "morphdynamics", "kaskada"]);

const nonFlagshipTypes = (Object.keys(EFFECT_DEFS) as EffectType[]).filter((type) => !FLAGSHIP_PANELS.has(type));

describe("fx catalog metadata", () => {
  it("every non-flagship device has a one-line blurb", () => {
    const missing = nonFlagshipTypes.filter((type) => !EFFECT_BLURBS[type]);
    expect(missing, `devices without blurbs: ${missing.join(", ")}`).toEqual([]);
    for (const type of nonFlagshipTypes) {
      const blurb = EFFECT_BLURBS[type]!;
      expect(blurb.length, `${type} blurb too long for one line`).toBeLessThanOrEqual(80);
      expect(blurb, `${type} blurb should end with a period-free phrase`).not.toMatch(/\.$/);
    }
  });

  it("every non-flagship device has at least 2 presets", () => {
    const bare = nonFlagshipTypes.filter((type) => presetsForEffect(type).length < 2);
    expect(bare, `devices without presets: ${bare.join(", ")}`).toEqual([]);
  });

  it("preset params are real ids clamped to ParamDef ranges", () => {
    for (const type of nonFlagshipTypes) {
      const def = EFFECT_DEFS[type];
      for (const preset of presetsForEffect(type)) {
        for (const [paramId, value] of Object.entries(preset.params)) {
          const param = def.params.find((pd) => pd.id === paramId);
          expect(param, `${preset.id}.${paramId} is not a param of ${type}`).toBeDefined();
          expect(value, `${preset.id}.${paramId} below min`).toBeGreaterThanOrEqual(param!.min);
          expect(value, `${preset.id}.${paramId} above max`).toBeLessThanOrEqual(param!.max);
        }
        // Mangler envelopes are 16-step by contract; other step patterns
        // (gates, dividers) may vary in length — not asserted here.
        if (preset.volumeSteps) expect(preset.volumeSteps).toHaveLength(16);
        if (preset.pitchSteps) expect(preset.pitchSteps).toHaveLength(16);
      }
    }
  });
});
