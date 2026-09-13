import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FXEQ_PRESETS } from "../effects/fxeq-core/core/presets";
import { buildSchema, type FxEqSchema } from "../effects/fxeq-core/core/parameterSchema";
import { blendParams } from "../effects/fxeqNode";
import type { EffectRuntime } from "../effects/types";
import { bandEqMagnitudeDb, crossoverBandMagnitudeDb } from "./fxeqCurve";
import { useServices } from "./context";
import { Slider } from "./controls";
import { EffectAbControls, type EffectAbState } from "./EffectAbControls";

const MODULE_ORDER = ["eq", "sat", "lofi", "mod", "delay", "rev", "dyn"] as const;
const MODULE_LABELS: Record<string, string> = {
  eq: "EQ",
  sat: "SAT",
  lofi: "LO-FI",
  mod: "MOD",
  delay: "DLY",
  rev: "REV",
  dyn: "DYN",
};
const MODULE_COLORS: Record<string, string> = {
  eq: "#a3e635",
  sat: "#f59e0b",
  lofi: "#22d3ee",
  mod: "#a78bfa",
  delay: "#34d399",
  rev: "#f472b6",
  dyn: "#60a5fa",
};

/**
 * The DSP stores tempo divisions as a compact 0…8 enum. Keep that storage
 * contract, but expose musical labels in the panel instead of making users
 * guess what an integer slider means. This table mirrors the Q2 contract in
 * the delay/modulation modules; `0` intentionally means free-running.
 */
const TEMPO_SYNC_OPTIONS = [
  { value: 0, label: "Free" },
  { value: 1, label: "1/1" },
  { value: 2, label: "1/2" },
  { value: 3, label: "1/4" },
  { value: 4, label: "1/8" },
  { value: 5, label: "1/16" },
  { value: 6, label: "1/8T" },
  { value: 7, label: "1/8." },
  { value: 8, label: "1/4T" },
] as const;

const AXIS_MIN_HZ = 20;
const AXIS_MAX_HZ = 20000;

/** Split handles snap within this many CSS px of the split line. */
const HANDLE_HIT_PX = 8;
/** Mirrors the core's XOVER_MIN_GAP_HZ — splits never approach closer. */
const SPLIT_MIN_GAP_HZ = 40;
/** Visual dB span of the EQ curve overlay (matches the ±24 dB def range). */
const CURVE_DB_SPAN = 24;
/** Nominal sample rate for the response overlay — shapes shift only
 *  marginally across real device rates, so one visual constant is enough. */
const CURVE_NOMINAL_SR = 48000;

function freqToX(freqHz: number, width: number): number {
  const logMin = Math.log(AXIS_MIN_HZ);
  const logMax = Math.log(AXIS_MAX_HZ);
  return ((Math.log(Math.max(AXIS_MIN_HZ, Math.min(AXIS_MAX_HZ, freqHz))) - logMin) / (logMax - logMin)) * width;
}

/** Inverse of freqToX: canvas-relative x ratio → frequency. */
function xToFreq(xRatio: number): number {
  const logMin = Math.log(AXIS_MIN_HZ);
  const logMax = Math.log(AXIS_MAX_HZ);
  return Math.exp(logMin + xRatio * (logMax - logMin));
}

/**
 * FxEqPanel — the EQ-paint editor for an FXEQ Multiband instance.
 *
 * Top: preset browser (vendored VocalForge presets, one-gesture apply).
 * Middle: spectrum canvas — log-frequency axis, the crossover band regions,
 * and a "paint" strip showing WHICH effect modules are active WHERE in the
 * spectrum (the fxeq idea: effects live at frequencies, not just in a chain).
 * Click a band to edit it. Bottom: the selected band's module params,
 * generated from the vendored parameter schema (ranges + defaults included).
 */
