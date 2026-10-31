import { describe, expect, it, beforeEach } from "vitest";
import { executeMcpTool, resetMcpIdempotencyLedger, MCP_TOOLS, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * P2-C BATCH SAFEGUARDS + DRY-RUN (control-surface audit 2026-10-13, GAP-11;
 * roadmap P2-C, prereq P1-B satisfied).
 *
 * ATOMIC-OR-EXPLICIT: kyx_batch defaults to partial-commit (documented);
 * `atomic: true` stops at the FIRST failure — executed calls stay committed
 * (a batch cannot un-execute its own prefix) and the result reports
 * PARTIAL_FAILURE with the skipped count.
 *
 * DRY-RUN: `dryRun: true` runs the tool's full logic against a sandbox
 * document — validation and resolution are real, the live store never
 * mutates, and the result names the exact commands that WOULD apply.
 * Runtime/export-side tools refuse (a dry-run cannot un-play a note).
 */

function makeCtx(doc: ProjectDocument): { ctx: McpToolContext; doc: () => ProjectDocument } {
  let current = doc;
  return {
    ctx: withAgentWriter({
      getDoc: () => current,
      execute: (command) => {
        current = command.execute(current);
      },
      undo: () => {},
      redo: () => {},
      undoStackLength: () => 0,
      historyLabels: () => [],
      isMicRecordingActive: () => false,
      transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    }),
    doc: () => current,
  };
}

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("P2-C atomic kyx_batch", () => {
  it("atomic mode stops at the first failure and reports the skipped count", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_batch", {
      atomic: true,
      calls: [
        { tool: "kyx_markers", args: { op: "add", bar: 1, name: "first" } },
        { tool: "kyx_checkpoint", args: { op: "restore", name: "does-not-exist" } },
        { tool: "kyx_markers", args: { op: "add", bar: 2, name: "never-runs" } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PARTIAL_FAILURE");
    expect(result.data).toMatchObject({
      mutations: 1,
      failures: 1,
      skipped: 1,
      atomic: true,
      status: "partial",
      recovery: "undo-once",
      singleUndo: true,
    });
    const batchData = result.data as { results: Array<{ tool: string; data?: unknown }> };
    expect(batchData.results[0]?.tool).toBe("kyx_markers");
    expect(batchData.results[0]?.data).toMatchObject({ status: "created" });
    // executed prefix landed; the call after the failure never ran
    expect(doc().markers.some((m) => m.name === "first")).toBe(true);
    expect(doc().markers.some((m) => m.name === "never-runs")).toBe(false);
    expect(result.text).toContain("atomic mode — stopped at the first failure");
    expect(result.text).toContain("1 skipped");
  });

  it("default stays partial-commit: failures are recorded, the loop continues", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_batch", {
      calls: [
        { tool: "kyx_markers", args: { op: "add", bar: 1, name: "first" } },
        { tool: "kyx_checkpoint", args: { op: "restore", name: "does-not-exist" } },
        { tool: "kyx_markers", args: { op: "add", bar: 2, name: "second" } },
      ],
    });
    expect(result.isError).toBeUndefined(); // partial-commit is not an error (documented design)
    expect(result.data).toMatchObject({ mutations: 2, failures: 1, skipped: 0 });
    expect(result.data).toMatchObject({ status: "partial", recovery: "undo-once", singleUndo: true });
    expect(doc().markers.some((m) => m.name === "second")).toBe(true);
  });

  it("a clean atomic batch succeeds without the failure marker", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_batch", {
      atomic: true,
      calls: [{ tool: "kyx_markers", args: { op: "add", bar: 1, name: "ok" } }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.mutated).toBe(true);
  });
});

