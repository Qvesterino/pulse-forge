import { useState, useSyncExternalStore } from "react";
import { useDoc, useServices } from "./context";
import {
  clearPattern,
  createFill,
  createPattern,
  deletePattern,
  duplicatePattern,
  mutatePattern,
  pastePattern,
  renamePattern,
  setActivePattern,
  setGroove,
  setPatternLength,
} from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";
import { grooveOf } from "../project-model/types";
import { DragNumber } from "./controls";

export function PatternBar({ clip, onCopy }: { clip: PatternClipboard | null; onCopy: (clip: PatternClipboard) => void }) {
  const services = useServices();
  const doc = useDoc();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const active = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const groove = grooveOf(doc);
  const pendingPatternId = useSyncExternalStore(
    (cb) => {
      const unsubPlayback = services.playback.subscribe(cb);
      const unsubScheduler = services.scheduler.subscribe(cb);
      return () => {
        unsubPlayback();
        unsubScheduler();
      };
    },
    () => services.scheduler.pendingPatternId ?? "",
    () => "",
  );

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

      <div className="pattern-groove" aria-label="Groove">
        <DragNumber
          label="SWING"
          value={groove.swing}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(swing) => services.store.execute(setGroove(doc, { swing }))}
        />
        <DragNumber
          label="HUM·T"
          value={groove.humanizeTiming}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(humanizeTiming) => services.store.execute(setGroove(doc, { humanizeTiming }))}
        />
        <DragNumber
          label="HUM·V"
          value={groove.humanizeVelocity}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(humanizeVelocity) => services.store.execute(setGroove(doc, { humanizeVelocity }))}
        />
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
          title="Mutate active pattern into a seeded variation (velocities, ghosts, microtiming)"
          onClick={() => services.store.execute(mutatePattern(doc, doc.activePatternId))}
        >
          MUT
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Duplicate active pattern as a fill (snare roll over the last beat)"
          onClick={() => services.store.execute(createFill(doc, doc.activePatternId))}
        >
          FILL
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

      <div className="scene-strip" aria-label="Scene launch">
        {doc.scenes.map((scene) => {
          const pattern = doc.patterns.find((p) => p.id === scene.patternId);
          const isActive = pattern?.id === doc.activePatternId;
          const isQueued = pendingPatternId === scene.patternId;
          return (
            <button
              key={scene.id}
              type="button"
              className={`scene-launch${isActive ? " active" : ""}${isQueued ? " queued" : ""}`}
              title={`${scene.name} → ${pattern?.name ?? "?"} — launch${isQueued ? " (queued for next bar)" : ""}`}
              onClick={() => services.playback.launchScene(scene)}
            >
              {scene.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}
