import { describe, it, expect, beforeEach } from "vitest";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { logIntentMiningEvent, INTENT_FAILURE_LOG_KEY } from "../src/intent/failure-log";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * MODEL-MISSES SURFACING (kyx_state subject:model-misses) — the failure-
 * mining log made visible to agents and the producer: the producer
 * sentences the deterministic layer AND the local model both failed on,
 * aggregated by frequency. LOCAL ONLY by contract — the log reads from
 * localStorage and never leaves the machine.
 */

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

beforeEach(() => {
  try {
    localStorage.removeItem(INTENT_FAILURE_LOG_KEY);
  } catch {
    /* noop */
  }
});

describe("kyx_state model-misses subject", () => {
  it("empty log → honest 'nothing yet' pointer to the mining purpose", async () => {
    const result = await executeMcpTool(makeCtx(), "kyx_state", { subject: "model-misses" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("no unanswered asks logged yet");
    expect(result.text).toContain("corpus round");
  });

  it("logged clarify + model-miss aggregate with hit counts, most frequent first", async () => {
    // "make it banging" failed twice (repeat collapse ×2), "vocal chop drop" once
    logIntentMiningEvent({ prompt: "make it banging", outcome: "model-miss" });
    logIntentMiningEvent({ prompt: "make it banging", outcome: "model-miss" });
    logIntentMiningEvent({ prompt: "vocal chop into the drop", outcome: "clarify", reason: "ambiguous target" });
    // model-hit must NOT appear (it worked — not a mining row)
    logIntentMiningEvent({ prompt: "mute the drums", outcome: "model-hit", routeKind: "fader" });

    const result = await executeMcpTool(makeCtx(), "kyx_state", { subject: "model-misses" });
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("2 unanswered ask(s), 3 hit(s) total");
    expect(result.text).toContain('[miss] "make it banging"');
    expect(result.text).toContain("2×");
    expect(result.text).toContain('[clarify] "vocal chop into the drop"');
    expect(result.text).toContain("ambiguous target");
    // the successful ask is not a mining row
    expect(result.text).not.toContain("mute the drums");
    // the read-back states the LOCAL ONLY contract
    expect(result.text).toContain("never telemetered");
  });

  it("lists up to 20 asks, sorted by hits", async () => {
    for (let i = 0; i < 5; i++) {
      logIntentMiningEvent({ prompt: `ask number ${i}`, outcome: "model-miss" });
    }
    const result = await executeMcpTool(makeCtx(), "kyx_state", { subject: "model-misses" });
    expect(result.text).toContain("5 unanswered ask(s), 5 hit(s) total");
    expect(result.text.match(/ask number/g)?.length).toBe(5);
  });

  it("the subject is documented in the kyx_state schema enum", () => {
    const state = MCP_TOOLS.find((tool) => tool.name === "kyx_state")!;
    const schema = state.inputSchema as unknown as { properties: { subject: { enum: string[] } } };
    expect(schema.properties.subject.enum).toContain("model-misses");
  });

  it("the schema enum includes reference + model-misses together (no subject regressions)", () => {
    const state = MCP_TOOLS.find((tool) => tool.name === "kyx_state")!;
    const schema = state.inputSchema as unknown as { properties: { subject: { enum: string[] } } };
    expect(schema.properties.subject.enum).toEqual(
      expect.arrayContaining(["overview", "history", "reference", "model-misses"]),
    );
  });
});
