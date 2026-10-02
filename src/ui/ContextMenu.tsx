import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActivePatternId, useArrangement, useSelection, useSelectionStore, useServices } from "./context";
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
import { applyClipArrangeOps, parseSelectedClipArrangeIntent } from "../intent/arrangeWords";

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
  const selectionStore = useSelectionStore();
  const doc = services.store.getDoc();
  const selection = useSelection();
  const menuRef = useRef<HTMLDivElement>(null);
  const [clipEditOpen, setClipEditOpen] = useState(false);
  const [clipEditText, setClipEditText] = useState("");
  const [clipEditError, setClipEditError] = useState<string | null>(null);
  const [clipEditTarget, setClipEditTarget] = useState<{
    id: string;
    sceneId: string;
    startBar: number;
    lengthBars: number;
  } | null>(null);
  const selectedArrangementClip =
    selection.clipIds.length === 1 ? arrangement.clips.find((clip) => clip.id === selection.clipIds[0]) : undefined;
  const editorClip = clipEditTarget ? arrangement.clips.find((clip) => clip.id === clipEditTarget.id) : undefined;
  const clipEditPlan = useMemo(() => {
    if (!clipEditText.trim()) return { ops: null, preview: [], error: null };
    if (!clipEditTarget || !editorClip)
      return { ops: null, preview: [], error: "The selected clip is no longer available." };
    if (
      editorClip.sceneId !== clipEditTarget.sceneId ||
      editorClip.startBar !== clipEditTarget.startBar ||
      editorClip.lengthBars !== clipEditTarget.lengthBars
    ) {
      return {
        ops: null,
        preview: [],
        error: "The selected clip changed. Close this editor and review the new selection.",
      };
    }
    const ops = parseSelectedClipArrangeIntent(clipEditText, doc, clipEditTarget.id);
    if (!ops) {
      return {
        ops: null,
        preview: [],
        error: "No supported change found. Try “move selected clip to bar 8” or “resize selected clip to 4 bars”.",
      };
    }
    const preview = ops.map((op) => {
      if (op.op === "copyClip") return `Copy from bar ${editorClip.startBar + 1} to bar ${op.toBar + 1}`;
      if (op.op === "moveClip") return `Move from bar ${editorClip.startBar + 1} to bar ${op.toBar + 1}`;
      if (op.op === "resizeClip") return `Resize from ${editorClip.lengthBars} to ${op.bars} bars`;
      return `Delete clip at bar ${editorClip.startBar + 1}`;
    });
    return { ops, preview, error: null };
  }, [clipEditText, clipEditTarget, doc, editorClip]);
  const closeMenu = useCallback(() => {
    setClipEditOpen(false);
    setClipEditText("");
    setClipEditError(null);
    setClipEditTarget(null);
    onClose();
  }, [onClose]);
  // Keyboard users must be able to reach the menu: focus the first item on
  // open and hand focus back to whatever was focused before.
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!state) return;
    previousFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    menuRef.current
      ?.querySelector<HTMLElement>('button[role="menuitem"]:not(:disabled), input:not(:disabled)')
      ?.focus();
    const restoreFocus = previousFocus.current;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const click = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".context-menu")) return;
      closeMenu();
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
  }, [state, closeMenu]);

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
            // Same ownership as pruneTrack: the deleted ids must not survive
            // in the selection, or the menu header keeps counting them and
            // `P` (locators to loop) silently does nothing over dead ids.
            selectionStore.retainClips([
              ...next.arrangement.clips.map((clip) => clip.id),
              ...(next.arrangement.audioClips ?? []).map((clip) => clip.id),
            ]);
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
    closeMenu();
  };

  const applySelectedClipEdit = () => {
    if (!clipEditTarget || !clipEditPlan.ops) return;
    const currentDoc = services.store.getDoc();
    const currentSelection = selectionStore.getState().clipIds;
    const liveClip = currentDoc.arrangement.clips.find((clip) => clip.id === clipEditTarget.id);
    if (
      currentSelection.length !== 1 ||
      currentSelection[0] !== clipEditTarget.id ||
      !liveClip ||
      liveClip.sceneId !== clipEditTarget.sceneId ||
      liveClip.startBar !== clipEditTarget.startBar ||
      liveClip.lengthBars !== clipEditTarget.lengthBars
    ) {
      setClipEditError("The selected clip changed. Close this editor and review the new selection.");
      return;
    }
    const currentOps = parseSelectedClipArrangeIntent(clipEditText, currentDoc, liveClip.id);
    if (!currentOps) {
      setClipEditError("The clip edit no longer resolves against the current arrangement.");
      return;
    }
    try {
      const command = applyClipArrangeOps(currentDoc, currentOps);
      if (!command) {
        setClipEditError("The selected clip is no longer available.");
        return;
      }
      services.store.execute(command);
      if (currentOps.some((op) => op.op === "deleteClip")) {
        const updated = services.store.getDoc();
        selectionStore.retainClips([
          ...updated.arrangement.clips.map((clip) => clip.id),
          ...(updated.arrangement.audioClips ?? []).map((clip) => clip.id),
        ]);
      }
      closeMenu();
    } catch (error) {
      setClipEditError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role={clipEditOpen ? "dialog" : "menu"}
      aria-label={clipEditOpen ? "Edit selected clip with Producer" : "Context menu"}
      style={{
        left: Math.max(8, Math.min(state.x, window.innerWidth - (clipEditOpen ? 360 : 220))),
        top: Math.max(8, Math.min(state.y, window.innerHeight - (clipEditOpen ? 280 : 160))),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {clipEditOpen ? (
        <>
          <div className="context-menu-header">PRODUCER EDIT · SELECTED CLIP</div>
          <div className="context-menu-edit-target">
            {editorClip
              ? `Target locked · bar ${editorClip.startBar + 1} · ${editorClip.lengthBars} bars`
              : "Target unavailable"}
          </div>
          <label className="context-menu-edit-label">
            Describe one arrangement change
            <input
              className="context-menu-edit-input"
              aria-label="Producer clip instruction"
              autoFocus
              value={clipEditText}
              placeholder="move selected clip to bar 8"
              onChange={(event) => {
                setClipEditText(event.target.value);
                setClipEditError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && clipEditPlan.ops && !clipEditPlan.error) applySelectedClipEdit();
              }}
            />
          </label>
          {clipEditPlan.preview.length > 0 && (
            <div className="context-menu-edit-preview" role="region" aria-label="Selected clip edit preview">
              <strong>PREVIEW · {clipEditPlan.ops?.length} operation(s)</strong>
              {clipEditPlan.preview.map((line, index) => (
                <div key={`${index}-${line}`}>{line}</div>
              ))}
            </div>
          )}
          {(clipEditError ?? clipEditPlan.error) && (
            <div className="context-menu-edit-error" role="alert">
              {clipEditError ?? clipEditPlan.error}
            </div>
          )}
          <div className="context-menu-edit-actions">
            <button
              type="button"
              onClick={() => {
                setClipEditOpen(false);
                setClipEditText("");
                setClipEditError(null);
                setClipEditTarget(null);
              }}
            >
              Cancel
            </button>
            <button type="button" disabled={!clipEditPlan.ops || !!clipEditPlan.error} onClick={applySelectedClipEdit}>
              APPLY · ONE UNDO STEP
            </button>
          </div>
        </>
      ) : (
        <>
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
          {hasClips && (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              onClick={() => {
                setClipEditText("");
                setClipEditError(null);
                setClipEditTarget(
                  selectedArrangementClip
                    ? {
                        id: selectedArrangementClip.id,
                        sceneId: selectedArrangementClip.sceneId,
                        startBar: selectedArrangementClip.startBar,
                        lengthBars: selectedArrangementClip.lengthBars,
                      }
                    : null,
                );
                setClipEditOpen(true);
              }}
              disabled={!selectedArrangementClip}
              title={
                selectedArrangementClip
                  ? "Describe a change for this clip; target stays locked to the selection"
                  : "Select exactly one arrangement clip"
              }
            >
              Producer edit selected clip…
            </button>
          )}
        </>
      )}
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
