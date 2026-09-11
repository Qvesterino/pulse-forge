import { useEffect, useRef, useState } from "react";
import { setInstrumentParam } from "../commands/commands";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";

const W = 320;
const H = 132;

/**
 * Granular playhead panel (floating plugin, sibling of WavetablePanel).
 *
 * Shows the source waveform with the grain window (SIZE ± JITTER) and the
 * POSITION marker. Dragging the canvas moves the playhead — commits stream
 * through setInstrumentParam with a coalesceKey, so one drag = one undo
 * entry while the engine hears every move. On the granular voice-worklet
 * path POSITION is read at every grain spawn, so the drag steers the cloud
 * LIVE during a held note (Granulator-II style); the fallback cloud picks
 * the new position up on its next notes.
 *
 * SCAN animates a ghost marker drifting at the scan rate (visual only —
 * the audio side is deterministic and never reads the wall clock).
 */
export function GranularPanel({
  track,
  doc,
  services,
}: {
  track: Extract<InstrumentTrack, { kind: "instrument" }>;
  doc: ProjectDocument;
  services: { bank: { get(id: string | null): AudioBuffer | undefined }; store: { execute: (c: unknown) => unknown } };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const position = dragPos ?? Math.max(0, Math.min(1, track.params.position ?? 0.25));
  const size = Math.min(0.4, Math.max(0.02, track.params.size ?? 0.09));
  const jitter = Math.max(0, Math.min(1, track.params.jitter ?? 0.15));
  const scan = Math.max(-2, Math.min(2, track.params.scan ?? 0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const buffer = services.bank.get(track.sampleId);
      if (!buffer) {
        ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--text-faint") || "#3a3d44";
        ctx.font = "11px system-ui";
        ctx.fillText("assign a sample to steer its playhead", 8, h / 2);
        return;
      }
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

      // Grain window: position ± jitter spray, width = grain size.
      const sizeFrac = Math.min(1, size / Math.max(0.001, buffer.duration));
      const x0 = (position - sizeFrac / 2 - jitter * 0.5) * w;
      const x1 = (position + sizeFrac / 2 + jitter * 0.5) * w;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);

      // SCAN ghost marker: wall-clock drift, visual only.
      if (Math.abs(scan) > 0.001) {
        const t = performance.now() / 1000;
        let ghost = position + scan * t;
        ghost = ((ghost % 1) + 1) % 1;
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ghost * w, 0);
        ctx.lineTo(ghost * w, h);
        ctx.stroke();
      }

      // POSITION playhead, full accent.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(position * w, 0);
      ctx.lineTo(position * w, h);
      ctx.stroke();
    };
    draw();
    if (Math.abs(scan) <= 0.001) return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, position, size, jitter, scan, services]);

  const commitPosition = (v: number) => {
    setDragPos(v);
    services.store.execute({
      ...setInstrumentParam(doc, track.id, "position", v),
      coalesceKey: `granular-position:${track.id}`,
    });
  };

  const pointerToPos = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  return (
    <div className="wt-panel">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="wt-canvas"
        style={{ touchAction: "none", cursor: "ew-resize" }}
        aria-label={`Granular playhead — position ${(position * 100).toFixed(0)}%`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          commitPosition(pointerToPos(e));
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          commitPosition(pointerToPos(e));
        }}
        onPointerUp={() => setDragPos(null)}
        onPointerCancel={() => setDragPos(null)}
      />
      <div className="wt-caption">
        <span>GRANULAR PLAYHEAD</span>
        <span>
          POS {(position * 100).toFixed(0)}% · GRAIN {Math.round(size * 1000)} ms
          {Math.abs(scan) > 0.001 ? ` · SCAN ${scan > 0 ? "+" : ""}${scan.toFixed(2)}/s` : " · drag = live"}
        </span>
      </div>
    </div>
  );
}
