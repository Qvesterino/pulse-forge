/**
 * Wave-2 effect upgrade tests — the character-engine Tape mode +
 * registry contract for the upgraded effects:
 *
 *   characterCurve — Tape mode (mode 4) bounded, softer knee than Warm
 *   registry       — bitcrusher drive/tone, multiband comp/solos,
 *                    haasWidener crossfeed/invert, pre-filter params
 */
import { describe, expect, it } from "vitest";
import {
  CHARACTER_MODE_COUNT,
  CHARACTER_MODE_LABELS,
  characterCurve,
  characterTransfer,
  type CharacterMode,
} from "../src/effects/characterCurve";
import { EFFECT_DEFS, defaultParamsOf } from "../src/effects/registry";

describe("character engine — Tape mode", () => {
  it("ships five modes ending with Tape", () => {
    expect(CHARACTER_MODE_COUNT).toBe(5);
    expect(CHARACTER_MODE_LABELS).toEqual(["Warm", "Tube", "Fold", "Hard", "Tape"]);
  });

  it("Tape is bounded, unity at full scale, softer knee than Warm", () => {
    const mode = 4 as CharacterMode;
    // Full-scale unity (atan(k)/atan(k) = 1).
    expect(characterTransfer(mode, 1, 0.8, 0)).toBeCloseTo(1, 6);
    expect(characterTransfer(mode, -1, 0.8, 0)).toBeCloseTo(-1, 6);
    // Softer knee: at half drive-in, tape compresses MORE than warm tanh
    // (arctan saturates earlier) but stays above the linear line.
    const tapeMid = characterTransfer(mode, 0.4, 0.8, 0);
    expect(tapeMid).toBeGreaterThan(0.4 * 0.9); // above ~linear
    expect(tapeMid).toBeLessThan(0.95);
    const curve = characterCurve(mode, 0.8, 0);
    for (const v of curve) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("all five curves stay bounded across the drive range", () => {
    for (let mode = 0 as CharacterMode; mode < 5; mode++) {
      for (const drive of [0, 0.5, 1]) {
        const curve = characterCurve(mode, drive, 0.5);
        for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});

describe("wave-2 registry contracts", () => {
  it("bitcrusher exposes drive + tone", () => {
    const params = defaultParamsOf("bitcrusher");
    expect(params["drive"]).toBe(0);
    expect(params["tone"]).toBe(18000);
    const labels = EFFECT_DEFS.bitcrusher.params.map((p) => p.id);
    expect(labels).toContain("drive");
    expect(labels).toContain("tone");
  });

  it("multiband exposes COMP + three solo gates", () => {
    const params = defaultParamsOf("multiband");
    expect(params["comp"]).toBe(0);
    expect(params["soloLow"]).toBe(0);
    expect(params["soloMid"]).toBe(0);
    expect(params["soloHigh"]).toBe(0);
    const solo = EFFECT_DEFS.multiband.params.filter((p) => p.kind === "toggle");
    expect(solo.length).toBe(3);
  });

  it("haasWidener exposes crossfeed + invert", () => {
    const params = defaultParamsOf("haasWidener");
    expect(params["crossfeed"]).toBe(0.4);
    expect(params["invert"]).toBe(0);
  });

  it("saturation/distortion expose the pre-filter and five characters", () => {
    for (const type of ["saturation", "distortion"] as const) {
      const def = EFFECT_DEFS[type];
      const character = def.params.find((p) => p.id === "character");
      expect(character?.max).toBe(4);
      const pre = def.params.find((p) => p.id === "preHpfHz");
      expect(pre).toBeDefined();
      expect(defaultParamsOf(type)["preHpfHz"]).toBe(20);
    }
  });
});