export function FxEqPanel({
  trackId,
  fxId,
  params,
  degraded,
  sidechainTrackId,
  abState,
  onAbStateChange,
  onAbLoad,
  onParam,
  onApplyPreset,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded?: boolean;
  sidechainTrackId?: string | null;
  abState?: EffectAbState;
  onAbStateChange?: (state: EffectAbState) => void;
  onAbLoad?: (slot: "A" | "B") => void;
  onParam: (fullId: string, value: number) => void;
  onApplyPreset: (presetName: string, presetParams: Record<string, number>) => void;
}) {
  const services = useServices();
  const bandCount = Math.max(2, Math.min(6, Math.round(params.bandCount ?? 6)));
  const schema: FxEqSchema = useMemo(() => buildSchema(bandCount), [bandCount]);
  // The editor remembers the last band worked on per instance (survives
  // track switches); stored unvalidated values fall back to band 1.
  const [selectedBand, setSelectedBand] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(`fxeq.band.${fxId}`));
      return Number.isFinite(stored) && stored >= 1 && stored <= 6 ? Math.round(stored) : 1;
    } catch {
      return 1;
    }
  });
  const selectBand = (band: number) => {
    setSelectedBand(band);
    try {
      window.localStorage.setItem(`fxeq.band.${fxId}`, String(band));
    } catch {
      /* storage unavailable (private mode) — selection just stays session-only */
    }
  };
  // A bandCount shrink must not leave the editor pointed past the last band.
  useEffect(() => {
    if (selectedBand > bandCount) selectBand(bandCount);
  }, [bandCount, selectedBand]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── plugin-level runtime surface: A/B morph slots + in-plugin undo/redo ──
  // Optional everywhere: the degraded bypass runtime exposes none of this
  // and test mocks may not implement getFxRuntime at all.
  const engineWithFx = services.engine as typeof services.engine & {
    getFxRuntime?: (trackId: string, fxId: string) => EffectRuntime | null;
    getFxMeters?: (trackId: string, fxId: string) => unknown;
    setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    previewFxParam?: (trackId: string, fxId: string, paramId: string, value: number) => void;
  };
  const fxRuntime = (): EffectRuntime | null => engineWithFx.getFxRuntime?.(trackId, fxId) ?? null;
  const morphSlots: [boolean, boolean] = [Boolean(abState?.slots.A), Boolean(abState?.slots.B)];
  const [morphT, setMorphT] = useState(0.5);
  const grRef = useRef<HTMLSpanElement | null>(null);

  const valueOf = (id: string): number => params[id] ?? schema.defaultParams[id] ?? 0;
  const sidechainActive = valueOf(`band${selectedBand}.sidechainMode`) >= 0.5;
  const sidechainAvailable = Boolean(sidechainTrackId);

  // Keep preview audio outside the document command stream. The document is
  // written once on pointer-up, while the worklet hears every coalesced move.
  const previewParam = (id: string, value: number) => {
    engineWithFx.previewFxParam?.(trackId, fxId, id, value);
  };
  const cancelParamPreview = (id: string) => {
    const runtime = fxRuntime();
    if (!runtime) return;
    runtime.beginParamSync?.();
    try {
      runtime.setParameter(id, valueOf(id));
    } finally {
      runtime.endParamSync?.();
    }
  };

  // Persisted A/B slots are the source of truth. Hydrate the runtime copy
  // whenever the document/runtime changes so morphing survives reloads and
  // chain rebuilds without exposing a second session-only store.
  useEffect(() => {
    const runtime = fxRuntime();
    runtime?.setMorphSnapshot?.(0, abState?.slots.A ?? null);
    runtime?.setMorphSnapshot?.(1, abState?.slots.B ?? null);
  }, [trackId, fxId, services.engine, params, abState]);

  /** Live scrub: transient audio morph, document untouched until release. */
  const scrubMorph = (t: number) => {
    setMorphT(t);
    fxRuntime()?.morphBlendSnapshots?.(0, 1, t, 0.08);
  };

  const morphStartRef = useRef(0.5);
  const morphDirtyRef = useRef(false);
  const cancelMorph = () => {
    const t = morphStartRef.current;
    setMorphT(t);
    morphDirtyRef.current = false;
    fxRuntime()?.morphBlendSnapshots?.(0, 1, t, 0.08);
  };

  /** On release: commit the scrubbed blend so knob edits continue from
   *  what the user actually hears (no silent snap-back to the old state). */
  const commitMorph = () => {
    if (!morphDirtyRef.current) return;
    morphDirtyRef.current = false;
    const runtime = fxRuntime();
    const a = runtime?.getMorphSnapshot?.(0);
    const b = runtime?.getMorphSnapshot?.(1);
    if (!a || !b) return;
    onApplyPreset("Morph", blendParams(a, b, morphT));
  };

  const undoParam = () => {
    fxRuntime()?.undoParam?.((entry) => {
      if (entry) onParam(entry.id, entry.value);
    });
  };
  const redoParam = () => {
    fxRuntime()?.redoParam?.((entry) => {
      if (entry) onParam(entry.id, entry.value);
    });
  };

  // Crossover split frequencies: crossoverFreq2..bandCount.
  const splits = useMemo(() => {
    const out: number[] = [];
    for (let i = 2; i <= bandCount; i++) {
      out.push(params[`crossoverFreq${i}`] ?? schema.defaultParams[`crossoverFreq${i}`] ?? 0);
    }
    return out;
  }, [params, bandCount, schema]);

  // ── crossover split drag: live preview on the runtime, one doc commit ──
  // The DSP glides split changes (10 Hz smoothing), so dragging is
  // zipper-free; the document is only written on release (same contract as
  // the Slider preview/commit pattern).
  const [dragSplit, setDragSplit] = useState<{ index: number; freq: number } | null>(null);
  const dragState = useRef<{ index: number; freq: number; moved: boolean } | null>(null);
  const grabHandleRef = useRef(false);

  /** Same clamp the core applies to a single split change: schema range,
   *  an 80 Hz floor and the 40 Hz gap against the stored neighbours — so
   *  the committed doc value and the previewed DSP value always agree. */
  const clampSplit = (index: number, freq: number): number => {
    const def = schema.defById.get(`crossoverFreq${index + 2}`);
    let lo = Math.max(80, def?.minValue ?? 80);
    let hi = def?.maxValue ?? AXIS_MAX_HZ;
    for (let i = 0; i < index; i++) lo = Math.max(lo, splits[i] + SPLIT_MIN_GAP_HZ);
    if (index < splits.length - 1) hi = Math.min(hi, splits[index + 1] - SPLIT_MIN_GAP_HZ);
    return Math.max(lo, Math.min(hi, freq));
  };

  const splitIndexAt = (clientX: number, rect: DOMRect): number => {
    for (let i = 0; i < splits.length; i++) {
      if (Math.abs(clientX - rect.left - freqToX(splits[i], rect.width)) <= HANDLE_HIT_PX) return i;
    }
    return -1;
  };

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const index = splitIndexAt(e.clientX, rect);
    if (index < 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported — the drag still works while held */
    }
    dragState.current = { index, freq: splits[index], moved: false };
    grabHandleRef.current = true;
    setDragSplit({ index, freq: splits[index] });
  };

  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const drag = dragState.current;
    if (!drag) {
      // Hover feedback: split handles announce themselves.
      e.currentTarget.style.cursor = splitIndexAt(e.clientX, rect) >= 0 ? "ew-resize" : "";
      return;
    }
    const freq = clampSplit(drag.index, xToFreq((e.clientX - rect.left) / rect.width));
    drag.moved = true;
    // The ref carries the authoritative latest position — the commit on
    // pointerup must never depend on whether React flushed the render pass
    // for this move yet.
    drag.freq = freq;
    setDragSplit({ index: drag.index, freq });
    previewParam(`crossoverFreq${drag.index + 2}`, freq);
  };

  const endSplitDrag = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragState.current;
    if (!drag) return;
    dragState.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    setDragSplit(null);
    if (commit && drag.moved) onParam(`crossoverFreq${drag.index + 2}`, drag.freq);
    // onClick fires after pointerup: swallow it for handle gestures (the
    // grab itself, even without movement, is not a band selection).
    window.setTimeout(() => {
      grabHandleRef.current = false;
    }, 0);
  };

  // Which modules are enabled per band (for the paint strip).
  const activeModules = useMemo(() => {
    const perBand: string[][] = [];
    for (let b = 1; b <= bandCount; b++) {
      const on: string[] = [];
      for (const key of MODULE_ORDER) {
        if ((params[`band${b}.${key}Enabled`] ?? 0) >= 0.5) on.push(key);
      }
      perBand.push(on);
    }
    return perBand;
  }, [params, bandCount]);

  // ── transfer overlay for the selected band ─────────────────────────────
  // Sampled across the band's own frequency region. windowDb is the
  // crossover's own response (the LR skirt: flat passband, −6 dB at the
  // splits, 12/24/48 dB per octave by SLOPE) plus the band gain; totalDb
  // adds the band EQ on top — together they answer "what does this band
  // actually contribute to the sum". The allpass phase EQ is
  // magnitude-flat and intentionally absent from both.
  const bandCurve = useMemo(() => {
    const edges = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];
    const f0 = edges[selectedBand - 1];
    const f1 = edges[selectedBand];
    if (!(f1 > f0)) return null;
    const order = params.crossoverOrder ?? 4;
    const gainDb = valueOf(`band${selectedBand}.gainDb`);
    const eqOn = valueOf(`band${selectedBand}.eqEnabled`) >= 0.5;
    const eq = {
      enabled: valueOf(`band${selectedBand}.eqEnabled`),
      lowFreq: valueOf(`band${selectedBand}.eqLowFreq`),
      lowGainDb: valueOf(`band${selectedBand}.eqLowGainDb`),
      peak1Freq: valueOf(`band${selectedBand}.eqPeak1Freq`),
      peak1GainDb: valueOf(`band${selectedBand}.eqPeak1GainDb`),
      peak1Q: valueOf(`band${selectedBand}.eqPeak1Q`),
      peak2Freq: valueOf(`band${selectedBand}.eqPeak2Freq`),
      peak2GainDb: valueOf(`band${selectedBand}.eqPeak2GainDb`),
      peak2Q: valueOf(`band${selectedBand}.eqPeak2Q`),
      highFreq: valueOf(`band${selectedBand}.eqHighFreq`),
      highGainDb: valueOf(`band${selectedBand}.eqHighGainDb`),
    };
    const N = 140;
    const logLo = Math.log(f0);
    const logHi = Math.log(f1);
    const windowDb: number[] = [];
    const totalDb: number[] = [];
    for (let i = 0; i <= N; i++) {
      const f = Math.exp(logLo + (i / N) * (logHi - logLo));
      const xover = crossoverBandMagnitudeDb(selectedBand - 1, splits, order, f, CURVE_NOMINAL_SR);
      windowDb.push(xover + gainDb);
      totalDb.push(xover + gainDb + (eqOn ? bandEqMagnitudeDb(eq, f, CURVE_NOMINAL_SR) : 0));
    }
    return { windowDb, totalDb: eqOn ? totalDb : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBand, splits, params, schema]);

  // ── canvas ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = canvas.offsetWidth * dpr);
    const h = (canvas.height = canvas.offsetHeight * dpr);
    ctx2d.clearRect(0, 0, w, h);

    // While a split is being dragged its live position overrides the (not
    // yet committed) document value, so regions and curve track the pointer.
    const drawnSplits = splits.map((f, i) => (dragSplit && dragSplit.index === i ? dragSplit.freq : f));
    const edges = [AXIS_MIN_HZ, ...drawnSplits, AXIS_MAX_HZ];

    // Band regions: alternating fills from splits.
    for (let b = 0; b < edges.length - 1; b++) {
      const x0 = freqToX(edges[b], w);
      const x1 = freqToX(edges[b + 1], w);
      ctx2d.fillStyle =
        b === selectedBand - 1
          ? "rgba(245, 158, 11, 0.10)"
          : b % 2 === 0
            ? "rgba(255,255,255,0.03)"
            : "rgba(0,0,0,0.16)";
      ctx2d.fillRect(x0, 0, x1 - x0, h);
      // Band number label.
      ctx2d.fillStyle = b === selectedBand - 1 ? "#f59e0b" : "#71717a";
      ctx2d.font = `600 ${10 * dpr}px system-ui, sans-serif`;
      ctx2d.fillText(`B${b + 1}`, x0 + 4 * dpr, 12 * dpr);
    }

    // Split lines + Hz labels. The grabbed handle lights up.
    ctx2d.font = `${9 * dpr}px ui-monospace, monospace`;
    for (let i = 0; i < drawnSplits.length; i++) {
      const x = freqToX(drawnSplits[i], w);
      const active = dragSplit?.index === i;
      ctx2d.fillStyle = active ? "#f59e0b" : "#52525b";
      ctx2d.fillRect(x - (active ? 2 : 1) * dpr, 0, (active ? 4 : 2) * dpr, h);
      ctx2d.fillStyle = active ? "#f59e0b" : "#71717a";
      const label = drawnSplits[i] >= 1000 ? `${(drawnSplits[i] / 1000).toFixed(1)}k` : `${Math.round(drawnSplits[i])}`;
      ctx2d.fillText(label, x + 3 * dpr, h - 4 * dpr);
    }

    // ── selected-band transfer overlay ─────────────────────────────────
    // The dashed window shows the crossover branch plus band gain. The solid
    // line adds the optional per-band EQ, so the canvas explains both the
    // band contribution and the EQ moves without pretending the crossover is
    // flat inside every region.
    if (bandCurve && bandCurve.windowDb.length > 1) {
      const bx0 = freqToX(edges[selectedBand - 1], w);
      const bx1 = freqToX(edges[selectedBand], w);
      // 0 dB reference inside the band region.
      ctx2d.strokeStyle = "rgba(255,255,255,0.08)";
      ctx2d.beginPath();
      ctx2d.moveTo(bx0, h / 2);
      ctx2d.lineTo(bx1, h / 2);
      ctx2d.stroke();

      const drawCurve = (points: number[], color: string, width: number, alpha = 1) => {
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = width * dpr;
        ctx2d.globalAlpha = alpha;
        ctx2d.beginPath();
        for (let i = 0; i < points.length; i++) {
          const x = bx0 + ((bx1 - bx0) * i) / (points.length - 1);
          const db = Math.max(-CURVE_DB_SPAN, Math.min(CURVE_DB_SPAN, points[i]));
          const y = h / 2 - (db / CURVE_DB_SPAN) * (h * 0.42);
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.globalAlpha = 1;
      };

      drawCurve(bandCurve.windowDb, MODULE_COLORS.eq, 1, 0.45);
      if (bandCurve.totalDb) drawCurve(bandCurve.totalDb, MODULE_COLORS.eq, 2);
      ctx2d.lineWidth = 1;
    }

    // Module paint strip: colored module tags inside their band region.
    // Tags that no longer fit collapse into a "+N" chip instead of being
    // silently dropped.
    const stripY = h - 22 * dpr;
    for (let b = 0; b < bandCount; b++) {
      const x0 = freqToX(edges[b], w);
      const x1 = freqToX(edges[b + 1], w);
      let x = x0 + 4 * dpr;
      let drawn = 0;
      for (const key of activeModules[b]) {
        const label = MODULE_LABELS[key];
        ctx2d.font = `700 ${8 * dpr}px system-ui, sans-serif`;
        const tw = ctx2d.measureText(label).width;
        if (x + tw + 6 * dpr > x1) break; // band too narrow for more tags
        ctx2d.fillStyle = MODULE_COLORS[key];
        ctx2d.globalAlpha = 0.85;
        ctx2d.fillRect(x, stripY, tw + 5 * dpr, 11 * dpr);
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = "#0e0f12";
        ctx2d.fillText(label, x + 2.5 * dpr, stripY + 8.5 * dpr);
        x += tw + 8 * dpr;
        drawn++;
      }
      const remaining = activeModules[b].length - drawn;
      if (remaining > 0) {
        const label = `+${remaining}`;
        ctx2d.font = `700 ${8 * dpr}px system-ui, sans-serif`;
        const tw = ctx2d.measureText(label).width;
        if (x + tw + 5 * dpr <= x1 - 2 * dpr) {
          ctx2d.fillStyle = "#52525b";
          ctx2d.globalAlpha = 0.9;
          ctx2d.fillRect(x, stripY, tw + 5 * dpr, 11 * dpr);
          ctx2d.globalAlpha = 1;
          ctx2d.fillStyle = "#d4d4d8";
          ctx2d.fillText(label, x + 2.5 * dpr, stripY + 8.5 * dpr);
        }
      }
    }

    // Frequency gridlines at decades.
    for (const freq of [50, 100, 500, 1000, 5000, 10000]) {
      const x = freqToX(freq, w);
      ctx2d.fillStyle = "rgba(255,255,255,0.05)";
      ctx2d.fillRect(x, 0, dpr, h);
    }
  }, [splits, dragSplit, bandCurve, bandCount, activeModules, selectedBand]);

  // Click canvas → select band by frequency (a drag on a split handle
  // swallows the click — grabbing a handle is not a band selection).
  const selectBandAt = (clientX: number, currentTarget: HTMLElement) => {
    const rect = currentTarget.getBoundingClientRect();
    const freq = xToFreq((clientX - rect.left) / rect.width);
    const edges = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];
    for (let b = 0; b < edges.length - 1; b++) {
      if (freq >= edges[b] && freq < edges[b + 1]) {
        selectBand(b + 1);
        return;
      }
    }
  };

  const onCanvasClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (grabHandleRef.current) return;
    selectBandAt(e.clientX, e.currentTarget);
  };

  // ── LIVE BAND PEAKS: poll the worklet snapshot, draw on canvas, no re-renders ──
  // Mirrors the UltinaPanel meter loop: the engine gates the worklet's
  // metering path on mount/unmount, so a closed FXEQ panel costs zero
  // band-peak traffic on the audio thread's message port.
  const peaksCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const edgesRef = useRef<number[]>([AXIS_MIN_HZ, AXIS_MAX_HZ]);
  edgesRef.current = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];

  useEffect(() => {
    engineWithFx.setFxMetersEnabled?.(trackId, fxId, true);

    const drawPeaks = () => {
      const canvas = peaksCanvasRef.current;
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const dpr = window.devicePixelRatio || 1;
      const w = (canvas.width = canvas.offsetWidth * dpr);
      const h = (canvas.height = canvas.offsetHeight * dpr);
      ctx2d.clearRect(0, 0, w, h);
      const edges = edgesRef.current;
      const peaks = peaksRef.current;
      for (let b = 0; b < edges.length - 1; b++) {
        const x0 = freqToX(edges[b], w);
        const x1 = freqToX(edges[b + 1], w);
        ctx2d.fillStyle = "rgba(255,255,255,0.04)";
        ctx2d.fillRect(x0, 0, x1 - x0, h);
        const peak = peaks && b < peaks.length ? peaks[b] : 0;
        if (peak > 1e-6) {
          const db = 20 * Math.log10(peak);
          const norm = Math.max(0, Math.min(1, (db + 60) / 60)); // −60 dB … 0 dB
          const barH = Math.max(2 * dpr, norm * h);
          ctx2d.fillStyle = db > -3 ? "#ef4444" : db > -12 ? "#f59e0b" : "#4ade80";
          ctx2d.fillRect(x0 + dpr, h - barH, x1 - x0 - 2 * dpr, barH);
        }
      }
    };

    drawPeaks();
    const id = setInterval(() => {
      const meters = engineWithFx.getFxMeters?.(trackId, fxId) as
        { bandPeaks?: Float32Array; gainReductionDb?: number } | null | undefined;
      peaksRef.current = meters?.bandPeaks ?? null;
      // GR readout rides the same snapshot (no React state — direct DOM
      // text update, mirroring the canvas draw loop).
      if (grRef.current) {
        const gr = meters?.gainReductionDb ?? 0;
        grRef.current.textContent = gr > 0.05 ? `GR −${gr.toFixed(1)} dB` : "";
      }
      drawPeaks();
    }, 66);
    return () => {
      engineWithFx.setFxMetersEnabled?.(trackId, fxId, false);
      clearInterval(id);
    };
  }, [trackId, fxId, services]);

  // Selected band's module params, grouped per module (from the vendored schema).
  const bandModuleDefs = useMemo(() => {
    const groups: Record<
      string,
      {
        id: string;
        name: string;
        min: number;
        max: number;
        default: number;
        unit?: string;
        options?: readonly { value: number; label: string }[];
      }[]
    > = {};
    for (const def of schema.defs) {
      const route = schema.routes.get(def.id);
      if (!route || route.band !== selectedBand || route.kind !== "module") continue;
      (groups[route.moduleKey!] ??= []).push({
        id: def.id,
        name: def.name.replace(/^B\d+ /, ""),
        min: def.minValue,
        max: def.maxValue,
        default: def.defaultValue,
        unit: def.unit,
        options: def.id.endsWith("SyncMode") ? TEMPO_SYNC_OPTIONS : undefined,
      });
    }
    return groups;
  }, [schema, selectedBand]);

  return (
    <div className="fxeq-panel" aria-label="PRISM multiband editor">
      {degraded && <div className="fxeq-degraded">AudioWorklet unavailable — PRISM is bypassed (1:1 signal)</div>}
      <div className="fxeq-preset-row">
        <select
          className="fxeq-preset-select"
          aria-label="PRISM preset"
          defaultValue=""
          onChange={(event) => {
            const preset = FXEQ_PRESETS.find((p) => p.name === event.target.value);
            if (preset) onApplyPreset(preset.name, preset.params);
            event.target.value = "";
          }}
        >
          <option value="">PRESET…</option>
          {FXEQ_PRESETS.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="fxeq-band-chips" role="group" aria-label="Select band">
          {Array.from({ length: bandCount }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`btn btn-small${selectedBand === i + 1 ? " active" : ""}`}
              aria-pressed={selectedBand === i + 1}
              onClick={() => selectBand(i + 1)}
            >
              B{i + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="fxeq-morph-row" role="group" aria-label="PRISM A/B morph">
        {onAbStateChange && onAbLoad && (
          <EffectAbControls
            effectName="PRISM"
            params={params}
            deviceState={
              abState
                ? { kind: "effect-ab-v1", data: { slots: { ...abState.slots }, active: abState.active } }
                : undefined
            }
            onStateChange={onAbStateChange}
            onLoad={onAbLoad}
          />
        )}
        <input
          type="range"
          className="fxeq-morph-slider"
          aria-label="PRISM morph A to B"
          title="Scrub between A and B — the blend lands in the document on release"
          min={0}
          max={1}
          step={0.01}
          value={morphT}
          disabled={!morphSlots[0] || !morphSlots[1]}
          onPointerDown={() => {
            morphStartRef.current = morphT;
            morphDirtyRef.current = false;
          }}
          onChange={(e) => {
            morphDirtyRef.current = true;
            scrubMorph(Number(e.target.value));
          }}
          onPointerUp={commitMorph}
          onPointerCancel={cancelMorph}
          onKeyUp={commitMorph}
        />
        <button
          type="button"
          className="btn btn-small"
          aria-label="Undo PRISM parameter edit"
          title="Undo the last live parameter tweak (plugin history)"
          onClick={undoParam}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-small"
          aria-label="Redo PRISM parameter edit"
          title="Redo an undone parameter tweak (plugin history)"
          onClick={redoParam}
        >
          ↷
        </button>
      </div>

      <div
        className="fxeq-canvas-wrap"
        role="img"
        aria-label="PRISM band map"
        title="Click a band to edit it — drag a split line to move the crossover"
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={(e) => endSplitDrag(e, true)}
        onPointerCancel={(e) => endSplitDrag(e, false)}
      >
        <canvas ref={canvasRef} className="fxeq-canvas" />
      </div>

      <div
        className="fxeq-peaks-wrap"
        role="img"
        aria-label="PRISM band peaks"
        title="Live per-band peak level — which band is playing hot right now"
      >
        <canvas ref={peaksCanvasRef} className="fxeq-peaks-canvas" />
        <span ref={grRef} className="fxeq-gr" aria-label="PRISM gain reduction" />
      </div>

      {/* Band scalars: solo / mute / gain — hear and level just this band. */}
      <div className="fxeq-band-scalars">
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.solo`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.solo`) >= 0.5}
          title="Solo — hear ONLY this frequency band through the whole PRISM engine"
          onClick={() => onParam(`band${selectedBand}.solo`, valueOf(`band${selectedBand}.solo`) >= 0.5 ? 0 : 1)}
        >
          SOLO
        </button>
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.mute`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.mute`) >= 0.5}
          title="Mute — silence this band"
          onClick={() => onParam(`band${selectedBand}.mute`, valueOf(`band${selectedBand}.mute`) >= 0.5 ? 0 : 1)}
        >
          MUTE
        </button>
        <div className="fxeq-band-gain">
          <Slider
            compact
            label={`B${selectedBand} GAIN`}
            value={valueOf(`band${selectedBand}.gainDb`)}
            min={-48}
            max={12}
            defaultValue={0}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
            onCommit={(v) => onParam(`band${selectedBand}.gainDb`, v)}
            onPreview={(v) => previewParam(`band${selectedBand}.gainDb`, v)}
            onCancel={() => cancelParamPreview(`band${selectedBand}.gainDb`)}
          />
        </div>
      </div>

      {/* Band-level dynamic EQ (spectral ducking). EXT SC drives the band's
          envelope from the sidechain feed attached by the engine via track
          routing; with it off the band tracks itself. */}
      <div className="fxeq-band-dyn" role="group" aria-label="PRISM dynamic EQ">
        <span className="fxeq-module-tag" style={{ background: MODULE_COLORS.dyn }}>
          DYN EQ
        </span>
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.dynEnable`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.dynEnable`) >= 0.5}
          title="Dynamic EQ — this band ducks itself when it exceeds the threshold"
          onClick={() =>
            onParam(`band${selectedBand}.dynEnable`, valueOf(`band${selectedBand}.dynEnable`) >= 0.5 ? 0 : 1)
          }
        >
          DYN
        </button>
        <button
          type="button"
          className={`btn btn-small${sidechainActive ? " active" : ""}`}
          aria-pressed={sidechainActive}
          disabled={!sidechainAvailable && !sidechainActive}
          title={
            sidechainAvailable
              ? "Sidechain — drive this band's dynamic EQ from the selected external source"
              : "Choose a SOURCE in the effect rack before enabling external sidechain"
          }
          onClick={() =>
            onParam(`band${selectedBand}.sidechainMode`, valueOf(`band${selectedBand}.sidechainMode`) >= 0.5 ? 0 : 1)
          }
        >
          EXT SC
        </button>
        <Slider
          compact
          label="DYN THRESH"
          value={valueOf(`band${selectedBand}.dynThresholdDb`)}
          min={-60}
          max={0}
          defaultValue={-20}
          format={(v) => `${v.toFixed(1)} dB`}
          onCommit={(v) => onParam(`band${selectedBand}.dynThresholdDb`, v)}
          onPreview={(v) => previewParam(`band${selectedBand}.dynThresholdDb`, v)}
          onCancel={() => cancelParamPreview(`band${selectedBand}.dynThresholdDb`)}
        />
        <Slider
          compact
          label="DYN RANGE"
          value={valueOf(`band${selectedBand}.dynRangeDb`)}
          min={-24}
          max={0}
          defaultValue={-6}
          format={(v) => `${v.toFixed(1)} dB`}
          onCommit={(v) => onParam(`band${selectedBand}.dynRangeDb`, v)}
          onPreview={(v) => previewParam(`band${selectedBand}.dynRangeDb`, v)}
          onCancel={() => cancelParamPreview(`band${selectedBand}.dynRangeDb`)}
        />
        <Slider
          compact
          label="DYN ATK"
          value={valueOf(`band${selectedBand}.dynAttackMs`)}
          min={0.1}
          max={100}
          defaultValue={10}
          format={(v) => `${v.toFixed(1)} ms`}
          onCommit={(v) => onParam(`band${selectedBand}.dynAttackMs`, v)}
          onPreview={(v) => previewParam(`band${selectedBand}.dynAttackMs`, v)}
          onCancel={() => cancelParamPreview(`band${selectedBand}.dynAttackMs`)}
        />
        <Slider
          compact
          label="DYN REL"
          value={valueOf(`band${selectedBand}.dynReleaseMs`)}
          min={10}
          max={1000}
          defaultValue={150}
          format={(v) => `${v.toFixed(0)} ms`}
          onCommit={(v) => onParam(`band${selectedBand}.dynReleaseMs`, v)}
          onPreview={(v) => previewParam(`band${selectedBand}.dynReleaseMs`, v)}
          onCancel={() => cancelParamPreview(`band${selectedBand}.dynReleaseMs`)}
        />
      </div>

      {MODULE_ORDER.map((key) => {
        const defs = bandModuleDefs[key];
        if (!defs || defs.length === 0) return null;
        const enabledId = `band${selectedBand}.${key}Enabled`;
        const enabled = valueOf(enabledId) >= 0.5;
        return (
          <div key={key} className={`fxeq-module${enabled ? "" : " fxeq-module-off"}`}>
            <div className="fxeq-module-head">
              <span className="fxeq-module-tag" style={{ background: MODULE_COLORS[key] }}>
                {MODULE_LABELS[key]}
              </span>
              <button
                type="button"
                className={`btn btn-small${enabled ? " active" : ""}`}
                aria-pressed={enabled}
                onClick={() => onParam(enabledId, enabled ? 0 : 1)}
              >
                {enabled ? "ON" : "OFF"}
              </button>
            </div>
            {enabled &&
              defs
                .filter((d) => !d.id.endsWith("Enabled"))
                .map((d) => {
                  if (d.options) {
                    const selected = Math.max(d.min, Math.min(d.max, Math.round(valueOf(d.id))));
                    return (
                      <label key={d.id} className="fx-param-select">
                        <span>{d.name}</span>
                        <select
                          aria-label={d.name}
                          value={selected}
                          onChange={(event) => onParam(d.id, Number(event.target.value))}
                        >
                          {d.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  }
                  return (
                    <Slider
                      key={d.id}
                      compact
                      label={d.name}
                      value={valueOf(d.id)}
                      min={d.min}
                      max={d.max}
                      defaultValue={d.default}
                      format={
                        d.unit === "dB"
                          ? (v) => `${v.toFixed(1)} dB`
                          : d.unit === "%"
                            ? (v) => `${v.toFixed(0)}%`
                            : d.unit === "ms"
                              ? (v) => `${v.toFixed(0)} ms`
                              : d.unit === "Hz"
                                ? (v) => `${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)} Hz`
                                : (v) => v.toFixed(2)
                      }
                      onCommit={(v) => onParam(d.id, v)}
                      onPreview={(v) => previewParam(d.id, v)}
                      onCancel={() => cancelParamPreview(d.id)}
                    />
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}
