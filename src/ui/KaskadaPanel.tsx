import { useEffect, useRef } from "react";
import { useServices } from "./context";

/**
 * Kaskáda dual-spectrum display (docs/kaskada-architecture.md — Phase 2
 * "dual spectrum", delivered ahead of unmask/reverse because it is pure
 * UI + a gated analysis tap in the worklet).
 *
 * Two traces over one log-frequency axis: the DRY input (grey) and the
 * DELAY bus (amber — post loop-EQ/drive/spread, pre-mix/pre-level, so the
 * panel shows what the echoes contain even with MIX closed). The dashed
 * cyan curve is the loop-EQ magnitude response computed from the current
 * TONE LP/HP params — the same 72-band geometry the worklet folds into.
 *
 * Display-is-the-control-surface: the LP/HP handles sit ON the curve and
 * drag horizontally (log axis). A drag previews through the engine
 * (audible mid-drag) and commits once on release via onParam — the same
 * preview/commit contract the Ultina panel uses. The red UNMASK curve
 * hangs from the top edge: the solver's 32-band reduction profile.
 *
 * Draw discipline follows Meter.tsx: a 15 Hz poll copies the latest meter
 * frame into a ref and paints straight to the canvas — zero React state
 * on the hot path. Metering is gated: the engine enables the worklet's
 * analysis only while this panel is mounted.
 */

/** RBJ biquad magnitude (dB) — mirrors the worklet's lpCoeffs/hpCoeffs. */
function biquadMagDb(c: { b0: number; b1: number; b2: number; a1: number; a2: number }, w: number): number {
  const cw1 = Math.cos(w);
  const sw1 = Math.sin(w);
  const cw2 = Math.cos(2 * w);
  const sw2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw1 + c.b2 * cw2;
  const ni = c.b1 * sw1 + c.b2 * sw2;
  const dr = 1 + c.a1 * cw1 + c.a2 * cw2;
  const di = c.a1 * sw1 + c.a2 * sw2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-12);
}

function lpCoeffs(freq: number, sr: number) {
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 / Math.SQRT2);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function hpCoeffs(freq: number, sr: number) {
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 / Math.SQRT2);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

const BANDS = 72;
const F_MIN = 20;
const F_MAX = 20000;
const DB_FLOOR = -90;
const LOG_RANGE = Math.log(F_MAX / F_MIN);

/** Registry ranges for the draggable loop-EQ handles. */
const TONE_RANGES = {
  toneLp: { min: 500, max: 12000 },
  toneHp: { min: 20, max: 800 },
} as const;

type ToneParamId = keyof typeof TONE_RANGES;

/** Loop-EQ response in dB at an arbitrary frequency (two cascaded biquads
 *  per side) — used by both the drawn curve and the handle hit-testing. */
function eqDbAtFreq(freq: number, toneLpHz: number, toneHpHz: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  return 2 * biquadMagDb(lpCoeffs(toneLpHz, sr), w) + 2 * biquadMagDb(hpCoeffs(toneHpHz, sr), w);
}

function eqDbAtBand(band: number, toneLpHz: number, toneHpHz: number, sr: number): number {
  const center = F_MIN * Math.pow(F_MAX / F_MIN, (band + 0.5) / BANDS);
  return eqDbAtFreq(center, toneLpHz, toneHpHz, sr);
}

