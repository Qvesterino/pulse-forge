import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MixHealthReport } from "../analysis/mixDoctor";
import type { BufferSummary } from "../audio-engine/metering";
import {
  planMasterSettings,
  planReferenceMastering,
  resolveMasterAssistantStepValue,
  type MasterAssistantDevice,
  type MasterAssistantStep,
  type MasteringReferenceMeasurement,
} from "../mcp/master-assistant";
import { defaultParamsOf, EFFECT_META, clampEffectParam } from "../effects/definitions";
import { resolveDeliveryTarget, evaluateDelivery } from "../mastering/profiles";
import { projectRevisionIdFor } from "../mastering/report";
import { formatAuditionTrim, getLoudnessMatchGain, resolveLoudnessMatchTarget } from "../mastering/audition";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import { tryAcquireMasteringWork } from "../mastering/workGate";
import { estimateRenderPcmBytes, renderProject } from "../rendering/renderer";
import type { EffectInstance, EffectType, ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { setMasterConfig } from "../commands/master";
import { useServices } from "./context";
import { MasteringLevelMatchControl } from "./MasteringLevelMatchControl";

const MAX_ASSISTANT_PCM_BYTES = 320 * 1024 * 1024;

type MasterDevice = MasterAssistantStep["device"];
type MasterInsertDevice = Exclude<MasterAssistantDevice, "master">;
type DeviceEffectType = Extract<EffectType, "zenit" | "apeks" | "sirka">;

interface AssistantAnalysis {
  source: ProjectDocument;
  revisionId: string;
  bankRevision: number;
  sampleRate: number;
  referenceId: string | null;
  usedReference: boolean;
  summary: BufferSummary;
  health: MixHealthReport;
  plan: MasterAssistantStep[];
  addedIds: Partial<Record<MasterInsertDevice, string>>;
}

interface AssistantPreview {
  revisionId: string;
  bankRevision: number;
  selectionKey: string;
  summary: BufferSummary;
  health: MixHealthReport;
}

interface AppliedSnapshot {
  revisionId: string;
  effects: EffectInstance[];
  ceilingDb: number;
  limiterEnabled: boolean;
}

function bytesOf(buffer: AudioBuffer | null): number {
  return buffer ? buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT : 0;
}

function formatDb(value: number, unit: string): string {
  return Number.isFinite(value) && value > -119 ? `${value.toFixed(1)} ${unit}` : `−∞ ${unit}`;
}

function formatOptional(value: number | null, unit: string, digits = 1): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}` : "Not measured";
}

function getAuditionMatchGains(
  currentLufs: number | null,
  proposalLufs: number | null,
  enabled: boolean,
): { current: number; proposal: number; available: boolean } {
  const targetLufs = enabled ? resolveLoudnessMatchTarget([currentLufs, proposalLufs]) : null;
  const available = targetLufs !== null;
  return {
    current: getLoudnessMatchGain(currentLufs, targetLufs, available),
    proposal: getLoudnessMatchGain(proposalLufs, targetLufs, available),
    available,
  };
}

function formatValue(device: MasterDevice, param: string, value: number): string {
  if (device === "master") {
    if (param === "limiterEnabled") return value >= 0.5 ? "On" : "Off";
    if (param === "ceilingDb") return `${value.toFixed(1)} dBFS`;
    return value.toFixed(2);
  }
  const definition = EFFECT_META[device].params.find((candidate) => candidate.id === param);
  return definition?.format ? definition.format(value) : `${value.toFixed(2)}`;
}

function deviceName(device: MasterDevice): string {
  if (device === "master") return "Final master limiter";
  return EFFECT_META[device].name;
}

function tradeoffFor(step: MasterAssistantStep): string {
  if (step.param === "limit" || step.param === "drive")
    return "More density can reduce transient punch and increase distortion. Compare at matched loudness.";
  if (step.device === "master" && step.param === "ceilingDb")
    return "The final limiter ceiling is in dBFS while the profile limit is in dBTP; only the rendered preview confirms the true-peak result. A lower ceiling may increase limiter activity and change loudness.";
  if (step.device === "master" && step.param === "limiterEnabled")
    return "The final limiter can control peaks, but it may change transients. The rendered preview shows its actual effect on this mix.";
  if (step.param === "ceiling" || step.param === "ceilingDb")
    return "A lower ceiling can reduce peak overs. It may increase limiter activity and change loudness.";
  if (step.param === "preserve")
    return "More transient preservation can make the result less dense. The source mix may already be compressed.";
  if (step.param === "glue")
    return "Bus compression can make the mix feel steadier, but can also soften the groove and transients.";
  if (step.param === "lowWidth")
    return "Narrower bass can improve mono translation; it also changes the stereo character of low instruments.";
  if (step.param === "midWidth" || step.param === "highWidth")
    return "More width can create space, but may weaken mono compatibility or expose phase cancellation.";
  return "This broad tonal change is only a starting point. Judge the result against the reference and on other systems.";
}

function confidenceFor(step: MasterAssistantStep): string {
  if (step.param === "ceiling" || step.param === "ceilingDb" || step.param === "limiterEnabled")
    return "Confidence: medium · measured true-peak miss; the encoded file still needs a post-export check.";
  if (step.param === "midWidth" || step.param === "lowWidth" || step.param === "highWidth")
    return "Confidence: low · stereo correlation is a mono-compatibility clue, not a direct width measurement.";
  return "Confidence: low · broad mix heuristics; audition on speakers and headphones.";
}

function evidenceFor(
  step: MasterAssistantStep,
  summary: BufferSummary,
  health: MixHealthReport,
  targetLufs: number,
  targetTruePeakDb: number,
  referenceMeasurement: MasteringReferenceMeasurement | null,
): string {
  if (step.param === "ceiling" || step.param === "ceilingDb" || step.param === "limiterEnabled")
    return `Measured true peak ${formatDb(summary.truePeakDb, "dBTP")} vs delivery limit ${targetTruePeakDb.toFixed(1)} dBTP.`;
  if ((step.param === "limit" || step.param === "drive") && referenceMeasurement?.measurement.lufs != null)
    return `Measured ${formatDb(summary.lufsIntegrated, "LUFS-I")} vs reference ${formatDb(referenceMeasurement.measurement.lufs, "LUFS-I")} · true peak ${formatDb(summary.truePeakDb, "dBTP")}.`;
  if (step.param === "limit" || step.param === "drive")
    return `Measured ${formatDb(summary.lufsIntegrated, "LUFS-I")} · ${formatDb(summary.truePeakDb, "dBTP")} · delivery target ${targetLufs} LUFS.`;
  if (step.param === "preserve" || step.param === "glue") {
    if (referenceMeasurement?.measurement.crestDb != null)
      return `Measured crest ${health.crestDb.toFixed(1)} dB vs reference ${referenceMeasurement.measurement.crestDb.toFixed(1)} dB.`;
    return `Measured crest ${health.crestDb.toFixed(1)} dB from the full SONG render.`;
  }
  if (step.param.toLowerCase().includes("width")) {
    if (referenceMeasurement?.measurement.correlation != null && health.stereoCorrelation != null)
      return `Measured correlation ${health.stereoCorrelation.toFixed(2)} vs reference ${referenceMeasurement.measurement.correlation.toFixed(2)}.`;
    return `Measured stereo correlation ${summary.correlation.toFixed(2)} · mono loss ${summary.monoLossDb.toFixed(1)} dB.`;
  }
  if (step.param === "eqLow" && referenceMeasurement?.measurement.lowEndShare != null)
    return `Measured low-end share ${(health.lowEndShare * 100).toFixed(0)}% vs reference ${(referenceMeasurement.measurement.lowEndShare * 100).toFixed(0)}%.`;
  if (step.param === "eqHigh" && referenceMeasurement?.measurement.hfShare != null)
    return `Measured high + air share ${((health.bandShares.high + health.bandShares.air) * 100).toFixed(0)}% vs reference ${(referenceMeasurement.measurement.hfShare * 100).toFixed(0)}%.`;
  const hfShare = health.bandShares.high + health.bandShares.air;
  return `Measured high + air energy share ${(hfShare * 100).toFixed(0)}% in the full SONG render.`;
}

function selectedKey(selected: readonly number[]): string {
  return [...selected].sort((a, b) => a - b).join(",");
}

function isPlanConsistent(plan: readonly MasterAssistantStep[]): boolean {
  const increasesZenitLimit = plan.some((step) => step.device === "zenit" && step.param === "limit" && step.value > 0);
  const addsApeksDrive = plan.some((step) => step.device === "apeks" && step.param === "drive" && step.value > 0);
  return !(increasesZenitLimit && addsApeksDrive);
}

function resolvePlanAgainstMaster(
  source: ProjectDocument,
  steps: readonly MasterAssistantStep[],
): MasterAssistantStep[] {
  const effects = source.master.effects ?? [];
  const resolvedParams = new Map<string, number>();
  const resolved: MasterAssistantStep[] = [];
  for (const step of steps) {
    if (step.device === "master") {
      const key = `${step.device}:${step.param}`;
      const current =
        resolvedParams.get(key) ??
        (step.param === "limiterEnabled" ? Number(source.master.limiterEnabled) : source.master.ceilingDb);
      const isToggle = step.param === "limiterEnabled";
      const target = resolveMasterAssistantStepValue(step, current, isToggle ? 0 : -12, isToggle ? 1 : 0);
      const quantizedTarget = isToggle ? (target >= 0.5 ? 1 : 0) : target;
      resolvedParams.set(key, quantizedTarget);
      if (Math.abs(quantizedTarget - current) <= 1e-9) continue;
      resolved.push({ ...step, value: quantizedTarget });
      continue;
    }
    const type = step.device as DeviceEffectType;
    const effect =
      effects.find((item) => item.type === type && !item.bypassed) ?? effects.find((item) => item.type === type);
    const definition = EFFECT_META[type].params.find((candidate) => candidate.id === step.param);
    const key = `${step.device}:${step.param}`;
    const current =
      resolvedParams.get(key) ??
      clampEffectParam(type, step.param, effect?.params[step.param] ?? defaultParamsOf(type)[step.param] ?? 0);
    const target = clampEffectParam(
      type,
      step.param,
      resolveMasterAssistantStepValue(step, current, definition?.min, definition?.max),
    );
    resolvedParams.set(key, target);
    if (Math.abs(target - current) <= 1e-9) continue;
    resolved.push({ ...step, value: target });
  }
  return resolved;
}

function buildDraft(
  source: ProjectDocument,
  plan: readonly MasterAssistantStep[],
  selected: readonly number[],
  addedIds: Partial<Record<MasterInsertDevice, string>>,
): ProjectDocument {
  const effects = [...(source.master.effects ?? [])];
  let ceilingDb = source.master.ceilingDb;
  let limiterEnabled = source.master.limiterEnabled;
  for (const index of selected) {
    const step = plan[index];
    if (!step) continue;
    if (step.device === "master") {
      if (step.param === "limiterEnabled") limiterEnabled = step.value >= 0.5;
      else if (step.param === "ceilingDb") ceilingDb = Math.max(-12, Math.min(0, step.value));
      continue;
    }
    const type = step.device as DeviceEffectType;
    let effectIndex = effects.findIndex((effect) => effect.type === type && !effect.bypassed);
    if (effectIndex < 0) effectIndex = effects.findIndex((effect) => effect.type === type);
    if (effectIndex < 0) {
      const id = addedIds[step.device] ?? uid("fx");
      effects.push({ id, type, bypassed: false, params: defaultParamsOf(type) });
      effectIndex = effects.length - 1;
    }
    const effect = effects[effectIndex];
    if (!effect) continue;
    effects[effectIndex] = {
      ...effect,
      bypassed: false,
      params: {
        ...effect.params,
        [step.param]: clampEffectParam(type, step.param, step.value),
      },
    };
  }
  return { ...source, master: { ...source.master, effects, ceilingDb, limiterEnabled } };
}

function currentRevision(services: ReturnType<typeof useServices>, projectId: string): string | null {
  const current = services.store.getDoc();
  return current.id === projectId ? projectRevisionIdFor(current) : null;
}

function reportLines(health: MixHealthReport): string[] {
  if (health.flags.length === 0) return ["No Mix Doctor flags in this render."];
  return health.flags.slice(0, 5).map((flag) => `${flag.severity === "red" ? "Issue" : "Check"}: ${flag.detail}`);
}

export function MasteringAssistant({
  doc,
  revisionId,
  sampleRate,
  referenceMeasurement,
  reservedPcmBytes,
  referencePcmBytes,
  comparisonEpoch,
  blockNewWork,
  blockAudition,
  onBeforeRender,
  onBusyChange,
  onPreviewBytes,
}: {
  doc: ProjectDocument;
  revisionId: string;
  sampleRate: number;
  referenceMeasurement: MasteringReferenceMeasurement | null;
  reservedPcmBytes: number;
  referencePcmBytes: number;
  comparisonEpoch: number;
  blockNewWork: boolean;
  blockAudition: boolean;
  onBeforeRender(): void;
  onBusyChange(busy: boolean): void;
  onPreviewBytes(bytes: number): void;
}) {
  const services = useServices();
  const [analysis, setAnalysis] = useState<AssistantAnalysis | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [candidatePreview, setCandidatePreview] = useState<AssistantPreview | null>(null);
  const [previewBuffer, setPreviewBuffer] = useState<AudioBuffer | null>(null);
  const [currentPreviewBuffer, setCurrentPreviewBuffer] = useState<AudioBuffer | null>(null);
  const previewBuffersRef = useRef<{ current: AudioBuffer | null; proposed: AudioBuffer | null }>({
    current: null,
    proposed: null,
  });
  const [playing, setPlaying] = useState<"current" | "proposed" | null>(null);
  const [levelMatch, setLevelMatch] = useState(true);
  const [useReferenceForPlan, setUseReferenceForPlan] = useState(false);
  const [busy, setBusy] = useState<"analyze" | "preview" | "verify" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [appliedSnapshot, setAppliedSnapshot] = useState<AppliedSnapshot | null>(null);
  const [appliedCheck, setAppliedCheck] = useState<AssistantPreview | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const expectedRevisionRef = useRef<string | null>(null);
  const observedRevisionRef = useRef(revisionId);
  const observedAssistantReferenceRef = useRef("off:");
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const workBlocked = blockNewWork || busy !== null;
  const updateBusy = (next: "analyze" | "preview" | "verify" | null) => {
    setBusy(next);
    onBusyChange(next !== null);
  };

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const selection = useMemo(() => selectedKey(selected), [selected]);
  const draft = useMemo(
    () => (analysis ? buildDraft(analysis.source, analysis.plan, selected, analysis.addedIds) : null),
    [analysis, selected],
  );
  const analysisIsCurrent =
    analysis?.revisionId === revisionId &&
    analysis.sampleRate === sampleRate &&
    analysis.bankRevision === services.bank.revision &&
    analysis.usedReference === useReferenceForPlan &&
    analysis.referenceId === (useReferenceForPlan ? (referenceMeasurement?.id ?? null) : null);
  const previewIsCurrent = Boolean(
    analysisIsCurrent &&
    candidatePreview &&
    candidatePreview.revisionId === revisionId &&
    candidatePreview.bankRevision === services.bank.revision &&
    candidatePreview.selectionKey === selection,
  );
  const appliedIsCurrent = Boolean(appliedSnapshot && appliedSnapshot.revisionId === revisionId);
  const target = useMemo(() => resolveDeliveryTarget(doc.master), [doc.master]);
  const activeReferenceId = useReferenceForPlan ? (referenceMeasurement?.id ?? null) : null;
  const activeReferenceKey = `${useReferenceForPlan ? "on" : "off"}:${activeReferenceId ?? ""}`;
  const referenceMeasurementCount = referenceMeasurement
    ? Object.values(referenceMeasurement.measurement).filter((value) => value != null && Number.isFinite(value)).length
    : 0;
  const auditionGains = getAuditionMatchGains(
    analysis?.summary.lufsIntegrated ?? null,
    candidatePreview?.summary.lufsIntegrated ?? null,
    levelMatch,
  );

  const stopPlayback = useCallback(() => {
    services.engine.stopPreview();
    setPlaying(null);
  }, [services.engine]);

  const publishPreviewBuffer = useCallback(
    (side: "current" | "proposed", buffer: AudioBuffer | null) => {
      previewBuffersRef.current = { ...previewBuffersRef.current, [side]: buffer };
      if (side === "current") setCurrentPreviewBuffer(buffer);
      else setPreviewBuffer(buffer);
      onPreviewBytes(bytesOf(previewBuffersRef.current.current) + bytesOf(previewBuffersRef.current.proposed));
    },
    [onPreviewBytes],
  );

  const releaseProposalPreview = useCallback(() => {
    previewBuffersRef.current = { ...previewBuffersRef.current, proposed: null };
    setPreviewBuffer(null);
    onPreviewBytes(bytesOf(previewBuffersRef.current.current));
  }, [onPreviewBytes]);

  const releasePreview = useCallback(() => {
    previewBuffersRef.current = { current: null, proposed: null };
    setPreviewBuffer(null);
    setCurrentPreviewBuffer(null);
    onPreviewBytes(0);
  }, [onPreviewBytes]);

  useEffect(() => {
    if (playing === "current" && analysis) {
      services.engine.updateMasterComparePreview(auditionGains.current, false);
    } else if (playing === "proposed" && candidatePreview) {
      services.engine.updateMasterComparePreview(auditionGains.proposal, false);
    }
  }, [analysis, auditionGains.current, auditionGains.proposal, candidatePreview, playing, services.engine]);

  useEffect(() => {
    if (comparisonEpoch === 0) return;
    if (playingRef.current) stopPlayback();
    releasePreview();
  }, [comparisonEpoch, releasePreview, stopPlayback]);

  useEffect(() => {
    if (observedAssistantReferenceRef.current === activeReferenceKey) return;
    observedAssistantReferenceRef.current = activeReferenceKey;
    abortRef.current?.abort();
    if (playingRef.current) stopPlayback();
    releasePreview();
    setCandidatePreview(null);
    setAppliedCheck(null);
    if (analysis) setStatus("Reference measurements changed. Analyze the master again before reviewing proposals.");
  }, [activeReferenceKey, analysis, releasePreview, stopPlayback]);

  useEffect(() => {
    if (observedRevisionRef.current === revisionId) return;
    observedRevisionRef.current = revisionId;
    if (expectedRevisionRef.current === revisionId) {
      expectedRevisionRef.current = null;
      return;
    }
    abortRef.current?.abort();
    if (playingRef.current) stopPlayback();
    releasePreview();
    updateBusy(null);
    setStatus("Projekt sa zmenil. Starý návrh je stale; spusti novú analýzu.");
  }, [releasePreview, revisionId, stopPlayback]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (playingRef.current) services.engine.stopPreview();
      onPreviewBytes(0);
    },
    [onPreviewBytes, services.engine],
  );

  const renderOptions = (signal: AbortSignal) => ({
    mode: "song" as const,
    sampleRate,
    quality: "studio" as const,
    signal,
  });

  const analyzeBuffer = (buffer: AudioBuffer, signal: AbortSignal, action: string) =>
    analyzeMasterBufferAsync(buffer, target, {
      signal,
      onProgress: ({ progress, stage }) => setStatus(`${action} ${Math.round(progress * 100)}% · ${stage}`),
    });

  const assertMemory = (
    renderDoc: ProjectDocument,
    otherPcmBytes = reservedPcmBytes +
      bytesOf(previewBuffersRef.current.current) +
      bytesOf(previewBuffersRef.current.proposed),
  ) => {
    const estimated = estimateRenderPcmBytes(renderDoc, { mode: "song", sampleRate });
    if (estimated + otherPcmBytes > MAX_ASSISTANT_PCM_BYTES) {
      throw new Error(
        `This render needs about ${(estimated / 1024 / 1024).toFixed(0)} MiB plus ${(otherPcmBytes / 1024 / 1024).toFixed(0)} MiB already used by comparison audio. Shorten the song or clear another preview.`,
      );
    }
  };

  const beginRender = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    onBeforeRender();
    stopPlayback();
    setError("");
    return { controller };
  };

  const analyze = async () => {
    if (useReferenceForPlan && !referenceMeasurement) {
      setError("Import and measure a reference file before using reference measurements in the assistant.");
      return;
    }
    const referenceAtStart = useReferenceForPlan ? referenceMeasurement : null;
    const revisionAtStart = currentRevision(services, doc.id);
    if (!revisionAtStart || revisionAtStart !== revisionId) {
      setError("Projekt sa zmenil. Počkaj na aktualizáciu MASTER pracoviska a skús znova.");
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setStatus("Iná MASTER úloha práve spracúva audio. Počkaj na jej dokončenie a skús znova.");
      return;
    }
    let activeController: AbortController | null = null;
    try {
      releasePreview();
      const { controller } = beginRender();
      activeController = controller;
      let bankRevisionAtStart = services.bank.revision;
      setAnalysis(null);
      setSelected([]);
      setCandidatePreview(null);
      setAppliedCheck(null);
      setStatus("Pripravujem sample audio pre masteringové meranie…");
      updateBusy("analyze");
      assertMemory(doc);
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      bankRevisionAtStart = services.bank.revision;
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas prípravy sample banku zmenil. Analýza bola zahodená.");
      setStatus("Renderujem celý SONG v Studio HQ a meriam master výstup…");
      const buffer = await renderProject(doc, services.bank, renderOptions(controller.signal));
      if (controller.signal.aborted) throw new DOMException("Assistant render cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas analýzy zmenil. Starý report bol zahodený.");
      if (services.bank.revision !== bankRevisionAtStart)
        throw new Error("Sample bank sa počas analýzy zmenil. Spusti nový render.");
      const { measurements: summary, mixHealth: health } = await analyzeBuffer(
        buffer,
        controller.signal,
        "Analyzing master",
      );
      if (controller.signal.aborted) throw new DOMException("Assistant analysis cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas merania zmenil. Starý report bol zahodený.");
      if (services.bank.revision !== bankRevisionAtStart)
        throw new Error("Sample bank sa počas merania zmenil. Spusti nový render.");
      const usableSignal = health.durationSec >= 0.4 && summary.peak > 1e-5;
      const suggestedPlan = usableSignal
        ? referenceAtStart
          ? [
              ...planReferenceMastering({
                mine: {
                  lufs: summary.lufsIntegrated > -119 ? summary.lufsIntegrated : null,
                  crestDb: health.crestDb,
                  correlation: health.stereoCorrelation,
                  hfShare: health.bandShares.high + health.bandShares.air,
                  lowEndShare: health.lowEndShare,
                },
                reference: referenceAtStart.measurement,
              }),
              ...planMasterSettings({
                lufs: null,
                peakDb: summary.truePeakDb,
                crestDb: health.crestDb,
                correlation: null,
                targetTruePeakDb: target.maxTruePeakDb,
                targetScope: "master",
                masterLimiterEnabled: doc.master.limiterEnabled,
              }).filter((step) => step.device === "master"),
            ]
          : planMasterSettings({
              lufs: summary.lufsIntegrated > -119 ? summary.lufsIntegrated : null,
              peakDb: summary.truePeakDb,
              crestDb: health.crestDb,
              correlation: summary.correlation,
              hfShare: health.bandShares.high + health.bandShares.air,
              targetLufs: target.targetLufs,
              targetTruePeakDb: target.maxTruePeakDb,
              targetScope: "master",
              masterLimiterEnabled: doc.master.limiterEnabled,
            })
        : [];
      const plan = resolvePlanAgainstMaster(doc, suggestedPlan);
      const addedIds: Partial<Record<MasterInsertDevice, string>> = {};
      for (const step of plan) {
        if (step.device === "master") continue;
        if (!(doc.master.effects ?? []).some((effect) => effect.type === step.device))
          addedIds[step.device] ??= uid("fx");
      }
      setAnalysis({
        source: doc,
        revisionId: revisionAtStart,
        bankRevision: bankRevisionAtStart,
        sampleRate,
        referenceId: referenceAtStart?.id ?? null,
        usedReference: referenceAtStart !== null,
        summary,
        health,
        plan,
        addedIds,
      });
      setSelected(plan.map((_, index) => index));
      const measurementAnnouncement = usableSignal
        ? `Measured ${formatDb(summary.lufsIntegrated, "LUFS-I")}, true peak ${formatDb(summary.truePeakDb, "dBTP")} against ${target.maxTruePeakDb.toFixed(1)} dBTP, crest ${health.crestDb.toFixed(1)} dB, and stereo correlation ${summary.correlation.toFixed(2)}.`
        : "No usable signal was measured; the render was silent or shorter than 0.4 seconds.";
      setStatus(
        `${
          plan.length > 0
            ? `Analýza hotová. Planner našiel ${plan.length} návrh${plan.length === 1 ? "" : "y"}; nič sa zatiaľ nezmenilo.`
            : "Analýza hotová. Z nameraných údajov nevznikol návrh na bezpečnú zmenu master chainu."
        } ${measurementAnnouncement}${referenceAtStart ? ` Reference: ${referenceAtStart.fileName}.` : ""}`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled")) setStatus("Analýza bola zrušená.");
      else setError(message);
    } finally {
      if (activeController && abortRef.current === activeController) abortRef.current = null;
      updateBusy(null);
      releaseMasteringWork();
    }
  };

  const renderProposal = async () => {
    if (!analysisIsCurrent || !analysis || !draft || selected.length === 0 || busy) return;
    const revisionAtStart = currentRevision(services, doc.id);
    if (revisionAtStart !== analysis.revisionId) {
      setError("Projekt sa zmenil. Spusti novú analýzu pred renderom návrhu.");
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setStatus("Iná MASTER úloha práve spracúva audio. Počkaj na jej dokončenie a skús znova.");
      return;
    }
    let activeController: AbortController | null = null;
    try {
      releaseProposalPreview();
      const { controller } = beginRender();
      activeController = controller;
      const bankRevisionAtStart = analysis.bankRevision;
      setCandidatePreview(null);
      setStatus("Renderujem presne vybrané zmeny na draft dokumente…");
      updateBusy("preview");
      assertMemory(draft);
      const buffer = await renderProject(draft, services.bank, renderOptions(controller.signal));
      if (controller.signal.aborted) throw new DOMException("Assistant render cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas preview renderu zmenil. Výsledok bol zahodený.");
      if (services.bank.revision !== bankRevisionAtStart)
        throw new Error("Sample bank sa počas preview renderu zmenil. Návrh vyrenderuj znova.");
      const actualBytes = bytesOf(buffer);
      if (actualBytes + reservedPcmBytes + bytesOf(previewBuffersRef.current.current) > MAX_ASSISTANT_PCM_BYTES)
        throw new Error("Render prekročil 320 MiB spoločný limit porovnávacieho audia.");
      const { measurements: summary, mixHealth: health } = await analyzeBuffer(
        buffer,
        controller.signal,
        "Analyzing proposal preview",
      );
      if (controller.signal.aborted) throw new DOMException("Proposal analysis cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas merania návrhu zmenil. Výsledok bol zahodený.");
      if (services.bank.revision !== bankRevisionAtStart)
        throw new Error("Sample bank sa počas merania návrhu zmenil. Návrh vyrenderuj znova.");
      publishPreviewBuffer("proposed", buffer);
      setCandidatePreview({
        revisionId: revisionAtStart,
        bankRevision: bankRevisionAtStart,
        selectionKey: selection,
        summary,
        health,
      });
      setStatus("Draft preview je vyrenderovaný. Metriky sú zo skutočného audia, nie odhad z parametrov.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled")) setStatus("Render návrhu bol zrušený.");
      else setError(message);
    } finally {
      if (activeController && abortRef.current === activeController) abortRef.current = null;
      updateBusy(null);
      releaseMasteringWork();
    }
  };

  const playCurrent = async () => {
    if (!analysisIsCurrent || !analysis || busy || blockAudition) return;
    const revisionAtStart = currentRevision(services, doc.id);
    if (revisionAtStart !== analysis.revisionId) {
      setError("Projekt sa zmenil. Spusti novú analýzu pred audition.");
      return;
    }
    const playBuffer = (buffer: AudioBuffer) => {
      stopPlayback();
      setPlaying("current");
      services.engine.previewMasterCompare(buffer, auditionGains.current, () => setPlaying(null));
      setStatus("Prehráva sa aktuálny master. Prepni na Play proposal pri zapnutom loudness match.");
    };
    if (currentPreviewBuffer) {
      playBuffer(currentPreviewBuffer);
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setStatus("Iná MASTER úloha práve spracúva audio. Počkaj na jej dokončenie a skús znova.");
      return;
    }
    let activeController: AbortController | null = null;
    try {
      const { controller } = beginRender();
      activeController = controller;
      const bankRevisionAtStart = analysis.bankRevision;
      updateBusy("preview");
      setStatus("Renderujem aktuálny master na porovnanie…");
      assertMemory(analysis.source, reservedPcmBytes + bytesOf(previewBuffersRef.current.proposed));
      const buffer = await renderProject(analysis.source, services.bank, renderOptions(controller.signal));
      if (controller.signal.aborted) throw new DOMException("Assistant render cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== revisionAtStart)
        throw new Error("Projekt sa počas audition zmenil. Stará verzia bola zahodená.");
      if (services.bank.revision !== bankRevisionAtStart)
        throw new Error("Sample bank sa počas audition zmenil. Spusti novú analýzu.");
      const actualBytes = bytesOf(buffer);
      if (actualBytes + reservedPcmBytes + bytesOf(previewBuffersRef.current.proposed) > MAX_ASSISTANT_PCM_BYTES)
        throw new Error("Render prekročil 320 MiB spoločný limit porovnávacieho audia.");
      publishPreviewBuffer("current", buffer);
      playBuffer(buffer);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled")) setStatus("Audition bolo zrušené.");
      else setError(message);
    } finally {
      if (activeController && abortRef.current === activeController) abortRef.current = null;
      updateBusy(null);
      releaseMasteringWork();
    }
  };

  const playProposed = () => {
    if (!previewIsCurrent || !candidatePreview || !previewBuffer || blockAudition) return;
    stopPlayback();
    setPlaying("proposed");
    services.engine.previewMasterCompare(previewBuffer, auditionGains.proposal, () => setPlaying(null));
    setStatus("Prehráva sa navrhnutý master. Prepínaj s Play current pri zapnutom loudness match.");
  };

  const verifyApplied = async (
    appliedDoc: ProjectDocument,
    appliedRevision: string,
    bankRevisionAtApply: number,
    selectionAtApply: string,
    releaseMasteringWork: () => void,
  ) => {
    let activeController: AbortController | null = null;
    try {
      const controller = new AbortController();
      activeController = controller;
      abortRef.current = controller;
      onBeforeRender();
      updateBusy("verify");
      setStatus("Zmena je aplikovaná jedným Undo krokom. Znova renderujem a overujem výsledný master…");
      assertMemory(appliedDoc, referencePcmBytes);
      const buffer = await renderProject(appliedDoc, services.bank, renderOptions(controller.signal));
      if (controller.signal.aborted) throw new DOMException("Verification render cancelled", "AbortError");
      if (currentRevision(services, doc.id) !== appliedRevision)
        throw new Error("Projekt sa po aplikovaní znova zmenil. Post-apply report je stale.");
      if (services.bank.revision !== bankRevisionAtApply)
        throw new Error("Sample bank sa počas post-apply renderu zmenil. Report je stale.");
      const verified = await analyzeBuffer(buffer, controller.signal, "Verifying applied master");
      if (currentRevision(services, doc.id) !== appliedRevision || services.bank.revision !== bankRevisionAtApply)
        throw new Error("Projekt alebo sample bank sa počas post-apply merania zmenil. Report je stale.");
      setAppliedCheck({
        revisionId: appliedRevision,
        bankRevision: bankRevisionAtApply,
        selectionKey: selectionAtApply,
        summary: verified.measurements,
        health: verified.mixHealth,
      });
      setStatus("Post-apply render hotový. Zobrazené metriky sú z nového renderu aktuálneho MASTER chainu.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled"))
        setStatus("Post-apply overenie bolo zrušené; zmenu môžeš vrátiť cez Undo.");
      else setError(`Zmena bola aplikovaná, ale post-apply meranie sa nepodarilo: ${message}`);
    } finally {
      if (activeController && abortRef.current === activeController) abortRef.current = null;
      updateBusy(null);
      releaseMasteringWork();
    }
  };

  const apply = (all: boolean) => {
    if (!analysisIsCurrent || !analysis || !draft || !candidatePreview || !previewIsCurrent || busy) return;
    const indices = all ? analysis.plan.map((_, index) => index) : selected;
    if (indices.length === 0) return;
    if (all && selection !== selectedKey(indices)) {
      setError("Najprv vyber všetky návrhy a vyrenderuj presne túto kombináciu.");
      return;
    }
    const liveDoc = services.store.getDoc();
    if (liveDoc.id !== doc.id || projectRevisionIdFor(liveDoc) !== analysis.revisionId) {
      setError("Projekt sa od analýzy zmenil. Návrh už nemožno aplikovať; spusti ho znova.");
      return;
    }
    if (services.bank.revision !== analysis.bankRevision) {
      setError("Sample bank sa od analýzy zmenil. Spusti nový render pred aplikovaním.");
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setError("Iná MASTER úloha práve spracúva audio. Počkaj na jej dokončenie a potom návrh aplikuj znova.");
      return;
    }
    try {
      const committedDraft = buildDraft(analysis.source, analysis.plan, indices, analysis.addedIds);
      const command = setMasterConfig(liveDoc, {
        effects: committedDraft.master.effects ?? [],
        ceilingDb: committedDraft.master.ceilingDb,
        limiterEnabled: committedDraft.master.limiterEnabled,
      });
      services.engine.stopPreview();
      setPlaying(null);
      releasePreview();
      services.store.execute({ ...command, label: "Apply MASTER assistant plan" });
      const appliedDoc = services.store.getDoc();
      const appliedRevision = projectRevisionIdFor(appliedDoc);
      expectedRevisionRef.current = appliedRevision;
      setAppliedSnapshot({
        revisionId: appliedRevision,
        effects: analysis.source.master.effects ?? [],
        ceilingDb: analysis.source.master.ceilingDb,
        limiterEnabled: analysis.source.master.limiterEnabled,
      });
      setAppliedCheck(null);
      setError("");
      void verifyApplied(
        appliedDoc,
        appliedRevision,
        analysis.bankRevision,
        selectedKey(indices),
        releaseMasteringWork,
      ).catch((caught: unknown) => {
        releaseMasteringWork();
        setError(caught instanceof Error ? caught.message : "Could not verify the applied MASTER proposal.");
      });
    } catch (caught) {
      releaseMasteringWork();
      setError(caught instanceof Error ? caught.message : "Could not apply the MASTER assistant proposal.");
    }
  };

  const resetToSnapshot = () => {
    if (!appliedSnapshot) return;
    const liveDoc = services.store.getDoc();
    if (liveDoc.id !== doc.id || projectRevisionIdFor(liveDoc) !== appliedSnapshot.revisionId) {
      setError("Projekt sa po aplikovaní zmenil. Snapshot už nie je bezpečné obnoviť; použi Undo history.");
      return;
    }
    services.engine.stopPreview();
    setPlaying(null);
    releasePreview();
    abortRef.current?.abort();
    const command = setMasterConfig(liveDoc, {
      effects: appliedSnapshot.effects,
      ceilingDb: appliedSnapshot.ceilingDb,
      limiterEnabled: appliedSnapshot.limiterEnabled,
    });
    services.store.execute({ ...command, label: "Reset MASTER to assistant snapshot" });
    const restored = services.store.getDoc();
    expectedRevisionRef.current = projectRevisionIdFor(restored);
    setAppliedSnapshot(null);
    setAppliedCheck(null);
    setAnalysis(null);
    setSelected([]);
    setCandidatePreview(null);
    setError("");
    updateBusy(null);
    setStatus("Master chain bol obnovený do snapshotu zachyteného pred návrhom.");
  };

  const dismiss = () => {
    abortRef.current?.abort();
    stopPlayback();
    releasePreview();
    setAnalysis(null);
    setSelected([]);
    setCandidatePreview(null);
    setError("");
    updateBusy(null);
    setStatus("Návrh zatvorený. Dismiss túto analýzu nezapisuje do projektu.");
  };

  const toggleStep = (index: number) => {
    stopPlayback();
    setSelected((previous) => {
      const wasSelected = previous.includes(index);
      const step = analysis?.plan[index];
      let next = wasSelected ? previous.filter((item) => item !== index) : [...previous, index];
      if (step?.device === "master" && step.param === "limiterEnabled") {
        const ceilingIndex = analysis?.plan.findIndex(
          (candidate) => candidate.device === "master" && candidate.param === "ceilingDb",
        );
        if (ceilingIndex != null && ceilingIndex >= 0) {
          next = wasSelected
            ? next.filter((item) => item !== ceilingIndex)
            : next.includes(ceilingIndex)
              ? next
              : [...next, ceilingIndex];
        }
      } else if (step?.device === "master" && step.param === "ceilingDb" && !wasSelected) {
        const enableIndex = analysis?.plan.findIndex(
          (candidate) => candidate.device === "master" && candidate.param === "limiterEnabled",
        );
        if (enableIndex != null && enableIndex >= 0 && !previous.includes(enableIndex)) next = [...next, enableIndex];
      }
      return next;
    });
    setCandidatePreview(null);
    setAppliedCheck(null);
    releaseProposalPreview();
  };

  return (
    <section className="master-assistant-section" aria-label="Mastering assistant">
      <header className="master-assistant-heading">
        <div>
          <span className="mastering-panel-kicker">MEASURE → REVIEW → APPLY</span>
          <h3>Master assistant</h3>
          <p>
            Deterministic suggestions from a full SONG render. The assistant edits final-sum inserts and the built-in
            limiter; every change needs an exact draft preview and remains one Undo step.
          </p>
        </div>
        <div className="master-assistant-proposal-actions">
          {analysis && !appliedSnapshot && (
            <button type="button" onClick={dismiss} disabled={workBlocked}>
              Dismiss
            </button>
          )}
          <button
            type="button"
            onClick={() => void analyze()}
            disabled={workBlocked || (useReferenceForPlan && !referenceMeasurement)}
          >
            {busy === "analyze" ? "Analyzing…" : "Analyze master"}
          </button>
        </div>
      </header>
      <div className="master-assistant-controls">
        <MasteringLevelMatchControl checked={levelMatch} onChange={setLevelMatch} />
        <label className="master-assistant-reference-control">
          <input
            type="checkbox"
            checked={useReferenceForPlan}
            onChange={(event) => {
              stopPlayback();
              setUseReferenceForPlan(event.target.checked);
              setCandidatePreview(null);
              setAppliedCheck(null);
              releaseProposalPreview();
            }}
            disabled={workBlocked}
          />
          Use measured reference in proposals
        </label>
        <span className="master-assistant-reference-status" role="status">
          {useReferenceForPlan
            ? referenceMeasurement
              ? referenceMeasurementCount > 0
                ? `Using ${referenceMeasurementCount} measured reference values; missing fields are skipped.`
                : `Reference ${referenceMeasurement.fileName} has no usable measurements.`
              : "Import a reference in Compare with a reference track."
            : "Reference measurements are off."}
        </span>
        {busy && (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Cancel render
          </button>
        )}
        {playing && (
          <button type="button" onClick={stopPlayback}>
            Stop audition
          </button>
        )}
        {(currentPreviewBuffer || previewBuffer) && (
          <button
            type="button"
            onClick={() => {
              stopPlayback();
              releasePreview();
              setStatus("Audition cache cleared; measured proposal data is still available for review.");
            }}
            disabled={workBlocked}
          >
            Clear audition cache
          </button>
        )}
        <span>SONG · {sampleRate / 1000} kHz · Studio HQ</span>
      </div>
      {useReferenceForPlan && referenceMeasurement && (
        <section className="master-assistant-reference" aria-label="Measured reference input">
          <div className="master-assistant-reference-heading">
            <strong>Measured reference</strong>
            <span>{referenceMeasurement.fileName}</span>
          </div>
          <div className="master-assistant-reference-measurements" role="group" aria-label="Reference measurements">
            <article>
              <span>Integrated</span>
              <strong>{formatOptional(referenceMeasurement.measurement.lufs, "LUFS-I")}</strong>
            </article>
            <article>
              <span>Crest</span>
              <strong>{formatOptional(referenceMeasurement.measurement.crestDb, "dB")}</strong>
            </article>
            <article>
              <span>Stereo correlation</span>
              <strong>{formatOptional(referenceMeasurement.measurement.correlation, "", 2)}</strong>
            </article>
            <article>
              <span>High + air</span>
              <strong>
                {formatOptional(
                  referenceMeasurement.measurement.hfShare == null
                    ? null
                    : referenceMeasurement.measurement.hfShare * 100,
                  "%",
                  0,
                )}
              </strong>
            </article>
            <article>
              <span>Low end</span>
              <strong>
                {formatOptional(
                  referenceMeasurement.measurement.lowEndShare == null
                    ? null
                    : referenceMeasurement.measurement.lowEndShare * 100,
                  "%",
                  0,
                )}
              </strong>
            </article>
          </div>
        </section>
      )}
      {analysisIsCurrent && analysis && (
        <>
          <div className="master-assistant-measurements" aria-label="Measured source master">
            <article>
              <span>Integrated</span>
              <strong>{formatDb(analysis.summary.lufsIntegrated, "LUFS-I")}</strong>
            </article>
            <article>
              <span>True peak</span>
              <strong>{formatDb(analysis.summary.truePeakDb, "dBTP")}</strong>
            </article>
            <article>
              <span>Crest</span>
              <strong>{analysis.health.crestDb.toFixed(1)} dB</strong>
            </article>
            <article>
              <span>Stereo correlation</span>
              <strong>{analysis.summary.correlation.toFixed(2)}</strong>
            </article>
            <article>
              <span>High + air</span>
              <strong>{((analysis.health.bandShares.high + analysis.health.bandShares.air) * 100).toFixed(0)}%</strong>
            </article>
          </div>
          {analysis.referenceId && referenceMeasurement && (
            <p className="master-assistant-reference-note">
              Proposals compare this SONG render with “{referenceMeasurement.fileName}”. Missing measurements are
              skipped.
            </p>
          )}
          <ul className="master-assistant-flags" aria-label="Source mix checks">
            {reportLines(analysis.health).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {analysis.plan.length > 0 ? (
            <div className="master-assistant-proposals">
              <div className="master-assistant-proposal-actions">
                <span>
                  {selected.length} / {analysis.plan.length} selected
                </span>
                <button
                  type="button"
                  onClick={() => {
                    stopPlayback();
                    setSelected(analysis.plan.map((_, index) => index));
                    setCandidatePreview(null);
                    releaseProposalPreview();
                  }}
                  disabled={workBlocked}
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    stopPlayback();
                    setSelected([]);
                    setCandidatePreview(null);
                    releaseProposalPreview();
                  }}
                  disabled={workBlocked}
                >
                  Select none
                </button>
                <button
                  type="button"
                  onClick={() => void renderProposal()}
                  disabled={workBlocked || selected.length === 0}
                >
                  {busy === "preview" ? "Rendering draft…" : "Render selected preview"}
                </button>
                <button
                  type="button"
                  onClick={playCurrent}
                  disabled={workBlocked || !analysisIsCurrent || blockAudition}
                >
                  {currentPreviewBuffer ? "Play current" : "Render & play current"}
                </button>
                <button
                  type="button"
                  onClick={playProposed}
                  disabled={!previewIsCurrent || !previewBuffer || workBlocked || blockAudition}
                >
                  Play proposal
                </button>
              </div>
              {analysis.plan.map((step, index) => {
                const isMasterStep = step.device === "master";
                const effect =
                  step.device === "master"
                    ? undefined
                    : ((analysis.source.master.effects ?? []).find(
                        (candidate) => candidate.type === step.device && !candidate.bypassed,
                      ) ?? (analysis.source.master.effects ?? []).find((candidate) => candidate.type === step.device));
                const definition =
                  step.device === "master"
                    ? undefined
                    : EFFECT_META[step.device].params.find((candidate) => candidate.id === step.param);
                const before =
                  step.device === "master"
                    ? step.param === "limiterEnabled"
                      ? Number(analysis.source.master.limiterEnabled)
                      : analysis.source.master.ceilingDb
                    : (effect?.params[step.param] ?? definition?.default ?? 0);
                const label =
                  step.device === "master"
                    ? step.param === "limiterEnabled"
                      ? "Enable final limiter"
                      : "Final limiter ceiling"
                    : (definition?.label ?? step.param);
                const inserted = !isMasterStep && !effect;
                return (
                  <article className="master-assistant-proposal" key={`${step.device}-${step.param}-${index}`}>
                    <label className="master-assistant-select">
                      <input
                        type="checkbox"
                        checked={selected.includes(index)}
                        onChange={() => toggleStep(index)}
                        disabled={workBlocked}
                      />
                      <span>
                        {deviceName(step.device)} · {label}
                      </span>
                    </label>
                    <div className="master-assistant-value">
                      <span>
                        {inserted ? "Add device · default" : effect?.bypassed ? "Enable bypassed device" : "Current"}
                      </span>
                      <strong>
                        {formatValue(step.device, step.param, before)} →{" "}
                        {formatValue(step.device, step.param, step.value)}
                      </strong>
                    </div>
                    <p>{step.why}</p>
                    <small>
                      {evidenceFor(
                        step,
                        analysis.summary,
                        analysis.health,
                        target.targetLufs,
                        target.maxTruePeakDb,
                        referenceMeasurement,
                      )}
                    </small>
                    <small>{tradeoffFor(step)}</small>
                    <small className="master-assistant-confidence">{confidenceFor(step)}</small>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="master-assistant-empty">
              No master chain proposal. The flags below still help locate work that belongs in the mix or needs
              listening.
            </p>
          )}
        </>
      )}
      {candidatePreview && previewIsCurrent && analysis && (
        <div className="master-assistant-preview-results" aria-label="Measured draft preview">
          <div>
            <strong>Draft preview · measured output</strong>
            <span>
              {formatDb(candidatePreview.summary.lufsIntegrated, "LUFS-I")} ·{" "}
              {formatDb(candidatePreview.summary.truePeakDb, "dBTP")} · crest{" "}
              {candidatePreview.health.crestDb.toFixed(1)} dB
            </span>
          </div>
          <div>
            <strong>Delivery check</strong>
            <span>
              {evaluateDelivery(
                {
                  lufs: candidatePreview.summary.lufsIntegrated,
                  truePeakDb: candidatePreview.summary.truePeakDb,
                  correlation: candidatePreview.summary.correlation,
                  monoLossDb: candidatePreview.summary.monoLossDb,
                },
                target,
              )
                .checks.map((check) => check.line)
                .join(" · ")}
            </span>
          </div>
          <div role="status" aria-live="polite" aria-atomic="true" aria-label="Master assistant audition trims">
            <strong>Audition trim</strong>
            <span>
              Current {formatAuditionTrim(auditionGains.current)} · Proposal{" "}
              {formatAuditionTrim(auditionGains.proposal)}
            </span>
            <span>
              {!levelMatch
                ? "Loudness matching is off; audition uses native levels."
                : auditionGains.available
                  ? "Only the louder side is attenuated to the quieter measured LUFS-I."
                  : "Loudness matching is unavailable for these readings; audition uses native levels."}
            </span>
          </div>
          <ul className="master-assistant-flags" aria-label="Draft mix checks">
            {reportLines(candidatePreview.health).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {!isPlanConsistent(analysis.plan) && (
            <p className="master-assistant-stale">
              Apply all is disabled because this plan increases two loudness stages. Review one stage at a time with
              Apply selected.
            </p>
          )}
          <div className="master-assistant-proposal-actions">
            <button type="button" onClick={() => apply(false)} disabled={workBlocked || selected.length === 0}>
              Apply selected
            </button>
            <button
              type="button"
              onClick={() => apply(true)}
              disabled={workBlocked || selected.length !== analysis.plan.length || !isPlanConsistent(analysis.plan)}
            >
              Apply all
            </button>
          </div>
        </div>
      )}
      {appliedSnapshot && (
        <div className="master-assistant-applied">
          <div>
            <strong>{appliedIsCurrent ? "Applied plan" : "Applied plan · stale revision"}</strong>
            {appliedCheck && appliedCheck.revisionId === appliedSnapshot.revisionId ? (
              <span>
                Re-rendered after apply: {formatDb(appliedCheck.summary.lufsIntegrated, "LUFS-I")} ·{" "}
                {formatDb(appliedCheck.summary.truePeakDb, "dBTP")} · crest {appliedCheck.health.crestDb.toFixed(1)} dB
              </span>
            ) : (
              <span>Waiting for a fresh post-apply render…</span>
            )}
          </div>
          <button type="button" onClick={resetToSnapshot} disabled={!appliedIsCurrent || workBlocked}>
            Reset to snapshot
          </button>
        </div>
      )}
      {analysis && !analysisIsCurrent && (
        <p className="master-assistant-stale" role="status">
          Project or render settings changed; analyze again before preview or apply.
        </p>
      )}
      {error && (
        <p className="master-assistant-error" role="alert">
          {error}
        </p>
      )}
      <p className="master-assistant-status" role="status" aria-live="polite">
        {status}
      </p>
      <footer>
        These suggestions are general starting points, not an automated mastering verdict. Phase, low-end balance,
        harshness, crest and width often need track-level fixes and listening; the assistant does not edit tracks.
      </footer>
    </section>
  );
}
