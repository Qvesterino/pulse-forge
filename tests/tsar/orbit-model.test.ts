import { describe, expect, it } from "vitest";
import {
  defaultOrbitMapping,
  describeOrbitMapping,
  isOrbitAxisLive,
  isOrbitTarget,
  normalizeOrbitMapping,
  ORBIT_PRESETS,
  ORBIT_TARGETS,
  ORBIT_TARGET_BY_ID,
  orbitAxisPosition,
  orbitAxisValue,
  orbitAxesCollide,
} from "../../src/tsar/orbit";
import { tsarParams } from "../../src/tsar/params";

/**
 * TSAR ORBIT — the model (ADR 0074).
 *
 * The surface's contract is a PROMISE about what it can do: every target is
 * a real, continuous TSAR parameter; every preset is a legal mapping; a
 * damaged mapping still loads as a working surface; and the position maths
 * round-trips, so the handle and the parameter can never drift apart.
 */

const PARAM_DEFS = new Map(tsarParams.map((param) => [param.id, param]));

describe("ORBIT targets", () => {
  it("every target is a registered TSAR parameter", () => {
    expect(ORBIT_TARGETS.length).toBeGreaterThan(10);
    for (const target of ORBIT_TARGETS) {
      expect(PARAM_DEFS.has(target.id), `${target.id} is not a TSAR parameter`).toBe(true);
    }
  });

  it("no target is discrete, an enum or a toggle (the automation bridge cannot interpolate those)", () => {
    for (const target of ORBIT_TARGETS) {
      const def = PARAM_DEFS.get(target.id)!;
      expect(def.kind ?? "continuous").not.toBe("discrete");
      expect(def.kind ?? "continuous").not.toBe("enum");
      expect(def.kind ?? "continuous").not.toBe("toggle");
      expect(def.options, `${target.id} has options — it is an enum`).toBeUndefined();
    }
  });

  it("the catalogue carries the axes the roadmap names — morph, cutoff, modulation intensity", () => {
    const ids = new Set(ORBIT_TARGETS.map((target) => target.id));
    expect(ids.has("morph")).toBe(true);
    expect(ids.has("srcACutoff")).toBe(true);
    expect(ids.has("srcBCutoff")).toBe(true);
    expect(ids.has("mod1Amt")).toBe(true);
  });

  it("the catalogue is a curated subset — not every TSAR parameter is assignable", () => {
    expect(ORBIT_TARGETS.length).toBeLessThan(tsarParams.length);
    // The loudness and identity parameters stay out: an axis that changes
    // the instrument's LEVEL is not a performance surface, it is a fader.
    const ids = new Set(ORBIT_TARGETS.map((target) => target.id));
    expect(ids.has("level")).toBe(false);
    expect(ids.has("srcALevel")).toBe(false);
    expect(ids.has("arpOn")).toBe(false);
  });

  it("every target's range is the parameter's own range and its default is the parameter's default", () => {
    for (const target of ORBIT_TARGETS) {
      const def = PARAM_DEFS.get(target.id)!;
      expect(target.min).toBe(def.min);
      expect(target.max).toBe(def.max);
      expect(target.default).toBe(def.default);
      expect(target.max).toBeGreaterThan(target.min);
    }
  });

  it("isOrbitTarget answers for the catalogue and refuses everything else", () => {
    expect(isOrbitTarget("srcACutoff")).toBe(true);
    expect(isOrbitTarget("srcAEngine")).toBe(false);
    expect(isOrbitTarget("notAParam")).toBe(false);
  });
});

describe("ORBIT presets", () => {
  it("every preset names two real targets over a legal range", () => {
    expect(ORBIT_PRESETS.length).toBeGreaterThan(1);
    for (const preset of ORBIT_PRESETS) {
      for (const axis of [preset.x, preset.y]) {
        const target = ORBIT_TARGET_BY_ID[axis.paramId];
        expect(target, `${preset.id} drives ${axis.paramId}, which is not assignable`).toBeDefined();
        expect(axis.max).toBeGreaterThan(axis.min);
        expect(axis.min).toBeGreaterThanOrEqual(target!.min);
        expect(axis.max).toBeLessThanOrEqual(target!.max);
      }
    }
  });

  it("no preset drives the same parameter on both axes", () => {
    for (const preset of ORBIT_PRESETS) {
      expect(preset.x.paramId).not.toBe(preset.y.paramId);
    }
  });

  it("the default mapping IS the first preset — the original is a value, not a gesture", () => {
    const preset = ORBIT_PRESETS[0]!;
    const fallback = defaultOrbitMapping();
    expect(fallback.x).toEqual(preset.x);
    expect(fallback.y).toEqual(preset.y);
  });
});

