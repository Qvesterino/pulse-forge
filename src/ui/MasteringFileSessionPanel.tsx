import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BufferSummary } from "../audio-engine/metering";
import { analyzeMasterBufferAsync } from "../mastering/analysisClient";
import {
  inspectEncodedMaster,
  inspectMasteringReferenceContainer,
  type EncodedMasterInspection,
} from "../mastering/encodedInspection";
import { awaitMasteringSampleBankReady } from "../mastering/readiness";
import { evaluateDelivery, MASTER_PROFILES, resolveDeliveryTarget } from "../mastering/profiles";
import {
  assertMasteringSessionWorkingSetBudget,
  estimateMasteringSessionComparisonBytes,
  estimateMasteringSessionWorkingSetBytes,
  renderMasteringSessionSource,
} from "../mastering/sessionRender";
import {
  captureMasteringSessionSnapshot,
  clearMasteringSessionSnapshot,
  createMasteringSessionRecord,
  MasteringSessionRepository,
  redoMasteringSessionConfig,
  undoMasteringSessionConfig,
  updateMasteringSessionConfig,
} from "../mastering/sessionStore";
import type { MasteringSessionRecord, MasteringSessionReferenceRecord } from "../mastering/sessionStore";
import type { MasteringSessionSlot, MasteringSessionSummary } from "../mastering/sessionStore";
import { decodeAudioData } from "../services/audio-decode";
import { uid } from "../shared/ids";
import type { EffectInstance } from "../project-model/types";
import { createBextMetadata, encodeWavAsync, sanitizeFilename } from "../rendering/wav";
import type { WavBitDepth } from "../rendering/wav";
import { downloadBlob } from "../export/download";
import { useServices } from "./context";
import { MasteringSessionInsertRack } from "./MasteringSessionInsertRack";

const MAX_DECODED_SOURCE_BYTES = 128 * 1024 * 1024;
const DECODE_SAMPLE_RATE = 44_100;
const AUDIO_EXTENSION = /\.(wav|wave|mp3)$/i;

interface RenderedSession {
  buffer: AudioBuffer;
  measurements: BufferSummary;
  configRevision: number;
  sampleRate: 44_100 | 48_000;
}

interface SessionComparedVersion {
  buffer: AudioBuffer;
  measurements: BufferSummary;
}

interface SessionComparison {
  snapshotAId: string;
  snapshotBId: string;
  sampleRate: 44_100 | 48_000;
  a: SessionComparedVersion;
  b: SessionComparedVersion;
}

type SessionPreviewSelection = MasteringSessionSlot | "master" | "reference";

interface LoadedSessionReference {
  record: MasteringSessionReferenceRecord;
  buffer: AudioBuffer;
  measurements: BufferSummary;
  sampleRate: number;
}

function compareGain(measurements: BufferSummary, targetLufs: number | null, enabled: boolean): number {
  if (!enabled || targetLufs === null || measurements.lufsIntegrated <= -119) return 1;
  return Math.min(1, Math.pow(10, (targetLufs - measurements.lufsIntegrated) / 20));
}

function formatCompareGain(gain: number): string {
  return `${(20 * Math.log10(Math.max(1e-12, gain))).toFixed(1)} dB`;
}

function sessionSummary(record: MasteringSessionRecord): MasteringSessionSummary {
  const { source, ...summary } = record;
  void source;
  return summary;
}

function setItem(items: MasteringSessionSummary[], record: MasteringSessionRecord): MasteringSessionSummary[] {
  return [sessionSummary(record), ...items.filter((item) => item.id !== record.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

function bufferBytes(buffer: AudioBuffer | null): number {
  return buffer ? buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT : 0;
}

function awaitWithSessionAbort<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
  message = "Operation cancelled",
): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(new DOMException(message, "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onAbort = () => finish(() => reject(new DOMException(message, "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (reason: unknown) => finish(() => reject(reason)),
    );
    if (signal.aborted) onAbort();
  });
}

