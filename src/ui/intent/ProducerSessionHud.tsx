import type { ReactElement } from "react";
import type { VariantSpec } from "../../intent/producer-session";

/**
 * F4 collaborator — the 🎛 producer session HUD: the session chip, the quick
 * B/C variant directions generated off the current intent, and the reset.
 *
 * Extracted verbatim from IntentPanel. Pure renderer: the variant plan is
 * computed by the shell and handed over, so this module never reads intent,
 * never regenerates, and mutates nothing.
 */
export interface ProducerSessionHudProps {
  /** null hides the HUD entirely. */
  summary: string | null;
  /** Bumped by the shell when session memory changes. */
  sessionTick: number;
  /** `planVariantIntents(...)` for the latest intent — empty when no bank exists. */
  variants: readonly VariantSpec[];
  /** One-shot patch + regenerate, driven by the shell. */
  onPickVariant: (patch: VariantSpec["patch"]) => void;
  onReset: () => void;
}

export function ProducerSessionHud(props: ProducerSessionHudProps): ReactElement | null {
  const { summary, sessionTick, variants, onPickVariant, onReset } = props;
  if (summary === null || sessionTick < 0) return null;
  return (
    <div className="producer-session-hud" aria-label="Producer session">
      <span className="producer-session-chip">🎛 {summary}</span>
      {variants.map((variant) => (
        <button
          key={variant.label}
          type="button"
          className="btn btn-small producer-variant-chip"
          title={`Generate a ${variant.label} direction off this intent`}
          onClick={() => onPickVariant(variant.patch)}
        >
          {variant.chip}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-small producer-session-reset"
        title="Clear the producer session memory"
        onClick={onReset}
      >
        ✕
      </button>
    </div>
  );
}
