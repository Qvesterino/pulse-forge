import { describe, it, expect, beforeEach } from "vitest";
import {
  BLIND_AB_MAX_LANES,
  BLIND_AB_MAX_TRIALS,
  BLIND_AB_MAX_TRIALS_PER_LANE,
  BlindAbTrialLimitError,
  planBlindPairGains,
  recordBlindAbTrial,
  summarizeBlindAb,
  resetBlindAbTrials,
  BLIND_AB_HASTE_MS,
} from "../src/mcp/blind-ab";
import { executeMcpTool, MCP_TOOLS, resetMcpIdempotencyLedger, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

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
    resetMcpIdempotencyLedger();
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
  return withAgentWriter({
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  });
}

describe("kyx_blind_ab tool contracts", () => {
  beforeEach(() => {
    resetBlindAbTrials();
    resetMcpIdempotencyLedger();
  });

  it("plan: level-match passthrough with structured gains data", async () => {
    const ctx = makeCtx();
    const result = await executeMcpTool(ctx, "kyx_blind_ab", { op: "plan", lufsA: -16, lufsB: -12 });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("level-matched to -14.0 LUFS");
    const data = result.data as { gains?: { gainDbA?: number } };
    expect(data.gains?.gainDbA).toBeCloseTo(2, 5);
    expect(data).toMatchObject({ op: "plan", status: "planned" });
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
    expect(verdict.data).toMatchObject({
      op: "verdict",
      status: "summarized",
      lane: "tool-lane",
      hastyExcluded: 0,
      summary: { total: 2, correct: 2 },
    });
  });

  it("reset requires confirmation, clears the log and reports its counts", async () => {
    const ctx = makeCtx();
    const record = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "r",
      xWas: "A",
      answer: "A",
      reactionMs: 3000,
    });
    expect(record.data).toMatchObject({
      op: "record",
      status: "recorded",
      trial: { lane: "r", xWas: "A", answer: "A", correct: true, reactionMs: 3000 },
    });
    expect(record.idempotencyCommitted).toBeUndefined();
    const refused = await executeMcpTool(ctx, "kyx_blind_ab", { op: "reset" });
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe("POLICY_REFUSED");
    const reset = await executeMcpTool(ctx, "kyx_blind_ab", { op: "reset", confirm: true });
    expect(reset.data).toEqual({ op: "reset", status: "cleared", clearedLanes: 1, clearedTrials: 1 });
    const after = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "r" });
    expect(after.text).toContain("no trials recorded");
    expect(after.data).toEqual({ op: "verdict", status: "no_trials", lane: "r" });
    const badOp = await executeMcpTool(ctx, "kyx_blind_ab", { op: "listen" });
    expect(badOp.isError).toBe(true);
  });

  it("requestId replays committed trial records and a confirmed reset exactly once", async () => {
    const ctx = makeCtx();
    const first = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "retry",
      xWas: "B",
      answer: "B",
      requestId: "trial-once",
    });
    const replay = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "retry",
      xWas: "B",
      answer: "B",
      requestId: "trial-once",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(first.data);
    const beforeReset = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "retry" });
    expect(beforeReset.data).toMatchObject({ total: 1, correct: 1 });

    const firstReset = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "reset",
      confirm: true,
      requestId: "reset-once",
    });
    expect(firstReset.data).toMatchObject({ clearedTrials: 1 });
    await executeMcpTool(ctx, "kyx_blind_ab", { op: "record", lane: "newer", xWas: "A", answer: "A" });
    const resetReplay = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "reset",
      confirm: true,
      requestId: "reset-once",
    });
    expect(resetReplay.replayed).toBe(true);
    const newerVerdict = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "newer" });
    expect(newerVerdict.data).toMatchObject({ status: "summarized", total: 1, correct: 1 });
  });

  it("the tool publishes bounded input and output schemas for all four ops", () => {
    const def = MCP_TOOLS.find((tool) => tool.name === "kyx_blind_ab");
    expect(def).toBeDefined();
    const schema = def!.inputSchema as unknown as {
      properties: { op: { enum: string[] }; lane: { maxLength: number }; confirm: { type: string } };
    };
    expect(schema.properties.op.enum).toEqual(["plan", "record", "verdict", "reset"]);
    expect(schema.properties.lane.maxLength).toBe(128);
    expect(schema.properties.confirm.type).toBe("boolean");
    expect(def!.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["op", "status"],
      properties: {
        op: { enum: ["plan", "record", "verdict", "reset"] },
        gains: { required: ["matched", "targetLufs", "gainDbA", "gainDbB", "note"] },
        trial: { required: ["lane", "xWas", "answer", "correct", "receivedAt"] },
        summary: { required: ["lane", "total", "correct", "pValue", "hastyExcluded", "verdict"] },
      },
    });
  });

  it("dry-run cannot record or erase trials; plan and verdict remain read-only", async () => {
    const ctx = makeCtx();
    const record = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "dry-run",
      xWas: "A",
      answer: "A",
      dryRun: true,
    });
    expect(record.isError).toBe(true);
    expect(record.errorCode).toBe("POLICY_REFUSED");
    const reset = await executeMcpTool(ctx, "kyx_blind_ab", { op: "reset", confirm: true, dryRun: true });
    expect(reset.isError).toBe(true);
    expect(reset.errorCode).toBe("POLICY_REFUSED");
    const verdict = await executeMcpTool(ctx, "kyx_blind_ab", { op: "verdict", lane: "dry-run", dryRun: true });
    expect(verdict.isError).toBeUndefined();
    expect(verdict.data).toEqual({ op: "verdict", status: "no_trials", lane: "dry-run" });
  });

  it("rejects invalid lane lengths and bounds per-session trial storage", async () => {
    const ctx = makeCtx();
    const tooLongLane = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "x".repeat(129),
      xWas: "A",
      answer: "A",
    });
    expect(tooLongLane.errorCode).toBe("INVALID_ARGUMENTS");

    for (let index = 0; index < BLIND_AB_MAX_TRIALS_PER_LANE; index += 1) {
      recordBlindAbTrial({ lane: "full", xWas: "A", answer: "A" });
    }
    const fullLane = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "full",
      xWas: "A",
      answer: "A",
    });
    expect(fullLane.isError).toBe(true);
    expect(fullLane.errorCode).toBe("RESOURCE_LIMIT");

    resetBlindAbTrials();
    for (let index = 0; index < BLIND_AB_MAX_LANES; index += 1) {
      recordBlindAbTrial({ lane: `lane-${index}`, xWas: "A", answer: "A" });
    }
    const fullSession = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "lane-over-limit",
      xWas: "A",
      answer: "A",
    });
    expect(fullSession.isError).toBe(true);
    expect(fullSession.errorCode).toBe("RESOURCE_LIMIT");
    expect(BLIND_AB_MAX_LANES).toBe(64);
    expect(() => recordBlindAbTrial({ lane: "x".repeat(129), xWas: "A", answer: "A" })).toThrow(BlindAbTrialLimitError);

    resetBlindAbTrials();
    for (let index = 0; index < BLIND_AB_MAX_TRIALS; index += 1) {
      recordBlindAbTrial({
        lane: `global-${Math.floor(index / BLIND_AB_MAX_TRIALS_PER_LANE)}`,
        xWas: "A",
        answer: "A",
      });
    }
    const fullTrialBudget = await executeMcpTool(ctx, "kyx_blind_ab", {
      op: "record",
      lane: "global-over-limit",
      xWas: "A",
      answer: "A",
    });
    expect(fullTrialBudget.errorCode).toBe("RESOURCE_LIMIT");
  });
});
