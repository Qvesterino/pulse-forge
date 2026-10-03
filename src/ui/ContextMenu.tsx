import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActivePatternId, useArrangement, useSelection, useSelectionStore, useServices } from "./context";
import {
  clearSteps,
  deleteArrangementClip,
  deleteAudioClip,
  deleteNote,
  deleteNotes,
  duplicateNotes,
  duplicatePattern,
  duplicateTimeRange,
} from "../commands/commands";
import { BAR_TICKS } from "../project-model/types";
import { consolidateRangeToAudio } from "../services/rangeConsolidation";
import {
  applyClipArrangeOps,
  parseSelectedClipArrangeIntent,
  parseSelectedTimeRangeIntent,
  selectedTimeRangeIntentError,
} from "../intent/arrangeWords";

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
  const rangeEditInputRef = useRef<HTMLInputElement | null>(null);
  const [clipEditOpen, setClipEditOpen] = useState(false);
  const [clipEditText, setClipEditText] = useState("");
  const [clipEditError, setClipEditError] = useState<string | null>(null);
  const [clipEditTarget, setClipEditTarget] = useState<{
    id: string;
    sceneId: string;
    startBar: number;
    lengthBars: number;
  } | null>(null);
  const [rangeEditOpen, setRangeEditOpen] = useState(false);
  const [rangeEditText, setRangeEditText] = useState("");
  const [rangeEditError, setRangeEditError] = useState<string | null>(null);
  const [rangeEditBusy, setRangeEditBusy] = useState(false);
  const [rangeEditTarget, setRangeEditTarget] = useState<{ fromTick: number; toTick: number } | null>(null);
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
  const rangeEditPlan = useMemo(() => {
    if (!rangeEditText.trim()) return { operation: null, preview: null, error: null };
    if (!rangeEditTarget) return { operation: null, preview: null, error: "Select a time range first." };
    const currentRange = selection.timeRange;
    if (
      !currentRange ||
      currentRange.fromTick !== rangeEditTarget.fromTick ||
      currentRange.toTick !== rangeEditTarget.toTick
    ) {
      return {
        operation: null,
        preview: null,
        error: "The time selection changed. Close this editor and select the range again.",
      };
    }
    const operation = parseSelectedTimeRangeIntent(rangeEditText);
    if (!operation) {
      return {
        operation: null,
        preview: null,
        error: "Try “duplicate selected range” or “consolidate this range”.",
      };
    }
    const rangeError = selectedTimeRangeIntentError(doc, rangeEditTarget, operation);
    if (rangeError) return { operation: null, preview: null, error: rangeError };
    const fromBar = rangeEditTarget.fromTick / BAR_TICKS;
    const toBar = rangeEditTarget.toTick / BAR_TICKS;
    const count = toBar - fromBar;
    const preview =
      operation === "duplicate"
        ? `Duplicate bars ${fromBar + 1}–${toBar} (${count} bars), including musical and audio clips, markers, pattern notes, and drum steps; shift later clips/markers.`
        : `Render bars ${fromBar + 1}–${toBar} (${count} bars) to one full-mix audio print, replacing the selected clips.`;
    return { operation, preview, error: null };
  }, [doc, rangeEditTarget, rangeEditText, selection.timeRange]);
  const closeMenu = useCallback(() => {
    setClipEditOpen(false);
    setClipEditText("");
    setClipEditError(null);
    setClipEditTarget(null);
    setRangeEditOpen(false);
    setRangeEditText("");
    setRangeEditError(null);
    setRangeEditTarget(null);
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
    let keepOpen = false;
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
          try {
            services.store.execute(duplicateTimeRange(doc, selection.timeRange!.fromTick, selection.timeRange!.toTick));
          } catch (error) {
            // Zone duplicate fails closed when a clip crosses the zone (the
            // no-overlap contract). Route the failure to the range editor —
            // the user can adjust the range and retry from there — instead of
            // an unhandled throw from the click handler.
            setRangeEditTarget(selection.timeRange!);
            setRangeEditText("duplicate selected range");
            setRangeEditError(error instanceof Error ? error.message : String(error));
            setRangeEditOpen(true);
            keepOpen = true;
          }
        } else if (hasNotes) {
          const sel = selection.noteSelections[0];
          if (sel) services.store.execute(duplicateNotes(doc, sel.trackId, sel.noteIds));
        } else {
          services.store.execute(duplicatePattern(doc, activePatternId));
        }
        break;
      }
      case "consolidate": {
        if (selection.timeRange) {
          setRangeEditTarget(selection.timeRange);
          setRangeEditText("consolidate selected range");
          setRangeEditError(null);
          setRangeEditOpen(true);
          keepOpen = true;
        }
        break;
      }
      default:
        break;
    }
    if (!keepOpen) closeMenu();
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

  const applySelectedRangeEdit = async () => {
    if (!rangeEditTarget || !rangeEditPlan.operation) return;
    const currentDoc = services.store.getDoc();
    const currentRange = selectionStore.getState().timeRange;
    if (
      !currentRange ||
      currentRange.fromTick !== rangeEditTarget.fromTick ||
      currentRange.toTick !== rangeEditTarget.toTick
    ) {
      setRangeEditError("The time selection changed. Close this editor and select the range again.");
      return;
    }
    const operation = parseSelectedTimeRangeIntent(rangeEditText);
    if (!operation || selectedTimeRangeIntentError(currentDoc, rangeEditTarget, operation)) {
      setRangeEditError("The selected range no longer supports this operation. Review the range and try again.");
      return;
    }
    if (operation === "consolidate") {
      setRangeEditBusy(true);
      try {
        await consolidateRangeToAudio(services, rangeEditTarget, () => {
          const liveRange = selectionStore.getState().timeRange;
          return (
            rangeEditInputRef.current?.value.trim() === rangeEditText &&
            liveRange != null &&
            liveRange.fromTick === rangeEditTarget.fromTick &&
            liveRange.toTick === rangeEditTarget.toTick &&
            parseSelectedTimeRangeIntent(rangeEditInputRef.current?.value ?? "") === "consolidate"
          );
        });
        closeMenu();
      } catch (error) {
        setRangeEditError(error instanceof Error ? error.message : String(error));
      } finally {
        setRangeEditBusy(false);
      }
      return;
    }
    try {
      const command = duplicateTimeRange(currentDoc, rangeEditTarget.fromTick, rangeEditTarget.toTick);
      services.store.execute(command);
      closeMenu();
    } catch (error) {
      setRangeEditError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role={clipEditOpen || rangeEditOpen ? "dialog" : "menu"}
      aria-label={
        clipEditOpen
          ? "Edit selected clip with Producer"
          : rangeEditOpen
            ? "Edit selected range with Producer"
            : "Context menu"
      }
      style={{
        left: Math.max(8, Math.min(state.x, window.innerWidth - (clipEditOpen || rangeEditOpen ? 360 : 220))),
        top: Math.max(8, Math.min(state.y, window.innerHeight - (clipEditOpen || rangeEditOpen ? 280 : 160))),
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
      ) : rangeEditOpen ? (
        <>
          <div className="context-menu-header">PRODUCER EDIT · SELECTED RANGE</div>
          <div className="context-menu-edit-target">
            {rangeEditTarget
              ? `Target locked · bars ${rangeEditTarget.fromTick / BAR_TICKS + 1}–${rangeEditTarget.toTick / BAR_TICKS} · ${
                  (rangeEditTarget.toTick - rangeEditTarget.fromTick) / BAR_TICKS
                } bars`
              : "Target unavailable"}
          </div>
          <label className="context-menu-edit-label">
            Describe one range operation
            <input
              className="context-menu-edit-input"
              aria-label="Producer range instruction"
              autoFocus
              ref={rangeEditInputRef}
              value={rangeEditText}
              disabled={rangeEditBusy}
              placeholder="duplicate selected range"
              onChange={(event) => {
                setRangeEditText(event.target.value);
                setRangeEditError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && rangeEditPlan.operation && !rangeEditPlan.error) applySelectedRangeEdit();
              }}
            />
          </label>
          {rangeEditPlan.preview && (
            <div className="context-menu-edit-preview" role="region" aria-label="Selected range edit preview">
              <strong>PREVIEW · MUSICAL + AUDIO</strong>
              <div>{rangeEditPlan.preview}</div>
            </div>
          )}
          {rangeEditPlan.operation === "consolidate" && (
            <div className="context-menu-edit-error" role="note">
              This replaces the source material inside the selection. Undo restores it.
            </div>
          )}
          {(rangeEditError ?? rangeEditPlan.error) && (
            <div className="context-menu-edit-error" role="alert">
              {rangeEditError ?? rangeEditPlan.error}
            </div>
          )}
          <div className="context-menu-edit-actions">
            <button
              type="button"
              disabled={rangeEditBusy}
              onClick={() => {
                setRangeEditOpen(false);
                setRangeEditText("");
                setRangeEditError(null);
                setRangeEditTarget(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!rangeEditPlan.operation || !!rangeEditPlan.error || rangeEditBusy}
              onClick={() => void applySelectedRangeEdit()}
            >
              {rangeEditBusy
                ? "RENDERING PRINT…"
                : rangeEditPlan.operation === "consolidate"
                  ? "CONSOLIDATE · ONE UNDO STEP"
                  : rangeEditPlan.operation === "duplicate"
                    ? "DUPLICATE · ONE UNDO STEP"
                    : "APPLY · ONE UNDO STEP"}
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
          {hasTime && (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              onClick={() => {
                setRangeEditText("");
                setRangeEditError(null);
                setRangeEditTarget(selection.timeRange ? { ...selection.timeRange } : null);
                setRangeEditOpen(true);
              }}
              title="Describe a duplicate or consolidate action; complete bars only, with audio boundary clips protected"
            >
              Producer edit selected range…
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