describe("ORBIT mapping repair", () => {
  it("a healthy mapping survives untouched", () => {
    const mapping = { x: { paramId: "srcACutoff", min: 200, max: 12000 }, y: { paramId: "morph", min: 0, max: 1 } };
    expect(normalizeOrbitMapping(mapping)).toEqual(mapping);
  });

  it("an unknown parameter id falls back to the default axis", () => {
    const repaired = normalizeOrbitMapping({
      x: { paramId: "notAParam", min: 0, max: 1 },
      y: { paramId: "morph", min: 0, max: 1 },
    });
    expect(repaired.x).toEqual(defaultOrbitMapping().x);
    expect(repaired.y.paramId).toBe("morph");
  });

  it("a discrete parameter falls back to the default axis — the surface never drives an enum", () => {
    const repaired = normalizeOrbitMapping({
      x: { paramId: "srcAEngine", min: 0, max: 2 },
      y: { paramId: "morph", min: 0, max: 1 },
    });
    expect(repaired.x.paramId).toBe(defaultOrbitMapping().x.paramId);
  });

  it("an impossible range falls back to the parameter's own range", () => {
    const repaired = normalizeOrbitMapping({
      x: { paramId: "srcACutoff", min: 9000, max: 100 },
      y: { paramId: "morph", min: 0, max: 1 },
    });
    expect(repaired.x.min).toBe(ORBIT_TARGET_BY_ID["srcACutoff"]!.min);
    expect(repaired.x.max).toBe(ORBIT_TARGET_BY_ID["srcACutoff"]!.max);
  });

  it("a range that leaves the parameter's own limits is clamped back inside them", () => {
    const repaired = normalizeOrbitMapping({
      x: { paramId: "srcAQ", min: -50, max: 500 },
      y: { paramId: "morph", min: 0, max: 1 },
    });
    expect(repaired.x.min).toBe(ORBIT_TARGET_BY_ID["srcAQ"]!.min);
    expect(repaired.x.max).toBe(ORBIT_TARGET_BY_ID["srcAQ"]!.max);
  });

  it("a missing or broken mapping still yields a working surface", () => {
    expect(normalizeOrbitMapping(undefined)).toEqual(defaultOrbitMapping());
    expect(normalizeOrbitMapping(null)).toEqual(defaultOrbitMapping());
    expect(normalizeOrbitMapping("nonsense")).toEqual(defaultOrbitMapping());
    expect(normalizeOrbitMapping({ x: 7 })).toEqual(defaultOrbitMapping());
  });

  it("two axes on one parameter are refused by the mapping helper", () => {
    const collide = {
      x: { paramId: "srcACutoff", min: 30, max: 18000 },
      y: { paramId: "srcACutoff", min: 30, max: 18000 },
    };
    expect(orbitAxesCollide(collide)).toBe(true);
    expect(orbitAxesCollide(defaultOrbitMapping())).toBe(false);
  });

  it("the mapping describes itself in one line", () => {
    expect(describeOrbitMapping(defaultOrbitMapping())).toContain("×");
  });
});

describe("ORBIT position maths", () => {
  it("position and value are inverses", () => {
    const axis = { paramId: "srcACutoff", min: 200, max: 12000 };
    for (const position of [0, 0.25, 0.5, 0.75, 1]) {
      const value = orbitAxisValue(axis, position);
      expect(orbitAxisPosition(axis, value)).toBeCloseTo(position, 6);
    }
  });

  it("a log parameter spends its travel musically — the middle is the geometric mean", () => {
    const axis = { paramId: "srcACutoff", min: 30, max: 18000 };
    const middle = orbitAxisValue(axis, 0.5);
    expect(middle).toBeCloseTo(Math.sqrt(30 * 18000), 3);
  });

  it("a linear parameter is the identity", () => {
    const axis = { paramId: "morph", min: 0, max: 1 };
    expect(orbitAxisValue(axis, 0.5)).toBeCloseTo(0.5, 6);
    expect(orbitAxisValue(axis, 0.25)).toBeCloseTo(0.25, 6);
  });

  it("the position is clamped to 0..1 — a value outside the range sits at the edge", () => {
    const axis = { paramId: "srcACutoff", min: 200, max: 12000 };
    expect(orbitAxisPosition(axis, 18000)).toBe(1);
    expect(orbitAxisPosition(axis, 30)).toBe(0);
    expect(orbitAxisValue(axis, 2)).toBe(12000);
    expect(orbitAxisValue(axis, -1)).toBe(200);
  });
});

describe("ORBIT axis liveness", () => {
  it("a mod slot with no source or no destination is silent — its amount reaches no ear", () => {
    expect(isOrbitAxisLive("mod1Amt", { mod1Src: -1, mod1Dst: -1 })).toBe(false);
    expect(isOrbitAxisLive("mod1Amt", { mod1Src: 0, mod1Dst: -1 })).toBe(false);
    expect(isOrbitAxisLive("mod1Amt", { mod1Src: 0, mod1Dst: 1 })).toBe(true);
  });

  it("the mutation engine's rules are reused, not re-invented", () => {
    // An open filter makes its Q silent; a silent source makes its cutoff
    // silent; the global morph needs both sources.
    expect(isOrbitAxisLive("srcAQ", { srcACutoff: 18000 })).toBe(false);
    expect(isOrbitAxisLive("srcACutoff", { srcALevel: 0 })).toBe(false);
    expect(isOrbitAxisLive("morph", { srcALevel: 0.8, srcBLevel: 0 })).toBe(false);
    expect(isOrbitAxisLive("morph", { srcALevel: 0.8, srcBLevel: 0.5 })).toBe(true);
  });
});
