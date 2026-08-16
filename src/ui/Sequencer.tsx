import { Fragment, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack, Track } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import { setStepVelocityCommand, setPadParams, setTrackParams, toggleStep } from "../commands/commands";
import { assetCategoryOf, categoryColor } from "./kitColors";
import { PianoRollTrack } from "./PianoRoll";
import type { SelectedNote } from "./PianoRoll";
import { trackBadge } from "./TrackTabs";
import { clamp } from "../shared/ids";

interface DragState {
  padId: string;
  stepIndex: number;
  startY: number;
  startVelocity: number;
  moved: boolean;
}

export function Sequencer({
  selectedPadId,
  selectedTrackId,
  onSelectTrack,
  onSelectPad,
  selectedNote,
  onSelectNote,
}: {
  selectedPadId: string;
  selectedTrackId: string;
  onSelectTrack: (trackId: string) => void;
  onSelectPad: (padId: string) => void;
  selectedNote: SelectedNote | null;
  onSelectNote: (selection: SelectedNote | null) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const playheadStep = usePlayheadStep(services.transport, doc);
  const dragRef = useRef<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<{ padId: string; stepIndex: number; velocity: number } | null>(null);

  const beginStepInteraction = (event: React.PointerEvent, padId: string, stepIndex: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
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
    if (drag.moved) {
      const preview = dragPreview;
      const velocity = preview && preview.padId === drag.padId && preview.stepIndex === drag.stepIndex
        ? preview.velocity
        : drag.startVelocity;
      if (velocity !== drag.startVelocity) {
        services.store.execute(setStepVelocityCommand(doc, drag.padId, drag.stepIndex, velocity));
      }
    } else {
      services.store.execute(toggleStep(doc, drag.padId, drag.stepIndex));
    }
    setDragPreview(null);
  };

  return (
    <section className="sequencer" aria-label="Step Sequencer">
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
      {doc.tracks.map((track) => {
        const trackHasHit =
          playheadStep >= 0 && track.kind === "drum" && track.pads.some((p) => (pattern.rows[p.id]?.[playheadStep] ?? 0) > 0);
        return (
          <Fragment key={track.id}>
            <TrackHeaderRow
              track={track}
              isSelected={track.id === selectedTrackId}
              isPlaying={trackHasHit}
              onSelect={() => onSelectTrack(track.id)}
            />
            {track.kind === "drum" ? (
              track.pads.map((pad) => (
                <PadRow
                  key={pad.id}
                  pad={pad}
                  trackId={track.id}
                  pattern={pattern}
                  playheadStep={playheadStep}
                  selected={pad.id === selectedPadId}
                  dragPreview={dragPreview}
                  onBegin={beginStepInteraction}
                  onMove={moveStepInteraction}
                  onEnd={endStepInteraction}
                  onSelectPad={onSelectPad}
                />
              ))
            ) : (
              <PianoRollTrack
                track={track}
                pattern={pattern}
                playheadStep={playheadStep}
                selectedNote={selectedNote}
                onSelectNote={onSelectNote}
              />
            )}
          </Fragment>
        );
      })}
    </section>
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
  onBegin,
  onMove,
  onEnd,
  onSelectPad,
}: {
  pad: DrumTrack["pads"][number];
  trackId: string;
  pattern: { stepCount: number; rows: Record<string, number[]> };
  playheadStep: number;
  selected: boolean;
  dragPreview: { padId: string; stepIndex: number; velocity: number } | null;
  onBegin: (event: React.PointerEvent, padId: string, stepIndex: number) => void;
  onMove: (event: React.PointerEvent) => void;
  onEnd: () => void;
  onSelectPad: (padId: string) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const row = pattern.rows[pad.id] ?? [];

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
          const stepNumber = stepIndex + 1;
          const stepLabel = `Step ${stepNumber}${active ? `, velocity ${Math.round(velocity * 100)}%` : ", empty"}`;
          return (
            <button
              key={stepIndex}
              type="button"
              className={`step${active ? " active" : ""}${stepIndex % 4 === 0 ? " beat-start" : ""}${playheadStep === stepIndex ? " playhead" : ""}`}
              style={active ? ({ "--step-velocity": velocity } as React.CSSProperties) : undefined}
              title={`${stepLabel} — click to toggle, drag vertically to set velocity`}
              aria-label={stepLabel}
              aria-pressed={active}
              onPointerDown={(event) => onBegin(event, pad.id, stepIndex)}
              onPointerMove={onMove}
              onPointerUp={onEnd}
            />
          );
        })}
      </div>
    </div>
  );
}
