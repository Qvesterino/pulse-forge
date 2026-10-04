import { useState, type CSSProperties } from "react";

/**
 * NUMERIC-DRAFT INPUT — a number field that stages typing in a local draft
 * and commits ONCE on blur or Enter, instead of one store command per
 * keystroke.
 *
 * Why this exists (audit #6, `docs/UI-FUNCTIONAL-AUDIT-2026-09-30.md`): the
 * Ozvena pad fields committed every keystroke, so typing "85" produced two
 * history entries and one Ctrl+Z snapped the field back to "8". The same
 * shape survives in the ModPanel automation point editors and the SliceLab
 * fields. This component is the one implementation of the contract:
 *
 * - a typed value is ONE command, not one per character;
 * - Escape abandons the draft without writing (the stored value re-renders);
 * - a cleared field is a CANCEL, not `Number("") === 0`;
 * - non-finite text is ignored rather than written as NaN.
 *
 * The parent owns clamping — `onCommit` receives the parsed number and the
 * caller's command/validation decides the legal range, exactly as it did for
 * the old `onChange` handler.
 */
export interface NumericDraftInputProps {
  value: number;
  onCommit: (value: number) => void;
  /** Value formatting for the idle display (e.g. `.toFixed(3)`). */
  format?: (value: number) => string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  title?: string;
}

export function NumericDraftInput({
  value,
  onCommit,
  format,
  min,
  max,
  step,
  disabled,
  className,
  style,
  "aria-label": ariaLabel,
  title,
}: NumericDraftInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commitText = (text: string) => {
    setDraft(null);
    if (text.trim() === "") return; // cleared field is a cancel, not 0
    // `type="number"` normalises the value property to a dot decimal (or "")
    // before it reaches us, so no locale comma handling is needed here.
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    onCommit(parsed);
  };

  return (
    <input
      type="number"
      className={className}
      style={style}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      title={title}
      aria-label={ariaLabel}
      value={draft ?? (format ? format(value) : String(value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) commitText(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          // Enter with no edits commits the displayed value (idempotent).
          commitText(draft ?? (format ? format(value) : String(value)));
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}
