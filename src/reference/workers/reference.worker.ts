/// <reference lib="webworker" />
import { analyzeReference } from "../analysis/analyzeReference";
import { transcribeTrack } from "../transcribe";
import type { ReferenceAudioMetadata, ReferenceOptions, ReferenceStage } from "../types";

/**
 * Wire format for the reference analyzer worker.
 *
 * Validated defensively before processing (extensions like React DevTools
 * occasionally postMessage into worker globals). Anything that doesn't
 * match the expected shape is silently ignored, mirroring
 * src/audio-workers/onset-detector.ts:96.
 */

export interface ReferenceWorkerRequest {
  type: "ANALYZE_REFERENCE";
  jobId: number;
  mono: Float32Array;
  /**
   * Original per-channel PCM, when the caller has it. Needed for the stereo
   * descriptor; a worker that only ever sees the mono downmix would report
   * width 0 for every file. Validated as an array of Float32Array so a
   * malformed payload degrades to mono rather than throwing.
   */
  channels?: Float32Array[];
  metadata: ReferenceAudioMetadata;
  options?: Partial<ReferenceOptions>;
}

export interface TranscribeWorkerRequest {
  type: "TRANSCRIBE_TRACK";
  jobId: number;
  mono: Float32Array;
  sampleRate: number;
  sections?: Array<{ role: string; startSec: number; endSec: number }>;
}

export type ReferenceWorkerResponse =
  | { type: "PROGRESS_STAGE"; jobId: number; stage: ReferenceStage }
  | { type: "TRANSCRIBE_RESULT"; jobId: number; payload: ReturnType<typeof transcribeTrack> }
  | { type: "REFERENCE_RESULT"; jobId: number; payload: ReturnType<typeof analyzeReference> }
  | { type: "REFERENCE_ERROR"; jobId: number; message: string };

interface MinimalDedicatedWorkerGlobalScope {
  postMessage: (msg: ReferenceWorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<ReferenceWorkerRequest | TranscribeWorkerRequest>) => void) | null;
}

const dedicated: MinimalDedicatedWorkerGlobalScope | undefined =
  typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function"
    ? (self as unknown as MinimalDedicatedWorkerGlobalScope)
    : undefined;

if (dedicated) {
  dedicated.onmessage = (event: MessageEvent<ReferenceWorkerRequest | TranscribeWorkerRequest>) => {
    const data = event.data;
    if (!data) return;
    // U6 — UN-SUNO transcription runs here so a 3-minute track never blocks
    // the main thread; same deterministic core as the sync path.
    if (data.type === "TRANSCRIBE_TRACK") {
      if (typeof data.jobId !== "number" || !(data.mono instanceof Float32Array)) return;
      if (typeof data.sampleRate !== "number" || !Number.isFinite(data.sampleRate) || data.sampleRate <= 0) return;
      try {
        const payload = transcribeTrack(data.mono, data.sampleRate, { sections: data.sections });
        dedicated.postMessage({
          type: "TRANSCRIBE_RESULT",
          jobId: data.jobId,
          payload,
        } satisfies ReferenceWorkerResponse);
      } catch (error) {
        dedicated.postMessage({
          type: "REFERENCE_ERROR",
          jobId: data.jobId,
          message: error instanceof Error ? error.message : "Unknown transcription failure.",
        } satisfies ReferenceWorkerResponse);
      }
      return;
    }
    if (data.type !== "ANALYZE_REFERENCE") return;
    if (typeof data.jobId !== "number" || !Number.isFinite(data.jobId)) return;
    if (!(data.mono instanceof Float32Array)) return;
    if (!data.metadata || typeof data.metadata.sampleRate !== "number" || !Number.isFinite(data.metadata.sampleRate))
      return;
    if (data.metadata.sampleRate <= 0) return;

    const { jobId, mono, metadata, options } = data;
    // A malformed channels payload degrades to mono (an honest width of 0)
    // rather than failing the whole analysis.
    const channels =
      Array.isArray(data.channels) && data.channels.every((c) => c instanceof Float32Array) ? data.channels : undefined;
    try {
      const payload = analyzeReference({
        mono,
        channels,
        metadata,
        options,
        onStage: (stage) =>
          dedicated.postMessage({ type: "PROGRESS_STAGE", jobId, stage } satisfies ReferenceWorkerResponse),
      });
      dedicated.postMessage({ type: "REFERENCE_RESULT", jobId, payload } satisfies ReferenceWorkerResponse);
    } catch (error) {
      dedicated.postMessage({
        type: "REFERENCE_ERROR",
        jobId,
        message: error instanceof Error ? error.message : "Unknown reference analysis failure.",
      } satisfies ReferenceWorkerResponse);
    }
  };
}
