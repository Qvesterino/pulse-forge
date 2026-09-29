import { describe, it, expect } from "vitest";
import {
  binomialTwoSidedPValue,
  summarizeAbxTrials,
  parseAbxTrialsJsonl,
  type AbxTrial,
} from "../src/listening/abx-stats";

/**
 * ABX LISTENING STATISTICS — the math that turns "1 person said it's okay"
 * into a discrimination measurement. Pins: exact binomial p-values, haste
 * filtering, JSONL tolerance, and the per-lane breakdown.
 */

function trial(lane: string, correct: boolean, reactionMs?: number): AbxTrial {
  const xWas: "A" | "B" = "A";
  const answer: "A" | "B" = correct ? "A" : "B";
  return { lane, xWas, answer, correct, ...(reactionMs != null ? { reactionMs } : {}) };
}

describe("binomial two-sided p-value", () => {
  it("matches known ABX reference values", () => {
    // classic listening-test table values
    expect(binomialTwoSidedPValue(8, 8)).toBeLessThan(0.01); // two-sided 8/8 = 1/256
    expect(binomialTwoSidedPValue(15, 20)).toBeLessThan(0.05);
    expect(binomialTwoSidedPValue(15, 20)).toBeGreaterThan(0.02); // ≈ 0.041
    expect(binomialTwoSidedPValue(14, 16)).toBeLessThan(0.05); // 14/16 two-sided ≈ 0.004
  });

  it("chance-level performance never reaches significance", () => {
    expect(binomialTwoSidedPValue(10, 20)).toBe(1.0); // exactly chance
    expect(binomialTwoSidedPValue(11, 20)).toBeGreaterThan(0.5);
    expect(binomialTwoSidedPValue(5, 10)).toBeGreaterThan(0.9);
  });

  it("below-chance also counts (two-sided: hearing a difference backwards)", () => {
    // 2/20 correct is as extreme as 18/20
    expect(binomialTwoSidedPValue(2, 20)).toBeLessThan(0.001);
  });

  it("edges: no trials → 1; perfect → small", () => {
    expect(binomialTwoSidedPValue(0, 0)).toBe(1);
    expect(binomialTwoSidedPValue(20, 20)).toBeLessThan(0.0001);
    expect(binomialTwoSidedPValue(0, 20)).toBeLessThan(0.0001);
  });
});

describe("trial summarization", () => {
  it("aggregates accuracy + significance + per-lane breakdown", () => {
    const trials: AbxTrial[] = [
      trial("groove-swing", true),
      trial("groove-swing", true),
      trial("groove-swing", true),
      trial("groove-swing", true),
      trial("groove-swing", true),
      trial("groove-swing", false),
      trial("preset-swap", true),
      trial("preset-swap", false),
    ];
    const summary = summarizeAbxTrials(trials);
    expect(summary.total).toBe(8);
    expect(summary.correct).toBe(6);
    // 6/8 is 75 % — NOT significant two-sided at this n (honest math)
    expect(summary.significant).toBe(false);
    expect(summary.perLane.find((lane) => lane.lane === "groove-swing")?.correct).toBe(5);
    expect(summary.perLane.find((lane) => lane.lane === "preset-swap")?.correct).toBe(1);
  });

  it("hasty clicks (< 1.5 s) are excluded, not counted as misses", () => {
    const trials: AbxTrial[] = [
      trial("groove-swing", false, 200), // hasty — excluded
      trial("groove-swing", true),
      trial("groove-swing", true),
    ];
    const summary = summarizeAbxTrials(trials);
    expect(summary.hastyExcluded).toBe(1);
    expect(summary.total).toBe(2);
    // 2/2 is still only p = 0.5 two-sided — tiny n can never be significant
    expect(summary.significant).toBe(false);
  });

  it("empty history is honest, never significant", () => {
    const summary = summarizeAbxTrials([]);
    expect(summary.total).toBe(0);
    expect(summary.pValue).toBe(1);
    expect(summary.significant).toBe(false);
    expect(summary.accuracy).toBe(0);
  });
});

describe("jsonl trials parsing", () => {
  it("parses rows, drops malformed and non-trial lines", () => {
    const content = [
      JSON.stringify({ lane: "groove-swing", xWas: "A", answer: "A", correct: true, receivedAt: 1 }),
      "",
      "{ broken",
      JSON.stringify({ lane: "groove-swing", xWas: "B", answer: "B", correct: true }),
      JSON.stringify({ hello: true }),
    ].join("\n");
    const trials = parseAbxTrialsJsonl(content);
    expect(trials).toHaveLength(2);
    expect(trials[0].lane).toBe("groove-swing");
    expect(trials[1].answer).toBe("B");
  });

  it("correct is DERIVED (xWas === answer), never trusted from the client", () => {
    const content = JSON.stringify({ lane: "x", xWas: "A", answer: "B", correct: true });
    const trials = parseAbxTrialsJsonl(content);
    expect(trials[0].correct).toBe(false); // a lying client cannot flip the stats
  });
});
