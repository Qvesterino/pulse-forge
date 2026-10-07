import { useEffect, useRef, useState } from "react";
import { useActivePatternId, useMarkers, useMaster, usePatterns, useServices, useTracks } from "./context";
import { estimateRenderPcmBytes, MAX_OFFLINE_RENDER_PCM_BYTES, renderProject } from "../rendering/renderer";
import { buildStemProject, nonEmptyStemGroups } from "../rendering/stems";
import {
  createBextMetadata,
  downloadWav,
  encodeWavAsync,
  sanitizeFilename,
  type WavBextMetadata,
} from "../rendering/wav";
import { buildScorepack } from "../export/scorepack";
import { buildZyvoTransfer } from "../export/zyvo-transfer";
import { exportProject } from "../export/project-io";
import { canExportVideo, recordVideo } from "../export/video";
import { downloadBlob } from "../export/download";
import { loadFlacEncoder } from "../export/flac-loader";
import { assertFlacExportWorkingSetBudget, estimateFlacOutputWorkingSetBytes } from "../export/flac-limits";
import { encodeShareCode, shareAppUrl, embedUrl, embedSnippet } from "../export/shareCode";
import type { WavBitDepth } from "../rendering/wav";
import type { PlayMode } from "../project-model/types";
import {
  summarizeBuffer,
  evaluateExportMonoGuard,
  evaluateMasterVerdict,
  computeStageAdjustment,
  type BufferSummary,
  type MasterVerdict,
} from "../audio-engine/metering";
import { extensionForMime, LiveRecorder, type RecordSource } from "../audio-engine/recorder";
import type { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import type { MaterializedPcmTake } from "../audio-engine/pcmRecording";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { userSampleId, type UserSampleAsset } from "../persistence/UserSampleRepository";
import { PublishToGalleryButton } from "../gallery/PublishButton";
import { isMountedInEcosystem, prepareBeatHandoff } from "../interop/qvesterHandoff";
import { setMasterConfig, chopSampleToPads } from "../commands/commands";
import { deriveMixAutoFix, type MixHealthReport } from "../analysis/mixDoctor";
import { detectTransientsAsync } from "../audio-workers/onset-detector-client";
import { slicesFromOnsets } from "../audio-engine/transients";
import { resolveDeliveryTarget, type MasterProfile } from "../mastering/profiles";
import { masteringVersionSuffix } from "../mastering/deliveryFilename";
import { inspectEncodedMaster, type EncodedMasterInspection } from "../mastering/encodedInspection";
import {
  createMasterRenderReport,
  projectRevisionIdFor,
  serializeMasterReportSidecar,
  type MasterRenderReport,
} from "../mastering/report";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import { IntegerPcmDeliveryError } from "../export/quantize";
import { MasteringFingerprint } from "./MasteringFingerprint";
import { MasterProfileFileGuidance } from "./MasterProfileFileGuidance";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; label: string; summary: BufferSummary }
  | { kind: "cancelled"; label: string; reason: string }
  | { kind: "error"; label: string };

export interface MasteringWorkspaceState {
  mode: PlayMode;
  setMode: (mode: PlayMode) => void;
  sampleRate: number;
  setSampleRate: (sampleRate: number) => void;
  quality: "live" | "studio";
  setQuality: (quality: "live" | "studio") => void;
  statusKind: Status["kind"];
  busy: boolean;
  activity: string | null;
  report: MasterRenderReport | null;
  reportStale: boolean;
  renderPcmBytes: number;
  renderPcmWithinBudget: boolean;
  analyze: () => void;
}

type MasterFormat = "wav" | "flac" | "mp3-192" | "mp3-320" | "video";
type ProfileExportRecommendation = { format: Exclude<MasterFormat, "video">; bitDepth?: WavBitDepth };

function profileExportRecommendation(profile: MasterProfile): ProfileExportRecommendation | null {
  const recommendation = profile.recommendedFormat.toLowerCase();
  const bitDepthMatch = recommendation.match(/\b(16|24|32)-bit\b/);
  const bitDepth = bitDepthMatch ? (Number(bitDepthMatch[1]) as WavBitDepth) : undefined;
  if (recommendation.includes("flac")) return { format: "flac", bitDepth: bitDepth === 16 ? 16 : 24 };
  if (recommendation.includes("wav") && bitDepth) return { format: "wav", bitDepth };
  if (recommendation.includes("mp3")) {
    const bitrate = recommendation.match(/\b(192|320)\s*kbps\b/);
    if (bitrate) return { format: `mp3-${bitrate[1]}` as "mp3-192" | "mp3-320" };
  }
  return null;
}

const EMPTY_EXPORT_SUMMARY: BufferSummary = {
  channelCount: 0,
  peak: 0,
  peakDb: -120,
  truePeakDb: -120,
  rms: 0,
  rmsDb: -120,
  correlation: 1,
  lrImbalanceDb: null,
  lufsMomentary: -120,
  lufsShortTerm: -120,
  lufsIntegrated: -120,
  monoLossDb: 0,
};

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function screenReaderExportStatus(status: Status, reportStale: boolean): string {
  const label =
    status.kind === "idle"
      ? "Offline render uses the same engine, instruments and effects as playback, plus a 2 second tail for reverb and delay."
      : status.label;
  const message = status.kind === "cancelled" ? `${label}. ${status.reason}` : label;
  const progressMatch = status.kind === "busy" ? message.match(/\d{1,3}%/) : null;
  const announcedMessage = progressMatch
    ? message.replace(progressMatch[0], `${Math.floor(Number(progressMatch[0].slice(0, -1)) / 10) * 10}%`)
    : message;
  const staleMessage = reportStale ? "Master report is stale. Analyze again before delivery." : null;
  return [announcedMessage, staleMessage].filter(Boolean).join(" ");
}

type RecSourceKind = "master" | "track" | "mic";
type RecState = "idle" | "starting" | "recording" | "saving";

/**
 * BWF `bext` metadata (EBU Tech 3285) for every deliverable WAV this panel
 * writes — project identity, timestamp and, when a render summary exists,
 * the measured loudness in the spec's v2 fields. Pro Tools / Nuendo / film
 * workflows read these on import.
 */
function bextFor(
  description: string,
  summary: BufferSummary | null,
  sampleRate: number,
  depth: WavBitDepth,
): WavBextMetadata {
  return createBextMetadata({
    description,
    ...(summary
      ? {
          loudness: {
            integratedLufs: summary.lufsIntegrated,
            rangeLu: summary.loudnessRangeLu,
            truePeakDbtp: summary.truePeakDb,
            momentaryLufs: summary.lufsMomentary,
            shortTermLufs: summary.lufsShortTerm,
          },
        }
      : {}),
    codingHistory: `A=PCM,F=${sampleRate},W=${depth},M=stereo,T=KYX offline render`,
  });
}

