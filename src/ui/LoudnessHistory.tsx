import { useEffect, useRef } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { useServices } from "./context";

/**
 * Loudness history canvas — plots LUFS-M / LUFS-S / LUFS-I over ~30s.
 * Observer-only: reads getMasterMeterSnapshot on a ~10 Hz loop.
 * Green = momentary, amber = short-term, white = integrated.
 * The dashed target line follows the project's LUFS target (-14 fallback);
 * -23 LUFS stays as the dim broadcast reference.
 */
export function LoudnessHistory({
  id = "loudness",
  height = 64,
  targetLufs = -14,
}: {
  id?: string;
  height?: number;
  targetLufs?: number;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<{ m: number[]; s: number[]; i: number[] }>({ m: [], s: [], i: [] });
  const targetRef = useRef(targetLufs);
  targetRef.current = targetLufs;

  useEffect(() => {
    const maxPoints = 300; // ~30s at 10 Hz
    const minDb = -30;
    const maxDb = -6;
    const range = maxDb - minDb;

    let last = 0;
    const rafId = `loudness-history-${id}`;
    registerRaf(rafId, (t) => {
      if (t - last < 100) return;
      last = t;
      const engine = services.engine as unknown as {
        getMasterMeterSnapshot?: () => { lufsMomentary: number; lufsShortTerm: number; lufsIntegrated: number };
      };
      const snap = engine.getMasterMeterSnapshot?.();
      if (!snap) return;
      const hist = historyRef.current;
      hist.m.push(snap.lufsMomentary);
      hist.s.push(snap.lufsShortTerm);
      hist.i.push(snap.lufsIntegrated);
      if (hist.m.length > maxPoints) {
        hist.m.shift();
        hist.s.shift();
        hist.i.shift();
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, w, h);

      // Grid at the project LUFS target + the -23 broadcast reference
      const targets: { value: number; primary: boolean }[] = [
        { value: targetRef.current, primary: true },
        { value: -23, primary: false },
      ];
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (const { value, primary } of targets) {
        if (value < minDb || value > maxDb) continue;
        const y = h * (1 - (value - minDb) / range);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = primary ? "rgba(245,158,11,0.5)" : "rgba(255,255,255,0.15)";
        ctx.font = "8px monospace";
        ctx.fillText(`${value} LUFS`, 4, y - 2);
      }

      const drawLine = (data: number[], color: string) => {
        if (data.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        for (let idx = 0; idx < data.length; idx++) {
          const v = data[idx];
          const clamped = Math.max(minDb, Math.min(maxDb, v));
          const x = (idx / (maxPoints - 1)) * w;
          const y = h * (1 - (clamped - minDb) / range);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };

      drawLine(hist.i, "rgba(255,255,255,0.9)");
      drawLine(hist.s, "#f59e0b");
      drawLine(hist.m, "#4ade80");

      // Legend
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "7px monospace";
      ctx.fillText("M", w - 42, 9);
      ctx.fillStyle = "#4ade80";
      ctx.fillRect(w - 38, 3, 6, 6);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText("S", w - 28, 9);
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(w - 24, 3, 6, 6);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText("I", w - 14, 9);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(w - 10, 3, 6, 6);
    });
    return () => unregisterRaf(rafId);
  }, [services, id]);

  return (
    <canvas
      ref={canvasRef}
      className="loudness-history"
      style={{ width: "100%", height, display: "block", borderRadius: 4 }}
      width={600}
      height={height}
      aria-label="Loudness history"
      role="img"
    />
  );
}
