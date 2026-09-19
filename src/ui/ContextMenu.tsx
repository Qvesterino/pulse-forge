import { useEffect, useRef } from "react";
import { useActivePatternId, useArrangement, useServices, useSelection } from "./context";
import {
  clearSteps,
  consolidateTimeRange,
  deleteArrangementClip,
  deleteAudioClip,
  deleteNote,
  deleteNotes,
  duplicateNotes,
  duplicatePattern,
  duplicateTimeRange,
} from "../commands/commands";

export interface ContextMenuState {
  x: number;
  y: number;
  context: string;
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const services = useServices();
  // Fine-grained selectors (GOAL 04): ContextMenu reads the arrangement
  // (clip + audio clip id sets for menu enable/disable) and the active
  // pattern id (for duplicate-pattern). Subscribing to the whole doc
  // re-renders this menu on every unrelated edit.
  const arrangement = useArrangement();
  const activePatternId = useActivePatternId();
  const doc = services.store.getDoc();
  const selection = useSelection();
  const menuRef = useRef<HTMLDivElement>(null);
  // Keyboard users must be able to reach the menu: focus the first item on
  // open and hand focus back to whatever was focused before.
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!state) return;
    previousFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
    const restoreFocus = previousFocus.current;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const click = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".context-menu")) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("mousedown", click);
      // Only steal focus back when the menu itself still holds it (the user
      // may have clicked straight into another control).
      if (menuRef.current?.contains(document.activeElement)) {
        restoreFocus?.focus?.();
      }
    };
  }, [state, onClose]);

  if (!state) return null;

  const hasNotes = selection.noteSelections.length > 0;
  const hasSteps = !!selection.stepSelection;
  const hasClips = selection.clipIds.length > 0;
  const hasTime = !!selection.timeRange;
  const hasAny = hasNotes || hasSteps || hasClips || hasTime;

  const handle = (action: string) => {
    switch (action) {
      case "delete": {
        if (hasNotes) {
          const sel = selection.noteSelections[0];
          if (sel) {
            const cmd =
              sel.noteIds.length === 1
                ? deleteNote(doc, sel.trackId, sel.noteIds[0])
                : deleteNotes(doc, sel.trackId, sel.noteIds);
            services.store.execute(cmd);
          }
        } else if (hasSteps) {
          const sel = selection.stepSelection!;
          services.store.execute(clearSteps(doc, activePatternId, sel.padIds, sel.from, sel.to));
        } else if (hasClips) {
          const arrangementIds = new Set(arrangement.clips.map((clip) => clip.id));
          const audioIds = new Set((arrangement.audioClips ?? []).map((clip) => clip.id));
          let next = doc;
          for (const clipId of selection.clipIds) {
            if (arrangementIds.has(clipId)) next = deleteArrangementClip(next, clipId).execute(next);
            else if (audioIds.has(clipId)) next = deleteAudioClip(next, clipId).execute(next);
          }
          if (next !== doc) {
            // Multiple selected clips are one user gesture and therefore one
            // undo entry, regardless of clip kind.
            services.store.execute({
              type: "deleteClips",
              label: "Delete clips",
              execute: () => next,
              undo: () => doc,
            });
          }
        }
        break;
      }
      case "duplicate": {
        if (hasTime) {
          services.store.execute(duplicateTimeRange(doc, selection.timeRange!.fromTick, selection.timeRange!.toTick));
        } else if (hasNotes) {
          const sel = selection.noteSelections[0];
          if (sel) services.store.execute(duplicateNotes(doc, sel.trackId, sel.noteIds));
        } else {
          services.store.execute(duplicatePattern(doc, activePatternId));
        }
        break;
      }
      case "consolidate": {
        if (hasTime) {
          services.store.execute(consolidateTimeRange(doc, selection.timeRange!.fromTick, selection.timeRange!.toTick));
        }
        break;
      }
      default:
        break;
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label="Context menu"
      style={{
        left: Math.min(state.x, window.innerWidth - 220),
        top: Math.min(state.y, window.innerHeight - 160),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="context-menu-header">{state.context}</div>
      <button type="button" role="menuitem" onClick={() => handle("delete")} disabled={!hasAny}>
        Delete
      </button>
      <button type="button" role="menuitem" onClick={() => handle("duplicate")} disabled={!hasAny}>
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={() => handle("consolidate")} disabled={!hasTime}>
        Consolidate
      </button>
    </div>
  );
}

export function deriveContext(selection: ReturnType<typeof useSelection>, hoverTarget: string | null): string {
  if (hoverTarget) return hoverTarget;
  if (selection.noteSelections.length > 0) return `${selection.noteSelections[0].noteIds.length} notes`;
  if (selection.stepSelection)
    return `${selection.stepSelection.padIds.length}×${selection.stepSelection.to - selection.stepSelection.from + 1} steps`;
  if (selection.clipIds.length > 0) return `${selection.clipIds.length} clips`;
  if (selection.timeRange) return `zone ${selection.timeRange.fromTick}–${selection.timeRange.toTick}`;
  if (selection.trackIds.length > 0) return `${selection.trackIds.length} tracks`;
  return "Canvas";
}
