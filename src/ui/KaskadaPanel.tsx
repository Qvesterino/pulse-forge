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

/** Loop-EQ response in dB at band b (two cascaded biquads per side). */
function eqDbAtBand(band: number, toneLpHz: number, toneHpHz: number, sr: number): number {
  const center = F_MIN * Math.pow(F_MAX / F_MIN, (band + 0.5) / BANDS);
  const w = (2 * Math.PI * center) / sr;
  const lp = biquadMagDb(lpCoeffs(toneLpHz, sr), w);
  const hp = biquadMagDb(hpCoeffs(toneHpHz, sr), w);
  return 2 * lp + 2 * hp;
}

export function KaskadaPanel({
  trackId,
  fxId,
  params,
  degraded,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metersRef = useRef<Float32Array | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const engineWithMeters = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
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
      const logRange = Math.log(F_MAX / F_MIN);
      for (const [freq, label] of [
        [100, "100"],
        [1000, "1k"],
        [10000, "10k"],
      ] as [number, string][]) {
        const x = Math.round((w * Math.log(freq / F_MIN)) / logRange) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(label, x + 2, h - 3);
      }

      // Loop-EQ overlay (dashed): gain curve from the live TONE params
      const p = paramsRef.current;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.beginPath();
      for (let b = 0; b < BANDS; b++) {
        const x = ((b + 0.5) / BANDS) * w;
        // EQ is a gain curve: anchor 0 dB at the 1/4-height line so cuts
        // sweep downward without burying the traces.
        const y = h * 0.25 - (eqDbAtBand(b, p.toneLp ?? 4500, p.toneHp ?? 150, sr) / 48) * (h * 0.6);
        if (b === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const meters = metersRef.current;
      if (!meters || meters.length < BANDS * 2) return;

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

    return () => {
      engineWithMeters.setFxMetersEnabled?.(trackId, fxId, false);
      clearInterval(id);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, fxId, services]);

  return (
    <div
      className="kaskada-spectrum"
      style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}
      data-testid="kaskada-spectrum"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, letterSpacing: 0.5 }}>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>SPECTRUM</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "rgba(255,255,255,0.55)" }}>
          <span style={{ width: 10, height: 2, background: "rgba(255,255,255,0.35)", display: "inline-block" }} />
          DRY
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "rgba(255,255,255,0.55)" }}>
          <span style={{ width: 10, height: 2, background: "#f59e0b", display: "inline-block" }} />
          DELAY
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "rgba(255,255,255,0.55)" }}>
          <span
            style={{
              width: 10,
              height: 0,
              borderTop: "2px dashed rgba(34,211,238,0.7)",
              display: "inline-block",
            }}
          />
          LOOP EQ
        </span>
        {degraded && <span style={{ color: "#f87171", marginLeft: "auto" }}>bypassed — no analysis</span>}
      </div>
      <canvas
        ref={canvasRef}
        width={600}
        height={110}
        style={{ width: "100%", height: 110, display: "block", borderRadius: 6, background: "rgba(0,0,0,0.35)" }}
        aria-label="Kaskáda dual spectrum — dry and delay bus"
        role="img"
      />
    </div>
  );
}
