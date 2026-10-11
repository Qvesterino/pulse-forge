import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SKRUTKA_LFO_SHAPE_LABELS, SKRUTKA_SHAPE_LABELS } from "../effects/definitions";
import {
  SKRUTKA_R_HARD_MAX,
  skrutkaCurve,
  skrutkaCurveWithRadius,
  skrutkaDelayAt,
  skrutkaDispersionForPeakMs,
  skrutkaLfoFocusRange,
  skrutkaPeakDelay,
  type SkrutkaCurveParams,
} from "../effects/skrutka-curve";
import type { SkrutkaMeterFrame } from "../audio-worklets/skrutka-node";
import { useServices } from "./context";

/**
 * SKRUTKA (skrutka) panel — v2: the group-delay curve that IS the effect,
 * now editable and dynamic-aware.
 *
 * The curve is the analytic model (src/effects/skrutka-curve — the same math
 * the worklet runs): how much LATER each frequency arrives. FOCUS marks the
 * hump; with SPREAD up the R curve splits from L. When DYNAMIC or KEY are
 * armed the driven radius ceiling draws as a faint band around the base
 * curve; when the LFO is armed its FOCUS sweep range shades on the x axis.
 *
 * DRAG THE CURVE: horizontal = FOCUS, vertical = DISPERSION (bisection over
 * the peak-delay mapping). The whole gesture is ONE undo frame.
 *
 * BAND SOLO auditions only the band the hump moves (monitor-only, live path,
 * released on unmount). The live dot follows the processor telemetry
 * (lfo phase + current radius) so the automation is visible, not inferred.
 */
