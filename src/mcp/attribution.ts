import type { Command } from "../commands/types";
import type { McpToolContext } from "./tools";

/**
 * MULTI-AGENT SESSION ATTRIBUTION (architecture hardening C6 v1).
 *
 * QMR, Claude (desktop stdio), ZCode (web relay) and the human all drive
 * the SAME document and share ONE LIFO undo history. v1 makes that shared
 * reality OBSERVABLE instead of pretending per-agent isolation:
 *
 *   - every mutation executed through an attributed context carries an
 *     `[agent-id]` prefix on its history label, so the interleaving is
 *     visible in kyx_state subject:history and the undo panel,
 *   - kyx_undo's read-back names exactly what it reverted and warns when
 *     an agent reverts work that was not its own (another agent's, or the
 *     human's unlabeled edits).
 *
 * Deliberately NOT in v1 (needs store-level actor tracking on history
 * entries — C6.2): per-agent undo filtering and per-agent redo stacks.
 * Global LIFO stays the truth; attribution makes it legible.
 */

/** Known automation surfaces. `local` = unattributed (headless tests and
 * the human working the UI directly — UI edits carry no prefix). */
export type McpAgentId = "desktop-stdio" | "web-relay" | "qmr" | "local";

export const AGENT_LABEL_PREFIX = /^\[([a-z-]+)\] /;

/** Prefix a command's history label with the agent id (no-op for `local`,
 * so headless/test and human labels stay exactly as before). */
export function attributeLabel(command: Command, agentId: McpAgentId): Command {
  if (agentId === "local") return command;
  return {
    ...command,
    label: `[${agentId}] ${command.label}`,
  };
}

/** Wrap a context so every mutation it executes is attributed. Reads,
 * undo/redo and undoStackLength pass through untouched. */
export function withAgentAttribution(ctx: McpToolContext, agentId: McpAgentId): McpToolContext {
  if (agentId === "local") return ctx;
  return {
    ...ctx,
    agentId,
    execute: (command) => ctx.execute(attributeLabel(command, agentId)),
  };
}

/** The labels a pending undo/redo WOULD revert (most recent first, in
 * execution order). Powers the honest kyx_undo read-back. */
export function labelsRevertedBy(ctx: McpToolContext, action: "undo" | "redo", steps: number): string[] {
  const labels = ctx.historyLabels();
  if (action === "undo") {
    const start = Math.max(0, labels.length - steps);
    return labels.slice(start).reverse();
  }
  // redo history lives beyond the undo stack — the context cannot see it;
  // callers report redo without names rather than guessing.
  return [];
}

/** True when the reverted label was NOT produced by this agent — another
 * attributed agent (different prefix) or the human (no prefix). */
export function isForeignWork(label: string, agentId: McpAgentId | string | null | undefined): boolean {
  const match = AGENT_LABEL_PREFIX.exec(label);
  if (match == null) return true; // unlabeled = human/manual work
  return match[1] !== agentId;
}
