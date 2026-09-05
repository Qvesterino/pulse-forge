import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_PARAMS, tryGetParamDef, clampParam as clampUltinaParam } from "../effects/ultina-core/contracts/parameterSchema";
import { DEFAULT_MODULE_ORDER } from "../effects/ultina-core/contracts/state";
import { FACTORY_PRESETS } from "../effects/ultina-core/presets/factoryPresets";
import { analyzeTrack, analyzeWithTarget } from "../effects/ultina-core/analysis/mixAssistant";
import {
  ASSISTANT_CHARACTERS,
  ASSISTANT_INTENSITIES,
  INSTRUMENT_LABELS,
  type AssistantCharacter,
  type AssistantIntensity,
} from "../effects/ultina-core/analysis/assistant";
import { extractFeatures } from "../effects/ultina-core/analysis/featureExtractor";
import { TARGET_LIBRARY, getTargetById } from "../effects/ultina-core/analysis/targetLibrary";
import { getExplanationForLocale } from "../effects/ultina-core/analysis/explanation";
import type { GlobalMeters } from "../effects/ultina-core/contracts/meters";
import { renderTrack } from "../rendering/track-renderer";
import { useDoc, useServices } from "./context";
import { Slider } from "./controls";

const MODULE_LABELS: Record<string, string> = {
  gate: "GATE",
  eq: "EQ",
  comp: "COMP",
  exciter: "EXC",
  transient: "TRNS",
  density: "DENS",
  sculptor: "SCULP",
  clipper: "CLIP",
  phase: "PHASE",
  unmask: "UNMSK",
};

/** Params hidden from the panel — host/engine concerns, not mix decisions. */
const HIDDEN = new Set(["eq.learnActive", "eq.maskingMeterEnabled"]);

export interface UltinaAbState {
  slots: { A?: Record<string, number>; B?: Record<string, number> };
  active: "A" | "B";
}

