import { describe, it, expect } from "vitest";
import { executeMcpTool, executeMcpToolAsync, type McpToolContext } from "../src/mcp/tools";

/**
 * kyx_publish_gallery — the AGENT-MADE publishing tool. Pins the honest
 * refusal without a host hook, input validation/defaults, the origin
 * passthrough contract, and the sync-path intercept.
 */

function baseCtx(hook?: NonNullable<McpToolContext["shareToGallery"]>): McpToolContext {
  return {
    getDoc: () => ({}) as never,
    execute: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {} as never,
    ...(hook ? { shareToGallery: hook } : {}),
  };
}

describe("kyx_publish_gallery", async () => {
  it("refuses honestly when no host hook is bound (standalone server)", async () => {
    const result = await executeMcpToolAsync(baseCtx(), "kyx_publish_gallery", { title: "x" });
    expect(result.text).toContain("not available over this MCP transport");
    expect(result.mutated).toBe(false);
  });

  it("publishes with agent provenance and reports the gallery id", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = baseCtx(async (input) => {
      seen.push(input);
      return { id: "gal-123" };
    });
    const result = await executeMcpToolAsync(ctx, "kyx_publish_gallery", {
      title: "night drive",
      agent: "Claude (MCP)",
      tags: ["synthwave", ""],
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("night drive");
    expect(result.text).toContain("Claude (MCP)");
    expect((result.data as { origin?: string }).origin).toBe("agent");
    // the host hook receives the validated input — empty tags dropped
    expect(seen[0]).toMatchObject({
      title: "night drive",
      author: "KYX agent",
      tags: ["synthwave"],
      agent: "Claude (MCP)",
    });
  });

  it("title is required and capped", async () => {
    const ctx = baseCtx(async () => ({ id: "x" }));
    const missing = await executeMcpToolAsync(ctx, "kyx_publish_gallery", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("title is required");
    const tooLong = await executeMcpToolAsync(ctx, "kyx_publish_gallery", { title: "x".repeat(80) });
    expect(tooLong.isError).toBe(true);
  });

  it("hook failures surface as tool errors, never as fake success", async () => {
    const ctx = baseCtx(async () => {
      throw new Error("gallery server unreachable");
    });
    const result = await executeMcpToolAsync(ctx, "kyx_publish_gallery", { title: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("gallery server unreachable");
  });

  it("single executor: the call runs the real publish path (no dual-path stub)", async () => {
    const result = await executeMcpTool(
      baseCtx(async () => ({ id: "x" })),
      "kyx_publish_gallery",
      { title: "x" },
    );
    expect(result.text).not.toContain("async executor");
  });
});
