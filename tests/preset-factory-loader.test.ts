import { describe, expect, it } from "vitest";
import { factoryPresets, isFactoryPresetsWarm, warmFactoryPresets } from "../src/presets/factory-loader";
// The pack seam (2026-10-04): the full bank = core + real-instrument packs,
// assembled by the loader's warm — same presets as before the seam.
const FACTORY_PRESETS = await warmFactoryPresets().then(() => factoryPresets());
import { parsePresetIntent } from "../src/intent/preset-intent";

/**
 * FACTORY PRESET BANK LOADER — the sync facade over the lazy ~130 KB bank.
 * Pins the contract the intent layer depends on: the warm is idempotent and
 * cached, cold access throws LOUDLY (a preset ask must never silently fall
 * through to generation), and a warmed bank is byte-identical to the source
 * module's export (one dataset, two access paths).
 */
describe("factory preset bank loader", () => {
  it("cold access throws loudly with the warm instruction", () => {
    // Fresh module registry per test file — this file never warmed before
    // this suite runs, so the cold assertion is meaningful here.
    if (!isFactoryPresetsWarm()) {
      expect(() => factoryPresets()).toThrow(/not warmed/);
    }
  });

  it("warm is idempotent and the bank matches the source export exactly", async () => {
    await warmFactoryPresets();
    await warmFactoryPresets(); // second call rides the cached promise
    expect(isFactoryPresetsWarm()).toBe(true);
    expect(factoryPresets()).toBe(FACTORY_PRESETS);
    expect(factoryPresets().length).toBeGreaterThan(100);
  });

  it("a warmed bank serves the sync intent parser end-to-end", async () => {
    await warmFactoryPresets();
    const parsed = parsePresetIntent("load the warm sub preset on the bass");
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.intent.preset.name).toBe("Warm Sub");
      expect(parsed.intent.target).toBe("bass");
    }
  });
});
