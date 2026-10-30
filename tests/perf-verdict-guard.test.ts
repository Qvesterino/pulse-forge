import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bracketSpread, driftAwareVerdict, topKMean } from "../src/testing/perf-verdict";

/**
 * PERF GATE GUARD (2026-10-30) — the browser gate's budgets decide what a
 * measurement MEANS; these locks keep that decision honest, and keep it in the
 * form of the workload it arbitrates.
 *
 * THE DEFECT THIS CLOSES: the guard that demoted the render budgets was a
 * pure-JS spin on the harness thread — a DIFFERENT subsystem from the render
 * path it judged — with an 18 ms floor that the highest value ever measured on
 * this machine (17.3 ms) never crossed. A guard that cannot fire is not a
 * guard, and the verdict it did produce flipped between adjacent runs on a
 * busy dev machine: a verdict that changes with the weather is a coin.
 *
 * THE REPLACEMENT: the baseline bracket. The same workload the gate measures
 * is measured before AND after it (and, for the 14-template window, in the
 * middle of it), and the SPREAD of those readings says how much the machine
 * moved. The budget is compared against the BAND the measurement can occupy,
 * not against its point estimate — so a PASS and a FAIL are both robust to
 * that movement, and a reading the machine's movement alone explains is
 * reported rather than gated.
 *
 * THE SECOND DEFECT, in the shape gate: it read the single heaviest template,
 * a per-ITEM extreme, and per-item numbers here move by up to 2.6× between
 * adjacent runs. Simulated over the measured template sets, one template
 * 2.6× slower pushes "heaviest / average" over the budget in EVERY set — a
 * false red every time — while the mean of the three heaviest stays under it
 * in every set.
 */

/** The peer run of 2026-10-30 (rt-boundary-run1-single-pass.log), per template. */
const PEER_RUN_TEMPLATES = [6499, 11328, 3474, 5563, 3600, 4533, 2392, 2977, 2613, 6407, 6179, 7675, 5923, 2400];
/** The same run's baseline bracket: 2353-2369 ms (templates), 2268-2621 ms (dense). */
const PEER_BASELINE_SPREAD = 2369 / 2353;
const PEER_DENSE_SPREAD = 2621 / 2268;

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe("perf gate guard — the bracket is the guard", () => {
  it("a stable machine reads a spread of 1, and the measured brackets read 1.01x and 1.16x", () => {
    expect(bracketSpread([2400, 2400, 2400])).toBe(1);
    expect(bracketSpread([2400])).toBe(1);
    expect(bracketSpread([2353, 2369])).toBeCloseTo(1.0068, 3);
    expect(bracketSpread([2268, 2621])).toBeCloseTo(1.1557, 3);
  });

  it("the verdict is decided on the BAND the measurement can occupy, not on its point estimate", () => {
    // Even the least favourable reading passes → PASS.
    expect(driftAwareVerdict(2.17, 1.0068, 3).verdict).toBe("pass");
    // Even the most favourable reading fails → FAIL.
    expect(driftAwareVerdict(3.5, 1, 3).verdict).toBe("fail");
    // The budget cuts through the band → the machine's movement alone explains
    // the difference, so the reading is reported, not gated.
    expect(driftAwareVerdict(3, 1.4, 3).verdict).toBe("informational");
  });

  it("the band is reported with the verdict, so the message and the decision cannot diverge", () => {
    const verdict = driftAwareVerdict(3, 1.4, 3);
    expect(verdict.best).toBeCloseTo(3 / 1.4, 6);
    expect(verdict.worst).toBeCloseTo(3 * 1.4, 6);
  });

  it("both measured runs of the peer gate stay PASS under their own brackets", () => {
    // 14-template average: 5112 ms against a 2361 ms baseline = 2.17x.
    const avgRatio = mean(PEER_RUN_TEMPLATES) / 2361;
    expect(avgRatio).toBeGreaterThan(2);
    expect(driftAwareVerdict(avgRatio, PEER_BASELINE_SPREAD, 3).verdict).toBe("pass");
    // Dense 8x4: 13162 ms against a 2445 ms baseline = 5.38x, budget 7.5x.
    expect(driftAwareVerdict(5.38, PEER_DENSE_SPREAD, 7.5).verdict).toBe("pass");
  });

  it("a real regression still fails, and the band says exactly how far a machine excursion can excuse", () => {
    // 50% slower than the measured band (2.17x → 3.26x) is over the 3x budget.
    expect(driftAwareVerdict(3.26, 1, 3).verdict).toBe("fail");
    // A 15% machine excursion CAN explain that reading: 3.26 / 1.15 = 2.84x,
    // which is under the budget. So it is reported, not gated — stated here so
    // the width of the excuse is a number, not a surprise.
    expect(driftAwareVerdict(3.26, 1.15, 3).verdict).toBe("informational");
    // A regression bigger than the excursion survives it: 3.45 / 1.15 = 3.00x
    // is still over the budget under the most favourable reading.
    expect(driftAwareVerdict(3.45, 1.15, 3).verdict).toBe("fail");
  });
});

