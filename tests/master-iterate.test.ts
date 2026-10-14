import { describe, expect, it } from "vitest";
import { iterateTowardTarget, isConverged, DEFAULT_TOLERANCES } from "../src/mcp/master-iterate";
import type { IterateMeasurement } from "../src/mcp/master-iterate";

/**
 * CLOSED-LOOP TONAL ITERATOR pins. Each iteration produces bounded
 * adjustments toward the target; the loop converges when all deltas are
 * within tolerance. The executor calls this in a bounded render→measure→
 * adjust loop — the planner itself is pure.
 */

function measurement(overrides: Partial<IterateMeasurement> = {}): IterateMeasurement {
  return {
    lufs: -14,
    crestDb: 11,
    correlation: 0.6,
    bandSharesDb: { air: -7, low: -6, mid: -3 }, // 10*log10(0.2)=-7, 10*log10(0.25)=-6 — CONVERGED
    target: { lufs: -14, crestDb: 11, correlation: 0.6, hfShare: 0.2, lowEndShare: 0.25 },
    ...overrides,
  };
}

describe("iterateTowardTarget", () => {
  it("converged measurement produces ZERO steps (the loop terminates)", () => {
    expect(iterateTowardTarget(measurement())).toEqual([]);
    expect(isConverged(measurement())).toBe(true);
  });

  it("quiet mix → limiting push; hot mix → ceiling discipline", () => {
    const quiet = iterateTowardTarget(measurement({ lufs: -18, target: { ...measurement().target, lufs: -14 } }));
    expect(quiet.find((s) => s.param === "limit")?.delta).toBeGreaterThan(0);
    const hot = iterateTowardTarget(measurement({ lufs: -10, target: { ...measurement().target, lufs: -14 } }));
    expect(hot.find((s) => s.param === "ceiling")?.delta).toBeLessThan(0);
  });

  it("hot air → eqHigh negative delta; thin low end → eqLow positive delta", () => {
    const hot = iterateTowardTarget(measurement({ bandSharesDb: { air: -3, low: -6 } }));
    expect(hot.find((s) => s.param === "eqHigh")?.delta).toBeLessThan(0);
    const thin = iterateTowardTarget(measurement({ bandSharesDb: { air: -14, low: -14 } }));
    expect(thin.find((s) => s.param === "eqLow")?.delta).toBeGreaterThan(0);
  });

  it("correlation delta drives sirka midWidth; crest delta drives preserve/glue", () => {
    const wide = iterateTowardTarget(
      measurement({
        correlation: 0.9,
        target: { ...measurement().target, correlation: 0.4 },
      }),
    );
    expect(wide.find((s) => s.param === "midWidth")?.delta).toBeLessThan(0);
    const squashed = iterateTowardTarget(measurement({ crestDb: 5 }));
    expect(squashed.find((s) => s.param === "preserve")?.delta).toBeGreaterThan(0);
  });

  it("deltas are capped per iteration (smooth convergence, no overshoot)", () => {
    const extreme = iterateTowardTarget(measurement({ bandSharesDb: { air: 0, low: 0 } }));
    for (const step of extreme) {
      expect(Math.abs(step.delta)).toBeLessThanOrEqual(1.5);
    }
  });

  it("is deterministic; isConverged flips at tolerance boundaries", () => {
    const m = measurement({ lufs: -15.2 });
    expect(iterateTowardTarget(m)).toEqual(iterateTowardTarget(m));
    expect(isConverged(measurement({ lufs: -14.4 }))).toBe(true); // within ±0.5 LU
    expect(isConverged(measurement({ lufs: -15.0 }))).toBe(false); // 1 LU off
  });
});
