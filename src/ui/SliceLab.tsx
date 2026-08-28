import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDoc, useServices } from "./context";
import { SampleBrowser } from "./SampleBrowser";
import { chopSampleToPads, type PadSlice } from "../commands/commands";
import { detectTransients, gridSlicePoints, pointsToSlices } from "../audio-engine/transients";
import type { DrumPad, DrumTrack } from "../project-model/types";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";

type ChopMode = "1/4" | "1/8" | "1/16" | "1/32" | "hits";
type DraftSlice = PadSlice & { fadeIn: number; fadeOut: number; reverse: boolean };

const DIVISIONS: Record<Exclude<ChopMode, "hits">, number> = { "1/4": 1, "1/8": 2, "1/16": 4, "1/32": 8 };

function withLeadingZero(points: number[]): number[] {
  const all = [0, ...points].filter((point, index, list) => Number.isFinite(point) && list.indexOf(point) === index);
  return all.sort((a, b) => a - b);
}

function makeDrafts(points: number[], duration: number): DraftSlice[] {
  return pointsToSlices(points, duration).map((slice) => ({
    ...slice,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
  }));
}

function sourceLabel(id: string | null, userAssets: UserSampleAsset[]): string {
  if (!id) return "Sample";
  return (
    FACTORY_ASSETS.find((asset) => asset.id === id)?.name ?? userAssets.find((asset) => asset.id === id)?.name ?? id
  );
}

