import { useEffect, useRef } from "react";
import { skrutkaCurve, skrutkaPeakDelay, type SkrutkaCurveParams } from "../effects/skrutka-curve";

/**
 * SKRUTKA (skrutka) panel — the group-delay curve that IS the effect.
 *
 * Phase-only DSP has no level signature to meter, so the honest visual is
 * the analytic group-delay curve (src/effects/skrutka-curve — the same math
 * the worklet runs): how much LATER each frequency arrives, relative to the
 * rest. FOCUS marks where the hump peaks; with SPREAD up the R curve splits
 * from L, which is exactly the stereo decorrelation the processor applies.
 *
 * Pure display: no engine calls, no telemetry (the curve is computed from
 * the params alone), and every AudioParam edit stays on the generic device
 * grid below — one command path, one undo per gesture. Redraws on param
 * changes and container resizes only; nothing polls at frame rate.
 */
export function SkrutkaPanel({
  params,
  degraded,
  docked = false,
}: {
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    let observer: ResizeObserver | null = null;

    const sizeCanvas = () => {
      const el = canvasRef.current;
      if (!el) return;
      const w = Math.max(200, Math.floor(el.clientWidth));
      const h = Math.max(80, Math.floor(el.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.floor(w * dpr);
      el.height = Math.floor(h * dpr);
    };

    const draw = () => {
      const el = canvasRef.current;
      if (!el) return;
      const c2d = el.getContext("2d");
      if (!c2d) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = el.width / dpr;
      const ch = el.height / dpr;
      if (cw <= 0 || ch <= 0) return;
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, cw, ch);

      const p = paramsRef.current;
      const curveParams: SkrutkaCurveParams = {
        dispersion: p.dispersion ?? 0.35,
        punch: p.punch ?? 0,
        focusHz: p.focusHz ?? 220,
        spread: p.spread ?? 0,
      };
      const F_LO = 30;
      const F_HI = 16000;
      const points = skrutkaCurve(curveParams, 48000, 160, F_LO, F_HI);
      let maxMs = 0.05;
      for (const point of points) maxMs = Math.max(maxMs, point.lMs, point.rMs);

      const xOf = (f: number) => (Math.log(Math.min(F_HI, Math.max(F_LO, f)) / F_LO) / Math.log(F_HI / F_LO)) * cw;
      const yOf = (ms: number) => ch - (ms / maxMs) * (ch - 6) - 3;

      // Decade gridlines: 100 Hz / 1 kHz / 10 kHz.
      c2d.strokeStyle = "rgba(200, 200, 200, 0.18)";
      c2d.fillStyle = "rgba(200, 200, 200, 0.5)";
      c2d.font = "9px monospace";
      for (const f of [100, 1000, 10000]) {
        const x = xOf(f);
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, ch);
        c2d.stroke();
        c2d.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, ch - 3);
      }

      // FOCUS marker — where the dispersion hump peaks.
      const xf = xOf(curveParams.focusHz);
      c2d.strokeStyle = "rgba(255, 210, 120, 0.55)";
      c2d.setLineDash([3, 4]);
      c2d.beginPath();
      c2d.moveTo(xf, 0);
      c2d.lineTo(xf, ch);
      c2d.stroke();
      c2d.setLineDash([]);

      // L curve (solid accent) and R curve (dashed, splits with SPREAD).
      const strokeCurve = (key: "lMs" | "rMs", color: string, dash: number[]) => {
        c2d.strokeStyle = color;
        c2d.lineWidth = 1.5;
        c2d.setLineDash(dash);
        c2d.beginPath();
        for (let i = 0; i < points.length; i++) {
          const x = xOf(points[i]!.freqHz);
          const y = yOf(points[i]![key]);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.lineWidth = 1;
      };
      strokeCurve("lMs", "rgba(255, 170, 120, 0.95)", []);
      strokeCurve("rMs", "rgba(120, 200, 255, 0.85)", [4, 4]);

      // Peak readout.
      const peak = skrutkaPeakDelay(curveParams, 48000);
      if (readoutRef.current) {
        readoutRef.current.textContent =
          peak.ms > 0.01 ? `+${peak.ms.toFixed(1)} ms @ ${Math.round(peak.freqHz)} Hz` : "— no delay hump";
      }
    };

    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        sizeCanvas();
        draw();
      });
      observer.observe(canvas);
    }
    sizeCanvas();
    draw();

    return () => observer?.disconnect();
  }, [params]);

  return (
    <section className={`skrutka-panel${docked ? " docked" : ""}`} aria-label="SKRUTKA group delay">
      {degraded && <div className="skrutka-degraded">AudioWorklet unavailable — SKRUTKA is bypassed (1:1 signal)</div>}
      <div className="skrutka-head">
        <span className="skrutka-readout" ref={readoutRef}>
          — no delay hump
        </span>
        <span className="skrutka-hint">arrival delay per frequency — L solid, R dashed</span>
      </div>
      <canvas ref={canvasRef} className="skrutka-viz" />
    </section>
  );
}
