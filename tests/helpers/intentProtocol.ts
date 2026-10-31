import type { McpToolResult } from "../../src/mcp/tools";

/**
 * The intent protocol an MCP caller must speak for a document edit.
 *
 * A trusted external-agent host cannot mutate the project straight from an
 * instruction: `kyx_intent` answers a direct call with
 * `CONFIRMATION_REQUIRED` and asks for a preview first. The two-step flow is
 * the contract, not a convenience:
 *
 *   1. `kyx_intent { instruction, dry_run: true }` → a REVIEWABLE plan and the
 *      `planId` that names it. Nothing is written.
 *   2. `kyx_intent { instruction, planId }` → applies that exact plan, against
 *      the same project state, by the same caller.
 *
 * The proposal is bound to the caller, the instruction, the project and its
 * revision, so a plan that went stale is refused (`WRITE_CONFLICT`) instead of
 * applying to a document it was never computed for.
 *
 * A spec that wants to assert on the EDIT speaks it through `applyIntent`;
 * a spec that wants to assert on the REVIEW speaks it through
 * `previewIntent`. When the plan would change nothing there is no `planId` to
 * apply — that is a no-op, and `applyIntent` says so instead of pretending.
 */
export interface IntentCaller {
  call(name: string, args?: unknown): Promise<McpToolResult>;
}

/** Review a plan without touching the project. */
export async function previewIntent(host: IntentCaller, instruction: string): Promise<McpToolResult> {
  return host.call("kyx_intent", { instruction, dry_run: true });
}

/**
 * Review the plan and apply exactly that plan. Throws when the preview carries
 * no `planId` — the instruction would change nothing, so there is nothing to
 * apply and the caller must say so itself.
 */
export async function applyIntent(host: IntentCaller, instruction: string): Promise<McpToolResult> {
  const preview = await previewIntent(host, instruction);
  const planId = (preview.data as { planId?: string } | undefined)?.planId;
  if (typeof planId !== "string" || planId === "") {
    throw new Error(`the intent preview returned no planId — nothing to apply: ${preview.text}`);
  }
  return host.call("kyx_intent", { instruction, planId });
}
