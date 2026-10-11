import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SKRUTKA_LFO_SHAPE_LABELS, SKRUTKA_SHAPE_LABELS } from "../effects/definitions";
import {
  SKRUTKA_PUNCH_R_HARD_MAX,
  SKRUTKA_R_HARD_MAX,
  skrutkaComponentCurve,
  skrutkaDelayAt,
  skrutkaDispersionForPeakMs,
  skrutkaGroupDelaySamples,
  skrutkaLfoFocusRange,
  skrutkaPeakDelay,
  skrutkaPunchFocus,
  type SkrutkaChannel,
  type SkrutkaCurveParams,
} from "../effects/skrutka-curve";
import {
  TWIST_CURVE_SLOTS,
  morphTwistParams,
  pickTwistCurveParams,
  readTwistCurvesState,
  type TwistCurveSlot,
  type TwistCurvesState,
} from "../effects/skrutka-curves";
import { TWIST_SCENE_PACK, findTwistScenePair, type TwistScenePair } from "../effects/skrutka-scene-pack";
import type { SkrutkaMeterFrame } from "../audio-worklets/skrutka-node";
import { useServices } from "./context";

const PANEL_SAMPLE_RATE_FALLBACK = 48_000;

export function skrutkaPanelSampleRate(sampleRate: number | null | undefined): number {
  return typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : PANEL_SAMPLE_RATE_FALLBACK;
}

/**
 * TWIST (skrutka) panel — v2: the group-delay curve that IS the effect,
 * now editable, dynamic-aware and morphable.
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
 * CURVE SNAPSHOTS (v2.3): STORE A / STORE B capture the current rack params;
 * the MORPH knob (a real rack param, so automation lanes and intensity-sourced
 * macros can drive it) blends between the stored curves — the drawn live
 * curve is the EFFECTIVE one, and A/B ghosts show where you morphed from.
 *
 * BAND SOLO auditions only the band the hump moves (monitor-only, live path,
 * released on unmount). The live dots follow the processor telemetry
 * (lfo phase + current radius/punch) so the automation is visible, not inferred.
 */