export function KaskadaPanel({
  trackId,
  fxId,
  params,
  degraded,
  onParam,
  docked = false,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  onParam?: (paramId: string, value: number) => void;
  docked?: boolean;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metersRef = useRef<Float32Array | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // Drag state lives outside React: the draw loop reads it for the handle
  // highlight and the live curve override; commits go through onParam once.
  const dragRef = useRef<{ param: ToneParamId; freq: number } | null>(null);
  const hoverRef = useRef<ToneParamId | null>(null);
  // Latest-commit ref: the effect below must not re-subscribe (and flap the
  // engine's meters gate) just because the parent passed a fresh inline
  // callback — read the current one at release time instead.
  const onParamRef = useRef(onParam);
  onParamRef.current = onParam;

  useEffect(() => {
    const engineWithMeters = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
      previewFxParam?: (trackId: string, fxId: string, paramId: string, value: number) => void;
    };
    // Only a mounted panel consumes meters — the engine gates the worklet's
    // FFT so a closed Kaskáda costs zero analysis CPU.
    engineWithMeters.setFxMetersEnabled?.(trackId, fxId, true);

    // Keep the backing store at the laid-out size without React re-renders.
    const canvas = canvasRef.current;
    let observer: ResizeObserver | null = null;
    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        const w = Math.max(200, Math.floor(canvas.clientWidth));
        const h = Math.max(60, Math.floor(canvas.clientHeight));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      });
      observer.observe(canvas);
    }

    // Nominal rate for the EQ overlay only — the engine context is private
    // and a passive panel must not force one into existence. The 44.1/48 kHz
    // difference shifts the biquad response by well under a pixel, and the
    // trace x-positions are rate-independent (the worklet folds into the
    // same 20 Hz–20 kHz band geometry at any rate).
    const sr = 48000;

    const cssWidth = () => {
      const cvs = canvasRef.current;
      if (!cvs) return 600;
      return cvs.clientWidth || cvs.width;
    };
    const freqToX = (freq: number) => (cssWidth() * Math.log(freq / F_MIN)) / LOG_RANGE;
    const xToFreq = (x: number) => F_MIN * Math.exp((x / cssWidth()) * LOG_RANGE);
    const clampParam = (param: ToneParamId, freq: number) =>
      Math.min(TONE_RANGES[param].max, Math.max(TONE_RANGES[param].min, freq));
    const handleFreq = (param: ToneParamId) => {
      const dragged = dragRef.current;
      if (dragged && dragged.param === param) return dragged.freq;
      return paramsRef.current[param] ?? (param === "toneLp" ? 4500 : 150);
    };
    const handleY = (freq: number, h: number) =>
      h * 0.25 - (eqDbAtFreq(freq, handleFreq("toneLp"), handleFreq("toneHp"), sr) / 48) * (h * 0.6);

    const dbToY = (db: number, h: number) => h * (1 - (Math.max(DB_FLOOR, Math.min(0, db)) - DB_FLOOR) / -DB_FLOOR);

    const draw = () => {
      const cvs = canvasRef.current;
      const ctx = cvs?.getContext("2d");
      if (!cvs || !ctx) return;
      const w = cvs.width;
      const h = cvs.height;
      if (w < 2 || h < 2) return;
      ctx.clearRect(0, 0, w, h);

      // Grid: horizontal dB lines + frequency ticks
      ctx.lineWidth = 1;
      ctx.font = "9px monospace";
      for (let db = -20; db > DB_FLOOR; db -= 20) {
        const y = Math.round(dbToY(db, h)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      for (const [freq, label] of [
        [100, "100"],
        [1000, "1k"],
        [10000, "10k"],
      ] as [number, string][]) {
        const x = Math.round((w * Math.log(freq / F_MIN)) / LOG_RANGE) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(label, x + 2, h - 3);
      }

      // Loop-EQ overlay (dashed): gain curve from the live TONE params
      const lpFreq = handleFreq("toneLp");
      const hpFreq = handleFreq("toneHp");
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.beginPath();
      for (let b = 0; b < BANDS; b++) {
        const x = ((b + 0.5) / BANDS) * w;
        // EQ is a gain curve: anchor 0 dB at the 1/4-height line so cuts
        // sweep downward without burying the traces.
        const y = h * 0.25 - (eqDbAtBand(b, lpFreq, hpFreq, sr) / 48) * (h * 0.6);
        if (b === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // LP / HP handles ON the curve (display is the control surface)
      for (const param of ["toneLp", "toneHp"] as ToneParamId[]) {
        const freq = handleFreq(param);
        const hx = (freqToX(freq) / cssWidth()) * w; // CSS px -> backing px
        const hy = handleY(freq, h);
        const active = dragRef.current?.param === param;
        const hovered = hoverRef.current === param;
        ctx.beginPath();
        ctx.arc(hx, hy, active ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? "#22d3ee" : hovered ? "rgba(34,211,238,0.85)" : "rgba(34,211,238,0.6)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.stroke();
        ctx.fillStyle = active ? "#22d3ee" : "rgba(34,211,238,0.8)";
        ctx.fillText(param === "toneLp" ? "LP" : "HP", hx + 7, hy - 5);
      }

      const meters = metersRef.current;
      if (!meters || meters.length < BANDS * 2) return;

      // UNMASK reduction profile (red, hangs from the top): 32 solver bands,
      // 0…12 dB positive reduction mapped downward from the top edge.
      if (meters.length >= BANDS * 2 + 32) {
        ctx.strokeStyle = "rgba(248,113,113,0.85)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let b = 0; b < 32; b++) {
          const x = ((b + 0.5) / 32) * w;
          const y = (Math.min(12, Math.max(0, meters[BANDS * 2 + b])) / 12) * (h * 0.4);
          if (b === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Tick marking the 12 dB ceiling
        ctx.strokeStyle = "rgba(248,113,113,0.25)";
        ctx.beginPath();
        ctx.moveTo(0, 0.5);
        ctx.lineTo(w, 0.5);
        ctx.stroke();
      }

      // DRY trace (dim)
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let b = 0; b < BANDS; b++) {
        const x = ((b + 0.5) / BANDS) * w;
        const y = dbToY(meters[b], h);
        if (b === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // DELAY trace (accent) + soft fill
      ctx.beginPath();
      for (let b = 0; b < BANDS; b++) {
        const x = ((b + 0.5) / BANDS) * w;
        const y = dbToY(meters[BANDS + b], h);
        if (b === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineTo(((BANDS - 0.5) / BANDS) * w, h);
      ctx.lineTo(w / BANDS / 2, h);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "#f59e0b26");
      gradient.addColorStop(1, "#f59e0b05");
      ctx.fillStyle = gradient;
      ctx.fill();
    };

    const id = setInterval(() => {
      const engine = services.engine as typeof services.engine & {
        getFxMeters?: (trackId: string, fxId: string) => unknown;
      };
      const frame = engine.getFxMeters?.(trackId, fxId);
      if (frame instanceof Float32Array) metersRef.current = frame;
      draw();
    }, 66);
    // Initial paint (grid + EQ curve before the first meter frame lands).
    requestAnimationFrame(draw);

    // ── Drag interaction for the LP/HP handles ──
    // Hit test runs in CSS pixels; both handles sit ON the curve, so the
    // nearest within radius wins. Dragging previews through the engine
    // (audible immediately) and commits once via onParam on release.
    const localX = (e: PointerEvent) => {
      const cvs = canvasRef.current;
      if (!cvs) return 0;
      const rect = cvs.getBoundingClientRect();
      return e.clientX - rect.left;
    };
    const hitHandle = (e: PointerEvent): ToneParamId | null => {
      const cvs = canvasRef.current;
      if (!cvs) return null;
      const rect = cvs.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const h = cvs.clientHeight || cvs.height;
      let best: ToneParamId | null = null;
      let bestDist = 18;
      for (const param of ["toneLp", "toneHp"] as ToneParamId[]) {
        const dx = freqToX(handleFreq(param)) - px;
        const dy = handleY(handleFreq(param), h) - py;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = param;
        }
      }
      return best;
    };
    const onPointerDown = (e: PointerEvent) => {
      const param = hitHandle(e);
      if (!param) return;
      dragRef.current = { param, freq: handleFreq(param) };
      try {
        canvasRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // jsdom/old browsers without pointer capture — drag still works
      }
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const cvs = canvasRef.current;
      if (!cvs) return;
      if (!drag) {
        const hovered = hitHandle(e);
        if (hovered !== hoverRef.current) {
          hoverRef.current = hovered;
          cvs.style.cursor = hovered ? "ew-resize" : "default";
        }
        return;
      }
      const freq = clampParam(drag.param, xToFreq(localX(e)));
      drag.freq = freq;
      engineWithMeters.previewFxParam?.(trackId, fxId, drag.param, freq);
      draw();
    };
    const onPointerUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      onParamRef.current?.(drag.param, drag.freq);
    };
    const onPointerLeave = () => {
      hoverRef.current = null;
      const cvs = canvasRef.current;
      if (cvs && !dragRef.current) cvs.style.cursor = "default";
    };

    const cvs = canvasRef.current;
    if (cvs) {
      cvs.addEventListener("pointerdown", onPointerDown);
      cvs.addEventListener("pointermove", onPointerMove);
      cvs.addEventListener("pointerup", onPointerUp);
      cvs.addEventListener("pointercancel", onPointerUp);
      cvs.addEventListener("pointerleave", onPointerLeave);
    }

    return () => {
      engineWithMeters.setFxMetersEnabled?.(trackId, fxId, false);
      clearInterval(id);
      observer?.disconnect();
      const cvs = canvasRef.current;
      if (cvs) {
        cvs.removeEventListener("pointerdown", onPointerDown);
        cvs.removeEventListener("pointermove", onPointerMove);
        cvs.removeEventListener("pointerup", onPointerUp);
        cvs.removeEventListener("pointercancel", onPointerUp);
        cvs.removeEventListener("pointerleave", onPointerLeave);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, fxId, services]);

  return (
    <div className={`ryft-spectrum kaskada-spectrum${docked ? " is-docked" : ""}`} data-testid="kaskada-spectrum">
      <div className="ryft-spectrum-legend">
        <span className="ryft-spectrum-title">RYFT / SPECTRUM</span>
        <span className="ryft-spectrum-key">
          <span className="ryft-spectrum-swatch dry" aria-hidden="true" /> DRY
        </span>
        <span className="ryft-spectrum-key">
          <span className="ryft-spectrum-swatch delay" aria-hidden="true" /> DELAY
        </span>
        <span className="ryft-spectrum-key">
          <span className="ryft-spectrum-swatch loop-eq" aria-hidden="true" /> LOOP EQ
        </span>
        <span className="ryft-spectrum-key">
          <span className="ryft-spectrum-swatch unmask" aria-hidden="true" /> UNMASK
        </span>
        <span className="ryft-spectrum-hint">DRAG LP / HP ⟷</span>
        {degraded && <span className="ryft-spectrum-warning">BYPASSED — NO ANALYSIS</span>}
      </div>
      <canvas
        ref={canvasRef}
        className="ryft-spectrum-canvas"
        width={600}
        height={110}
        style={{
          height: docked ? 88 : 110,
          touchAction: "none",
        }}
        aria-label="RYFT dual spectrum — dry and delay bus, drag LP/HP handles"
        role="img"
      />
    </div>
  );
}
