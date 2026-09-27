import { describe, expect, it } from "vitest";
import {
  formatMorphParam,
  morphLaneRange,
  morphLaneParams,
  morphOptionGroups,
} from "../src/effects/morphDynamicsAutomation";

/**
 * MORPH DYNAMICS automation surface — the bridge between the parameter
 * schema (authoritative deep space) and the ModPanel automation lanes.
 * Pins: the route-slot collapse, plain-unit lane ranges, option grouping /
 * filtering, and every formatter branch (the lane editor's value readout).
 */

describe("morphLaneParams — lane target list", () => {
  const lanes = morphLaneParams();

  it("exposes automatable params only, with schema-plain min/max", () => {
    expect(lanes.length).toBeGreaterThan(20);
    for (const lane of lanes) {
      expect(Number.isFinite(lane.min)).toBe(true);
      expect(Number.isFinite(lane.max)).toBe(true);
      expect(lane.max).toBeGreaterThanOrEqual(lane.min);
      expect(lane.id).toMatch(/^[a-z0-9]+(\.[0-9a-zA-Z]+)+$/); // namespaced ids
    }
  });

  it("collapses route slots to slot 1 (representative lanes, 8×5 would drown the picker)", () => {
    const routeLanes = lanes.filter((lane) => lane.module === "Mod Matrix");
    expect(routeLanes.length).toBeGreaterThan(0);
    for (const lane of routeLanes) {
      expect(lane.id.startsWith("routes.1.")).toBe(true);
    }
    // Slot 2+ never leak through under any module label.
    expect(lanes.some((lane) => /^routes\.[2-8]\./.test(lane.id))).toBe(false);
  });

  it("pretty module names where documented; unknown prefixes pass through raw", () => {
    const byModule = (m: string) => lanes.some((lane) => lane.module === m);
    // Documented pretty names actually appear…
    expect(byModule("Dynamics")).toBe(true);
    expect(byModule("Mod Matrix")).toBe(true);
    // …and prefixes outside the pretty-name table fall back to the raw id
    // (the schema grows; the picker must never lose a module to a stale map).
    for (const lane of lanes) {
      expect(lane.module.length).toBeGreaterThan(0);
      expect(lane.module).not.toBe("");
    }
  });
});

describe("morphOptionGroups — grouped picker", () => {
  it("values route fxParam:fxId:paramId and labels pair name with id", () => {
    const groups = morphOptionGroups("fx-42", "");
    const all = groups.flatMap((g) => g.options);
    expect(all.length).toBe(morphLaneParams().length);
    const threshold = all.find((o) => o.value.endsWith(":dyn.thresholdDb"));
    expect(threshold?.label).toContain("dyn.thresholdDb");
    expect(threshold?.value).toBe("fxParam:fx-42:dyn.thresholdDb");
  });

  it("filters by label OR raw id, case-insensitively, and trims whitespace", () => {
    const byLabel = morphOptionGroups("fx", "thresh");
    expect(byLabel.flatMap((g) => g.options).every((o) => o.label.toLowerCase().includes("thresh"))).toBe(true);
    expect(byLabel.length).toBeGreaterThan(0);

    const byId = morphOptionGroups("fx", "DECAY");
    expect(byId.flatMap((g) => g.options).some((o) => o.value.includes("decay"))).toBe(true);

    const padded = morphOptionGroups("fx", "  thresh  ");
    expect(padded).toEqual(byLabel);
  });

  it("an unmatched filter yields no groups (not a throw)", () => {
    expect(morphOptionGroups("fx", "zzzznotaparam")).toEqual([]);
  });
});

describe("morphLaneRange + formatMorphParam — lane editor surface", () => {
  it("known ids return schema bounds; unknown ids return null (registry fallback)", () => {
    const range = morphLaneRange("dyn.thresholdDb");
    expect(range).not.toBeNull();
    expect(range!.max).toBeGreaterThanOrEqual(range!.min);

    expect(morphLaneRange("not.a.param")).toBeNull();
    // Route collapse is a LANE-LIST rule only — the schema lookup still
    // serves any real slot (lane editors may target them via raw ids).
    expect(morphLaneRange("routes.2.amount")).not.toBeNull();
  });

  it("formatters cover every unit branch", () => {
    expect(formatMorphParam("db", 3.24)).toBe("+3.2 dB"); // away from the toFixed tie
    expect(formatMorphParam("db", -6)).toBe("-6.0 dB");
    expect(formatMorphParam("db", 0)).toBe("+0.0 dB");
    expect(formatMorphParam("hz", 440)).toBe("440 Hz");
    expect(formatMorphParam("hz", 18000)).toBe("18.0 kHz");
    expect(formatMorphParam("hz", 999)).toBe("999 Hz");
    expect(formatMorphParam("ms", 5.42)).toBe("5.4 ms");
    expect(formatMorphParam("ms", 250)).toBe("250 ms");
    expect(formatMorphParam("percent", 33.4)).toBe("33%");
    expect(formatMorphParam("ratio", 4)).toBe("4.00:1");
    expect(formatMorphParam("sec", 1.5)).toBe("1.50 s");
    expect(formatMorphParam("boolean", 0.49)).toBe("OFF");
    expect(formatMorphParam("boolean", 0.5)).toBe("ON");
    expect(formatMorphParam("enum", 2.4)).toBe("2");
  });

  it("non-finite values format as an em dash, never NaN text", () => {
    expect(formatMorphParam("db", Number.NaN)).toBe("–");
    expect(formatMorphParam("hz", Number.POSITIVE_INFINITY)).toBe("–");
  });
});
