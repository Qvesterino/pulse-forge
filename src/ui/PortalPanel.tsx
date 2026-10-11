import { useEffect, useRef, useState } from "react";
import type { PortalMeterFrame } from "../audio-worklets/portal-node";
import { useServices } from "./context";
import { PORTAL_AXIS_MIN_HZ, PORTAL_BAND_COUNT, bandHz, formatAxisHz, hzToX } from "./portalSpectrum";

/**
 * PORTAL panel — the spectrum the device is actually producing.
 *
 * Two traces on a log-frequency axis:
 *
 *   INPUT   the spectrum as analysed, straight from the processor
 *   OUTPUT  the same bins AFTER the mode ran
 *
 * The gap between them is the entire point. In DELAY you watch the feedback
 * tail grow above the source; in RESONATOR you watch the focus band swell and
 * the rest fall away; in FREEZE the input line keeps moving while the output
 * line stops dead and holds. A single spectrum cannot show any of that.
 *
 * WHY IT NEVER RE-DERIVES ANYTHING HOST-SIDE
 * -----------------------------------------
 * The panel draws `bandsIn` / `bandsOut` exactly as the processor measured
 * them. It does NOT recompute a spectrum from FOCUS, FEEDBACK or MIX — a panel
 * that drew the settings would show a clean hump at FOCUS on a resonator that
 * never rang, and a flat line on a delay that was quietly pouring out repeats.
 * The processor's clamp, its contractive feedback ceiling and its FREEZE hold
 * all change the outcome; only the processor knows the final one.
 *
 * HONEST STATES
 * -------------
 * `bypassed`  the rack bypasses the STFT at mix = 0 (that is what keeps the
 *             dry path bit-exact), so there is no frame and no trace. Drawing
 *             zeros as a spectrum would show a silent device that is in fact
 *             passing audio through untouched.
 * `waiting`   telemetry is enabled but the first frame has not landed.
 * `fallback`  the module never loaded; the honest 1:1 bypass is running.
 */

const MODE_LABELS = ["DELAY", "RESONATOR", "FREEZE"] as const;