export function ExportPanel({
  selectedTrackId,
  selectedTrackName,
  masteringMode = false,
  revisionId,
  onMasteringWorkspaceStateChange,
}: {
  selectedTrackId?: string;
  selectedTrackName?: string;
  masteringMode?: boolean;
  revisionId?: string;
  onMasteringWorkspaceStateChange?: (state: MasteringWorkspaceState) => void;
} = {}) {
  const services = useServices();
  const [sampleBankRevision, setSampleBankRevision] = useState(services.bank.revision);
  useEffect(() => services.bank.onRevisionChanged(setSampleBankRevision), [services.bank]);
  // Fine-grained selectors (GOAL 04): ExportPanel reads markers (count
  // badge), patterns (active pattern name), tracks (renderable tracks,
  // total count), and master (LUFS target, ceiling dB for the meter). Root
  // scalars (`doc.name`, `doc.bpm`) come from a plain getter.
  const markers = useMarkers();
  const patterns = usePatterns();
  const activePatternId = useActivePatternId();
  const tracks = useTracks();
  const master = useMaster();
  const deliveryProfile = resolveDeliveryTarget(master);
  const recommendedExport = profileExportRecommendation(deliveryProfile);
  const doc = services.store.getDoc();
  const [mode, setMode] = useState<PlayMode>(masteringMode ? "song" : services.playback.mode);
  const [sampleRate, setSampleRate] = useState(44100);
  const [standardBitDepth, setStandardBitDepth] = useState<WavBitDepth>(16);
  const [masteringBitDepth, setMasteringBitDepth] = useState<WavBitDepth>(recommendedExport?.bitDepth ?? 24);
  const bitDepth = masteringMode ? masteringBitDepth : standardBitDepth;
  const setBitDepth = (depth: WavBitDepth) => {
    if (masteringMode) setMasteringBitDepth(depth);
    else setStandardBitDepth(depth);
  };
  const [format, setFormat] = useState<MasterFormat>("wav");
  // Global Live/Export quality switch — defaults to STUDIO: the export has
  // no realtime CPU budget, so PRISM's 8× saturation oversampling and VØID's
  // render tier (default-tier instances only; explicit eco/high/render
  // choices are respected) apply across tracks, returns and master inserts.
  // LIVE keeps their stored runtime quality; freeze/bounce stay on that tier.
  const [quality, setQuality] = useState<"live" | "studio">("studio");
  const [includeTrackStems, setIncludeTrackStems] = useState(true);
  const [clipSeconds, setClipSeconds] = useState(15);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [masterReport, setMasterReport] = useState<MasterRenderReport | null>(null);
  const [masterVersion, setMasterVersion] = useState("");
  const [masterDeliveryFileName, setMasterDeliveryFileName] = useState<string | null>(null);

  const markerCount = markers.length;
  /** Active export run — the CANCEL button aborts it (roadmap 1.4). */
  const abortRef = useRef<AbortController | null>(null);
  const analyzeActionRef = useRef<() => void>(() => undefined);
  const cancelRequestedByUserRef = useRef(false);
  const beginExport = (): AbortSignal => {
    cancelRequestedByUserRef.current = false;
    setMasterReport(null);
    setMasterDeliveryFileName(null);
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  };
  const cancelExport = () => {
    cancelRequestedByUserRef.current = true;
    abortRef.current?.abort();
  };
  /** Cancellation is distinct from success and failure; it never leaves a report behind. */
  const cancelOrElse = (error: unknown, fallbackLabel: string, cancelLabel: string): void => {
    if (isAbortError(error)) {
      const reason = cancelRequestedByUserRef.current
        ? "Cancelled by user."
        : "The operation aborted before completion.";
      cancelRequestedByUserRef.current = false;
      setMasterReport(null);
      setStatus({ kind: "cancelled", label: cancelLabel, reason });
      return;
    }
    setStatus({ kind: "error", label: fallbackLabel.replace("{err}", String(error)) });
  };

  const [recSource, setRecSource] = useState<RecSourceKind>("master");
  const [recState, setRecState] = useState<RecState>("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recorderRef = useRef<LiveRecorder | PcmMicRecorder | null>(null);
  const stoppingRecordingRef = useRef(false);
  /** Last finished take — kept for one-click AUTO-CHOP to pads. */
  const [lastTake, setLastTake] = useState<{ assetId: string; name: string; buffer: AudioBuffer } | null>(null);
  const [chopping, setChopping] = useState(false);
  const [chopNote, setChopNote] = useState<string | null>(null);

  const busy = status.kind === "busy";
  const deliveredMeasurements =
    masterReport?.encodedDelivery?.decode.status === "measured"
      ? (masterReport.encodedDelivery.decode.measurements ?? null)
      : null;
  const deliveredMixHealth =
    masterReport?.encodedDelivery?.decode.status === "measured"
      ? (masterReport.encodedDelivery.decode.mixHealth ?? masterReport.mixHealth)
      : (masterReport?.mixHealth ?? null);
  const mixHealthStage = masterReport?.encodedDelivery?.decode.status === "measured" ? "POST-DECODE" : "PRE-ENCODE";
  const encodedSettingsStale = Boolean(
    masterReport?.encodedDelivery &&
    (format === "video" ||
      masterReport.encodedDelivery.format !== (format.startsWith("mp3") ? "mp3" : format === "flac" ? "flac" : "wav") ||
      ((masterReport.encodedDelivery.format === "wav" || masterReport.encodedDelivery.format === "flac") &&
        masterReport.encodedDelivery.file.bitDepth !== bitDepth) ||
      (masterReport.encodedDelivery.format === "mp3" &&
        Math.abs((masterReport.encodedDelivery.file.averageBitrateKbps ?? 0) - (format === "mp3-320" ? 320 : 192)) >
          8)),
  );
  const masterRenderStale = Boolean(
    masteringMode &&
    masterReport &&
    (masterReport.projectRevisionId !== revisionId ||
      masterReport.sampleBankRevision !== sampleBankRevision ||
      masterReport.scope !== mode ||
      masterReport.sampleRate !== sampleRate ||
      masterReport.quality !== quality),
  );
  const reportStale = Boolean(masteringMode && masterReport && (masterRenderStale || encodedSettingsStale));
  const integerMasterDelivery = format.startsWith("mp3") || format === "flac" || (format === "wav" && bitDepth !== 32);
  const integerMasterPeakOverRange = Boolean(
    masteringMode && masterReport && !masterRenderStale && integerMasterDelivery && masterReport.measurements.peak > 1,
  );
  const baseName = sanitizeFilename(doc.name);
  const versionSuffix = masteringMode ? masteringVersionSuffix(masterVersion) : "";
  // Keep the workspace preflight tied to the renderer's exact duration/tail
  // estimate so Analyze and Export can explain a memory-limit failure before
  // an OfflineAudioContext is allocated.
  const renderPcmBytes = estimateRenderPcmBytes(doc, { mode, sampleRate });
  const renderPcmLimitMiB = Math.floor(MAX_OFFLINE_RENDER_PCM_BYTES / (1024 * 1024));
  const renderPcmWithinBudget =
    Number.isFinite(renderPcmBytes) && renderPcmBytes > 0 && renderPcmBytes <= MAX_OFFLINE_RENDER_PCM_BYTES;
  const groups = nonEmptyStemGroups(doc);
  const videoSupported = canExportVideo();
  const activePatternName = patterns.find((p) => p.id === activePatternId)?.name ?? "pattern";
  const downloadMasterReport = () => {
    if (!masterReport || reportStale) return;
    const json = serializeMasterReportSidecar(masterReport);
    const reportName = masterDeliveryFileName
      ? masterDeliveryFileName.replace(/\.(?:wav|mp3|flac)$/i, "-report.json")
      : `${baseName}-master-report.json`;
    downloadBlob(new Blob([json], { type: "application/json" }), reportName);
  };

  const exportMaster = async (download = true) => {
    const signal = beginExport();
    const projectRevisionAtStart = projectRevisionIdFor(doc);
    let sampleBankRevisionAtStart = services.bank.revision;
    const assertMasterSourceCurrent = (): void => {
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const current = services.store.getDoc();
      if (current.id !== doc.id || projectRevisionIdFor(current) !== projectRevisionAtStart) {
        throw new Error("The project changed during mastering. The stale result was discarded; analyze again.");
      }
      if (services.bank.revision !== sampleBankRevisionAtStart) {
        throw new Error("The sample bank changed during mastering. The stale result was discarded; analyze again.");
      }
    };
    setStatus({ kind: "busy", label: "Preparing sample audio for a consistent mastering render…" });
    try {
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, signal);
      sampleBankRevisionAtStart = services.bank.revision;
      assertMasterSourceCurrent();
      setStatus({ kind: "busy", label: download ? "Rendering master…" : "Analyzing master…" });
      let buffer: AudioBuffer | null = await renderProject(doc, services.bank, {
        mode,
        sampleRate,
        quality,
        signal,
      });
      assertMasterSourceCurrent();
      const renderedDurationSeconds = buffer.duration;
      const profile = resolveDeliveryTarget(master);
      const analysis = await analyzeMasterBufferAsync(buffer, profile, {
        signal,
        onProgress: ({ progress, stage }) =>
          setStatus({ kind: "busy", label: `Analyzing master… ${Math.round(progress * 100)}% · ${stage}` }),
      });
      assertMasterSourceCurrent();
      const { measurements: summary, mixHealth: mixHealthReport, verdict } = analysis;
      setMasterReport(
        createMasterRenderReport({
          projectId: doc.id,
          projectName: doc.name,
          projectRevisionId: revisionId ?? projectRevisionAtStart,
          sampleBankRevision: sampleBankRevisionAtStart,
          scope: mode,
          sampleRate: buffer.sampleRate,
          quality,
          durationSeconds: renderedDurationSeconds,
          sampleRange: { startFrame: 0, endFrame: buffer.length },
          profile,
          measurements: summary,
          loudnessTimeline: analysis.loudnessTimeline,
          mixHealth: mixHealthReport,
          verdict,
        }),
      );

      if (!download) {
        assertMasterSourceCurrent();
        setStatus({
          kind: "done",
          label: `Analysis complete (${mode === "song" ? "full song" : "active pattern"}, ${buffer.duration.toFixed(1)}s, ${sampleRate} Hz, ${quality === "studio" ? "Studio HQ" : "Live"})`,
          summary,
        });
        return;
      }

      if (format === "video") {
        const seconds = Math.min(clipSeconds, renderedDurationSeconds);
        const result = await recordVideo(buffer, {
          title: doc.name,
          bpm: doc.bpm,
          seconds,
          signal,
          onProgress: (f) => setStatus({ kind: "busy", label: `Recording video… ${Math.round(f * 100)}%` }),
        });
        assertMasterSourceCurrent();
        downloadBlob(result.blob, `${baseName}-clip.${result.ext}`);
        setStatus({
          kind: "done",
          label: `Video exported — ${seconds}s ${result.ext.toUpperCase()}, ${(result.bytes / 1e6).toFixed(1)} MB, ready for Reels/Shorts/TikTok`,
          summary,
        });
        return;
      }

      if (format.startsWith("mp3")) {
        const kbps = format === "mp3-320" ? 320 : 192;
        // The LAME encoder is a heavy dependency — fetched on first MP3 export.
        const { encodeMp3 } = await import("../export/mp3");
        const blob = await encodeMp3(buffer, {
          kbps,
          ...(masteringMode ? { integerOverflowPolicy: "reject" as const } : {}),
          signal,
          onProgress: (f) => setStatus({ kind: "busy", label: `Encoding MP3 ${kbps}… ${Math.round(f * 100)}%` }),
        });
        buffer = null;
        setStatus({ kind: "busy", label: "Checking encoded MP3…" });
        const encodedDelivery = await inspectEncodedMaster({
          format: "mp3",
          bytes: blob,
          fingerprintBlob: masteringMode ? blob : undefined,
          expectedDurationSeconds: renderedDurationSeconds,
          sourceMeasurements: summary,
          profile,
          signal,
          onProgress: ({ progress, stage }) =>
            setStatus({ kind: "busy", label: `Checking encoded MP3… ${Math.round(progress * 100)}% · ${stage}` }),
        });
        assertMasterSourceCurrent();
        setMasterReport((report) => (report ? { ...report, encodedDelivery } : report));
        const fileName = `${baseName}-${kbps}${versionSuffix}.mp3`;
        setMasterDeliveryFileName(fileName);
        downloadBlob(blob, fileName);
        setStatus({
          kind: "done",
          label: `MP3 exported (${renderedDurationSeconds.toFixed(1)}s, ${kbps} kbps, ${(blob.size / 1e6).toFixed(2)} MB) as ${fileName} — ${encodedDelivery.decode.status === "measured" ? "decoded file measured" : "header checked; audio not measured"}`,
          summary,
        });
        return;
      }

      if (format === "flac") {
        const flacBitDepth = bitDepth === 16 ? 16 : 24;
        assertFlacExportWorkingSetBudget(renderPcmBytes, estimateFlacOutputWorkingSetBytes(buffer, flacBitDepth));
        const { encodeFlac } = await loadFlacEncoder();
        const blob = await encodeFlac(buffer, {
          bitDepth: flacBitDepth,
          signal,
          onProgress: (f) => setStatus({ kind: "busy", label: `Encoding FLAC… ${Math.round(f * 100)}%` }),
        });
        buffer = null;
        setStatus({ kind: "busy", label: "Checking encoded FLAC…" });
        const encodedDelivery = await inspectEncodedMaster({
          format: "flac",
          bytes: blob,
          fingerprintBlob: masteringMode ? blob : undefined,
          expectedDurationSeconds: renderedDurationSeconds,
          sourceMeasurements: summary,
          profile,
          signal,
          onProgress: ({ progress, stage }) =>
            setStatus({ kind: "busy", label: `Checking encoded FLAC… ${Math.round(progress * 100)}% · ${stage}` }),
        });
        assertMasterSourceCurrent();
        setMasterReport((report) => (report ? { ...report, encodedDelivery } : report));
        const fileName = `${baseName}-master-${flacBitDepth}bit${versionSuffix}.flac`;
        setMasterDeliveryFileName(fileName);
        downloadBlob(blob, fileName);
        setStatus({
          kind: "done",
          label: `FLAC exported (${renderedDurationSeconds.toFixed(1)}s, ${sampleRate} Hz, ${flacBitDepth}-bit) as ${fileName} — ${encodedDelivery.decode.status === "measured" ? "decoded file measured" : "header checked; audio not measured"}`,
          summary,
        });
        return;
      }

      // Audit 11 (reliability wave): async encode — the per-sample loop
      // yields per 64k-frame block, keeps the UI alive, reports progress
      // and honors Cancel. Byte-identical to the sync encoder.
      const wavBytes = await encodeWavAsync(buffer, bitDepth, {
        bext: bextFor(`${doc.name} — KYX master`, summary, sampleRate, bitDepth),
        ...(masteringMode ? { integerOverflowPolicy: "reject" as const } : {}),
        onProgress: (f) => setStatus({ kind: "busy", label: `Encoding WAV… ${Math.round(f * 100)}%` }),
        signal,
      });
      const wavBlob = new Blob([wavBytes], { type: "audio/wav" });
      buffer = null;
      setStatus({ kind: "busy", label: "Checking encoded WAV…" });
      const encodedDelivery = await inspectEncodedMaster({
        format: "wav",
        bytes: wavBytes,
        fingerprintBlob: masteringMode ? wavBlob : undefined,
        expectedDurationSeconds: renderedDurationSeconds,
        sourceMeasurements: summary,
        profile,
        signal,
        onProgress: ({ progress, stage }) =>
          setStatus({ kind: "busy", label: `Checking encoded WAV… ${Math.round(progress * 100)}% · ${stage}` }),
      });
      assertMasterSourceCurrent();
      setMasterReport((report) => (report ? { ...report, encodedDelivery } : report));
      const fileName = `${baseName}-master${versionSuffix}.wav`;
      setMasterDeliveryFileName(fileName);
      downloadBlob(wavBlob, fileName);
      setStatus({
        kind: "done",
        label: `Master exported (${renderedDurationSeconds.toFixed(1)}s, ${sampleRate} Hz, ${bitDepth}-bit) as ${fileName} — ${encodedDelivery.decode.status === "measured" ? "decoded file measured" : "header checked; audio not measured"}`,
        summary,
      });
    } catch (error) {
      if (!isAbortError(error) && !(error instanceof IntegerPcmDeliveryError)) setMasterReport(null);
      cancelOrElse(error, `Export failed: {err}`, download ? "Master export cancelled" : "Master analysis cancelled");
    }
  };

  analyzeActionRef.current = () => {
    if (masteringMode && !busy) void exportMaster(false);
  };

  useEffect(() => {
    if (!masteringMode || !onMasteringWorkspaceStateChange) return;
    onMasteringWorkspaceStateChange({
      mode,
      setMode,
      sampleRate,
      setSampleRate,
      quality,
      setQuality,
      statusKind: status.kind,
      busy,
      activity: status.kind === "idle" ? null : status.label,
      report: masterReport,
      reportStale,
      renderPcmBytes,
      renderPcmWithinBudget,
      analyze: () => analyzeActionRef.current(),
    });
  }, [
    masteringMode,
    onMasteringWorkspaceStateChange,
    mode,
    setMode,
    sampleRate,
    setSampleRate,
    quality,
    setQuality,
    busy,
    status,
    masterReport,
    reportStale,
    renderPcmBytes,
    renderPcmWithinBudget,
  ]);

  /** Qvester ecosystem: render + hand the WAV to Audio Canvas (same-origin
   *  mount only — the handoff medium is shared IndexedDB + WebStorage). */
  const sendToQvesterVisualizer = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Rendering beat for Audio Canvas…" });
    try {
      const { packet, record } = await prepareBeatHandoff(doc, services.bank, {
        mode,
        sampleRate,
        quality,
        signal,
        onProgress: (f, label) => setStatus({ kind: "busy", label: `${label} ${Math.round(f * 100)}%` }),
      });
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = `${window.location.origin}/audio-canvas?handoff=${encodeURIComponent(packet.handoffId)}&handoffIntent=${encodeURIComponent(packet.intent)}`;
      setStatus({
        kind: "done",
        label: `Handoff ready — ${record.name} (${(record.byteLength / 1e6).toFixed(1)} MB WAV) handed to Audio Canvas`,
        summary: EMPTY_EXPORT_SUMMARY,
      });
      window.location.assign(url);
    } catch (error) {
      cancelOrElse(error, `Send to visualizer failed: {err}`, "Visualizer handoff cancelled");
    }
  };

  const exportStems = async () => {
    const signal = beginExport();
    try {
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < groups.length; i++) {
        if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        const group = groups[i];
        setStatus({ kind: "busy", label: `Rendering stem ${i + 1}/${groups.length}: ${group.label}…` });
        const stemDoc = buildStemProject(doc, group.filter);
        const buffer = await renderProject(stemDoc, services.bank, {
          mode,
          sampleRate,
          quality,
          signal,
          // Audit 11 D1: stems are deliverables for re-balancing elsewhere —
          // they must not bake the master limiter/tape/glue into every stem.
          masterProcessing: false,
        });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(
          await encodeWavAsync(buffer, bitDepth, {
            bext: bextFor(`${doc.name} — ${group.label} stem`, lastSummary, sampleRate, bitDepth),
            onProgress: (f) => setStatus({ kind: "busy", label: `Encoding stem WAV… ${Math.round(f * 100)}%` }),
            signal,
          }),
          `${baseName}-${group.id}.wav`,
        );
      }
      setStatus({
        kind: "done",
        label: `${groups.length} stems exported (${groups.map((g) => g.label).join(", ")})`,
        summary: lastSummary ?? EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Stem export failed: {err}", "Stem export cancelled");
    }
  };

  const exportTracks = async () => {
    const signal = beginExport();
    try {
      // Group tracks have no own generators — rendering one produces a
      // silent WAV (their children belong to their own stems).
      const renderableTracks = tracks.filter((t) => t.kind !== "group");
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < renderableTracks.length; i++) {
        if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        const track = renderableTracks[i];
        setStatus({ kind: "busy", label: `Rendering track ${i + 1}/${renderableTracks.length}: ${track.name}…` });
        const trackDoc = buildStemProject(doc, (t) => t.id === track.id);
        const buffer = await renderProject(trackDoc, services.bank, {
          mode,
          sampleRate,
          quality,
          signal,
          // Individual track exports are pre-master stems, just like grouped
          // stem exports. Their track, parent-group and routed return FX stay
          // in the render; global master processing is applied only to the
          // final stereo master and must not be printed onto every track.
          masterProcessing: false,
        });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(
          await encodeWavAsync(buffer, bitDepth, {
            bext: bextFor(`${doc.name} — ${track.name} track stem`, lastSummary, sampleRate, bitDepth),
            onProgress: (f) => setStatus({ kind: "busy", label: `Encoding track WAV… ${Math.round(f * 100)}%` }),
            signal,
          }),
          `${baseName}-track-${sanitizeFilename(track.name)}.wav`,
        );
      }
      setStatus({
        kind: "done",
        label: `${renderableTracks.length} track stems exported`,
        summary: lastSummary ?? EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Track export failed: {err}", "Track export cancelled");
    }
  };

  const copyText = async (text: string, doneLabel: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "done", label: doneLabel, summary: EMPTY_EXPORT_SUMMARY });
    } catch {
      setStatus({ kind: "error", label: "Clipboard blocked by the browser — copy failed" });
    }
  };

  /** Share link: the whole project compressed into the URL (?import=…). */
  const copyShareLink = () => {
    const code = encodeShareCode(doc);
    const url = shareAppUrl(code, location.origin);
    const approxKb = Math.round(url.length / 1024);
    return copyText(url, `Share link copied (${approxKb} kB URL) — opens this project in the studio`);
  };

  /** Embed snippet: self-contained player iframe for Discord/Reddit/websites. */
  const copyEmbedCode = () => {
    const code = encodeShareCode(doc);
    const snippet = embedSnippet(embedUrl(code, location.origin));
    return copyText(snippet, "Embed iframe copied — paste it into a website");
  };

  /** MIDI export: the active pattern as a format-1 .mid (drums on ch 10). */
  const exportMidi = async () => {
    try {
      // The SMF writer is a lazy chunk — fetched on first MIDI export.
      const { patternToMidi, downloadMidi } = await import("../midi/midiProject");
      const bytes = patternToMidi(doc, activePatternId);
      downloadMidi(bytes, `${baseName}-${sanitizeFilename(activePatternName)}`);
      setStatus({
        kind: "done",
        label: `MIDI exported (${activePatternName}) — opens in any DAW`,
        summary: EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      setStatus({ kind: "error", label: `MIDI export failed: ${String(error)}` });
    }
  };

  const exportScorepack = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Building scorepack…" });
    try {
      const { blob, filename } = await buildScorepack(
        doc,
        services.bank,
        (p) => {
          setStatus({ kind: "busy", label: `Scorepack: ${p.phase}…` });
        },
        signal,
        { quality },
      );
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL?.(url), 5000);
      setStatus({
        kind: "done",
        label: `Scorepack exported (${filename})`,
        summary: EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Scorepack failed: {err}", "Scorepack creation cancelled");
    }
  };

  const exportZyvoTransfer = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Preparing KYX → ZYVO transfer…" });
    try {
      const result = await buildZyvoTransfer(
        doc,
        services.bank,
        (progress) => setStatus({ kind: "busy", label: `ZYVO transfer: ${progress.phase}…` }),
        signal,
        { quality, includeTrackStems },
      );
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL?.(url), 30_000);
      setStatus({
        kind: "done",
        label: `ZYVO transfer ready (${result.manifest.stems.length} stems · ${result.blob.size.toLocaleString()} bytes)`,
        summary: result.masterSummary,
      });
    } catch (error) {
      cancelOrElse(error, "ZYVO transfer failed: {err}", "ZYVO transfer cancelled");
    }
  };

  // ── Realtime resample — bounce what you hear / mic capture ─────────────

  const startRecording = async () => {
    services.engine.ensureContext();
    const ctx = services.engine.getLiveAudioContext();
    if (!ctx) {
      setRecError("Audio engine not ready");
      return;
    }
    // Audit 07 D5: enter "starting" IMMEDIATELY — the mic permission prompt
    // can take seconds, and a second click used to construct a competing
    // recorder whose claim error surfaced while the first prompt was open.
    setRecState("starting");
    // The TRACK option only renders with a selected track; anything else that
    // slips through falls back to the master tap rather than failing silently.
    const source: RecordSource =
      recSource === "mic"
        ? { kind: "mic" }
        : recSource === "track" && selectedTrackId
          ? { kind: "track", trackId: selectedTrackId }
          : { kind: "master" };
    try {
      if (source.kind === "mic") {
        const { PcmMicRecorder } = await import("../audio-engine/PcmMicRecorder");
        const recorder = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
        recorderRef.current = recorder;
        let startResolved = false;
        let earlyError: string | null = null;
        recorder.onError = (message) => {
          setRecError(message);
          if (startResolved) void stopRecording();
          else earlyError = message;
        };
        const start = recorder.start(() => {
          const currentDoc = services.store.doc;
          const selected = currentDoc.tracks.find((track) => track.id === selectedTrackId);
          return {
            projectId: currentDoc.id,
            trackId: selected?.id ?? "",
            trackName: "Standalone microphone resample",
            placeOnTimeline: false,
            startBar: 0,
            bpm: currentDoc.bpm,
          };
        });
        await start;
        setRecSeconds(0);
        setRecError(null);
        setRecState("recording");
        startResolved = true;
        if (earlyError) void stopRecording();
        return;
      }

      const recorder = new LiveRecorder({
        ctx,
        getTapNode: (recordSource: RecordSource) => {
          if (recordSource.kind === "master") return services.engine.getMasterTapNode();
          if (recordSource.kind === "track") return services.engine.getTrackTapNode(recordSource.trackId);
          return null;
        },
      });
      recorderRef.current = recorder;
      await recorder.start(source);
      setRecSeconds(0);
      setRecError(null);
      setRecState("recording");
    } catch (err) {
      const recorder = recorderRef.current;
      if (recorder) await Promise.resolve(recorder.cancel()).catch(() => undefined);
      recorderRef.current = null;
      setRecState("idle"); // back off "starting" — retry must be possible
      setRecError(err instanceof Error ? err.message : "Recording failed");
    }
  };

  const stopRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    setRecState("saving");
    try {
      const take = await recorder.stop();
      if (!take) {
        setRecError("Nothing was captured. Any staged microphone audio remains available for recovery.");
        setRecState("idle");
        return;
      }
      const buffer = take.buffer;
      let pcmTake: MaterializedPcmTake | null = null;
      let blob: Blob | null = null;
      if ("session" in take) {
        pcmTake = take;
      } else {
        blob = take.blob;
      }
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const id = userSampleId(`resample-${stamp}`);
      services.bank.add(id, buffer);
      // Tempo tag for the sample browser — resampled loops fit the same
      // "Fit to project BPM" workflow as imports.
      let bpm: number | undefined;
      try {
        const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
        if (detected) bpm = detected.bpm;
      } catch {
        /* best-effort */
      }
      const asset: UserSampleAsset = {
        id,
        name: `Resample ${stamp}`,
        fileName: `${id}${pcmTake ? ".wav" : extensionForMime(blob!.type)}`,
        category: "Custom",
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
        ...(bpm !== undefined ? { bpm } : {}),
      };
      try {
        if (pcmTake) {
          await services.recordingRecovery.finalize(pcmTake.session.id, asset);
          services.userSamples.invalidateCache();
        } else {
          await services.userSamples.save(asset, await blob!.arrayBuffer());
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Saving the take failed";
        setRecError(pcmTake ? `${detail}. The staged PCM remains available for recovery.` : detail);
        setRecState("idle");
        return;
      }
      setStatus({
        kind: "done",
        label: `Resampled → "${asset.name}" in Samples (${buffer.duration.toFixed(1)}s) — click it in the browser to flip onto a pad`,
        summary: summarizeBuffer(buffer),
      });
      setLastTake({ assetId: id, name: asset.name, buffer });
      setChopNote(null);
      setRecState("idle");
    } catch (error) {
      setRecError(error instanceof Error ? error.message : "Could not finish the recording");
      setRecState("idle");
    } finally {
      recorderRef.current = null;
      stoppingRecordingRef.current = false;
    }
  };

  // Elapsed REC timer.
  useEffect(() => {
    if (recState !== "recording") return;
    const timer = setInterval(() => {
      setRecSeconds(recorderRef.current?.elapsedSeconds ?? 0);
    }, 200);
    return () => clearInterval(timer);
  }, [recState]);

  // A recorder left running at unmount must release its device/nodes while
  // preserving any committed PCM blocks for the recovery prompt.
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && "onError" in recorder) recorder.onError = null;
      if (recorder) void Promise.resolve(recorder.cancel()).catch(() => undefined);
    },
    [],
  );

  /**
   * One-click AUTO-CHOP: onset-detect the last take (worker, off the UI
   * thread), zero-cross-snapped slices → drum pads + a diagonal pattern.
   * One undoable command, same chop path as SliceLab's manual flow.
   */
  const autoChop = async () => {
    if (!lastTake || chopping) return;
    setChopping(true);
    setChopNote(null);
    try {
      const channelData = lastTake.buffer.getChannelData(0);
      const times = await detectTransientsAsync(channelData, lastTake.buffer.sampleRate, 1);
      const slices = slicesFromOnsets(times, lastTake.buffer.duration, channelData, lastTake.buffer.sampleRate);
      if (slices.length < 2) {
        setChopNote("No transients found — try a busier take.");
        return;
      }
      const doc = services.store.getDoc();
      const target =
        doc.tracks.find((track) => track.id === selectedTrackId && track.kind === "drum") ??
        doc.tracks.find((track) => track.kind === "drum");
      if (!target || target.kind !== "drum") {
        setChopNote("AUTO-CHOP needs a drum track — create one first.");
        return;
      }
      const fit = slices.slice(0, target.pads.length);
      services.store.execute(
        chopSampleToPads(doc, {
          trackId: target.id,
          assetId: lastTake.assetId,
          sourceName: lastTake.name,
          slices: fit.map((slice) => ({ ...slice, fadeIn: 0, fadeOut: 0, reverse: false })),
          createPattern: true,
        }),
      );
      setChopNote(
        fit.length < slices.length
          ? `Chopped first ${fit.length} of ${slices.length} slices → ${target.name} + pattern`
          : `${fit.length} slices → ${target.name} + pattern`,
      );
    } catch (error) {
      setChopNote(error instanceof Error ? error.message : "Auto-chop failed — try again");
    } finally {
      setChopping(false);
    }
  };

  return (
    <section className="export-panel" aria-label="Export">
      <div className="export-options">
        {!masteringMode && (
          <label className="fx-param-select">
            <span className="slider-label">SOURCE</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as PlayMode)}>
              <option value="song">Arrangement (SONG)</option>
              <option value="pattern">Active pattern (1 pass)</option>
            </select>
          </label>
        )}
        {!masteringMode && (
          <label className="fx-param-select">
            <span className="slider-label">RATE</span>
            <select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
            </select>
          </label>
        )}
        <label className="fx-param-select">
          <span className="slider-label">FORMAT</span>
          <select
            value={format}
            onChange={(event) => {
              const nextFormat = event.target.value as MasterFormat;
              setFormat(nextFormat);
              if (nextFormat === "flac" && bitDepth === 32) setBitDepth(24);
            }}
          >
            <option value="wav">WAV (studio)</option>
            <option value="flac">FLAC (lossless)</option>
            <option value="mp3-192">MP3 192 (share)</option>
            <option value="mp3-320">MP3 320 (hq share)</option>
            <option value="video" disabled={!videoSupported || masteringMode} hidden={masteringMode}>
              VIDEO {videoSupported ? "(Reels/TikTok)" : "(unsupported)"}
            </option>
          </select>
        </label>
        {!masteringMode && (
          <label
            className="fx-param-select"
            title="STUDIO: PRISM renders at 8x saturation oversampling and default-tier VØID at the render tier across tracks, returns and master inserts (explicit eco/high/render choices respected). Slower render, no effect on the live document. LIVE uses each effect's stored quality setting and renders faster."
          >
            <span className="slider-label">QUALITY</span>
            <select value={quality} onChange={(event) => setQuality(event.target.value as "live" | "studio")}>
              <option value="studio">Studio HQ</option>
              <option value="live">Live (faster)</option>
            </select>
          </label>
        )}
        {format === "video" && (
          <label className="fx-param-select">
            <span className="slider-label">LENGTH</span>
            <select value={clipSeconds} onChange={(event) => setClipSeconds(Number(event.target.value))}>
              <option value={5}>5 s</option>
              <option value={10}>10 s</option>
              <option value={15}>15 s</option>
              <option value={30}>30 s</option>
            </select>
          </label>
        )}
        <label className="fx-param-select">
          <span className="slider-label">DEPTH</span>
          <select
            value={bitDepth}
            disabled={format !== "wav" && format !== "flac"}
            title={
              format === "flac"
                ? "FLAC supports 16-bit or 24-bit integer PCM"
                : format !== "wav"
                  ? "Depth applies to WAV and FLAC only"
                  : undefined
            }
            onChange={(event) => setBitDepth(Number(event.target.value) as WavBitDepth)}
          >
            <option value={16}>16-bit PCM</option>
            <option value={24}>24-bit PCM</option>
            <option value={32} disabled={format === "flac"}>
              32-bit float
            </option>
          </select>
        </label>
        {masteringMode && format !== "video" && (
          <label className="fx-param-select">
            <span className="slider-label">VERSION</span>
            <input
              type="text"
              value={masterVersion}
              disabled={busy}
              maxLength={32}
              placeholder="Optional · e.g. v02"
              title="Version for the next master export. Spaces become dashes; unsafe filename characters are removed."
              aria-label="Master delivery version"
              aria-describedby="master-version-hint"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => setMasterVersion(event.target.value)}
            />
            <small id="master-version-hint" className="export-version-hint">
              Next export only · spaces become dashes; unsafe filename characters are removed.
            </small>
          </label>
        )}
      </div>
      {masteringMode && (
        <div className="mastering-profile-export-suggestion" role="note">
          <span>
            PROFILE SUGGESTION · {deliveryProfile.recommendedFormat}
            {
              " · WAV supports 16/24-bit PCM and 32-bit float; FLAC supports 16/24-bit PCM. Integer exports use deterministic TPDF dither and refuse over-range samples instead of silently clipping."
            }
          </span>
          <MasterProfileFileGuidance profile={deliveryProfile} />
          {recommendedExport && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => {
                setFormat(recommendedExport.format);
                if (recommendedExport.bitDepth) setBitDepth(recommendedExport.bitDepth);
              }}
            >
              USE PROFILE FILE SETTINGS
            </button>
          )}
        </div>
      )}
      <div className="export-policy" role="note" aria-label="Export policy">
        {integerMasterPeakOverRange && masterReport && (
          <span className="export-policy-warning" role="alert">
            INTEGER DELIVERY EXCEEDS FULL SCALE · sample peak{" "}
            {(20 * Math.log10(masterReport.measurements.peak)).toFixed(2)} dBFS. Lower master gain/trim or limiter
            ceiling and render again, or choose 32-bit-float WAV. KYX will refuse this integer export instead of
            applying hidden saturation.
          </span>
        )}
        {masteringMode && !renderPcmWithinBudget && (
          <span className="export-policy-warning" role="alert">
            {Number.isFinite(renderPcmBytes) && renderPcmBytes > 0
              ? `RENDER TOO LARGE · ${(renderPcmBytes / (1024 * 1024)).toFixed(1)} MiB stereo PCM exceeds the ${renderPcmLimitMiB} MiB limit. Choose Active pattern or shorten the song${sampleRate > 44100 ? ", or lower the sample rate" : ""}.`
              : "RENDER SIZE UNAVAILABLE · Check the project tempo and render scope before analyzing or exporting."}
          </span>
        )}
        {markerCount > 0 && (
          <span className="export-policy-warning">
            MARKERS: {markerCount} cue one-shots are included in SCOREPACK, not the master WAV.
          </span>
        )}
        <span>OFFLINE: CANCEL stops between stages/encoding; the current render stage completes.</span>
        {format === "video" && (
          <span className="export-policy-warning">
            VIDEO: final duration is codec/frame-granular; verify short clips after export.
          </span>
        )}
      </div>
      <div className="export-buttons">
        {masteringMode ? (
          <>
            <button
              type="button"
              className="btn btn-export"
              disabled={
                busy || !renderPcmWithinBudget || integerMasterPeakOverRange || (format === "video" && !videoSupported)
              }
              title={
                integerMasterPeakOverRange
                  ? "Integer master delivery exceeds 0 dBFS sample peak. Lower the master level or choose 32-bit-float WAV."
                  : !renderPcmWithinBudget
                    ? `The estimated stereo PCM render exceeds KYX's ${renderPcmLimitMiB} MiB safety limit.`
                    : undefined
              }
              onClick={() => void exportMaster(true)}
            >
              {format === "video"
                ? "EXPORT VIDEO"
                : `EXPORT MASTER${format === "flac" ? " (FLAC)" : format.startsWith("mp3") ? " (MP3)" : ""}`}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy || (format === "video" && !videoSupported)}
              onClick={() => void exportMaster()}
            >
              {format === "video"
                ? "EXPORT VIDEO"
                : `EXPORT MASTER${format === "flac" ? " (FLAC)" : format.startsWith("mp3") ? " (MP3)" : ""}`}
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy || groups.length === 0}
              title="Grouped stems: drums / bass / music (solo is disabled in stems)"
              onClick={() => void exportStems()}
            >
              EXPORT STEMS ({groups.length})
            </button>
            <button type="button" className="btn btn-export" disabled={busy} onClick={() => void exportTracks()}>
              EXPORT ALL TRACKS ({tracks.length})
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy}
              title="Copy a link that opens this project in the full studio"
              onClick={() => void copyShareLink()}
            >
              COPY SHARE LINK
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy}
              title="Copy an iframe embed with a playable beat player"
              onClick={() => void copyEmbedCode()}
            >
              COPY EMBED CODE
            </button>
            <PublishToGalleryButton />
            {isMountedInEcosystem() && (
              <button
                type="button"
                className="btn btn-export"
                disabled={busy}
                title="Render this beat and hand it to Audio Canvas (SIQ) — its analysis and beat-reactive visuals run on your audio"
                onClick={() => void sendToQvesterVisualizer()}
              >
                ✦ SEND TO QVESTER VISUALIZER
              </button>
            )}
            <button
              type="button"
              className="btn btn-export btn-export-scorepack"
              disabled={busy}
              title="Export a .scorepack ZIP: master + stems + cues + JSON manifests"
              onClick={() => void exportScorepack()}
            >
              EXPORT SCOREPACK
            </button>
            <label
              className="export-policy"
              title="Track stems are rendered as time-aligned 32-bit-float WAVs to preserve headroom; long sessions can make the transfer large."
            >
              <input
                type="checkbox"
                checked={includeTrackStems}
                disabled={busy}
                onChange={(event) => setIncludeTrackStems(event.target.checked)}
              />
              INCLUDE TRACK STEMS
            </label>
            <button
              type="button"
              className="btn btn-export btn-export-scorepack"
              disabled={busy}
              title="Create a ZYVO transfer with a 48 kHz 32-bit-float master, optional aligned stems, arrangement metadata, and the original KYX project."
              onClick={() => void exportZyvoTransfer()}
            >
              EXPORT TO ZYVO
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy}
              title="Download the active pattern as a .mid file (drums on channel 10, one track per instrument)"
              onClick={() => void exportMidi()}
            >
              EXPORT MIDI (PATTERN)
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={busy}
              title="Download project as JSON file for backup or sharing"
              onClick={() => exportProject(doc)}
            >
              EXPORT JSON
            </button>
          </>
        )}
      </div>
      <div className={`export-status export-${status.kind}`}>
        <span aria-hidden="true">
          {status.kind === "idle" &&
            "Offline render uses the exact same engine, instruments and effects as playback — plus a 2 s tail for reverb/delay."}
          {status.kind !== "idle" && status.label}
          {status.kind === "cancelled" && <span className="export-cancel-reason"> · {status.reason}</span>}
          {reportStale && (
            <span className="export-policy-warning">
              STALE REPORT — project, sample bank or render settings changed; analyze again.
            </span>
          )}
        </span>
        {busy && (
          <button type="button" className="btn btn-small" onClick={cancelExport} aria-label="Cancel export">
            CANCEL
          </button>
        )}
      </div>
      <div
        className="sr-only"
        role={status.kind === "error" ? "alert" : "status"}
        aria-live={status.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {screenReaderExportStatus(status, reportStale)}
      </div>
      {((status.kind === "done" && (!masteringMode || masterReport)) ||
        (status.kind === "error" && masteringMode && masterReport)) && (
        <div className="master-render-measurement">
          {masteringMode && <strong>RENDER PCM · PRE-ENCODE</strong>}
          <ExportSummary
            summary={status.kind === "done" ? status.summary : (masterReport?.measurements ?? EMPTY_EXPORT_SUMMARY)}
            deliveryProfile={masterReport?.profile ?? resolveDeliveryTarget(master)}
            verdict={masterReport?.verdict}
          />
        </div>
      )}
      {masteringMode && masterReport && (status.kind === "done" || (status.kind === "error" && !reportStale)) && (
        <>
          <div className="master-render-report-meta" role="note" aria-label="Master render report details">
            <strong title={masterReport.runId}>
              REPORT V{masterReport.version} · {masterReport.measurementTap.position.toUpperCase()} · PRE-ENCODE
            </strong>
            <span>
              {masterReport.projectName} · {masterReport.scope === "song" ? "FULL SONG" : "PATTERN"} ·{" "}
              {masterReport.sampleRate} Hz · {masterReport.quality === "studio" ? "Studio HQ" : "Live"} ·{" "}
              {masterReport.durationSeconds.toFixed(1)} s · {masterReport.sampleRange.endFrame.toLocaleString()} samples
              · bank r{masterReport.sampleBankRevision}
            </span>
            <time dateTime={masterReport.createdAt}>{new Date(masterReport.createdAt).toLocaleString()}</time>
            <button
              type="button"
              className="btn btn-small"
              disabled={reportStale}
              onClick={downloadMasterReport}
              aria-label="Download mastering report JSON"
            >
              DOWNLOAD REPORT JSON
            </button>
          </div>
          {masterReport.encodedDelivery ? (
            <EncodedDeliveryCheck inspection={masterReport.encodedDelivery} deliveryProfile={masterReport.profile} />
          ) : status.kind === "error" ? (
            <div className="master-delivery-check" role="note">
              Integer delivery was refused. No encoded file was created or checked; the pre-encode render report is
              retained.
            </div>
          ) : (
            <div className="master-delivery-check" role="note">
              Analysis-only run. No WAV, FLAC or MP3 file was created or checked.
            </div>
          )}
        </>
      )}
      {status.kind === "done" && deliveredMixHealth && (
        <MixHealthLine health={deliveredMixHealth} stage={mixHealthStage} />
      )}
      {status.kind === "done" && deliveredMixHealth && !reportStale && <MixAutoFixButton health={deliveredMixHealth} />}
      {status.kind === "done" && (!masteringMode || masterReport) && !reportStale && (
        <AutoStageButton summary={deliveredMeasurements ?? status.summary} />
      )}

      {!masteringMode && (
        <div className="export-resample" role="group" aria-label="Realtime resample">
          <div className="export-resample-head">RESAMPLE — BOUNCE WHAT YOU HEAR</div>
          <div className="export-resample-row">
            <select
              aria-label="Recording source"
              value={recSource}
              disabled={recState !== "idle"}
              onChange={(event) => setRecSource(event.target.value as RecSourceKind)}
            >
              <option value="master">MASTER (with FX)</option>
              {selectedTrackId && (
                <option value="track">TRACK: {(selectedTrackName ?? selectedTrackId).toUpperCase()}</option>
              )}
              <option value="mic">MIC / LINE IN</option>
            </select>
            {recState === "recording" ? (
              <button type="button" className="btn btn-rec btn-rec-stop" onClick={() => void stopRecording()}>
                ■ STOP {recSeconds.toFixed(0)}s
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-rec"
                disabled={recState === "saving" || recState === "starting"}
                onClick={() => void startRecording()}
              >
                {recState === "starting" ? "…" : "● REC"}
              </button>
            )}
            {recState === "saving" && <span className="export-resample-saving">saving…</span>}
          </div>
          {recError && <div className="export-resample-error">{recError}</div>}
          {lastTake && recState !== "recording" && (
            <div className="export-resample-row">
              <button
                type="button"
                className="btn btn-rec"
                disabled={chopping}
                title="Detect onsets in the last take and chop zero-cross-snapped slices to drum pads + pattern (one undoable step)"
                onClick={() => void autoChop()}
              >
                {chopping ? "CHOPPING…" : `AUTO-CHOP "${lastTake.name.toUpperCase()}" → PADS`}
              </button>
            </div>
          )}
          {chopNote && (
            <div className="export-resample-hint" role="status">
              {chopNote}
            </div>
          )}
          <div className="export-resample-hint">
            Realtime capture through the full live chain. The take lands in Samples — click it to flip onto a pad.
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * MIX CHECK line (library-gate wave): the mix-doctor verdict for the last
 * master render — one compact line, pass or the flag list. Advisory
 * (yellow) flags render as ○ notes, failures (red) as ⚠.
 */
function EncodedDeliveryCheck({
  inspection,
  deliveryProfile,
}: {
  inspection: EncodedMasterInspection;
  deliveryProfile: MasterProfile;
}) {
  const { file, decode } = inspection;
  const sizeMb = (inspection.byteLength / 1024 / 1024).toFixed(1);
  const wavEncoding = file.bitDepth === 32 ? "float" : "PCM";
  const formatLabel =
    inspection.format === "wav"
      ? `WAV · ${file.bitDepth}-bit ${wavEncoding}`
      : inspection.format === "flac"
        ? `FLAC · ${file.bitDepth ?? "?"}-bit PCM`
        : `MP3 · ${file.averageBitrateKbps?.toFixed(0) ?? "?"} kbps avg`;
  const channelsLabel = file.channels === 1 ? "mono" : `${file.channels} channels`;
  const bextLabel = file.bext ? `BWF v${file.bext.version}` : "no BWF metadata";
  const bextLoudness = file.bext?.loudness;
  const durationLabel = `${file.durationSeconds.toFixed(2)} s${file.durationAccuracy === "estimated" ? " estimated" : ""}`;
  const formatBwfField = (value: number | null, unit: string) =>
    value == null ? `N/A ${unit}` : `${value.toFixed(2)} ${unit}`;

  return (
    <section className="master-delivery-check" aria-label="Encoded master file check">
      <div className="master-delivery-check-head">
        <strong>FINAL FILE · {decode.status === "measured" ? "DECODED + MEASURED" : "HEADER CHECKED"}</strong>
        <span>{(inspection.byteLength / 1024).toFixed(0)} KiB</span>
      </div>
      <p>
        {formatLabel} · {file.sampleRate.toLocaleString()} Hz · {channelsLabel} · {durationLabel} · {sizeMb} MiB
        {inspection.format === "wav" ? ` · ${bextLabel}` : ""}
      </p>
      <MasteringFingerprint fingerprint={inspection.fingerprint} />
      {file.bext?.description && <p className="master-delivery-metadata">BWF description: {file.bext.description}</p>}
      {bextLoudness && (
        <p className="master-delivery-metadata">
          BWF v2 source PCM · I {formatBwfField(bextLoudness.integratedLufs, "LUFS")} · LRA{" "}
          {formatBwfField(bextLoudness.rangeLu, "LU")} · max TP {formatBwfField(bextLoudness.truePeakDbtp, "dBTP")} · M{" "}
          {formatBwfField(bextLoudness.momentaryLufs, "LUFS")} · S {formatBwfField(bextLoudness.shortTermLufs, "LUFS")}
        </p>
      )}
      {decode.status === "measured" && decode.measurements ? (
        <div className="master-delivery-decoded">
          <span>
            POST-DECODE · {decode.sampleRate?.toLocaleString()} Hz · {decode.channels} channels ·{" "}
            {decode.durationSeconds?.toFixed(2)} s · {decode.decoder}
          </span>
          <ExportSummary summary={decode.measurements} deliveryProfile={deliveryProfile} verdict={decode.verdict} />
        </div>
      ) : (
        <p className="master-delivery-not-measured" role="status">
          Post-encode audio measurements not available: {decode.reason ?? "decoder result unavailable"}
        </p>
      )}
      {decode.warnings.length > 0 && (
        <ul className="master-delivery-warnings" aria-label="File check warnings">
          {decode.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MixHealthLine({ health, stage }: { health: MixHealthReport; stage: "PRE-ENCODE" | "POST-DECODE" }) {
  const red = health.flags.filter((f) => f.severity === "red");
  const yellow = health.flags.filter((f) => f.severity === "yellow");
  const measured = health.integratedLufs !== null;
  const stats = `low ${(health.lowEndShare * 100).toFixed(0)}% · crest ${health.crestDb.toFixed(1)} dB · peak −${health.headroomDb.toFixed(1)} dBFS`;
  const notes = [...red, ...yellow]
    .map((f) => `${f.severity === "red" ? "⚠" : "○"} ${f.check}: ${f.detail}`)
    .join(" · ");
  return (
    <div className="export-resample-hint" role="status">
      {!measured
        ? `MIX CHECK · ${stage} NOT MEASURED — `
        : red.length === 0
          ? `MIX CHECK · ${stage} PASS — `
          : `MIX CHECK · ${stage} — ${red.length} ISSUE${red.length > 1 ? "S" : ""} — `}
      {stats}
      {notes && ` — ${notes}`}
    </div>
  );
}

/**
 * MIX-DOCTOR AUTO FIX (mix-doctor auto-fix wave): a one-click, one-undo
 * correction for the two mechanically-safe problems the doctor flags —
 * low-end dominance (dark tilt) and clipping (master IN). Everything else
 * stays report-only. Hidden when the derivation has nothing to offer.
 */
function MixAutoFixButton({ health }: { health: MixHealthReport }) {
  const services = useServices();
  const [applied, setApplied] = useState<string | null>(null);
  const fix = deriveMixAutoFix(health);
  if (!fix) return null;
  return (
    <button
      type="button"
      className="btn btn-export"
      disabled={applied !== null}
      title="Apply the mix-doctor fix as one undoable step (tilt + master IN) — re-export to verify"
      onClick={() => {
        services.store.execute(
          setMasterConfig(services.store.getDoc(), {
            ...(fix.tiltDb !== 0 ? { tiltDb: -fix.tiltDb } : {}),
            ...(fix.masterGain !== 1 ? { masterGain: fix.masterGain } : {}),
          }),
        );
        setApplied(fix.label);
      }}
    >
      {applied !== null ? `MIX FIX STAGED ✓ ${applied} — re-export to verify` : `MIX FIX (${fix.label})`}
    </button>
  );
}

/**
 * One-click export gain staging. Applies the verdict's advice (master IN so
 * the true peak lands at ceiling − 1 dBTP while honoring the streaming
 * target) as a single undoable command — the ceiling stays untouched.
 * Hidden when the last render is already staged (or silent/muted).
 */
function AutoStageButton({ summary }: { summary: BufferSummary }) {
  const services = useServices();
  const master = useMaster();
  const [staged, setStaged] = useState(false);
  const deliveryProfile = resolveDeliveryTarget(master);
  const adj = computeStageAdjustment(
    summary,
    master.masterGain ?? 1,
    deliveryProfile.targetLufs,
    deliveryProfile.maxTruePeakDb,
  );
  if (adj.noop) return null;
  return (
    <button
      type="button"
      className="btn btn-export"
      disabled={staged}
      title="Apply the gain verdict as one undoable step (master IN only — re-export to verify)"
      onClick={() => {
        services.store.execute(setMasterConfig(services.store.getDoc(), { masterGain: adj.masterGain }));
        setStaged(true);
      }}
    >
      {staged
        ? `STAGED ✓ ${adj.applied[0]} — re-export to verify`
        : `AUTO STAGE (${adj.deltaDb >= 0 ? "+" : ""}${adj.deltaDb.toFixed(1)} dB)`}
    </button>
  );
}

function ExportSummary({
  summary,
  deliveryProfile,
  verdict: measuredVerdict,
}: {
  summary: BufferSummary;
  deliveryProfile: MasterProfile;
  verdict?: MasterVerdict;
}) {
  const corr = summary.correlation;
  const stereoMeasured = summary.channelCount >= 2 && summary.lufsIntegrated > -119;
  const corrLabel = !stereoMeasured ? "N/A" : corr > 0.5 ? "Mono OK" : corr < 0 ? "Phase" : "Wide";
  const clipped = summary.peakDb > -0.3 || summary.truePeakDb > -0.3;
  // Mono-loss guardian: same thresholds as the live mix-check verdict, so
  // the export summary never disagrees with the master meter wall.
  const monoGuard = evaluateExportMonoGuard(summary);
  // Gain-staging verdict: the same print-ready verdict the live master
  // meter shows (loudness vs streaming target, true peak vs limiter
  // ceiling, mono, balance) — the export tells you what to turn.
  const verdict =
    measuredVerdict ??
    evaluateMasterVerdict(
      {
        lufsIntegrated: summary.lufsIntegrated,
        truePeakDb: summary.truePeakDb,
        monoLossDb: stereoMeasured ? summary.monoLossDb : null,
        correlation: stereoMeasured ? summary.correlation : null,
        lrImbalanceDb: stereoMeasured ? summary.lrImbalanceDb : null,
      },
      deliveryProfile.targetLufs,
      deliveryProfile.maxTruePeakDb,
      deliveryProfile.label.toUpperCase(),
      deliveryProfile,
    );
  return (
    <div className="export-summary" aria-label="Export summary">
      <div className="export-summary-row">
        <span className="export-summary-label">PEAK</span>
        <span className="export-summary-value">{summary.peakDb.toFixed(1)} dBFS</span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">TRUE PEAK</span>
        <span className={`export-summary-value${clipped ? " export-summary-clipped" : ""}`}>
          {summary.truePeakDb.toFixed(1)} dBTP
          {clipped && " ⚠"}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">RMS</span>
        <span className="export-summary-value">{summary.rmsDb.toFixed(1)} dBFS</span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">×CORR</span>
        <span className="export-summary-value">
          {stereoMeasured ? `${corr.toFixed(2)} ${corrLabel}` : "N/A · mono or silence"}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">L/R Δ RMS</span>
        <span className="export-summary-value">
          {!stereoMeasured || summary.lrImbalanceDb === null
            ? "N/A · mono or silence"
            : `${summary.lrImbalanceDb.toFixed(1)} dB`}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">LUFS-I</span>
        <span className="export-summary-value">
          {summary.lufsIntegrated <= -119 ? "-INF" : summary.lufsIntegrated.toFixed(1)}
        </span>
      </div>
      {summary.loudnessRangeLu !== undefined && (
        <div
          className="export-summary-row"
          title="EBU Tech 3342 Loudness Range uses gated 3-second loudness windows. It describes programme dynamics; it is not a delivery target."
        >
          <span className="export-summary-label">LRA</span>
          <span className="export-summary-value">
            {summary.loudnessRangeLu == null
              ? "NOT MEASURED · short or silent programme"
              : `${summary.loudnessRangeLu.toFixed(1)} LU`}
          </span>
        </div>
      )}
      <div className="export-summary-row">
        <span className="export-summary-label">MONO LOSS</span>
        <span className={`export-summary-value${monoGuard.level !== "ok" ? " export-summary-clipped" : ""}`}>
          {stereoMeasured ? `${summary.monoLossDb.toFixed(1)} dB` : "N/A · mono or silence"}
          {monoGuard.level !== "ok" && " ⚠"}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">GAIN VERDICT</span>
        <span className="export-summary-value" data-level={verdict.level}>
          {verdict.headline}
          {verdict.loudnessDeltaDb !== 0 && ` (Δ ${verdict.loudnessDeltaDb.toFixed(1)} dB)`}
        </span>
      </div>
      {verdict.hints.length > 0 && (
        <div className="export-summary-row">
          <span className="export-summary-label">FIX IT</span>
          {verdict.hints.map((hint) => (
            <span key={hint} className="export-summary-value">
              {hint}
            </span>
          ))}
        </div>
      )}
      {verdict.checks.some((check) => check.status === "not-measured") && (
        <div className="export-summary-row" role="note">
          <span className="export-summary-label">NOT MEASURED</span>
          {verdict.checks
            .filter((check) => check.status === "not-measured")
            .map((check) => (
              <span key={check.line} className="export-summary-value">
                {check.line}
              </span>
            ))}
        </div>
      )}
      {monoGuard.level !== "ok" && (
        <div className="export-summary-guard" role="alert" data-level={monoGuard.level}>
          <span className="export-summary-label">MONO GUARD</span>
          {monoGuard.hints.map((hint) => (
            <span key={hint} className="export-summary-value">
              {hint}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
