import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack, StepMeta, Track } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import {
  clearStepLocks,
  pasteStepLocks,
  setPadParams,
  setStepLocks,
  setStepMeta,
  setStepsLocks,
  setStepsVelocity,
  setStepVelocityCommand,
  setTrackParams,
  toggleStep,
} from "../commands/commands";
import { assetCategoryOf, categoryColor } from "./kitColors";
import { PianoRollTrack } from "./PianoRoll";
import type { SelectedNote } from "./PianoRoll";
import { trackBadge } from "./TrackTabs";
import { useLongPress } from "./useLongPress";
import { clamp } from "../shared/ids";
import { DragNumber, Slider } from "./controls";
import { cursorsAt, usePublishCursor, useRemoteCursors } from "./remoteCursors";
import type { RemoteCursor } from "../collab/CollaborationProvider";

export interface StepSelection {
  padIds: string[];
  from: number;
  to: number;
}

interface DragState {
  mode: "edit" | "select";
  padId: string;
  stepIndex: number;
  startY: number;
  startVelocity: number;
  startMicro: number;
  startProb: number;
  editKind: "velocity" | "microtiming" | "probability";
  moved: boolean;
}

// Flat item types for virtualized rendering
interface HeaderItem {
  type: "header";
  trackIndex: number;
  track: Track;
}
interface PadRowItem {
  type: "padRow";
  trackIndex: number;
  padIndex: number;
  pad: DrumTrack["pads"][number];
  trackId: string;
}
interface PianoRollItem {
  type: "pianoRoll";
  trackIndex: number;
  track: Track;
}
type FlatItem = HeaderItem | PadRowItem | PianoRollItem;

const COARSE_POINTER = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
const ROW_HEIGHT = COARSE_POINTER ? 46 : 34;
const HEADER_HEIGHT = COARSE_POINTER ? 44 : 38;
const STEP_MIN_PX = COARSE_POINTER ? 34 : 22;
const OVERSCAN = 5;

function buildFlatItems(tracks: Track[]): FlatItem[] {
  const items: FlatItem[] = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    items.push({ type: "header", trackIndex: ti, track });
    if (track.kind === "group") continue;
    if (track.kind === "drum") {
      for (let pi = 0; pi < track.pads.length; pi++) {
        items.push({ type: "padRow", trackIndex: ti, padIndex: pi, pad: track.pads[pi], trackId: track.id });
      }
    } else {
      items.push({ type: "pianoRoll", trackIndex: ti, track });
    }
  }
  return items;
}

function getItemHeight(item: FlatItem): number {
  return item.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT;
}

