import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "./context";
import { updateAudioClip } from "../commands/commands";
import { uid } from "../shared/ids";
import { applySpectralEditsToChannels, computeStftDbFrames, suggestNoiseRegionFromFrames, type SpectralEdit } from "../audio-engine/spectralEdit";
import {
  SPECTRO_MIN_FREQ,
  createSpectrogramBandMap,
  dbToLutIndex,
  getSpectroLut,
  reduceFrameToRows,
} from "../audio-engine/spectrogram";
import type { AudioClip } from "../project-model/types";

/**
 * Spectral Lab — RX-style spectral editing for one audio clip.
 *
 * Left: static spectrogram of the clip's buffer (mono display mix, log
 * frequency). Drag a time×frequency rectangle, pick a gain, preview
 * original vs edited, then APPLY: the edited audio lands as a NEW bank
 * buffer and the clip's bufferId is rewired through an undoable command —
 * the original buffer stays in the bank, so Ctrl+Z (or re-import) always
 * gets it back.
 *
 * Selection is in raw sample time: it includes regions the clip's trim
 * window may not play.
 */

const PANEL_W = 700;
const CANVAS_H = 240;
const FFT = 2048;
const HOP = 1024;
const LUT = getSpectroLut("MAGMA");

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normRect(r: Rect): Rect {
  return {
    x0: Math.min(r.x0, r.x1),
    x1: Math.max(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    y1: Math.max(r.y0, r.y1),
  };
}

export function SpectralEditPanel({
  clip,
  buffer,
  onClose,
}: {
  clip: AudioClip;
  buffer: AudioBuffer;
  onClose: () => void;
}) {
  const services = useServices();
  const dataRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const previewRef = useRef<AudioBufferSourceNode | null>(null);
  const framesRef = useRef<Float32Array<ArrayBuffer>[] | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [gainDb, setGainDb] = useState(-24);
  const [featherMs, setFeatherMs] = useState(30);
  const [status, setStatus] = useState("Drag a rectangle over the spectrogram");
  const [backing, setBacking] = useState({ w: PANEL_W - 40, h: CANVAS_H });

  const channels = useMemo(
    () => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
    [buffer],
  );
  const duration = buffer.duration;
  const nyquist = buffer.sampleRate / 2;

  const xToTime = (x: number) => (x / backing.w) * duration;
  const yToFreq = (y: number) =>
    SPECTRO_MIN_FREQ * Math.pow(nyquist / SPECTRO_MIN_FREQ, 1 - Math.min(1, Math.max(0, y / backing.h)));

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const w = Math.max(320, Math.floor(wrap.clientWidth));
      setBacking((prev) => (prev.w !== w ? { ...prev, w } : prev));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Stop any preview when the panel goes away.
  useEffect(() => () => previewRef.current?.stop(), []);

  // Static spectrogram paint — one column per canvas pixel.
  useEffect(() => {
    const canvas = dataRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = backing;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const mono = new Float32Array(buffer.length);
    for (const ch of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
    }
    const map = createSpectrogramBandMap(buffer.sampleRate, FFT, h, SPECTRO_MIN_FREQ, nyquist);
    const frames = computeStftDbFrames(mono, FFT, HOP);
    framesRef.current = frames;
    if (frames.length === 0) return;
    const rows = new Float32Array(h);
    const img = ctx.createImageData(w, h);

    for (let x = 0; x < w; x++) {
      const frame = frames[Math.min(frames.length - 1, Math.floor((x * frames.length) / w))];
      reduceFrameToRows(frame, map, rows);
      for (let y = 0; y < h; y++) {
        const idx = dbToLutIndex(rows[y], -90, 0);
        const p = (y * w + x) * 4;
        img.data[p] = LUT[idx * 3];
        img.data[p + 1] = LUT[idx * 3 + 1];
        img.data[p + 2] = LUT[idx * 3 + 2];
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Frequency grid + labels (same ramp style as the live spectrogram).
    ctx.font = "9px monospace";
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (f >= nyquist || f < SPECTRO_MIN_FREQ) continue;
      const t = 1 - Math.log(f / SPECTRO_MIN_FREQ) / Math.log(nyquist / SPECTRO_MIN_FREQ);
      const y = Math.round(t * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 2, y - 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText("0s", 2, h - 3);
    const durLabel = `${duration.toFixed(2)}s`;
    ctx.fillText(durLabel, w - durLabel.length * 5.5 - 2, h - 3);
  }, [buffer, channels, backing, nyquist, duration]);

  // Selection overlay — rectangle + readout.
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = backing;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    if (!sel) return;
    const r = normRect(sel);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0 - 1, r.y1 - r.y0 - 1);
    const label = `${xToTime(r.x0).toFixed(2)}–${xToTime(r.x1).toFixed(2)}s · ${Math.round(
      yToFreq(r.y1),
    )}–${Math.round(yToFreq(r.y0))}Hz`;
    ctx.fillStyle = "rgba(8,6,12,0.85)";
    ctx.fillRect(r.x0 + 2, r.y0 + 2, label.length * 5.5 + 8, 13);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(label, r.x0 + 6, r.y0 + 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, backing]);

  const stopPreview = () => {
    try {
      previewRef.current?.stop();
    } catch {
      /* already stopped */
    }
    previewRef.current = null;
  };

  const playBuffer = (buf: AudioBuffer) => {
    const ctx = services.engine.getLiveAudioContext();
    if (!ctx) {
      setStatus("Audio engine not running — press play once first");
      return;
    }
    stopPreview();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (previewRef.current === src) previewRef.current = null;
    };
    src.start();
    previewRef.current = src;
  };

  const currentEdit = (): SpectralEdit | null => {
    if (!sel) return null;
    const r = normRect(sel);
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3) return null;
    const startSec = xToTime(r.x0);
    const endSec = xToTime(r.x1);
    return {
      startSec,
      endSec: Math.max(startSec + 0.01, endSec),
      freqLoHz: Math.max(20, yToFreq(r.y1)),
      freqHiHz: Math.max(21, yToFreq(r.y0)),
      gainDb,
    };
  };

  const buildEditedBuffer = (): AudioBuffer | null => {
    const ctx = services.engine.getLiveAudioContext();
    const edit = currentEdit();
    if (!ctx || !edit) return null;
    const edited = applySpectralEditsToChannels(channels, buffer.sampleRate, [edit], {
      fftSize: FFT,
      featherSec: featherMs / 1000,
    });
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    edited.forEach((ch, i) => out.copyToChannel(ch, i));
    return out;
  };

  const eraseNoise = () => {
    const frames = framesRef.current;
    if (!frames || frames.length === 0) {
      setStatus("Spectrogram still computing — try again in a moment");
      return;
    }
    const sug = suggestNoiseRegionFromFrames(frames, buffer.sampleRate, FFT, duration);
    if (!sug) {
      setStatus("No persistent noise found — select a region manually");
      return;
    }
    setGainDb(sug.gainDb);
    const yFor = (f: number) =>
      backing.h * (1 - Math.log(f / SPECTRO_MIN_FREQ) / Math.log(nyquist / SPECTRO_MIN_FREQ));
    setSel({ x0: 0, x1: backing.w, y0: yFor(sug.freqHiHz), y1: yFor(sug.freqLoHz) });
    setStatus(`Noise band ≈ ${Math.round(sug.freqLoHz)}–${Math.round(sug.freqHiHz)} Hz suggested — preview and APPLY`);
  };

  const apply = () => {
    const ctx = services.engine.getLiveAudioContext();
    if (!ctx) {
      setStatus("Audio engine not running — press play once first");
      return;
    }    const edit = currentEdit();
    if (!edit) {
      setStatus("Select a region first (drag on the spectrogram)");
      return;
    }
    const edited = applySpectralEditsToChannels(channels, buffer.sampleRate, [edit], {
      fftSize: FFT,
      featherSec: featherMs / 1000,
    });
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    edited.forEach((ch, i) => out.copyToChannel(ch, i));
    const newId = uid("spectralEdit");
    services.bank.add(newId, out);
    try {
      services.store.execute(updateAudioClip(services.store.doc, clip.id, { bufferId: newId }));
    } catch (err) {
      setStatus(String(err).slice(0, 120));
      return;
    }
    stopPreview();
    onClose();
  };

  const btnStyle: React.CSSProperties = {
    background: "none",
    border: "1px solid var(--border, #333)",
    borderRadius: 4,
    color: "var(--text, #ddd)",
    fontFamily: "var(--mono, monospace)",
    fontSize: 10,
    padding: "4px 10px",
    cursor: "pointer",
  };

  return (
    <div
      data-testid="spectral-edit-panel"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          stopPreview();
          onClose();
        }
      }}
    >
      <div
        style={{
          width: PANEL_W,
          maxWidth: "94vw",
          background: "var(--bg, #0c0a10)",
          border: "1px solid var(--border, #333)",
          borderRadius: 6,
          padding: 14,
          boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontFamily: "var(--mono, monospace)",
            fontSize: 11,
            letterSpacing: "0.08em",
            color: "var(--text, #ddd)",
            marginBottom: 8,
          }}
        >
          <span>SPECTRAL EDIT — {buffer.numberOfChannels === 1 ? "MONO" : "STEREO"} {duration.toFixed(2)}s</span>
          <button type="button" style={btnStyle} onClick={() => { stopPreview(); onClose(); }}>
            ✕
          </button>
        </div>

        <div ref={wrapRef} style={{ width: "100%", marginBottom: 8 }}>
          <div style={{ position: "relative", width: "100%", height: CANVAS_H }}>
            <canvas ref={dataRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", borderRadius: 4 }} />
            <canvas
              ref={overlayRef}
              data-testid="spectral-edit-overlay"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair" }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                dragRef.current = { x, y };
                setSel({ x0: x, y0: y, x1: x, y1: y });
              }}
              onPointerMove={(e) => {
                if (!dragRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                setSel({ x0: dragRef.current.x, y0: dragRef.current.y, x1: x, y1: y });
              }}
              onPointerUp={(e) => {
                if (!dragRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const dx = Math.abs(x - dragRef.current.x);
                const dy = Math.abs(y - dragRef.current.y);
                dragRef.current = null;
                if (dx < 4 && dy < 4) {
                  setSel(null);
                  setStatus("Selection cleared");
                } else {
                  setStatus("Pick GAIN, preview, then APPLY (undo restores the original)");
                }
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontFamily: "var(--mono, monospace)",
            fontSize: 10,
            color: "var(--text, #ddd)",
            marginBottom: 8,
          }}
        >
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 220 }}>
            GAIN
            <input
              type="range"
              min={-60}
              max={24}
              step={1}
              value={gainDb}
              onChange={(e) => setGainDb(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 46, textAlign: "right" }}>{gainDb > 0 ? `+${gainDb}` : gainDb} dB</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            FEATHER
            <select value={featherMs} onChange={(e) => setFeatherMs(Number(e.target.value))} style={btnStyle}>
              {[10, 30, 60, 120].map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            style={btnStyle}
            title="Detect the loudest persistent noise band (hiss, hum, rumble) and prefill the selection with an erase cut"
            onClick={eraseNoise}
          >
            ERASE NOISE
          </button>
          <button type="button" style={btnStyle} onClick={() => playBuffer(buffer)}>
            PLAY ORIG
          </button>
          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              const buf = buildEditedBuffer();
              if (buf) playBuffer(buf);
              else setStatus("Select a region first (drag on the spectrogram)");
            }}
          >
            PLAY EDIT
          </button>
          <button
            type="button"
            style={{ ...btnStyle, borderColor: "var(--accent, #f59e0b)", color: "var(--accent, #f59e0b)" }}
            onClick={apply}
          >
            APPLY
          </button>
          <button type="button" style={btnStyle} onClick={() => { stopPreview(); onClose(); }}>
            CLOSE
          </button>
        </div>

        <div style={{ fontFamily: "var(--mono, monospace)", fontSize: 10, color: "var(--text-faint, #888)" }}>
          {status} · APPLY renders a new buffer and rewires the clip — the original stays in the library (Ctrl+Z to undo).
        </div>
      </div>
    </div>
  );
}
