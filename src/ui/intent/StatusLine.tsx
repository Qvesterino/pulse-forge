import type { ReactElement } from "react";

/**
 * F4 collaborator — the conversation / router status lines (🤖 model and route
 * decisions, ⚡ DO IT confirmations, plus the personal-training line).
 *
 * Extracted verbatim from IntentPanel. Pure renderer: every message is produced
 * by the shell and only rendered here.
 */
export interface StatusLineProps {
  /** null or empty hides the line entirely. */
  message: string | null;
  /** Personal-training line, styled apart from the router status. */
  personal?: boolean;
  /** A long-running action is active; the renderer adds a non-determinate cue. */
  busy?: boolean;
}

export function StatusLine({ message, personal = false, busy = false }: StatusLineProps): ReactElement | null {
  if (!message) return null;
  return (
    <div
      className={personal ? "intent-status intent-personal-status" : "intent-status"}
      data-state={busy ? "busy" : undefined}
      role="status"
    >
      {message}
      {busy && (
        <span className="intent-status-progress" aria-hidden="true">
          <span />
        </span>
      )}
    </div>
  );
}