export function Sequencer({
  selectedPadId,
  selectedTrackId,
  onSelectTrack,
  onSelectPad,
  selectedNote,
  onSelectNote,
  stepSelection,
  onSelectSteps,
  scaleSnap,
}: {
  selectedPadId: string;
  selectedTrackId: string;
  onSelectTrack: (trackId: string) => void;
  onSelectPad: (padId: string) => void;
  selectedNote: SelectedNote | null;
  onSelectNote: (selection: SelectedNote | null) => void;
  stepSelection: StepSelection | null;
  onSelectSteps: (selection: StepSelection | null) => void;
  scaleSnap: boolean;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  const playheadStep = usePlayheadStep(services.transport, doc);
  const dragRef = useRef<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    padId: string;
    stepIndex: number;
    velocity: number;
    microtiming?: number;
    probability?: number;
    kind?: DragState["editKind"];
  } | null>(null);
  const [stepEditor, setStepEditor] = useState<{ padId: string; stepIndex: number } | null>(null);
  const [lockClipboard, setLockClipboard] = useState<Partial<
    Record<import("../project-model/types").StepLockKey, number>
  > | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Presence: everyone else's cursor, published/erased on hover cell changes.
  const remoteCursors = useRemoteCursors();
  const publishCursor = usePublishCursor();
  // Fullscreen piano roll on touch/narrow screens — which track is expanded.
  const [pianoFullTrack, setPianoFullTrack] = useState<string | null>(null);

  // Flatten track tree into virtualizable items
  const flatItems = useMemo(() => buildFlatItems(doc.tracks), [doc.tracks]);

  // Compute cumulative heights for index lookup
  const cumulativeHeights = useMemo(() => {
    const heights: number[] = [0];
    for (const item of flatItems) {
      heights.push(heights[heights.length - 1] + getItemHeight(item));
    }
    return heights;
  }, [flatItems]);

  const totalHeight = cumulativeHeights[cumulativeHeights.length - 1];

  // Compute visible range from scroll position
  const { startIndex, endIndex } = useMemo(() => {
    let start = 0;
    while (start < flatItems.length && cumulativeHeights[start + 1] < scrollTop) start++;
    let end = start;
    while (end < flatItems.length && cumulativeHeights[end] < scrollTop + viewportHeight) end++;
    return {
      startIndex: Math.max(0, start - OVERSCAN),
      endIndex: Math.min(flatItems.length - 1, end + OVERSCAN),
    };
  }, [scrollTop, viewportHeight, cumulativeHeights, flatItems.length]);

  const visibleItems = useMemo(() => {
    const items: { item: FlatItem; top: number; height: number }[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      items.push({ item: flatItems[i], top: cumulativeHeights[i], height: getItemHeight(flatItems[i]) });
    }
    return items;
  }, [flatItems, startIndex, endIndex, cumulativeHeights]);

  // Display order of pad rows — used to build rectangular selections.
  const orderedPadIds: string[] = useMemo(() => {
    const ids: string[] = [];
    for (const track of doc.tracks) {
      if (track.kind === "drum") for (const pad of track.pads) ids.push(pad.id);
    }
    return ids;
  }, [doc.tracks]);

  const selectionFromDrag = (
    anchorPad: string,
    anchorStep: number,
    padId: string,
    stepIndex: number,
  ): StepSelection => {
    const a = orderedPadIds.indexOf(anchorPad);
    const b = orderedPadIds.indexOf(padId);
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(orderedPadIds.length - 1, Math.max(a, b));
    return {
      padIds: orderedPadIds.slice(lo, hi + 1),
      from: Math.min(anchorStep, stepIndex),
      to: Math.max(anchorStep, stepIndex),
    };
  };

  const selectionContains = (padId: string, stepIndex: number): boolean =>
    stepSelection !== null &&
    stepSelection.padIds.includes(padId) &&
    stepIndex >= stepSelection.from &&
    stepIndex <= stepSelection.to;

  const beginStepInteraction = (event: React.PointerEvent, padId: string, stepIndex: number) => {
    // RMB lasso — right-drag selects regardless of Shift. Selection only
    // starts on the first MOVE: selecting on pointerdown would render the
    // p-lock toolbar above the grid and shift it before the browser
    // dispatches contextmenu, so the event landed on whatever moved under
    // the cursor and a plain right-click could never open the step editor.
    if (event.button === 2) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* no capture */
      }
      dragRef.current = {
        mode: "select",
        padId,
        stepIndex,
        startY: event.clientY,
        startVelocity: 0,
        startMicro: 0,
        startProb: 1,
        editKind: "velocity",
        moved: false,
      };
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic/test-dispatched pointers have no active pointer id —
      // drag tracking simply continues without capture.
    }
    if (event.shiftKey) {
      dragRef.current = {
        mode: "select",
        padId,
        stepIndex,
        startY: event.clientY,
        startVelocity: 0,
        startMicro: 0,
        startProb: 1,
        editKind: "velocity",
        moved: true,
      };
      onSelectSteps(selectionFromDrag(padId, stepIndex, padId, stepIndex));
      return;
    }
    const meta = pattern.stepMeta?.[padId]?.[stepIndex];
    const editKind: DragState["editKind"] = event.altKey
      ? "microtiming"
      : event.ctrlKey || event.metaKey
        ? "probability"
        : "velocity";
    dragRef.current = {
      mode: "edit",
      padId,
      stepIndex,
      startY: event.clientY,
      startVelocity: pattern.rows[padId]?.[stepIndex] ?? 0,
      startMicro: meta?.microtiming ?? 0,
      startProb: meta?.probability ?? 1,
      editKind,
      moved: false,
    };
  };

  const moveStepInteraction = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "select") {
      // Geometric hit-testing for virtualized rows (no DOM dependency)
      const el = (document.elementFromPoint(event.clientX, event.clientY)?.closest(".step") ??
        null) as HTMLElement | null;
      const padId = el?.dataset.pad;
      const stepIndex = Number(el?.dataset.step ?? NaN);
      if (padId && Number.isFinite(stepIndex)) {
        onSelectSteps(selectionFromDrag(drag.padId, drag.stepIndex, padId, stepIndex));
      }
      return;
    }
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 5) return;
    drag.moved = true;
    if (drag.editKind === "microtiming") {
      const microtiming = clamp(drag.startMicro + delta / 60, -1, 1);
      setDragPreview({
        padId: drag.padId,
        stepIndex: drag.stepIndex,
        velocity: drag.startVelocity,
        microtiming,
        kind: "microtiming",
      });
    } else if (drag.editKind === "probability") {
      const probability = clamp(drag.startProb + delta / 120, 0, 1);
      setDragPreview({
        padId: drag.padId,
        stepIndex: drag.stepIndex,
        velocity: drag.startVelocity,
        probability,
        kind: "probability",
      });
    } else {
      const velocity = clamp(drag.startVelocity + delta / 120, 0.05, 1);
      setDragPreview({ padId: drag.padId, stepIndex: drag.stepIndex, velocity, kind: "velocity" });
    }
  };

  const endStepInteraction = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === "select") {
      setDragPreview(null);
      return;
    }
    if (drag.moved) {
      const preview = dragPreview;
      if (drag.editKind === "microtiming") {
        const microtiming =
          preview &&
          preview.padId === drag.padId &&
          preview.stepIndex === drag.stepIndex &&
          preview.microtiming !== undefined
            ? preview.microtiming
            : drag.startMicro;
        if (microtiming !== drag.startMicro) {
          if (selectionContains(drag.padId, drag.stepIndex) && stepSelection) {
            let nextDoc = doc;
            for (const pid of stepSelection.padIds)
              for (let s = stepSelection.from; s <= stepSelection.to; s++)
                nextDoc = setStepMeta(nextDoc, pattern.id, pid, s, { microtiming }).execute(nextDoc);
            services.store.execute({
              type: "bulkMicrotiming",
              label: "Set microtiming",
              execute: () => nextDoc,
              undo: () => doc,
            } as any);
          } else {
            services.store.execute(setStepMeta(doc, pattern.id, drag.padId, drag.stepIndex, { microtiming }));
          }
        }
      } else if (drag.editKind === "probability") {
        const probability =
          preview &&
          preview.padId === drag.padId &&
          preview.stepIndex === drag.stepIndex &&
          preview.probability !== undefined
            ? preview.probability
            : drag.startProb;
        if (probability !== drag.startProb) {
          if (selectionContains(drag.padId, drag.stepIndex) && stepSelection) {
            let nextDoc = doc;
            for (const pid of stepSelection.padIds)
              for (let s = stepSelection.from; s <= stepSelection.to; s++)
                nextDoc = setStepMeta(nextDoc, pattern.id, pid, s, { probability }).execute(nextDoc);
            services.store.execute({
              type: "bulkProbability",
              label: "Set probability",
              execute: () => nextDoc,
              undo: () => doc,
            } as any);
          } else {
            services.store.execute(setStepMeta(doc, pattern.id, drag.padId, drag.stepIndex, { probability }));
          }
        }
      } else {
        const velocity =
          preview && preview.padId === drag.padId && preview.stepIndex === drag.stepIndex
            ? preview.velocity
            : drag.startVelocity;
        const delta = velocity - drag.startVelocity;
        if (selectionContains(drag.padId, drag.stepIndex) && stepSelection && Math.abs(delta) > 1e-6) {
          const span = stepSelection.to - stepSelection.from;
          const entries: { padId: string; stepIndex: number; velocity: number }[] = [];
          for (const pad of stepSelection.padIds) {
            const row = pattern.rows[pad] ?? [];
            for (let i = stepSelection.from; i <= stepSelection.to && i < row.length; i++) {
              if (row[i] <= 0) continue;
              const progress = span > 0 ? (i - stepSelection.from) / span : 0;
              const ramped = clamp(drag.startVelocity + delta * progress, 0.05, 1);
              entries.push({ padId: pad, stepIndex: i, velocity: ramped });
            }
          }
          if (entries.length > 0) services.store.execute(setStepsVelocity(doc, pattern.id, entries));
        } else if (velocity !== drag.startVelocity) {
          services.store.execute(setStepVelocityCommand(doc, drag.padId, drag.stepIndex, velocity));
        }
      }
    } else {
      services.store.execute(toggleStep(doc, drag.padId, drag.stepIndex));
      onSelectSteps(null);
    }
    setDragPreview(null);
  };

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Observe container resize. React 18 ignores ref-callback cleanup returns,
  // so the observer must be tracked manually and disconnected on re-attach
  // and unmount — otherwise every re-render leaks a live ResizeObserver.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportHeight(entry.contentRect.height);
    });
    ro.observe(node);
    resizeObserverRef.current = ro;
  }, []);
  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);
  const attachScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      containerRef(node);
    },
    [containerRef],
  );

  return (
    <section className="sequencer" aria-label="Step Sequencer" onPointerLeave={() => publishCursor(null)}>
      {stepEditor && (
        <StepEditor
          padId={stepEditor.padId}
          stepIndex={stepEditor.stepIndex}
          stepSelection={stepSelection}
          onClose={() => setStepEditor(null)}
        />
      )}
      {stepSelection && (
        <div className="step-selection-toolbar" role="group" aria-label="Selection p-lock tools">
          <span className="step-selection-label">
            {stepSelection.padIds.length}×{stepSelection.to - stepSelection.from + 1} STEPS
          </span>
          <button
            type="button"
            className="btn btn-small"
            title="Copy p-locks from the anchor step (first selected with locks, or editor step)"
            onClick={() => {
              let sourceLocks: Partial<Record<import("../project-model/types").StepLockKey, number>> | null = null;
              if (stepEditor) {
                sourceLocks = pattern.stepMeta?.[stepEditor.padId]?.[stepEditor.stepIndex]?.locks ?? null;
              }
              if (!sourceLocks) {
                for (const pid of stepSelection.padIds) {
                  for (let s = stepSelection.from; s <= stepSelection.to; s++) {
                    const l = pattern.stepMeta?.[pid]?.[s]?.locks;
                    if (l && Object.keys(l).length > 0) {
                      sourceLocks = l;
                      break;
                    }
                  }
                  if (sourceLocks) break;
                }
              }
              if (sourceLocks) setLockClipboard({ ...sourceLocks });
            }}
          >
            COPY LOCKS
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!lockClipboard || Object.keys(lockClipboard).length === 0}
            title={lockClipboard ? `Paste ${Object.keys(lockClipboard).join(", ")}` : "No locks copied"}
            onClick={() => {
              if (!lockClipboard) return;
              services.store.execute(
                pasteStepLocks(
                  doc,
                  pattern.id,
                  stepSelection.padIds,
                  stepSelection.from,
                  stepSelection.to,
                  lockClipboard,
                ),
              );
            }}
          >
            PASTE LOCKS
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Clear all p-locks in selection"
            onClick={() =>
              services.store.execute(
                clearStepLocks(doc, pattern.id, stepSelection.padIds, stepSelection.from, stepSelection.to),
              )
            }
          >
            CLEAR LOCKS
          </button>
          <button type="button" className="btn btn-small" onClick={() => onSelectSteps(null)}>
            ✕ CLEAR SEL
          </button>
        </div>
      )}
      <div
        className="sequencer-ruler"
        style={{ gridTemplateColumns: `168px repeat(${pattern.stepCount}, minmax(${STEP_MIN_PX}px, 1fr))` }}
        role="row"
        aria-label="Step ruler"
      >
        <span className="row-label-spacer" />
        {Array.from({ length: pattern.stepCount }, (_, i) => (
          <span
            key={i}
            className={`ruler-tick${playheadStep === i ? " current" : ""}${i % 4 === 0 ? " beat-start" : ""}`}
            aria-label={`Step ${i + 1}${i % 4 === 0 ? `, beat ${i / 4 + 1}` : ""}`}
          >
            {i % 4 === 0 ? i / 4 + 1 : "·"}
          </span>
        ))}
      </div>
      <div
        ref={attachScrollRef}
        className="sequencer-scroll"
        onScroll={handleScroll}
        style={{ overflowY: "auto", maxHeight: "600px", position: "relative" }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          {visibleItems.map(({ item, top, height }) => (
            <div
              key={`${item.type}-${item.trackIndex}-${item.type === "padRow" ? (item as PadRowItem).padIndex : ""}`}
              style={{ position: "absolute", top, left: 0, right: 0, height }}
            >
              <VirtualRow
                item={item}
                pattern={pattern}
                playheadStep={playheadStep}
                selectedPadId={selectedPadId}
                selectedTrackId={selectedTrackId}
                dragPreview={dragPreview}
                stepSelection={stepSelection}
                selectedNote={selectedNote}
                scaleSnap={scaleSnap}
                onSelectTrack={onSelectTrack}
                onSelectPad={onSelectPad}
                onSelectNote={onSelectNote}
                beginStepInteraction={beginStepInteraction}
                moveStepInteraction={moveStepInteraction}
                endStepInteraction={endStepInteraction}
                setStepEditor={setStepEditor}
                remoteCursors={remoteCursors}
                pianoFullTrack={pianoFullTrack}
                onTogglePianoFull={setPianoFullTrack}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function VirtualRow({
  item,
  pattern,
  playheadStep,
  selectedPadId,
  selectedTrackId,
  dragPreview,
  stepSelection,
  selectedNote,
  scaleSnap,
  onSelectTrack,
  onSelectPad,
  onSelectNote,
  beginStepInteraction,
  moveStepInteraction,
  endStepInteraction,
  setStepEditor,
  remoteCursors,
  pianoFullTrack,
  onTogglePianoFull,
}: {
  item: FlatItem;
  pattern: import("../project-model/types").Pattern;
  playheadStep: number;
  selectedPadId: string;
  selectedTrackId: string;
  dragPreview: {
    padId: string;
    stepIndex: number;
    velocity: number;
    microtiming?: number;
    probability?: number;
    kind?: DragState["editKind"];
  } | null;
  stepSelection: StepSelection | null;
  selectedNote: SelectedNote | null;
  scaleSnap: boolean;
  onSelectTrack: (trackId: string) => void;
  onSelectPad: (padId: string) => void;
  onSelectNote: (selection: SelectedNote | null) => void;
  beginStepInteraction: (event: React.PointerEvent, padId: string, stepIndex: number) => void;
  moveStepInteraction: (event: React.PointerEvent) => void;
  endStepInteraction: () => void;
  setStepEditor: (v: { padId: string; stepIndex: number } | null) => void;
  remoteCursors: RemoteCursor[];
  pianoFullTrack: string | null;
  onTogglePianoFull: (trackId: string | null) => void;
}) {
  if (item.type === "header") {
    const track = item.track;
    const trackHasHit =
      playheadStep >= 0 &&
      track.kind === "drum" &&
      track.pads.some((p) => (pattern.rows[p.id]?.[playheadStep] ?? 0) > 0);
    return (
      <TrackHeaderRow
        track={track}
        isSelected={track.id === selectedTrackId}
        isPlaying={trackHasHit}
        onSelect={() => onSelectTrack(track.id)}
      />
    );
  }

  if (item.type === "padRow") {
    return (
      <PadRow
        pad={item.pad}
        trackId={item.trackId}
        pattern={pattern}
        playheadStep={playheadStep}
        selected={item.pad.id === selectedPadId}
        dragPreview={dragPreview}
        stepSelection={stepSelection}
        onBegin={beginStepInteraction}
        onMove={moveStepInteraction}
        onEnd={endStepInteraction}
        onSelectPad={onSelectPad}
        onEditStep={(stepIndex) => setStepEditor({ padId: item.pad.id, stepIndex })}
        remoteCursors={remoteCursors}
      />
    );
  }

  if (item.type === "pianoRoll" && item.track.kind === "instrument") {
    return (
      <PianoRollTrack
        track={item.track}
        pattern={pattern}
        playheadStep={playheadStep}
        selectedNote={selectedNote}
        onSelectNote={onSelectNote}
        scaleSnap={scaleSnap}
        fullscreen={pianoFullTrack === item.track.id}
        onToggleFullscreen={() => onTogglePianoFull(pianoFullTrack === item.track.id ? null : item.track.id)}
      />
    );
  }

  return null;
}

/** Inline editor for per-step performance: probability, ratchet, microtiming + p-locks. */
function StepEditor({
  padId,
  stepIndex,
  onClose,
  stepSelection,
}: {
  padId: string;
  stepIndex: number;
  onClose: () => void;
  stepSelection: StepSelection | null;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  const meta: StepMeta = pattern.stepMeta?.[padId]?.[stepIndex] ?? {};
  const pad = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads)
    .find((p) => p.id === padId);
  const isInSelection =
    stepSelection !== null &&
    stepSelection.padIds.includes(padId) &&
    stepIndex >= stepSelection.from &&
    stepIndex <= stepSelection.to;

  const set = (change: StepMeta) => {
    if (isInSelection && stepSelection) {
      // Bulk: apply the same change to every selected cell's meta (conservative: apply via setStepMeta per cell)
      let nextDoc = doc;
      for (const pid of stepSelection.padIds) {
        for (let s = stepSelection.from; s <= stepSelection.to; s++) {
          nextDoc = setStepMeta(nextDoc, pattern.id, pid, s, change).execute(nextDoc);
        }
      }
      services.store.execute({
        type: "bulkStepMeta",
        label: "Bulk edit steps",
        execute: () => nextDoc,
        undo: () => doc,
      } as any);
    } else {
      services.store.execute(setStepMeta(doc, pattern.id, padId, stepIndex, change));
    }
  };
  const setLock = (key: "pitch" | "gain" | "pan" | "cutoff" | "sampleStart" | "length", value: number | undefined) => {
    if (isInSelection && stepSelection) {
      services.store.execute(
        setStepsLocks(doc, pattern.id, stepSelection.padIds, stepSelection.from, stepSelection.to, {
          [key]: value,
        } as any),
      );
    } else {
      services.store.execute(setStepLocks(doc, pattern.id, padId, stepIndex, { [key]: value } as any));
    }
  };
  const hasLocks = meta.locks && Object.keys(meta.locks).length > 0;

  return (
    <div className="step-editor" role="group" aria-label="Step performance editor">
      <span className="step-editor-title">
        STEP {stepIndex + 1} · {pad?.name ?? "?"}
        {isInSelection && stepSelection
          ? ` · +${stepSelection.padIds.length * (stepSelection.to - stepSelection.from + 1) - 1} SELECTED`
          : ""}
      </span>
      <button
        type="button"
        className="step-editor-close btn btn-small"
        onClick={onClose}
        title="Close step editor"
        aria-label="Close step editor"
      >
        ×
      </button>
      <div className="step-editor-field">
        <Slider
          compact
          label="PROB"
          value={meta.probability ?? 1}
          min={0}
          max={1}
          defaultValue={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(probability) => set({ probability })}
        />
      </div>
      <label className="step-editor-field">
        <span className="slider-label">RATCHET</span>
        <select
          value={meta.ratchet ?? 1}
          onChange={(event) => set({ ratchet: Number(event.target.value) })}
          aria-label="Ratchet count"
        >
          {[1, 2, 3, 4, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n}×
            </option>
          ))}
        </select>
      </label>
      <DragNumber
        label="MICRO"
        value={meta.microtiming ?? 0}
        min={-1}
        max={1}
        defaultValue={0}
        sensitivity={0.01}
        format={(v) =>
          Math.abs(v) < 0.02 ? "0" : v < 0 ? `${Math.round(v * 100)} EARLY` : `+${Math.round(v * 100)} LATE`
        }
        onCommit={(microtiming) => set({ microtiming })}
      />
      <div className="step-editor-locks" role="group" aria-label="Parameter locks">
        <span className="slider-label">
          P-LOCKS {hasLocks ? "●" : ""} {isInSelection ? "(BULK)" : ""}
        </span>
        <div className="step-editor-lock-row">
          <DragNumber
            label="PITCH"
            value={meta.locks?.pitch ?? pad?.pitch ?? 0}
            min={-24}
            max={24}
            defaultValue={pad?.pitch ?? 0}
            sensitivity={0.1}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st${meta.locks?.pitch === undefined ? " · —" : ""}`}
            onCommit={(pitch) => setLock("pitch", pitch)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.pitch !== undefined ? "Clear pitch lock" : "No pitch lock"}
            disabled={meta.locks?.pitch === undefined}
            onClick={() => setLock("pitch", undefined)}
          >
            ✕
          </button>
        </div>
        <div className="step-editor-lock-row">
          <DragNumber
            label="GAIN"
            value={meta.locks?.gain ?? pad?.gain ?? 1}
            min={0}
            max={2}
            defaultValue={pad?.gain ?? 1}
            sensitivity={0.02}
            format={(v) =>
              `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB${meta.locks?.gain === undefined ? " · —" : ""}`
            }
            onCommit={(gain) => setLock("gain", gain)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.gain !== undefined ? "Clear gain lock" : "No gain lock"}
            disabled={meta.locks?.gain === undefined}
            onClick={() => setLock("gain", undefined)}
          >
            ✕
          </button>
        </div>
        <div className="step-editor-lock-row">
          <DragNumber
            label="PAN"
            value={meta.locks?.pan ?? pad?.pan ?? 0}
            min={-1}
            max={1}
            defaultValue={pad?.pan ?? 0}
            sensitivity={0.02}
            format={(v) =>
              `${Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`}${meta.locks?.pan === undefined ? " · —" : ""}`
            }
            onCommit={(pan) => setLock("pan", pan)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.pan !== undefined ? "Clear pan lock" : "No pan lock"}
            disabled={meta.locks?.pan === undefined}
            onClick={() => setLock("pan", undefined)}
          >
            ✕
          </button>
        </div>
        <div className="step-editor-lock-row">
          <DragNumber
            label="CUTOFF"
            value={meta.locks?.cutoff ?? 16000}
            min={80}
            max={16000}
            defaultValue={16000}
            sensitivity={5}
            format={(v) => `${Math.round(v)} Hz${meta.locks?.cutoff === undefined ? " · —" : ""}`}
            onCommit={(cutoff) => setLock("cutoff", cutoff)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.cutoff !== undefined ? "Clear cutoff lock" : "No cutoff lock"}
            disabled={meta.locks?.cutoff === undefined}
            onClick={() => setLock("cutoff", undefined)}
          >
            ✕
          </button>
        </div>
        <div className="step-editor-lock-row">
          <DragNumber
            label="START"
            value={meta.locks?.sampleStart ?? 0}
            min={0}
            max={1}
            defaultValue={0}
            sensitivity={0.01}
            format={(v) => `${Math.round(v * 100)}%${meta.locks?.sampleStart === undefined ? " · —" : ""}`}
            onCommit={(sampleStart) => setLock("sampleStart", sampleStart)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.sampleStart !== undefined ? "Clear start lock" : "No start lock"}
            disabled={meta.locks?.sampleStart === undefined}
            onClick={() => setLock("sampleStart", undefined)}
          >
            ✕
          </button>
        </div>
        <div className="step-editor-lock-row">
          <DragNumber
            label="LENGTH"
            value={meta.locks?.length ?? 1}
            min={0.1}
            max={2}
            defaultValue={1}
            sensitivity={0.02}
            format={(v) => `${Math.round(v * 100)}%${meta.locks?.length === undefined ? " · —" : ""}`}
            onCommit={(length) => setLock("length", length)}
          />
          <button
            type="button"
            className="btn btn-small btn-lock-clear"
            title={meta.locks?.length !== undefined ? "Clear length lock" : "No length lock"}
            disabled={meta.locks?.length === undefined}
            onClick={() => setLock("length", undefined)}
          >
            ✕
          </button>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-small"
        title="Reset step performance to defaults"
        onClick={() => {
          if (isInSelection && stepSelection) {
            services.store.execute(
              clearStepLocks(doc, pattern.id, stepSelection.padIds, stepSelection.from, stepSelection.to),
            );
          } else {
            set({ probability: 1, ratchet: 1, microtiming: 0, locks: undefined } as StepMeta);
            if (hasLocks) for (const k of Object.keys(meta.locks!)) setLock(k as any, undefined);
          }
        }}
      >
        RESET
      </button>
    </div>
  );
}

function TrackHeaderRow({
  track,
  isSelected,
  isPlaying,
  onSelect,
}: {
  track: Track;
  isSelected: boolean;
  isPlaying: boolean;
  onSelect: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  return (
    <div className={`track-header-row${isSelected ? " selected" : ""}${isPlaying ? " playing" : ""}`}>
      <div className="track-header">
        <button
          type="button"
          className="track-header-name"
          title={`${track.name} — select track`}
          aria-label={`${track.name} track${track.mute ? " (muted)" : ""}${track.solo ? " (soloed)" : ""}`}
          aria-pressed={isSelected}
          onClick={onSelect}
        >
          {track.color && <span className="track-color-dot" style={{ background: track.color }} aria-hidden="true" />}
          <span className="track-header-badge">{trackBadge(track)}</span>
          {track.name}
        </button>
        <button
          type="button"
          className={`row-toggle${track.mute ? " active-mute" : ""}`}
          title="Mute track"
          aria-label={`Mute ${track.name}`}
          aria-pressed={track.mute}
          onClick={() => services.store.execute(setTrackParams(doc, track.id, { mute: !track.mute }))}
        >
          M
        </button>
        <button
          type="button"
          className={`row-toggle${track.solo ? " active-solo" : ""}`}
          title="Solo track"
          aria-label={`Solo ${track.name}`}
          aria-pressed={track.solo}
          onClick={() => services.store.execute(setTrackParams(doc, track.id, { solo: !track.solo }))}
        >
          S
        </button>
      </div>
      <div className="track-header-spacer" />
    </div>
  );
}

function PadRow({
  pad,
  trackId,
  pattern,
  playheadStep,
  selected,
  dragPreview,
  stepSelection,
  onBegin,
  onMove,
  onEnd,
  onSelectPad,
  onEditStep,
  remoteCursors,
}: {
  pad: DrumTrack["pads"][number];
  trackId: string;
  pattern: {
    id: string;
    stepCount: number;
    rows: Record<string, number[]>;
    stepMeta?: Record<string, Record<number, StepMeta>>;
  };
  playheadStep: number;
  selected: boolean;
  dragPreview: {
    padId: string;
    stepIndex: number;
    velocity: number;
    microtiming?: number;
    probability?: number;
    kind?: DragState["editKind"];
  } | null;
  stepSelection: StepSelection | null;
  onBegin: (event: React.PointerEvent, padId: string, stepIndex: number) => void;
  onMove: (event: React.PointerEvent) => void;
  onEnd: () => void;
  onSelectPad: (padId: string) => void;
  onEditStep: (stepIndex: number) => void;
  remoteCursors: RemoteCursor[];
}) {
  const services = useServices();
  const doc = useDoc();
  const row = pattern.rows[pad.id] ?? [];
  const metaRow = pattern.stepMeta?.[pad.id] ?? {};

  return (
    <div className={`sequencer-row${selected ? " selected" : ""}`}>
      <div className="row-label">
        <button
          type="button"
          className={`row-pad${selected ? " selected" : ""}`}
          style={{ "--pad-color": categoryColor(assetCategoryOf(pad)) } as React.CSSProperties}
          title={`${pad.name} — click to preview and select`}
          onClick={() => {
            onSelectPad(pad.id);
            services.engine.preview(pad, trackId);
          }}
        >
          {pad.name}
        </button>
        <button
          type="button"
          className={`row-toggle${pad.mute ? " active-mute" : ""}`}
          title="Mute pad"
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { mute: !pad.mute }))}
        >
          M
        </button>
        <button
          type="button"
          className={`row-toggle${pad.solo ? " active-solo" : ""}`}
          title="Solo pad"
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { solo: !pad.solo }))}
        >
          S
        </button>
      </div>
      <div
        className="row-steps"
        style={{ gridTemplateColumns: `repeat(${pattern.stepCount}, minmax(${STEP_MIN_PX}px, 1fr))` }}
      >
        {Array.from({ length: pattern.stepCount }, (_, stepIndex) => {
          const velocity =
            dragPreview && dragPreview.padId === pad.id && dragPreview.stepIndex === stepIndex
              ? dragPreview.velocity
              : (row[stepIndex] ?? 0);
          const active = velocity > 0;
          const meta: StepMeta | undefined = metaRow[stepIndex] as StepMeta | undefined;
          const inSelection =
            stepSelection !== null &&
            stepSelection.padIds.includes(pad.id) &&
            stepIndex >= stepSelection.from &&
            stepIndex <= stepSelection.to;
          const stepNumber = stepIndex + 1;
          const metaHints: string[] = [];
          if (meta?.probability !== undefined && meta.probability < 1)
            metaHints.push(`probability ${Math.round(meta.probability * 100)}%`);
          if (meta?.ratchet !== undefined && meta.ratchet > 1) metaHints.push(`ratchet ${meta.ratchet}×`);
          if (meta?.microtiming !== undefined && meta.microtiming !== 0)
            metaHints.push(`microtiming ${meta.microtiming < 0 ? "early" : "late"}`);
          const stepLabel = `Step ${stepNumber}${active ? `, velocity ${Math.round(velocity * 100)}%` : ", empty"}${
            metaHints.length > 0 ? ` (${metaHints.join(", ")})` : ""
          }`;
          return (
            <StepCell
              key={stepIndex}
              patternId={pattern.id}
              padId={pad.id}
              stepIndex={stepIndex}
              velocity={velocity}
              active={active}
              meta={meta}
              inSelection={inSelection}
              playhead={playheadStep === stepIndex}
              stepLabel={stepLabel}
              onBegin={onBegin}
              onMove={onMove}
              onEnd={onEnd}
              onEditStep={() => onEditStep(stepIndex)}
              remoteCursors={remoteCursors}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * One sequencer step. Owns the long-press gesture (touch equivalent of
 * right-click → step editor) — extracted into a component so the hook is
 * not called inside the render loop.
 */
function StepCell({
  patternId,
  padId,
  stepIndex,
  velocity,
  active,
  meta,
  inSelection,
  playhead,
  stepLabel,
  onBegin,
  onMove,
  onEnd,
  onEditStep,
  remoteCursors,
}: {
  patternId: string;
  padId: string;
  stepIndex: number;
  velocity: number;
  active: boolean;
  meta: StepMeta | undefined;
  inSelection: boolean;
  playhead: boolean;
  stepLabel: string;
  onBegin: (event: React.PointerEvent, padId: string, stepIndex: number) => void;
  onMove: (event: React.PointerEvent) => void;
  onEnd: (event: React.PointerEvent) => void;
  onEditStep: () => void;
  remoteCursors: RemoteCursor[];
}) {
  const services = useServices();
  const doc = useDoc();
  const longPress = useLongPress(onEditStep);
  const publishCursor = usePublishCursor();
  // Who else is pointing at this exact cell — one colored marker per user.
  const remoteHere = cursorsAt(remoteCursors, { view: "sequencer", patternId, padId, stepIndex });

  const hasLocks = meta?.locks && Object.keys(meta.locks).length > 0;
  const lockHints: string[] = [];
  if (meta?.locks?.pitch !== undefined)
    lockHints.push(`pitch ${meta.locks.pitch > 0 ? "+" : ""}${meta.locks.pitch.toFixed(1)} st`);
  if (meta?.locks?.gain !== undefined) lockHints.push(`gain ${meta.locks.gain.toFixed(2)}`);
  if (meta?.locks?.pan !== undefined) lockHints.push(`pan ${meta.locks.pan.toFixed(2)}`);
  if (meta?.locks?.cutoff !== undefined) lockHints.push(`cutoff ${Math.round(meta.locks.cutoff)} Hz`);
  if (meta?.locks?.sampleStart !== undefined) lockHints.push(`start ${Math.round(meta.locks.sampleStart * 100)}%`);
  if (meta?.locks?.length !== undefined) lockHints.push(`length ${Math.round(meta.locks.length * 100)}%`);
  if (meta?.amount !== undefined && meta.amount < 1) lockHints.push(`amount ${Math.round(meta.amount * 100)}%`);
  const fullLabel = `${stepLabel}${lockHints.length > 0 ? `, p-locks: ${lockHints.join(", ")}` : ""}`;
  const amount = meta?.amount ?? 1;
  const amountPct = Math.round(amount * 100);

  return (
    <button
      type="button"
      data-pad={padId}
      data-step={stepIndex}
      className={`step${active ? " active" : ""}${stepIndex % 4 === 0 ? " beat-start" : ""}${playhead ? " playhead" : ""}${inSelection ? " in-selection" : ""}${meta?.probability !== undefined && meta.probability < 1 ? " has-probability" : ""}${meta?.microtiming !== undefined && meta.microtiming !== 0 ? (meta.microtiming < 0 ? " micro-early" : " micro-late") : ""}${hasLocks ? " has-locks" : ""}${amount < 0.99 ? " has-amount" : ""}`}
      style={active ? ({ "--step-velocity": velocity } as React.CSSProperties) : undefined}
      title={`${fullLabel} — click to toggle, drag vertically for velocity (Alt microtiming −1..1, Ctrl/Cmd probability 0..1), shift+drag to multi-select, right-click (or long-press) for p-locks — bottom bar is amount 0..1`}
      aria-label={fullLabel}
      aria-pressed={active}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          publishCursor({ view: "sequencer", patternId, padId, stepIndex });
        }
      }}
      onPointerDown={(event) => {
        longPress.onPointerDown(event);
        onBegin(event, padId, stepIndex);
      }}
      onPointerMove={(event) => {
        onMove(event);
        longPress.onPointerMove();
      }}
      onPointerUp={(event) => {
        onEnd(event);
        longPress.onPointerUp();
      }}
      onPointerLeave={longPress.onPointerLeave}
      onPointerCancel={longPress.onPointerCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          services.store.execute(toggleStep(doc, padId, stepIndex));
        }
      }}
      onContextMenu={longPress.wrapContextMenu((event) => {
        event.preventDefault();
        onEditStep();
      })}
    >
      {meta?.ratchet !== undefined && meta.ratchet > 1 && <span className="step-badge">{meta.ratchet}×</span>}
      {remoteHere.slice(0, 3).map(({ user }) => (
        <span
          key={user.id}
          className="remote-cursor-dot"
          style={{ background: user.color, borderColor: user.color }}
          title={`${user.name} je tu`}
          aria-label={`${user.name} is pointing at this step`}
        />
      ))}
      {hasLocks && (
        <span className="step-lock-dot" aria-hidden="true">
          ●
        </span>
      )}
      <span
        className="step-amount-track"
        title={`Amount ${amountPct}% — drag horizontally to set 0..100% (ghost vs accent)`}
        onPointerDown={(e) => {
          e.stopPropagation();
          const track = e.currentTarget as HTMLElement;
          const rect = track.getBoundingClientRect();
          const compute = (clientX: number) => clamp((clientX - rect.left) / rect.width, 0, 1);
          const startAmount = amount;
          let current = compute(e.clientX);
          const onMove = (ev: PointerEvent) => {
            current = compute(ev.clientX);
            track.style.setProperty("--amount-preview", String(current));
            const fill = track.querySelector(".step-amount-fill") as HTMLElement | null;
            if (fill) fill.style.width = `${Math.round(current * 100)}%`;
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const final = current;
            if (Math.abs(final - startAmount) > 0.01) {
              const target = final >= 0.99 ? undefined : final;
              services.store.execute(
                setStepMeta(
                  doc,
                  doc.activePatternId,
                  padId,
                  stepIndex,
                  target === undefined ? ({ amount: undefined } as any) : { amount: Math.round(final * 100) / 100 },
                ),
              );
            }
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {}
        }}
        aria-hidden="true"
      >
        <span className="step-amount-fill" style={{ width: `${amountPct}%` }} />
      </span>
    </button>
  );
}
