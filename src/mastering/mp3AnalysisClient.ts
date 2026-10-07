import type { MasterBufferAnalysis, MasterAnalysisProgressListener } from "./analysis";
import { isMasterBufferAnalysisResult } from "./analysisClient";
import type { MasterProfile } from "./profiles";

const WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
let nextJobId = 1;

export interface Mp3DecodeMetadata {
  sampleRate: number;
  channels: number;
}

export type Mp3WorkerAnalysisResult =
  | {
      status: "measured";
      analysis: MasterBufferAnalysis;
      durationSeconds: number;
      averageBitrateKbps: number;
    }
  | { status: "unsupported"; reason: string };

function abortError(): DOMException {
  return new DOMException("Master inspection cancelled", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitProgress(onProgress: MasterAnalysisProgressListener | undefined, progress: number, stage: string): void {
  try {
    onProgress?.({ progress, stage });
  } catch {
    // Progress display must never fail the audio analysis.
  }
}

/** Decode and inspect an MP3 Blob frame-by-frame in a worker when WebCodecs supports it. */
export function analyzeMp3BlobAsync(
  blob: Blob,
  file: Mp3DecodeMetadata,
  profile: MasterProfile,
  options: { signal?: AbortSignal; onProgress?: MasterAnalysisProgressListener } = {},
): Promise<Mp3WorkerAnalysisResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (
    !(blob instanceof Blob) ||
    blob.size <= 0 ||
    !Number.isInteger(file.sampleRate) ||
    ![1, 2].includes(file.channels)
  ) {
    return Promise.reject(new Error("The MP3 worker requires a non-empty file with valid audio metadata."));
  }
  if (typeof Worker === "undefined")
    return Promise.resolve({
      status: "unsupported",
      reason: "This browser cannot run a background WebCodecs MP3 analysis worker.",
    });

  let worker: Worker;
  try {
    worker = new Worker(new URL("./mp3AnalysisWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.resolve({
      status: "unsupported",
      reason: `Could not start the background MP3 worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const jobId = nextJobId++;
  return new Promise<Mp3WorkerAnalysisResult>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    const finish = (result?: Mp3WorkerAnalysisResult, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      removeAbortListener();
      worker.terminate();
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new Error("MP3 analysis worker returned no result."));
    };
    const resetWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(undefined, new Error("The MP3 analysis worker stopped responding for 3 minutes.")),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.jobId !== jobId || typeof event.data.type !== "string") return;
      const message = event.data;
      if (message.type === "MP3_ANALYSIS_PROGRESS") {
        if (
          typeof message.progress === "number" &&
          Number.isFinite(message.progress) &&
          message.progress >= 0 &&
          message.progress <= 1 &&
          typeof message.stage === "string" &&
          message.stage.length <= 120
        ) {
          resetWatchdog();
          try {
            onProgress?.({ progress: message.progress, stage: message.stage });
          } catch {
            // Progress display must never fail the audio analysis.
          }
        }
        return;
      }
      if (message.type === "MP3_ANALYSIS_UNSUPPORTED") {
        const reason =
          typeof message.reason === "string" ? message.reason.slice(0, 500) : "WebCodecs MP3 decoding is unavailable.";
        finish({ status: "unsupported", reason });
        return;
      }
      if (message.type === "MP3_ANALYSIS_ERROR") {
        const reason = typeof message.message === "string" ? message.message.slice(0, 500) : "The MP3 decoder failed.";
        finish(undefined, new Error(reason));
        return;
      }
      if (message.type === "MP3_ANALYSIS_RESULT") {
        const { analysis, durationSeconds, sampleRate, channels, frameCount } = message;
        if (
          !isMasterBufferAnalysisResult(analysis) ||
          sampleRate !== file.sampleRate ||
          channels !== file.channels ||
          typeof frameCount !== "number" ||
          !Number.isSafeInteger(frameCount) ||
          frameCount <= 0 ||
          typeof durationSeconds !== "number" ||
          !Number.isFinite(durationSeconds) ||
          typeof message.averageBitrateKbps !== "number" ||
          !Number.isFinite(message.averageBitrateKbps) ||
          message.averageBitrateKbps <= 0 ||
          Math.abs(durationSeconds - frameCount / file.sampleRate) > 1 / file.sampleRate ||
          analysis.measurements.channelCount !== file.channels ||
          Math.abs(analysis.mixHealth.durationSec - durationSeconds) > 1 / file.sampleRate
        ) {
          finish(undefined, new Error("MP3 analysis worker returned an invalid report or duration."));
          return;
        }
        finish({ status: "measured", analysis, durationSeconds, averageBitrateKbps: message.averageBitrateKbps });
      }
    });
    worker.addEventListener("error", (event) => {
      finish(undefined, new Error(`MP3 analysis worker failed: ${event.message || "unknown worker error"}`));
    });
    worker.addEventListener("messageerror", () => {
      finish(undefined, new Error("MP3 analysis worker could not decode its response."));
    });

    if (signal) {
      const onAbort = () => finish(undefined, abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish(undefined, abortError());
        return;
      }
    }

    try {
      resetWatchdog();
      emitProgress(onProgress, 0, "Checking browser MP3 decoder support");
      worker.postMessage({
        type: "MP3_ANALYSIS_START",
        jobId,
        blob,
        file,
        profile,
      });
    } catch (error) {
      finish(
        undefined,
        new Error(`Could not start MP3 inspection: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  });
}