export function SkrutkaPanel({
  trackId,
  fxId,
  params,
  degraded,
  docked = false,
  deviceState,
  onParam,
  onGestureStart,
  onGestureEnd,
  onCurvesStateChange,
  sceneBound = false,
  onApplyScenePair,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded: boolean;
  docked?: boolean;
  deviceState?: { kind: string; data: Record<string, unknown> } | null;
  onParam?: (paramId: string, value: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onCurvesStateChange?: (next: TwistCurvesState) => void;
  /** True when MORPH already rides the project's scene intensity. */
  sceneBound?: boolean;
  /** Apply a curated scene pack pair (one undoable command in the rack). */
  onApplyScenePair?: (pair: TwistScenePair) => void;
}) {
  const services = useServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<SkrutkaMeterFrame | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const curves = readTwistCurvesState(deviceState);
  const curvesRef = useRef<TwistCurvesState | undefined>(curves);
  curvesRef.current = curves;
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

      const sampleRate = skrutkaPanelSampleRate(engine.getLiveAudioContext()?.sampleRate);
      const baseParams = paramsRef.current;
      const cpOf = (map: Record<string, number>): SkrutkaCurveParams => ({
        dispersion: map.dispersion ?? 0.35,
        punch: map.punch ?? 0,
        punchHz: map.punchHz ?? 0,
        punchMix: map.punchMix ?? 1,
        focusHz: map.focusHz ?? 220,
        spread: map.spread ?? 0,
        shape: map.shape ?? 0,
        field: map.field ?? 0,
      });
      // CURVE SNAPSHOTS: everything drawn/below is the EFFECTIVE (morphed)
      // state, so the panel always shows what the DSP is playing.
      const curveState = curvesRef.current;
      const p = morphTwistParams(baseParams, curveState, baseParams.morph ?? 0);
      const cp = cpOf(p);
      // FIELD switches the drawn components: legacy L/R, or the M/S field.
      const fieldActive = Math.abs(cp.field ?? 0) > 1e-4;
      const chA: SkrutkaChannel = fieldActive ? "M" : "L";
      const chB: SkrutkaChannel = fieldActive ? "S" : "R";
      const curveA = skrutkaComponentCurve(cp, sampleRate, chA, 160, F_LO, F_HI);
      const curveB = skrutkaComponentCurve(cp, sampleRate, chB, 160, F_LO, F_HI);
      // Stored-curve ghosts (A then B): where the MORPH knob can travel.
      const ghostA = curveState?.slots.A
        ? skrutkaComponentCurve(
            cpOf(morphTwistParams(baseParams, { slots: { A: curveState.slots.A } }, 0)),
            sampleRate,
            chA,
            160,
            F_LO,
            F_HI,
          )
        : null;
      const ghostB = curveState?.slots.B
        ? skrutkaComponentCurve(
            cpOf(morphTwistParams(baseParams, { slots: { B: curveState.slots.B } }, 0)),
            sampleRate,
            chA,
            160,
            F_LO,
            F_HI,
          )
        : null;
      const dynArmed = Math.abs(p.dyn ?? 0) > 1e-4 || (p.keyMode ?? 0) > 0;
      const driven = dynArmed ? skrutkaComponentCurve(cp, sampleRate, chA, 160, F_LO, F_HI, SKRUTKA_R_HARD_MAX) : null;
      // DYNAMIC PUNCH (v2.2): the punch radius is driven from its static
      // mapping up to the hard ceiling — its own band when armed.
      const punchDynArmed = Math.abs(p.dynPunch ?? 0) > 1e-4;
      const drivenPunch = punchDynArmed
        ? skrutkaComponentCurve(cp, sampleRate, chA, 160, F_LO, F_HI, undefined, SKRUTKA_PUNCH_R_HARD_MAX)
        : null;
      let maxMs = 0.05;
      for (const point of curveA) maxMs = Math.max(maxMs, point.ms);
      for (const point of curveB) maxMs = Math.max(maxMs, point.ms);
      if (driven) for (const point of driven) maxMs = Math.max(maxMs, point.ms);
      if (drivenPunch) for (const point of drivenPunch) maxMs = Math.max(maxMs, point.ms);
      if (ghostA) for (const point of ghostA) maxMs = Math.max(maxMs, point.ms);
      if (ghostB) for (const point of ghostB) maxMs = Math.max(maxMs, point.ms);
      maxMs *= 1.12;

      const yOf = (ms: number) => ch - (ms / maxMs) * (ch - 6) - 3;

      // Stored-curve ghosts (faint, dotted): A amber, B blue.
      const strokeGhost = (curve: { freqHz: number; ms: number }[], color: string) => {
        c2d.strokeStyle = color;
        c2d.setLineDash([2, 3]);
        c2d.beginPath();
        for (let i = 0; i < curve.length; i++) {
          const x = xOf(curve[i]!.freqHz, cw);
          const y = yOf(curve[i]!.ms);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
      };
      if (ghostA) strokeGhost(ghostA, "rgba(255, 190, 120, 0.5)");
      if (ghostB) strokeGhost(ghostB, "rgba(120, 200, 255, 0.45)");

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
        for (let i = 0; i < curveA.length; i++) c2d.lineTo(xOf(curveA[i]!.freqHz, cw), yOf(curveA[i]!.ms));
        for (let i = driven.length - 1; i >= 0; i--) c2d.lineTo(xOf(driven[i]!.freqHz, cw), yOf(driven[i]!.ms));
        c2d.closePath();
        c2d.fill();
        c2d.strokeStyle = "rgba(255, 190, 120, 0.35)";
        c2d.setLineDash([2, 4]);
        c2d.beginPath();
        for (let i = 0; i < driven.length; i++) {
          const x = xOf(driven[i]!.freqHz, cw);
          const y = yOf(driven[i]!.ms);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
      }

      // DYNAMIC PUNCH driven band (a cooler hue so it reads as the short,
      // transient-scale stage rather than the long hump).
      if (drivenPunch) {
        c2d.fillStyle = "rgba(150, 205, 255, 0.10)";
        c2d.beginPath();
        for (let i = 0; i < curveA.length; i++) c2d.lineTo(xOf(curveA[i]!.freqHz, cw), yOf(curveA[i]!.ms));
        for (let i = drivenPunch.length - 1; i >= 0; i--)
          c2d.lineTo(xOf(drivenPunch[i]!.freqHz, cw), yOf(drivenPunch[i]!.ms));
        c2d.closePath();
        c2d.fill();
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

      // Component A (solid accent) and B (dashed).
      const strokeCurve = (curve: { freqHz: number; ms: number }[], color: string, dash: number[]) => {
        c2d.strokeStyle = color;
        c2d.lineWidth = 1.5;
        c2d.setLineDash(dash);
        c2d.beginPath();
        for (let i = 0; i < curve.length; i++) {
          const x = xOf(curve[i]!.freqHz, cw);
          const y = yOf(curve[i]!.ms);
          if (i === 0) c2d.moveTo(x, y);
          else c2d.lineTo(x, y);
        }
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.lineWidth = 1;
      };
      strokeCurve(curveA, "rgba(255, 170, 120, 0.95)", []);
      strokeCurve(curveB, "rgba(120, 200, 255, 0.85)", [4, 4]);

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
        const ms = (skrutkaDelayAt(cp, sampleRate, fEff, radius, chA) / sampleRate) * 1000;
        const x = xOf(fEff, cw);
        const y = yOf(Math.min(ms, maxMs));
        c2d.fillStyle = "rgba(255, 255, 255, 0.92)";
        c2d.beginPath();
        c2d.arc(x, y, 3, 0, Math.PI * 2);
        c2d.fill();

        // The punch stage has its own current-radius meter. Show its live
        // group-delay point separately so DYNAMIC PUNCH is visible while it moves.
        if (frame.punch > 1e-4) {
          const punchFocus = skrutkaPunchFocus(cp.focusHz, cp.punch, cp.punchHz ?? 0, sampleRate);
          const punchMs =
            (skrutkaGroupDelaySamples(cp, sampleRate, punchFocus, chA, radius, frame.punch) / sampleRate) * 1000;
          c2d.fillStyle = "rgba(150, 205, 255, 0.98)";
          c2d.beginPath();
          c2d.arc(xOf(punchFocus, cw), yOf(Math.min(punchMs, maxMs)), 2.5, 0, Math.PI * 2);
          c2d.fill();
        }
      }

      // Readout: base peak.
      const peak = skrutkaPeakDelay(cp, sampleRate, chA);
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
              punch: typeof raw.punch === "number" && Number.isFinite(raw.punch) ? raw.punch : 0,
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
    const sampleRate = skrutkaPanelSampleRate(services.engine.getLiveAudioContext()?.sampleRate);
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
      field: paramsRef.current.field ?? 0,
    };
    // The y axis maps to the same normalization the draw uses for the NEW
    // focus/dispersion, so the peak follows the pointer exactly.
    const dragChannel: SkrutkaChannel = Math.abs(cp.field ?? 0) > 1e-4 ? "M" : "L";
    const maxMs = Math.max(0.05, skrutkaPeakDelay(cp, sampleRate, dragChannel).ms * 1.12);
    const targetMs = Math.max(0, ((ch - 3 - y) / (ch - 6)) * maxMs);
    const dispersion = skrutkaDispersionForPeakMs(cp, sampleRate, targetMs);
    onParam("focusHz", Math.round(focus));
    onParam("dispersion", Math.round(dispersion * 1000) / 1000);
  };

  // The chips report the EFFECTIVE (morphed) state — what the DSP plays.
  const displayed = morphTwistParams(params, curves, params.morph ?? 0);
  const fieldActive = Math.abs(displayed.field ?? 0) > 1e-4;
  const hasCurve = !!(curves?.slots.A || curves?.slots.B);
  const activePair = findTwistScenePair(curves?.slots);
  const morphPct = Math.round((params.morph ?? 0) * 100);
  const morphMode =
    !curves?.slots.A && !curves?.slots.B
      ? "OFF"
      : curves?.slots.A && curves?.slots.B
        ? "A→B"
        : curves?.slots.A
          ? "A→LIVE"
          : "LIVE→B";
  const chips = [
    `SHAPE ${SKRUTKA_SHAPE_LABELS[Math.max(0, Math.min(3, Math.round(displayed.shape ?? 0)))]}`,
    fieldActive
      ? `FIELD ${Math.round(Math.abs(displayed.field ?? 0) * 100)}% ${(displayed.field ?? 0) > 0 ? "SIDE" : "MID"}`
      : "FIELD STEREO",
    Math.abs(displayed.dyn ?? 0) > 1e-4
      ? `DYN ${(displayed.dyn ?? 0) > 0 ? "ATTACK" : "BODY"} ${Math.round(Math.abs(displayed.dyn ?? 0) * 100)}%`
      : "DYN OFF",
    Math.abs(displayed.dynPunch ?? 0) > 1e-4
      ? `PUNCH-DYN ${(displayed.dynPunch ?? 0) > 0 ? "ATTACK" : "BODY"} ${Math.round(Math.abs(displayed.dynPunch ?? 0) * 100)}%`
      : "PUNCH-DYN OFF",
    `KEY ${["OFF", "PUMP", "DUCK"][Math.max(0, Math.min(2, Math.round(displayed.keyMode ?? 0)))]}`,
    (displayed.lfoDepth ?? 0) > 1e-4
      ? `LFO ${SKRUTKA_LFO_SHAPE_LABELS[Math.max(0, Math.min(2, Math.round(displayed.lfoShape ?? 0)))]} ${Math.round((displayed.lfoDepth ?? 0) * 100)}%`
      : "LFO OFF",
    hasCurve ? `MORPH ${morphPct}% ${morphMode}` : "MORPH OFF",
    ...(sceneBound ? ["SCENE-INTENSITY"] : []),
  ];

  /** Push the curve state straight into the live runtime (mirrors MORPH scenes). */
  const runtimeSetCurves = (a: Record<string, number> | null, b: Record<string, number> | null) => {
    const engine = services.engine as unknown as {
      getFxRuntime?: (trackId: string, fxId: string) => unknown;
    };
    const runtime = engine.getFxRuntime?.(trackId, fxId) as {
      setCurves?: (a: Record<string, number> | null, b: Record<string, number> | null) => void;
    } | null;
    runtime?.setCurves?.(a, b);
  };

  // Undo/redo and project reload can change the persisted snapshots without a
  // STORE/CLEAR click in this panel. Keep the live worklet on the document's
  // authoritative device state whenever that state changes.
  useEffect(() => {
    const state = readTwistCurvesState(deviceState);
    runtimeSetCurves(state?.slots.A ?? null, state?.slots.B ?? null);
  }, [deviceState, fxId, services.engine, trackId]);

  const captureCurve = (slot: TwistCurveSlot) => {
    if (!onCurvesStateChange) return;
    const next: TwistCurvesState = { slots: { ...(curves?.slots ?? {}), [slot]: pickTwistCurveParams(params) } };
    onCurvesStateChange(next);
    runtimeSetCurves(next.slots.A ?? null, next.slots.B ?? null);
  };

  const clearCurves = () => {
    if (!onCurvesStateChange) return;
    onCurvesStateChange({ slots: {} });
    runtimeSetCurves(null, null);
  };

  return (
    <section className={`skrutka-panel${docked ? " docked" : ""}`} aria-label="TWIST group delay">
      {degraded && <div className="skrutka-degraded">AudioWorklet unavailable — TWIST is bypassed (1:1 signal)</div>}
      <div className="skrutka-head">
        <span className="skrutka-readout" ref={readoutRef}>
          — no delay hump
        </span>
        <span className="skrutka-hint">
          {fieldActive
            ? "drag: focus × dispersion — M solid, S dashed"
            : "drag: focus × dispersion — L solid, R dashed"}
        </span>
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
      <div className="skrutka-curves" role="group" aria-label="Curve snapshots">
        {TWIST_CURVE_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={`btn btn-small${curves?.slots[slot] ? " on" : ""}`}
            aria-pressed={!!curves?.slots[slot]}
            onClick={() => captureCurve(slot)}
            disabled={!onCurvesStateChange}
            title={`Store the current rack settings as curve ${slot}`}
          >
            STORE {slot}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-small"
          onClick={clearCurves}
          disabled={!onCurvesStateChange || !hasCurve}
          title="Forget both stored curves"
        >
          CLEAR
        </button>
        <select
          className="skrutka-pack"
          aria-label="Scene pack"
          value={activePair?.id ?? ""}
          disabled={!onApplyScenePair}
          title="Curated A/B pairs for the scene-intensity arc — intro leans A, the drop lands B"
          onChange={(event) => {
            const pair = TWIST_SCENE_PACK.find((candidate) => candidate.id === event.target.value);
            if (!pair) return;
            onApplyScenePair?.(pair);
            runtimeSetCurves({ ...pair.a }, { ...pair.b });
          }}
        >
          {!activePair && <option value="">CUSTOM</option>}
          {TWIST_SCENE_PACK.map((pair) => (
            <option key={pair.id} value={pair.id}>
              {pair.genre} — {pair.label}
            </option>
          ))}
        </select>
        <input
          type="range"
          className="skrutka-morph"
          min={0}
          max={1}
          step={0.01}
          value={params.morph ?? 0}
          aria-label="Curve morph"
          disabled={!hasCurve || !onParam}
          title="Blend between the stored curves — automatable, and an intensity-sourced macro can drive it"
          onPointerDown={() => onGestureStart?.()}
          onPointerUp={() => onGestureEnd?.()}
          onChange={(event) => onParam?.("morph", Number(event.target.value))}
        />
      </div>
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