describe("P2-C dry-run envelope", () => {
  it("a mutating call with dryRun previews its commands and touches nothing", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const before = doc();
    const result = await executeMcpTool(ctx, "kyx_markers", {
      op: "add",
      bar: 1,
      name: "preview-only",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("dry-run — nothing was applied");
    expect(result.text).toContain("would apply 1 command(s)");
    expect(doc()).toBe(before); // the live document object is untouched
    expect(doc().markers.some((m) => m.name === "preview-only")).toBe(false);
  });

  it("invalid arguments fail the dry-run exactly like a real run", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_batch", { dryRun: true, calls: {} });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("INVALID_ARGUMENTS");
  });

  it("dry-running an undo previews what would revert", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "committed" });
    const markersBefore = doc().markers.length;
    const result = await executeMcpTool(ctx, "kyx_undo", { action: "undo", dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.mutated).toBe(false);
    expect(doc().markers.length).toBe(markersBefore); // nothing actually reverted
  });

  it("runtime/export-side tools refuse the dry-run", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_transport", { action: "play", dryRun: true });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("POLICY_REFUSED");
    expect(result.text).toContain("drives runtime or export state");
  });

  it("dry-run refuses external side effects that bypass the document sandbox", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    const cases: Array<{ tool: string; args: Record<string, unknown>; message: string }> = [
      {
        tool: "kyx_import_sfz",
        args: { dryRun: true },
        message: "writes samples to the user library",
      },
      {
        tool: "kyx_checkpoint",
        args: { op: "save", name: "preview", dryRun: true },
        message: "writes the checkpoint repository",
      },
      {
        tool: "kyx_checkpoint",
        args: { op: "delete", name: "old", dryRun: true },
        message: "writes the checkpoint repository",
      },
      {
        tool: "kyx_mix_idea",
        args: { idea: "warm up the drums", preview: true, dryRun: true },
        message: "arms live preview state",
      },
    ];

    for (const entry of cases) {
      const result = await executeMcpTool(ctx, entry.tool, entry.args);
      expect(result.isError, entry.tool).toBe(true);
      expect(result.errorCode, entry.tool).toBe("POLICY_REFUSED");
      expect(result.text, entry.tool).toContain(entry.message);
      expect(result.dryRun, entry.tool).toBeUndefined();
    }
  });

  it("dry-run refuses non-sandboxable operations nested in a batch", async () => {
    const { ctx } = makeCtx(createProjectFromTemplate("house"));
    const result = await executeMcpTool(ctx, "kyx_batch", {
      dryRun: true,
      calls: [{ tool: "kyx_checkpoint", args: { op: "save", name: "must-not-save" } }],
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("POLICY_REFUSED");
    expect(result.text).toContain("kyx_batch call 1");
    expect(result.text).toContain("writes the checkpoint repository");
  });

  it("dry-run results are not idempotency-cached", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "d", requestId: "dry-1", dryRun: true });
    const real = await executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "d", requestId: "dry-1" });
    // the dry-run cached nothing — the same id executes for real afterwards
    expect(real.replayed).toBeUndefined();
    expect(real.mutated).toBe(true);
    expect(doc().markers.some((m) => m.name === "d")).toBe(true);
  });

  it("dry-run never replays a prior live mutation with the same requestId", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const live = await executeMcpTool(ctx, "kyx_markers", {
      op: "add",
      bar: 1,
      name: "committed-first",
      requestId: "same-live-and-dry",
    });
    expect(live.mutated).toBe(true);
    const afterLive = doc();

    const preview = await executeMcpTool(ctx, "kyx_markers", {
      op: "add",
      bar: 2,
      name: "preview-only",
      requestId: "same-live-and-dry",
      dryRun: true,
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.replayed).toBeUndefined();
    expect(preview.mutated).toBe(false);
    expect(doc()).toBe(afterLive);
    expect(doc().markers.some((marker) => marker.name === "preview-only")).toBe(false);
  });

  it("retries a partially applied atomic batch without re-running its committed prefix", async () => {
    const { ctx, doc } = makeCtx(createProjectFromTemplate("house"));
    const request = {
      requestId: "partial-batch-once",
      atomic: true,
      calls: [
        { tool: "kyx_markers", args: { op: "add", bar: 1, name: "prefix-once" } },
        { tool: "kyx_checkpoint", args: { op: "restore", name: "not-found" } },
      ],
    };
    const first = await executeMcpTool(ctx, "kyx_batch", request);
    expect(first.isError).toBe(true);
    expect(first.mutated).toBe(true);
    const afterFirst = doc();

    const retry = await executeMcpTool(ctx, "kyx_batch", request);
    expect(retry.replayed).toBe(true);
    expect(retry.errorCode).toBe("PARTIAL_FAILURE");
    expect(doc()).toBe(afterFirst);
    expect(doc().markers.filter((marker) => marker.name === "prefix-once")).toHaveLength(1);
  });

  it("every tool schema declares the dryRun envelope (discoverability)", () => {
    for (const def of MCP_TOOLS) {
      const prop = def.inputSchema.properties.dryRun as { type?: string } | undefined;
      expect(prop, def.name).toBeDefined();
      expect(prop?.type, def.name).toBe("boolean");
    }
  });
});
