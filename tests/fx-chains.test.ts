import { describe, expect, it } from "vitest";
import { BEATMAKING_EFFECT_CHAINS } from "../src/effects/chains";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";

/**
 * PORTAL × TWIST tandem chains — arrival time (phase) meets spectral time.
 * The chains must exist with their documented effect order; preset existence
 * and type matching are locked by tests/effects-source-profiles.test.ts.
 */
const TANDEM = [
  { id: "phase-spectral-throw", types: ["skrutka", "portal"] },
  { id: "808-space-ladder", types: ["bassHarmonic", "skrutka", "portal"] },
  { id: "ghost-pad", types: ["skrutka", "portal"] },
  { id: "hyper-glitch", types: ["pitchShift", "skrutka", "portal"] },
] as const;

describe("PORTAL × TWIST tandem chains", () => {
  it("ships the four tandem chains with their effect order", () => {
    for (const expected of TANDEM) {
      const chain = BEATMAKING_EFFECT_CHAINS.find((candidate) => candidate.id === expected.id);
      expect(chain, `${expected.id} missing`).toBeDefined();
      expect(chain!.effects.map((item) => item.type)).toEqual([...expected.types]);
      expect(chain!.description.length).toBeGreaterThan(20);
      expect(chain!.name.length).toBeGreaterThan(0);
    }
  });

  it("every tandem chain references real factory presets", () => {
    const presetById = new Map(CORE_EFFECT_PRESETS.map((preset) => [preset.id, preset]));
    for (const expected of TANDEM) {
      const chain = BEATMAKING_EFFECT_CHAINS.find((candidate) => candidate.id === expected.id)!;
      for (const item of chain.effects) {
        const preset = presetById.get(item.presetId);
        expect(preset, `${chain.id} → ${item.presetId}`).toBeDefined();
        expect(preset!.type).toBe(item.type);
      }
    }
  });

  it("chain ids stay unique", () => {
    const ids = BEATMAKING_EFFECT_CHAINS.map((chain) => chain.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
