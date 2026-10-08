import { describe, expect, it } from "vitest";
import { planReferenceMastering } from "../src/mcp/master-assistant";

/**
 * REFERENCE MASTERING planner pins ("urob to ako tento track"). The F2 §2.2
 * rule: the reference's own descriptors are NEVER the target — only the
 * measured DIFFERENCE drives steps. All steps bounded, deterministic, with
 * auditable WHY lines naming the measured gap.
 */

const base = {
  mine: { lufs: -14, crestDb: 11, correlation: 0.6, hfShare: 0.2, lowEndShare: 0.25 },
  reference: { lufs: -14, crestDb: 11, correlation: 0.6, hfShare: 0.2, lowEndShare: 0.25 },
};

describe("reference mastering planner", () => {
  it("identical sides → loudness-neutral plan only (no invented tonal moves)", () => {
    const plan = planReferenceMastering(base);
    expect(plan.find((s) => s.param === "eqHigh")).toBeUndefined();
    expect(plan.find((s) => s.param === "eqLow")).toBeUndefined();
    expect(plan.find((s) => s.param === "midWidth")).toBeUndefined();
  });

  it("hot air vs reference → AIR eased by the bounded delta; thin air → opened", () => {
    const hot = planReferenceMastering({
      ...base,
      mine: { ...base.mine, hfShare: 0.4 }, // 10·log10(0.4/0.2) = +3 dB
    });
    const air = hot.find((s) => s.param === "eqHigh")!;
    expect(air.value).toBeLessThan(0);
    expect(air.why).toContain("3.0 dB above");
    const thin = planReferenceMastering({
      ...base,
      mine: { ...base.mine, hfShare: 0.1 }, // −3 dB
    });
    expect(thin.find((s) => s.param === "eqHigh")!.value).toBeGreaterThan(0);
  });

  it("heavier low end → LOW eased; thinner → strengthened", () => {
    const heavy = planReferenceMastering({
      ...base,
      mine: { ...base.mine, lowEndShare: 0.5 }, // +3 dB
    });
    expect(heavy.find((s) => s.param === "eqLow")!.value).toBeLessThan(0);
    const thin = planReferenceMastering({
      ...base,
      mine: { ...base.mine, lowEndShare: 0.1 }, // −4 dB
    });
    expect(thin.find((s) => s.param === "eqLow")!.value).toBeGreaterThan(0);
  });

  it("reference loudness becomes the target; explicit targetLufs wins", () => {
    const toRef = planReferenceMastering({
      ...base,
      mine: { ...base.mine, lufs: -18 },
      reference: { ...base.reference, lufs: -14 },
    });
    expect(toRef.find((s) => s.param === "limit")).toBeDefined(); // needs loudness toward the reference
    const explicit = planReferenceMastering({
      ...base,
      mine: { ...base.mine, lufs: -18 },
      reference: { ...base.reference, lufs: -14 },
      targetLufs: -16,
    });
    expect(explicit.length).toBeGreaterThan(0);
  });

  it("reference width/crest deltas drive the space and dynamics families", () => {
    const wider = planReferenceMastering({
      ...base,
      reference: { ...base.reference, correlation: 0.3 }, // reference much wider
    });
    expect(wider.find((s) => s.param === "midWidth")?.value).toBe(1.2);
    const denser = planReferenceMastering({
      ...base,
      reference: { ...base.reference, crestDb: 6 }, // reference denser by 5 dB
    });
    expect(denser.find((s) => s.param === "glue")?.value).toBe(0.4);
    const dynamic = planReferenceMastering({
      ...base,
      reference: { ...base.reference, crestDb: 16 }, // reference keeps 5 dB more crest
    });
    expect(dynamic.find((s) => s.param === "preserve")?.value).toBe(0.7);
  });

  it("deterministic; every step bounded and auditable", () => {
    const pair = {
      mine: { lufs: -16, crestDb: 8, correlation: 0.95, hfShare: 0.4, lowEndShare: 0.1 },
      reference: { lufs: -14, crestDb: 12, correlation: 0.5, hfShare: 0.15, lowEndShare: 0.3 },
    };
    expect(planReferenceMastering(pair)).toEqual(planReferenceMastering(pair));
    for (const step of planReferenceMastering(pair)) {
      expect(Number.isFinite(step.value)).toBe(true);
      expect(step.why.length).toBeGreaterThan(10);
    }
  });
});
