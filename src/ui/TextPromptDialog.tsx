import { useEffect, useRef, useState } from "react";
import { useFocusRestore } from "./useFocusRestore";

/**
 * TEXT-PROMPT DIALOG — the in-app replacement for `window.prompt` on the
 * kit / PACK / BINDS / theme import paths and the mixer's "type a value".
 *
 * Why not `window.prompt`: it blocks the main thread (audio callbacks keep
 * running, but every UI frame stalls until the user answers), it renders as
 * browser chrome so a long PFPACK code scrolls in a one-line box, it cannot
 * be styled or shown read-only, and browsers can suppress it entirely. This
 * is the same decision the stretch dialog recorded when it replaced
 * `window.prompt("Stretch rate…")` — one dialog shape, Escape/backdrop
 * cancel, Enter to confirm.
 *
 * Contract:
 * - `onSubmit` receives the raw trimmed text; validation belongs to the
 *   CALLER (each code decoder already answers "is this valid?"), so the
 *   dialog stays dumb and the error text stays next to the decoder.
 * - Empty submit is refused here: an empty code can only ever be invalid,
 *   and closing the dialog on an accidental Enter would read as success.
 * - `multiline` renders a textarea (share codes are hundreds of characters);
 *   single-line fields submit on Enter, textareas on Ctrl/Cmd+Enter, so
 *   Enter never fights with a paste that contains newlines.
 * - The component renders unconditionally and takes `open` as a prop, which
 *   is what `useFocusRestore` requires to hand focus back on close.
 */
export interface TextPromptDialogProps {
  open: boolean;
  title: string;
  /** Short instruction above the field. */
  label: string;
  initialValue?: string;
  placeholder?: string;
  /** Share codes are long — a textarea makes them inspectable and pasteable. */
  multiline?: boolean;
  /** Input type for single-line fields (mixer "type a value" is numeric). */
  inputType?: "text" | "number";
  /** Rendered under the field; caller-owned (e.g. "Invalid PACK code"). */
  error?: string | null;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function TextPromptDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  multiline = false,
  inputType = "text",
  error = null,
  confirmLabel = "OK",
  onSubmit,
  onClose,
}: TextPromptDialogProps) {
  const focusRef = useFocusRestore<HTMLDivElement>(open);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);

  // Re-seed the draft each time the dialog OPENS. A dialog that kept the
  // previous attempt would resurface a stale code on the next install.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  // `submit` closes over the current `value`; keeping it as a callback means
  // the key listener re-binds per keystroke (cheap) instead of reading a
  // stale value from a render-time ref.
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === "") return; // an empty code is never a successful install
    onSubmit(trimmed);
  };
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Enter" && !multiline && e.target === inputRef.current) {
        e.preventDefault();
        submitRef.current();
      }
      if (e.key === "Enter" && multiline && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, multiline, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="generate-dialog-backdrop" role="dialog" aria-label={title} ref={focusRef}>
      <div className="generate-dialog" ref={dialogRef}>
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">{title}</span>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label={`Close ${title}`}>
            ✕
          </button>
        </div>
        <div className="generate-dialog-body">
          <div className="generate-field">
            <label className="generate-label" htmlFor="text-prompt-input">
              {label}
            </label>
            {multiline ? (
              <textarea
                id="text-prompt-input"
                className="text-prompt-textarea"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                value={value}
                placeholder={placeholder}
                rows={4}
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
                aria-label={label}
              />
            ) : (
              <input
                id="text-prompt-input"
                className="generate-seed-input"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                ref={inputRef as React.RefObject<HTMLInputElement>}
                type={inputType}
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
                aria-label={label}
              />
            )}
          </div>
          {error && (
            <div className="text-prompt-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="generate-dialog-footer">
          <button type="button" className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-small intent-use-btn" onClick={() => submitRef.current()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
