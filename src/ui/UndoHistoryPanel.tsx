import { useMemo, useSyncExternalStore } from "react";
import { useServices } from "./context";

function formatTime(ts: number): string {
  if (ts === 0) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function diffLabel(diff: { added: number; removed: number; changed: number } | undefined): string {
  if (!diff || (diff.added === 0 && diff.removed === 0 && diff.changed === 0)) return "";
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`+${diff.added}`);
  if (diff.removed > 0) parts.push(`−${diff.removed}`);
  if (diff.changed > 0) parts.push(`~${diff.changed}`);
  return parts.join(" ");
}

/**
 * Cubase-style undo history panel: last 20 commands with a cheap ±diff
 * (from the doc delta) and click-to-jump (undo/redo to that state).
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
  // In the reversed list, idx 0 = newest. Jump target for entry i is its
  // position in the chronological undo stack (length-1-i).
  const jump = (chronologicalIndex: number) => {
    const store = services.store as unknown as { jumpTo?: (i: number) => void };
    if (typeof store.jumpTo === "function") store.jumpTo(chronologicalIndex);
  };

  return (
    <div className="undo-history-panel" role="region" aria-label="Undo history">
      <div className="undo-history-header">
        <span className="undo-history-title">HISTORY</span>
        <span className="undo-history-count">{history.length} steps</span>
      </div>
      {reversed.length === 0 && <div className="undo-history-empty">No history yet</div>}
      <div className="undo-history-list">
        {reversed.map((entry, idx) => {
          const chronoIdx = history.length - 1 - idx;
          const diff = diffLabel((entry as { diff?: { added: number; removed: number; changed: number } }).diff);
          return (
            <button
              key={`${entry.type}-${idx}`}
              type="button"
              className={`undo-history-entry${idx === 0 ? " current" : ""}`}
              style={{
                cursor: "pointer",
                background: "transparent",
                border: "none",
                color: "inherit",
                textAlign: "left",
                width: "100%",
                padding: "4px 8px",
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
              title={`Jump to this state — ${entry.label}`}
              onClick={() => jump(chronoIdx)}
            >
              <span className="undo-history-dot" />
              <span className="undo-history-label">{entry.label}</span>
              {diff && (
                <span
                  className="undo-history-diff"
                  style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)", letterSpacing: 0.3 }}
                >
                  {diff}
                </span>
              )}
              <span className="undo-history-time">{formatTime(entry.timestamp)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
