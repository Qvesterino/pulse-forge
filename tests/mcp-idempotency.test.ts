import { describe, it, expect, beforeEach } from "vitest";
import { executeMcpTool, resetMcpIdempotencyLedger, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * P1-B IDEMPOTENCY LEDGER (control-surface audit 2026-10-13, GAP-04 /
 * roadmap P1-B). Relative operations re-apply against live state, so a
 * retried or duplicated agent request double-applies. The ledger at the
 * dispatcher chokepoint makes a caller-supplied requestId name ONE logical
 * operation: the first document mutation or explicitly marked session-side
 * effect is remembered; a repeat returns that exact outcome (`replayed:
 * true`) instead of re-executing.
 *
 * Contract under test:
 *  ID1 same requestId twice → applies exactly once; second call is a replay
 *      carrying the ORIGINAL outcome
 *  ID2 a different requestId applies again
 *  ID3 no requestId → every call applies (backward compatible)
 *  ID4 reads are never cached — a retried read executes fresh
 *  ID5 failed calls are not cached — fix the args, same id re-executes
 *  ID6 undo after a mutation: the replay still returns the original outcome
 *      and does NOT re-apply (the agent owns undo/redo)
 *  ID7 entries are scoped to the producing project document; the same id in
 *      another project executes fresh and re-binds
 *  ID8 the ledger is bounded and evicts deterministically (oldest first)
 *  ID9 kyx_batch: a batch-level requestId caches the WHOLE batch outcome as
 *      one unit; per-call requestIds inside `calls` work through the same
 *      wrapper
 *  ID10 the envelope is discoverable: every tool schema declares requestId
 */

function makeCtx(start: ProjectDocument): {
  ctx: McpToolContext;
  doc: () => ProjectDocument;
  setDoc: (doc: ProjectDocument) => void;
  undo: () => void;
} {
  let current = start;
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const labels: string[] = [];
  const ctx: McpToolContext = withAgentWriter({
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      labels.push(command.label);
      // Called with the document CURRENT AT CALL TIME, matching the real
      // ProjectStore (`command.undo(this.doc_)`). snapshot() is delta-based:
      // it applies its inverse ops to whatever document it is handed, so
      // capturing `prev` here made undo re-add the parent instead of removing
      // the fragments it had created.
      undoStack.push({ undo: () => command.undo(current), redo: () => command.execute(current) });
      redoStack.length = 0;
    },
    undo: () => {
      const entry = undoStack.pop();
      if (entry) {
        current = entry.undo();
        redoStack.push(entry);
      }
    },
    redo: () => {
      const entry = redoStack.pop();
      if (entry) {
        current = entry.redo();
        undoStack.push(entry);
      }
    },
    undoStackLength: () => undoStack.length,
    historyLabels: () => [...labels],
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  });
  return { ctx, doc: () => current, setDoc: (next) => (current = next), undo: () => ctx.undo() };
}

