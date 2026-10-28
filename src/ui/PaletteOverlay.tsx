import { useEffect, useMemo, useRef, useState } from "react";
import { buildPaletteActions, filterActions, type PaletteAction, type PaletteDeps } from "./commandPalette";
import { useFocusRestore } from "./useFocusRestore";

interface CommandPaletteProps {
  open: boolean;
  deps: PaletteDeps;
  onClose: () => void;
}

/**
 * Ctrl+K command palette — type to filter every app action, arrows to move,
 * Enter to run. Consumes its own keydowns with preventDefault so the global
 * shortcut handler (which skips default-prevented events) stays quiet.
 */
export function PaletteOverlay({ open, deps, onClose }: CommandPaletteProps) {
  const overlayRef = useFocusRestore<HTMLDivElement>(open);
  // Built inside the lazy chunk so the registry never touches the entry bundle.
  const actions = buildPaletteActions(deps);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const results = useMemo(() => filterActions(actions, query), [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    const item = listRef.current?.children[selected] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" }); // jsdom has no scrollIntoView
  }, [selected]);

  if (!open) return null;

  const runAction = (action: PaletteAction) => {
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((idx) => Math.min(results.length - 1, idx + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((idx) => Math.max(0, idx - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const action = results[selected];
      // An action that cannot run right now says why; pressing Enter on it
      // does nothing rather than failing silently.
      if (action && !action.unavailableReason) runAction(action);
    }
  };

  return (
    <div
      className="palette-overlay"

      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette-card">
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          placeholder="Type a command — e.g. solo, export, loop…"
          aria-label="Search commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <ul className="palette-list" ref={listRef} role="listbox" aria-label="Commands">
          {results.map((action, idx) => (
            <li key={action.id}>
              <button
                type="button"
                role="option"
                aria-selected={idx === selected}
                // aria-disabled, NOT the disabled attribute: a disabled button
                // fires no hover, so the reason would never be readable. This
                // way the row stays visible AND says why it cannot run.
                aria-disabled={action.unavailableReason ? true : undefined}
                className={`palette-item${idx === selected ? " selected" : ""}${
                  action.unavailableReason ? " unavailable" : ""
                }`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => {
                  if (action.unavailableReason) return;
                  runAction(action);
                }}
                title={action.unavailableReason}
              >
                <span className="palette-copy">
                  <span className="palette-title">{action.title}</span>
                  {action.profileHint && <span className="palette-profile-hint">{action.profileHint}</span>}
                  {action.unavailableReason && <span className="palette-unavailable">{action.unavailableReason}</span>}
                </span>
                {action.binding && (
                  <kbd className="help-kbd palette-kbd" aria-label={action.binding}>
                    {action.binding}
                  </kbd>
                )}
                <span className="palette-group">{action.group.toUpperCase()}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">No command matches "{query.trim()}"</li>}
        </ul>
        <div className="palette-footer">
          <span>
            <kbd className="help-kbd">↑</kbd> <kbd className="help-kbd">↓</kbd> move ·{" "}
            <kbd className="help-kbd">Enter</kbd> run · <kbd className="help-kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
