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
}

export function StatusLine({ message, personal = false }: StatusLineProps): ReactElement | null {
  if (!message) return null;
  return (
    <div className={personal ? "intent-status intent-personal-status" : "intent-status"} role="status">
      {message}
    </div>
  );
}