const groove = (ctx: McpToolContext, args: Record<string, unknown>) => executeMcpTool(ctx, "kyx_groove", args);

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("mcp idempotency ledger (P1-B, GAP-04)", () => {
  it("ID1 same requestId twice applies exactly once; the repeat replays the original outcome", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const first = await groove(ctx, { direction: "more", requestId: "r1" });
    expect(first.mutated).toBe(true);
    expect(first.replayed).toBeUndefined();
    const afterFirst = doc();
    const second = await groove(ctx, { direction: "more", requestId: "r1" });
    expect(second.replayed).toBe(true);
    expect(second.text).toContain("idempotent replay");
    expect(second.text).toBe(`idempotent replay — requestId was already applied; nothing re-executed\n${first.text}`);
    expect(doc()).toBe(afterFirst); // no execution — not even a new document revision
  });

  it("ID2 a different requestId applies again", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    await groove(ctx, { direction: "more", requestId: "r1" });
    const afterFirst = doc();
    const second = await groove(ctx, { direction: "more", requestId: "r2" });
    expect(second.mutated).toBe(true);
    expect(second.replayed).toBeUndefined();
    expect(doc()).not.toBe(afterFirst);
  });

  it("ID3 no requestId keeps the old behavior: every call applies", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const first = await groove(ctx, { direction: "more" });
    const second = await groove(ctx, { direction: "more" });
    expect(first.replayed).toBeUndefined();
    expect(second.replayed).toBeUndefined();
    expect(doc()).not.toBe(createProjectFromTemplate("house"));
    expect(second.mutated).toBe(true);
  });

  it("ID4 reads are never cached — a retried read executes fresh", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    await groove(ctx, { direction: "more", requestId: "seed" });
    const read1 = await executeMcpTool(ctx, "kyx_state", { subject: "groove", requestId: "read-1" });
    const read2 = await executeMcpTool(ctx, "kyx_state", { subject: "groove", requestId: "read-1" });
    expect(read1.mutated).toBe(false);
    expect(read2.mutated).toBe(false);
    expect(read2.replayed).toBeUndefined();
  });

  it("ID5 failed calls are not cached — fixing the args and retrying with the same id re-executes", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const bad = await executeMcpTool(ctx, "kyx_tracks", { op: "no-such-op", requestId: "r5" });
    expect(bad.mutated).toBe(false);
    const good = await executeMcpTool(ctx, "kyx_tracks", {
      op: "rename",
      trackId: doc().tracks[0]!.id,
      name: "Renamed",
      requestId: "r5",
    });
    expect(good.mutated).toBe(true);
    expect(good.replayed).toBeUndefined();
    expect(doc().tracks[0]!.name).toBe("Renamed");
  });

  it("ID6 undo after a mutation: the replay returns the original outcome and does not re-apply", async () => {
    const { ctx, doc, undo } = makeCtx(createProjectFromTemplate("house"));
    const start = doc();
    await groove(ctx, { direction: "more", requestId: "r6" });
    undo();
    const undone = doc();
    expect(undone).not.toBe(start);
    const replay = await groove(ctx, { direction: "more", requestId: "r6" });
    expect(replay.replayed).toBe(true);
    expect(doc()).toBe(undone); // replay does not resurrect the change
  });

  it("ID7 entries are project-scoped: the same id in another project executes fresh and re-binds", async () => {
    const docA = createProjectFromTemplate("house");
    const docB = createProjectFromTemplate("house");
    expect(docA.id).not.toBe(docB.id);
    const harness = makeCtx(docA);
    const first = await groove(harness.ctx, { direction: "more", requestId: "r7" });
    expect(first.mutated).toBe(true);
    harness.setDoc(docB);
    const inB = await groove(harness.ctx, { direction: "more", requestId: "r7" });
    expect(inB.replayed).toBeUndefined(); // fresh execution in the new scope
    expect(inB.mutated).toBe(true);
    // ...and the id is now bound to B: a repeat in B replays again.
    const againB = await groove(harness.ctx, { direction: "more", requestId: "r7" });
    expect(againB.replayed).toBe(true);
  });

  it("ID8 the ledger is bounded and evicts deterministically (oldest first)", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    // 257 distinct mutating requestIds: percent cycles 40..59 — each call
    // differs from the live value, so every one genuinely mutates.
    for (let i = 0; i < 257; i += 1) {
      const result = await groove(ctx, { direction: "set", percent: 40 + (i % 20), requestId: `evict-${i}` });
      expect(result.mutated, `evict-${i}`).toBe(true);
    }
    const beforeOldest = doc();
    const evicted = await groove(ctx, { direction: "set", percent: 41, requestId: "evict-0" });
    expect(evicted.replayed).toBeUndefined(); // evicted → executed again
    expect(doc()).not.toBe(beforeOldest);
    const survivor = await groove(ctx, { direction: "set", percent: 56, requestId: "evict-256" });
    expect(survivor.replayed).toBe(true); // newest → still cached
  });

  it("ID9 batch: a batch-level requestId caches the whole outcome; per-call ids work too", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const batchArgs = {
      requestId: "b1",
      calls: [
        { tool: "kyx_groove", args: { direction: "more" } },
        { tool: "kyx_markers", args: { op: "add", bar: 1, name: "idem" } },
      ],
    };
    const first = await executeMcpTool(ctx, "kyx_batch", batchArgs);
    expect(first.mutated).toBe(true);
    expect(first.replayed).toBeUndefined();
    const afterBatch = doc();
    const replay = await executeMcpTool(ctx, "kyx_batch", batchArgs);
    expect(replay.replayed).toBe(true);
    expect(replay.mutated).toBe(true);
    expect(replay.data).toEqual(first.data); // identical per-call outcomes
    expect(doc()).toBe(afterBatch); // no sub-call re-executed
    // per-call requestIds inside a batch flow through the same wrapper
    await executeMcpTool(ctx, "kyx_batch", {
      calls: [{ tool: "kyx_groove", args: { direction: "more", requestId: "s1" } }],
    });
    const standalone = await groove(ctx, { direction: "more", requestId: "s1" });
    expect(standalone.replayed).toBe(true);
  });

  it("ID10 every tool schema declares the requestId envelope (discoverable contract)", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    for (const def of MCP_TOOLS) {
      const prop = def.inputSchema.properties.requestId as { type?: string; maxLength?: number } | undefined;
      expect(prop, def.name).toBeDefined();
      expect(prop!.type, def.name).toBe("string");
      expect(prop!.maxLength, def.name).toBe(128);
    }
  });

  it("ID13 malformed requestIds are rejected instead of being ignored or truncated", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const start = doc();
    const invalidRequests = [
      { direction: "more", requestId: "x".repeat(129) },
      { direction: "more", requestId: "   " },
      { direction: "more", requestId: 12 },
    ];

    for (const args of invalidRequests) {
      const result = await groove(ctx, args);
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe("INVALID_REQUEST_ID");
    }
    expect(doc()).toBe(start);
  });

  it("ID11 one requestId cannot replay a different tool or argument payload", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const first = await groove(ctx, { direction: "more", requestId: "bound-once" });
    expect(first.mutated).toBe(true);
    const afterFirst = doc();

    const differentArguments = await groove(ctx, {
      direction: "less",
      requestId: "bound-once",
    });
    expect(differentArguments.isError).toBe(true);
    expect(differentArguments.errorCode).toBe("REQUEST_ID_CONFLICT");
    expect(differentArguments.text).toContain("choose a fresh requestId");
    expect(doc()).toBe(afterFirst);

    const differentTool = await executeMcpTool(ctx, "kyx_markers", {
      op: "add",
      bar: 1,
      name: "must-not-land",
      requestId: "bound-once",
    });
    expect(differentTool.errorCode).toBe("REQUEST_ID_CONFLICT");
    expect(doc()).toBe(afterFirst);
    expect(doc().markers.some((marker) => marker.name === "must-not-land")).toBe(false);
  });

  it("ID12 overlapping calls with the same requestId execute one mutation", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const args = { direction: "more", requestId: "concurrent-once" };
    const [first, second] = await Promise.all([groove(ctx, args), groove(ctx, args)]);
    expect(first.mutated).toBe(true);
    expect(second.mutated).toBe(true);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
    const after = await groove(ctx, { direction: "more", requestId: "concurrent-once" });
    expect(after.replayed).toBe(true);
    expect(doc().groove).toBeDefined();
  });
});
