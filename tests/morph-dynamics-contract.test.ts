/**
 * MORPH DYNAMICS — contract tests.
 *
 * Pins the parameter schema (the persistent API contract): stable ids,
 * round-tripping normalization, NaN-safe clamping, complete defaults, and
 * that every factory preset applies cleanly through the schema. Also pins
 * the registry integration (rack surface, plugin-param normalization on
 * project load).
 */
import { describe, expect, it } from "vitest";

import * as P from "../src/effects/morph-dynamics-core/contracts/parameterIds";
import {
  ALL_PARAMS,
  PARAM_BY_ID,
  buildDefaultParams,
  clampParam,
  fromNormalized,
  getAutomatableParamIds,
  toNormalized,
  tryGetParamDef,
} from "../src/effects/morph-dynamics-core/contracts/parameterSchema";
import { MOD_DESTINATIONS, MOD_SOURCES } from "../src/effects/morph-dynamics-core/contracts/modulation";
import {
  FACTORY_PRESETS,
  GOLDEN_PRESET_IDS,
  applyMorphPreset,
} from "../src/effects/morph-dynamics-core/presets/factoryPresets";
import { defaultParamsOf, normalizePluginParams } from "../src/effects/registry";

describe("morph-dynamics parameter schema", () => {
  it("has unique, dot-namespaced, non-empty ids", () => {
    const ids = new Set<string>();
    for (const def of ALL_PARAMS) {
      expect(def.id.length).toBeGreaterThan(0);
      expect(def.id).toMatch(/^[a-z]+(\.[a-z0-9]+)+$/);
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);
    }
  });

  it("keeps route slots bounded and generated", () => {
    for (let slot = 0; slot < P.ROUTE_COUNT; slot++) {
      for (const param of ["enabled", "source", "destination", "amount", "smoothMs"]) {
        expect(tryGetParamDef(P.routeParamId(slot, param))).toBeDefined();
      }
    }
    expect(tryGetParamDef(`routes.${P.ROUTE_COUNT}.enabled`)).toBeUndefined();
    expect(tryGetParamDef("routes.-1.enabled")).toBeUndefined();
    expect(P.isRouteParamId("routes.0.amount")).toBe(true);
    expect(P.isRouteParamId("routes.7.smoothMs")).toBe(true);
    expect(P.isRouteParamId("routes.8.amount")).toBe(false);
    expect(P.isRouteParamId("routesX.0.amount")).toBe(false);
  });

  it("round-trips plain unit ↔ normalized across the whole schema", () => {
    for (const def of ALL_PARAMS) {
      const mid = def.minValue + (def.maxValue - def.minValue) / 2;
      const norm = toNormalized(def.id, mid);
      expect(norm).toBeGreaterThanOrEqual(0);
      expect(norm).toBeLessThanOrEqual(1);
      const back = fromNormalized(def.id, norm);
      expect(Math.abs(back - mid)).toBeLessThan(1e-9);
      // Extremes round-trip exactly.
      expect(fromNormalized(def.id, toNormalized(def.id, def.minValue))).toBe(def.minValue);
      expect(fromNormalized(def.id, toNormalized(def.id, def.maxValue))).toBe(def.maxValue);
    }
  });

  it("clamps non-finite values to the DEFAULT, never NaN", () => {
    for (const def of ALL_PARAMS) {
      expect(clampParam(def.id, NaN)).toBe(def.defaultValue);
      expect(clampParam(def.id, Infinity)).toBe(def.defaultValue);
      expect(clampParam(def.id, -Infinity)).toBe(def.defaultValue);
      expect(clampParam(def.id, def.maxValue + 1e6)).toBe(def.maxValue);
      expect(clampParam(def.id, def.minValue - 1e6)).toBe(def.minValue);
    }
  });

  it("builds a complete default map", () => {
    const defaults = buildDefaultParams();
    expect(Object.keys(defaults).length).toBe(ALL_PARAMS.length);
    for (const def of ALL_PARAMS) expect(defaults[def.id]).toBe(def.defaultValue);
  });

  it("keeps booleans and enums non-automatable, continuous params automatable", () => {
    for (const def of ALL_PARAMS) {
      if (def.unit === "boolean" || def.unit === "enum") expect(def.automatable).toBe(false);
      else expect(def.automatable).toBe(true);
    }
    expect(getAutomatableParamIds().length).toBeGreaterThan(20);
  });

  it("keeps every destination bounded inside its safe region", () => {
    expect(MOD_DESTINATIONS.length).toBe(12);
    for (const dest of MOD_DESTINATIONS) {
      expect(dest.span).not.toBe(0);
      expect(dest.min).toBeLessThan(dest.max);
    }
    expect(MOD_SOURCES.length).toBe(7);
  });
});

