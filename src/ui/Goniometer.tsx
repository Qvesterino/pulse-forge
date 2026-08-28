import { useEffect, useRef } from "react";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Stereo goniometer / vector scope. Reads time-domain data from the two
 * per-channel master analysers (observer-only) and plots L vs R.
 *
 * Mid = (L+R)*0.5 on X, Side = (L-R)*0.5 on Y — mono sits on the X axis,
 * wide stereo blooms vertically. This matches the classic vectorscope
 * orientation used in mastering.
 */
export function Goniometer({
  analysers,
  size = 100,
  accent = "#f59e0b",
  id,
}: {
  analysers: { l: AnalyserNode; r: AnalyserNode } | null;
  size?: number;
  accent?: string;
  id: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analysers) return;
    const { l, r } = analysers;
    const bufL = new Float32Array(l.fftSize);
    const bufR = new Float32Array(r.fftSize);
    let last = 0;
    let rafId = `goniometer-${id}`;

    registerRaf(rafId, (t) => {
      if (t - last < 33) return;
      last = t;
      l.getFloatTimeDomainData(bufL);
      r.getFloatTimeDomainData(bufR);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.42;

      // Fade trail — semi-transparent fill instead of clear for persistence
      ctx.fillStyle = "rgba(17,19,24,0.35)";
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();

      // Diagonal mono lines
      ctx.strokeStyle = "rgba(255,255,255,0.03)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.moveTo(w, 0);
      ctx.lineTo(0, h);
      ctx.stroke();

      // Border
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.strokeRect(0, 0, w, h);

      // Plot points — mid on X, side on Y
      ctx.fillStyle = accent;
      const step = Math.max(1, Math.floor(bufL.length / 512));
      for (let i = 0; i < bufL.length; i += step) {
        const mid = (bufL[i] + bufR[i]) * 0.5;
        const side = (bufL[i] - bufR[i]) * 0.5;
        const x = cx + mid * radius * 2;
        const y = cy - side * radius * 2;
        ctx.fillRect(x, y, 1.2, 1.2);
      }

      // Correlation hint — thin line across centre whose angle follows correlation
      // Approximated from last buffers (Pearson) — reuse simple estimate
      let corr = 0;
      {
        let sumL = 0,
          sumR = 0,
          sumLL = 0,
          sumRR = 0,
          sumLR = 0;
        const N = Math.min(bufL.length, 256);
        for (let i = 0; i < N; i++) {
          const a = bufL[i];
          const b = bufR[i];
          sumL += a;
          sumR += b;
          sumLL += a * a;
          sumRR += b * b;
          sumLR += a * b;
        }
        const num = N * sumLR - sumL * sumR;
        const den = Math.sqrt((N * sumLL - sumL * sumL) * (N * sumRR - sumR * sumR));
        corr = den > 1e-9 ? num / den : 1;
      }
      ctx.strokeStyle = corr < 0 ? "rgba(239,68,68,0.5)" : "rgba(245,158,11,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const lineLen = radius * 0.9;
      const angle = ((corr + 1) / 2) * (Math.PI / 2) - Math.PI / 4;
      ctx.moveTo(cx - Math.cos(angle) * lineLen, cy - Math.sin(angle) * lineLen);
      ctx.lineTo(cx + Math.cos(angle) * lineLen, cy + Math.sin(angle) * lineLen);
      ctx.stroke();
    });

    return () => unregisterRaf(rafId);
  }, [analysers, id, accent]);

  return (
    <canvas
      ref={canvasRef}
      className="goniometer"
      style={{ width: size, height: size, display: "block", borderRadius: 4 }}
      width={size * 2}
      height={size * 2}
      aria-label="Stereo goniometer"
      role="img"
    />
  );
}
