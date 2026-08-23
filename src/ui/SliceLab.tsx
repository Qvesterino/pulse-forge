import { useEffect, useMemo, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import { DropZone } from "./DropZone";
import { sliceToPads } from "../commands/commands";
import { detectTransients, gridSlicePoints, pointsToSlices } from "../audio-engine/transients";
import type { DrumTrack } from "../project-model/types";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";

type ChopMode = "1/4" | "1/8" | "1/16" | "1/32" | "hits";

const DIVISIONS: Record<Exclude<ChopMode, "hits">, number> = { "1/4": 1, "1/8": 2, "1/16": 4, "1/32": 8 };

/**
 * SliceLab — chop beats onto pads, MPC-style.
 *
 * Drop or pick a loop, see the waveform with live slice markers, choose a
 * grid division (locked to project BPM) or transient "hits" detection, then
 * CHOP: each slice lands on a pad as a [start, end) region of the source —
 * no buffer copies, survives reloads, undoable as one gesture.
 */
export function SliceLab({ track, onClose }: { track: DrumTrack; onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();
  const [sources, setSources] = useState<UserSampleAsset[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [mode, setMode] = useState<ChopMode>("1/16");
  const [status, setStatus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    void services.userSamples.list().then((all) => {
      const recent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
      setSources(recent);
      if (recent.length > 0 && !sourceId) setSourceId(recent[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the selected source's audio from the bank (already restored or
  // freshly imported).
  useEffect(() => {
    setBuffer(sourceId ? (services.bank.get(sourceId) ?? null) : null);
  }, [sourceId, services.bank]);

  const slicePoints = useMemo<number[]>(() => {
    if (!buffer) return [];
    if (mode === "hits") {
      const mono = buffer.getChannelData(0);
      return detectTransients(mono, buffer.sampleRate, { sensitivity: 1 });
    }
    return gridSlicePoints(doc.bpm, DIVISIONS[mode], buffer.duration);
  }, [buffer, mode, doc.bpm]);

  const slices = useMemo(() => pointsToSlices(slicePoints, buffer?.duration ?? 0), [slicePoints, buffer]);

  // ── waveform + markers ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = canvas.offsetWidth * dpr);
    const h = (canvas.height = canvas.offsetHeight * dpr);
    const data = buffer.getChannelData(0);
    const columns = Math.max(60, Math.floor(w / 3));
    const per = Math.floor(data.length / columns);
    ctx2d.clearRect(0, 0, w, h);
    for (let c = 0; c < columns; c++) {
      let min = 1;
      let max = -1;
      for (let i = c * per; i < (c + 1) * per && i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      const amp = Math.max(0.01, (max - min) / 2);
      const barH = amp * h * 0.92;
      ctx2d.fillStyle = "#52525b";
      ctx2d.fillRect(c * (w / columns) + 1, h / 2 - barH / 2, Math.max(1.5, w / columns - 2), barH);
    }
    ctx2d.fillStyle = "#f59e0b";
    for (const point of slicePoints) {
      const x = (point / buffer.duration) * w;
      ctx2d.fillRect(x - dpr, 0, 2 * dpr, h);
    }
  }, [buffer, slicePoints]);

  const previewSlice = (index: number) => {
    const slice = slices[index];
    const pad = track.pads[index];
    if (!slice || !pad || !sourceId) return;
    services.engine.preview(
      { ...pad, assetId: sourceId, sliceStart: slice.start, sliceEnd: slice.end },
      track.id,
    );
  };

  const chop = () => {
    if (!sourceId || slices.length === 0) return;
    const fit = slices.slice(0, track.pads.length);
    if (slices.length > track.pads.length) {
      setStatus(`Chopped first ${track.pads.length} of ${slices.length} slices`);
    } else {
      setStatus(null);
    }
    const source = sources.find((s) => s.id === sourceId);
    services.store.execute(sliceToPads(doc, track.id, sourceId, fit, source?.name ?? "Chop"));
  };

  return (
    <section className="slice-lab" aria-label="Slice lab">
      <div className="slice-lab-head">
        <h3 className="inspector-subtitle">SLICE LAB</h3>
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close slice lab">
          ×
        </button>
      </div>

      <DropZone onImport={(asset) => setSourceId(asset.id)} className="slice-drop" />

      {sources.length > 0 && (
        <label className="collab-field">
          <span>SOURCE</span>
          <select value={sourceId ?? ""} onChange={(e) => setSourceId(e.target.value || null)}>
            <option value="">— pick a sample —</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {buffer ? (
        <>
          <div className="slice-wave" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const fraction = (e.clientX - rect.left) / rect.width;
            const index = slices.findIndex((s) => fraction * buffer.duration >= s.start && fraction * buffer.duration < s.end);
            previewSlice(index);
          }}>
            <canvas ref={canvasRef} className="slice-canvas" />
          </div>
          <div className="slice-info">
            {buffer.duration.toFixed(1)}s · {doc.bpm} BPM
          </div>

          <div className="slice-modes" role="group" aria-label="Chop mode">
            {(Object.keys(DIVISIONS) as Exclude<ChopMode, "hits">[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn btn-small${mode === m ? " active" : ""}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
            <button
              type="button"
              className={`btn btn-small${mode === "hits" ? " active" : ""}`}
              aria-pressed={mode === "hits"}
              title="Transient detection — slice on detected hits"
              onClick={() => setMode("hits")}
            >
              HITS
            </button>
          </div>

          <div className="slice-info">
            {slices.length} slices{slices.length > track.pads.length ? ` (pads hold ${track.pads.length})` : ""} — click the
            waveform to preview a slice
          </div>

          <button
            type="button"
            className="btn btn-export"
            disabled={slices.length === 0}
            onClick={chop}
          >
            CHOP TO PADS
          </button>
          {status && <div className="slice-info">{status}</div>}
        </>
      ) : (
        <div className="slice-info">Drop a loop (WAV/MP3/OGG/FLAC) or pick a sample to start chopping.</div>
      )}
    </section>
  );
}
