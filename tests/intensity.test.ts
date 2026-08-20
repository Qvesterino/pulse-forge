import { describe, expect, it } from "vitest";
import { computeSceneIntensity } from "../src/project-model/intensity";
import { sanitizeMarkers } from "../src/project-model/schema";

function makeScene(intensity: number, curve?: { offset: number; value: number }[]): any {
  return { id: "s1", name: "Test", patternId: "p1", intensity, intensityCurve: curve };
}

describe("intensity", () => {
  it("returns static intensity when no curve is present", () => {
    const scene = makeScene(0.7);
    expect(computeSceneIntensity(scene, 0, 0)).toBe(0.7);
    expect(computeSceneIntensity(scene, 0, 5000)).toBe(0.7);
  });

  it("clamps intensity to 0..1", () => {
    const scene = makeScene(1.5);
    expect(computeSceneIntensity(scene, 0, 0)).toBe(1);
  });

  it("interpolates a two-point curve linearly", () => {
    const scene = makeScene(0.5, [
      { offset: 0, value: 0.2 },
      { offset: 1920, value: 0.8 },
    ]);
    // At offset 0, returns the first curve point.
    expect(computeSceneIntensity(scene, 0, 0)).toBe(0.2);
    // Past the last curve point, returns the last value.
    expect(computeSceneIntensity(scene, 0, 2000)).toBeCloseTo(0.8, 2);
    // Mid-curve point.
    expect(computeSceneIntensity(scene, 0, 960)).toBeCloseTo(0.5, 2);
  });

  it("returns 0 before the scene start (outside clip window)", () => {
    const scene = makeScene(1);
    expect(computeSceneIntensity(scene, 1000, 500)).toBe(0);
  });

  it("handles empty curves gracefully", () => {
    const scene = makeScene(0.6, []);
    expect(computeSceneIntensity(scene, 0, 100)).toBe(0.6);
  });
});

describe("markers", () => {
  it("sanitizes markers: deduplicates, clamps ticks, drops invalid types", () => {
    const markers = [
      { id: "m1", name: "A", type: "drop", tick: 100 },
      { id: "m2", name: "B", type: "invalid", tick: 50 },
      { id: "m3", name: "C", type: "cue", tick: 200 },
    ];
    const sanitized = sanitizeMarkers(markers, 300);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0].type).toBe("cue"); // "invalid" -> "cue"
    expect(sanitized[0].tick).toBe(50);
    expect(sanitized[1].tick).toBe(100);
    expect(sanitized[2].tick).toBe(200);
  });

  it("drops markers with negative ticks and clamps to project length", () => {
    const markers = [
      { id: "m1", name: "Before", type: "drop", tick: -10 },
      { id: "m2", name: "After", type: "riser", tick: 500 },
    ];
    const sanitized = sanitizeMarkers(markers, 400);
    expect(sanitized[0].tick).toBe(0);
    expect(sanitized[1].tick).toBe(400);
  });
});
