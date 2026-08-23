import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack, StepMeta, Track } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import {
  setPadParams,
  setStepMeta,
  setStepsVelocity,
  setStepVelocityCommand,
  setTrackParams,
  toggleStep,
} from "../commands/commands";
import { assetCategoryOf, categoryColor } from "./kitColors";
import { PianoRollTrack } from "./PianoRoll";
import type { SelectedNote } from "./PianoRoll";
import { trackBadge } from "./TrackTabs";
import { clamp } from "../shared/ids";
import { DragNumber, Slider } from "./controls";

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
  moved: boolean;
}

// Flat item types for virtualized rendering
interface HeaderItem { type: "header"; trackIndex: number; track: Track }
interface PadRowItem { type: "padRow"; trackIndex: number; padIndex: number; pad: DrumTrack["pads"][number]; trackId: string }
interface PianoRollItem { type: "pianoRoll"; trackIndex: number; track: Track }
type FlatItem = HeaderItem | PadRowItem | PianoRollItem;

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 38;
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
  const [dragPreview, setDragPreview] = useState<{ padId: string; stepIndex: number; velocity: number } | null>(null);
  const [stepEditor, setStepEditor] = useState<{ padId: string; stepIndex: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

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

  const selectionFromDrag = (anchorPad: string, anchorStep: number, padId: string, stepIndex: number): StepSelection => {
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
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.shiftKey) {
      dragRef.current = { mode: "select", padId, stepIndex, startY: event.clientY, startVelocity: 0, moved: true };
      onSelectSteps(selectionFromDrag(padId, stepIndex, padId, stepIndex));
      return;
    }
    dragRef.current = {
      mode: "edit",
      padId,
      stepIndex,
      startY: event.clientY,
      startVelocity: pattern.rows[padId]?.[stepIndex] ?? 0,
      moved: false,
    };
  };

  const moveStepInteraction = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "select") {
      // Geometric hit-testing for virtualized rows (no DOM dependency)
      const el = (document.elementFromPoint(event.clientX, event.clientY)?.closest(".step") ?? null) as HTMLElement | null;
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
    const velocity = clamp(drag.startVelocity + delta / 120, 0.05, 1);
    setDragPreview({ padId: drag.padId, stepIndex: drag.stepIndex, velocity });
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
      const velocity = preview && preview.padId === drag.padId && preview.stepIndex === drag.stepIndex
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
  const attachScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    containerRef(node);
  }, [containerRef]);

  return (
    <section className="sequencer" aria-label="Step Sequencer">
      {stepEditor && (
        <StepEditor
          padId={stepEditor.padId}
          stepIndex={stepEditor.stepIndex}
          onClose={() => setStepEditor(null)}
        />
      )}
      <div
        className="sequencer-ruler"
        style={{ gridTemplateColumns: `168px repeat(${pattern.stepCount}, minmax(22px, 1fr))` }}
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
            <div key={`${item.type}-${item.trackIndex}-${item.type === "padRow" ? (item as PadRowItem).padIndex : ""}`} style={{ position: "absolute", top, left: 0, right: 0, height }}>
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
}: {
  item: FlatItem;
  pattern: import("../project-model/types").Pattern;
  playheadStep: number;
  selectedPadId: string;
  selectedTrackId: string;
  dragPreview: { padId: string; stepIndex: number; velocity: number } | null;
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
}) {
  if (item.type === "header") {
    const track = item.track;
    const trackHasHit =
      playheadStep >= 0 && track.kind === "drum" && track.pads.some((p) => (pattern.rows[p.id]?.[playheadStep] ?? 0) > 0);
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
      />
    );
  }

  return null;
}

