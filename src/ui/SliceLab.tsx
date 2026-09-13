import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDoc, useServices } from "./context";
import { SampleBrowser } from "./SampleBrowser";
import { chopSampleToPads, setPadLoop, type PadSlice } from "../commands/commands";
import { gridSlicePoints, pointsToSlices, snapToGrid } from "../audio-engine/transients";
import { detectTransientsAsync } from "../audio-workers/onset-detector-client";
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

function zeroCrossSnap(data: Float32Array, sampleRate: number, seconds: number): number {
  const idx = Math.floor(seconds * sampleRate);
  const search = 256;
  let bestIdx = idx;
  let bestDist = Infinity;
  const start = Math.max(1, idx - search);
  const end = Math.min(data.length - 1, idx + search);
  for (let i = start; i < end; i++) {
    if (data[i] === 0) {
      const dist = Math.abs(i - idx);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    } else if (data[i] * data[i + 1] < 0 || data[i] * data[i + 1] === 0) {
      // Linear interpolate zero crossing between i and i+1
      const t = Math.abs(data[i]) / (Math.abs(data[i]) + Math.abs(data[i + 1]));
      const interp = i + t;
      const dist = Math.abs(interp - idx);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = Math.round(interp);
      }
    }
  }
  return bestDist === Infinity ? seconds : bestIdx / sampleRate;
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
  const [sensitivity, setSensitivity] = useState(1);
  const [snapGrid, setSnapGrid] = useState(false);
  const [hitsPoints, setHitsPoints] = useState<number[]>([]);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [zoom, setZoom] = useState({ from: 0, to: 1 });
  const [snapZC, setSnapZC] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [bpmPreview, setBpmPreview] = useState(true);
  const [playheadFrac, setPlayheadFrac] = useState<number | null>(null);
  // Slices map to pads by index (chopSampleToPads assigns drafts[i] → pads[i]).
  const selectedPad = track.pads[selectedIndex];
  const selectedSliceLooped = selectedPad?.sliceLoop === true;
  const previewStartRef = useRef<number | null>(null);
  const panRef = useRef<{ startX: number; startFrom: number; startTo: number } | null>(null);

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

  // Worker-offloaded onset detection for "hits" mode
  useEffect(() => {
    if (!buffer || mode !== "hits") {
      setHitsPoints([]);
      setHitsLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setHitsLoading(true);
    const channelData = buffer.getChannelData(0);
    void detectTransientsAsync(channelData, buffer.sampleRate, sensitivity, controller.signal).then((times) => {
      if (cancelled) return;
      setHitsPoints(times);
      setHitsLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [buffer, mode, sensitivity]);

  const basePoints = useMemo(() => {
    if (!buffer) return [];
    if (mode === "hits") {
      const raw = hitsPoints;
      const points = snapGrid ? snapToGrid(raw, doc.bpm, DIVISIONS["1/16"]) : raw;
      return withLeadingZero(points);
    }
    return gridSlicePoints(doc.bpm, DIVISIONS[mode], buffer.duration);
  }, [buffer, mode, doc.bpm, hitsPoints, snapGrid]);
  const basePointsKey = basePoints.map((point) => point.toFixed(6)).join(",");

  useEffect(() => {
    setDrafts(buffer ? makeDrafts(basePoints, buffer.duration) : []);
    setSelectedIndex(0);
    setLoopPreview(false);
    services.engine.stopPreview();
  }, [sourceId, mode, doc.bpm, buffer?.duration, basePointsKey, services.engine]);

  useEffect(() => {
    setZoom({ from: 0, to: 1 });
  }, [sourceId]);

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
    const visibleFrom = zoom.from;
    const visibleTo = zoom.to;
    const visibleDur = buffer.duration * (visibleTo - visibleFrom);
    const visibleStartSec = buffer.duration * visibleFrom;
    const visibleStartSample = Math.floor(visibleFrom * data.length);
    const visibleEndSample = Math.floor(visibleTo * data.length);
    const visibleLength = Math.max(1, visibleEndSample - visibleStartSample);
    const columns = Math.max(80, Math.floor(w / 3));
    const samplesPerColumn = Math.max(1, Math.floor(visibleLength / columns));
    let peak = 1;
    if (normalize) {
      let maxAbs = 0;
      for (let i = 0; i < data.length; i++) maxAbs = Math.max(maxAbs, Math.abs(data[i]));
      peak = Math.max(0.01, maxAbs);
    }

    context.clearRect(0, 0, w, h);
    context.fillStyle = "#111318";
    context.fillRect(0, 0, w, h);
    for (let column = 0; column < columns; column++) {
      let min = 1;
      let max = -1;
      const start = visibleStartSample + column * samplesPerColumn;
      const end = Math.min(visibleStartSample + (column + 1) * samplesPerColumn, visibleEndSample);
      for (let i = start; i < end; i++) {
        const v = data[i] / peak;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      const barHeight = Math.max(1, ((max - min) / 2) * h * 0.82);
      context.fillStyle = "#69707d";
      context.fillRect(column * (w / columns), h / 2 - barHeight / 2, Math.max(1, w / columns - 1), barHeight);
    }

    drafts.forEach((slice, index) => {
      const x = ((slice.start - visibleStartSec) / visibleDur) * w;
      const sliceW = ((slice.end - slice.start) / visibleDur) * w;
      if (index === selectedIndex && sliceW > 1) {
        context.fillStyle = "rgba(245, 158, 11, 0.12)";
        context.fillRect(Math.max(0, x), 0, Math.min(w - Math.max(0, x), sliceW), h);
      }
      if (x >= -4 && x <= w + 4) {
        context.fillStyle = index === selectedIndex ? "#f59e0b" : "#b8c0cc";
        context.fillRect(Math.max(0, x - dpr), 0, 2 * dpr, h);
      }
    });
    const last = drafts[drafts.length - 1];
    if (last) {
      const xLast = ((last.end - visibleStartSec) / visibleDur) * w;
      if (xLast >= -4 && xLast <= w + 4) {
        context.fillStyle = "#b8c0cc";
        context.fillRect(Math.max(0, xLast - dpr), 0, 2 * dpr, h);
      }
    }
    if (playheadFrac !== null && selected) {
      const playSec = selected.start + playheadFrac * (selected.end - selected.start);
      const xPlay = ((playSec - visibleStartSec) / visibleDur) * w;
      if (xPlay >= 0 && xPlay <= w) {
        context.fillStyle = "rgba(74, 222, 128, 0.9)";
        context.fillRect(Math.max(0, xPlay - dpr), 0, 2 * dpr, h);
      }
    }
  }, [buffer, drafts, selectedIndex, zoom, normalize, playheadFrac]);

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

  // Playhead animation for loop preview (DAW-style) — after selected is defined
  useEffect(() => {
    if (!loopPreview || !buffer || !selected) {
      setPlayheadFrac(null);
      previewStartRef.current = null;
      return;
    }
    previewStartRef.current = performance.now();
    let raf = 0;
    const tick = () => {
      const start = previewStartRef.current;
      if (start === null) return;
      const dur = Math.max(0.05, selected.end - selected.start);
      const elapsed = (performance.now() - start) / 1000;
      const frac = (elapsed % dur) / dur;
      setPlayheadFrac(frac);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopPreview, buffer, selected]);

  const updateBoundary = (boundaryIndex: number, rawValue: number) => {
    let snapped = rawValue;
    if (snapZC && buffer) {
      snapped = zeroCrossSnap(buffer.getChannelData(0), buffer.sampleRate, rawValue);
    }
    setDrafts((current) => {
      if (boundaryIndex <= 0 || boundaryIndex >= current.length) return current;
      const previous = current[boundaryIndex - 1];
      const nextSlice = current[boundaryIndex];
      const min = previous.start + 0.001;
      const max = nextSlice.end - 0.001;
      const value = Math.max(min, Math.min(max, Number.isFinite(snapped) ? snapped : min));
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
    const w = Math.max(1, rect.width);
    const visibleDur = buffer.duration * (zoom.to - zoom.from);
    const visibleStart = buffer.duration * zoom.from;
    // Marker hit-test in pixel space (12px tolerance)
    const markerIndex = drafts.findIndex((slice, index) => {
      if (index === 0) return false;
      const mx = ((slice.start - visibleStart) / visibleDur) * w;
      return Math.abs(mx - x) <= 12;
    });
    if (markerIndex > 0) {
      dragBoundaryRef.current = markerIndex;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom has no pointer capture */
      }
      return;
    }
    // Check if clicking on a slice to select
    const absSec = visibleStart + (x / w) * visibleDur;
    const index = drafts.findIndex((slice) => absSec >= slice.start && absSec < slice.end);
    if (index >= 0) {
      setSelectedIndex(index);
      // If zoomed, also allow pan on drag — delay pan decision to move
      panRef.current = { startX: event.clientX, startFrom: zoom.from, startTo: zoom.to };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* no capture */
      }
      return;
    }
    // Click on empty area when zoomed → start pan
    if (zoom.to - zoom.from < 0.99) {
      panRef.current = { startX: event.clientX, startFrom: zoom.from, startTo: zoom.to };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* no capture */
      }
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const boundaryIndex = dragBoundaryRef.current;
    if (boundaryIndex !== null && buffer) {
      const rect = event.currentTarget.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const visibleDur = buffer.duration * (zoom.to - zoom.from);
      const visibleStart = buffer.duration * zoom.from;
      const fracVisible = Math.max(0, Math.min(1, (event.clientX - rect.left) / w));
      const absSec = visibleStart + fracVisible * visibleDur;
      updateBoundary(boundaryIndex, absSec);
      return;
    }
    if (panRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const dx = panRef.current.startX - event.clientX;
      const deltaFrac = (dx / w) * (panRef.current.startTo - panRef.current.startFrom);
      const width = panRef.current.startTo - panRef.current.startFrom;
      let newFrom = panRef.current.startFrom + deltaFrac;
      let newTo = panRef.current.startTo + deltaFrac;
      if (newFrom < 0) {
        newTo -= newFrom;
        newFrom = 0;
      }
      if (newTo > 1) {
        newFrom -= newTo - 1;
        newTo = 1;
      }
      newFrom = Math.max(0, Math.min(1 - width, newFrom));
      newTo = newFrom + width;
      setZoom({ from: newFrom, to: newTo });
    }
  };

  const finishPointer = () => {
    dragBoundaryRef.current = null;
    panRef.current = null;
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!buffer) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = Math.max(1, rect.width);
    const fracVisible = x / w;
    const visibleStart = buffer.duration * zoom.from;
    const visibleDur = buffer.duration * (zoom.to - zoom.from);
    const anchorSec = visibleStart + fracVisible * visibleDur;
    const anchorFrac = anchorSec / buffer.duration;
    const factor = event.deltaY < 0 ? 0.9 : 1.1;
    const width = zoom.to - zoom.from;
    const newWidth = Math.max(0.05, Math.min(1, width * factor));
    let newFrom = anchorFrac - fracVisible * newWidth;
    let newTo = newFrom + newWidth;
    if (newFrom < 0) {
      newTo -= newFrom;
      newFrom = 0;
    }
    if (newTo > 1) {
      newFrom -= newTo - 1;
      newTo = 1;
    }
    setZoom({ from: newFrom, to: newTo });
  };

  const preview = (loop: boolean) => {
    if (!previewPad || !selected) return;
    let padToPreview: DrumPad = previewPad;
    if (bpmPreview && mode !== "hits") {
      const divisions = DIVISIONS[mode as Exclude<ChopMode, "hits">];
      if (divisions) {
        const stepDur = 60 / doc.bpm / divisions;
        const sliceDur = selected.end - selected.start;
        if (sliceDur > 0.02 && stepDur > 0.01) {
          const pitchShift = 12 * Math.log2(stepDur / sliceDur);
          const clampedShift = Math.max(-24, Math.min(24, pitchShift));
          padToPreview = { ...padToPreview, pitch: clampedShift };
        }
      }
    }
    if (normalize && buffer) {
      const data = buffer.getChannelData(0);
      let peak = 0.01;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      const gainBoost = Math.min(4, 1 / peak);
      padToPreview = { ...padToPreview, gain: (padToPreview.gain ?? 1) * gainBoost };
    }
    setLoopPreview(loop);
    services.engine.previewSlice(padToPreview, loop);
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
                  onWheel={handleWheel}
                  aria-label="Sample waveform with slice markers"
                  title="Drag to pan when zoomed, wheel to zoom, double-click to fit"
                  onDoubleClick={() => setZoom({ from: 0, to: 1 })}
                />

                <div className="slice-dialog-zoom-row" role="group" aria-label="Zoom and tools">
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Fit to view (double-click waveform)"
                    onClick={() => setZoom({ from: 0, to: 1 })}
                  >
                    FIT
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Zoom in"
                    onClick={() => {
                      const w = zoom.to - zoom.from;
                      const nw = Math.max(0.05, w * 0.7);
                      const c = (zoom.from + zoom.to) / 2;
                      setZoom({ from: Math.max(0, c - nw / 2), to: Math.min(1, c + nw / 2) });
                    }}
                  >
                    ZOOM IN
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Zoom out"
                    onClick={() => {
                      const w = zoom.to - zoom.from;
                      const nw = Math.min(1, w * 1.4);
                      const c = (zoom.from + zoom.to) / 2;
                      setZoom({ from: Math.max(0, c - nw / 2), to: Math.min(1, c + nw / 2) });
                    }}
                  >
                    ZOOM OUT
                  </button>
                  <span className="slice-zoom-hint">drag waveform to pan · wheel to zoom · double-click FIT</span>
                  <label className="slice-check">
                    <input type="checkbox" checked={snapZC} onChange={(e) => setSnapZC(e.target.checked)} /> SNAP ZC
                  </label>
                  <label className="slice-check">
                    <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> NORM
                  </label>
                  <label className="slice-check">
                    <input type="checkbox" checked={bpmPreview} onChange={(e) => setBpmPreview(e.target.checked)} /> BPM
                    PREVIEW
                  </label>
                </div>

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

                {mode === "hits" && (
                  <div className="slice-dialog-hits-controls">
                    <label className="slice-hits-sensitivity">
                      <span>SENS {sensitivity.toFixed(1)}</span>
                      <input
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={sensitivity}
                        onChange={(e) => setSensitivity(Number(e.target.value))}
                      />
                    </label>
                    <label className="slice-check">
                      <input type="checkbox" checked={snapGrid} onChange={(e) => setSnapGrid(e.target.checked)} /> SNAP
                      TO GRID (1/16)
                    </label>
                    <span className="slice-hits-status">
                      {hitsLoading ? "Detecting…" : `${hitsPoints.length} hits`}
                    </span>
                  </div>
                )}

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
                  {selected && (
                    <>
                      <button
                        type="button"
                        className={`btn btn-small${selectedSliceLooped ? " active" : ""}`}
                        aria-pressed={selectedSliceLooped}
                        title="Loop this slice region while the pad rings — choke it with a pad in the same choke group"
                        onClick={() =>
                                                    services.store.execute(
                            setPadLoop(
                              doc,
                              track.id,
                              track.pads[selectedIndex].id,
                              true,
                              selected.start,
                              selected.end,
                            ),
                          )
                        }
                      >
                        LOOP SEL
                      </button>
                      {selectedSliceLooped && (
                        <button
                          type="button"
                          className="btn btn-small"
                          title="Turn the pad loop off"
                          onClick={() => services.store.execute(setPadLoop(doc, track.id, track.pads[selectedIndex].id, false))}
                        >
                          LOOP OFF
                        </button>
                      )}
                    </>
                  )}
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
