import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { formatAuditionTrim, getLoudnessMatchGain } from "../mastering/audition";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import { acquireMasteringWork, tryAcquireMasteringWork } from "../mastering/workGate";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import {
  inspectMasteringReferenceContainer,
  masteringReferenceFormatFromFileName,
  type EncodedMasterFileDetails,
  type MasteringReferenceFormat,
} from "../mastering/encodedInspection";
import { CUSTOM_PROFILE, resolveDeliveryTarget } from "../mastering/profiles";
import { MasteringReferenceRepository, type MasteringReferenceRecord } from "../mastering/referenceRepository";
import { projectRevisionIdFor } from "../mastering/report";
import { decodeAudioData } from "../services/audio-decode";
import { decodeFlacAudioBuffer, estimateFlacDecoderWorkingSetBytes } from "../mastering/flacDecode";
import { estimateRenderPcmBytes, renderProject } from "../rendering/renderer";
import type { ProjectDocument } from "../project-model/types";
import { useServices } from "./context";
import { useMasteringExcerptLoudness } from "./useMasteringExcerptLoudness";

interface LoadedReference {
  record: MasteringReferenceRecord;
  buffer: AudioBuffer;
  summary: BufferSummary;
  details: EncodedMasterFileDetails;
}

interface RenderedProjectMaster {
  revisionId: string;
  sampleBankRevision: number;
  sampleRate: number;
  buffer: AudioBuffer;
  summary: BufferSummary;
}

const MAX_REFERENCE_FILE_BYTES = 96 * 1024 * 1024;
const MAX_REFERENCE_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_COMPARE_PCM_BYTES = 320 * 1024 * 1024;
const DECODE_SAMPLE_RATE = 44100;
const MAX_REFERENCE_SECONDS = 12 * 60;
const AUDIO_FILE_EXTENSION = /\.(wav|wave|mp3|flac)$/i;

function assertReferenceMetadata(format: MasteringReferenceFormat, details: EncodedMasterFileDetails): void {
  if (details.channels !== 1 && details.channels !== 2) {
    throw new Error(`Reference audio must be mono or stereo; this file has ${details.channels} channels.`);
  }
  if (details.sampleRate < 8000 || details.sampleRate > 192000) {
    throw new Error(`Reference sample rate ${details.sampleRate} Hz is outside the supported 8–192 kHz range.`);
  }
  if (!Number.isFinite(details.durationSeconds) || details.durationSeconds <= 0) {
    throw new Error("The reference file has no measurable audio duration.");
  }
  if (details.durationSeconds > MAX_REFERENCE_SECONDS) {
    throw new Error("Reference audio is longer than 12 minutes. Shorten it before importing.");
  }
  const decodedSampleRate = format === "flac" ? details.sampleRate : DECODE_SAMPLE_RATE;
  const decodedBytes = Math.ceil(details.durationSeconds * decodedSampleRate) * details.channels * 4;
  if (decodedBytes > MAX_REFERENCE_BUFFER_BYTES) {
    throw new Error("The decoded reference would exceed the 128 MiB memory limit. Use a shorter excerpt.");
  }
}