function formatUnit(value: number, unit: string): string {
  switch (unit) {
    case "db":
      return `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
    case "hz":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
    case "ms":
      return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
    case "percent":
      return `${Math.round(value)}%`;
    case "ratio":
      return `${value.toFixed(2)}:1`;
    case "degrees":
      return `${Math.round(value)}°`;
    default:
      return value.toFixed(2);
  }
}

/**
 * UltinaPanel — per-module editor for the Ultina Suite.
 *
 * Module chips follow the signal-graph order; the selected module's
 * parameters are generated from the VENDORED schema (ranges, defaults and
 * enum lists included), so the panel never drifts from the DSP. The EQ
 * module gets a dedicated 12-band editor with a response-curve sketch.
 */
export function UltinaPanel({
  trackId,
  fxId,
  params,
  degraded,
  onParam,
  onApplyPreset,
  onApplyProposal,
  abState,
  onAbStateChange,
  onAbLoad,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded?: boolean;
  onParam: (paramId: string, value: number) => void;
  onApplyPreset: (presetName: string, presetParams: Record<string, number>) => void;
  onApplyProposal: (
    label: string,
    toggles: { moduleType: string; enabled: boolean }[],
    changes: { parameterId: string; value: number }[],
  ) => void;
  /** Kept by the device card so collapse/expand does not erase A/B work. */
  abState?: UltinaAbState;
  onAbStateChange?: (state: UltinaAbState) => void;
  /**
   * Slot activation as ONE undoable command (restore params + active flag).
   * Absent → legacy path: onApplyPreset + local state flip.
   */
  onAbLoad?: (slot: "A" | "B") => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const [selectedModule, setSelectedModule] = useState<string>("comp");
  const [selectedEqBand, setSelectedEqBand] = useState(0);
  const [assistBusy, setAssistBusy] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [assistSummary, setAssistSummary] = useState<string[] | null>(null);
  const [character, setCharacter] = useState<AssistantCharacter>("punchy");
  const [intensity, setIntensity] = useState<AssistantIntensity>("balanced");

  // ── REFERENCE MATCH state ──
  const [refSources, setRefSources] = useState<{ id: string; name: string }[]>([]);
  const [refId, setRefId] = useState<string>("");
  const [libTargetId, setLibTargetId] = useState<string>("drums-balanced");
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSummary, setMatchSummary] = useState<string[] | null>(null);

  useEffect(() => {
    void services.userSamples.list().then((all) => setRefSources(all.slice(0, 40)));
  }, [services]);

  const enabled = (mod: string) => (params[`${mod}.enabled`] ?? 0) >= 0.5;

  // Params of the selected module (schema defs, excluding hidden + enable).
  const moduleParams = useMemo(
    () =>
      ALL_PARAMS.filter(
        (d) =>
          d.id.startsWith(`${selectedModule}.`) &&
          d.unit !== "boolean" &&
          !HIDDEN.has(d.id) &&
          !/\.enabled$/.test(d.id),
      ),
    [selectedModule],
  );
  const booleanParams = useMemo(
    () =>
      ALL_PARAMS.filter(
        (d) =>
          d.id.startsWith(`${selectedModule}.`) &&
          d.unit === "boolean" &&
          !HIDDEN.has(d.id) &&
          !/\.enabled$/.test(d.id) &&
          !/\.solo$/.test(d.id),
      ),
    [selectedModule],
  );
  const enumParams = useMemo(
    () => ALL_PARAMS.filter((d) => d.id.startsWith(`${selectedModule}.`) && d.unit === "enum" && !HIDDEN.has(d.id)),
    [selectedModule],
  );

  const valueOf = (id: string): number => params[id] ?? tryGetParamDef(id)?.defaultValue ?? 0;

  // ── PRO: A/B slots (host-side snapshots — abSlot in the DSP is only a label) ──
  const [localAbState, setLocalAbState] = useState<UltinaAbState>({ slots: {}, active: "A" });
  const currentAbState = abState ?? localAbState;
  const abSlots = currentAbState.slots;
  const abActive = currentAbState.active;
  const updateAbState = (next: UltinaAbState) => {
    if (onAbStateChange) onAbStateChange(next);
    else setLocalAbState(next);
  };
  const storeAbSlot = (slot: "A" | "B") => {
    updateAbState({ ...currentAbState, slots: { ...abSlots, [slot]: { ...params } } });
  };
  const clearAbSlot = (slot: "A" | "B") => {
    const nextSlots = { ...abSlots };
    delete nextSlots[slot];
    updateAbState({ ...currentAbState, slots: nextSlots });
  };
  const copyAbSlot = (from: "A" | "B", to: "A" | "B") => {
    const snapshot = abSlots[from];
    if (!snapshot) return;
    updateAbState({ ...currentAbState, slots: { ...abSlots, [to]: { ...snapshot } } });
  };
  const loadAbSlot = (slot: "A" | "B") => {
    if (slot === abActive) return;
    const snapshot = abSlots[slot];
    if (snapshot && onAbLoad) {
      // Persisted A/B: one command restores params AND the active slot.
      onAbLoad(slot);
      return;
    }
    if (snapshot) onApplyPreset(`Slot ${slot}`, snapshot); // exact restore: defaults + snapshot
    updateAbState({ ...currentAbState, active: slot });
  };
  const deltaOn = valueOf("global.deltaListen") >= 0.5;
  const gainMatchOn = valueOf("global.gainMatchEnabled") >= 0.5;

  // ── LIVE METERS: poll the worklet snapshot, draw on canvas, no re-renders ──
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lufsRef = useRef<HTMLSpanElement | null>(null);
  const truePeakRef = useRef<HTMLSpanElement | null>(null);
  const gainMatchStatusRef = useRef<HTMLSpanElement | null>(null);
  const grFillRef = useRef<HTMLDivElement | null>(null);
  const grTextRef = useRef<HTMLSpanElement | null>(null);
  const maskFillRef = useRef<HTMLDivElement | null>(null);
  const maskTextRef = useRef<HTMLSpanElement | null>(null);
  const metersRef = useRef<unknown>(null);

  useEffect(() => {
    const engineWithMeters = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    };
    // Only a mounted panel consumes meters — the engine gates the worklet's
    // analysis path so a closed Ultina costs zero metering CPU.
    engineWithMeters.setFxMetersEnabled?.(trackId, fxId, true);
    const id = setInterval(() => {
      metersRef.current = engineWithMeters.getFxMeters?.(trackId, fxId) ?? null;
      drawMeters();
    }, 66);
    return () => {
      engineWithMeters.setFxMetersEnabled?.(trackId, fxId, false);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, fxId, services]);

  // ── LIVE DRAG PREVIEW: knob moves are audible DURING the drag ──────────
  // Fire-and-forget write to the device runtime; the document write still
  // happens once on commit (onParam). Values are clamped here because the
  // worklet port trusts the host.
  const previewParam = (paramId: string, value: number) => {
    services.engine.previewFxParam?.(trackId, fxId, paramId, clampUltinaParam(paramId, value));
  };

  // ── EQ LEARN: resonance detection from the vendored learn meters ──────
  const [learnOn, setLearnOn] = useState(false);
  const [learnSuggestions, setLearnSuggestions] = useState<
    { freqHz: number; gainDb: number; q: number; severity: number }[]
  >([]);
  useEffect(() => {
    if (!learnOn) {
      setLearnSuggestions([]);
      return;
    }
    const id = setInterval(() => {
      const meters = metersRef.current as {
        learn?: {
          eq?: { isReady?: boolean; suggestions?: { freqHz: number; gainDb: number; q: number; severity: number }[] };
        };
      } | null;
      const learn = meters?.learn?.eq;
      if (learn?.isReady && learn.suggestions) {
        const signature = JSON.stringify(learn.suggestions);
        setLearnSuggestions((prev) => (JSON.stringify(prev) === signature ? prev : learn.suggestions!));
      }
    }, 300);
    return () => clearInterval(id);
  }, [learnOn]);

  /** Apply a learn suggestion: write it into the first disabled EQ band. */
  const applyLearnSuggestion = (s: { freqHz: number; gainDb: number; q: number }) => {
    for (let b = 0; b < 12; b++) {
      if (valueOf(`eq.band${b}.enabled`) < 0.5) {
        onParam(`eq.band${b}.enabled`, 1);
        onParam(`eq.band${b}.freqHz`, Math.max(20, Math.min(20000, s.freqHz)));
        onParam(`eq.band${b}.gainDb`, Math.max(-18, Math.min(18, s.gainDb)));
        onParam(`eq.band${b}.q`, Math.max(0.1, Math.min(24, s.q)));
        return;
      }
    }
  };

  const drawMeters = () => {
    const meters = metersRef.current as {
      global?: Partial<GlobalMeters>;
      modules?: Record<string, { gainReductionDb?: number; maskingScore?: number }>;
    } | null;
    const global = meters?.global;

    // Spectrum (64 bins, dBFS -100..0 → y) + waveform overlay (256 samples).
    const canvas = liveCanvasRef.current;
    if (canvas) {
      const ctx2d = canvas.getContext("2d");
      if (ctx2d) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.width;
        const h = canvas.height;
        ctx2d.clearRect(0, 0, w, h);
        ctx2d.fillStyle = "#0e0f12";
        ctx2d.fillRect(0, 0, w, h);
        // Spectrum curve.
        const spectrum = global?.inputSpectrumDb;
        if (spectrum && spectrum.length > 0) {
          ctx2d.beginPath();
          ctx2d.moveTo(0, h);
          for (let b = 0; b < spectrum.length; b++) {
            const x = (b / (spectrum.length - 1)) * w;
            const db = Math.max(-100, Math.min(0, spectrum[b]));
            const y = h - ((db + 100) / 100) * h;
            ctx2d.lineTo(x, y);
          }
          ctx2d.lineTo(w, h);
          ctx2d.closePath();
          ctx2d.fillStyle = "rgba(245, 158, 11, 0.30)";
          ctx2d.fill();
          ctx2d.strokeStyle = "#f59e0b";
          ctx2d.lineWidth = dpr;
          ctx2d.stroke();
        }
        // Oscilloscope waveform.
        const wave = global?.outputWaveform;
        if (wave && wave.length > 0) {
          ctx2d.beginPath();
          for (let i = 0; i < wave.length; i++) {
            const x = (i / (wave.length - 1)) * w;
            const y = h / 2 - Math.max(-1, Math.min(1, wave[i])) * (h * 0.45);
            if (i === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.strokeStyle = "rgba(244, 244, 245, 0.75)";
          ctx2d.lineWidth = dpr;
          ctx2d.stroke();
        }
      }
    }

    // LUFS + true peak readouts.
    if (lufsRef.current) {
      const lufs = global?.outputShortTermLufs ?? -70;
      lufsRef.current.textContent = lufs <= -69 ? "— LUFS" : `${lufs.toFixed(1)} LUFS`;
    }
    if (truePeakRef.current) {
      const tp = global?.outputTruePeakDb ?? -100;
      truePeakRef.current.textContent = tp <= -99 ? "TP —" : `TP ${tp.toFixed(1)}`;
    }
    if (gainMatchStatusRef.current) {
      const active = global?.autoGainActive;
      const correction = global?.autoGainCorrectionDb ?? 0;
      const error = global?.autoGainErrorDb ?? 0;
      const currentLufs = global?.outputShortTermLufs ?? -70;
      const hasSignal = Number.isFinite(currentLufs) && currentLufs > -69;
      gainMatchStatusRef.current.textContent =
        active === true && hasSignal
          ? `LOCK ${correction > 0 ? "+" : ""}${correction.toFixed(1)} dB · Δ ${error > 0 ? "+" : ""}${error.toFixed(1)}`
          : "WAITING FOR SIGNAL";
      gainMatchStatusRef.current.dataset.active = active === true && hasSignal ? "true" : "false";
    }

    // Compressor gain-reduction bar (module meters only exist while enabled).
    const comp = meters?.modules?.comp as { gainReductionDb?: number } | undefined;
    const gr = Math.max(0, Math.min(20, comp?.gainReductionDb ?? 0));
    if (grFillRef.current) grFillRef.current.style.width = `${(gr / 20) * 100}%`;
    if (grTextRef.current) grTextRef.current.textContent = gr > 0.1 ? `-${gr.toFixed(1)} dB` : "";

    // Unmask masking score bar.
    const unmask = meters?.modules?.unmask as { maskingScore?: number } | undefined;
    const score = Math.max(0, Math.min(1, unmask?.maskingScore ?? 0));
    if (maskFillRef.current) {
      maskFillRef.current.style.width = `${score * 100}%`;
      maskFillRef.current.style.background = score > 0.5 ? "#ef4444" : score > 0.2 ? "#f59e0b" : "#34d399";
    }
    if (maskTextRef.current) {
      maskTextRef.current.textContent = score > 0.02 ? `masking ${(score * 100).toFixed(0)}%` : "";
    }
  };

  // ── REFERENCE MATCH: target curve from a reference sample or library ──
  const runReferenceMatch = async () => {
    if (matchBusy) return;
    setMatchError(null);
    setMatchSummary(null);
    try {
      // 1. Target curve: reference sample's spectral profile, or library target.
      let targetCurve: number[];
      let targetName: string;
      const refBuffer = refId ? services.bank.get(refId) : null;
      if (refBuffer) {
        setMatchBusy("Analyzing reference…");
        await new Promise((r) => setTimeout(r, 30));
        const refCh = [
          refBuffer.getChannelData(0),
          refBuffer.numberOfChannels > 1 ? refBuffer.getChannelData(1) : refBuffer.getChannelData(0),
        ];
        const refFeatures = extractFeatures(refCh, refBuffer.sampleRate);
        if (!refFeatures.valid) {
          setMatchError("Reference is too short or too quiet to analyze.");
          return;
        }
        // Same dB domain analyzeWithTarget uses for the current mix.
        targetCurve = refFeatures.spectralProfile.map((b) =>
          b.ratio > 0 ? 10 * Math.log10(b.ratio * 10 + 1e-20) : -60,
        );
        targetName = "reference";
      } else {
        const lib = getTargetById(libTargetId);
        if (!lib) {
          setMatchError("Pick a reference sample or a target curve.");
          return;
        }
        targetCurve = lib.curve;
        targetName = lib.name;
      }

      // 2. Render the user's track and match toward the target.
      setMatchBusy("Rendering your track…");
      const buffer = await renderTrack(doc, trackId, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.5,
      });
      setMatchBusy("Matching tonal balance…");
      await new Promise((r) => setTimeout(r, 30));
      const result = analyzeWithTarget(
        {
          channels: [buffer.getChannelData(0), buffer.getChannelData(1)],
          sampleRate: buffer.sampleRate,
          minimumDuration: 2,
        },
        targetCurve,
      );
      if (result.kind === "insufficient") {
        setMatchError(`Not enough material: ${result.reason}`);
        return;
      }
      if (result.kind === "error") {
        setMatchError(result.message);
        return;
      }
      const proposal = result.proposal;
      const eqChanges = proposal.changes.filter((c) => c.parameterId.startsWith("eq.band"));
      if (eqChanges.length === 0) {
        setMatchSummary([`Tonal balance already within ±1.5 dB of ${targetName} — no EQ moves needed.`]);
        return;
      }
      onApplyProposal(
        `Reference match (${targetName})`,
        proposal.moduleToggles.map((t) => ({ moduleType: t.moduleType, enabled: t.enabled })),
        eqChanges.map((c) => ({ parameterId: c.parameterId, value: c.value })),
      );
      const lines: string[] = [
        `Target: ${targetName} · ${INSTRUMENT_LABELS[proposal.instrument] ?? proposal.instrument}`,
      ];
      for (const c of eqChanges.slice(0, 6)) {
        const bandMatch = /eq\.band(\d+)\./.exec(c.parameterId);
        const bandNo = bandMatch ? Number(bandMatch[1]) + 1 : 0;
        lines.push(
          `EQ B${bandNo} ${c.value > 0 ? "+" : ""}${c.value.toFixed(1)} dB — ${getExplanationForLocale(c.reasonCode, "sk")}`,
        );
      }
      if (eqChanges.length > 6) lines.push(`…a ${eqChanges.length - 6} ďalších EQ zmien`);
      setMatchSummary(lines);
    } catch (err) {
      setMatchError(`Reference match failed: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setMatchBusy(null);
    }
  };

  const runMixAssist = async () => {
    if (assistBusy) return;
    setAssistError(null);
    setAssistSummary(null);
    try {
      setAssistBusy("Rendering track…");
      const buffer = await renderTrack(doc, trackId, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.5,
      });
      setAssistBusy("Analyzing…");
      // Yield so the busy label paints before the (sync, heavy) analysis.
      await new Promise((r) => setTimeout(r, 30));
      const result = analyzeTrack({
        channels: [buffer.getChannelData(0), buffer.getChannelData(1)],
        sampleRate: buffer.sampleRate,
        character,
        intensity,
        minimumDuration: 2,
      });
      if (result.kind === "insufficient") {
        setAssistError(`Not enough material: ${result.reason}`);
        return;
      }
      if (result.kind === "error") {
        setAssistError(result.message);
        return;
      }
      const proposal = result.proposal;
      onApplyProposal(
        `Mix assist (${INSTRUMENT_LABELS[proposal.instrument] ?? proposal.instrument})`,
        proposal.moduleToggles.map((t) => ({ moduleType: t.moduleType, enabled: t.enabled })),
        proposal.changes.map((c) => ({ parameterId: c.parameterId, value: c.value })),
      );
      // Human summary in Slovak (the vendored plugin ships sk explanations).
      const lines: string[] = [
        `Nástroj: ${INSTRUMENT_LABELS[proposal.instrument] ?? proposal.instrument} · ${proposal.analyzedDuration.toFixed(1)}s`,
      ];
      for (const t of proposal.moduleToggles) {
        lines.push(
          `${MODULE_LABELS[t.moduleType] ?? t.moduleType} ${t.enabled ? "ON" : "OFF"} — ${getExplanationForLocale(t.reasonCode, "sk")}`,
        );
      }
      for (const c of proposal.changes.slice(0, 6)) {
        lines.push(
          `${c.parameterId} → ${formatUnit(c.value, tryGetParamDef(c.parameterId)?.unit ?? "generic")} — ${getExplanationForLocale(c.reasonCode, "sk")}`,
        );
      }
      if (proposal.changes.length > 6) lines.push(`…a ${proposal.changes.length - 6} ďalších zmien`);
      setAssistSummary(lines);
    } catch (err) {
      setAssistError(`Mix assist failed: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setAssistBusy(null);
    }
  };

  // EQ curve sketch: bells/shelves from enabled band params. A visual
  // approximation (log-freq x, gain-mapped y) — the DSP itself is exact.
  const eqBands = useMemo(() => {
    const bands: { index: number; freq: number; gain: number; q: number; shape: number; enabled: boolean }[] = [];
    for (let i = 0; i < 12; i++) {
      bands.push({
        index: i,
        freq: valueOf(`eq.band${i}.freqHz`),
        gain: valueOf(`eq.band${i}.gainDb`),
        q: valueOf(`eq.band${i}.q`),
        shape: valueOf(`eq.band${i}.shape`),
        enabled: valueOf(`eq.band${i}.enabled`) >= 0.5,
      });
    }
    return bands;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const eqSelected = selectedModule === "eq";

  return (
    <div className="fxeq-panel ultina-panel" aria-label="Ultina module editor">
      {degraded && <div className="fxeq-degraded">AudioWorklet unavailable — Ultina is bypassed (1:1 signal)</div>}

      {/* ── LIVE METERS ────────────────────────────────────────────── */}
      <div className="ultina-live" aria-label="Ultina live meters">
        <canvas ref={liveCanvasRef} className="ultina-live-canvas" width={512} height={96} />
        <div className="ultina-live-row">
          <span className="ultina-lufs" ref={lufsRef}>
            — LUFS
          </span>
          <span className="ultina-truepeak" ref={truePeakRef}>
            TP —
          </span>
          <div className="ultina-meter" title="Compressor gain reduction">
            <span className="ultina-meter-label">GR</span>
            <div className="ultina-meter-track">
              <div className="ultina-meter-fill" ref={grFillRef} style={{ background: "#f59e0b" }} />
            </div>
            <span className="ultina-meter-text" ref={grTextRef} />
          </div>
          <div className="ultina-meter" title="Unmask masking score">
            <span className="ultina-meter-label">MSK</span>
            <div className="ultina-meter-track">
              <div className="ultina-meter-fill" ref={maskFillRef} style={{ background: "#34d399" }} />
            </div>
            <span className="ultina-meter-text" ref={maskTextRef} />
          </div>
        </div>
      </div>

      {/* ── REFERENCE MATCH ────────────────────────────────────────── */}
      <div className="ultina-assist ultina-ref" aria-label="Reference match">
        <div className="ultina-assist-head">
          <span className="ultina-assist-title">REFERENCE MATCH</span>
          <button
            type="button"
            className="btn btn-export"
            disabled={!!matchBusy}
            title="Match this track's tonal balance toward a reference sample or a target curve"
            onClick={() => void runReferenceMatch()}
          >
            {matchBusy ?? "🎯 MATCH"}
          </button>
        </div>
        <label className="collab-field">
          <span>REFERENCE SAMPLE (optional — its balance becomes the target)</span>
          <select value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">— none: use target curve —</option>
            {refSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {!refId && (
          <label className="collab-field">
            <span>TARGET CURVE</span>
            <select value={libTargetId} onChange={(e) => setLibTargetId(e.target.value)}>
              {TARGET_LIBRARY.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {matchError && <div className="fxeq-degraded">{matchError}</div>}
        {matchSummary && (
          <div className="ultina-assist-summary">
            {matchSummary.map((line, i) => (
              <div key={i} className="ultina-assist-line">
                {line}
              </div>
            ))}
            <div className="ultina-assist-note">EQ zmeny aplikované ako jedno gesto — Ctrl+Z vráti všetko.</div>
          </div>
        )}
      </div>

      {/* ── EQ LEARN ───────────────────────────────────────────────── */}
      <div className="ultina-assist ultina-ref" aria-label="EQ learn">
        <div className="ultina-assist-head">
          <span className="ultina-assist-title">EQ LEARN</span>
          <button
            type="button"
            className={`btn btn-export${learnOn ? " active" : ""}`}
            aria-pressed={learnOn}
            title="Play your track — Ultina detects resonances and suggests cuts"
            onClick={() => setLearnOn((v) => !v)}
          >
            {learnOn ? "● LEARNING" : "LEARN"}
          </button>
        </div>
        {learnOn && learnSuggestions.length > 0 && (
          <div className="ultina-assist-summary">
            {learnSuggestions.slice(0, 4).map((s, i) => (
              <div key={i} className="ozvena-weights" style={{ alignItems: "center" }}>
                <span>{s.freqHz >= 1000 ? `${(s.freqHz / 1000).toFixed(1)}k` : Math.round(s.freqHz)} Hz</span>
                <span style={{ color: "#ef4444" }}>{s.gainDb.toFixed(1)} dB</span>
                <button
                  type="button"
                  className="btn btn-small"
                  title={`Apply: ${Math.round(s.freqHz)} Hz ${s.gainDb.toFixed(1)} dB (Q ${s.q.toFixed(1)}) on the first free band`}
                  onClick={() => applyLearnSuggestion(s)}
                >
                  APPLY
                </button>
              </div>
            ))}
            <div className="ultina-assist-note">Keep the track playing — suggestions refine as it analyzes.</div>
          </div>
        )}
      </div>

      {/* ── PRO: delta listen / A/B / gain match ───────────────────── */}
      <div className="ultina-pro" aria-label="Pro tools">
        <div className="ultina-pro-group">
          <button
            type="button"
            className={`btn btn-small${deltaOn ? " active" : ""}`}
            aria-pressed={deltaOn}
            title="Hear ONLY what Ultina removes — the delta between dry and processed"
            onClick={() => onParam("global.deltaListen", deltaOn ? 0 : 1)}
          >
            DELTA
          </button>
          <button
            type="button"
            className={`btn btn-small${gainMatchOn ? " active" : ""}`}
            aria-pressed={gainMatchOn}
            title="Level-locked tweaking — output loudness matched while you turn knobs"
            onClick={() => onParam("global.gainMatchEnabled", gainMatchOn ? 0 : 1)}
          >
            G-MATCH
          </button>
          {gainMatchOn && (
            <div className="ultina-pro-lufs">
              <Slider
                compact
                label="TARGET"
                value={valueOf("global.autogainTargetLufs")}
                min={-30}
                max={0}
                defaultValue={-14}
                format={(v) => `${v.toFixed(1)} LUFS`}
                onCommit={(v) => onParam("global.autogainTargetLufs", v)}
                onPreview={(v) => previewParam("global.autogainTargetLufs", v)}
              />
              <div className="ultina-gain-match-meta">
                <span className="ultina-gain-match-status" ref={gainMatchStatusRef} role="status">
                  WAITING FOR SIGNAL
                </span>
                <span className="ultina-gain-match-note">output trim only · safe to A/B</span>
              </div>
            </div>
          )}
        </div>
        <div className="ultina-pro-group">
          <span className="ultina-pro-label">A/B</span>
          {(["A", "B"] as const).map((slot) => (
            <button
              key={slot}
              type="button"
              className={`btn btn-small${abActive === slot ? " active" : ""}`}
              aria-pressed={abActive === slot}
              title={abSlots[slot] ? `Load slot ${slot}` : `Slot ${slot} (empty — use STORE)`}
              onClick={() => loadAbSlot(slot)}
            >
              {slot}
              {abSlots[slot] ? "•" : ""}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-small"
            title={`Store current settings into slot ${abActive}`}
            onClick={() => storeAbSlot(abActive)}
          >
            STORE
          </button>
          <button
            type="button"
            className="btn btn-small"
            title={`Copy slot A to slot B`}
            aria-label="Copy A to B"
            disabled={!abSlots.A}
            onClick={() => copyAbSlot("A", "B")}
          >
            A → B
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Copy slot B to slot A"
            aria-label="Copy B to A"
            disabled={!abSlots.B}
            onClick={() => copyAbSlot("B", "A")}
          >
            B → A
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger"
            title={`Clear slot ${abActive}`}
            aria-label={`Clear slot ${abActive}`}
            disabled={!abSlots[abActive]}
            onClick={() => clearAbSlot(abActive)}
          >
            CLEAR
          </button>
          <span className="ultina-ab-status" role="status">
            {abActive} ACTIVE · {abSlots[abActive] ? "STORED" : "EMPTY"}
          </span>
        </div>
      </div>

      {/* ── MIX ASSIST ─────────────────────────────────────────────── */}
      <div className="ultina-assist" aria-label="Mix assistant">
        <div className="ultina-assist-head">
          <span className="ultina-assist-title">MIX ASSIST</span>
          <button
            type="button"
            className="btn btn-export"
            disabled={!!assistBusy}
            title="Render this track, analyze it and propose mix settings"
            onClick={() => void runMixAssist()}
          >
            {assistBusy ?? "⚡ MIX ASSIST"}
          </button>
        </div>
        <div className="ultina-assist-opts">
          <label className="collab-field">
            <span>CHARACTER</span>
            <select value={character} onChange={(e) => setCharacter(e.target.value as AssistantCharacter)}>
              {ASSISTANT_CHARACTERS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="collab-field">
            <span>INTENSITY</span>
            <select value={intensity} onChange={(e) => setIntensity(e.target.value as AssistantIntensity)}>
              {ASSISTANT_INTENSITIES.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
        </div>
        {assistError && <div className="fxeq-degraded">{assistError}</div>}
        {assistSummary && (
          <div className="ultina-assist-summary">
            {assistSummary.map((line, i) => (
              <div key={i} className="ultina-assist-line">
                {line}
              </div>
            ))}
            <div className="ultina-assist-note">Aplikované ako jedno gesto — Ctrl+Z vráti všetko.</div>
          </div>
        )}
      </div>

      <div className="fxeq-preset-row">
        <select
          className="fxeq-preset-select"
          aria-label="Ultina preset"
          defaultValue=""
          onChange={(event) => {
            const preset = FACTORY_PRESETS.find((p) => p.name === event.target.value);
            if (preset) onApplyPreset(preset.name, preset.params);
            event.target.value = "";
          }}
        >
          <option value="">PRESET…</option>
          {FACTORY_PRESETS.map((p) => (
            <option key={p.id} value={p.name}>
              {p.module.toUpperCase()} · {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Module chips in graph order */}
      <div className="fxeq-band-chips" role="group" aria-label="Select module">
        {DEFAULT_MODULE_ORDER.map((mod) => (
          <button
            key={mod}
            type="button"
            className={`btn btn-small${selectedModule === mod ? " active" : ""}${enabled(mod) ? " ultina-mod-on" : ""}`}
            aria-pressed={selectedModule === mod}
            title={enabled(mod) ? `${MODULE_LABELS[mod]} — enabled` : `${MODULE_LABELS[mod]} — off`}
            onClick={() => setSelectedModule(mod)}
          >
            {MODULE_LABELS[mod]}
          </button>
        ))}
      </div>

      {/* Enable toggle for the selected module */}
      <div className="ultina-module-head">
        <span className="fxeq-module-tag ultina-tag">{MODULE_LABELS[selectedModule]}</span>
        <button
          type="button"
          className={`btn btn-small${enabled(selectedModule) ? " active" : ""}`}
          aria-pressed={enabled(selectedModule)}
          onClick={() => onParam(`${selectedModule}.enabled`, enabled(selectedModule) ? 0 : 1)}
        >
          {enabled(selectedModule) ? "ON" : "OFF"}
        </button>
      </div>

      {enabled(selectedModule) && (
        <>
          {/* Enum params (shapes, modes, channel modes) as selects */}
          {enumParams.length > 0 && (
            <div className="ultina-enum-row">
              {enumParams.map((d) => {
                const value = valueOf(d.id);
                const enums = d.enumValues ?? [];
                // EQ band shapes/modes are per-band — only show global enums here.
                if (/^eq\.band\d+\./.test(d.id)) return null;
                return (
                  <label key={d.id} className="collab-field">
                    <span>{d.name.toUpperCase()}</span>
                    <select value={value} onChange={(e) => onParam(d.id, Number(e.target.value))}>
                      {enums.map((label, idx) => (
                        <option key={label} value={idx}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          )}

          {/* Boolean extras as toggles */}
          {booleanParams.length > 0 && (
            <div className="ultina-bool-row">
              {booleanParams.map((d) => {
                const on = valueOf(d.id) >= 0.5;
                return (
                  <button
                    key={d.id}
                    type="button"
                    className={`btn btn-small${on ? " active" : ""}`}
                    aria-pressed={on}
                    onClick={() => onParam(d.id, on ? 0 : 1)}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* EQ: dedicated 12-band editor + response sketch */}
          {eqSelected ? (
            <div className="ultina-eq">
              <svg
                viewBox="0 0 100 44"
                preserveAspectRatio="none"
                className="ultina-eq-curve"
                role="img"
                aria-label="EQ response sketch"
              >
                <line x1="0" y1="26" x2="100" y2="26" className="eq-response-zero" />
                {eqBands
                  .filter((b) => b.enabled && b.gain !== 0)
                  .map((b) => {
                    const cx = (Math.log(Math.max(20, b.freq) / 20) / Math.log(20000 / 20)) * 100;
                    const cy = 26 - b.gain * 1.15;
                    const rw = Math.max(3, Math.min(22, 9 / Math.max(0.35, b.q)));
                    return (
                      <ellipse
                        key={b.index}
                        cx={cx}
                        cy={cy + (cy - 26) * 0.12}
                        rx={rw}
                        ry={Math.max(1.5, Math.abs(b.gain) * 1.05)}
                        className="ultina-eq-blob"
                        opacity={b.index === selectedEqBand ? 0.95 : 0.55}
                      />
                    );
                  })}
              </svg>
              <div className="fxeq-band-chips" role="group" aria-label="Select EQ band">
                {eqBands.map((b) => (
                  <button
                    key={b.index}
                    type="button"
                    className={`btn btn-small${selectedEqBand === b.index ? " active" : ""}${b.enabled ? " ultina-mod-on" : ""}`}
                    aria-pressed={selectedEqBand === b.index}
                    onClick={() => setSelectedEqBand(b.index)}
                  >
                    {b.index + 1}
                  </button>
                ))}
              </div>
              {(() => {
                const band = eqBands[selectedEqBand];
                if (!band) return null;
                const prefix = `eq.band${band.index}`;
                const bandDefs = ALL_PARAMS.filter(
                  (d) => d.id.startsWith(`${prefix}.`) && d.unit !== "boolean" && !d.id.endsWith(".solo"),
                );
                return (
                  <>
                    <button
                      type="button"
                      className={`btn btn-small${band.enabled ? " active" : ""}`}
                      aria-pressed={band.enabled}
                      onClick={() => onParam(`${prefix}.enabled`, band.enabled ? 0 : 1)}
                    >
                      BAND {band.index + 1} — {band.enabled ? "ON" : "OFF"}
                    </button>
                    {band.enabled &&
                      bandDefs.map((d) =>
                        d.unit === "enum" ? (
                          <label key={d.id} className="collab-field">
                            <span>{d.name.toUpperCase()}</span>
                            <select value={valueOf(d.id)} onChange={(e) => onParam(d.id, Number(e.target.value))}>
                              {(d.enumValues ?? []).map((label, idx) => (
                                <option key={label} value={idx}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <Slider
                            key={d.id}
                            compact
                            label={d.name}
                            value={valueOf(d.id)}
                            min={d.minValue}
                            max={d.maxValue}
                            defaultValue={d.defaultValue}
                            format={(v) => formatUnit(v, d.unit)}
                            onCommit={(v) => onParam(d.id, v)}
                            onPreview={(v) => previewParam(d.id, v)}
                          />
                        ),
                      )}
                  </>
                );
              })()}
            </div>
          ) : (
            /* Non-EQ modules: flat slider list from the schema */
            moduleParams.map((d) => (
              <Slider
                key={d.id}
                compact
                label={d.name}
                value={valueOf(d.id)}
                min={d.minValue}
                max={d.maxValue}
                defaultValue={d.defaultValue}
                format={(v) => formatUnit(v, d.unit)}
                onCommit={(v) => onParam(d.id, v)}
                onPreview={(v) => previewParam(d.id, v)}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}
