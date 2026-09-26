import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_PARAMS,
  tryGetParamDef,
  clampParam as clampUltinaParam,
} from "../effects/ultina-core/contracts/parameterSchema";
import { DEFAULT_MODULE_ORDER } from "../effects/ultina-core/contracts/state";
import { FACTORY_PRESETS } from "../effects/ultina-core/presets/factoryPresets";
import { ULTINA_PRESET_SCHEMA_VERSION, type UltinaPresetEntry } from "../persistence/UltinaPresetRepository";
import {
  ASSISTANT_CHARACTERS,
  ASSISTANT_INTENSITIES,
  INSTRUMENT_LABELS,
  type AssistantCharacter,
  type AssistantIntensity,
  type UltinaProposal,
} from "../effects/ultina-core/analysis/assistant";
import type { ProjectDocument } from "../project-model/types";
import { applyUltinaProposal } from "../commands/commands";
import { matchAuditionLevels, playAuditionBuffer, stopAudition } from "../intent/audition";
import { TARGET_LIBRARY, getTargetById } from "../effects/ultina-core/analysis/targetLibrary";
import { getExplanationForLocale } from "../effects/ultina-core/analysis/explanation";
import {
  UltinaAnalysisCancelledError,
  isUltinaAnalysisCancelledError,
  startUltinaAnalysis,
  startUltinaLoudnessMeasurement,
  startUltinaTargetAnalysis,
  type UltinaAnalysisTask,
} from "../analysis/ultinaAnalysisClient";
import type { GlobalMeters } from "../effects/ultina-core/contracts/meters";
import { renderTrack } from "../rendering/track-renderer";
import { useServices } from "./context";
import { Slider } from "./controls";
import { EffectAbControls, type EffectAbState } from "./EffectAbControls";

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

type UltinaReview = {
  kind: "mix" | "match";
  baseDoc: ProjectDocument;
  before: AudioBuffer;
  after: AudioBuffer;
  beforeGain: number;
  afterGain: number;
  label: string;
  goal: string;
  lines: readonly string[];
  toggles: { moduleType: string; enabled: boolean }[];
  changes: { parameterId: string; value: number }[];
};

