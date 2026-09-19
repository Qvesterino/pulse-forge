import { useEffect, useMemo, useRef, useState } from "react";
import { EDITOR_SHORTCUTS, groupShortcuts, shortcutDisplayBindings } from "./shortcuts";
import { gestureMatches, gesturesByArea } from "./helpContent";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Help overlay — every keyboard shortcut (primary + alternative bindings)
 * and every mouse/touch gesture, with a text filter. Opens with `?`,
 * closes with Escape or by clicking the scrim.
 */
export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
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

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = groupShortcuts();
    if (!q) return all;
    return all
      .map(({ group, items }) => ({
        group,
        items: items.filter(
          (sc) =>
            sc.label.toLowerCase().includes(q) ||
            group.toLowerCase().includes(q) ||
            shortcutDisplayBindings(sc).some((binding) => binding.toLowerCase().includes(q)),
        ),
      }))
      .filter(({ items }) => items.length > 0);
  }, [query]);

  const gestureAreas = useMemo(
    () => gesturesByArea().map(({ area, items }) => ({ area, items: items.filter((g) => gestureMatches(g, query)) })),
    [query],
  );
  const editorAreas = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = EDITOR_SHORTCUTS.filter(
      (sc) =>
        !q ||
        sc.label.toLowerCase().includes(q) ||
        sc.area.toLowerCase().includes(q) ||
        sc.bindings.some((binding) => binding.toLowerCase().includes(q)),
    );
    const order = [...new Set(EDITOR_SHORTCUTS.map((sc) => sc.area))];
    return order
      .map((area) => ({ area, items: matches.filter((sc) => sc.area === area) }))
      .filter(({ items }) => items.length > 0);
  }, [query]);
  const gesturesVisible = gestureAreas.some(({ items }) => items.length > 0);
  const editorsVisible = editorAreas.length > 0;
  const nothingFound = groups.length === 0 && !gesturesVisible && !editorsVisible;

  if (!open) return null;

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Help: shortcuts and gestures"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="help-card">
        <header className="help-header">
          <h2 className="panel-title">HELP — SHORTCUTS &amp; GESTURES</h2>
          <input
            ref={searchRef}
            type="search"
            className="help-search"
            placeholder="Filter — e.g. velocity, undo, Ctrl…"
            aria-label="Filter shortcuts and gestures"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close help" title="Close (Esc)">
            CLOSE
          </button>
        </header>

        {nothingFound && (
          <div className="undo-history-empty" role="status">
            Nothing matches "{query.trim()}" — try "velocity", "undo" or "dice".
          </div>
        )}

        {groups.length > 0 && (
          <div className="help-grid">
            {groups.map(({ group, items }) => (
              <section key={group} className="help-group" aria-labelledby={`help-group-${group}`}>
                <h3 id={`help-group-${group}`} className="help-group-title">
                  {group.toUpperCase()}
                </h3>
                <ul className="help-list">
                  {items.map((sc) => {
                    const bindings = shortcutDisplayBindings(sc);
                    return (
                      <li key={sc.key} className="help-row">
                        <span className="help-label">{sc.label}</span>
                        <span className="help-bindings">
                          {bindings.map((binding, idx) => (
                            <span key={binding} className="help-binding">
                              {idx > 0 && <span className="help-or">or</span>}
                              <kbd className={idx === 0 ? "help-kbd" : "help-kbd help-kbd-alt"} aria-label={binding}>
                                {binding}
                              </kbd>
                            </span>
                          ))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {gesturesVisible && (
          <div className="help-gestures" aria-label="Mouse and touch gestures">
            <h3 className="help-group-title">MOUSE &amp; TOUCH — BY AREA</h3>
            {gestureAreas
              .filter(({ items }) => items.length > 0)
              .map(({ area, items }) => (
                <section key={area} className="help-group" aria-labelledby={`help-gestures-${area}`}>
                  <h4 className="help-group-title">{area.toUpperCase()}</h4>
                  <ul className="help-list">
                    {items.map((gesture) => (
                      <li key={`${gesture.area}-${gesture.action}`} className="help-row">
                        <span className="help-label">
                          {gesture.action}
                          <span className="help-gesture-detail"> — {gesture.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}

        {editorsVisible && (
          <div className="help-gestures" aria-label="Editor shortcuts">
            <h3 className="help-group-title">EDITOR SHORTCUTS — DEPENDS ON FOCUS</h3>
            {editorAreas.map(({ area, items }) => (
              <section key={area} className="help-group" aria-labelledby={`help-editor-${area}`}>
                <h4 id={`help-editor-${area}`} className="help-group-title">
                  {area.toUpperCase()}
                </h4>
                <ul className="help-list">
                  {items.map((sc) => (
                    <li key={`${sc.area}-${sc.label}`} className="help-row">
                      <span className="help-label">{sc.label}</span>
                      <span className="help-bindings">
                        {sc.bindings.map((binding) => (
                          <kbd key={binding} className="help-kbd" aria-label={binding}>
                            {binding}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <footer className="help-footer">
          <span>
            Close with <kbd className="help-kbd">Esc</kbd> or click outside
          </span>
        </footer>
      </div>
    </div>
  );
}
