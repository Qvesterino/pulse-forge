import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import {
  inspectMasteringReferenceContainer,
  masteringReferenceFormatFromFileName,
  type EncodedMasterFileDetails,
} from "../mastering/encodedInspection";
import { CUSTOM_PROFILE, resolveDeliveryTarget } from "../mastering/profiles";
import { MasteringReferenceRepository, type MasteringReferenceRecord } from "../mastering/referenceRepository";
import { projectRevisionIdFor } from "../mastering/report";
import { decodeAudioData } from "../services/audio-decode";
import { estimateRenderPcmBytes, renderProject } from "../rendering/renderer";
import type { ProjectDocument } from "../project-model/types";
import { useServices } from "./context";

interface LoadedReference {
  record: MasteringReferenceRecord;
  buffer: AudioBuffer;
  summary: BufferSummary;
  details: EncodedMasterFileDetails;
}

interface RenderedProjectMaster {
  revisionId: string;
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

function assertReferenceMetadata(details: EncodedMasterFileDetails): void {
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
  const decodedBytes = Math.ceil(details.durationSeconds * DECODE_SAMPLE_RATE) * details.channels * 4;
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
  assertReferenceMetadata(details);
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudioData(bytes.slice(0), DECODE_SAMPLE_RATE);
  } catch (reason) {
    if (signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) throw reason;
    if (format === "flac") {
      throw new Error(
        "This browser could not decode the FLAC reference. Convert it to WAV or try a browser with FLAC decoding.",
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
): Promise<LoadedReference> {
  if (
    record.byteLength <= 0 ||
    record.byteLength > MAX_REFERENCE_FILE_BYTES ||
    record.source.size !== record.byteLength
  ) {
    throw new Error("The saved reference file is empty or exceeds the 96 MiB import limit.");
  }
  return decodeReferenceBytes(record, await record.source.arrayBuffer(), profile, signal, onProgress);
}

function bufferBytes(buffer: AudioBuffer | null): number {
  return buffer ? buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT : 0;
}

function formatDb(value: number, suffix: string): string {
  return Number.isFinite(value) && value > -120 ? `${value.toFixed(1)} ${suffix}` : `−∞ ${suffix}`;
}

function previewTrim(summary: BufferSummary, target: number | null, enabled: boolean): number {
  if (!enabled || target === null || summary.lufsIntegrated <= -119) return 1;
  return Math.min(1, Math.pow(10, (target - summary.lufsIntegrated) / 20));
}

function trimLabel(gain: number): string {
  return `${(20 * Math.log10(Math.max(1e-12, gain))).toFixed(1)} dB`;
}

export function MasteringReferenceCompare({
  doc,
  revisionId,
  sampleRate,
  levelMatch,
  abRenderEpoch,
  onBeforeRender,
  onReferenceBytes,
  assistantBytes,
  comparisonBytes,
  onProjectMasterBytes,
}: {
  doc: ProjectDocument;
  revisionId: string;
  sampleRate: number;
  levelMatch: boolean;
  abRenderEpoch: number;
  onBeforeRender(): void;
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
    };
  }, [services.engine]);

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
    void repository
      .get(projectId)
      .then(async (record) => {
        if (!aliveRef.current || decodeJobRef.current !== job) return;
        if (!record) {
          setStatus("No reference saved for this project.");
          return;
        }
        setStatus("Decoding saved reference…");
        const decoded = await decodeReference(record, CUSTOM_PROFILE, controller.signal, (progress, stage) => {
          if (aliveRef.current && decodeJobRef.current === job)
            setStatus(`Measuring saved reference… ${Math.round(progress * 100)}% · ${stage}`);
        });
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
    onReferenceBytes(bufferBytes(reference?.buffer ?? null));
  }, [reference, onReferenceBytes]);

  const currentProjectMaster = projectMaster?.revisionId === revisionId && projectMaster.sampleRate === sampleRate;
  const targetLufs = useMemo(() => {
    if (!reference || !currentProjectMaster) return null;
    const lufsProject = projectMaster.summary.lufsIntegrated;
    const lufsReference = reference.summary.lufsIntegrated;
    if (lufsProject <= -119 || lufsReference <= -119) return null;
    return Math.min(lufsProject, lufsReference);
  }, [currentProjectMaster, projectMaster, reference]);
  const dimGain = Math.pow(10, dimDb / 20);
  const projectGain =
    currentProjectMaster && projectMaster
      ? previewTrim(projectMaster.summary, targetLufs, levelMatch) * dimGain
      : dimGain;
  const referenceGain = reference ? previewTrim(reference.summary, targetLufs, levelMatch) * dimGain : dimGain;

  useEffect(() => {
    if (playing === "project") services.engine.updateMasterComparePreview(projectGain, mono);
    if (playing === "reference") services.engine.updateMasterComparePreview(referenceGain, mono);
  }, [mono, playing, projectGain, referenceGain, services.engine]);

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
    }
  };

  const renderProjectMaster = async () => {
    if (rendering) return;
    const startRevision = projectRevisionIdFor(services.store.getDoc());
    if (services.store.getDoc().id !== doc.id || startRevision !== revisionId) {
      setError("The project changed. Wait for the MASTER panel to update, then render again.");
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
      setProjectMaster({ revisionId: startRevision, sampleRate, buffer, summary });
      setStatus("Project master ready. Project and reference playback start at their selected comparison points.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancelled")) setStatus("Project master render cancelled.");
      else setError(message);
    } finally {
      if (renderAbortRef.current === controller) renderAbortRef.current = null;
      setRendering(false);
    }
  };

  const play = (source: "project" | "reference") => {
    if (source === "project" && (!currentProjectMaster || !projectMaster)) return;
    if (source === "reference" && !reference) return;
    services.engine.stopPreview();
    setPlaying(source);
    if (source === "project" && projectMaster) {
      services.engine.previewMasterCompare(
        projectMaster.buffer,
        projectGain,
        () => setPlaying(null),
        projectOffset,
        mono,
      );
    } else if (reference) {
      services.engine.previewMasterCompare(
        reference.buffer,
        referenceGain,
        () => setPlaying(null),
        referenceOffset,
        mono,
      );
    }
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

  const renderProjectMax = currentProjectMaster && projectMaster ? projectMaster.buffer.duration : 0;
  const renderReferenceMax = reference?.buffer.duration ?? 0;

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
            disabled={loading || rendering}
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
          <button type="button" onClick={() => void removeReference()} disabled={loading || rendering}>
            Remove reference
          </button>
        </div>
      )}
      {reference && (
        <div className="master-reference-controls">
          <button type="button" onClick={() => void renderProjectMaster()} disabled={rendering || loading}>
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
            disabled={!currentProjectMaster || rendering || loading}
          >
            {playing === "project" ? "Playing project…" : "Play project master"}
          </button>
          <button type="button" onClick={() => play("reference")} disabled={!reference || rendering || loading}>
            {playing === "reference" ? "Playing reference…" : "Play reference"}
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
            <span>
              Audition trim — project{" "}
              {levelMatch && targetLufs === null
                ? "unavailable"
                : trimLabel(previewTrim(projectMaster.summary, targetLufs, levelMatch))}
              ; reference{" "}
              {levelMatch && targetLufs === null
                ? "unavailable"
                : trimLabel(previewTrim(reference.summary, targetLufs, levelMatch))}
            </span>
          </div>
          <div className="master-reference-offsets">
            <label>
              Project start
              <input
                type="number"
                min={0}
                max={renderProjectMax}
                step={1}
                value={projectOffset}
                onChange={(event) =>
                  setProjectOffset(Math.min(renderProjectMax, Math.max(0, Number(event.target.value) || 0)))
                }
              />{" "}
              s
            </label>
            <label>
              Reference start
              <input
                type="number"
                min={0}
                max={renderReferenceMax}
                step={1}
                value={referenceOffset}
                onChange={(event) =>
                  setReferenceOffset(Math.min(renderReferenceMax, Math.max(0, Number(event.target.value) || 0)))
                }
              />{" "}
              s
            </label>
            <span>
              Switching sides starts each at its chosen point. Both use the same audition dim and mono setting.
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