export function SkrutkaPanel({
  trackId,
  fxId,
  params,
  degraded,
  docked = false,
  onParam,
  onGestureStart,
  onGestureEnd,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
  onParam?: (paramId: string, value: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<SkrutkaMeterFrame | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [soloOn, setSoloOn] = useState(false);
  const draggingRef = useRef(false);

  // BAND SOLO is monitor-only and panel-scoped: when the device card (or the
  // panel) unmounts, the audition band must not survive it.
  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      setMonitorBand?: (hz: number | null) => void;
    };
    return () => engine.setMonitorBand?.(null);
  }, [services]);

  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
    };
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

    const F_LO = 30;
    const F_HI = 16000;
    const xOf = (f: number, cw: number) =>
      (Math.log(Math.min(F_HI, Math.max(F_LO, f)) / F_LO) / Math.log(F_HI / F_LO)) * cw;

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
      const cp: SkrutkaCurveParams = {
        dispersion: p.dispersion ?? 0.35,
        punch: p.punch ?? 0,
        punchHz: p.punchHz ?? 0,
        punchMix: p.punchMix ?? 1,
        focusHz: p.focusHz ?? 220,
        spread: p.spread ?? 0,
        shape: p.shape ?? 0,
      };
      const base = skrutkaCurve(cp, 48000, 160, F_LO, F_HI);
      const dynArmed = Math.abs(p.dyn ?? 0) > 1e-4 || (p.keyMode ?? 0) > 0;
      const driven = dynArmed ? skrutkaCurveWithRadius(cp, 48000, SKRUTKA_R_HARD_MAX, 160, F_LO, F_HI) : null;
      let maxMs = 0.05;
      for (const point of base) maxMs = Math.max(maxMs, point.lMs, point.rMs);
      if (driven) for (const point of driven) maxMs = Math.max(maxMs, point.lMs, point.rMs);
      maxMs *= 1.12;

      const yOf = (ms: number) => ch - (ms / maxMs) * (ch - 6) - 3;

      // LFO focus sweep shade (x axis).
      if ((p.lfoDepth ?? 0) > 1e-4) {
        const range = skrutkaLfoFocusRange(cp.focusHz, p.lfoDepth ?? 0);
        const xa = xOf(range.lo, cw);
        const xb = xOf(range.hi, cw);
        c2d.fillStyle = "rgba(150, 140, 255, 0.10)";
        c2d.fillRect(xa, 0, Math.max(1, xb - xa), ch);
      }

      // DYNAMIC/KEY driven band (fill between base and driven curves).
      if (driven) {
        c2d.fillStyle = "rgba(255, 190, 120, 0.12)";
        c2d.beginPath();
        for (let i = 0; i < base.length; i++) c2d.lineTo(xOf(base[i]!.freqHz, cw), yOf(base[i]!.lMs));
        for (let i = driven.length - 1; i >= 0; i--) c2d.lineTo(xOf(driven[i]!.freqHz, cw), yOf(driven[i]!.lMs));
        c2d.closePath();
        c2d.fill();
        c2d.strokeStyle = "rgba(255, 190, 120, 0.35)";
        c2d.setLineDash([2, 4]);
        c2d.beginPath();
        for (let i = 0; i < driven.length; i++) {
          const x = xOf(driven[i]!.freqHz, cw);
          const y = yOf(driven[i]!.lMs);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
      }

      // Decade gridlines.
      c2d.strokeStyle = "rgba(200, 200, 200, 0.18)";
      c2d.fillStyle = "rgba(200, 200, 200, 0.5)";
      c2d.font = "9px monospace";
      for (const f of [100, 1000, 10000]) {
        const x = xOf(f, cw);
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, ch);
        c2d.stroke();
        c2d.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, ch - 3);
      }

      // FOCUS marker.
      const xf = xOf(cp.focusHz, cw);
      c2d.strokeStyle = "rgba(255, 210, 120, 0.55)";
      c2d.setLineDash([3, 4]);
      c2d.beginPath();
      c2d.moveTo(xf, 0);
      c2d.lineTo(xf, ch);
      c2d.stroke();
      c2d.setLineDash([]);

      // L curve (solid accent) and R curve (dashed).
      const strokeCurve = (key: "lMs" | "rMs", color: string, dash: number[]) => {
        c2d.strokeStyle = color;
        c2d.lineWidth = 1.5;
        c2d.setLineDash(dash);
        c2d.beginPath();
        for (let i = 0; i < base.length; i++) {
          const x = xOf(base[i]!.freqHz, cw);
          const y = yOf(base[i]![key]);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.lineWidth = 1;
      };
      strokeCurve("lMs", "rgba(255, 170, 120, 0.95)", []);
      strokeCurve("rMs", "rgba(120, 200, 255, 0.85)", [4, 4]);

      // Live dot: the processor's current radius + LFO-moderated focus.
      const frame = frameRef.current;
      if (frame && !degraded) {
        const wave =
          (p.lfoShape ?? 0) === 0
            ? Math.sin(2 * Math.PI * frame.lfo)
            : (p.lfoShape ?? 0) === 1
              ? 4 * Math.abs(frame.lfo - 0.5) - 1
              : Math.sin(2 * Math.PI * frame.lfo); // random shape is unknown to the panel
        const fEff = Math.min(4000, Math.max(40, cp.focusHz * Math.pow(2, (p.lfoDepth ?? 0) * wave)));
        const radius = Math.min(SKRUTKA_R_HARD_MAX, Math.max(0.02, frame.radius));
        const ms = (skrutkaDelayAt(cp, 48000, fEff, radius, "L") / 48000) * 1000;
        const x = xOf(fEff, cw);
        const y = yOf(Math.min(ms, maxMs));
        c2d.fillStyle = "rgba(255, 255, 255, 0.92)";
        c2d.beginPath();
        c2d.arc(x, y, 3, 0, Math.PI * 2);
        c2d.fill();
      }

      // Readout: base peak.
      const peak = skrutkaPeakDelay(cp, 48000);
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

    const timer = window.setInterval(() => {
      const raw = engine.getFxMeters?.(trackId, fxId) as Partial<SkrutkaMeterFrame> | null;
      frameRef.current =
        raw && typeof raw.lfo === "number" && Number.isFinite(raw.lfo) && typeof raw.radius === "number"
          ? {
              lfo: raw.lfo,
              env: typeof raw.env === "number" ? raw.env : 0,
              key: typeof raw.key === "number" ? raw.key : 1,
              radius: raw.radius,
            }
          : null;
      draw();
    }, 66);

    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
    };
  }, [services, trackId, fxId, degraded]);

  const toggleSolo = () => {
    const engine = services.engine as typeof services.engine & {
      setMonitorBand?: (hz: number | null) => void;
    };
    const next = !soloOn;
    setSoloOn(next);
    engine.setMonitorBand?.(next ? (params.focusHz ?? 220) : null);
  };

  const pointerToParams = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const el = canvasRef.current;
    if (!el || !onParam) return;
    const rect = el.getBoundingClientRect();
    const cw = Math.max(1, rect.width);
    const ch = Math.max(1, rect.height);
    const F_LO = 30;
    const F_HI = 16000;
    const x = Math.min(cw, Math.max(0, event.clientX - rect.left));
    const y = Math.min(ch, Math.max(0, event.clientY - rect.top));
    const focus = F_LO * Math.pow(F_HI / F_LO, x / cw);
    const cp: SkrutkaCurveParams = {
      dispersion: paramsRef.current.dispersion ?? 0.35,
      punch: paramsRef.current.punch ?? 0,
      punchHz: paramsRef.current.punchHz ?? 0,
      punchMix: paramsRef.current.punchMix ?? 1,
      focusHz: focus,
      spread: paramsRef.current.spread ?? 0,
      shape: paramsRef.current.shape ?? 0,
    };
    // The y axis maps to the same normalization the draw uses for the NEW
    // focus/dispersion, so the peak follows the pointer exactly.
    const maxMs = Math.max(0.05, skrutkaPeakDelay(cp, 48000).ms * 1.12);
    const targetMs = Math.max(0, ((ch - 3 - y) / (ch - 6)) * maxMs);
    const dispersion = skrutkaDispersionForPeakMs(cp, 48000, targetMs);
    onParam("focusHz", Math.round(focus));
    onParam("dispersion", Math.round(dispersion * 1000) / 1000);
  };

  const chips = [
    `SHAPE ${SKRUTKA_SHAPE_LABELS[Math.max(0, Math.min(3, Math.round(params.shape ?? 0)))]}`,
    Math.abs(params.dyn ?? 0) > 1e-4
      ? `DYN ${(params.dyn ?? 0) > 0 ? "ATTACK" : "BODY"} ${Math.round(Math.abs(params.dyn ?? 0) * 100)}%`
      : "DYN OFF",
    `KEY ${["OFF", "PUMP", "DUCK"][Math.max(0, Math.min(2, Math.round(params.keyMode ?? 0)))]}`,
    (params.lfoDepth ?? 0) > 1e-4
      ? `LFO ${SKRUTKA_LFO_SHAPE_LABELS[Math.max(0, Math.min(2, Math.round(params.lfoShape ?? 0)))]} ${Math.round((params.lfoDepth ?? 0) * 100)}%`
      : "LFO OFF",
  ];

  return (
    <section className={`skrutka-panel${docked ? " docked" : ""}`} aria-label="SKRUTKA group delay">
      {degraded && <div className="skrutka-degraded">AudioWorklet unavailable — SKRUTKA is bypassed (1:1 signal)</div>}
      <div className="skrutka-head">
        <span className="skrutka-readout" ref={readoutRef}>
          — no delay hump
        </span>
        <span className="skrutka-hint">drag: focus × dispersion — L solid, R dashed</span>
        <button
          type="button"
          className={`btn btn-small skrutka-solo${soloOn ? " on" : ""}`}
          aria-pressed={soloOn}
          onClick={toggleSolo}
          title="Audition only the band around FOCUS. Monitor only — never in exports."
        >
          BAND SOLO
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="skrutka-viz"
        onPointerDown={(event) => {
          if (!onParam) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          onGestureStart?.();
          pointerToParams(event);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          pointerToParams(event);
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          onGestureEnd?.();
        }}
        onPointerCancel={() => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          onGestureEnd?.();
        }}
      />
      <div className="skrutka-chips">
        {chips.map((chip) => (
          <span key={chip} className="skrutka-chip">
            {chip}
          </span>
        ))}
      </div>
    </section>
  );
}
