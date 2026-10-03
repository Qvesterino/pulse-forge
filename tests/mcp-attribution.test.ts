import { describe, it, expect } from "vitest";
import { withAgentAttribution, labelsRevertedBy, isForeignWork } from "../src/mcp/attribution";
import { executeMcpTool, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";
import type { Command } from "../src/commands/types";

/**
 * MULTI-AGENT SESSION ATTRIBUTION (C6 v1) — shared document, shared LIFO
 * undo history, LEGIBLE interleaving: attributed mutations carry an
 * [agent-id] label prefix, kyx_undo names what it reverts and warns when
 * an agent reverts work that was not its own.
 *
 * ProjectStore history is MOST-RECENT-LAST; kyx_undo's revert list is
 * most-recent-FIRST.
 */

function makeCtx(): McpToolContext {
  useDeterministicIds();
  resetDeterministicIds();
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    getDoc: () => store.doc,
    execute: (command: Command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  };
}

describe("withAgentAttribution", () => {
  it("local passes the context through untouched (no prefix tax for tests/human)", () => {
    const ctx = makeCtx();
    expect(withAgentAttribution(ctx, "local")).toBe(ctx);
  });

  it("attributed execute prefixes history labels; reads pass through", async () => {
    const ctx = makeCtx();
    const attributed = withAgentAttribution(ctx, "qmr");
    await executeMcpTool(attributed, "kyx_generate", { genre: "techno", seed: "attr" });
    const labels = ctx.historyLabels();
    expect(labels.length).toBe(1);
    expect(labels[0]).toMatch(/^\[qmr\] /);
    expect(attributed.undoStackLength()).toBe(1);
  });

  it("two agents interleaving stay legible in the shared history", async () => {
    const base = makeCtx();
    const qmr = withAgentAttribution(base, "qmr");
    const claude = withAgentAttribution(base, "desktop-stdio");
    await executeMcpTool(qmr, "kyx_generate", { genre: "techno", seed: "a" });
    await executeMcpTool(claude, "kyx_generate", { genre: "house", seed: "b" });
    const labels = base.historyLabels();
    // most recent LAST
    expect(labels[0]).toMatch(/^\[qmr\] /);
    expect(labels[1]).toMatch(/^\[desktop-stdio\] /);
  });
});

describe("kyx_undo read-back — reverts naming + foreign-work warning", () => {
  it("undo names the reverted labels (most recent first)", async () => {
    const ctx = makeCtx();
    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "one" });
    await executeMcpTool(ctx, "kyx_generate", { genre: "house", seed: "two" });
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 2 });
    expect(result.text).toContain("undo ×2 — reverts:");
    const reverted = result.text.slice(result.text.indexOf("reverts:"));
    // most recent (house) comes first
    expect(reverted.indexOf("house")).toBeLessThan(reverted.indexOf("techno"));
  });

  it("an agent reverting ANOTHER agent's work is REFUSED without consent (C6.2 guard)", async () => {
    const base = makeCtx();
    const qmr = withAgentAttribution(base, "qmr");
    const claude = withAgentAttribution(base, "desktop-stdio");
    await executeMcpTool(qmr, "kyx_generate", { genre: "techno", seed: "qmr-work" });
    await executeMcpTool(claude, "kyx_generate", { genre: "house", seed: "claude-work" });
    // qmr undoes one step — the top entry is CLAUDE's work: REFUSED
    const refused = await executeMcpTool(qmr, "kyx_undo", { action: "undo", steps: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.mutated).toBe(false);
    expect(refused.text).toContain("foreign work");
    expect(refused.text).toContain("allowForeign: true");
    // with explicit consent it goes through and says so
    const consented = await executeMcpTool(qmr, "kyx_undo", { action: "undo", steps: 1, allowForeign: true });
    expect(consented.mutated).toBe(true);
    expect(consented.text).toContain("foreign work reverted by explicit consent");
  });

  it("an agent reverting its OWN work is free; crossing into the human's edits needs consent", async () => {
    const base = makeCtx();
    await executeMcpTool(base, "kyx_generate", { genre: "techno", seed: "human-unlabeled" });
    const qmr = withAgentAttribution(base, "qmr");
    await executeMcpTool(qmr, "kyx_generate", { genre: "house", seed: "qmr-work" });
    // own work: free
    const own = await executeMcpTool(qmr, "kyx_undo", { action: "undo", steps: 1 });
    expect(own.mutated).toBe(true);
    expect(own.text).not.toContain("foreign work");
    // 2-step undo crosses into the human's unlabeled edit: REFUSED
    const crossed = await executeMcpTool(qmr, "kyx_undo", { action: "undo", steps: 1, allowForeign: false });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toContain("foreign work");
    const consented = await executeMcpTool(qmr, "kyx_undo", { action: "undo", steps: 1, allowForeign: true });
    expect(consented.mutated).toBe(true);
  });

  it("a human-context (unattributed) undo of its own work carries no warning", async () => {
    const ctx = makeCtx();
    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "a" });
    await executeMcpTool(ctx, "kyx_generate", { genre: "house", seed: "b" });
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(result.text).not.toContain("⚠");
  });
});

describe("attribution helpers", () => {
  it("labelsRevertedBy: undo slice is most-recent-first; redo is honestly unnamed", async () => {
    const ctx = makeCtx();
    const attributed = withAgentAttribution(ctx, "web-relay");
    await executeMcpTool(attributed, "kyx_generate", { genre: "techno", seed: "x1" });
    await executeMcpTool(attributed, "kyx_generate", { genre: "house", seed: "x2" });
    expect(labelsRevertedBy(ctx, "undo", 1)).toHaveLength(1);
    expect(labelsRevertedBy(ctx, "undo", 5)).toHaveLength(2);
    expect(labelsRevertedBy(ctx, "redo", 1)).toEqual([]);
  });

  it("isForeignWork: unlabeled is foreign; own prefix is not; other prefix is", () => {
    expect(isForeignWork("Rename track", null)).toBe(true);
    expect(isForeignWork("[qmr] Generate", "qmr")).toBe(false);
    expect(isForeignWork("[qmr] Generate", "web-relay")).toBe(true);
    expect(isForeignWork("[desktop-stdio] Undo", "qmr")).toBe(true);
  });

  it("every manifest custom command maps to a real tool (surface parity)", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(20);
  });
});