async function decodeReferenceBytes(
  record: MasteringReferenceRecord,
  bytes: ArrayBuffer,
  profile: ReturnType<typeof resolveDeliveryTarget>,
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: string) => void,
  additionalWorkingSetBytes = 0,
): Promise<LoadedReference> {
  if (
    record.byteLength <= 0 ||
    record.byteLength > MAX_REFERENCE_FILE_BYTES ||
    record.source.size !== record.byteLength ||
    bytes.byteLength !== record.byteLength
  ) {
    throw new Error("The reference file is empty or exceeds the 96 MiB import limit.");
  }
  const format = masteringReferenceFormatFromFileName(record.fileName);
  const details = inspectMasteringReferenceContainer(format, bytes);
  assertReferenceMetadata(format, details);
  if (format === "flac") {
    const pcmBytes = Math.ceil(details.durationSeconds * details.sampleRate) * details.channels * 4;
    const decodeWorkingSetBytes = estimateFlacDecoderWorkingSetBytes(bytes.byteLength, pcmBytes);
    if (decodeWorkingSetBytes + additionalWorkingSetBytes > MAX_COMPARE_PCM_BYTES) {
      throw new Error(
        "The FLAC reference and current comparison audio exceed the 320 MiB working-memory limit. Use a shorter excerpt.",
      );
    }
  }
  let buffer: AudioBuffer;
  try {
    buffer =
      format === "flac"
        ? await decodeFlacAudioBuffer(bytes, details, { maxPcmBytes: MAX_REFERENCE_BUFFER_BYTES, signal })
        : await decodeAudioData(bytes.slice(0), DECODE_SAMPLE_RATE);
  } catch (reason) {
    if (signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) throw reason;
    if (format === "flac") {
      throw new Error(
        `The FLAC decoder could not read this reference: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    throw new Error("The browser could not decode this reference. Check the file or try another WAV/MP3 export.");
  }
  if (buffer.length <= 0 || (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2)) {
    throw new Error("The decoded reference has no audio or has an unsupported channel count.");
  }
  if (buffer.numberOfChannels !== details.channels) {
    throw new Error("The decoded channel count does not match the reference file header.");
  }
  const actualBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (actualBytes > MAX_REFERENCE_BUFFER_BYTES || buffer.duration > MAX_REFERENCE_SECONDS) {
    throw new Error("The decoded reference exceeds the browser memory or duration limit. Use a shorter excerpt.");
  }
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame++) {
      if (!Number.isFinite(samples[frame]))
        throw new Error("The decoded reference contains a non-finite audio sample.");
    }
  }
  const analysis = await analyzeMasterBufferAsync(buffer, profile, {
    signal,
    onProgress: (update) => onProgress?.(update.progress, update.stage),
  });
  return { record, buffer, summary: analysis.measurements, details };
}

async function decodeReference(
  record: MasteringReferenceRecord,
  profile: ReturnType<typeof resolveDeliveryTarget>,
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: string) => void,
  additionalWorkingSetBytes = 0,
): Promise<LoadedReference> {
  if (
    record.byteLength <= 0 ||
    record.byteLength > MAX_REFERENCE_FILE_BYTES ||
    record.source.size !== record.byteLength
  ) {
    throw new Error("The saved reference file is empty or exceeds the 96 MiB import limit.");
  }
  return decodeReferenceBytes(
    record,
    await record.source.arrayBuffer(),
    profile,
    signal,
    onProgress,
    additionalWorkingSetBytes,
  );
}

function bufferBytes(buffer: AudioBuffer | null): number {
  return buffer ? buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT : 0;
}

function formatDb(value: number, suffix: string): string {
  return Number.isFinite(value) && value > -120 ? `${value.toFixed(1)} ${suffix}` : `−∞ ${suffix}`;
}

function previewTrim(lufsIntegrated: number | null, target: number | null, enabled: boolean): number {
  return getLoudnessMatchGain(lufsIntegrated, target, enabled);
}

export function MasteringReferenceCompare({
  doc,
  revisionId,
  sampleBankRevision,
  sampleRate,
  levelMatch,
  abRenderEpoch,
  blockNewWork,
  onBeforeRender,
  onBusyChange,
  onReferenceBytes,
  assistantBytes,
  comparisonBytes,
  onProjectMasterBytes,
}: {
  doc: ProjectDocument;
  revisionId: string;
  sampleBankRevision: number;
  sampleRate: number;
  levelMatch: boolean;
  abRenderEpoch: number;
  blockNewWork: boolean;
  onBeforeRender(): void;
  onBusyChange(busy: boolean, excerptPending: boolean): void;
  onReferenceBytes(bytes: number): void;
  assistantBytes: number;
  comparisonBytes: number;
  onProjectMasterBytes(bytes: number): void;
}) {
  const services = useServices();
  const repository = useMemo(() => new MasteringReferenceRepository(), []);
  const [reference, setReference] = useState<LoadedReference | null>(null);
  const [projectMaster, setProjectMaster] = useState<RenderedProjectMaster | null>(null);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [playing, setPlaying] = useState<"project" | "reference" | null>(null);
  const [mono, setMono] = useState(false);
  const [dimDb, setDimDb] = useState(-6);
  const [projectOffset, setProjectOffset] = useState(0);
  const [referenceOffset, setReferenceOffset] = useState(0);
  const decodeJobRef = useRef(0);
  const decodeAbortRef = useRef<AbortController | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const projectMasterPcmBytes = bufferBytes(projectMaster?.buffer ?? null);
  const residentWorkingSetBytesRef = useRef(0);
  residentWorkingSetBytesRef.current =
    assistantBytes + comparisonBytes + projectMasterPcmBytes + bufferBytes(reference?.buffer ?? null);

  useEffect(() => {
    onProjectMasterBytes(projectMasterPcmBytes);
  }, [onProjectMasterBytes, projectMasterPcmBytes]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      decodeJobRef.current++;
      decodeAbortRef.current?.abort();
      renderAbortRef.current?.abort();
      if (playingRef.current) services.engine.stopPreview();
      onBusyChange(false, false);
    };
  }, [onBusyChange, services.engine]);

  useEffect(() => {
    const projectId = doc.id;
    const job = ++decodeJobRef.current;
    decodeAbortRef.current?.abort();
    const controller = new AbortController();
    decodeAbortRef.current = controller;
    renderAbortRef.current?.abort();
    setReference(null);
    setProjectMaster(null);
    setError("");
    setStorageMessage("");
    setLoading(true);
    setStatus("Checking local reference…");
    let releaseMasteringWork: (() => void) | null = null;
    void repository
      .get(projectId)
      .then(async (record) => {
        if (!aliveRef.current || decodeJobRef.current !== job) return;
        if (!record) {
          setStatus("No reference saved for this project.");
          return;
        }
        setStatus("Waiting for the MASTER workspace to become available…");
        releaseMasteringWork = await acquireMasteringWork(controller.signal);
        if (!releaseMasteringWork) return;
        setStatus("Decoding saved reference…");
        const decoded = await decodeReference(
          record,
          CUSTOM_PROFILE,
          controller.signal,
          (progress, stage) => {
            if (aliveRef.current && decodeJobRef.current === job)
              setStatus(`Measuring saved reference… ${Math.round(progress * 100)}% · ${stage}`);
          },
          residentWorkingSetBytesRef.current,
        );
        if (!aliveRef.current || decodeJobRef.current !== job) return;
        setReference(decoded);
        setStatus("Local reference ready.");
      })
      .catch((caught: unknown) => {
        if (!aliveRef.current || decodeJobRef.current !== job) return;
        setError(caught instanceof Error ? caught.message : "Could not load the saved reference.");
        setStatus("");
      })
      .finally(() => {
        releaseMasteringWork?.();
        if (aliveRef.current && decodeJobRef.current === job) setLoading(false);
      });
    return () => {
      if (decodeJobRef.current === job) decodeJobRef.current++;
      controller.abort();
      if (decodeAbortRef.current === controller) decodeAbortRef.current = null;
    };
  }, [doc.id, repository]);

  useEffect(() => {
    renderAbortRef.current?.abort();
    if (playingRef.current) {
      services.engine.stopPreview();
      setPlaying(null);
    }
    setProjectMaster(null);
    setProjectOffset(0);
    setReferenceOffset(0);
  }, [doc.id, revisionId, sampleRate, abRenderEpoch, services.engine]);

  useEffect(() => {
    if (!projectMaster || projectMaster.sampleBankRevision === sampleBankRevision) return;
    renderAbortRef.current?.abort();
    if (playingRef.current) {
      services.engine.stopPreview();
      setPlaying(null);
    }
    setProjectMaster(null);
    setProjectOffset(0);
    setStatus("Sample bank changed. Render the current master again for a fresh reference comparison.");
  }, [projectMaster, sampleBankRevision, services.engine]);

  useEffect(() => {
    onReferenceBytes(bufferBytes(reference?.buffer ?? null));
  }, [reference, onReferenceBytes]);

  const currentProjectMaster =
    projectMaster?.revisionId === revisionId &&
    projectMaster.sampleBankRevision === sampleBankRevision &&
    projectMaster.sampleRate === sampleRate;
  const renderProjectMax = currentProjectMaster && projectMaster ? projectMaster.buffer.duration : 0;
  const renderReferenceMax = reference?.buffer.duration ?? 0;
  const compareExcerptDuration = Math.max(
    0,
    Math.min(renderProjectMax - projectOffset, renderReferenceMax - referenceOffset),
  );
  const comparePairReady = Boolean(currentProjectMaster && projectMaster && reference);
  const excerptLoudness = useMasteringExcerptLoudness({
    enabled: levelMatch && comparePairReady,
    projectBuffer: projectMaster?.buffer ?? null,
    projectSummary: projectMaster?.summary ?? null,
    referenceBuffer: reference?.buffer ?? null,
    referenceSummary: reference?.summary ?? null,
    projectOffset,
    referenceOffset,
    durationSeconds: compareExcerptDuration,
  });
  const currentExcerptLoudness = excerptLoudness.current;
  const excerptLoudnessPending = excerptLoudness.pending;
  const targetLufs = excerptLoudness.targetLufs;
  useEffect(() => {
    onBusyChange(loading || rendering, excerptLoudnessPending);
  }, [excerptLoudnessPending, loading, onBusyChange, rendering]);
  const projectAuditionLufs =
    levelMatch && comparePairReady
      ? (currentExcerptLoudness?.projectLufs ?? null)
      : (projectMaster?.summary.lufsIntegrated ?? null);
  const referenceAuditionLufs =
    levelMatch && comparePairReady
      ? (currentExcerptLoudness?.referenceLufs ?? null)
      : (reference?.summary.lufsIntegrated ?? null);
  const dimGain = Math.pow(10, dimDb / 20);
  const projectGain =
    currentProjectMaster && projectMaster
      ? previewTrim(projectAuditionLufs, targetLufs, levelMatch) * dimGain
      : dimGain;
  const referenceGain = reference ? previewTrim(referenceAuditionLufs, targetLufs, levelMatch) * dimGain : dimGain;
  const auditionTrimLabel = !levelMatch
    ? "off"
    : !currentExcerptLoudness ||
        currentExcerptLoudness.status === "measuring" ||
        currentExcerptLoudness.status === "waiting"
      ? currentExcerptLoudness?.status === "waiting"
        ? "waiting for another MASTER audio task…"
        : "measuring selected excerpt…"
      : currentExcerptLoudness.status === "unavailable"
        ? `unavailable; using native levels${currentExcerptLoudness.reason ? ` · ${currentExcerptLoudness.reason.slice(0, 120)}` : ""}`
        : targetLufs === null
          ? "not matched; selected excerpt is too short or too quiet to measure"
          : `selected excerpt — project ${formatAuditionTrim(previewTrim(currentExcerptLoudness.projectLufs, targetLufs, true))}; reference ${formatAuditionTrim(previewTrim(currentExcerptLoudness.referenceLufs, targetLufs, true))}`;

  useEffect(() => {
    if (!excerptLoudnessPending || !playingRef.current) return;
    services.engine.stopPreview();
    setPlaying(null);
  }, [excerptLoudnessPending, services.engine]);

  useEffect(() => {
    if (!playing) return;
    if (comparePairReady) services.engine.updateMasterComparePair(projectGain, referenceGain, playing, mono);
    else if (playing === "reference") services.engine.updateMasterComparePreview(referenceGain, mono);
  }, [comparePairReady, mono, playing, projectGain, referenceGain, services.engine]);

  const importFile = async (file: File) => {
    const projectId = doc.id;
    const job = ++decodeJobRef.current;
    decodeAbortRef.current?.abort();
    const controller = new AbortController();
    decodeAbortRef.current = controller;
    renderAbortRef.current?.abort();
    setError("");
    setStorageMessage("");
    if (!AUDIO_FILE_EXTENSION.test(file.name)) {
      setError("Choose a WAV, MP3 or FLAC reference audio file.");
      return;
    }
    if (file.size === 0 || file.size > MAX_REFERENCE_FILE_BYTES) {
      setError(
        `Reference files must be between 1 byte and 96 MiB; this file is ${(file.size / 1024 / 1024).toFixed(1)} MiB.`,
      );
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setError("Another MASTER audio task is in progress. Try importing this reference again when it finishes.");
      return;
    }
    services.engine.stopPreview();
    setPlaying(null);
    setLoading(true);
    setStatus("Validating and decoding reference…");
    try {
      const bytes = await file.arrayBuffer();
      if (!aliveRef.current || decodeJobRef.current !== job) return;
      const format = masteringReferenceFormatFromFileName(file.name);
      const mimeType = format === "wav" ? "audio/wav" : format === "mp3" ? "audio/mpeg" : "audio/flac";
      const record: MasteringReferenceRecord = {
        projectId,
        fileName: file.name,
        mimeType: file.type || mimeType,
        byteLength: bytes.byteLength,
        importedAt: new Date().toISOString(),
        source: file.slice(0, file.size, file.type || mimeType),
      };
      const decoded = await decodeReferenceBytes(
        record,
        bytes,
        CUSTOM_PROFILE,
        controller.signal,
        (progress, stage) => {
          if (aliveRef.current && decodeJobRef.current === job)
            setStatus(`Measuring reference… ${Math.round(progress * 100)}% · ${stage}`);
        },
        assistantBytes + comparisonBytes + projectMasterPcmBytes + bufferBytes(reference?.buffer ?? null),
      );
      if (
        !aliveRef.current ||
        decodeJobRef.current !== job ||
        controller.signal.aborted ||
        services.store.getDoc().id !== projectId
      )
        return;
      let saved = false;
      try {
        await repository.put(record);
        saved = true;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "browser storage failed";
        setStorageMessage(`Reference is ready in this tab, but local saving failed: ${message}`);
      }
      if (!aliveRef.current || decodeJobRef.current !== job || controller.signal.aborted) return;
      setReference(decoded);
      setProjectMaster(null);
      setProjectOffset(0);
      setReferenceOffset(0);
      setStatus(
        saved ? "Reference imported and saved locally for this project." : "Reference imported for this tab only.",
      );
    } catch (caught) {
      if (!aliveRef.current || decodeJobRef.current !== job) return;
      setError(caught instanceof Error ? caught.message : "Could not import this reference.");
      setStatus("");
    } finally {
      if (decodeAbortRef.current === controller) decodeAbortRef.current = null;
      if (aliveRef.current && decodeJobRef.current === job) setLoading(false);
      releaseMasteringWork();
    }
  };

  const renderProjectMaster = async () => {
    if (rendering || blockNewWork) return;
    const startRevision = projectRevisionIdFor(services.store.getDoc());
    if (services.store.getDoc().id !== doc.id || startRevision !== revisionId) {
      setError("The project changed. Wait for the MASTER panel to update, then render again.");
      return;
    }
    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      setError("Another MASTER audio task is in progress. Try the reference render again when it finishes.");
      return;
    }
    onBeforeRender();
    services.engine.stopPreview();
    setPlaying(null);
    setProjectMaster(null);
    setError("");
    setStorageMessage("");
    setStatus("Preparing sample audio for a consistent reference comparison…");
    setRendering(true);
    const controller = new AbortController();
    renderAbortRef.current = controller;
    let sampleBankRevisionAtStart = services.bank.revision;
    try {
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      sampleBankRevisionAtStart = services.bank.revision;
      const latestBeforeRender = services.store.getDoc();
      if (latestBeforeRender.id !== doc.id || projectRevisionIdFor(latestBeforeRender) !== startRevision) {
        throw new Error("The project changed while sample audio was loading. Start the comparison again.");
      }
      setStatus("Rendering current project master · SONG · Studio HQ…");
      const outputBytes = estimateRenderPcmBytes(doc, { mode: "song", sampleRate });
      const pairBytes =
        outputBytes + bufferBytes(reference?.buffer ?? null) + assistantBytes + comparisonBytes + projectMasterPcmBytes;
      if (pairBytes > MAX_COMPARE_PCM_BYTES) {
        throw new Error(
          "The project render and reference exceed the 320 MiB comparison memory limit. Use a shorter render.",
        );
      }
      const buffer = await renderProject(doc, services.bank, {
        mode: "song",
        sampleRate,
        quality: "studio",
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException("Reference comparison cancelled", "AbortError");
      const current = services.store.getDoc();
      if (current.id !== doc.id || projectRevisionIdFor(current) !== startRevision) {
        throw new Error("The project changed during the render. The stale comparison was discarded.");
      }
      if (services.bank.revision !== sampleBankRevisionAtStart) {
        throw new Error("The sample bank changed during the render. The stale comparison was discarded.");
      }
      const actualPairBytes =
        bufferBytes(buffer) +
        bufferBytes(reference?.buffer ?? null) +
        assistantBytes +
        comparisonBytes +
        projectMasterPcmBytes;
      if (actualPairBytes > MAX_COMPARE_PCM_BYTES) {
        throw new Error("Rendered audio exceeds the 320 MiB comparison memory limit. Use a shorter render.");
      }
      setStatus("Analyzing project master…");
      const analysis = await analyzeMasterBufferAsync(buffer, resolveDeliveryTarget(doc.master), {
        signal: controller.signal,
        onProgress: ({ progress, stage }) =>
          setStatus(`Analyzing project master… ${Math.round(progress * 100)}% · ${stage}`),
      });
      if (controller.signal.aborted) throw new DOMException("Reference comparison cancelled", "AbortError");
      const latest = services.store.getDoc();
      if (latest.id !== doc.id || projectRevisionIdFor(latest) !== startRevision) {
        throw new Error("The project changed during analysis. The stale comparison was discarded.");
      }
      if (services.bank.revision !== sampleBankRevisionAtStart) {
        throw new Error("The sample bank changed during analysis. The stale comparison was discarded.");
      }
      const summary = analysis.measurements;
      setProjectMaster({
        revisionId: startRevision,
        sampleBankRevision: sampleBankRevisionAtStart,
        sampleRate,
        buffer,
        summary,
      });
      setStatus("Project master ready. Project and reference playback start at their selected comparison points.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled")) setStatus("Project master render cancelled.");
      else setError(message);
    } finally {
      if (renderAbortRef.current === controller) renderAbortRef.current = null;
      setRendering(false);
      releaseMasteringWork();
    }
  };

  const play = (source: "project" | "reference") => {
    if (excerptLoudnessPending) return;
    if (source === "project" && (!currentProjectMaster || !projectMaster)) return;
    if (source === "reference" && !reference) return;
    setError("");
    if (playing && comparePairReady) {
      services.engine.selectMasterComparePairSide(source);
      setPlaying(source);
      return;
    }
    const onPreviewEnded = () => {
      if (aliveRef.current) setPlaying(null);
    };
    services.engine.stopPreview();
    if (comparePairReady && projectMaster && reference) {
      const started = services.engine.previewMasterComparePair(
        projectMaster.buffer,
        reference.buffer,
        projectGain,
        referenceGain,
        source,
        projectOffset,
        referenceOffset,
        mono,
        onPreviewEnded,
      );
      if (!started) {
        setPlaying(null);
        setError("Choose a start point with at least 10 ms remaining on both sides.");
        return;
      }
    } else if (source === "reference" && reference) {
      services.engine.previewMasterCompare(reference.buffer, referenceGain, onPreviewEnded, referenceOffset, mono);
    } else if (source === "project" && projectMaster) {
      services.engine.previewMasterCompare(projectMaster.buffer, projectGain, onPreviewEnded, projectOffset, mono);
    }
    setPlaying(source);
  };

  const removeReference = async () => {
    if (!reference) return;
    setError("");
    setStatus("Removing local reference…");
    services.engine.stopPreview();
    setPlaying(null);
    try {
      await repository.delete(doc.id);
      setReference(null);
      setProjectMaster(null);
      setStatus("Local reference removed. The source project and exports were not changed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the local reference.");
      setStatus("");
    }
  };

  const stop = () => {
    services.engine.stopPreview();
    setPlaying(null);
  };

  const updateOffset = (side: "project" | "reference", nextOffset: number) => {
    if (playing) stop();
    const maximum = side === "project" ? renderProjectMax : renderReferenceMax;
    const finiteOffset = Number.isFinite(nextOffset) ? nextOffset : 0;
    const boundedOffset = Math.max(0, Math.min(maximum, finiteOffset));
    const offset = Math.min(maximum, Math.round(boundedOffset * 1000) / 1000);
    if (side === "project") setProjectOffset(offset);
    else setReferenceOffset(offset);
  };
  const nudgeOffset = (side: "project" | "reference", deltaSeconds: number) => {
    const currentOffset = side === "project" ? projectOffset : referenceOffset;
    updateOffset(side, currentOffset + deltaSeconds);
  };
  const resetOffsets = () => {
    if (playing) stop();
    setProjectOffset(0);
    setReferenceOffset(0);
  };

  return (
    <section className="master-reference-section" aria-label="Reference audio comparison">
      <header>
        <div>
          <span className="mastering-panel-kicker">REFERENCE</span>
          <h4>Compare with a reference track</h4>
          <p>
            Import an original WAV, MP3 or FLAC, measure it, then switch between it and the current rendered master.
          </p>
        </div>
        <label className="master-reference-import">
          <span>{loading ? "Loading…" : reference ? "Replace reference" : "Import WAV / MP3 / FLAC"}</span>
          <input
            type="file"
            accept=".wav,.wave,.mp3,.flac,audio/wav,audio/mpeg,audio/flac"
            disabled={loading || rendering || blockNewWork || excerptLoudnessPending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importFile(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {loading && (
          <button
            type="button"
            onClick={() => {
              decodeJobRef.current++;
              decodeAbortRef.current?.abort();
              decodeAbortRef.current = null;
              setLoading(false);
              setStatus("Reference load cancelled.");
            }}
          >
            Cancel load
          </button>
        )}
      </header>
      <p className="master-reference-privacy">
        The reference stays read-only in local browser storage. It is not added to the project, collab session, or
        exports. Import limit: 96 MiB; decoded PCM limit: 128 MiB; maximum length: 12 minutes.
      </p>
      {reference && (
        <div className="master-reference-metadata">
          <strong>{reference.record.fileName}</strong>
          <span>
            {(reference.record.byteLength / 1024 / 1024).toFixed(1)} MiB ·{" "}
            {reference.details.durationSeconds.toFixed(1)} s
            {reference.details.durationAccuracy === "estimated" ? " (estimated)" : ""} · {reference.details.channels} ch
            · {reference.details.sampleRate} Hz
          </span>
          <span>
            {formatDb(reference.summary.lufsIntegrated, "LUFS-I")} · {formatDb(reference.summary.truePeakDb, "dBTP")}
          </span>
          <button type="button" onClick={() => void removeReference()} disabled={loading || rendering || blockNewWork}>
            Remove reference
          </button>
        </div>
      )}
      {reference && (
        <div className="master-reference-controls">
          <button
            type="button"
            onClick={() => void renderProjectMaster()}
            disabled={rendering || loading || blockNewWork || excerptLoudnessPending}
          >
            {rendering
              ? "Rendering project…"
              : currentProjectMaster
                ? "Re-render current master"
                : "Render current master"}
          </button>
          {rendering && (
            <button type="button" onClick={() => renderAbortRef.current?.abort()}>
              Cancel render
            </button>
          )}
          <button
            type="button"
            onClick={() => play("project")}
            disabled={!currentProjectMaster || rendering || loading || excerptLoudnessPending}
          >
            {comparePairReady
              ? playing === "project"
                ? "Selected · project master"
                : playing
                  ? "Switch to project master"
                  : "Start A/B · project master"
              : playing === "project"
                ? "Playing project…"
                : "Play project master"}
          </button>
          <button
            type="button"
            onClick={() => play("reference")}
            disabled={!reference || rendering || loading || excerptLoudnessPending}
          >
            {comparePairReady
              ? playing === "reference"
                ? "Selected · reference"
                : playing
                  ? "Switch to reference"
                  : "Start A/B · reference"
              : playing === "reference"
                ? "Playing reference…"
                : "Play reference"}
          </button>
          {playing && (
            <button type="button" onClick={stop}>
              Stop
            </button>
          )}
          <label className="master-ab-match">
            <input type="checkbox" checked={mono} onChange={(event) => setMono(event.target.checked)} />
            Mono audition
          </label>
          <label className="master-reference-dim">
            Dim
            <input
              type="range"
              min={-24}
              max={0}
              step={1}
              value={dimDb}
              onChange={(event) => setDimDb(Number(event.target.value))}
            />
            <span>{dimDb} dB</span>
          </label>
        </div>
      )}
      {reference && currentProjectMaster && projectMaster && (
        <>
          <div className="master-reference-match-readout">
            <span>
              Project: {formatDb(projectMaster.summary.lufsIntegrated, "LUFS-I")} ·{" "}
              {formatDb(projectMaster.summary.truePeakDb, "dBTP")}
            </span>
            <span>
              Reference: {formatDb(reference.summary.lufsIntegrated, "LUFS-I")} ·{" "}
              {formatDb(reference.summary.truePeakDb, "dBTP")}
            </span>
            <span role="status" aria-live="polite" aria-atomic="true" title={currentExcerptLoudness?.reason}>
              Audition trim — {auditionTrimLabel}
            </span>
          </div>
          <div className="master-reference-offsets">
            <div className="master-reference-offset-control">
              <label htmlFor="master-reference-project-offset">Project start</label>
              <div className="master-reference-offset-input">
                <button
                  type="button"
                  aria-label="Move project start 10 milliseconds earlier"
                  title="Move 10 milliseconds earlier"
                  disabled={projectOffset <= 0}
                  onClick={() => nudgeOffset("project", -0.01)}
                >
                  −10 ms
                </button>
                <input
                  id="master-reference-project-offset"
                  type="number"
                  min={0}
                  max={renderProjectMax}
                  step={0.001}
                  value={projectOffset}
                  aria-label="Project start offset in seconds"
                  aria-describedby="master-reference-offset-status"
                  onChange={(event) => updateOffset("project", Number(event.target.value) || 0)}
                />
                <span aria-hidden="true">s</span>
                <button
                  type="button"
                  aria-label="Move project start 10 milliseconds later"
                  title="Move 10 milliseconds later"
                  disabled={projectOffset >= renderProjectMax}
                  onClick={() => nudgeOffset("project", 0.01)}
                >
                  +10 ms
                </button>
              </div>
            </div>
            <div className="master-reference-offset-control">
              <label htmlFor="master-reference-reference-offset">Reference start</label>
              <div className="master-reference-offset-input">
                <button
                  type="button"
                  aria-label="Move reference start 10 milliseconds earlier"
                  title="Move 10 milliseconds earlier"
                  disabled={referenceOffset <= 0}
                  onClick={() => nudgeOffset("reference", -0.01)}
                >
                  −10 ms
                </button>
                <input
                  id="master-reference-reference-offset"
                  type="number"
                  min={0}
                  max={renderReferenceMax}
                  step={0.001}
                  value={referenceOffset}
                  aria-label="Reference start offset in seconds"
                  aria-describedby="master-reference-offset-status"
                  onChange={(event) => updateOffset("reference", Number(event.target.value) || 0)}
                />
                <span aria-hidden="true">s</span>
                <button
                  type="button"
                  aria-label="Move reference start 10 milliseconds later"
                  title="Move 10 milliseconds later"
                  disabled={referenceOffset >= renderReferenceMax}
                  onClick={() => nudgeOffset("reference", 0.01)}
                >
                  +10 ms
                </button>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-small"
              aria-label="Reset project and reference starts to the beginning"
              disabled={projectOffset === 0 && referenceOffset === 0}
              onClick={resetOffsets}
            >
              Reset both starts
            </button>
            <span id="master-reference-offset-status" role="status" aria-live="polite" aria-atomic="true">
              {comparePairReady
                ? `Shared A/B excerpt: ${compareExcerptDuration.toFixed(2)} s. Start both at these points, then switch sides without stopping.`
                : "Each side starts at its chosen point. Both use the same audition dim and mono setting."}
            </span>
          </div>
        </>
      )}
      <p className="master-reference-status" role="status" aria-live="polite">
        {status}
      </p>
      {storageMessage && <p className="master-reference-storage">{storageMessage}</p>}
      {error && (
        <p className="master-ab-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
