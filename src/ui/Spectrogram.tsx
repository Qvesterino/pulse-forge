import { useEffect, useId, useRef, useState } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import {
  SpectrogramHistory,
  buildMagmaLut,
  createSpectrogramBandMap,
  dbToLutIndex,
  reduceFrameToRows,
  rowToFreq,
  type SpectrogramBandMap,
} from "../audio-engine/spectrogram";
import { PPQ } from "../project-model/types";
import type { Transport } from "../transport/Transport";

/**
 * Scrolling spectrogram ("X-ray view") for the master output. Consumes the
 * engine's dedicated post-limiter AnalyserNode — observer-only, never
 * touches the audio graph.
 *
 * Data canvas: one dB column per analysis frame (~30 Hz), blitted one pixel
 * left per frame, newest at the right edge. Overlay canvas: grid, labels
 * and the hover crosshair, redrawn every tick so interaction stays live
 * while playback is paused or frozen.
 *
 * Transport behavior: pause holds the view, stop and seek clear it (old
 * content must never read as current), loop wraps insert a dark separator
 * column. All transport reads are plain getters polled inside the shared
 * rAF loop — no engine or transport modifications.
 */
const MAGMA_LUT = buildMagmaLut();
const PULL_INTERVAL_MS = 33;

const FFT_OPTIONS = [2048, 4096, 8192] as const;
const FLOOR_OPTIONS = [-60, -75, -90] as const;

function formatFreq(freq: number): string {
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : `${Math.round(freq)}`;
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "−∞";
  return `${db <= -99.95 ? "−∞" : db.toFixed(1)}`;
}

