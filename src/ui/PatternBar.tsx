import { useState } from "react";
import { useDoc, useServices } from "./context";
import {
  clearPattern,
  createPattern,
  deletePattern,
  duplicatePattern,
  pastePattern,
  renamePattern,
  setActivePattern,
  setPatternLength,
} from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";

export function PatternBar({ clip, onCopy }: { clip: PatternClipboard | null; onCopy: (clip: PatternClipboard) => void }) {
  const services = useServices();
  const doc = useDoc();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const active = doc.patterns.find((p) => p.id === doc.activePatternId)!;

  const beginRename = (id: string, name: string) => {
    setEditingId(id);
    setDraft(name);
  };

  const commitRename = () => {
    if (editingId !== null && draft.trim() !== "") {
      const current = doc.patterns.find((p) => p.id === editingId);
      if (current && current.name !== draft.trim()) {
        services.store.execute(renamePattern(doc, editingId, draft.trim()));
      }
    }
    setEditingId(null);
  };

  return (
    <section className="pattern-bar" aria-label="Patterns">
      <div className="pattern-chips" role="tablist" aria-label="Pattern selector">
        {doc.patterns.map((pattern) => {
          const isActive = pattern.id === doc.activePatternId;
          if (editingId === pattern.id) {
            return (
              <input
                key={pattern.id}
                className="pattern-rename"
                value={draft}
                autoFocus
                aria-label="Pattern name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setEditingId(null);
                }}
              />
            );
          }
          return (
            <button
              key={pattern.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`pattern-chip${isActive ? " active" : ""}`}
              title={`${pattern.name} (${pattern.stepCount} steps) — click to select, double-click or F2 to rename`}
              onClick={() => services.store.execute(setActivePattern(doc, pattern.id))}
              onDoubleClick={() => beginRename(pattern.id, pattern.name)}
              onKeyDown={(event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename(pattern.id, pattern.name);
                }
              }}
            >
              {pattern.name}
            </button>
          );
        })}
      </div>
      <div className="pattern-actions">
        <button type="button" className="btn btn-small" title="New pattern" onClick={() => services.store.execute(createPattern(doc))}>
          ADD
        </button>
        <button type="button" className="btn btn-small" title="Duplicate active pattern (Ctrl+D)" onClick={() => services.store.execute(duplicatePattern(doc, doc.activePatternId))}>
          DUP
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Copy active pattern"
          onClick={() => onCopy({ stepCount: active.stepCount, rows: active.rows, notes: active.notes ?? {} })}
        >
          COPY
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Paste into active pattern"
          disabled={clip === null}
          onClick={() => clip && services.store.execute(pastePattern(doc, clip))}
        >
          PASTE
        </button>
        <button type="button" className="btn btn-small" title="Clear all steps of active pattern" onClick={() => services.store.execute(clearPattern(doc, doc.activePatternId))}>
          CLEAR
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title="Delete active pattern"
          disabled={doc.patterns.length <= 1}
          onClick={() => services.store.execute(deletePattern(doc, doc.activePatternId))}
        >
          DEL
        </button>
        <select
          className="pattern-length"
          aria-label="Pattern length"
          title="Pattern length in steps"
          value={active.stepCount}
          onChange={(event) => services.store.execute(setPatternLength(doc, doc.activePatternId, Number(event.target.value)))}
        >
          <option value={16}>16</option>
          <option value={32}>32</option>
        </select>
      </div>
    </section>
  );
}
