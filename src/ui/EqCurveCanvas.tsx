import { useEffect, useRef } from "react";
import { EQ_CURVE_MAX_DB, EQ_CURVE_MAX_HZ, EQ_CURVE_MIN_DB, EQ_CURVE_MIN_HZ, eqCurve } from "../effects/eqCurve";

type EqCurveCanvasProps = {
  params: Record<string, number>;
  width?: number;
  height?: number;
};

/**
 * Read-only paint of the core EQ response. It draws, it does not edit: a
 * `Slider` is a real input, and it is the one that stays authoritative: a
 * draggable curve is a much larger surface (per-band hit-testing, dB↔param
 * mapping, gesture arbitration against the knobs below it). The canvas
 * reports what the band sliders are doing; the sliders take the edits.
 */
export function EqCurveCanvas({ params, width = 236, height = 46 }: EqCurveCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Redraw on resize as well: the dock is a flexible panel and a canvas
    // sized once at mount would stretch or letterbox.
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || width;
      const h = canvas.clientHeight || height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const midY = h / 2;
      const styles = getComputedStyle(canvas);
      const accent = styles.getPropertyValue("--accent").trim() || "#f0a24a";
      const gridColor = styles.getPropertyValue("--border-soft").trim() || "rgba(255,255,255,.12)";

      // 0 dB baseline and the ±12 dB guides, so the curve is read against a
      // reference instead of against the frame.
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (const db of [0, 12, -12]) {
        const y = midY - (db / EQ_CURVE_MAX_DB) * (h / 2);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
      }

      const points = eqCurve(params, 96);
      const xOf = (hz: number) =>
        ((Math.log(hz) - Math.log(EQ_CURVE_MIN_HZ)) / (Math.log(EQ_CURVE_MAX_HZ) - Math.log(EQ_CURVE_MIN_HZ))) * w;
      const yOf = (db: number) => {
        const clamped = Math.max(EQ_CURVE_MIN_DB, Math.min(EQ_CURVE_MAX_DB, db));
        return midY - (clamped / EQ_CURVE_MAX_DB) * (h / 2);
      };

      // Fill under the curve, then the line itself: the fill is what makes a
      // boost read as "more" and a cut read as "less" at a glance.
      ctx.beginPath();
      ctx.moveTo(0, midY);
      for (const pt of points) ctx.lineTo(xOf(pt.hz), yOf(pt.db));
      ctx.lineTo(w, midY);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      points.forEach((pt, i) => {
        const x = xOf(pt.hz);
        const y = yOf(pt.db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [params, width, height]);

  return (
    <canvas
      ref={ref}
      className="kit-eq-curve"
      style={{ width: "100%", height: `${height}px` }}
      role="img"
      aria-label="EQ response curve"
    />
  );
}