describe("morph-dynamics factory presets", () => {
  it("contains the 8 golden presets in canonical order", () => {
    const ids = FACTORY_PRESETS.map((p) => p.id);
    GOLDEN_PRESET_IDS.forEach((goldenId, index) => {
      expect(ids[index]).toBe(goldenId);
    });
  });

  it("applies every preset to a fully-clamped, complete param map", () => {
    const defaults = buildDefaultParams();
    for (const preset of FACTORY_PRESETS) {
      const applied = applyMorphPreset(preset.params);
      // Same key set as defaults (complete map, no junk).
      expect(Object.keys(applied).sort()).toEqual(Object.keys(defaults).sort());
      for (const [id, value] of Object.entries(applied)) {
        expect(Number.isFinite(value)).toBe(true);
        const def = PARAM_BY_ID.get(id);
        expect(def).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(def!.minValue);
        expect(value).toBeLessThanOrEqual(def!.maxValue);
      }
    }
  });

  it("drops unknown ids and non-finite values from preset data", () => {
    const applied = applyMorphPreset({
      "macro.pressure": 80,
      "legacy.param": 5,
      "macro.body": NaN,
    });
    expect(applied["macro.pressure"]).toBe(80);
    expect(applied["legacy.param"]).toBeUndefined();
    expect(applied["macro.body"]).toBe(50); // default survives
  });

  it("gives every preset a description and valid category/intensity", () => {
    const categories = new Set(["vocal", "drums", "bass", "synth", "instrument", "bus", "creative"]);
    const intensities = new Set(["subtle", "moderate", "strong", "extreme"]);
    for (const preset of FACTORY_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(10);
      expect(categories.has(preset.category)).toBe(true);
      expect(intensities.has(preset.intensity)).toBe(true);
    }
  });
});

describe("morph-dynamics registry integration", () => {
  it("rack surface exposes the six macros + I/O", () => {
    const defaults = defaultParamsOf("morphdynamics");
    for (const id of [
      "macro.pressure",
      "macro.punch",
      "macro.body",
      "macro.texture",
      "macro.motion",
      "macro.space",
      "global.inputGainDb",
      "global.outputGainDb",
      "global.mix",
    ]) {
      expect(defaults[id]).toBeDefined();
    }
    expect(defaults["macro.pressure"]).toBe(35);
    expect(defaults["macro.punch"]).toBe(20);
  });

  it("normalizePluginParams retains deep params and clamps values", () => {
    const normalized = normalizePluginParams("morphdynamics", {
      "macro.pressure": 200, // out of range → clamped
      "dyn.thresholdDb": -40,
      "routes.0.amount": -75,
      "unknown.old.id": 3,
      "macro.body": "junk" as unknown as number,
    });
    expect(normalized).not.toBeNull();
    expect(normalized!["macro.pressure"]).toBe(100);
    expect(normalized!["dyn.thresholdDb"]).toBe(-40);
    expect(normalized!["routes.0.amount"]).toBe(-75);
    expect(normalized!["unknown.old.id"]).toBeUndefined();
    // Full default map present even for ids absent from the source.
    expect(normalized!["space.decayS"]).toBe(1.2);
    expect(Object.keys(normalized!).length).toBe(ALL_PARAMS.length);
  });
});
