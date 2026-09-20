import { useEffect, useId, useRef, useState } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import {
  MULTIRES_CROSS_HIGH_HZ,
  MULTIRES_CROSS_LOW_HZ,
  SPECTRO_LUT_NAMES,
  SPECTRO_MIN_FREQ,
  SpectrogramHistory,
  composeMultiResRows,
  createSpectrogramBandMap,
  dbToLutIndex,
  dominantRowAround,
  getSpectroLut,
  buildRowFreqs,
  reduceFrameToRows,
  rowToFreq,
  type SpectroLutName,
  type SpectrogramBandMap,
} from "../audio-engine/spectrogram";
import { PPQ } from "../project-model/types";
import type { Transport } from "../transport/Transport";

/**
 * Scrolling spectrogram ("X-ray view") for the master output. Consumes the
 * engine's dedicated post-limiter AnalyserNodes — observer-only, never
 * touches the audio graph.
 *
 * Data canvas: one dB column per analysis frame (~30 Hz), blitted one pixel
 * left per frame, newest at the right edge. Overlay canvas: grid, labels
 * and the hover crosshair, redrawn every tick so interaction stays live
 * while playback is paused or frozen.
 *
 * Resolution modes. SINGLE: one FFT (selectable size). MULTI: the engine's
 * three taps — long window (8192) below 250 Hz for Hz-level sub-bass
 * detail, mid window (4096) through 2 kHz, short window (1024) above for
 * transient-crisp highs — composed into one column.
 *
 * Transport behavior: pause holds the view, stop and seek clear it (old
 * content must never read as current), loop wraps insert a dark separator
 * column. All transport reads are plain getters polled inside the shared
 * rAF loop — no engine or transport modifications.
 */
const PULL_INTERVAL_MS = 33;
const ZOOM_MIN_SPAN_HZ = 80;
const FFT_OPTIONS = [2048, 4096, 8192] as const;
const FLOOR_OPTIONS = [-45, -60, -75, -90, -105, -120] as const;
const CEIL_OPTIONS = [0, -6, -12, -20] as const;
const FREQ_TICKS = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000];

interface SpectroTaps {
  low: AnalyserNode;
  mid: AnalyserNode;
  high: AnalyserNode;
}

function formatFreq(freq: number): string {
  return freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : `${Math.round(freq)}`;
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "−∞";
  return `${db <= -99.95 ? "−∞" : db.toFixed(1)}`;
}