describe("perf gate guard — the shape gate reads the heavy tail as a group", () => {
  it("the mean of the three heaviest is what the gate reads", () => {
    expect(topKMean(PEER_RUN_TEMPLATES, 3)).toBeCloseTo((11328 + 7675 + 6499) / 3, 6);
    expect(topKMean([5, 4, 3, 2, 1], 3)).toBeCloseTo(4, 6);
  });

  it("one template 2.6x slower would false-red the single heaviest and does not red the top-3", () => {
    const burst = PEER_RUN_TEMPLATES.map((ms, i) => (i === 1 ? ms * 2.6 : ms));
    const burstAvg = mean(burst);
    // The statistic the gate used: over the 3x budget in this set — a false red.
    expect(Math.max(...burst) / burstAvg).toBeGreaterThan(3);
    // The statistic the gate uses now: under the budget in this set.
    expect(topKMean(burst, 3) / burstAvg).toBeLessThan(3);
  });
});

describe("perf gate guard — the browser gate is wired to the bracket", () => {
  const source = readFileSync(resolve(process.cwd(), "src/browser-checks.ts"), "utf8");

  it("takes the verdict helpers from the testable module", () => {
    expect(source).toContain('import { bracketSpread, driftAwareVerdict, topKMean } from "./testing/perf-verdict";');
  });

  it("no render budget is demoted by the foreign probe any more", () => {
    // The probe's verdict must not short-circuit a render gate.
    expect(source).not.toContain("machineLoaded ||");
  });

  it("the aggregate gate is decided by the drift-aware verdict", () => {
    expect(source).toContain("const avgVerdict = driftAwareVerdict(avgRatio, spread, BUDGET_AVERAGE_RATIO);");
    expect(source).toContain('avgVerdict.verdict !== "fail"');
  });

  it("the shape gate reads the three heaviest templates, not the one heaviest", () => {
    expect(source).toContain("const shapeMs = topKMean(budgetTimes, 3);");
    expect(source).toContain("perf: the three heaviest templates stay in proportion to the average");
    expect(source).not.toContain("perf: the heaviest template stays in proportion to the average");
  });

  it("the template window is bracketed on both sides AND in the middle", () => {
    expect(source).toContain("const baselineBefore = await measureSingleTrackBaseline(bank);");
    expect(source).toContain("const baselineAfter = await measureSingleTrackBaseline(bank);");
    expect(source).toContain("if (baselineReadings.length === 1 && budgetTimes.length === 7) {");
    expect(source).toContain("const spread = bracketSpread(baselineReadings);");
  });

  it("the dense gate brackets ITS OWN heavy render and decides on the bracket", () => {
    expect(source).toContain("const readings = [baselineBefore.ms, baselineAfter.ms];");
    expect(source).toContain("const spread = bracketSpread(readings);");
    expect(source).toContain("const verdict = driftAwareVerdict(ratio, spread, BUDGET_BASELINE_RATIO);");
    // Its signature carries no foreign veto any more.
    expect(source).toContain("export async function auditDenseRender(bank: SampleBank): Promise<CheckResult> {");
    expect(source).toContain("record(await auditDenseRender(bank));");
  });

  it("the realtime gate keeps the probe — its floor lives on the audio thread", () => {
    expect(source).toContain("record(await auditRtBudget(bank, machineLoaded, calibNote));");
  });
});
