import { describe, expect, it } from "vitest";
import {
  AUTOMATION_RAMP_GRID_TICKS,
  AUTOMATION_RAMP_MAX_EVENTS,
  interpolateAutomationPoints,
} from "../src/project-model/automation";
import type { AutomationPoint } from "../src/project-model/types";

/**
 * Phase 2 (docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md) — device/track automation
 * lanes now render as the ramps the lane editor draws: sparse points expand
 * to a 16th-note grid before the engine writes them. These pins hold the
 * expansion contract; the engine schedules discrete kinds (toggle/enum/
 * discrete) as raw point events instead.
 */

const pt = (tick: number, value: number): AutomationPoint => ({ tick, value });

describe("interpolateAutomationPoints", () => {
  it("expands a two-point ramp onto the 16th-note grid with correct interpolated values", () => {
    const out = interpolateAutomationPoints([pt(0, 0), pt(480, 15)]);
    // 0, 120, 240, 360, 480 — quarter of the range per 16th
    expect(out.map((p) => p.tick)).toEqual([0, 120, 240, 360, 480]);
    expect(out[2].value).toBeCloseTo(7.5, 6);
    expect(out[4].value).toBe(15);
  });

  it("interpolates through interior points without changing them", () => {
    const lane = [pt(0, 0), pt(240, 10), pt(480, 0)];
    const out = interpolateAutomationPoints(lane);
    for (const p of lane) {
      const hit = out.find((o) => o.tick === p.tick);
      expect(hit?.value).toBe(p.value);
    }
    // monotone up then down at the 16th grid between the anchors
    const mid = out.find((o) => o.tick === 120);
    expect(mid?.value).toBeCloseTo(5, 6);
    const midDown = out.find((o) => o.tick === 360);
    expect(midDown?.value).toBeCloseTo(5, 6);
  });

  it("short-circuits constant lanes — identical events carry no information", () => {
    const lane = [pt(0, 3), pt(480, 3), pt(960, 3)];
    expect(interpolateAutomationPoints(lane)).toEqual(lane);
  });

  it("keeps single-point and empty lanes untouched", () => {
    expect(interpolateAutomationPoints([pt(5, 1)])).toEqual([pt(5, 1)]);
    expect(interpolateAutomationPoints([])).toEqual([]);
  });

  it("doubles the stride adaptively on long lanes but keeps ramping", () => {
    // 4 bars at 480 ticks/bar = 1920 ticks → 16 events on the 16th grid.
    const out = interpolateAutomationPoints([pt(0, 0), pt(1920, 100)]);
    expect(out.length).toBeGreaterThan(8);
    expect(out.length).toBeLessThanOrEqual(AUTOMATION_RAMP_MAX_EVENTS);
    // endpoints survive any stride
    expect(out[0]).toEqual(pt(0, 0));
    expect(out[out.length - 1]).toEqual(pt(1920, 100));
    // grid is a multiple of the base grid after stride doubling
    for (let i = 1; i < out.length - 1; i++) {
      expect((out[i].tick - out[0].tick) % AUTOMATION_RAMP_GRID_TICKS).toBe(0);
    }
  });

  it("decimates instead of exploding past the event cap", () => {
    // span far beyond the cap: 480 * 2000 ticks with the base grid would be
    // ~8000 events — the helper must stay under the cap.
    const out = interpolateAutomationPoints([pt(0, 0), pt(480 * 2000, 10)]);
    expect(out.length).toBeLessThanOrEqual(AUTOMATION_RAMP_MAX_EVENTS);
    expect(out[0].tick).toBe(0);
    expect(out[out.length - 1].value).toBe(10);
  });

  it("respects a caller-provided cap", () => {
    const out = interpolateAutomationPoints([pt(0, 0), pt(4800, 10)], AUTOMATION_RAMP_GRID_TICKS, 16);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out[out.length - 1].value).toBe(10);
  });
});
