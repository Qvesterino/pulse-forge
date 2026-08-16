import { describe, expect, it } from "vitest";
import { expandAutomationAcrossWindows } from "../src/rendering/renderer";
import type { AutomationPoint, Pattern } from "../src/project-model/types";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";

function makePattern(stepCount: number): Pattern {
  return {
    id: `pat-${stepCount}`,
    name: `Pattern ${stepCount}`,
    stepCount,
    rows: {},
    notes: {},
  };
}

describe("expandAutomationAcrossWindows", () => {
  it("emits the source points once when the window is exactly one pattern cycle long", () => {
    const pattern = makePattern(16);
    const points: AutomationPoint[] = [
      { tick: 0, value: 0 },
      { tick: STEP_TICKS * 8, value: 1 },
    ];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: STEP_TICKS * 16 },
    ]);
    expect(result).toEqual(points);
  });

  it("loops a 16-step pattern across 4 cycles inside a 4-bar window", () => {
    const pattern = makePattern(16);
    const points: AutomationPoint[] = [
      { tick: 0, value: 0 },
      { tick: STEP_TICKS * 8, value: 1 },
    ];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: STEP_TICKS * 16 * 4 },
    ]);
    expect(result).toHaveLength(8);
    for (let cycle = 0; cycle < 4; cycle++) {
      const base = cycle * STEP_TICKS * 16;
      expect(result[cycle * 2]).toEqual({ tick: base, value: 0 });
      expect(result[cycle * 2 + 1]).toEqual({ tick: base + STEP_TICKS * 8, value: 1 });
    }
  });

  it("respects a non-zero window base (clip that starts mid-song)", () => {
    const pattern = makePattern(16);
    const clipStart = 4 * BAR_TICKS;
    const points: AutomationPoint[] = [
      { tick: 0, value: 0.2 },
      { tick: STEP_TICKS * 4, value: 0.6 },
    ];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: clipStart, from: clipStart, to: clipStart + STEP_TICKS * 16 },
    ]);
    expect(result).toEqual([
      { tick: clipStart, value: 0.2 },
      { tick: clipStart + STEP_TICKS * 4, value: 0.6 },
    ]);
  });

  it("uses the per-window pattern size, not a hard-coded length", () => {
    // 32-step pattern (patternTicks = 32 * STEP_TICKS) inside a 2-bar window
    // (2 * BAR_TICKS = 2 * 4 * STEP_TICKS = 8 * STEP_TICKS = only 1 cycle)
    const pattern = makePattern(32);
    const points: AutomationPoint[] = [
      { tick: 0, value: 0 },
      { tick: STEP_TICKS * 16, value: 0.5 },
    ];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: 2 * BAR_TICKS },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tick: 0, value: 0 });
    expect(result[1]).toEqual({ tick: STEP_TICKS * 16, value: 0.5 });
  });

  it("loops a 16-step pattern three times across a 3-bar window", () => {
    const pattern = makePattern(16);
    const points: AutomationPoint[] = [{ tick: 0, value: 1 }];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: 3 * BAR_TICKS },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.tick)).toEqual([0, STEP_TICKS * 16, STEP_TICKS * 32]);
    expect(result.every((p) => p.value === 1)).toBe(true);
  });

  it("drops cycle points that would fall past the end of an uneven window", () => {
    const pattern = makePattern(16);
    const points: AutomationPoint[] = [
      { tick: 0, value: 0 },
      { tick: STEP_TICKS * 15, value: 0.9 },
    ];
    // 1.5 patterns = 24 * STEP_TICKS = 2880 ticks. The window holds 2 cycles
    // (base 0 and base 1920). In cycle 0, point tick 1800 → absolute 1800 (kept).
    // In cycle 1, point tick 0 → absolute 1920 (kept), but point tick 1800 →
    // absolute 3720 (dropped, >= 2880).
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: 24 * STEP_TICKS },
    ]);
    expect(result).toEqual([
      { tick: 0, value: 0 },
      { tick: 15 * STEP_TICKS, value: 0.9 },
      { tick: 16 * STEP_TICKS, value: 0 },
    ]);
  });

  it("expands across multiple windows and preserves each window's base", () => {
    const pattern = makePattern(16);
    const points: AutomationPoint[] = [{ tick: 0, value: 0.5 }];
    const result = expandAutomationAcrossWindows(points, [
      { pattern, base: 0, from: 0, to: STEP_TICKS * 16 },
      { pattern, base: 4 * BAR_TICKS, from: 4 * BAR_TICKS, to: 4 * BAR_TICKS + STEP_TICKS * 16 },
    ]);
    expect(result).toEqual([
      { tick: 0, value: 0.5 },
      { tick: 4 * BAR_TICKS, value: 0.5 },
    ]);
  });

  it("returns an empty list when the source has no points", () => {
    const pattern = makePattern(16);
    expect(
      expandAutomationAcrossWindows([], [{ pattern, base: 0, from: 0, to: STEP_TICKS * 16 }]),
    ).toEqual([]);
  });

  it("skips windows with a non-positive pattern length", () => {
    const pattern = makePattern(0);
    const points: AutomationPoint[] = [{ tick: 0, value: 0 }];
    expect(expandAutomationAcrossWindows(points, [{ pattern, base: 0, from: 0, to: 100 }])).toEqual([]);
  });
});
