import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useServices, useDoc } from "./context";
import type { ProjectSnapshot } from "../persistence/SnapshotRepository";

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
  const doc = useDoc();
  const historyKey = useSyncExternalStore(
    services.store.subscribe,
    () => services.store.undoStackLength,
    () => 0,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => services.store.history, [historyKey]);
  // ── Snapshots ("restore to yesterday") ─────────────────────────────────
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[] | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void services.core.snapshots
      .list(doc.id)
      .then((list) => {
        if (!cancelled) setSnapshots(list);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, services.core.snapshots, doc.id]);

  const snapshotNow = () => {
    setSnapBusy(true);
    const label = `Manual — ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    void services.core.snapshots
      .save(doc.id, doc, label)
      .then(() => services.core.snapshots.prune(doc.id))
      .then(() => services.core.snapshots.list(doc.id))
      .then((list) => setSnapshots(list))
      .catch(() => {})
      .finally(() => setSnapBusy(false));
  };

  /** Restore = one undoable command; collab peers receive it as a normal edit. */
  const restoreSnapshot = (snapshot: ProjectSnapshot) => {
    const before = doc;
    // Clone: the stored document must stay untouched for future restores.
    const restored = typeof structuredClone === "function" ? structuredClone(snapshot.doc) : snapshot.doc;
    services.store.execute({
      type: "restoreSnapshot",
      label: `Restore "${snapshot.label}"`,
      execute: () => restored,
      undo: () => before,
    });
  };

  const deleteSnapshot = (snapshot: ProjectSnapshot) => {
    void services.core.snapshots.delete(snapshot.id).then(() => {
      setSnapshots((list) => list?.filter((s) => s.id !== snapshot.id) ?? list);
    });
  };

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

      <div className="snapshots-section" aria-label="Project snapshots">
        <div className="snapshots-head">
          <span className="snapshots-title">SNAPSHOTS</span>
          <button
            type="button"
            className="btn btn-small snapshots-now"
            disabled={snapBusy}
            title="Save a manual snapshot of the whole project — restore any time from here"
            onClick={snapshotNow}
          >
            {snapBusy ? "…" : "⊕ NOW"}
          </button>
        </div>
        {snapshots === null && <div className="undo-history-empty">loading…</div>}
        {snapshots !== null && snapshots.length === 0 && (
          <div className="undo-history-empty">No snapshots yet — one is taken daily automatically</div>
        )}
        {snapshots?.map((snapshot) => (
          <div key={snapshot.id} className="snapshots-entry">
            <span className="snapshots-label" title={snapshot.label}>
              {snapshot.label}
            </span>
            <span className="snapshots-time">
              {new Date(snapshot.createdAt).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <button
              type="button"
              className="snapshots-restore"
              title="Replace the current project with this snapshot (undoable)"
              onClick={() => restoreSnapshot(snapshot)}
            >
              RESTORE
            </button>
            <button
              type="button"
              className="snapshots-delete"
              aria-label={`Delete snapshot ${snapshot.label}`}
              title="Delete snapshot"
              onClick={() => deleteSnapshot(snapshot)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