export type UltinaAbState = EffectAbState;

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
  bypassed,
  onParam,
  onApplyPreset,
  onApplyProposal,
  abState,
  onAbStateChange,
  onAbLoad,
  docked = false,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded?: boolean;
  bypassed?: boolean;
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
  docked?: boolean;
}) {
  const services = useServices();
  const [selectedModule, setSelectedModule] = useState<string>("comp");
  const [selectedEqBand, setSelectedEqBand] = useState(0);
  const [dockPage, setDockPage] = useState<"modules" | "assist" | "tools">("modules");
  const [dockAssist, setDockAssist] = useState<"mix" | "match" | "learn">("mix");
  const [moduleParamPage, setModuleParamPage] = useState(0);
  const [assistBusy, setAssistBusy] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [assistSummary, setAssistSummary] = useState<string[] | null>(null);
  const [pendingReview, setPendingReview] = useState<UltinaReview | null>(null);
  const [reviewPlaying, setReviewPlaying] = useState<"before" | "after" | null>(null);
  const [character, setCharacter] = useState<AssistantCharacter>("punchy");
  const [intensity, setIntensity] = useState<AssistantIntensity>("balanced");

  // ── USER PRESETS: named snapshots of the full parameter map ──
  const [userPresets, setUserPresets] = useState<UltinaPresetEntry[]>([]);
  const [selectedUserPresetId, setSelectedUserPresetId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void services.ultinaPresets
      .list()
      .then((all) => {
        if (!cancelled) setUserPresets(all);
      })
      .catch(() => {
        /* repository already degrades to [] — nothing to surface here */
      });
    return () => {
      cancelled = true;
    };
  }, [services.ultinaPresets]);

  // ── REFERENCE MATCH state ──
  const [refSources, setRefSources] = useState<{ id: string; name: string }[]>([]);
  const [refId, setRefId] = useState<string>("");
  const [libTargetId, setLibTargetId] = useState<string>("drums-balanced");
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSummary, setMatchSummary] = useState<string[] | null>(null);
  const analysisRunRef = useRef<{
    cancelled: boolean;
    cancelWorker: (() => void) | null;
  } | null>(null);
  const pendingReviewRef = useRef<UltinaReview | null>(null);
  const reviewPlayingRef = useRef(false);

  const updatePendingReview = (review: UltinaReview | null) => {
    pendingReviewRef.current = review;
    setPendingReview(review);
  };

  const stopReviewAudio = () => {
    if (reviewPlayingRef.current) stopAudition();
    reviewPlayingRef.current = false;
    setReviewPlaying(null);
  };

  useEffect(() => {
    const unsubscribe = services.store.subscribe(() => {
      const review = pendingReviewRef.current;
      if (!review || services.store.getDoc() === review.baseDoc) return;
      if (reviewPlayingRef.current) stopAudition();
      reviewPlayingRef.current = false;
      pendingReviewRef.current = null;
      setReviewPlaying(null);
      setPendingReview(null);
      const message = "Projekt sa počas audície zmenil. VLYX návrh je zastaraný — analyzuj ho znova.";
      if (review.kind === "mix") setAssistError(message);
      else setMatchError(message);
    });
    return () => {
      unsubscribe();
      const run = analysisRunRef.current;
      if (run) {
        run.cancelled = true;
        run.cancelWorker?.();
      }
      analysisRunRef.current = null;
      if (reviewPlayingRef.current) stopAudition();
      reviewPlayingRef.current = false;
      pendingReviewRef.current = null;
    };
  }, [services.store]);

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

  const modulePageSize = docked ? 4 : Math.max(1, moduleParams.length);
  const modulePageCount = Math.max(1, Math.ceil(moduleParams.length / modulePageSize));
  const visibleModuleParams = moduleParams.slice(
    moduleParamPage * modulePageSize,
    (moduleParamPage + 1) * modulePageSize,
  );
  useEffect(() => setModuleParamPage(0), [selectedModule]);

  const valueOf = (id: string): number => params[id] ?? tryGetParamDef(id)?.defaultValue ?? 0;

  // ── PRO: A/B slots (host-side snapshots — abSlot in the DSP is only a label) ──
  const [localAbState, setLocalAbState] = useState<UltinaAbState>({ slots: {}, active: "A" });
  const currentAbState = abState ?? localAbState;
  const updateAbState = (next: UltinaAbState) => {
    if (onAbStateChange) onAbStateChange(next);
    else setLocalAbState(next);
  };
  const loadAbSlot = (slot: "A" | "B") => {
    const snapshot = currentAbState.slots[slot];
    if (!snapshot) return;
    if (onAbLoad) {
      // Persisted A/B: one command restores params AND the active slot.
      onAbLoad(slot);
      return;
    }
    onApplyPreset(`Slot ${slot}`, snapshot); // exact restore: defaults + snapshot
    updateAbState({ ...currentAbState, active: slot });
  };
  const deltaOn = valueOf("global.deltaListen") >= 0.5;
  const gainMatchOn = valueOf("global.gainMatchEnabled") >= 0.5;

  const beginAnalysisRun = () => {
    const run = { cancelled: false, cancelWorker: null as (() => void) | null };
    analysisRunRef.current = run;
    return run;
  };

  const ensureAnalysisActive = (run: { cancelled: boolean }) => {
    if (run.cancelled) throw new UltinaAnalysisCancelledError();
  };

  const awaitAnalysis = async <T,>(
    task: UltinaAnalysisTask<T>,
    run: { cancelled: boolean; cancelWorker: (() => void) | null },
  ): Promise<T> => {
    ensureAnalysisActive(run);
    run.cancelWorker = task.cancel;
    try {
      return await task.promise;
    } finally {
      if (run.cancelWorker === task.cancel) run.cancelWorker = null;
    }
  };

  const measureIntegratedLufs = async (
    buffer: AudioBuffer,
    run: { cancelled: boolean; cancelWorker: (() => void) | null },
  ): Promise<number | null> => {
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) =>
      buffer.getChannelData(index),
    );
    if (channels.length === 0) return null;
    const result = await awaitAnalysis(startUltinaLoudnessMeasurement(channels, buffer.sampleRate), run);
    return result.integratedLufs;
  };

  const stageProposalReview = async (args: {
    kind: UltinaReview["kind"];
    run: { cancelled: boolean; cancelWorker: (() => void) | null };
    baseDoc: ProjectDocument;
    before: AudioBuffer;
    proposal: UltinaProposal;
    label: string;
    goal: string;
    changes: { parameterId: string; value: number }[];
  }) => {
    const sourceToggles = Array.isArray(args.proposal.moduleToggles) ? args.proposal.moduleToggles : [];
    const toggles = sourceToggles.flatMap((toggle) => {
      if (typeof toggle.moduleType !== "string" || typeof toggle.enabled !== "boolean") return [];
      return tryGetParamDef(`${toggle.moduleType}.enabled`)
        ? [{ moduleType: toggle.moduleType, enabled: toggle.enabled }]
        : [];
    });
    const sourceChanges = Array.isArray(args.changes) ? args.changes : [];
    const changes = sourceChanges
      .filter(
        (change) =>
          typeof change.parameterId === "string" &&
          Number.isFinite(change.value) &&
          Boolean(tryGetParamDef(change.parameterId)),
      )
      .map((change) => ({
        parameterId: change.parameterId,
        value: clampUltinaParam(change.parameterId, change.value),
      }));
    if (toggles.length === 0 && changes.length === 0) {
      const message = "VLYX nenašiel zmenu, ktorú by bolo treba navrhnúť.";
      if (args.kind === "mix") setAssistSummary([message]);
      else setMatchSummary([message]);
      return;
    }

    const reviewBusy = args.kind === "mix" ? setAssistBusy : setMatchBusy;
    reviewBusy("Rendering proposed A/B…");
    const nextDoc = applyUltinaProposal(args.baseDoc, trackId, fxId, args.label, toggles, changes).execute(
      args.baseDoc,
    );
    const after = await renderTrack(nextDoc, trackId, services.bank, {
      mode: "song",
      sampleRate: 44100,
      tailSeconds: 0.5,
    });
    ensureAnalysisActive(args.run);
    if (services.store.getDoc() !== args.baseDoc) throw new Error("Projekt sa počas analýzy zmenil; návrh sa zahodil.");
    reviewBusy("Measuring loudness-matched A/B…");
    const beforeLufs = await measureIntegratedLufs(args.before, args.run);
    const afterLufs = await measureIntegratedLufs(after, args.run);
    ensureAnalysisActive(args.run);
    if (services.store.getDoc() !== args.baseDoc) throw new Error("Projekt sa počas merania zmenil; návrh sa zahodil.");
    const levelMatch = matchAuditionLevels(beforeLufs, afterLufs);

    const instrument = INSTRUMENT_LABELS[args.proposal.instrument] ?? args.proposal.instrument;
    const confidence = Number.isFinite(args.proposal.classification.confidence)
      ? `${Math.round(args.proposal.classification.confidence * 100)} %`
      : "nezmeraná";
    const features = args.proposal.features;
    const metric = (value: number, unit: string) => (Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : "n/a");
    const trackName = args.baseDoc.tracks.find((track) => track.id === trackId)?.name ?? trackId;
    const lines = [
      levelMatch
        ? `A/B LEVEL — BS.1770 integrated ${beforeLufs?.toFixed(1)} → ${afterLufs?.toFixed(1)} LUFS; preview matched at ${levelMatch.targetLufs.toFixed(1)} LUFS (before ${levelMatch.beforeGainDb.toFixed(1)} dB, proposal ${levelMatch.afterGainDb.toFixed(1)} dB). Preview-only gain; no upward normalization.`
        : "A/B LEVEL — one render was too quiet or too short to measure; preview uses original render levels.",
      `EVIDENCE — ${instrument} (${confidence} confidence), ${args.proposal.analyzedDuration.toFixed(1)} s; VLYX feature estimates: ${metric(features.lufsIntegrated, "LUFS")}, crest ${metric(features.crestFactorDb, "dB")}, dynamic range ${metric(features.dynamicRangeDb, "dB")}.`,
      `AFFECTED — track “${trackName}” · VLYX only.`,
      "TRADE-OFF — this rule-based starting point can change tone and dynamics; compare both renders before applying. The project is still unchanged.",
    ];
    for (const toggle of sourceToggles) {
      if (typeof toggle.moduleType !== "string" || typeof toggle.enabled !== "boolean") continue;
      if (!toggles.some((valid) => valid.moduleType === toggle.moduleType)) continue;
      lines.push(
        `MODULE — ${MODULE_LABELS[toggle.moduleType] ?? toggle.moduleType} ${toggle.enabled ? "ON" : "OFF"} — ${getExplanationForLocale(toggle.reasonCode, "en")}`,
      );
    }
    for (const change of changes.slice(0, 8)) {
      const original = args.proposal.changes.find((candidate) => candidate.parameterId === change.parameterId);
      lines.push(
        `CHANGE — ${change.parameterId} → ${formatUnit(change.value, tryGetParamDef(change.parameterId)?.unit ?? "generic")} — ${original ? getExplanationForLocale(original.reasonCode, "en") : "reference-curve correction"}`,
      );
    }
    if (changes.length > 8) lines.push(`CHANGE — …and ${changes.length - 8} more parameter changes`);
    if (toggles.length !== sourceToggles.length || changes.length !== sourceChanges.length) {
      lines.push("SAFETY — unsupported parameter suggestions were filtered before audition and apply.");
    }
    updatePendingReview({
      kind: args.kind,
      baseDoc: args.baseDoc,
      before: args.before,
      after,
      beforeGain: levelMatch?.beforeGain ?? 1,
      afterGain: levelMatch?.afterGain ?? 1,
      label: args.label,
      goal: args.goal,
      lines,
      toggles,
      changes,
    });
  };

  const playReview = (part: "before" | "after") => {
    const review = pendingReviewRef.current;
    if (!review) return;
    if (services.transport.playing) {
      const message = "Zastav transport pred offline A/B posluchom, aby sa nemiešal s bežiacou skladbou.";
      if (review.kind === "mix") setAssistError(message);
      else setMatchError(message);
      return;
    }
    if (services.store.getDoc() !== review.baseDoc) {
      updatePendingReview(null);
      stopReviewAudio();
      const message = "Projekt sa zmenil. Vytvor nový návrh z aktuálneho stavu.";
      if (review.kind === "mix") setAssistError(message);
      else setMatchError(message);
      return;
    }
    const buffer = part === "before" ? review.before : review.after;
    reviewPlayingRef.current = true;
    setReviewPlaying(part);
    playAuditionBuffer(
      buffer,
      () => {
        reviewPlayingRef.current = false;
        setReviewPlaying(null);
      },
      part === "before" ? review.beforeGain : review.afterGain,
    );
  };

  const applyPendingReview = () => {
    const review = pendingReviewRef.current;
    if (!review) return;
    if (services.store.getDoc() !== review.baseDoc) {
      stopReviewAudio();
      updatePendingReview(null);
      const message = "Projekt sa zmenil. Návrh je zastaraný a treba ho vytvoriť znova.";
      if (review.kind === "mix") setAssistError(message);
      else setMatchError(message);
      return;
    }
    stopReviewAudio();
    updatePendingReview(null);
    try {
      onApplyProposal(review.label, review.toggles, review.changes);
      if (review.kind === "mix")
        setAssistSummary([...review.lines, "APPLIED — one undoable gesture; Ctrl+Z restores the previous settings."]);
      else setMatchSummary([...review.lines, "APPLIED — one undoable gesture; Ctrl+Z restores the previous settings."]);
    } catch (error) {
      updatePendingReview(review);
      const message = error instanceof Error ? error.message : "VLYX proposal could not be applied.";
      if (review.kind === "mix") setAssistError(message);
      else setMatchError(message);
    }
  };

  const discardPendingReview = () => {
    const kind = pendingReviewRef.current?.kind;
    stopReviewAudio();
    updatePendingReview(null);
    if (kind === "mix") setAssistSummary(["DISCARDED — the project was not changed."]);
    else if (kind === "match") setMatchSummary(["DISCARDED — the project was not changed."]);
  };

  const cancelAnalysis = () => {
    const run = analysisRunRef.current;
    if (!run) return;
    run.cancelled = true;
    run.cancelWorker?.();
  };

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
      gainMatchStatusRef.current.textContent = bypassed
        ? "BYPASSED"
        : !hasSignal
          ? "NO SIGNAL"
          : active === true
            ? `LOCK ${correction > 0 ? "+" : ""}${correction.toFixed(1)} dB · Δ ${error > 0 ? "+" : ""}${error.toFixed(1)}`
            : "MEASURING…";
      gainMatchStatusRef.current.dataset.active = active === true && hasSignal && !bypassed ? "true" : "false";
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
    if (matchBusy || assistBusy) return;
    setMatchError(null);
    setMatchSummary(null);
    setAssistSummary(null);
    stopReviewAudio();
    updatePendingReview(null);
    const baseDoc = services.store.getDoc();
    const run = beginAnalysisRun();
    try {
      // 1. Target curve: reference sample's spectral profile, or library target.
      let targetCurve: number[];
      let targetName: string;
      const refBuffer = refId ? services.bank.get(refId) : null;
      if (refBuffer) {
        setMatchBusy("Analyzing reference…");
        const refCh = [
          refBuffer.getChannelData(0),
          refBuffer.numberOfChannels > 1 ? refBuffer.getChannelData(1) : refBuffer.getChannelData(0),
        ];
        const refResult = await awaitAnalysis(startUltinaTargetAnalysis(refCh, refBuffer.sampleRate), run);
        if (!refResult.targetCurve) {
          setMatchError(refResult.reason ?? "Reference is too short or too quiet to analyze.");
          return;
        }
        targetCurve = refResult.targetCurve;
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
      if (services.store.getDoc() !== baseDoc) throw new Error("Projekt sa počas analýzy zmenil; spusti ju znova.");
      setMatchBusy("Rendering your track…");
      const buffer = await renderTrack(baseDoc, trackId, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.5,
      });
      ensureAnalysisActive(run);
      setMatchBusy("Matching tonal balance…");
      const result = await awaitAnalysis(
        startUltinaAnalysis(
          {
            channels: [buffer.getChannelData(0), buffer.getChannelData(1)],
            sampleRate: buffer.sampleRate,
            minimumDuration: 2,
          },
          targetCurve,
        ),
        run,
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
      await stageProposalReview({
        kind: "match",
        run,
        baseDoc,
        before: buffer,
        proposal,
        label: `Reference match (${targetName})`,
        goal: `move this track toward the “${targetName}” tonal target`,
        changes: eqChanges.map((change) => ({ parameterId: change.parameterId, value: change.value })),
      });
    } catch (err) {
      if (isUltinaAnalysisCancelledError(err)) return;
      setMatchError(`Reference match failed: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setMatchBusy(null);
      if (analysisRunRef.current === run) analysisRunRef.current = null;
    }
  };

  const runMixAssist = async () => {
    if (assistBusy || matchBusy) return;
    setAssistError(null);
    setAssistSummary(null);
    setMatchSummary(null);
    stopReviewAudio();
    updatePendingReview(null);
    const baseDoc = services.store.getDoc();
    const run = beginAnalysisRun();
    try {
      setAssistBusy("Rendering track…");
      const buffer = await renderTrack(baseDoc, trackId, services.bank, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.5,
      });
      ensureAnalysisActive(run);
      setAssistBusy("Analyzing…");
      const result = await awaitAnalysis(
        startUltinaAnalysis({
          channels: [buffer.getChannelData(0), buffer.getChannelData(1)],
          sampleRate: buffer.sampleRate,
          character,
          intensity,
          minimumDuration: 2,
        }),
        run,
      );
      if (result.kind === "insufficient") {
        setAssistError(`Not enough material: ${result.reason}`);
        return;
      }
      if (result.kind === "error") {
        setAssistError(result.message);
        return;
      }
      const proposal = result.proposal;
      await stageProposalReview({
        kind: "mix",
        run,
        baseDoc,
        before: buffer,
        proposal,
        label: `Mix assist (${INSTRUMENT_LABELS[proposal.instrument] ?? proposal.instrument})`,
        goal: `${character} character · ${intensity} intensity`,
        changes: proposal.changes.map((change) => ({ parameterId: change.parameterId, value: change.value })),
      });
    } catch (err) {
      if (isUltinaAnalysisCancelledError(err)) return;
      setAssistError(`Mix assist failed: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setAssistBusy(null);
      if (analysisRunRef.current === run) analysisRunRef.current = null;
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

  const renderProposalReview = (kind: UltinaReview["kind"], title: string) => {
    if (pendingReview?.kind !== kind) return null;
    return (
      <section className="ultina-assist-summary" aria-label={`${title} proposal`}>
        <strong>{pendingReview.goal}</strong>
        {pendingReview.lines.map((line, index) => (
          <div key={index} className="ultina-assist-line">
            {line}
          </div>
        ))}
        <div className="ultina-assist-note" role="status" aria-live="polite">
          Offline A/B track renders. Nothing changes in the project until you apply. Measurable renders are loudness
          matched with preview-only attenuation; neither version is boosted.
        </div>
        <div className="ultina-assist-actions">
          <button type="button" className="btn btn-small" onClick={() => playReview("before")}>
            ▶ PLAY BEFORE
          </button>
          <button type="button" className="btn btn-small" onClick={() => playReview("after")}>
            ▶ PLAY PROPOSAL
          </button>
          {reviewPlaying && (
            <button type="button" className="btn btn-small" onClick={stopReviewAudio}>
              ■ STOP PREVIEW
            </button>
          )}
          <button type="button" className="btn btn-export" onClick={applyPendingReview}>
            ✓ APPLY PROPOSAL
          </button>
          <button type="button" className="btn btn-small" onClick={discardPendingReview}>
            DISCARD
          </button>
        </div>
      </section>
    );
  };

  return (
    <div
      className={`fxeq-panel ultina-panel${docked ? " vlyx-docked" : ""}`}
      data-module={selectedModule}
      aria-label="VLYX module editor"
    >
      {degraded && <div className="fxeq-degraded">AudioWorklet unavailable — VLYX is bypassed (1:1 signal)</div>}

      {docked && (
        <div className="device-view-tabs" role="group" aria-label="VLYX view">
          {(
            [
              ["modules", "MODULES"],
              ["assist", "ASSIST"],
              ["tools", "TOOLS"],
            ] as const
          ).map(([page, label]) => (
            <button
              key={page}
              type="button"
              className={`btn btn-small${dockPage === page ? " active" : ""}`}
              aria-pressed={dockPage === page}
              onClick={() => setDockPage(page)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {docked && dockPage === "assist" && (
        <div className="device-subtabs" role="group" aria-label="VLYX assistant">
          {(
            [
              ["mix", "MIX"],
              ["match", "MATCH"],
              ["learn", "LEARN"],
            ] as const
          ).map(([tool, label]) => (
            <button
              key={tool}
              type="button"
              className={`btn btn-small${dockAssist === tool ? " active" : ""}`}
              aria-pressed={dockAssist === tool}
              onClick={() => setDockAssist(tool)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── LIVE METERS ────────────────────────────────────────────── */}
      {(!docked || dockPage === "modules") && (
        <div className="ultina-live" aria-label="VLYX live meters">
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
      )}

      {/* ── REFERENCE MATCH ────────────────────────────────────────── */}
      {(!docked || (dockPage === "assist" && dockAssist === "match")) && (
        <div className="ultina-assist ultina-ref" aria-label="Reference match">
          <div className="ultina-assist-head">
            <span className="ultina-assist-title">REFERENCE MATCH</span>
            <button
              type="button"
              className="btn btn-export"
              disabled={!!matchBusy || !!assistBusy}
              title="Match this track's tonal balance toward a reference sample or a target curve"
              onClick={() => void runReferenceMatch()}
            >
              {matchBusy ?? "🎯 MATCH"}
            </button>
            {matchBusy && (
              <button type="button" className="btn btn-small" onClick={cancelAnalysis}>
                CANCEL
              </button>
            )}
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
              <div className="ultina-assist-note">
                {matchSummary.some((line) => line.startsWith("APPLIED —"))
                  ? "One undoable gesture — Ctrl+Z restores the previous settings."
                  : "No project changes were made."}
              </div>
            </div>
          )}
          {renderProposalReview("match", "Reference match")}
        </div>
      )}

      {/* ── EQ LEARN ───────────────────────────────────────────────── */}
      {(!docked || (dockPage === "assist" && dockAssist === "learn")) && (
        <div className="ultina-assist ultina-ref" aria-label="EQ learn">
          <div className="ultina-assist-head">
            <span className="ultina-assist-title">EQ LEARN</span>
            <button
              type="button"
              className={`btn btn-export${learnOn ? " active" : ""}`}
              aria-pressed={learnOn}
              title="Play your track — VLYX detects resonances and suggests cuts"
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
      )}

      {/* ── PRO: delta listen / A/B / gain match ───────────────────── */}
      {(!docked || dockPage === "tools") && (
        <div className="ultina-pro" aria-label="Pro tools">
          <div className="ultina-pro-group">
            <button
              type="button"
              className={`btn btn-small${deltaOn ? " active" : ""}`}
              aria-pressed={deltaOn}
              title="Hear ONLY what VLYX removes — the delta between dry and processed"
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
          <EffectAbControls
            effectName="VLYX"
            stateKind="ultina-ab-v1"
            params={params}
            deviceState={{ kind: "ultina-ab-v1", data: { ...currentAbState } }}
            onStateChange={updateAbState}
            onLoad={loadAbSlot}
          />
        </div>
      )}

      {/* ── MIX ASSIST ─────────────────────────────────────────────── */}
      {(!docked || (dockPage === "assist" && dockAssist === "mix")) && (
        <div className="ultina-assist" aria-label="Mix assistant">
          <div className="ultina-assist-head">
            <span className="ultina-assist-title">MIX ASSIST</span>
            <button
              type="button"
              className="btn btn-export"
              disabled={!!assistBusy || !!matchBusy}
              title="Render this track, analyze it and propose mix settings"
              onClick={() => void runMixAssist()}
            >
              {assistBusy ?? "⚡ MIX ASSIST"}
            </button>
            {assistBusy && (
              <button type="button" className="btn btn-small" onClick={cancelAnalysis}>
                CANCEL
              </button>
            )}
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
              <div className="ultina-assist-note">
                {assistSummary.some((line) => line.startsWith("APPLIED —"))
                  ? "One undoable gesture — Ctrl+Z restores the previous settings."
                  : "No project changes were made."}
              </div>
            </div>
          )}
          {renderProposalReview("mix", "Mix assist")}
        </div>
      )}

      {(!docked || dockPage === "modules") && (
        <div className="fxeq-preset-row">
          <select
            className="fxeq-preset-select"
            aria-label="VLYX preset"
            defaultValue=""
            onChange={(event) => {
              const user = userPresets.find((p) => p.id === event.target.value);
              if (user) {
                onApplyPreset(user.name, user.params);
                setSelectedUserPresetId(user.id);
                event.target.value = "";
                return;
              }
              // Lookup by preset ID, not display name — two factory presets
              // share the name "Vocal Warmth" (EQ + density), and a name-based
              // find() silently always returned the EQ one.
              const preset = FACTORY_PRESETS.find((p) => p.id === event.target.value);
              if (preset) onApplyPreset(preset.name, preset.params);
              event.target.value = "";
            }}
          >
            <option value="">PRESET…</option>
            {userPresets.length > 0 && (
              <optgroup label="USER">
                {userPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="FACTORY">
              {FACTORY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.module.toUpperCase()} · {p.name}
                </option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Save user preset"
            title="Save the current settings as a user preset"
            onClick={async () => {
              const name = (window.prompt("User preset name:", "") ?? "").trim();
              if (!name) return;
              const existing = userPresets.find((p) => p.name === name);
              if (existing && !window.confirm(`Preset "${name}" already exists — overwrite it?`)) return;
              try {
                const repo = services.ultinaPresets;
                await repo.save({
                  id: existing?.id ?? `ultina-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name,
                  params: { ...params },
                  createdAt: new Date().toISOString(),
                  schemaVersion: ULTINA_PRESET_SCHEMA_VERSION,
                });
                setUserPresets(await repo.list());
                setPresetError(null);
              } catch (err) {
                console.error("[UltinaPanel] preset save failed:", err);
                setPresetError(err instanceof Error ? err.message : "Preset storage failed");
              }
            }}
          >
            SAVE
          </button>
          {selectedUserPresetId && (
            <>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Rename user preset"
                onClick={async () => {
                  const current = userPresets.find((p) => p.id === selectedUserPresetId);
                  if (!current) return;
                  const name = (window.prompt("Rename preset:", current.name) ?? "").trim();
                  if (!name || name === current.name) return;
                  try {
                    const repo = services.ultinaPresets;
                    await repo.save({ ...current, name });
                    setUserPresets(await repo.list());
                    setPresetError(null);
                  } catch (err) {
                    console.error("[UltinaPanel] preset rename failed:", err);
                    setPresetError(err instanceof Error ? err.message : "Preset storage failed");
                  }
                }}
              >
                RENAME
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                aria-label="Delete user preset"
                onClick={async () => {
                  const current = userPresets.find((p) => p.id === selectedUserPresetId);
                  if (!current) return;
                  if (!window.confirm(`Delete preset "${current.name}"?`)) return;
                  try {
                    const repo = services.ultinaPresets;
                    await repo.remove(current.id);
                    setSelectedUserPresetId(null);
                    setUserPresets(await repo.list());
                    setPresetError(null);
                  } catch (err) {
                    console.error("[UltinaPanel] preset delete failed:", err);
                    setPresetError(err instanceof Error ? err.message : "Preset storage failed");
                  }
                }}
              >
                DEL
              </button>
            </>
          )}
          {presetError && (
            <span className="ultina-preset-error" role="alert">
              {presetError}
            </span>
          )}
        </div>
      )}

      {/* Module chips in graph order */}
      {(!docked || dockPage === "modules") && (
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
      )}

      {/* Enable toggle for the selected module */}
      {(!docked || dockPage === "modules") && (
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
      )}

      {(!docked || dockPage === "modules") && enabled(selectedModule) && (
        <div className={`ultina-module-controls${docked ? " is-docked" : ""}`}>
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
            visibleModuleParams.map((d) => (
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
          {docked && !eqSelected && modulePageCount > 1 && (
            <div
              className="device-param-pager"
              role="group"
              aria-label={`${MODULE_LABELS[selectedModule]} parameter pages`}
            >
              <span>
                PARAMETERS {moduleParamPage + 1}/{modulePageCount}
              </span>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Previous module parameter page"
                disabled={moduleParamPage === 0}
                onClick={() => setModuleParamPage((page) => Math.max(0, page - 1))}
              >
                ‹
              </button>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Next module parameter page"
                disabled={moduleParamPage >= modulePageCount - 1}
                onClick={() => setModuleParamPage((page) => Math.min(modulePageCount - 1, page + 1))}
              >
                ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
