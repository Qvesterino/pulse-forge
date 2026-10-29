import { describe, expect, it } from "vitest";
import { formatReport, reportsIdentical, runTargetingScenarios } from "../src/mcp/targeting-benchmark";
import { TARGETING_SCENARIOS } from "./mcp-targeting-scenarios";

/**
 * E9 — the targeting benchmark PIN. The harness (src/mcp/targeting-benchmark)
 * scores receipts over the seeded catalog; this spec pins three things:
 *
 * 1. every scenario in the catalog PASSES at the current head — a red here
 *    means an AI surface started acting on the wrong object, mutating when it
 *    must ask, or dropping a disclosure/refusal sentence;
 * 2. the benchmark is DETERMINISTIC — two runs over the same seeds produce
 *    byte-identical reports (the reproducibility gate; a harness whose
 *    receipts drift cannot baseline anything);
 * 3. every category keeps its floor, so silent catalog shrinking fails.
 */

describe("MCP targeting benchmark (E9)", () => {
  it("every seeded scenario passes — targeting, adversarial, refusal, verification", async () => {
    const report = await runTargetingScenarios(TARGETING_SCENARIOS);
    if (report.failed > 0) {
      throw new Error(`\n${formatReport(report)}`);
    }
    expect(report.passed).toBe(report.total);
    expect(report.total).toBe(TARGETING_SCENARIOS.length);
  }, 60_000);

  it("two runs over the same seeds produce identical receipts (determinism gate)", async () => {
    const first = await runTargetingScenarios(TARGETING_SCENARIOS);
    const second = await runTargetingScenarios(TARGETING_SCENARIOS);
    const verdict = reportsIdentical(first, second);
    expect(verdict.firstDivergence ?? "identical").toBe("identical");
    expect(verdict.identical).toBe(true);
  }, 90_000);

  it("category floors hold — the catalog cannot silently shrink", async () => {
    const report = await runTargetingScenarios(TARGETING_SCENARIOS);
    expect(report.byCategory.targeting.total).toBeGreaterThanOrEqual(10);
    expect(report.byCategory.adversarial.total).toBeGreaterThanOrEqual(5);
    expect(report.byCategory.refusal.total).toBeGreaterThanOrEqual(4);
    expect(report.byCategory.verification.total).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