export function Spectrogram({
  analyser,
  taps,
  transport,
  id,
  bodyHeight = 140,
}: {
  analyser: AnalyserNode | null;
  taps: SpectroTaps | null;
  transport: Transport;
  id: string;
  bodyHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [fftSize, setFftSize] = useState<number>(4096);
  const [floorDb, setFloorDb] = useState<number>(-90);
  const [ceilDb, setCeilDb] = useState<number>(0);
  const [lutIdx, setLutIdx] = useState<number>(0);
  const [multi, setMulti] = useState(false);
  /** Log-axis zoom. max === 0 means "up to Nyquist". */
  const [zoom, setZoom] = useState<{ min: number; max: number }>({ min: SPECTRO_MIN_FREQ, max: 0 });
  const [, setClearSeq] = useState(0);
  const frozenRef = useRef(false);
  const [frozenUi, setFrozenUi] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const [backing, setBacking] = useState<{ w: number; h: number }>({ w: 600, h: 140 });
  const rafId = useId();

  const lutName: SpectroLutName = SPECTRO_LUT_NAMES[lutIdx];
  const zoomed = zoom.max !== 0 || zoom.min !== SPECTRO_MIN_FREQ;
  // The parent hands us a fresh taps bag on every render (it calls the
  // engine getter inline), so the effect must depend on the stable
  // AnalyserNode identities inside it — not on the bag.
  const tapLow = taps?.low ?? null;
  const tapMid = taps?.mid ?? null;
  const tapHigh = taps?.high ?? null;

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
    const sampleRate = analyser.context.sampleRate;
    const trueNyquist = sampleRate / 2;
    const fMin = Math.max(SPECTRO_MIN_FREQ, Math.min(zoom.min, trueNyquist - ZOOM_MIN_SPAN_HZ));
    const fTop = zoom.max === 0 ? trueNyquist : Math.min(trueNyquist, Math.max(fMin + ZOOM_MIN_SPAN_HZ, zoom.max));

    // Active analysers + their window sizes. MULTI enforces the canonical
    // sizes on entry so a custom SINGLE fftSize can never leak into the
    // shared mid tap.
    const useMulti = multi && !!tapLow && !!tapMid && !!tapHigh;
    const sources: Array<{ node: AnalyserNode; fft: number }> = useMulti
      ? [
          { node: tapLow, fft: 8192 },
          { node: tapMid, fft: 4096 },
          { node: tapHigh, fft: 1024 },
        ]
      : [{ node: analyser, fft: fftSize }];
    for (const src of sources) {
      if (src.node.fftSize !== src.fft) src.node.fftSize = src.fft;
    }

    const freqDataArrs = sources.map((src) => new Float32Array(src.fft >> 1));
    const bandMaps: SpectrogramBandMap[] = sources.map((src) =>
      createSpectrogramBandMap(sampleRate, src.fft, h, fMin, fTop),
    );
    const bandRows: Float32Array<ArrayBuffer>[] = sources.map(() => new Float32Array(h));
    const rows = new Float32Array(h);
    const history = new SpectrogramHistory(h, Math.max(2, w));
    const column = new ImageData(1, h);
    const rowFreqs = buildRowFreqs(bandMaps[0]);
    const lut = getSpectroLut(lutName);
    const logMin = Math.log(fMin);
    const logRange = Math.log(fTop) - logMin;

    // Resize and manual clear rebuild this effect, so the view starts empty.
    dataCtx.clearRect(0, 0, w, h);

    let lastPull = 0;
    let intervalMs = PULL_INTERVAL_MS;
    let lastPlaying = transport.playing;
    let lastPos = transport.position;

    const paintColumn = (columnRows: Float32Array) => {
      const px = column.data;
      for (let row = 0; row < h; row++) {
        const idx = dbToLutIndex(columnRows[row], floorDb, ceilDb);
        px[row * 4] = lut[idx * 3];
        px[row * 4 + 1] = lut[idx * 3 + 1];
        px[row * 4 + 2] = lut[idx * 3 + 2];
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

    const pullAndAdvance = () => {
      for (let i = 0; i < sources.length; i++) {
        sources[i].node.getFloatFrequencyData(freqDataArrs[i]);
        reduceFrameToRows(freqDataArrs[i], bandMaps[i], bandRows[i]);
      }
      if (useMulti) {
        composeMultiResRows(bandRows[0], bandRows[1], bandRows[2], rowFreqs, MULTIRES_CROSS_LOW_HZ, MULTIRES_CROSS_HIGH_HZ, rows);
      } else {
        rows.set(bandRows[0]);
      }
      history.push(rows);
      paintColumn(rows);
    };

    const tick = (t: number) => {
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
          pullAndAdvance();
        }
      }

      // --- overlay: grid + labels + cursor readout (every tick) ---
      overlayCtx.clearRect(0, 0, w, h);
      overlayCtx.font = "9px monospace";
      overlayCtx.fillStyle = "rgba(255,255,255,0.4)";
      overlayCtx.strokeStyle = "rgba(255,255,255,0.07)";
      overlayCtx.lineWidth = 1;
      for (const freq of FREQ_TICKS) {
        if (freq < fMin || freq > fTop) continue;
        const x = Math.round(((Math.log(freq) - logMin) / logRange) * w) + 0.5;
        overlayCtx.beginPath();
        overlayCtx.moveTo(x, 0);
        overlayCtx.lineTo(x, h);
        overlayCtx.stroke();
        overlayCtx.fillText(formatFreq(freq), x + 2, h - 3);
      }
      for (let db = 0; db >= floorDb; db -= 20) {
        const y = Math.round(((ceilDb - db) / (ceilDb - floorDb)) * h) + 0.5;
        if (y < 8 || y > h - 2) continue;
        overlayCtx.fillStyle = "rgba(255,255,255,0.3)";
        overlayCtx.fillText(`${db}`, 2, y - 2);
        overlayCtx.fillStyle = "rgba(255,255,255,0.4)";
      }
      if (useMulti) {
        // Resolution boundaries — knowing which window produced a row
        // matters when reading sub-bass detail vs. transients.
        overlayCtx.strokeStyle = "rgba(120,220,255,0.16)";
        for (const cross of [MULTIRES_CROSS_LOW_HZ, MULTIRES_CROSS_HIGH_HZ]) {
          if (cross < fMin || cross > fTop) continue;
          const y = Math.round((1 - Math.log(cross / fMin) / logRange) * h) + 0.5;
          overlayCtx.beginPath();
          overlayCtx.moveTo(0, y + 0.5);
          overlayCtx.lineTo(w, y + 0.5);
          overlayCtx.stroke();
        }
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
        const col = history.at(age);
        const freq = rowFreqs[y];
        const db = col[y];
        overlayCtx.strokeStyle = "rgba(255,255,255,0.35)";
        overlayCtx.beginPath();
        overlayCtx.moveTo(x + 0.5, 0);
        overlayCtx.lineTo(x + 0.5, h);
        overlayCtx.moveTo(0, y + 0.5);
        overlayCtx.lineTo(w, y + 0.5);
        overlayCtx.stroke();

        // Dominant frequency near the cursor: the local peak row gets a
        // marker so "which partial am I on" is one glance.
        const peakRow = dominantRowAround(col, y, 4);
        let peakLabel = "";
        if (peakRow !== y && Number.isFinite(col[peakRow]) && col[peakRow] > -99) {
          peakLabel = ` ▲${formatFreq(rowToFreq(bandMaps[0], peakRow))}`;
          const py = peakRow + 0.5;
          overlayCtx.fillStyle = "rgba(255,255,255,0.85)";
          overlayCtx.beginPath();
          overlayCtx.moveTo(x + 3, py - 3);
          overlayCtx.lineTo(x + 8, py);
          overlayCtx.lineTo(x + 3, py + 3);
          overlayCtx.closePath();
          overlayCtx.fill();
        }

        const label = `${formatFreq(freq)}Hz ${formatDb(db)}dB -${((age * intervalMs) / 1000).toFixed(1)}s${peakLabel}`;
        const labelWidth = label.length * 5.5 + 8;
        const labelX = Math.min(w - labelWidth - 2, x + 6);
        const labelY = Math.min(h - 16, Math.max(2, y - 18));
        overlayCtx.fillStyle = "rgba(8,6,12,0.85)";
        overlayCtx.fillRect(labelX, labelY, labelWidth, 13);
        overlayCtx.fillStyle = "rgba(255,255,255,0.92)";
        overlayCtx.fillText(label, labelX + 4, labelY + 10);
      }
    };

    registerRaf(rafId, tick);

    // Wheel zoom around the cursor frequency (non-passive: preventDefault
    // keeps the page from scrolling while zooming the axis).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = overlayCanvas.getBoundingClientRect();
      if (rect.height === 0) return;
      const frac = 1 - (e.clientY - rect.top) / rect.height;
      const anchor = fMin * Math.exp(Math.log(fTop / fMin) * Math.min(1, Math.max(0, frac)));
      const k = e.deltaY < 0 ? 1 / 1.25 : 1.25;
      let nMin = anchor - (anchor - fMin) * k;
      let nTop = anchor + (fTop - anchor) * k;
      nMin = Math.max(SPECTRO_MIN_FREQ, nMin);
      nTop = Math.min(trueNyquist, Math.max(nTop, nMin + ZOOM_MIN_SPAN_HZ));
      if (nTop - nMin >= trueNyquist - SPECTRO_MIN_FREQ) {
        setZoom({ min: SPECTRO_MIN_FREQ, max: 0 });
      } else {
        setZoom({ min: nMin, max: nTop >= trueNyquist - 0.5 ? 0 : nTop });
      }
    };
    const onDblClick = () => setZoom({ min: SPECTRO_MIN_FREQ, max: 0 });
    overlayCanvas.addEventListener("wheel", onWheel, { passive: false });
    overlayCanvas.addEventListener("dblclick", onDblClick);
    return () => {
      unregisterRaf(rafId);
      overlayCanvas.removeEventListener("wheel", onWheel);
      overlayCanvas.removeEventListener("dblclick", onDblClick);
    };
    // `backing` rides along: a canvas resize changes rowCount/capacity, so
    // the history (and the view) rebuild. clearSeq: manual CLEAR. Zoom,
    // lut, floor/ceil and mode rebuild too (existing columns are already
    // LUT-mapped with the previous mapping, so a rebuild keeps the view
    // honest rather than repainting mixed mappings).
  }, [
    analyser,
    tapLow,
    tapMid,
    tapHigh,
    transport,
    rafId,
    open,
    fftSize,
    floorDb,
    ceilDb,
    lutName,
    multi,
    zoom,
    backing.w,
    backing.h,
    id,
  ]);

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

  const zoomLabel = zoomed ? `${formatFreq(zoom.min)}–${formatFreq(zoom.max || 24000)}` : "FULL";

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
            <label className="spectrogram-ctl" title="Multi-resolution: long window for sub-bass, short for transients">
              RES
              <select
                value={multi ? "multi" : "single"}
                disabled={!taps}
                onChange={(e) => setMulti(e.target.value === "multi")}
                aria-label="Spectrogram resolution mode"
              >
                <option value="single">1×FFT</option>
                <option value="multi">MULTI</option>
              </select>
            </label>
            <label className="spectrogram-ctl">
              FFT
              <select
                value={fftSize}
                disabled={multi}
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
            <label className="spectrogram-ctl" title="Dynamic range floor — raise it when the mix is quiet">
              FL
              <select
                value={floorDb}
                onChange={(e) => setFloorDb(Number(e.target.value))}
                aria-label="Spectrogram range floor"
              >
                {FLOOR_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="spectrogram-ctl" title="Dynamic range ceiling — lower it to spotlight quiet detail">
              CEIL
              <select
                value={ceilDb}
                onChange={(e) => setCeilDb(Number(e.target.value))}
                aria-label="Spectrogram range ceiling"
              >
                {CEIL_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="spectrogram-ctl-btn"
              onClick={() => setLutIdx((i) => (i + 1) % SPECTRO_LUT_NAMES.length)}
              title="Cycle color map"
            >
              {lutName}
            </button>
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
            <button
              type="button"
              className="spectrogram-ctl-btn"
              data-active={zoomed}
              onClick={() => setZoom({ min: SPECTRO_MIN_FREQ, max: 0 })}
              title="Frequency zoom — scroll wheel on the view zooms around the cursor, double-click resets"
            >
              {zoomLabel}
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