export function PortalPanel({
  trackId,
  fxId,
  params,
  degraded,
  docked = false,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<PortalMeterFrame | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const delayRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Metering is panel-scoped: closed panels must cost nothing on the audio
  // thread. A missing engine method is tolerated (older host, headless test)
  // and reported, never silently drawn as a dead spectrum.
  useEffect(() => {
    const engine = services.engine as typeof services.engine & {
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    };
    if (!engine.setFxMetersEnabled) {
      setUnavailable(true);
      return;
    }
    engine.setFxMetersEnabled(trackId, fxId, true);
    return () => engine.setFxMetersEnabled?.(trackId, fxId, false);
  }, [services, trackId, fxId]);

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
      const h = Math.max(90, Math.floor(el.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.floor(w * dpr);
      el.height = Math.floor(h * dpr);
    };
    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sizeCanvas);
      observer.observe(canvas);
    }
    sizeCanvas();

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
      const mode = Math.max(0, Math.min(2, Math.round(p.mode ?? 0)));
      const frame = frameRef.current;

      // --- axis: decade gridlines on a log axis ---------------------------
      const xOf = (f: number) => hzToX(f, cw);
      c2d.font = "10px ui-monospace, monospace";
      c2d.textBaseline = "top";
      for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        const x = xOf(hz);
        c2d.strokeStyle = "rgba(255,255,255,0.06)";
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, ch);
        c2d.stroke();
        c2d.fillStyle = "rgba(255,255,255,0.28)";
        c2d.fillText(formatAxisHz(hz), x + 3, ch - 12);
      }

      // --- the band every mode is measured against ----------------------
      // RESONATOR: the focus window the bank concentrates on, so the swelling
      // output line can be read against the exact span it is meant to fill.
      if (mode === 1) {
        const focus = Math.max(PORTAL_AXIS_MIN_HZ, p.focus ?? 1200);
        const oct = Math.max(0.1, p.focusWidth ?? 1);
        const xa = xOf(focus * Math.pow(2, -oct / 2));
        const xb = xOf(focus * Math.pow(2, oct / 2));
        c2d.fillStyle = "rgba(120,200,255,0.10)";
        c2d.fillRect(xa, 0, Math.max(1, xb - xa), ch);
        c2d.strokeStyle = "rgba(120,200,255,0.5)";
        c2d.beginPath();
        c2d.moveTo(xa, 0);
        c2d.lineTo(xa, ch);
        c2d.moveTo(xb, 0);
        c2d.lineTo(xb, ch);
        c2d.stroke();
        c2d.fillStyle = "rgba(120,200,255,0.75)";
        c2d.fillText(`FOCUS ${formatAxisHz(focus)}`, Math.min(cw - 70, xa + 4), 3);
      }

      // DELAY/FREEZE: which spectral region SHIFT feeds back on. The output
      // trace piling up on one side of this line is the shift, made visible.
      if (mode !== 1) {
        const shift = p.shift ?? 0;
        const pivot = 1000;
        const moved = pivot * Math.pow(2, shift / 12);
        const x = xOf(moved);
        c2d.strokeStyle = "rgba(255,190,110,0.55)";
        c2d.setLineDash([4, 4]);
        c2d.beginPath();
        c2d.moveTo(x, 0);
        c2d.lineTo(x, ch);
        c2d.stroke();
        c2d.setLineDash([]);
        if (shift !== 0) {
          c2d.fillStyle = "rgba(255,190,110,0.8)";
          c2d.fillText(`SHIFT ${shift > 0 ? "+" : ""}${shift.toFixed(0)} st`, Math.min(cw - 80, x + 4), 3);
        }
      }

      // --- the traces --------------------------------------------------
      if (!frame) {
        c2d.fillStyle = "rgba(255,255,255,0.35)";
        c2d.fillText("waiting for telemetry", 8, ch / 2 - 6);
        return;
      }

      const trace = (bands: Uint8Array, stroke: string, fill: string, width: number) => {
        c2d.beginPath();
        for (let b = 0; b < bands.length; b++) {
          const x = xOf(bandHz(b));
          const h = (bands[b]! / 255) * (ch - 16);
          if (b === 0) c2d.moveTo(x, ch - 14 - h);
          else c2d.lineTo(x, ch - 14 - h);
        }
        c2d.strokeStyle = stroke;
        c2d.lineWidth = width;
        c2d.stroke();
        c2d.lineTo(cw, ch - 14);
        c2d.lineTo(0, ch - 14);
        c2d.closePath();
        c2d.fillStyle = fill;
        c2d.fill();
      };

      // Input first and dim, so the output line reads on top of it.
      trace(frame.bandsIn, "rgba(150,170,200,0.55)", "rgba(120,140,180,0.10)", 1);
      trace(frame.bandsOut, "rgba(125,211,252,0.95)", "rgba(80,170,255,0.16)", 1.6);

      c2d.fillStyle = "rgba(150,170,200,0.8)";
      c2d.fillText("IN", 8, 3);
      c2d.fillStyle = "rgba(125,211,252,0.95)";
      c2d.fillText("OUT", 28, 3);
    };

    const timer = window.setInterval(() => {
      const raw = engine.getFxMeters?.(trackId, fxId) as Partial<PortalMeterFrame> | null;
      // Validate rather than trust. A frame missing either trace is dropped
      // whole: half a trace would draw a device that is quieter or brighter
      // than the one actually running.
      const ok =
        !!raw &&
        typeof raw.peak === "number" &&
        Number.isFinite(raw.peak) &&
        raw.bandsIn instanceof Uint8Array &&
        raw.bandsIn.length === PORTAL_BAND_COUNT &&
        raw.bandsOut instanceof Uint8Array &&
        raw.bandsOut.length === PORTAL_BAND_COUNT;
      frameRef.current = ok ? (raw as PortalMeterFrame) : null;

      const p = paramsRef.current;
      const frame = frameRef.current;
      const mix = p.mix ?? 0;
      const engaged = mix > 0.001;

      let label: string;
      let colour = "rgba(255,255,255,0.55)";
      if (degraded) {
        label = "FALLBACK — 1:1 bypass";
        colour = "rgba(255,170,120,0.9)";
      } else if (!engaged) {
        // mix = 0 short-circuits the STFT by design, so there is genuinely no
        // frame to show. Saying so is honest; drawing zeros would not be.
        label = "BYPASSED (MIX 0)";
      } else if (!frame) {
        label = unavailable ? "TELEMETRY UNAVAILABLE" : "waiting for telemetry";
      } else {
        label = `${MODE_LABELS[Math.max(0, Math.min(2, Math.round(p.mode ?? 0)))]} · ${(
          (frame.bandsOut.reduce((s, v) => s + v, 0) / (PORTAL_BAND_COUNT * 255)) *
          100
        ).toFixed(0)}%`;
        colour = "rgba(125,211,252,0.95)";
      }
      if (stateRef.current) {
        stateRef.current.textContent = label;
        stateRef.current.style.color = colour;
      }
      if (delayRef.current) {
        delayRef.current.textContent = frame && engaged && !degraded ? `${frame.delaySec.toFixed(3)} s` : "— s";
      }
      if (peakRef.current) {
        peakRef.current.textContent =
          frame && engaged && !degraded ? `${(20 * Math.log10(Math.max(1e-6, frame.peak))).toFixed(1)} dB` : "— dB";
      }
      draw();
    }, 66);

    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
    };
  }, [services, trackId, fxId, degraded, unavailable]);

  return (
    <div className="portal-panel" data-docked={docked ? "1" : undefined}>
      <div className="portal-panel__readout">
        <span ref={stateRef} className="portal-panel__state">
          waiting for telemetry
        </span>
        <span className="portal-panel__readouts">
          <span ref={delayRef}>— s</span>
          <span ref={peakRef}>— dB</span>
        </span>
      </div>
      <canvas ref={canvasRef} className="portal-panel__canvas" aria-label="PORTAL spectrum: input and output" />
      <div className="portal-panel__legend">
        <span className="portal-panel__legend-in">IN — analysed</span>
        <span className="portal-panel__legend-out">OUT — after the mode</span>
      </div>
    </div>
  );
}
