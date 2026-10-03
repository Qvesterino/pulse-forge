import { describe, it, expect, beforeEach } from "vitest";
import {
  planBlindPairGains,
  recordBlindAbTrial,
  summarizeBlindAb,
  resetBlindAbTrials,
  BLIND_AB_HASTE_MS,
} from "../src/mcp/blind-ab";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * IN-APP BLIND A/B (P4 completion) — the app-side half of the ABX loop:
 * symmetric LUFS level-matching (the SAME pure helper the offline page
 * uses) + a session trial log with the exact binomial verdict. The agent
 * plans and counts; the human listens.
 */

describe("planBlindPairGains", () => {
  it("delegates to the offline levelMatch helper (mean target, symmetric gains)", () => {
    const plan = planBlindPairGains(-16, -12);
    expect(plan.gains.matched).toBe(true);
    expect(plan.gains.targetLufs).toBe(-14);
    expect(plan.gains.gainDbA).toBeCloseTo(2, 5);
    expect(plan.gains.gainDbB).toBeCloseTo(-2, 5);
    expect(plan.note).toContain("level-matched to -14.0 LUFS");
  });

  it("unmeasurable side degrades honestly to native levels", () => {
    const plan = planBlindPairGains(null, -12);
    expect(plan.gains.matched).toBe(false);
    expect(plan.gains.gainDbA).toBe(0);
    expect(plan.gains.gainDbB).toBe(0);
    expect(plan.note).toContain("could not be measured");
  });
});

describe("trial log + binomial verdict", () => {
  beforeEach(() => {
    resetBlindAbTrials();
  });

  it("records correctness (answer === xWas) and verdicts honestly at chance", () => {
    // 10 coin-flip answers → no discrimination expected
    const answers: Array<"A" | "B"> = ["A", "B", "A", "A", "B", "B", "A", "B", "B", "A"];
    answers.forEach((answer) => {
      recordBlindAbTrial({ lane: "tilt-vs-flat", xWas: "A", answer, reactionMs: 3000 });
    });
    const summary = summarizeBlindAb("tilt-vs-flat")!;
    expect(summary.total).toBe(10);
    expect(summary.pValue).toBeGreaterThan(0.05);
    expect(summary.verdict).toContain("no significant discrimination");
  });

  it("strong discrimination yields a tiny p-value", () => {
    for (let i = 0; i < 18; i++) {
      recordBlindAbTrial({ lane: "night-and-day", xWas: "B", answer: "B", reactionMs: 4000 });
    }
    const summary = summarizeBlindAb("night-and-day")!;
    expect(summary.correct).toBe(18);
    expect(summary.total).toBe(18);
    expect(summary.pValue).toBeLessThan(0.001);
    expect(summary.verdict).toContain("STRONG");
  });

  it("hasty trials are excluded from the evidence (mirrors the offline haste filter)", () => {
    recordBlindAbTrial({ lane: "lane-x", xWas: "A", answer: "A", reactionMs: 200 });
    recordBlindAbTrial({ lane: "lane-x", xWas: "A", answer: "A", reactionMs: 200 });
    recordBlindAbTrial({ lane: "lane-x", xWas: "A", answer: "A", reactionMs: 4000 });
    const summary = summarizeBlindAb("lane-x")!;
    expect(summary.hastyExcluded).toBe(2);
    expect(summary.total).toBe(1);
    expect(summary.correct).toBe(1);
    expect(BLIND_AB_HASTE_MS).toBe(1500);
  });

  it("empty lane → null; verdict op answers honestly", async () => {
    expect(summarizeBlindAb("nothing-here")).toBeNull();
    const ctx = makeCtx();
    const empty = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "nothing-here" });
    expect(empty.text).toContain("no trials recorded");
  });
});

function makeCtx(): McpToolContext {
  useDeterministicIds();
  resetDeterministicIds();
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  };
}

describe("kyx_blind_ab tool contracts", () => {
  beforeEach(() => {
    resetBlindAbTrials();
  });

  it("plan: level-match passthrough with structured gains data", async () => {
    const ctx = makeCtx();
    const result = await executeMcpTool(ctx, "kyx_blind_ab", { op: "plan", lufsA: -16, lufsB: -12 });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("level-matched to -14.0 LUFS");
    const data = result.data as { gains?: { gainDbA?: number } };
    expect(data.gains?.gainDbA).toBeCloseTo(2, 5);
  });

  it("record validates the forced-choice fields; verdict carries the p-value", async () => {
    const ctx = makeCtx();
    const bad = await executeMcpTool(ctx, "kyx_blind_ab", { op: "record", lane: "l", xWas: "A" });
    expect(bad.isError).toBe(true);
    for (const xWas of ["A", "B"] as const) {
      await executeMcpTool(ctx, "kyx_blind_ab", {
        op: "record",
        lane: "tool-lane",
        xWas,
        answer: xWas,
        reactionMs: 2500,
      });
    }
    const verdict = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "tool-lane" });
    expect(verdict.text).toContain("2/2 correct");
    expect(verdict.text).toContain("p = ");
    expect(verdict.data).toMatchObject({ total: 2, correct: 2 });
  });

  it("reset clears the log; unknown op is isError", async () => {
    const ctx = makeCtx();
    await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "r",
      xWas: "A",
      answer: "A",
      reactionMs: 3000,
    });
    await executeMcpTool(ctx, "kyx_blind_ab", { op: "reset" });
    const after = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "r" });
    expect(after.text).toContain("no trials recorded");
    const badOp = await executeMcpTool(ctx, "kyx_blind_ab", { op: "listen" });
    expect(badOp.isError).toBe(true);
  });

  it("the tool is documented in MCP_TOOLS with all four ops", () => {
    const def = MCP_TOOLS.find((tool) => tool.name === "kyx_blind_ab");
    expect(def).toBeDefined();
    const schema = def!.inputSchema as unknown as { properties: { op: { enum: string[] } } };
    expect(schema.properties.op.enum).toEqual(["plan", "record", "verdict", "reset"]);
  });
});
