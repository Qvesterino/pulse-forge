import { useEffect, useRef } from "react";
import { formatShortcut, groupShortcuts } from "./shortcuts";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal-style overlay listing all keyboard shortcuts.
 * Opens with `?`, closes with Escape or by clicking the scrim.
 */
export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const groups = groupShortcuts();

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="help-card">
        <header className="help-header">
          <h2 className="panel-title">KEYBOARD SHORTCUTS</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-small"
            onClick={onClose}
            aria-label="Close shortcuts"
            title="Close (Esc)"
          >
            CLOSE
          </button>
        </header>
        <div className="help-grid">
          {groups.map(({ group, items }) => (
            <section key={group} className="help-group" aria-labelledby={`help-group-${group}`}>
              <h3 id={`help-group-${group}`} className="help-group-title">
                {group.toUpperCase()}
              </h3>
              <ul className="help-list">
                {items.map((sc) => (
                  <li key={sc.key} className="help-row">
                    <span className="help-label">{sc.label}</span>
                    <kbd className="help-kbd" aria-label={formatShortcut(sc)}>
                      {formatShortcut(sc)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="help-footer">
          <span>
            Close with <kbd className="help-kbd">Esc</kbd> or click outside
          </span>
        </footer>
      </div>
    </div>
  );
}
