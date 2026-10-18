import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SKRUTKA_LFO_SHAPE_LABELS, SKRUTKA_SHAPE_LABELS } from "../effects/definitions";
import {
  SKRUTKA_PUNCH_R_HARD_MAX,
  SKRUTKA_R_HARD_MAX,
  skrutkaComponentCurve,
  skrutkaDelayAt,
  skrutkaDynRadiusRange,
  skrutkaDispersionForPeakMs,
  skrutkaGroupDelaySamples,
  skrutkaLfoFocusRange,
  skrutkaOutputComponentCurve,
  skrutkaOutputGroupDelaySamples,
  skrutkaOutputMagnitudeDbAt,
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
import { skrutkaParams } from "../effects/definitions";
import { useServices } from "./context";

/**
 * The REACHABLE focus range, read from the authoritative param definition
 * (skrutkaParams → focusHz is min 40 / max 4000, log taper).
 *
 * Audit 17: the drag used to hardcode its own 30…16000 span while
 * setEffectParam clamps to the ParamDef on commit and previewFxParam does NOT
 * clamp at all. Dragging into the unreachable part of the axis therefore
 * auditioned a value the document would reject: the hump audibly moved, the
 * drawing did not (it reads the document), and releasing snapped the sound
 * back. One source of truth now — the display axis below is a different,
 * deliberate question (it shows the whole band the effect touches).
 */
const FOCUS_MIN = skrutkaParams.find((p) => p.id === "focusHz")?.min ?? 40;
const FOCUS_MAX = skrutkaParams.find((p) => p.id === "focusHz")?.max ?? 4000;

/**
 * The DISPLAY band: the whole range the disperser touches, ticked at 100/1k/10k.
 * Deliberately wider than the reachable FOCUS range — it is a view of the
 * spectrum, not the parameter's own span. Defined ONCE: audit 17 found this
 * span hardcoded twice in this file (draw + drag), which is how the drag and
 * the drawing drifted apart in the first place.
 */
const BAND_LO = 30;
const BAND_HI = 16000;

const PANEL_SAMPLE_RATE_FALLBACK = 48_000;
type SkrutkaViewMode = "wet-delay" | "output-delay" | "output-level";
type SkrutkaPlotPoint = { freqHz: number; ms: number | null; db: number };

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
  keySourceConnected = false,
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
  keySourceConnected?: boolean;
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
  const dynamicMeterRef = useRef<HTMLDivElement>(null);
  const dynamicFillRef = useRef<HTMLSpanElement>(null);
  const dynamicValueRef = useRef<HTMLSpanElement>(null);
  const keyMeterRef = useRef<HTMLDivElement>(null);
  const keyFillRef = useRef<HTMLSpanElement>(null);
  const keyValueRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<SkrutkaMeterFrame | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const curves = readTwistCurvesState(deviceState);
  const curvesRef = useRef<TwistCurvesState | undefined>(curves);
  curvesRef.current = curves;
  const [soloOn, setSoloOn] = useState(false);
  const [viewMode, setViewMode] = useState<SkrutkaViewMode>("wet-delay");
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

    const F_LO = BAND_LO;
    const F_HI = BAND_HI;
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
      const frame = degraded ? null : frameRef.current;
      const paintMeter = (
        meter: HTMLDivElement | null,
        fill: HTMLSpanElement | null,
        readout: HTMLSpanElement | null,
        percent: number | null,
        text: string,
      ) => {
        if (!meter || !fill || !readout) return;
        const value = percent == null ? 0 : Math.min(100, Math.max(0, percent));
        fill.style.width = `${value}%`;
        meter.setAttribute("aria-valuenow", String(Math.round(value)));
        meter.setAttribute("aria-valuetext", text);
        readout.textContent = text;
      };
      if (!frame) {
        const unavailableText = degraded ? "BYPASSED" : "Waiting for live audio";
        paintMeter(dynamicMeterRef.current, dynamicFillRef.current, dynamicValueRef.current, null, unavailableText);
        paintMeter(keyMeterRef.current, keyFillRef.current, keyValueRef.current, null, unavailableText);
      } else {
        const dynamicActive = Math.abs(frame.dyn) > 1e-4 || Math.abs(frame.dynPunch) > 1e-4;
        const dynamicPercent = dynamicActive ? Math.round(frame.env * 100) : 0;
        paintMeter(
          dynamicMeterRef.current,
          dynamicFillRef.current,
          dynamicValueRef.current,
          dynamicPercent,
          dynamicActive ? `${dynamicPercent}%` : "OFF",
        );

        if (frame.keyMode <= 1e-4) {
          paintMeter(keyMeterRef.current, keyFillRef.current, keyValueRef.current, 0, "OFF");
        } else if (!keySourceConnected) {
          paintMeter(keyMeterRef.current, keyFillRef.current, keyValueRef.current, 0, "NO SOURCE");
        } else {
          const pumping = frame.keyMode < 1.5;
          const response = pumping ? frame.key - 1 : (1 - frame.key) / 0.7;
          const keyPercent = Math.round(Math.min(1, Math.max(0, response)) * 100);
          const keyText = `${pumping ? "PUMP" : "DUCK"} ${keyPercent}% · ×${frame.key.toFixed(2)}`;
          paintMeter(keyMeterRef.current, keyFillRef.current, keyValueRef.current, keyPercent, keyText);
        }
      }
      const cpOf = (map: Record<string, number>): SkrutkaCurveParams => ({
        dispersion: map.dispersion ?? 0.35,
        punch: map.punch ?? 0,
        punchHz: map.punchHz ?? 0,
        punchMix: map.punchMix ?? 1,
        focusHz: map.focusHz ?? 220,
        spread: map.spread ?? 0,
        shape: map.shape ?? 0,
        field: map.field ?? 0,
        mix: map.mix ?? 1,
        output: map.output ?? 0,
      });
      // CURVE SNAPSHOTS: start from the effective project state. A validated
      // worklet frame takes precedence so automation, scene intensity and
      // parameter smoothing are visible in the curve too.
      const curveState = curvesRef.current;
      const p = morphTwistParams(baseParams, curveState, baseParams.morph ?? 0);
      const liveParams = frame
        ? {
            ...p,
            dispersion: frame.dispersion,
            punch: frame.punch,
            punchHz: frame.punchHz,
            punchMix: frame.punchMix,
            focusHz: frame.focusHz,
            shape: frame.shape,
            spread: frame.spread,
            field: frame.field,
            dyn: frame.dyn,
            dynPunch: frame.dynPunch,
            keyMode: frame.keyMode,
            lfoDepth: frame.lfoDepth,
            mix: frame.mix,
            output: frame.output,
          }
        : p;
      const cp = cpOf(liveParams);
      const makeCurve = (
        curveParams: SkrutkaCurveParams,
        channel: SkrutkaChannel,
        points = 160,
        radius?: number,
        punchRadius?: number,
      ): SkrutkaPlotPoint[] => {
        if (viewMode === "wet-delay") {
          return skrutkaComponentCurve(curveParams, sampleRate, channel, points, F_LO, F_HI, radius, punchRadius).map(
            (point) => ({ ...point, db: 0 }),
          );
        }
        return skrutkaOutputComponentCurve(
          curveParams,
          sampleRate,
          channel,
          points,
          F_LO,
          F_HI,
          radius,
          punchRadius,
          viewMode === "output-level" ? "level" : "delay",
        );
      };
      // FIELD switches the drawn components: legacy L/R, or the M/S field.
      const fieldActive = Math.abs(cp.field ?? 0) > 1e-4;
      const chA: SkrutkaChannel = fieldActive ? "M" : "L";
      const chB: SkrutkaChannel = fieldActive ? "S" : "R";
      const curveA = makeCurve(cp, chA, 160, frame?.radius, frame?.punchRadius);
      const curveB = makeCurve(cp, chB, 160, frame?.radius, frame?.punchRadius);
      // Stored-curve ghosts (A then B): where the MORPH knob can travel.
      const ghostA = curveState?.slots.A
        ? makeCurve(cpOf(morphTwistParams(baseParams, { slots: { A: curveState.slots.A } }, 0)), chA, 160)
        : null;
      const ghostB = curveState?.slots.B
        ? makeCurve(cpOf(morphTwistParams(baseParams, { slots: { B: curveState.slots.B } }, 0)), chA, 160)
        : null;
      const dynArmed = Math.abs(liveParams.dyn ?? 0) > 1e-4 || (liveParams.keyMode ?? 0) > 0;
      const radiusRange = dynArmed
        ? skrutkaDynRadiusRange({ ...cp, dyn: liveParams.dyn ?? 0, keyMode: liveParams.keyMode ?? 0 })
        : null;
      const drivenMin = radiusRange ? makeCurve(cp, chA, 160, radiusRange.min, frame?.punchRadius) : null;
      const drivenMax = radiusRange ? makeCurve(cp, chA, 160, radiusRange.max, frame?.punchRadius) : null;
      // DYNAMIC PUNCH (v2.2): the punch radius is driven from its static
      // mapping up to the hard ceiling — its own band when armed.
      const punchDynArmed = Math.abs(liveParams.dynPunch ?? 0) > 1e-4;
      const drivenPunch = punchDynArmed ? makeCurve(cp, chA, 160, undefined, SKRUTKA_PUNCH_R_HARD_MAX) : null;
      const graphValue = (point: SkrutkaPlotPoint): number | null => {
        if (viewMode === "output-level") return point.db;
        return typeof point.ms === "number" && Number.isFinite(point.ms) ? point.ms : null;
      };
      const plotted = [curveA, curveB, drivenMin, drivenMax, drivenPunch, ghostA, ghostB]
        .filter((curve): curve is SkrutkaPlotPoint[] => curve !== null)
        .flatMap((curve) => curve.map(graphValue))
        .filter((value): value is number => value !== null && Number.isFinite(value));
      let minValue = 0;
      let maxValue = 0.05;
      if (viewMode === "output-level") {
        minValue = -60;
        maxValue = 12;
      } else if (plotted.length) {
        minValue = Math.min(...plotted);
        maxValue = Math.max(...plotted);
        if (minValue >= 0) {
          minValue = 0;
          maxValue = Math.max(0.05, maxValue * 1.12);
        } else {
          const pad = Math.max(0.05, (maxValue - minValue) * 0.08);
          minValue -= pad;
          maxValue += pad;
        }
      }
      const yOf = (value: number) =>
        ch - ((Math.min(maxValue, Math.max(minValue, value)) - minValue) / (maxValue - minValue)) * (ch - 6) - 3;

      const strokeCurve = (curve: SkrutkaPlotPoint[], color: string, dash: number[]) => {
        c2d.strokeStyle = color;
        c2d.lineWidth = 1.5;
        c2d.setLineDash(dash);
        c2d.beginPath();
        let drawing = false;
        for (const point of curve) {
          const value = graphValue(point);
          if (value === null) {
            drawing = false;
            continue;
          }
          const x = xOf(point.freqHz, cw);
          const y = yOf(value);
          if (drawing) c2d.lineTo(x, y);
          else c2d.moveTo(x, y);
          drawing = true;
        }
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.lineWidth = 1;
      };

      // Stored-curve ghosts (faint, dotted): A amber, B blue.
      const strokeGhost = (curve: SkrutkaPlotPoint[], color: string) => {
        strokeCurve(curve, color, [2, 3]);
      };
      if (ghostA) strokeGhost(ghostA, "rgba(255, 190, 120, 0.5)");
      if (ghostB) strokeGhost(ghostB, "rgba(120, 200, 255, 0.45)");

      // LFO focus sweep shade (x axis).
      if ((liveParams.lfoDepth ?? 0) > 1e-4) {
        const range = skrutkaLfoFocusRange(cp.focusHz, liveParams.lfoDepth ?? 0);
        const xa = xOf(range.lo, cw);
        const xb = xOf(range.hi, cw);
        c2d.fillStyle = "rgba(150, 140, 255, 0.10)";
        c2d.fillRect(xa, 0, Math.max(1, xb - xa), ch);
      }

      // DYNAMIC/KEY radius range. DUCK moves downward, PUMP and DYNAMIC move
      // upward, and transitional/keyed combinations can span both sides.
      const fullyPlotted = (curve: SkrutkaPlotPoint[]) => curve.every((point) => graphValue(point) !== null);
      if (drivenMin && drivenMax && fullyPlotted(drivenMin) && fullyPlotted(drivenMax)) {
        c2d.fillStyle = "rgba(255, 190, 120, 0.12)";
        c2d.beginPath();
        for (const point of drivenMin) c2d.lineTo(xOf(point.freqHz, cw), yOf(graphValue(point)!));
        for (let i = drivenMax.length - 1; i >= 0; i--)
          c2d.lineTo(xOf(drivenMax[i]!.freqHz, cw), yOf(graphValue(drivenMax[i]!)!));
        c2d.closePath();
        c2d.fill();
        for (const [curve, color] of [
          [drivenMin, "rgba(255, 190, 120, 0.3)"],
          [drivenMax, "rgba(255, 190, 120, 0.45)"],
        ] as const) {
          strokeCurve(curve, color, [2, 4]);
        }
      }

      // DYNAMIC PUNCH driven band (a cooler hue so it reads as the short,
      // transient-scale stage rather than the long hump).
      if (drivenPunch && fullyPlotted(curveA) && fullyPlotted(drivenPunch)) {
        c2d.fillStyle = "rgba(150, 205, 255, 0.10)";
        c2d.beginPath();
        for (const point of curveA) c2d.lineTo(xOf(point.freqHz, cw), yOf(graphValue(point)!));
        for (let i = drivenPunch.length - 1; i >= 0; i--)
          c2d.lineTo(xOf(drivenPunch[i]!.freqHz, cw), yOf(graphValue(drivenPunch[i]!)!));
        c2d.closePath();
        c2d.fill();
      }

      // Horizontal scale and frequency decade gridlines.
      c2d.strokeStyle = "rgba(200, 200, 200, 0.18)";
      c2d.fillStyle = "rgba(200, 200, 200, 0.5)";
      c2d.font = "9px monospace";
      if (viewMode === "output-level") {
        for (const db of [-60, -48, -36, -24, -12, 0, 12]) {
          const y = yOf(db);
          c2d.beginPath();
          c2d.moveTo(0, y);
          c2d.lineTo(cw, y);
          c2d.stroke();
          c2d.fillText(db + " dB", 2, y - 2);
        }
      } else {
        for (let tick = 0; tick <= 4; tick++) {
          const value = minValue + ((maxValue - minValue) * tick) / 4;
          const y = yOf(value);
          c2d.beginPath();
          c2d.moveTo(0, y);
          c2d.lineTo(cw, y);
          c2d.stroke();
          c2d.fillText(value.toFixed(1) + " ms", 2, y - 2);
        }
      }
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

      // Component A (solid accent) and B (dashed). OUTPUT DELAY gaps mark
      // cancellation nulls, where the phase derivative is not well-defined.
      strokeCurve(curveA, "rgba(255, 170, 120, 0.95)", []);
      strokeCurve(curveB, "rgba(120, 200, 255, 0.85)", [4, 4]);

      // Live dot: the processor's current radius + LFO-moderated focus.
      if (frame && !degraded) {
        const fEff = Math.min(4000, Math.max(40, frame.focusHz));
        const radius = Math.min(SKRUTKA_R_HARD_MAX, Math.max(0.02, frame.radius));
        const value =
          viewMode === "wet-delay"
            ? (skrutkaDelayAt(cp, sampleRate, fEff, radius, chA, frame.punchRadius) / sampleRate) * 1000
            : viewMode === "output-delay"
              ? ((skrutkaOutputGroupDelaySamples(cp, sampleRate, fEff, chA, radius, frame.punchRadius) ?? Number.NaN) /
                  sampleRate) *
                1000
              : skrutkaOutputMagnitudeDbAt(cp, sampleRate, fEff, chA, radius, frame.punchRadius);
        if (Number.isFinite(value)) {
          c2d.fillStyle = "rgba(255, 255, 255, 0.92)";
          c2d.beginPath();
          c2d.arc(xOf(fEff, cw), yOf(value), 3, 0, Math.PI * 2);
          c2d.fill();
        }

        // The punch stage has its own current-radius meter. Show its live
        // group-delay point separately so DYNAMIC PUNCH is visible while it moves.
        if (viewMode === "wet-delay" && frame.punchRadius > 1e-4) {
          const punchFocus = skrutkaPunchFocus(cp.focusHz, cp.punch, cp.punchHz ?? 0, sampleRate);
          const punchMs =
            (skrutkaGroupDelaySamples(cp, sampleRate, punchFocus, chA, radius, frame.punchRadius) / sampleRate) * 1000;
          c2d.fillStyle = "rgba(150, 205, 255, 0.98)";
          c2d.beginPath();
          c2d.arc(xOf(punchFocus, cw), yOf(punchMs), 2.5, 0, Math.PI * 2);
          c2d.fill();
        }
      }

      // Readout follows the smoothed worklet state when it is available.
      if (readoutRef.current) {
        if (viewMode === "wet-delay") {
          const peak = skrutkaPeakDelay(cp, sampleRate, chA, frame?.radius, frame?.punchRadius);
          readoutRef.current.textContent =
            peak.ms > 0.01
              ? "WET +" + peak.ms.toFixed(1) + " ms @ " + Math.round(peak.freqHz) + " Hz"
              : "WET — no delay hump";
        } else if (viewMode === "output-delay") {
          const outputCurve = makeCurve(cp, chA, 240, frame?.radius, frame?.punchRadius);
          const peak = outputCurve
            .filter((point) => typeof point.ms === "number" && Number.isFinite(point.ms))
            .reduce(
              (best, point) =>
                Math.abs(point.ms!) > Math.abs(best.ms) ? { ms: point.ms!, freqHz: point.freqHz } : best,
              { ms: 0, freqHz: 0 },
            );
          readoutRef.current.textContent =
            Math.abs(peak.ms) > 0.01
              ? "OUT " + (peak.ms > 0 ? "+" : "") + peak.ms.toFixed(1) + " ms @ " + Math.round(peak.freqHz) + " Hz"
              : "OUT — no delay hump";
        } else {
          const peak = [...curveA, ...curveB].reduce(
            (best, point) => (Math.abs(point.db) > Math.abs(best.db) ? { db: point.db, freqHz: point.freqHz } : best),
            { db: 0, freqHz: 0 },
          );
          readoutRef.current.textContent =
            Math.abs(peak.db) > 0.05
              ? "OUT " + (peak.db > 0 ? "+" : "") + peak.db.toFixed(1) + " dB @ " + Math.round(peak.freqHz) + " Hz"
              : "OUT flat ±0.0 dB";
        }
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
      const bounded = (value: unknown, min: number, max: number): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
      frameRef.current =
        raw &&
        bounded(raw.lfo, 0, 1) &&
        bounded(raw.focusHz, 40, 4000) &&
        bounded(raw.env, 0, 1) &&
        typeof raw.key === "number" &&
        Number.isFinite(raw.key) &&
        bounded(raw.radius, 0.05, SKRUTKA_R_HARD_MAX) &&
        bounded(raw.dispersion, 0, 1) &&
        bounded(raw.punch, -1, 1) &&
        bounded(raw.punchHz, 0, 6000) &&
        bounded(raw.punchMix, 0, 1) &&
        bounded(raw.punchRadius, 0, SKRUTKA_PUNCH_R_HARD_MAX) &&
        bounded(raw.shape, 0, 3) &&
        bounded(raw.spread, 0, 1) &&
        bounded(raw.field, -1, 1) &&
        bounded(raw.dyn, -1, 1) &&
        bounded(raw.dynPunch, -1, 1) &&
        bounded(raw.keyMode, 0, 2) &&
        bounded(raw.lfoDepth, 0, 1) &&
        bounded(raw.mix, 0, 1) &&
        bounded(raw.output, -18, 12)
          ? {
              lfo: raw.lfo,
              focusHz: raw.focusHz,
              env: raw.env,
              key: raw.key,
              radius: raw.radius,
              dispersion: raw.dispersion,
              punch: raw.punch,
              punchHz: raw.punchHz,
              punchMix: raw.punchMix,
              punchRadius: raw.punchRadius,
              shape: raw.shape,
              spread: raw.spread,
              field: raw.field,
              dyn: raw.dyn,
              dynPunch: raw.dynPunch,
              keyMode: raw.keyMode,
              lfoDepth: raw.lfoDepth,
              mix: raw.mix,
              output: raw.output,
            }
          : null;
      draw();
    }, 66);

    return () => {
      observer?.disconnect();
      window.clearInterval(timer);
    };
  }, [services, trackId, fxId, degraded, viewMode, keySourceConnected]);

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
    const F_LO = BAND_LO;
    const F_HI = BAND_HI;
    const sampleRate = skrutkaPanelSampleRate(services.engine.getLiveAudioContext()?.sampleRate);
    const x = Math.min(cw, Math.max(0, event.clientX - rect.left));
    const y = Math.min(ch, Math.max(0, event.clientY - rect.top));
    // Audit 17: clamp into the range the document can actually store. The
    // preview goes straight to the runtime (no clamp) while the commit path
    // clamps through clampEffectParam — without this the drag auditions a
    // value the document rejects, then snaps back on release.
    const rawFocus = F_LO * Math.pow(F_HI / F_LO, x / cw);
    const focus = Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, rawFocus));
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
    <section className={"skrutka-panel" + (docked ? " docked" : "")} aria-label="TWIST response">
      {degraded && <div className="skrutka-degraded">AudioWorklet unavailable — TWIST is bypassed (1:1 signal)</div>}
      <div className="skrutka-head">
        <span className="skrutka-readout" ref={readoutRef}>
          — no delay hump
        </span>
        <div className="skrutka-views" role="group" aria-label="Response view">
          {(
            [
              ["wet-delay", "WET DELAY"],
              ["output-delay", "OUT DELAY"],
              ["output-level", "OUT LEVEL"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={["btn btn-small", viewMode === mode && "on"].filter(Boolean).join(" ")}
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              title={
                mode === "wet-delay"
                  ? "Show the fully wet phase-dispersion response"
                  : mode === "output-delay"
                    ? "Show phase delay after PUNCH, DRY/WET MIX and OUTPUT gain"
                    : "Show output magnitude in dB, including PUNCH cancellation and OUTPUT gain"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <span className="skrutka-hint">
          {viewMode === "wet-delay"
            ? fieldActive
              ? "drag: focus × dispersion — M solid, S dashed"
              : "drag: focus × dispersion — L solid, R dashed"
            : "output response includes MIX and OUTPUT; nulls break the delay curve"}
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
        className={["skrutka-viz", viewMode !== "wet-delay" && "inspect"].filter(Boolean).join(" ")}
        onPointerDown={(event) => {
          if (!onParam || viewMode !== "wet-delay") return;
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
      <div className="skrutka-activity" role="group" aria-label="Live detector response">
        <div className="skrutka-activity-row">
          <span className="skrutka-activity-label">DYN</span>
          <div
            ref={dynamicMeterRef}
            className="skrutka-activity-track"
            role="meter"
            aria-label="DYNAMIC activity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            aria-valuetext="Waiting for live audio"
          >
            <span ref={dynamicFillRef} className="skrutka-activity-fill" />
          </div>
          <span ref={dynamicValueRef} className="skrutka-activity-value">
            —
          </span>
        </div>
        <div className="skrutka-activity-row">
          <span className="skrutka-activity-label">KEY</span>
          <div
            ref={keyMeterRef}
            className="skrutka-activity-track key"
            role="meter"
            aria-label="KEY response"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            aria-valuetext="Waiting for live audio"
          >
            <span ref={keyFillRef} className="skrutka-activity-fill" />
          </div>
          <span ref={keyValueRef} className="skrutka-activity-value">
            —
          </span>
        </div>
      </div>
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