function decodeAudioDataWithSessionAbort(
  bytes: ArrayBuffer,
  sampleRate: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<AudioBuffer> {
  if (signal?.aborted) return Promise.reject(new DOMException(message, "AbortError"));
  return awaitWithSessionAbort(decodeAudioData(bytes, sampleRate), signal, message);
}

async function auditDecodedAudio(buffer: AudioBuffer, signal?: AbortSignal): Promise<void> {
  let checked = 0;
  const total = buffer.length * buffer.numberOfChannels;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let offset = 0; offset < samples.length; offset += 262_144) {
      if (signal?.aborted) throw new DOMException("Audio inspection cancelled", "AbortError");
      const end = Math.min(samples.length, offset + 262_144);
      for (let index = offset; index < end; index++) {
        if (!Number.isFinite(samples[index])) throw new Error("The decoded file contains an invalid audio sample.");
      }
      checked += end - offset;
      if (checked < total) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot calculate a source-file fingerprint.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function decodeSessionSource(record: MasteringSessionRecord, signal?: AbortSignal): Promise<AudioBuffer> {
  if (record.byteLength <= 0 || record.source.size !== record.byteLength) {
    throw new Error("The saved source file is incomplete.");
  }
  const bytes = await awaitWithSessionAbort(record.source.arrayBuffer(), signal, "Session load cancelled");
  if (signal?.aborted) throw new DOMException("Session load cancelled", "AbortError");
  if ((await awaitWithSessionAbort(sha256Hex(bytes), signal, "Session load cancelled")) !== record.sourceHash)
    throw new Error("The saved source file does not match its session fingerprint.");
  if (signal?.aborted) throw new DOMException("Session load cancelled", "AbortError");
  const format = record.fileName.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
  const details = inspectMasteringReferenceContainer(format, bytes);
  if (details.channels !== record.channels || details.sampleRate !== record.sourceSampleRate) {
    throw new Error("The saved file metadata no longer matches this mastering session.");
  }
  const buffer = await decodeAudioDataWithSessionAbort(
    bytes.slice(0),
    DECODE_SAMPLE_RATE,
    signal,
    "Session load cancelled",
  );
  if (signal?.aborted) throw new DOMException("Session load cancelled", "AbortError");
  if (
    buffer.numberOfChannels !== record.channels ||
    buffer.duration > 12 * 60 ||
    buffer.duration < 0.8 ||
    buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_SOURCE_BYTES
  ) {
    throw new Error("The decoded source is outside the supported mastering-session limits.");
  }
  await auditDecodedAudio(buffer, signal);
  return buffer;
}

async function decodeSessionReference(
  record: MasteringSessionReferenceRecord,
  profile: ReturnType<typeof resolveDeliveryTarget>,
  signal?: AbortSignal,
): Promise<LoadedSessionReference> {
  if (record.byteLength <= 0 || record.source.size !== record.byteLength || record.byteLength > 96 * 1024 * 1024) {
    throw new Error("The saved mastering-session reference is incomplete or exceeds the 96 MiB limit.");
  }
  const bytes = await awaitWithSessionAbort(record.source.arrayBuffer(), signal, "Reference load cancelled");
  if (signal?.aborted) throw new DOMException("Reference load cancelled", "AbortError");
  if ((await awaitWithSessionAbort(sha256Hex(bytes), signal, "Reference load cancelled")) !== record.sourceHash) {
    throw new Error("The saved reference file does not match its session fingerprint.");
  }
  if (signal?.aborted) throw new DOMException("Reference load cancelled", "AbortError");
  const format = record.fileName.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
  const details = inspectMasteringReferenceContainer(format, bytes);
  if (
    details.channels !== record.channels ||
    details.sampleRate !== record.sampleRate ||
    details.durationSeconds > 12 * 60
  ) {
    throw new Error("The saved reference metadata no longer matches its file.");
  }
  const estimatedBytes = Math.ceil(details.durationSeconds * DECODE_SAMPLE_RATE) * details.channels * 4;
  if (estimatedBytes > MAX_DECODED_SOURCE_BYTES) {
    throw new Error("The decoded reference exceeds KYX's 128 MiB memory limit.");
  }
  const buffer = await decodeAudioDataWithSessionAbort(
    bytes.slice(0),
    DECODE_SAMPLE_RATE,
    signal,
    "Reference load cancelled",
  );
  if (
    buffer.numberOfChannels !== record.channels ||
    buffer.duration < 0.8 ||
    buffer.duration > 12 * 60 ||
    buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_SOURCE_BYTES
  ) {
    throw new Error("The decoded reference is outside the supported mastering-session limits.");
  }
  if (signal?.aborted) throw new DOMException("Reference load cancelled", "AbortError");
  await auditDecodedAudio(buffer, signal);
  const analysis = await analyzeMasterBufferAsync(buffer, profile, { signal });
  return { record, buffer, measurements: analysis.measurements, sampleRate: details.sampleRate };
}

function masteringSessionErrorMessage(reason: unknown, fallback: string): string {
  const name = typeof reason === "object" && reason !== null && "name" in reason ? String(reason.name) : "";
  const message = reason instanceof Error ? reason.message : String(reason);
  if (name === "QuotaExceededError" || /quota exceeded|storage.*full/i.test(message)) {
    return "Browser storage is full. Free space or remove an unused local mastering session, then retry.";
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return "Browser storage is unavailable for this page. Check the site storage permission and retry.";
  }
  return reason instanceof Error ? reason.message : fallback;
}

export function MasteringFileSessionPanel() {
  const services = useServices();
  const repository = useMemo(() => new MasteringSessionRepository(), []);
  const [sessions, setSessions] = useState<MasteringSessionSummary[]>([]);
  const [session, setSession] = useState<MasteringSessionRecord | null>(null);
  const [source, setSource] = useState<AudioBuffer | null>(null);
  const [reference, setReference] = useState<LoadedSessionReference | null>(null);
  const [draft, setDraft] = useState<MasteringSessionRecord["masterConfig"] | null>(null);
  const [rendered, setRendered] = useState<RenderedSession | null>(null);
  const [comparison, setComparison] = useState<SessionComparison | null>(null);
  const [matchLoudness, setMatchLoudness] = useState(true);
  const [playing, setPlaying] = useState<SessionPreviewSelection | null>(null);
  const [versionNames, setVersionNames] = useState<Record<MasteringSessionSlot, string>>({
    A: "Version A",
    B: "Version B",
  });
  const [inspection, setInspection] = useState<EncodedMasterInspection | null>(null);
  const [sampleRate, setSampleRate] = useState<44_100 | 48_000>(44_100);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(24);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const operation = useRef<AbortController | null>(null);
  const selectionEpoch = useRef(0);
  const playingRef = useRef<SessionPreviewSelection | null>(null);
  playingRef.current = playing;

  useEffect(() => {
    let active = true;
    void repository.list().then(
      (records) => active && setSessions(records),
      (reason: unknown) =>
        active && setError(masteringSessionErrorMessage(reason, "Could not load local mastering sessions.")),
    );
    return () => {
      active = false;
      selectionEpoch.current++;
      operation.current?.abort();
      if (playingRef.current) services.engine.stopPreview();
    };
  }, [repository, services.engine]);

  const dirty = Boolean(session && draft && JSON.stringify(draft) !== JSON.stringify(session.masterConfig));
  const renderCurrent = Boolean(
    session &&
    rendered &&
    !dirty &&
    rendered.configRevision === session.configRevision &&
    rendered.sampleRate === sampleRate,
  );
  const estimatedBytes =
    source && draft
      ? estimateMasteringSessionWorkingSetBytes(source, draft, sampleRate) + bufferBytes(reference?.buffer ?? null)
      : 0;
  const snapshotA = session?.snapshots.A ?? null;
  const snapshotB = session?.snapshots.B ?? null;
  const comparisonEstimateBytes =
    source && snapshotA && snapshotB
      ? estimateMasteringSessionComparisonBytes(source, snapshotA.masterConfig, snapshotB.masterConfig, sampleRate) +
        bufferBytes(reference?.buffer ?? null)
      : 0;
  const comparisonCurrent = Boolean(
    comparison &&
    snapshotA &&
    snapshotB &&
    comparison.snapshotAId === snapshotA.id &&
    comparison.snapshotBId === snapshotB.id &&
    comparison.sampleRate === sampleRate,
  );
  const comparisonMatchTarget = useMemo(() => {
    if (!comparisonCurrent || !comparison) return null;
    const loudnessA = comparison.a.measurements.lufsIntegrated;
    const loudnessB = comparison.b.measurements.lufsIntegrated;
    if (loudnessA <= -119 || loudnessB <= -119) return null;
    return Math.min(loudnessA, loudnessB);
  }, [comparison, comparisonCurrent]);
  const comparisonGainA =
    comparisonCurrent && comparison ? compareGain(comparison.a.measurements, comparisonMatchTarget, matchLoudness) : 1;
  const comparisonGainB =
    comparisonCurrent && comparison ? compareGain(comparison.b.measurements, comparisonMatchTarget, matchLoudness) : 1;
  const referenceMatchTarget = useMemo(() => {
    if (!renderCurrent || !rendered || !reference) return null;
    const masterLufs = rendered.measurements.lufsIntegrated;
    const referenceLufs = reference.measurements.lufsIntegrated;
    if (masterLufs <= -119 || referenceLufs <= -119) return null;
    return Math.min(masterLufs, referenceLufs);
  }, [reference, renderCurrent, rendered]);
  const referenceMasterGain =
    rendered && renderCurrent ? compareGain(rendered.measurements, referenceMatchTarget, matchLoudness) : 1;
  const referenceAudioGain = reference ? compareGain(reference.measurements, referenceMatchTarget, matchLoudness) : 1;
  const outputMeasurements = useMemo(() => {
    if (!rendered) return null;
    if (inspection?.decode.status === "measured" && inspection.decode.measurements) {
      return inspection.decode.measurements;
    }
    return rendered.measurements;
  }, [inspection, rendered]);

  useEffect(() => {
    if (!session) return;
    setVersionNames({
      A: session.snapshots.A?.name ?? "Version A",
      B: session.snapshots.B?.name ?? "Version B",
    });
  }, [session?.id, session?.snapshots.A?.id, session?.snapshots.B?.id]);
  const deliveryVerdict = useMemo(() => {
    if (!outputMeasurements || !draft) return null;
    return evaluateDelivery(
      {
        lufs: outputMeasurements.lufsIntegrated,
        truePeakDb: outputMeasurements.truePeakDb,
        correlation: outputMeasurements.correlation,
        monoLossDb: outputMeasurements.monoLossDb,
        lrImbalanceDb: outputMeasurements.lrImbalanceDb,
      },
      resolveDeliveryTarget(draft),
    );
  }, [draft, outputMeasurements]);

  useEffect(() => {
    if (playing === "A") services.engine.updateMasterComparePreview(comparisonGainA, false);
    if (playing === "B") services.engine.updateMasterComparePreview(comparisonGainB, false);
    if (playing === "master") services.engine.updateMasterComparePreview(referenceMasterGain, false);
    if (playing === "reference") services.engine.updateMasterComparePreview(referenceAudioGain, false);
  }, [comparisonGainA, comparisonGainB, playing, referenceAudioGain, referenceMasterGain, services.engine]);

  const stopSessionPreview = useCallback(() => {
    if (playingRef.current) services.engine.stopPreview();
    playingRef.current = null;
    setPlaying(null);
  }, [services.engine]);

  const loadSession = useCallback(
    async (id: string) => {
      const epoch = ++selectionEpoch.current;
      operation.current?.abort();
      operation.current = null;
      stopSessionPreview();
      setComparison(null);
      setSession(null);
      setSource(null);
      setReference(null);
      setDraft(null);
      setRendered(null);
      setInspection(null);
      setError("");
      setNotice("");
      if (!id) {
        setBusy("");
        return;
      }
      const controller = new AbortController();
      operation.current = controller;
      const ensureActive = () => {
        if (selectionEpoch.current !== epoch) throw new DOMException("Session selection changed", "AbortError");
        if (controller.signal.aborted) throw new DOMException("Session load cancelled", "AbortError");
      };
      setBusy("Loading source file…");
      try {
        const record = await repository.get(id);
        ensureActive();
        if (!record) throw new Error("This local mastering session could not be found.");
        const buffer = await decodeSessionSource(record, controller.signal);
        ensureActive();
        let loadedReference: LoadedSessionReference | null = null;
        let referenceError = "";
        const savedReference = await repository.getReference(id);
        ensureActive();
        if (savedReference) {
          try {
            setBusy("Loading saved comparison reference…");
            const referenceBytes =
              Math.ceil(savedReference.durationSeconds * DECODE_SAMPLE_RATE) * savedReference.channels * 4;
            const baseBytes = estimateMasteringSessionWorkingSetBytes(buffer, record.masterConfig, sampleRate);
            assertMasteringSessionWorkingSetBudget(baseBytes + referenceBytes);
            loadedReference = await decodeSessionReference(
              savedReference,
              resolveDeliveryTarget(record.masterConfig),
              controller.signal,
            );
          } catch (reason) {
            if (controller.signal.aborted) throw reason;
            referenceError = masteringSessionErrorMessage(reason, "The saved reference could not be loaded.");
          }
        }
        ensureActive();
        setSession(record);
        setSource(buffer);
        setReference(loadedReference);
        setDraft(record.masterConfig);
        setNotice(
          `Loaded ${record.fileName} · ${record.durationSeconds.toFixed(1)} s · ${record.channels} ch${loadedReference ? ` · reference ${loadedReference.record.fileName} ready` : ""}`,
        );
        if (referenceError) setError(`Session loaded, but its saved reference could not be loaded: ${referenceError}`);
      } catch (reason) {
        if (epoch !== selectionEpoch.current || operation.current !== controller) return;
        if (controller.signal.aborted) setNotice("Session load cancelled.");
        else setError(masteringSessionErrorMessage(reason, "Could not load the mastering session."));
      } finally {
        if (operation.current === controller) operation.current = null;
        if (epoch === selectionEpoch.current) setBusy("");
      }
    },
    [repository, sampleRate, stopSessionPreview],
  );

  const importFile = useCallback(
    async (file?: File) => {
      if (!file) return;
      const epoch = ++selectionEpoch.current;
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const ensureActive = () => {
        if (selectionEpoch.current !== epoch) throw new DOMException("Session selection changed", "AbortError");
        if (controller.signal.aborted) throw new DOMException("Source import cancelled", "AbortError");
      };
      let commitStarted = false;
      setError("");
      setNotice("");
      stopSessionPreview();
      setBusy("Reading source file…");
      try {
        if (!AUDIO_EXTENSION.test(file.name)) throw new Error("Choose a WAV or MP3 mixdown.");
        if (file.size <= 0 || file.size > 96 * 1024 * 1024) {
          throw new Error("External mastering accepts files up to 96 MiB.");
        }
        const bytes = await awaitWithSessionAbort(file.arrayBuffer(), controller.signal, "Source import cancelled");
        ensureActive();
        const format = file.name.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
        const details = inspectMasteringReferenceContainer(format, bytes);
        if (details.channels !== 1 && details.channels !== 2) throw new Error("Use a mono or stereo source file.");
        if (
          !Number.isFinite(details.durationSeconds) ||
          details.durationSeconds < 0.8 ||
          details.durationSeconds > 12 * 60
        ) {
          throw new Error("External mastering supports audio from 0.8 seconds to 12 minutes.");
        }
        if (details.sampleRate < 8000 || details.sampleRate > 192000) {
          throw new Error("The source sample rate must be between 8 and 192 kHz.");
        }
        const estimatedDecodeBytes = Math.ceil(details.durationSeconds * DECODE_SAMPLE_RATE) * details.channels * 4;
        if (estimatedDecodeBytes > MAX_DECODED_SOURCE_BYTES) {
          throw new Error("The decoded source would exceed KYX's 128 MiB source-memory limit.");
        }
        const sourceHash = await awaitWithSessionAbort(sha256Hex(bytes), controller.signal, "Source import cancelled");
        ensureActive();
        setProgress("Decoding source audio…");
        const buffer = await decodeAudioDataWithSessionAbort(
          bytes.slice(0),
          DECODE_SAMPLE_RATE,
          controller.signal,
          "Source import cancelled",
        );
        ensureActive();
        if (
          buffer.numberOfChannels !== details.channels ||
          buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_SOURCE_BYTES ||
          buffer.duration > 12 * 60 ||
          buffer.duration < 0.8
        ) {
          throw new Error("The decoded source is outside KYX's supported duration or memory limits.");
        }
        setBusy("Inspecting decoded source audio…");
        await auditDecodedAudio(buffer, controller.signal);
        ensureActive();
        const record = createMasteringSessionRecord({
          id: uid("mastering-session"),
          fileName: file.name.slice(0, 255),
          mimeType: file.type.slice(0, 120),
          source: file,
          sourceHash,
          durationSeconds: buffer.duration,
          channels: buffer.numberOfChannels as 1 | 2,
          sourceSampleRate: details.sampleRate,
          masterConfig: (await import("../project-model/schema")).defaultMasterConfig(),
        });
        ensureActive();
        setBusy("Saving source session locally…");
        setProgress("");
        // IndexedDB commits are atomic but cannot be aborted from this UI.
        // Hide Cancel for this short, non-cancellable commit window.
        commitStarted = true;
        operation.current = null;
        await repository.put(record);
        if (selectionEpoch.current !== epoch) return;
        setComparison(null);
        setRendered(null);
        setInspection(null);
        setSessions((current) => setItem(current, record));
        setSession(record);
        setSource(buffer);
        setReference(null);
        setDraft(record.masterConfig);
        setNotice(`Original saved locally · SHA-256 ${sourceHash.slice(0, 16)}…`);
      } catch (reason) {
        if (epoch !== selectionEpoch.current || (!commitStarted && operation.current !== controller)) return;
        if (controller.signal.aborted) setNotice("Source import cancelled. The selected session was left unchanged.");
        else setError(masteringSessionErrorMessage(reason, "Could not import this mastering source."));
      } finally {
        if (operation.current === controller) operation.current = null;
        if (epoch === selectionEpoch.current) {
          setBusy("");
          setProgress("");
        }
      }
    },
    [repository, stopSessionPreview],
  );

  const importReference = useCallback(
    async (file?: File) => {
      if (!file || !session || !source || !draft) return;
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const epoch = selectionEpoch.current;
      let commitStarted = false;
      const ensureActive = () => {
        if (selectionEpoch.current !== epoch) throw new DOMException("Session selection changed", "AbortError");
        if (controller.signal.aborted) throw new DOMException("Reference import cancelled", "AbortError");
      };
      stopSessionPreview();
      setError("");
      setNotice("");
      setProgress("");
      setBusy("Validating comparison reference…");
      try {
        if (!AUDIO_EXTENSION.test(file.name)) throw new Error("Choose a WAV or MP3 reference file.");
        if (file.size <= 0 || file.size > 96 * 1024 * 1024) {
          throw new Error("Comparison references must be between 1 byte and 96 MiB.");
        }
        const bytes = await awaitWithSessionAbort(file.arrayBuffer(), controller.signal, "Reference import cancelled");
        ensureActive();
        const format = file.name.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
        const details = inspectMasteringReferenceContainer(format, bytes);
        if (details.channels !== 1 && details.channels !== 2) {
          throw new Error("Use a mono or stereo comparison reference.");
        }
        if (
          !Number.isFinite(details.durationSeconds) ||
          details.durationSeconds < 0.8 ||
          details.durationSeconds > 12 * 60
        ) {
          throw new Error("Comparison references must be between 0.8 seconds and 12 minutes.");
        }
        if (details.sampleRate < 8000 || details.sampleRate > 192000) {
          throw new Error("The comparison sample rate must be between 8 and 192 kHz.");
        }
        const estimatedReferenceBytes =
          Math.ceil(details.durationSeconds * DECODE_SAMPLE_RATE) * details.channels * Float32Array.BYTES_PER_ELEMENT;
        if (estimatedReferenceBytes > MAX_DECODED_SOURCE_BYTES) {
          throw new Error("The decoded reference exceeds KYX's 128 MiB memory limit.");
        }
        const baseBytes =
          estimateMasteringSessionWorkingSetBytes(source, draft, sampleRate) + bufferBytes(reference?.buffer ?? null);
        assertMasteringSessionWorkingSetBudget(baseBytes + estimatedReferenceBytes);
        const sourceHash = await awaitWithSessionAbort(
          sha256Hex(bytes),
          controller.signal,
          "Reference import cancelled",
        );
        ensureActive();
        setBusy("Decoding comparison reference…");
        const buffer = await decodeAudioDataWithSessionAbort(
          bytes.slice(0),
          DECODE_SAMPLE_RATE,
          controller.signal,
          "Reference import cancelled",
        );
        ensureActive();
        if (
          buffer.numberOfChannels !== details.channels ||
          buffer.duration < 0.8 ||
          buffer.duration > 12 * 60 ||
          buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_SOURCE_BYTES
        ) {
          throw new Error("The decoded reference is outside the supported mastering-session limits.");
        }
        assertMasteringSessionWorkingSetBudget(baseBytes + bufferBytes(buffer));
        setBusy("Inspecting decoded comparison reference…");
        await auditDecodedAudio(buffer, controller.signal);
        ensureActive();
        setBusy("Measuring comparison reference…");
        const analysis = await analyzeMasterBufferAsync(buffer, resolveDeliveryTarget(draft), {
          signal: controller.signal,
          onProgress: ({ progress: value, stage }) => setProgress(`${stage} · ${Math.round(value * 100)}%`),
        });
        ensureActive();
        const record: MasteringSessionReferenceRecord = {
          sessionId: session.id,
          fileName: file.name.slice(0, 255),
          mimeType: file.type.slice(0, 120),
          byteLength: file.size,
          source: file.slice(0, file.size, file.type),
          sourceHash,
          durationSeconds: buffer.duration,
          channels: buffer.numberOfChannels as 1 | 2,
          sampleRate: details.sampleRate,
          importedAt: new Date().toISOString(),
        };
        setBusy("Saving reference locally…");
        setProgress("");
        commitStarted = true;
        operation.current = null;
        await repository.putReference(record);
        if (selectionEpoch.current !== epoch) return;
        setReference({ record, buffer, measurements: analysis.measurements, sampleRate: details.sampleRate });
        setNotice(`Reference saved locally · ${record.fileName}. It stays outside the master render and export.`);
      } catch (reason) {
        if (selectionEpoch.current !== epoch || (!commitStarted && operation.current !== controller)) return;
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
          setNotice("Reference import cancelled.");
        } else {
          setError(masteringSessionErrorMessage(reason, "Could not import this comparison reference."));
        }
      } finally {
        if (operation.current === controller) operation.current = null;
        if (selectionEpoch.current === epoch) {
          setBusy("");
          setProgress("");
        }
      }
    },
    [draft, repository, sampleRate, session, source, stopSessionPreview],
  );

  const removeReference = useCallback(async () => {
    if (!session || !reference) return;
    stopSessionPreview();
    setBusy("Removing local comparison reference…");
    setError("");
    try {
      await repository.deleteReference(session.id);
      setReference(null);
      setNotice("Local reference removed. The source session and master export are unchanged.");
    } catch (reason) {
      setError(masteringSessionErrorMessage(reason, "Could not remove the local comparison reference."));
    } finally {
      setBusy("");
    }
  }, [reference, repository, session, stopSessionPreview]);

  const persistRecord = useCallback(
    async (next: MasteringSessionRecord) => {
      try {
        await repository.put(next);
      } catch (reason) {
        throw new Error(masteringSessionErrorMessage(reason, "Could not save the mastering session."));
      }
      setSession(next);
      setDraft(next.masterConfig);
      setSessions((current) => setItem(current, next));
      setRendered(null);
      setInspection(null);
      setError("");
      setNotice("Processing settings saved to this local session.");
    },
    [repository],
  );

  const applySettings = useCallback(async () => {
    if (!session || !draft || !dirty) return;
    setBusy("Saving processing settings…");
    try {
      await persistRecord(updateMasteringSessionConfig(session, draft));
    } catch (reason) {
      setError(masteringSessionErrorMessage(reason, "Could not save processing settings."));
    } finally {
      setBusy("");
    }
  }, [dirty, draft, persistRecord, session]);

  const moveHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (!session) return;
      setBusy(direction === "undo" ? "Undoing settings…" : "Redoing settings…");
      try {
        const next = direction === "undo" ? undoMasteringSessionConfig(session) : redoMasteringSessionConfig(session);
        if (next !== session) await persistRecord(next);
      } catch (reason) {
        setError(masteringSessionErrorMessage(reason, "Could not update the settings history."));
      } finally {
        setBusy("");
      }
    },
    [persistRecord, session],
  );

  const saveSnapshot = useCallback(
    async (slot: MasteringSessionSlot) => {
      if (!session || dirty || busy) return;
      stopSessionPreview();
      setComparison(null);
      setBusy(`Saving version ${slot}…`);
      try {
        const next = captureMasteringSessionSnapshot(session, slot, versionNames[slot]);
        await repository.put(next);
        setSession(next);
        setSessions((current) => setItem(current, next));
        setNotice(`Saved ${slot} · ${next.snapshots[slot]?.name ?? versionNames[slot]}.`);
        setError("");
      } catch (reason) {
        setError(masteringSessionErrorMessage(reason, `Could not save version ${slot}.`));
      } finally {
        setBusy("");
      }
    },
    [busy, dirty, repository, session, stopSessionPreview, versionNames],
  );

  const clearSnapshot = useCallback(
    async (slot: MasteringSessionSlot) => {
      if (!session || !session.snapshots[slot] || busy) return;
      stopSessionPreview();
      setComparison(null);
      setBusy(`Clearing version ${slot}…`);
      try {
        const next = clearMasteringSessionSnapshot(session, slot);
        await repository.put(next);
        setSession(next);
        setSessions((current) => setItem(current, next));
        setNotice(`Cleared version ${slot}.`);
        setError("");
      } catch (reason) {
        setError(masteringSessionErrorMessage(reason, `Could not clear version ${slot}.`));
      } finally {
        setBusy("");
      }
    },
    [busy, repository, session, stopSessionPreview],
  );

  const loadSnapshot = useCallback(
    async (slot: MasteringSessionSlot) => {
      if (!session || dirty || busy) return;
      const snapshot = session.snapshots[slot];
      if (!snapshot) return;
      stopSessionPreview();
      setComparison(null);
      setBusy(`Loading version ${slot}…`);
      try {
        const next = updateMasteringSessionConfig(session, snapshot.masterConfig);
        if (next !== session) await persistRecord(next);
        setNotice(`Loaded ${slot} · ${snapshot.name}. Undo restores the previous session settings.`);
        setError("");
      } catch (reason) {
        setError(masteringSessionErrorMessage(reason, `Could not load version ${slot}.`));
      } finally {
        setBusy("");
      }
    },
    [busy, dirty, persistRecord, session, stopSessionPreview],
  );

  const renderComparison = useCallback(async () => {
    if (!session || !source || !snapshotA || !snapshotB || dirty || busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    const epoch = selectionEpoch.current;
    const snapshotAId = snapshotA.id;
    const snapshotBId = snapshotB.id;
    setBusy("Preparing A/B version render…");
    setError("");
    setNotice("");
    setProgress("");
    setComparison(null);
    setRendered(null);
    setInspection(null);
    stopSessionPreview();
    try {
      assertMasteringSessionWorkingSetBudget(comparisonEstimateBytes);
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      const bankRevision = services.bank.revision;
      const renderVersion = async (slot: MasteringSessionSlot, config: MasteringSessionRecord["masterConfig"]) => {
        setBusy(`Rendering version ${slot} · Studio HQ…`);
        const buffer = await renderMasteringSessionSource(source, config, services.bank, {
          sampleRate,
          quality: "studio",
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new DOMException("A/B render cancelled", "AbortError");
        if (selectionEpoch.current !== epoch) throw new DOMException("Mastering session changed", "AbortError");
        if (services.bank.revision !== bankRevision) {
          throw new Error("The sample bank changed during comparison. Render both versions again.");
        }
        return buffer;
      };

      const bufferA = await renderVersion("A", snapshotA.masterConfig);
      setBusy("Analyzing version A…");
      const analysisA = await analyzeMasterBufferAsync(bufferA, resolveDeliveryTarget(snapshotA.masterConfig), {
        signal: controller.signal,
        onProgress: ({ progress: value, stage }) => setProgress(`Version A · ${stage} · ${Math.round(value * 100)}%`),
      });
      const bufferB = await renderVersion("B", snapshotB.masterConfig);
      setBusy("Analyzing version B…");
      const analysisB = await analyzeMasterBufferAsync(bufferB, resolveDeliveryTarget(snapshotB.masterConfig), {
        signal: controller.signal,
        onProgress: ({ progress: value, stage }) => setProgress(`Version B · ${stage} · ${Math.round(value * 100)}%`),
      });
      if (services.bank.revision !== bankRevision || selectionEpoch.current !== epoch) {
        throw new Error("The source session or sample bank changed. Discarded this A/B result.");
      }
      setComparison({
        snapshotAId,
        snapshotBId,
        sampleRate,
        a: { buffer: bufferA, measurements: analysisA.measurements },
        b: { buffer: bufferB, measurements: analysisB.measurements },
      });
      setNotice("Both saved versions were rendered from the same source and sample rate. Compare them by listening.");
    } catch (reason) {
      if (selectionEpoch.current !== epoch) return;
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
        setNotice("A/B render cancelled.");
      } else {
        setError(masteringSessionErrorMessage(reason, "Could not render these mastering versions."));
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (selectionEpoch.current === epoch) {
        setBusy("");
        setProgress("");
      }
    }
  }, [
    busy,
    comparisonEstimateBytes,
    dirty,
    sampleRate,
    services,
    session,
    snapshotA,
    snapshotB,
    source,
    stopSessionPreview,
  ]);

  const playComparedVersion = useCallback(
    (slot: MasteringSessionSlot) => {
      if (!comparisonCurrent || !comparison) return;
      const side = slot === "A" ? comparison.a : comparison.b;
      const gain = slot === "A" ? comparisonGainA : comparisonGainB;
      stopSessionPreview();
      playingRef.current = slot;
      setPlaying(slot);
      services.engine.previewMasterCompare(side.buffer, gain, () => {
        if (playingRef.current === slot) {
          playingRef.current = null;
          setPlaying(null);
        }
      });
    },
    [comparison, comparisonCurrent, comparisonGainA, comparisonGainB, services.engine, stopSessionPreview],
  );

  const playReferenceComparison = useCallback(
    (selection: "master" | "reference") => {
      if (!renderCurrent || !rendered || !reference) return;
      const buffer = selection === "master" ? rendered.buffer : reference.buffer;
      const gain = selection === "master" ? referenceMasterGain : referenceAudioGain;
      stopSessionPreview();
      playingRef.current = selection;
      setPlaying(selection);
      services.engine.previewMasterCompare(buffer, gain, () => {
        if (playingRef.current === selection) {
          playingRef.current = null;
          setPlaying(null);
        }
      });
    },
    [reference, referenceAudioGain, referenceMasterGain, renderCurrent, rendered, services.engine, stopSessionPreview],
  );

  const updateDraft = useCallback(
    (patch: Partial<NonNullable<typeof draft>>) => {
      stopSessionPreview();
      setDraft((current) => (current ? { ...current, ...patch } : current));
      setRendered(null);
      setInspection(null);
      setError("");
    },
    [stopSessionPreview],
  );
  const updateDraftEffects = useCallback((effects: EffectInstance[]) => updateDraft({ effects }), [updateDraft]);

  const renderAndAnalyze = useCallback(async () => {
    if (!session || !source || !draft || dirty) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    const epoch = selectionEpoch.current;
    stopSessionPreview();
    setBusy("Preparing studio render…");
    setError("");
    setNotice("");
    setProgress("");
    setRendered(null);
    setInspection(null);
    setComparison(null);
    try {
      assertMasteringSessionWorkingSetBudget(estimatedBytes);
      await awaitMasteringSampleBankReady(services.core.initialSampleBankHydration, controller.signal);
      setBusy("Rendering source through the master chain…");
      const buffer = await renderMasteringSessionSource(source, draft, services.bank, {
        sampleRate,
        quality: "studio",
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException("Render cancelled", "AbortError");
      setBusy("Analyzing rendered master…");
      const analysis = await analyzeMasterBufferAsync(buffer, resolveDeliveryTarget(draft), {
        signal: controller.signal,
        onProgress: (update) => setProgress(`${update.stage} · ${Math.round(update.progress * 100)}%`),
      });
      if (controller.signal.aborted) throw new DOMException("Analysis cancelled", "AbortError");
      setRendered({ buffer, measurements: analysis.measurements, configRevision: session.configRevision, sampleRate });
      setNotice("Studio render and loudness analysis are ready. Review the measurements, then export the checked WAV.");
    } catch (reason) {
      if (selectionEpoch.current !== epoch) return;
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
        setNotice("Render or analysis cancelled.");
      } else {
        setError(masteringSessionErrorMessage(reason, "Could not render this mastering session."));
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (selectionEpoch.current === epoch) {
        setBusy("");
        setProgress("");
      }
    }
  }, [dirty, draft, estimatedBytes, sampleRate, services, session, source, stopSessionPreview]);

  const exportWav = useCallback(async () => {
    if (!session || !draft || !rendered || !renderCurrent) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    const epoch = selectionEpoch.current;
    stopSessionPreview();
    setBusy("Encoding delivery WAV…");
    setError("");
    setNotice("");
    setProgress("");
    setInspection(null);
    setComparison(null);
    try {
      const wav = await encodeWavAsync(rendered.buffer, bitDepth, {
        signal: controller.signal,
        onProgress: (value) => setProgress(`Encoding WAV · ${Math.round(value * 100)}%`),
        bext: createBextMetadata({
          description: `KYX mastered delivery · ${session.fileName}`,
          loudness: {
            integratedLufs: rendered.measurements.lufsIntegrated,
            rangeLu: rendered.measurements.loudnessRangeLu,
            truePeakDbtp: rendered.measurements.truePeakDb,
            momentaryLufs: rendered.measurements.lufsMomentary,
            shortTermLufs: rendered.measurements.lufsShortTerm,
          },
          codingHistory: `A=PCM,F=${rendered.sampleRate},W=${bitDepth},M=stereo,T=KYX external mastering`,
        }),
      });
      // Web Audio decodeAudioData may detach the ArrayBuffer passed to encoded
      // inspection. Retain the delivery Blob before inspection so export bytes
      // remain intact after the browser measures the encoded master.
      const deliveryBlob = new Blob([wav], { type: "audio/wav" });
      setBusy("Checking encoded WAV delivery…");
      const checked = await inspectEncodedMaster({
        format: "wav",
        bytes: wav,
        expectedDurationSeconds: rendered.buffer.duration,
        sourceMeasurements: rendered.measurements,
        profile: resolveDeliveryTarget(draft),
        signal: controller.signal,
        onProgress: (update) => setProgress(`${update.stage} · ${Math.round(update.progress * 100)}%`),
      });
      if (controller.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      setInspection(checked);
      const fileName = `${sanitizeFilename(session.fileName.replace(/\.(wav|wave|mp3)$/i, ""))}-mastered-${rendered.sampleRate}Hz-${bitDepth}bit.wav`;
      downloadBlob(deliveryBlob, fileName);
      setNotice(
        checked.decode.status === "measured"
          ? `Exported ${fileName} · encoded file parsed and decoded audio measured.`
          : `Exported ${fileName} · WAV container checked; post-decode audio was not measured.`,
      );
    } catch (reason) {
      if (selectionEpoch.current !== epoch) return;
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
        setNotice("WAV export cancelled.");
      } else {
        setError(masteringSessionErrorMessage(reason, "Could not encode or inspect the delivery WAV."));
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (selectionEpoch.current === epoch) {
        setBusy("");
        setProgress("");
      }
    }
  }, [bitDepth, draft, renderCurrent, rendered, session, stopSessionPreview]);

  const deleteSession = useCallback(async () => {
    if (!session) return;
    selectionEpoch.current++;
    operation.current?.abort();
    operation.current = null;
    stopSessionPreview();
    setComparison(null);
    setBusy("Deleting local session…");
    try {
      await repository.delete(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSession(null);
      setSource(null);
      setReference(null);
      setDraft(null);
      setRendered(null);
      setInspection(null);
      setNotice("Local session, source file and comparison reference were deleted.");
    } catch (reason) {
      setError(masteringSessionErrorMessage(reason, "Could not delete the local mastering session."));
    } finally {
      setBusy("");
    }
  }, [repository, session, stopSessionPreview]);

  const historyLabel = useMemo(() => {
    if (!session) return "No mastering session selected";
    return `${session.fileName} · ${session.durationSeconds.toFixed(1)} s · ${session.channels} ch · ${formatBytes(session.byteLength)}`;
  }, [session]);

  return (
    <section className="mastering-file-session" aria-label="External file mastering session">
      <header className="mastering-file-session-heading">
        <div>
          <span className="mastering-panel-kicker">EXTERNAL FILE MASTERING</span>
          <h3>Master a stereo mixdown</h3>
          <p>Open a WAV or MP3, process it with KYX’s offline master chain, then inspect and export a checked WAV.</p>
        </div>
        <label className="btn btn-small mastering-file-session-import">
          Import WAV / MP3
          <input
            type="file"
            aria-label="Import WAV or MP3 mixdown"
            accept=".wav,.wave,.mp3,audio/wav,audio/mpeg"
            disabled={Boolean(busy)}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void importFile(file);
            }}
          />
        </label>
      </header>

      <div className="mastering-file-session-context">
        <label>
          <strong>LOCAL SESSION</strong>
          <select
            aria-label="Saved mastering sessions"
            value={session?.id ?? ""}
            disabled={Boolean(busy)}
            onChange={(event) => void loadSession(event.target.value)}
          >
            <option value="">Choose a saved session…</option>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fileName} · {new Date(item.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <span className="mastering-file-session-source" title={historyLabel}>
          {historyLabel}
          {session && <small>SHA-256 {session.sourceHash.slice(0, 16)}… · original file retained</small>}
        </span>
        {session && (
          <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => void deleteSession()}>
            Delete session
          </button>
        )}
      </div>

      {session && draft && (
        <>
          <div className="mastering-file-session-controls" aria-label="External session processing settings">
            <label>
              <strong>DELIVERY PROFILE</strong>
              <select
                aria-label="External mastering delivery profile"
                value={draft.deliveryProfileId ?? "custom"}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  const id = event.target.value as NonNullable<typeof draft.deliveryProfileId>;
                  const target = resolveDeliveryTarget({ deliveryProfileId: id });
                  updateDraft({
                    deliveryProfileId: id,
                    ...(id === "custom"
                      ? {}
                      : { lufsTarget: target.targetLufs, deliveryTruePeakDb: target.maxTruePeakDb }),
                  });
                }}
              >
                {MASTER_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="mastering-file-session-range">
              <strong>INPUT</strong>
              <input
                aria-label="External master input gain"
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={draft.masterGain}
                disabled={Boolean(busy)}
                onChange={(event) => updateDraft({ masterGain: Number(event.target.value) })}
              />
              <small>{draft.masterGain === 0 ? "−∞ dB" : `${(20 * Math.log10(draft.masterGain)).toFixed(1)} dB`}</small>
            </label>
            <label className="mastering-file-session-range">
              <strong>CEILING</strong>
              <input
                aria-label="External master limiter ceiling"
                type="range"
                min="-12"
                max="0"
                step="0.1"
                value={draft.ceilingDb}
                disabled={Boolean(busy)}
                onChange={(event) => updateDraft({ ceilingDb: Number(event.target.value) })}
              />
              <small>{draft.ceilingDb.toFixed(1)} dBFS</small>
            </label>
            <label className="mastering-file-session-range">
              <strong>TONAL TILT</strong>
              <input
                aria-label="External master tonal tilt"
                type="range"
                min="-4"
                max="4"
                step="0.5"
                value={draft.tiltDb ?? 0}
                disabled={Boolean(busy)}
                onChange={(event) => updateDraft({ tiltDb: Number(event.target.value) })}
              />
              <small>
                {(draft.tiltDb ?? 0) > 0 ? "+" : ""}
                {(draft.tiltDb ?? 0).toFixed(1)} dB
              </small>
            </label>
            <label>
              <strong>TARGET LUFS</strong>
              <input
                aria-label="External mastering target loudness"
                type="number"
                min="-30"
                max="-5"
                step="0.1"
                value={draft.lufsTarget ?? -14}
                disabled={Boolean(busy)}
                onChange={(event) =>
                  updateDraft({ lufsTarget: Math.min(-5, Math.max(-30, Number(event.target.value))) })
                }
              />
            </label>
            <label>
              <strong>TRUE PEAK TARGET</strong>
              <input
                aria-label="External mastering true peak target"
                type="number"
                min="-6"
                max="0"
                step="0.1"
                value={draft.deliveryTruePeakDb ?? -1}
                disabled={Boolean(busy)}
                onChange={(event) =>
                  updateDraft({ deliveryTruePeakDb: Math.min(0, Math.max(-6, Number(event.target.value))) })
                }
              />
            </label>
            <div
              className="mastering-file-session-toggles"
              role="group"
              aria-label="External master processor switches"
            >
              <button
                type="button"
                className={`btn btn-small${draft.limiterEnabled ? " active-solo" : ""}`}
                aria-label="External master limiter"
                aria-pressed={draft.limiterEnabled}
                disabled={Boolean(busy)}
                onClick={() => updateDraft({ limiterEnabled: !draft.limiterEnabled })}
              >
                LIMIT
              </button>
              <button
                type="button"
                className={`btn btn-small${draft.glueEnabled ? " active-solo" : ""}`}
                aria-label="External master glue"
                aria-pressed={draft.glueEnabled ?? true}
                disabled={Boolean(busy)}
                onClick={() => updateDraft({ glueEnabled: !(draft.glueEnabled ?? true) })}
              >
                GLUE
              </button>
              <button
                type="button"
                className={`btn btn-small${draft.clipperEnabled ? " active-solo" : ""}`}
                aria-label="External master clipper"
                aria-pressed={draft.clipperEnabled}
                disabled={Boolean(busy)}
                onClick={() => updateDraft({ clipperEnabled: !draft.clipperEnabled })}
              >
                CLIP
              </button>
            </div>
          </div>

          <MasteringSessionInsertRack
            key={`${session.id}-${session.configRevision}`}
            sessionId={session.id}
            masterConfig={draft}
            disabled={Boolean(busy)}
            onEffectsChange={updateDraftEffects}
          />

          <section className="mastering-session-ab" aria-label="External session A/B versions">
            <header>
              <div>
                <strong>SESSION VERSIONS</strong>
                <p>
                  Save two settings or compare the current master with a reference; matching only changes audition
                  level.
                </p>
              </div>
              <label className="mastering-session-match">
                <input
                  type="checkbox"
                  checked={matchLoudness}
                  disabled={Boolean(busy)}
                  onChange={(event) => setMatchLoudness(event.target.checked)}
                />
                Match audition loudness
              </label>
              <button
                type="button"
                className="btn btn-export"
                disabled={
                  Boolean(busy) ||
                  dirty ||
                  !source ||
                  !snapshotA ||
                  !snapshotB ||
                  comparisonEstimateBytes > 512 * 1024 * 1024
                }
                onClick={() => void renderComparison()}
              >
                Render A/B versions
              </button>
            </header>
            <div className="mastering-session-version-grid">
              {(["A", "B"] as const).map((slot) => {
                const snapshot = slot === "A" ? snapshotA : snapshotB;
                const side = comparisonCurrent && comparison ? (slot === "A" ? comparison.a : comparison.b) : null;
                const gain = slot === "A" ? comparisonGainA : comparisonGainB;
                return (
                  <article className="mastering-session-version" key={slot} aria-label={`Session version ${slot}`}>
                    <label>
                      <strong>VERSION {slot} NAME</strong>
                      <input
                        aria-label={`Name for version ${slot}`}
                        value={versionNames[slot]}
                        maxLength={64}
                        disabled={Boolean(busy)}
                        onChange={(event) => setVersionNames((current) => ({ ...current, [slot]: event.target.value }))}
                      />
                    </label>
                    <span className="mastering-session-version-state">
                      {snapshot ? `Saved · ${new Date(snapshot.capturedAt).toLocaleString()}` : "Empty slot"}
                    </span>
                    <div className="mastering-session-version-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={Boolean(busy) || dirty}
                        onClick={() => void saveSnapshot(slot)}
                      >
                        Save current to {slot}
                      </button>
                      {snapshot && (
                        <>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={Boolean(busy) || dirty}
                            onClick={() => void loadSnapshot(slot)}
                          >
                            Load {slot} into session
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={Boolean(busy)}
                            onClick={() => void clearSnapshot(slot)}
                          >
                            Clear {slot}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={!comparisonCurrent || Boolean(busy)}
                        onClick={() => playComparedVersion(slot)}
                      >
                        {playing === slot ? `Playing ${slot}…` : `Listen to ${slot}`}
                      </button>
                      {playing === slot && (
                        <button type="button" className="btn btn-small" onClick={stopSessionPreview}>
                          Stop audition
                        </button>
                      )}
                    </div>
                    {side && (
                      <dl>
                        <div>
                          <dt>Integrated</dt>
                          <dd>{side.measurements.lufsIntegrated.toFixed(1)} LUFS</dd>
                        </div>
                        <div>
                          <dt>True peak</dt>
                          <dd>{side.measurements.truePeakDb.toFixed(1)} dBTP</dd>
                        </div>
                        <div>
                          <dt>Audition trim</dt>
                          <dd>
                            {matchLoudness && comparisonMatchTarget === null ? "unavailable" : formatCompareGain(gain)}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </article>
                );
              })}
            </div>
            <small className="mastering-session-ab-note">
              {comparisonCurrent
                ? `A/B render · ${sampleRate / 1000} kHz · Studio HQ${matchLoudness && comparisonMatchTarget === null ? " · loudness match unavailable" : ""}`
                : snapshotA && snapshotB
                  ? `Estimated comparison memory ${formatBytes(comparisonEstimateBytes)} / 512 MiB.`
                  : "Capture applied settings into both slots to enable comparison."}
            </small>
          </section>

          <section className="mastering-session-reference" aria-label="External mastering reference">
            <header>
              <div>
                <strong>REFERENCE COMPARISON</strong>
                <p>Import a read-only WAV/MP3 and compare it with the current rendered master.</p>
              </div>
              <label className="mastering-session-reference-import">
                <span>{reference ? "Replace reference" : "Import reference WAV / MP3"}</span>
                <input
                  type="file"
                  aria-label="Import external mastering reference WAV or MP3"
                  accept=".wav,.wave,.mp3,audio/wav,audio/mpeg"
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void importReference(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </header>
            <small>The reference stays local to this session and is never processed or included in its export.</small>
            {reference && (
              <div className="mastering-session-reference-details">
                <strong>{reference.record.fileName}</strong>
                <span>
                  {formatBytes(reference.record.byteLength)} · {reference.record.durationSeconds.toFixed(1)} s ·{" "}
                  {reference.record.channels} ch · {reference.sampleRate} Hz
                </span>
                <span>
                  {reference.measurements.lufsIntegrated.toFixed(1)} LUFS-I ·{" "}
                  {reference.measurements.truePeakDb.toFixed(1)} dBTP
                </span>
                <div>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!renderCurrent || Boolean(busy)}
                    onClick={() => playReferenceComparison("master")}
                  >
                    {playing === "master" ? "Playing session master…" : "Listen to session master"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!renderCurrent || Boolean(busy)}
                    onClick={() => playReferenceComparison("reference")}
                  >
                    {playing === "reference" ? "Playing reference…" : "Listen to reference"}
                  </button>
                  {(playing === "master" || playing === "reference") && (
                    <button type="button" className="btn btn-small" onClick={stopSessionPreview}>
                      Stop audition
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={Boolean(busy)}
                    onClick={() => void removeReference()}
                  >
                    Remove reference
                  </button>
                </div>
                {renderCurrent && rendered && (
                  <span>
                    Master: {rendered.measurements.lufsIntegrated.toFixed(1)} LUFS-I ·{" "}
                    {rendered.measurements.truePeakDb.toFixed(1)} dBTP · audition trims{" "}
                    {matchLoudness && referenceMatchTarget === null
                      ? "unavailable"
                      : `${formatCompareGain(referenceMasterGain)} / ${formatCompareGain(referenceAudioGain)}`}
                  </span>
                )}
              </div>
            )}
            {reference && !renderCurrent && (
              <small>Render the current session master to enable a level-matched audition.</small>
            )}
          </section>

          <div className="mastering-file-session-actions">
            <label>
              <strong>RENDER RATE</strong>
              <select
                aria-label="External mastering render sample rate"
                value={sampleRate}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  stopSessionPreview();
                  setComparison(null);
                  setSampleRate(Number(event.target.value) as 44_100 | 48_000);
                  setRendered(null);
                  setInspection(null);
                }}
              >
                <option value={44_100}>44.1 kHz</option>
                <option value={48_000}>48 kHz</option>
              </select>
            </label>
            <label>
              <strong>WAV BIT DEPTH</strong>
              <select
                aria-label="External mastering WAV bit depth"
                value={bitDepth}
                disabled={Boolean(busy)}
                onChange={(event) => setBitDepth(Number(event.target.value) as WavBitDepth)}
              >
                <option value={16}>16-bit PCM</option>
                <option value={24}>24-bit PCM</option>
                <option value={32}>32-bit float</option>
              </select>
            </label>
            <span className="mastering-file-session-budget">
              RENDER MEMORY {estimatedBytes > 0 ? formatBytes(estimatedBytes) : "—"} / 512 MiB
            </span>
            <div className="mastering-file-session-history" role="group" aria-label="External session settings history">
              <button
                type="button"
                className="btn btn-small"
                disabled={Boolean(busy) || dirty || session.undoStack.length === 0}
                onClick={() => void moveHistory("undo")}
              >
                Undo
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={Boolean(busy) || dirty || session.redoStack.length === 0}
                onClick={() => void moveHistory("redo")}
              >
                Redo
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={Boolean(busy) || !dirty}
                onClick={() => void applySettings()}
              >
                Apply settings
              </button>
            </div>
            <button
              type="button"
              className="btn btn-export"
              disabled={Boolean(busy) || !source || dirty || estimatedBytes > 512 * 1024 * 1024}
              onClick={() => void renderAndAnalyze()}
            >
              Render &amp; analyze
            </button>
            <button
              type="button"
              className="btn btn-export"
              disabled={Boolean(busy) || !renderCurrent}
              onClick={() => void exportWav()}
            >
              Encode &amp; export WAV
            </button>
          </div>
          {estimatedBytes > 512 * 1024 * 1024 && (
            <p className="mastering-file-session-status" data-state="warn" role="status">
              This render exceeds the 512 MiB session limit. Try 44.1 kHz or import a shorter mixdown.
            </p>
          )}
        </>
      )}

      {busy && (
        <div className="mastering-file-session-status" role="status">
          <span>
            {busy}
            {progress ? ` · ${progress}` : ""}
          </span>
          {operation.current && (
            <button type="button" className="btn btn-small" onClick={() => operation.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="mastering-file-session-status" data-state="error" role="alert">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mastering-file-session-status" data-state="notice" role="status">
          {notice}
        </p>
      )}
      {rendered && renderCurrent && (
        <div className="mastering-file-session-report" aria-label="Rendered master measurements">
          <strong>
            {inspection?.decode.status === "measured"
              ? "DECODED WAV · POST-ENCODE"
              : inspection
                ? "RENDER PCM · ENCODED WAV NOT MEASURED"
                : "RENDER PCM · PRE-ENCODE"}
          </strong>
          <span>{outputMeasurements?.lufsIntegrated.toFixed(1)} LUFS</span>
          <span>{outputMeasurements?.truePeakDb.toFixed(1)} dBTP</span>
          <span>
            {rendered.buffer.duration.toFixed(1)} s · {rendered.buffer.numberOfChannels} ch ·{" "}
            {rendered.sampleRate / 1000} kHz
          </span>
          {inspection && (
            <small>
              {inspection.decode.status === "measured"
                ? `Decoded WAV · ${inspection.decode.measurements?.lufsIntegrated.toFixed(1)} LUFS · ${inspection.decode.measurements?.truePeakDb.toFixed(1)} dBTP`
                : `Container checked · post-decode measurement unavailable: ${inspection.decode.reason ?? "not measured"}`}
            </small>
          )}
          {deliveryVerdict && (
            <div className="mastering-file-session-verdict" data-state={deliveryVerdict.status}>
              <strong>
                {inspection?.decode.status === "measured" ? "DECODED WAV" : "RENDER PCM"} DELIVERY TARGET CHECK ·{" "}
                {deliveryVerdict.status.toUpperCase()}
              </strong>
              {deliveryVerdict.checks.map((check, index) => (
                <small key={`${check.line}-${index}`} data-state={check.status}>
                  {check.line}
                </small>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="mastering-file-session-note">
        Sessions and source files stay on this device. This independent mastering chain never edits the open KYX
        project. Import limits: 96 MiB, mono/stereo, 0.8 s–12 min.
      </p>
    </section>
  );
}
