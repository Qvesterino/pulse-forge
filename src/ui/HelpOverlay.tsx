import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  EDITOR_SHORTCUTS,
  formatBinding,
  getActiveShortcuts,
  groupShortcuts,
  isShortcutCustomized,
  resetShortcutBindings,
  setShortcutBinding,
  shortcutBindingFromEvent,
  shortcutBindingsRevision,
  shortcutDisplayBindings,
  subscribeShortcutBindings,
  type ShortcutKey,
} from "./shortcuts";
import { useFocusRestore } from "./useFocusRestore";
import { gestureMatches, gesturesByArea } from "./helpContent";
import { ModelPacksSection } from "./ModelPackCard";
import type { ProjectTransferSourceDaw } from "../project-model/types";
import { DAW_ACTION_MAPPINGS, DAW_PROFILE_OPTIONS, readDawProfile, writeDawProfile } from "./dawProfile";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
  profileSourceDaw?: ProjectTransferSourceDaw;
}

/**
 * Help overlay — every keyboard shortcut (primary + alternative bindings)
 * and every mouse/touch gesture, with a text filter. Opens with `?`,
 * closes with Escape or by clicking the scrim.
 */
export function HelpOverlay({ open, onClose, profileSourceDaw }: HelpOverlayProps) {
  const overlayRef = useFocusRestore<HTMLDivElement>(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [dawProfile, setDawProfile] = useState<ProjectTransferSourceDaw | null>(readDawProfile);
  const [capturingKey, setCapturingKey] = useState<ShortcutKey | null>(null);
  const [bindingMessage, setBindingMessage] = useState("");
  const shortcutRevision = useSyncExternalStore(
    subscribeShortcutBindings,
    shortcutBindingsRevision,
    shortcutBindingsRevision,
  );
  const allShortcuts = useMemo(() => groupShortcuts().flatMap(({ items }) => items), [shortcutRevision]);

  useEffect(() => {
    if (open) setDawProfile(readDawProfile() ?? profileSourceDaw ?? null);
  }, [open, profileSourceDaw]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCapturingKey(null);
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || capturingKey === null) return;
    const capture = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        setCapturingKey(null);
        setBindingMessage("Shortcut change cancelled.");
        return;
      }
      const binding = shortcutBindingFromEvent(event);
      if (!binding) {
        setBindingMessage("Press Ctrl/Cmd + Shift + one letter or number. Esc cancels.");
        return;
      }
      const result = setShortcutBinding(capturingKey, binding);
      if (!result.ok) {
        setBindingMessage(result.message);
        return;
      }
      const action = getActiveShortcuts().find(({ key }) => key === capturingKey);
      setCapturingKey(null);
      setBindingMessage(
        result.persisted
          ? `Saved ${formatBinding({ ...binding, key: binding.keyHint })} for ${action?.label ?? "action"}.`
          : "Changed for this session; browser storage is unavailable.",
      );
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [capturingKey, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturingKey(null);
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
  }, [query, shortcutRevision]);

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

      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Help: shortcuts and gestures"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setCapturingKey(null);
          onClose();
        }
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
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setCapturingKey(null);
              onClose();
            }}
            aria-label="Close help"
            title="Close (Esc)"
          >
            CLOSE
          </button>
        </header>

        <section className="help-shortcut-settings" aria-label="Custom keyboard shortcuts">
          <div>
            <strong>GLOBAL SHORTCUTS</strong>
            <p>
              Change a binding with Ctrl/Cmd + Shift + a letter or number. Plain keys stay available for playing notes.
            </p>
          </div>
          {allShortcuts.some(({ key }) => isShortcutCustomized(key)) && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                const persisted = resetShortcutBindings();
                setCapturingKey(null);
                setBindingMessage(
                  persisted ? "All global shortcuts restored to defaults." : "Defaults restored for this session.",
                );
              }}
            >
              RESET ALL
            </button>
          )}
        </section>
        {bindingMessage && (
          <p className="help-shortcut-message" role="status" aria-live="polite">
            {bindingMessage}
          </p>
        )}

        <section className="help-daw-profile" aria-label="DAW terminology guide">
          <label>
            <span>Show familiar terms for</span>
            <select
              aria-label="Show familiar terms for"
              value={dawProfile ?? ""}
              onChange={(event) => {
                const next = DAW_PROFILE_OPTIONS.some(({ id }) => id === event.currentTarget.value)
                  ? (event.currentTarget.value as ProjectTransferSourceDaw)
                  : null;
                setDawProfile(next);
                writeDawProfile(next);
              }}
            >
              <option value="">Choose later</option>
              {DAW_PROFILE_OPTIONS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {dawProfile ? (
            <>
              <p>These are familiar names for KYX actions, not separate DAW modes.</p>
              <ul className="help-list help-daw-mappings">
                {DAW_ACTION_MAPPINGS.map((mapping) => {
                  const shortcuts = (mapping.shortcutKeys ?? [])
                    .map((shortcutKey) => allShortcuts.find(({ key }) => key === shortcutKey))
                    .filter((shortcut): shortcut is NonNullable<typeof shortcut> => shortcut !== undefined);
                  return (
                    <li key={mapping.id} className="help-row">
                      <span className="help-label">
                        <strong>{mapping.action}</strong>
                        <span className="help-gesture-detail">
                          {mapping.familiarTerm[dawProfile]} → {mapping.kyxTerm}
                        </span>
                        {mapping.kyxDetail && <span className="help-gesture-detail">{mapping.kyxDetail}</span>}
                      </span>
                      {shortcuts.length > 0 && (
                        <span className="help-bindings" aria-label={`${mapping.kyxTerm} shortcut`}>
                          {shortcuts.flatMap(shortcutDisplayBindings).map((binding) => (
                            <kbd key={binding} className="help-kbd" aria-label={binding}>
                              {binding}
                            </kbd>
                          ))}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p>Optional: choose a previous DAW to see equivalent terms beside KYX actions.</p>
          )}
        </section>

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
                        <span className="help-shortcut-actions">
                          <button
                            type="button"
                            className="help-shortcut-action"
                            aria-label={`Change shortcut for ${sc.label}`}
                            onClick={() => {
                              setCapturingKey(sc.key);
                              setBindingMessage(`Press a new shortcut for ${sc.label}. Esc cancels.`);
                            }}
                          >
                            {capturingKey === sc.key ? "PRESS KEYS…" : "CHANGE"}
                          </button>
                          {isShortcutCustomized(sc.key) && (
                            <button
                              type="button"
                              className="help-shortcut-action"
                              aria-label={`Restore default shortcut for ${sc.label}`}
                              onClick={() => {
                                const result = setShortcutBinding(sc.key, null);
                                setCapturingKey(null);
                                setBindingMessage(
                                  result.ok
                                    ? result.persisted
                                      ? `Restored ${sc.label} to its default shortcut.`
                                      : `Restored ${sc.label} for this session.`
                                    : result.message,
                                );
                              }}
                            >
                              RESET
                            </button>
                          )}
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
            <h3 className="help-group-title">EDITOR SHORTCUTS — FIXED, DEPENDS ON FOCUS</h3>
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

        {!query && <ModelPacksSection />}

        <footer className="help-footer">
          <span>
            Close with <kbd className="help-kbd">Esc</kbd> or click outside
          </span>
        </footer>
      </div>
    </div>
  );
}