/** Inline editor for per-step performance: probability, ratchet, microtiming. */
function StepEditor({ padId, stepIndex, onClose }: { padId: string; stepIndex: number; onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId) ?? doc.patterns[0];
  const meta: StepMeta = pattern.stepMeta?.[padId]?.[stepIndex] ?? {};
  const pad = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads)
    .find((p) => p.id === padId);

  const set = (change: StepMeta) => services.store.execute(setStepMeta(doc, pattern.id, padId, stepIndex, change));

  return (
    <div className="step-editor" role="group" aria-label="Step performance editor">
      <span className="step-editor-title">
        STEP {stepIndex + 1} · {pad?.name ?? "?"}
      </span>
      <button type="button" className="step-editor-close btn btn-small" onClick={onClose} title="Close step editor">
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
        format={(v) => (Math.abs(v) < 0.02 ? "0" : v < 0 ? `${Math.round(v * 100)} EARLY` : `+${Math.round(v * 100)} LATE`)}
        onCommit={(microtiming) => set({ microtiming })}
      />
      <button
        type="button"
        className="btn btn-small"
        title="Reset step performance to defaults"
        onClick={() => set({ probability: 1, ratchet: 1, microtiming: 0 })}
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
}: {
  pad: DrumTrack["pads"][number];
  trackId: string;
  pattern: { id: string; stepCount: number; rows: Record<string, number[]>; stepMeta?: Record<string, Record<number, StepMeta>> };
  playheadStep: number;
  selected: boolean;
  dragPreview: { padId: string; stepIndex: number; velocity: number } | null;
  stepSelection: StepSelection | null;
  onBegin: (event: React.PointerEvent, padId: string, stepIndex: number) => void;
  onMove: (event: React.PointerEvent) => void;
  onEnd: () => void;
  onSelectPad: (padId: string) => void;
  onEditStep: (stepIndex: number) => void;
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
      <div className="row-steps" style={{ gridTemplateColumns: `repeat(${pattern.stepCount}, minmax(22px, 1fr))` }}>
        {Array.from({ length: pattern.stepCount }, (_, stepIndex) => {
          const velocity = dragPreview && dragPreview.padId === pad.id && dragPreview.stepIndex === stepIndex
            ? dragPreview.velocity
            : row[stepIndex] ?? 0;
          const active = velocity > 0;
          const meta = metaRow[stepIndex];
          const inSelection =
            stepSelection !== null &&
            stepSelection.padIds.includes(pad.id) &&
            stepIndex >= stepSelection.from &&
            stepIndex <= stepSelection.to;
          const stepNumber = stepIndex + 1;
          const metaHints: string[] = [];
          if (meta?.probability !== undefined && meta.probability < 1) metaHints.push(`probability ${Math.round(meta.probability * 100)}%`);
          if (meta?.ratchet !== undefined && meta.ratchet > 1) metaHints.push(`ratchet ${meta.ratchet}×`);
          if (meta?.microtiming !== undefined && meta.microtiming !== 0)
            metaHints.push(`microtiming ${meta.microtiming < 0 ? "early" : "late"}`);
          const stepLabel = `Step ${stepNumber}${active ? `, velocity ${Math.round(velocity * 100)}%` : ", empty"}${
            metaHints.length > 0 ? ` (${metaHints.join(", ")})` : ""
          }`;
          return (
            <button
              key={stepIndex}
              type="button"
              data-pad={pad.id}
              data-step={stepIndex}
              className={`step${active ? " active" : ""}${stepIndex % 4 === 0 ? " beat-start" : ""}${playheadStep === stepIndex ? " playhead" : ""}${inSelection ? " in-selection" : ""}${meta?.probability !== undefined && meta.probability < 1 ? " has-probability" : ""}${meta?.microtiming !== undefined && meta.microtiming !== 0 ? (meta.microtiming < 0 ? " micro-early" : " micro-late") : ""}`}
              style={active ? ({ "--step-velocity": velocity } as React.CSSProperties) : undefined}
              title={`${stepLabel} — click to toggle, drag vertically for velocity, shift+drag to multi-select, right-click for probability / ratchet / microtiming`}
              aria-label={stepLabel}
              aria-pressed={active}
              onPointerDown={(event) => onBegin(event, pad.id, stepIndex)}
              onPointerMove={onMove}
              onPointerUp={onEnd}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  services.store.execute(toggleStep(doc, pad.id, stepIndex));
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onEditStep(stepIndex);
              }}
            >
              {meta?.ratchet !== undefined && meta.ratchet > 1 && <span className="step-badge">{meta.ratchet}×</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
