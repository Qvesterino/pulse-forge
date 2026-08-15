import { describe, expect, it } from "vitest";
import { insertPointSorted, valueAt } from "../src/project-model/automation";

describe("automation valueAt", () => {
  const points = [
    { tick: 0, value: 1 },
    { tick: 480, value: 0 },
    { tick: 960, value: 0.5 },
  ];

  it("returns fallback for empty lanes", () => {
    expect(valueAt([], 100, 1)).toBe(1);
  });

  it("clamps to first value before the first point", () => {
    expect(valueAt(points, -50)).toBe(1);
    expect(valueAt(points, 0)).toBe(1);
  });

  it("clamps to last value after the last point", () => {
    expect(valueAt(points, 5000)).toBe(0.5);
  });

  it("interpolates linearly between points", () => {
    expect(valueAt(points, 240)).toBeCloseTo(0.5, 5);
    expect(valueAt(points, 120)).toBeCloseTo(0.75, 5);
    expect(valueAt(points, 720)).toBeCloseTo(0.25, 5);
  });

  it("returns exact point values at points", () => {
    expect(valueAt(points, 480)).toBe(0);
    expect(valueAt(points, 960)).toBe(0.5);
  });

  it("insertPointSorted keeps points ordered", () => {
    const sorted = insertPointSorted(
      [
        { tick: 480, value: 1 },
        { tick: 0, value: 0 },
      ],
      { tick: 240, value: 0.5 },
    );
    expect(sorted.map((p) => p.tick)).toEqual([0, 240, 480]);
  });
});
