import { describe, expect, it } from "vitest";
import { planMasterSettings } from "../src/mcp/master-assistant";

/**
 * MASTER ASSISTANT (M3, ADR 0020 lineage) — deterministic planner pins.
 * Every step must be auditable (why), bounded (inside registry ranges) and
 * reproducible: same measurement → same plan. The loudness authority stays
 * with the trim loop — the planner only proposes SHAPE.
 */

describe("master assistant planner", () => {
  it("quiet mix under target → limiting push + moderate maximizer drive", () => {
    const plan = planMasterSettings({ lufs: -18.5, peakDb: -4, crestDb: 11, correlation: 0.7 });
    const limit = plan.find((s) => s.device === "zenit" && s.param === "limit");
    expect(limit).toBeDefined();
    expect(limit!.value).toBeGreaterThan(0.25);
    expect(limit!.value).toBeLessThanOrEqual(0.7);
    expect(limit!.why).toContain("-18.5");
    expect(plan.find((s) => s.device === "apeks" && s.param === "drive")).toBeDefined();
  });

  it("hot mix gets ceiling discipline, not more limiting", () => {
    const plan = planMasterSettings({ lufs: -9, peakDb: -0.3, crestDb: 10, correlation: 0.6 });
    expect(plan.find((s) => s.param === "ceiling")?.value).toBe(-1.5);
    expect(plan.find((s) => s.param === "limit")).toBeUndefined();
  });

  it("squashed crest raises PRESERVE and lightens glue; peaky crest tightens glue", () => {
    const squashed = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 6, correlation: 0.6 });
    expect(squashed.find((s) => s.param === "preserve")?.value).toBe(0.75);
    expect(squashed.find((s) => s.param === "glue")?.value).toBe(0.15);
    const peaky = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 17, correlation: 0.6 });
    expect(peaky.find((s) => s.param === "glue")?.value).toBe(0.35);
  });

  it("near-mono mix widens mids/highs and collapses bass; phasey mix is pulled in", () => {
    const mono = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 11, correlation: 0.98 });
    expect(mono.find((s) => s.param === "lowWidth")?.value).toBe(0);
    expect(mono.find((s) => s.param === "highWidth")?.value).toBe(1.35);
    const phasey = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 11, correlation: 0.1 });
    expect(phasey.find((s) => s.param === "midWidth")?.value).toBe(0.85);
  });

  it("harsh top eases AIR, dull top opens it; unmeasurable loudness skips loudness rules", () => {
    const harsh = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 11, correlation: 0.6, hfShare: 0.4 });
    expect(harsh.find((s) => s.param === "eqHigh")?.value).toBe(-1.5);
    const dull = planMasterSettings({ lufs: -14, peakDb: -1, crestDb: 11, correlation: 0.6, hfShare: 0.05 });
    expect(dull.find((s) => s.param === "eqHigh")?.value).toBe(1.5);
    const noLufs = planMasterSettings({ lufs: null, peakDb: -1, crestDb: 11, correlation: 0.6 });
    expect(noLufs.find((s) => s.param === "limit")).toBeUndefined();
  });

  it("is deterministic: same measurement → identical plans; every value is finite", () => {
    const m = { lufs: -16.2, peakDb: -2, crestDb: 9, correlation: 0.97, hfShare: 0.4 };
    expect(planMasterSettings(m)).toEqual(planMasterSettings(m));
    for (const step of planMasterSettings(m)) {
      expect(Number.isFinite(step.value)).toBe(true);
      expect(step.why.length).toBeGreaterThan(10);
    }
  });
});
