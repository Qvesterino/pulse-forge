import { describe, expect, it, vi, afterEach } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { cancelMcpCall, executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { mcpRenderSummary } from "../src/mcp/render-summary";
import { createDefaultProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * AS-009 phase 2 — COOPERATIVE CANCELLATION. Every MCP call owns an
 * AbortController; render-class handlers observe ctx.signal at render-stage
 * boundaries. The dispatcher auto-aborts at the call deadline (past the
 * transports' own budgets) and cancelMcpCall(requestId) aborts early. A
 * cancelled call returns the typed CANCELLED code and says honestly whether
 * the document changed before the abort landed.
 */

function hostWithRenderHook(hook: NonNullable<McpToolContext["renderSummary"]>) {
  const base = createHeadlessMcpHost({ document: createDefaultProject() });
  const ctx: McpToolContext = { ...base.ctx, renderSummary: hook };
  return { base, ctx };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP cooperative cancellation (AS-009 phase 2)", () => {
  it("cancelMcpCall aborts an in-flight render-class call, which returns CANCELLED", async () => {
    let observed: AbortSignal | undefined;
    const { ctx } = hostWithRenderHook(async (_request, signal) => {
      observed = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("aborted by the caller", "AbortError");
    });
    const pending = executeMcpTool(ctx, "kyx_render_summary", { scope: "master", requestId: "cancel-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelMcpCall("cancel-1")).toBe(true);
    const result = await pending;
    expect(observed?.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("CANCELLED");
    expect(result.mutated).toBe(false);
    expect(result.text).toContain("nothing changed");
  });

  it("cancelMcpCall for an unknown or already-finished id is an honest false", () => {
    expect(cancelMcpCall("no-such-request")).toBe(false);
  });

  it("the deadline auto-abort fires for a hung render (75 s long-running budget)", async () => {
    vi.useFakeTimers();
    const { ctx } = hostWithRenderHook(async (_request, signal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("deadline", "AbortError");
    });
    const pending = executeMcpTool(ctx, "kyx_render_summary", { scope: "master" });
    const assertion = expect(pending).resolves.toMatchObject({ isError: true, errorCode: "CANCELLED" });
    await vi.advanceTimersByTimeAsync(75_000);
    await assertion;
  });

  it("a cancelled call that had already mutated the document says so", async () => {
    const { base, ctx } = hostWithRenderHook(async (_request, signal) => {
      // The abort raced a REAL mutation: one undo step landed first.
      base.ctx.execute({
        type: "testMutation",
        label: "cancelled-call mutation",
        execute: (doc) => ({ ...doc, bpm: 123 }),
        undo: (doc) => ({ ...doc, bpm: 120 }),
      });
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("aborted", "AbortError");
    });
    const pending = executeMcpTool(ctx, "kyx_render_summary", { scope: "master", requestId: "cancel-2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancelMcpCall("cancel-2");
    const result = await pending;
    expect(result.errorCode).toBe("CANCELLED");
    expect(result.mutated).toBe(true);
    expect(result.text).toContain("the document DID change first");
  });

  it("capabilities advertise COOPERATIVE cancellation with its honest scope", async () => {
    const base = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await base.call("kyx_state", { subject: "capabilities" });
    const capabilities = (
      result.data as { capabilities: { cancellation: { supported: boolean; scope: string; reason: string } } }
    ).capabilities;
    expect(capabilities.cancellation.supported).toBe(true);
    expect(capabilities.cancellation.scope).toContain("cooperative");
    expect(capabilities.cancellation.reason).toContain("notifications/cancelled");
    expect(result.text).toContain("cancellation: cooperative");
  });

  it("an already-aborted render-summary call never starts its first render", async () => {
    const doc: ProjectDocument = createDefaultProject();
    const controller = new AbortController();
    controller.abort(new DOMException("pre-aborted", "AbortError"));
    const services = { store: { getDoc: () => doc, getRevision: () => 1 } } as never;
    await expect(mcpRenderSummary(services, { scope: "master" }, controller.signal)).rejects.toThrow(
      /cancelled|abort/i,
    );
  });
});
