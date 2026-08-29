import { useEffect } from "react";
import { useDoc, useServices, useSelection } from "./context";
import { clearSteps, deleteNote, deleteNotes, duplicateNotes, duplicatePattern } from "../commands/commands";

export interface ContextMenuState {
  x: number;
  y: number;
  context: string;
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();
  const selection = useSelection();

  useEffect(() => {
    if (!state) return;
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
      case "cut":
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
          services.store.execute(clearSteps(doc, doc.activePatternId, sel.padIds, sel.from, sel.to));
        } else if (hasClips) {
          // TODO: delete clips
        }
        break;
      }
      case "copy":
        // Handled via existing clipboard in PianoRoll/Sequencer
        break;
      case "duplicate": {
        if (hasNotes) {
          const sel = selection.noteSelections[0];
          if (sel) services.store.execute(duplicateNotes(doc, sel.trackId, sel.noteIds));
        } else {
          services.store.execute(duplicatePattern(doc, doc.activePatternId));
        }
        break;
      }
      case "consolidate":
        // Placeholder: would call buildStemProject + freeze
        break;
      default:
        break;
    }
    onClose();
  };

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label="Context menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="context-menu-header">{state.context}</div>
      <button type="button" role="menuitem" onClick={() => handle("cut")} disabled={!hasAny}>
        Cut
      </button>
      <button type="button" role="menuitem" onClick={() => handle("copy")} disabled={!hasAny}>
        Copy
      </button>
      <button type="button" role="menuitem" onClick={() => handle("paste")}>
        Paste
      </button>
      <button type="button" role="menuitem" onClick={() => handle("delete")} disabled={!hasAny}>
        Delete
      </button>
      <button type="button" role="menuitem" onClick={() => handle("duplicate")} disabled={!hasAny}>
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={() => handle("consolidate")} disabled={!hasTime}>
        Consolidate
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={() => handle("slice")}>
        Slice to pads
      </button>
      <button type="button" role="menuitem" onClick={() => handle("reverse")}>
        Reverse
      </button>
      <button type="button" role="menuitem" onClick={() => handle("normalize")}>
        Normalize
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
