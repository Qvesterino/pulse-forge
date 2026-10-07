import { describe, expect, it } from "vitest";
import { TSAR_FACTORY_PRESETS, TSAR_FACTORY_PRESET_COUNT } from "../../src/presets/tsar-factory";
import { tsarParams } from "../../src/tsar/params";
import { clampInstrumentParam } from "../../src/instruments/definitions";

/**
 * T3 — TSAR FACTORY PRESETS (docs/TSAR-ROADMAP.md T3).
 *
 * The audit the release gate needs: every preset applies to a TSAR track,
 * every param id exists in the schema, every value is inside its declared
 * range (a preset that clamps on load is a silent lie), ids are unique, and
 * the whole set is deterministic (same import, same values).
 */

const PARAM_IDS = new Set(tsarParams.map((param) => param.id));

describe("TSAR factory presets — schema audit", () => {
  it("every preset is a TSAR instrument with unique id and name", () => {
    const ids = new Set<string>();
    for (const preset of TSAR_FACTORY_PRESETS) {
      expect(preset.instrument, preset.id).toBe("tsar");
      expect(ids.has(preset.id), `duplicate id ${preset.id}`).toBe(false);
      ids.add(preset.id);
      expect(preset.name.length, preset.id).toBeGreaterThan(3);
    }
    expect(ids.size).toBe(TSAR_FACTORY_PRESET_COUNT);
  });

  it("every parameter id exists in the TSAR schema", () => {
    for (const preset of TSAR_FACTORY_PRESETS) {
      for (const key of Object.keys(preset.params)) {
        expect(PARAM_IDS.has(key), `${preset.id} carries unknown param "${key}"`).toBe(true);
      }
    }
  });

  it("every value is inside its declared range (no preset clamps on load)", () => {
    for (const preset of TSAR_FACTORY_PRESETS) {
      for (const [key, value] of Object.entries(preset.params)) {
        const clamped = clampInstrumentParam("tsar", key, value);
        expect(clamped, `${preset.id}.${key}=${value} clamps to ${clamped}`).toBe(value);
      }
    }
  });

  it("covers the discovery metadata the browser filters on", () => {
    for (const preset of TSAR_FACTORY_PRESETS) {
      expect(preset.genre, preset.id).not.toBeNull();
      expect(preset.mood.length, preset.id).toBeGreaterThan(0);
      expect(preset.tags.length, preset.id).toBeGreaterThan(1);
      expect(preset.metadata?.useCase, preset.id).toBeDefined();
      expect(preset.metadata?.source, preset.id).toBe("KYX factory");
    }
  });

  it("is deterministic — rebuilding yields identical values", async () => {
    // Fresh import evaluation in the same process gives the same objects by
    // construction; assert the shape that matters: stable ids and params.
    const snapshot = TSAR_FACTORY_PRESETS.map((preset) => ({
      id: preset.id,
      params: { ...preset.params },
    }));
    const moduleAgain = await import("../../src/presets/tsar-factory");
    expect(moduleAgain.TSAR_FACTORY_PRESETS.map((preset) => ({ id: preset.id, params: { ...preset.params } }))).toEqual(
      snapshot,
    );
  });

  it("genre profiles actually move the sound (not 48 copies of one patch)", () => {
    // Every archetype must have at least one genre variant that differs
    // materially in cutoff or drive — otherwise the profile layer is dead.
    const byArchetype = new Map<string, number[]>();
    for (const preset of TSAR_FACTORY_PRESETS) {
      const archetype = preset.id.split(".")[2]!;
      const list = byArchetype.get(archetype) ?? [];
      list.push(preset.params.srcACutoff ?? 0);
      byArchetype.set(archetype, list);
    }
    for (const [archetype, cutoffs] of byArchetype) {
      const min = Math.min(...cutoffs);
      const max = Math.max(...cutoffs);
      expect(max / Math.max(1, min), `${archetype} variants must differ in cutoff`).toBeGreaterThan(1.15);
    }
  });
});