export function Spectrogram({
  analyser,
  transport,
  id,
  bodyHeight = 140,
}: {
  analyser: AnalyserNode | null;
  transport: Transport;
  id: string;
  bodyHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [fftSize, setFftSize] = useState<number>(4096);
  const [floorDb, setFloorDb] = useState<number>(-90);
  const [frozenUi, setFrozenUi] = useState(false);
  const [, setClearSeq] = useState(0);
  const frozenRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const [backing, setBacking] = useState<{ w: number; h: number }>({ w: 600, h: 140 });
  const rafId = useId();

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      const w = Math.max(200, Math.floor(canvas.clientWidth));
      const h = Math.max(48, Math.floor(canvas.clientHeight));
      setBacking((prev) => (prev.w !== w || prev.h !== h ? { w, h } : prev));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open || !analyser) return;
    const dataCanvas = canvasRef.current;
    const overlayCanvas = overlayRef.current;
    if (!dataCanvas || !overlayCanvas) return;
    const dataCtx = dataCanvas.getContext("2d");
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!dataCtx || !overlayCtx) return;

    const w = backing.w;
    const h = backing.h;
    if (analyser.fftSize !== fftSize) analyser.fftSize = fftSize;
    const sampleRate = analyser.context.sampleRate;
    const binCount = fftSize >> 1;
    const freqData = new Float32Array(binCount);
    const rows = new Float32Array(h);
    const history = new SpectrogramHistory(h, Math.max(2, w));
    const column = new ImageData(1, h);
    const map: SpectrogramBandMap = createSpectrogramBandMap(sampleRate, fftSize, h);
    const rangeDb = -floorDb;
    const logMin = Math.log(map.minFreq);
    const logRange = Math.log(map.nyquist) - logMin;

    // Resize and manual clear rebuild this effect, so the view starts empty.
    dataCtx.clearRect(0, 0, w, h);

    let lastPull = 0;
    let intervalMs = PULL_INTERVAL_MS;
    let lastPlaying = transport.playing;
    let lastPos = transport.position;

    const paintColumn = (columnRows: Float32Array) => {
      const px = column.data;
      for (let row = 0; row < h; row++) {
        const idx = dbToLutIndex(columnRows[row], floorDb, rangeDb);
        px[row * 4] = MAGMA_LUT[idx * 3];
        px[row * 4 + 1] = MAGMA_LUT[idx * 3 + 1];
        px[row * 4 + 2] = MAGMA_LUT[idx * 3 + 2];
        px[row * 4 + 3] = 255;
      }
      // Scroll left one device pixel, then stamp the new column at the
      // right edge. drawImage from the same canvas is spec-defined.
      dataCtx.drawImage(dataCanvas, -1, 0);
      dataCtx.putImageData(column, w - 1, 0);
    };

    const pushGap = () => {
      rows.fill(-Infinity);
      history.push(rows);
      paintColumn(rows);
    };

    const registerRafTick = (t: number) => {
      // --- transport bookkeeping (read-only observation) ---
      const playing = transport.playing;
      if (playing && lastPlaying) {
        const pos = transport.position;
        if (pos < lastPos) {
          // Loop wrap or backward seek. A wrap within the loop length gets a
          // separator column; any other jump means the audio restarted —
          // clear so pre-seek content is not mistaken for the new position.
          const loopLen = transport.loopEnd - transport.loopStart;
          const isWrap = transport.loopEnabled && loopLen > 0 && lastPos - pos <= loopLen + PPQ;
          if (isWrap) pushGap();
          else history.clear();
        } else if (pos - lastPos > PPQ * 2) {
          history.clear(); // fast-forward seek
        }
        lastPos = pos;
      } else if (!playing && lastPlaying && !transport.paused) {
        history.clear(); // stop rewinds to 0
      }
      lastPlaying = playing;

      // --- analysis → history → paint (paused/frozen: hold the view) ---
      if (playing && !frozenRef.current) {
        if (t - lastPull >= PULL_INTERVAL_MS) {
          const elapsed = t - lastPull;
          intervalMs = intervalMs * 0.9 + Math.min(elapsed, 250) * 0.1;
          lastPull = t;
          // Behind schedule (stalled tab): mark the missed time as a gap
          // instead of smearing one frame across it.
          const missed = Math.min(4, Math.floor(elapsed / PULL_INTERVAL_MS) - 1);
          for (let i = 0; i < missed; i++) pushGap();
          analyser.getFloatFrequencyData(freqData);
          reduceFrameToRows(freqData, map, rows);
          history.push(rows);
          paintColumn(rows);
        }
      }

      // --- overlay: grid + labels + cursor readout (every tick) ---
      overlayCtx.clearRect(0, 0, w, h);
      overlayCtx.font = "9px monospace";
      overlayCtx.fillStyle = "rgba(255,255,255,0.4)";
      overlayCtx.strokeStyle = "rgba(255,255,255,0.07)";
      overlayCtx.lineWidth = 1;
      for (const freq of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        if (freq >= map.nyquist) continue;
        const x = Math.round(((Math.log(freq) - logMin) / logRange) * w) + 0.5;
        overlayCtx.beginPath();
        overlayCtx.moveTo(x, 0);
        overlayCtx.lineTo(x, h);
        overlayCtx.stroke();
        overlayCtx.fillText(formatFreq(freq), x + 2, h - 3);
      }
      for (let db = 0; db >= floorDb; db -= 20) {
        const y = Math.round(((0 - db) / rangeDb) * h) + 0.5;
        if (y < 8 || y > h - 2) continue;
        overlayCtx.fillStyle = "rgba(255,255,255,0.3)";
        overlayCtx.fillText(`${db}`, 2, y - 2);
        overlayCtx.fillStyle = "rgba(255,255,255,0.4)";
      }
      if (frozenRef.current) {
        overlayCtx.fillStyle = "rgba(255,255,255,0.7)";
        overlayCtx.fillText("FROZEN", w - 40, 10);
      }

      const hover = hoverRef.current;
      if (hover.inside && history.capacity > 0) {
        const x = Math.min(w - 1, Math.max(0, Math.round(hover.x)));
        const y = Math.min(h - 1, Math.max(0, Math.round(hover.y)));
        const age = w - 1 - x;
        const freq = rowToFreq(map, y);
        const db = history.at(age)[y];
        overlayCtx.strokeStyle = "rgba(255,255,255,0.35)";
        overlayCtx.beginPath();
        overlayCtx.moveTo(x + 0.5, 0);
        overlayCtx.lineTo(x + 0.5, h);
        overlayCtx.moveTo(0, y + 0.5);
        overlayCtx.lineTo(w, y + 0.5);
        overlayCtx.stroke();

        const label = `${formatFreq(freq)}Hz  ${formatDb(db)}dB  -${((age * intervalMs) / 1000).toFixed(1)}s`;
        const labelWidth = label.length * 5.5 + 8;
        const labelX = Math.min(w - labelWidth - 2, x + 6);
        const labelY = Math.min(h - 16, Math.max(2, y - 18));
        overlayCtx.fillStyle = "rgba(8,6,12,0.85)";
        overlayCtx.fillRect(labelX, labelY, labelWidth, 13);
        overlayCtx.fillStyle = "rgba(255,255,255,0.92)";
        overlayCtx.fillText(label, labelX + 4, labelY + 10);
      }
    };

    registerRaf(rafId, registerRafTick);
    return () => unregisterRaf(rafId);
    // `backing` rides along: a canvas resize changes rowCount/capacity, so
    // the history (and the view) rebuild. clearSeq: manual CLEAR.
  }, [analyser, transport, rafId, open, fftSize, floorDb, backing.w, backing.h, id]);

  const toDevice = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  return (
    <section className="spectrogram" data-open={open} aria-label="Master spectrogram">
      <div className="spectrogram-head">
        <button
          type="button"
          className="spectrogram-collapse"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title="Scrolling frequency-over-time view of the master output"
        >
          SPECTROGRAM {open ? "▾" : "▸"}
        </button>
        {open && (
          <>
            <label className="spectrogram-ctl">
              FFT
              <select
                value={fftSize}
                onChange={(e) => setFftSize(Number(e.target.value))}
                aria-label="Spectrogram FFT size"
              >
                {FFT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="spectrogram-ctl">
              RANGE
              <select
                value={floorDb}
                onChange={(e) => setFloorDb(Number(e.target.value))}
                aria-label="Spectrogram dynamic range"
              >
                {FLOOR_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} dB
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="spectrogram-ctl-btn"
              data-active={frozenUi}
              onClick={() => {
                frozenRef.current = !frozenRef.current;
                setFrozenUi(frozenRef.current);
              }}
            >
              {frozenUi ? "FROZEN" : "FREEZE"}
            </button>
            <button type="button" className="spectrogram-ctl-btn" onClick={() => setClearSeq((s) => s + 1)}>
              CLEAR
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="spectrogram-body" style={{ height: bodyHeight }}>
          <canvas
            ref={canvasRef}
            className="spectrogram-canvas"
            width={backing.w}
            height={backing.h}
            aria-label="Spectrogram"
            role="img"
          />
          <canvas
            ref={overlayRef}
            className="spectrogram-overlay"
            width={backing.w}
            height={backing.h}
            onMouseMove={(e) => {
              const pos = toDevice(e);
              if (pos) hoverRef.current = { x: pos.x, y: pos.y, inside: true };
            }}
            onMouseLeave={() => {
              hoverRef.current = { ...hoverRef.current, inside: false };
            }}
          />
        </div>
      )}
    </section>
  );
}
