import { useEffect, useRef } from "react";
import { useServices } from "./context";
import type { InstrumentTrack } from "../project-model/types";
import { FACTORY_WAVETABLES, extractWavetable, morphFrames, type Wavetable } from "../instruments/wavetables";

/** Extraction results per sample id — ids are unique per import, so entries
 *  never go stale; the cap just bounds memory. */
const extractCache = new Map<string, Wavetable | null>();

export function resolveTrackWavetable(
  track: InstrumentTrack,
  getSample: (id: string | null) => AudioBuffer | undefined,
): Wavetable | null {
  if (track.sampleId) {
    if (!extractCache.has(track.sampleId)) {
      if (extractCache.size > 16) extractCache.delete(extractCache.keys().next().value ?? "");
      const buffer = getSample(track.sampleId);
      extractCache.set(track.sampleId, buffer ? extractWavetable(buffer.getChannelData(0), buffer.sampleRate) : null);
    }
    const table = extractCache.get(track.sampleId);
    if (table) return table;
  }
  const count = FACTORY_WAVETABLES.length;
  const idx = ((Math.round(track.params.table ?? 0) % count) + count) % count;
  return FACTORY_WAVETABLES[idx] ?? null;
}

function drawWavetablePreview(canvas: HTMLCanvasElement, table: Wavetable, morph: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const mid = h / 2;
  const dim = getComputedStyle(canvas).getPropertyValue("--text-faint") || "#3a3d44";

  // All frames overlaid, faint — shows the shape of the whole table.
  ctx.strokeStyle = dim;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  for (const frame of table.frames) {
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const v = frame[Math.min(frame.length - 1, Math.floor((x / w) * frame.length))];
      const y = mid - v * (h / 2 - 2);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Interpolated frame at the current morph position, in accent color.
  const { a, b, blend } = morphFrames(table.frames, morph);
  const accent = getComputedStyle(canvas).getPropertyValue("--accent") || "#f59e0b";
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i = Math.min(a.length - 1, Math.floor((x / w) * a.length));
    const v = a[i] * (1 - blend) + b[i] * blend;
    const y = mid - v * (h / 2 - 2);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawGranularPreview(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  position: number,
  size: number,
  jitter: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const dim = getComputedStyle(canvas).getPropertyValue("--text-faint") || "#3a3d44";
  const accent = getComputedStyle(canvas).getPropertyValue("--accent") || "#f59e0b";

  // Min/max envelope of the source, faint.
  const data = buffer.getChannelData(0);
  const columns = Math.min(w, 240);
  const per = Math.floor(data.length / columns);
  ctx.strokeStyle = dim;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c < columns; c++) {
    let min = 1;
    let max = -1;
    for (let i = c * per; i < (c + 1) * per && i < data.length; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const x = (c / columns) * w;
    ctx.moveTo(x, h / 2 - max * (h / 2 - 2));
    ctx.lineTo(x, h / 2 - min * (h / 2 - 2));
  }
  ctx.stroke();

  // Grain window: position ± jitter, width = grain size.
  ctx.globalAlpha = 1;
  const sizeFrac = Math.min(1, size / Math.max(0.001, buffer.duration));
  const x0 = (position - sizeFrac / 2 - jitter * 0.5) * w;
  const x1 = (position + sizeFrac / 2 + jitter * 0.5) * w;
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(position * w, 0);
  ctx.lineTo(position * w, h);
  ctx.stroke();
}

/**
 * Canvas preview under the sample browser in the Inspector:
 * wavetable tracks show the table's frames with the morph position
 * highlighted; granular tracks show the source waveform with the grain
 * window. Static — redrawn on parameter changes only.
 */
export function WavetablePreview({ track }: { track: InstrumentTrack }) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      if (cssWidth === 0 || cssHeight === 0) return;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      if (track.instrument === "granular") {
        const buffer = services.bank.get(track.sampleId);
        if (buffer) {
          drawGranularPreview(
            canvas,
            buffer,
            track.params.position ?? 0.25,
            track.params.size ?? 0.09,
            track.params.jitter ?? 0.15,
          );
        }
      } else {
        const table = resolveTrackWavetable(track, (id) => services.bank.get(id));
        if (table) drawWavetablePreview(canvas, table, track.params.morph ?? 0.3);
      }
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
    // track identity changes whenever any of its params/sampleId change
  }, [track, services]);

  return <canvas ref={canvasRef} className="wt-preview" aria-label="Instrument preview" />;
}