/** Modal sample editor: waveform, transient/grid slicing and Drum Rack mapping. */
export function SliceLab({ track, onClose }: { track: DrumTrack; onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragBoundaryRef = useRef<number | null>(null);
  const [userAssets, setUserAssets] = useState<UserSampleAsset[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(track.pads[0]?.assetId ?? FACTORY_ASSETS[0]?.id ?? null);
  const [mode, setMode] = useState<ChopMode>("1/16");
  const [drafts, setDrafts] = useState<DraftSlice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loopPreview, setLoopPreview] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const buffer = sourceId ? (services.bank.get(sourceId) ?? null) : null;
  const sourceName = sourceLabel(sourceId, userAssets);

  useEffect(() => {
    let alive = true;
    void services.userSamples.list().then((assets) => {
      if (alive) setUserAssets(assets);
    });
    return () => {
      alive = false;
    };
  }, [services]);

  const basePoints = useMemo(() => {
    if (!buffer) return [];
    if (mode === "hits") {
      return withLeadingZero(detectTransients(buffer.getChannelData(0), buffer.sampleRate, { sensitivity: 1 }));
    }
    return gridSlicePoints(doc.bpm, DIVISIONS[mode], buffer.duration);
  }, [buffer, mode, doc.bpm]);
  const basePointsKey = basePoints.map((point) => point.toFixed(6)).join(",");

  useEffect(() => {
    setDrafts(buffer ? makeDrafts(basePoints, buffer.duration) : []);
    setSelectedIndex(0);
    setLoopPreview(false);
    services.engine.stopPreview();
  }, [sourceId, mode, doc.bpm, buffer?.duration, basePointsKey, services.engine]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer || drafts.length === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, canvas.clientWidth || canvas.offsetWidth || 720);
    const height = Math.max(120, canvas.clientHeight || canvas.offsetHeight || 180);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const w = canvas.width;
    const h = canvas.height;
    const data = buffer.getChannelData(0);
    const columns = Math.max(80, Math.floor(w / 3));
    const samplesPerColumn = Math.max(1, Math.floor(data.length / columns));

    context.clearRect(0, 0, w, h);
    context.fillStyle = "#111318";
    context.fillRect(0, 0, w, h);
    for (let column = 0; column < columns; column++) {
      let min = 1;
      let max = -1;
      const start = column * samplesPerColumn;
      const end = Math.min(data.length, start + samplesPerColumn);
      for (let i = start; i < end; i++) {
        min = Math.min(min, data[i]);
        max = Math.max(max, data[i]);
      }
      const barHeight = Math.max(1, ((max - min) / 2) * h * 0.82);
      context.fillStyle = "#69707d";
      context.fillRect(column * (w / columns), h / 2 - barHeight / 2, Math.max(1, w / columns - 1), barHeight);
    }

    drafts.forEach((slice, index) => {
      const x = (slice.start / buffer.duration) * w;
      if (index === selectedIndex) {
        context.fillStyle = "rgba(245, 158, 11, 0.12)";
        context.fillRect(x, 0, ((slice.end - slice.start) / buffer.duration) * w, h);
      }
      context.fillStyle = index === selectedIndex ? "#f59e0b" : "#b8c0cc";
      context.fillRect(Math.max(0, x - dpr), 0, 2 * dpr, h);
    });
    const last = drafts[drafts.length - 1];
    if (last) {
      context.fillStyle = "#b8c0cc";
      context.fillRect((last.end / buffer.duration) * w - dpr, 0, 2 * dpr, h);
    }
  }, [buffer, drafts, selectedIndex]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        services.engine.stopPreview();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => () => services.engine.stopPreview(), [services.engine]);

  const selected = drafts[selectedIndex];
  const previewPad = useMemo<DrumPad | null>(() => {
    if (!selected || !sourceId) return null;
    const base = track.pads[0];
    if (!base) return null;
    return {
      ...base,
      assetId: sourceId,
      sliceStart: selected.start,
      sliceEnd: selected.end,
      sliceFadeIn: selected.fadeIn,
      sliceFadeOut: selected.fadeOut,
      sliceReverse: selected.reverse,
    };
  }, [selected, sourceId, track.pads]);

  const updateBoundary = (boundaryIndex: number, rawValue: number) => {
    setDrafts((current) => {
      if (boundaryIndex <= 0 || boundaryIndex >= current.length) return current;
      const previous = current[boundaryIndex - 1];
      const nextSlice = current[boundaryIndex];
      const min = previous.start + 0.001;
      const max = nextSlice.end - 0.001;
      const value = Math.max(min, Math.min(max, Number.isFinite(rawValue) ? rawValue : min));
      const next = current.map((slice) => ({ ...slice }));
      next[boundaryIndex - 1].end = value;
      next[boundaryIndex].start = value;
      return next;
    });
  };

  const updateSelectedStart = (value: number) => updateBoundary(selectedIndex, value);

  const updateSelectedEnd = (value: number) => {
    if (!selected || !buffer) return;
    if (selectedIndex < drafts.length - 1) updateBoundary(selectedIndex + 1, value);
    else {
      setDrafts((current) =>
        current.map((slice, index) =>
          index === selectedIndex
            ? {
                ...slice,
                end: Math.max(
                  slice.start + 0.001,
                  Math.min(buffer.duration, Number.isFinite(value) ? value : slice.end),
                ),
              }
            : slice,
        ),
      );
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!buffer || drafts.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const fraction = x / Math.max(1, rect.width);
    const markerTolerance = 12 / Math.max(1, rect.width);
    const markerIndex = drafts.findIndex(
      (slice, index) => index > 0 && Math.abs(slice.start / buffer.duration - fraction) <= markerTolerance,
    );
    if (markerIndex > 0) {
      dragBoundaryRef.current = markerIndex;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom has no pointer capture */
      }
      return;
    }
    const index = drafts.findIndex(
      (slice) => fraction * buffer.duration >= slice.start && fraction * buffer.duration < slice.end,
    );
    if (index >= 0) setSelectedIndex(index);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const boundaryIndex = dragBoundaryRef.current;
    if (boundaryIndex === null || !buffer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    updateBoundary(boundaryIndex, fraction * buffer.duration);
  };

  const finishPointer = () => {
    dragBoundaryRef.current = null;
  };

  const preview = (loop: boolean) => {
    if (!previewPad) return;
    setLoopPreview(loop);
    services.engine.previewSlice(previewPad, loop);
  };

  const updateSelected = (values: Partial<DraftSlice>) => {
    setDrafts((current) => current.map((slice, index) => (index === selectedIndex ? { ...slice, ...values } : slice)));
  };

  const chop = (createPattern: boolean) => {
    if (!sourceId || drafts.length === 0) return;
    const slices = drafts.slice(0, track.pads.length);
    services.store.execute(
      chopSampleToPads(doc, {
        trackId: track.id,
        assetId: sourceId,
        sourceName,
        slices,
        createPattern,
      }),
    );
    setStatus(
      drafts.length > track.pads.length
        ? `Mapped first ${track.pads.length} of ${drafts.length} slices`
        : `${slices.length} slices mapped${createPattern ? " and pattern created" : ""}`,
    );
  };

  const close = () => {
    services.engine.stopPreview();
    onClose();
  };

  return (
    <div
      className="slice-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Sample to beat editor"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="slice-dialog" tabIndex={-1}>
        <header className="slice-dialog-header">
          <div>
            <span className="slice-dialog-kicker">SAMPLE TO BEAT</span>
            <h2>SLICE LAB</h2>
          </div>
          <button type="button" className="btn btn-small" onClick={close} aria-label="Close sample to beat editor">
            x
          </button>
        </header>

        <div className="slice-dialog-body">
          <aside className="slice-dialog-browser">
            <h3 className="inspector-subtitle">SOURCE</h3>
            <SampleBrowser
              assets={FACTORY_ASSETS}
              currentId={sourceId}
              allowNone={false}
              onSelect={(id) => {
                setSourceId(id);
                setStatus(null);
                if (id) void services.userSamples.list().then(setUserAssets);
              }}
              showDropZone
            />
          </aside>

          <section className="slice-dialog-editor">
            <div className="slice-dialog-source-meta">
              <strong>{sourceName}</strong>
              {buffer ? (
                <span>
                  {buffer.duration.toFixed(3)}s | {buffer.sampleRate} Hz | {doc.bpm} BPM
                </span>
              ) : (
                <span>SOURCE UNAVAILABLE</span>
              )}
            </div>

            {buffer && drafts.length > 0 ? (
              <>
                <canvas
                  ref={canvasRef}
                  className="slice-dialog-canvas"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishPointer}
                  onPointerCancel={finishPointer}
                  onPointerLeave={finishPointer}
                  aria-label="Sample waveform with slice markers"
                />

                <div className="slice-dialog-mode-row" role="group" aria-label="Slice mode">
                  {(Object.keys(DIVISIONS) as Exclude<ChopMode, "hits">[]).map((division) => (
                    <button
                      key={division}
                      type="button"
                      className={`btn btn-small${mode === division ? " active" : ""}`}
                      aria-pressed={mode === division}
                      onClick={() => setMode(division)}
                    >
                      {division}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`btn btn-small${mode === "hits" ? " active" : ""}`}
                    aria-pressed={mode === "hits"}
                    onClick={() => setMode("hits")}
                  >
                    HITS
                  </button>
                </div>

                <div className="slice-dialog-selection">
                  <div className="slice-dialog-selection-head">
                    <strong>
                      SLICE {selectedIndex + 1} / {drafts.length}
                    </strong>
                    <span>{selected ? `${selected.start.toFixed(3)}s - ${selected.end.toFixed(3)}s` : ""}</span>
                  </div>
                  {selected && (
                    <div className="slice-dialog-controls">
                      <label className="slice-number">
                        <span>START</span>
                        <input
                          type="number"
                          min={0}
                          max={selected.end - 0.001}
                          step={0.001}
                          value={selected.start.toFixed(3)}
                          disabled={selectedIndex === 0}
                          onChange={(event) => updateSelectedStart(Number(event.target.value))}
                        />
                      </label>
                      <label className="slice-number">
                        <span>END</span>
                        <input
                          type="number"
                          min={selected.start + 0.001}
                          max={buffer.duration}
                          step={0.001}
                          value={selected.end.toFixed(3)}
                          onChange={(event) => updateSelectedEnd(Number(event.target.value))}
                        />
                      </label>
                      <label className="slice-number">
                        <span>FADE IN</span>
                        <input
                          type="number"
                          min={0}
                          max={selected.end - selected.start}
                          step={0.001}
                          value={selected.fadeIn.toFixed(3)}
                          onChange={(event) => updateSelected({ fadeIn: Math.max(0, Number(event.target.value) || 0) })}
                        />
                      </label>
                      <label className="slice-number">
                        <span>FADE OUT</span>
                        <input
                          type="number"
                          min={0}
                          max={selected.end - selected.start}
                          step={0.001}
                          value={selected.fadeOut.toFixed(3)}
                          onChange={(event) =>
                            updateSelected({ fadeOut: Math.max(0, Number(event.target.value) || 0) })
                          }
                        />
                      </label>
                      <label className="slice-check">
                        <input
                          type="checkbox"
                          checked={selected.reverse}
                          onChange={(event) => updateSelected({ reverse: event.target.checked })}
                        />{" "}
                        REVERSE
                      </label>
                    </div>
                  )}
                </div>

                <div className="slice-dialog-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      services.engine.stopPreview();
                      setLoopPreview(false);
                    }}
                  >
                    STOP
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => preview(false)}>
                    PREVIEW
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small${loopPreview ? " active" : ""}`}
                    aria-pressed={loopPreview}
                    onClick={() =>
                      loopPreview ? (services.engine.stopPreview(), setLoopPreview(false)) : preview(true)
                    }
                  >
                    LOOP PREVIEW
                  </button>
                  <span className="slice-dialog-spacer" />
                  <button type="button" className="btn btn-small" onClick={() => chop(false)}>
                    CHOP TO PADS
                  </button>
                  <button type="button" className="btn btn-export" onClick={() => chop(true)}>
                    CHOP + PATTERN
                  </button>
                </div>
                {status && <div className="slice-dialog-status">{status}</div>}
              </>
            ) : (
              <div className="slice-dialog-empty">
                {sourceId ? "SOURCE UNAVAILABLE" : "Choose a sample to start slicing."}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
