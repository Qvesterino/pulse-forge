import type { ReactElement } from "react";

/**
 * F4 collaborator — the 🎧 audio-reference chip: what the reference is, that
 * it shapes every generation, match-EQ against it, and clearing it.
 *
 * Extracted verbatim from IntentPanel. Pure renderer: the analysis, the
 * conditioning wiring and the AST patch live in the shell — this module only
 * reports the current state and forwards the two verbs.
 */
export interface AudioRefChipProps {
  /** A reference is loaded and conditioning the generator. */
  active: boolean;
  refSummary: string | null;
  onMatchEq: () => void;
  onClearReference: () => void;
}

export function AudioRefChip(props: AudioRefChipProps): ReactElement | null {
  const { active, refSummary, onMatchEq, onClearReference } = props;
  if (!active) return null;
  return (
    <div className="intent-ref-chip" role="status">
      <span className="intent-ref-chip-label">🎧 ref: {refSummary ?? "active"}</span>
      <span className="intent-ref-chip-hint">shapes every generation</span>
      <button
        type="button"
        className="intent-ref-chip-clear"
        aria-label="Match master EQ to reference"
        title="Match EQ — measure the mix against the reference and correct the master (znej ako ref)"
        onClick={onMatchEq}
      >
        🎯
      </button>
      <button
        type="button"
        className="intent-ref-chip-clear"
        aria-label="Clear audio reference"
        title="Clear the reference — back to text-only intent"
        onClick={onClearReference}
      >
        ×
      </button>
    </div>
  );
}
