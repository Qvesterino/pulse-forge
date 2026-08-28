import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { useServices } from "./context";

function formatTime(ts: number): string {
  if (ts === 0) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Decent undo history panel. Shows the last 20 commands in the undo stack.
 * Collapsed by default — toggled via a button in the TopBar.
 */
export function UndoHistoryPanel({ open }: { open: boolean }) {
  const services = useServices();
  const historyKey = useSyncExternalStore(
    services.store.subscribe,
    () => services.store.undoStackLength,
    () => 0,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => services.store.history, [historyKey]);

  if (!open) return null;

  const reversed = [...history].reverse();

  return (
    <div className="undo-history-panel" role="region" aria-label="Undo history">
      <div className="undo-history-header">
        <span className="undo-history-title">HISTORY</span>
        <span className="undo-history-count">{history.length} steps</span>
      </div>
      {reversed.length === 0 && <div className="undo-history-empty">No history yet</div>}
      <div className="undo-history-list">
        {reversed.map((entry, idx) => (
          <div key={`${entry.type}-${idx}`} className={`undo-history-entry${idx === 0 ? " current" : ""}`}>
            <span className="undo-history-dot" />
            <span className="undo-history-label">{entry.label}</span>
            <span className="undo-history-time">{formatTime(entry.timestamp)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
