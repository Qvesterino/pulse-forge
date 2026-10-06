import type { MasterBufferAnalysis, MasterAnalysisProgressListener } from "./analysis";
import { analyzeMasterBuffer } from "./analysis";
import type { MasterProfile } from "./profiles";
import type { LoudnessTimeline } from "../audio-engine/kweighting";

const WORKER_MIN_SECONDS = 0.5;
const CHUNK_FRAMES = 131_072;
const MAX_ANALYSIS_SECONDS = 12 * 60 * 60;
const WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
let nextJobId = 1;

export interface AnalyzeMasterBufferOptions {
  signal?: AbortSignal;
  onProgress?: MasterAnalysisProgressListener;
}

export interface MasterPcmStreamSource {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  /** Return fresh channel chunks; ownership transfers to the worker. */
  readChunk(offset: number, length: number): Float32Array[] | Promise<Float32Array[]>;
}

function abortError(): DOMException {
  return new DOMException("Master analysis cancelled", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isLoudnessTimeline(value: unknown): value is LoudnessTimeline | null {
  if (value === null) return true;
  if (!isRecord(value) || !Array.isArray(value.points) || value.points.length === 0 || value.points.length > 1200)
    return false;
  if (
    value.windowSeconds !== 3 ||
    value.startSeconds !== 3 ||
    typeof value.hopSeconds !== "number" ||
    !Number.isFinite(value.hopSeconds) ||
    value.hopSeconds <= 0 ||
    value.hopSeconds > 0.1 ||
    typeof value.durationSeconds !== "number" ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds < 3 ||
    !Number.isInteger(value.sourceWindowCount) ||
    (value.sourceWindowCount as number) < value.points.length
  ) {
    return false;
  }
  let previousTime = value.startSeconds as number;
  return value.points.every((point) => {
    if (
      !isRecord(point) ||
      typeof point.timeSeconds !== "number" ||
      !Number.isFinite(point.timeSeconds) ||
      typeof point.lowLufs !== "number" ||
      !Number.isFinite(point.lowLufs) ||
      typeof point.meanLufs !== "number" ||
      !Number.isFinite(point.meanLufs) ||
      typeof point.highLufs !== "number" ||
      !Number.isFinite(point.highLufs) ||
      (point.lowLufs as number) > (point.meanLufs as number) ||
      (point.meanLufs as number) > (point.highLufs as number) ||
      (point.timeSeconds as number) < previousTime ||
      (point.timeSeconds as number) > (value.durationSeconds as number)
    ) {
      return false;
    }
    previousTime = point.timeSeconds as number;
    return true;
  });
}

function isMasterBufferAnalysis(value: unknown): value is MasterBufferAnalysis {
  if (!isRecord(value) || !isRecord(value.measurements) || !isRecord(value.mixHealth) || !isRecord(value.verdict))
    return false;
  const measurements = value.measurements;
  const mixHealth = value.mixHealth;
  const verdict = value.verdict;
  const finiteMeasurements = Object.values(measurements).every(isFiniteOrNull);
  const finiteBandShares =
    isRecord(mixHealth.bandShares) &&
    Object.values(mixHealth.bandShares).every((share) => typeof share === "number" && Number.isFinite(share));
  const validFlags =
    Array.isArray(mixHealth.flags) &&
    mixHealth.flags.every(
      (flag) =>
        isRecord(flag) &&
        (flag.severity === "red" || flag.severity === "yellow") &&
        typeof flag.check === "string" &&
        typeof flag.detail === "string",
    );
  const validChecks =
    Array.isArray(verdict.checks) &&
    verdict.checks.every(
      (check) =>
        isRecord(check) &&
        ["pass", "warn", "fail", "not-measured"].includes(String(check.status)) &&
        typeof check.line === "string",
    );
  return (
    Number.isInteger(measurements.channelCount) &&
    finiteMeasurements &&
    isLoudnessTimeline(value.loudnessTimeline) &&
    typeof mixHealth.durationSec === "number" &&
    Number.isFinite(mixHealth.durationSec) &&
    Number.isFinite(mixHealth.peak) &&
    Number.isInteger(mixHealth.clippedSamples) &&
    Number.isFinite(mixHealth.headroomDb) &&
    Number.isFinite(mixHealth.crestDb) &&
    Number.isFinite(mixHealth.dcOffset) &&
    (mixHealth.integratedLufs === null || Number.isFinite(mixHealth.integratedLufs)) &&
    (mixHealth.momentaryMaxLufs === null || Number.isFinite(mixHealth.momentaryMaxLufs)) &&
    finiteBandShares &&
    Number.isFinite(mixHealth.lowEndShare) &&
    (mixHealth.stereoCorrelation === null || Number.isFinite(mixHealth.stereoCorrelation)) &&
    typeof mixHealth.ok === "boolean" &&
    validFlags &&
    ["idle", "ok", "warn", "bad"].includes(String(verdict.level)) &&
    ["pass", "warn", "fail", "not-measured"].includes(String(verdict.status)) &&
    typeof verdict.headline === "string" &&
    Array.isArray(verdict.hints) &&
    verdict.hints.every((hint) => typeof hint === "string") &&
    Number.isFinite(verdict.loudnessDeltaDb) &&
    validChecks
  );
}

function emitProgress(onProgress: MasterAnalysisProgressListener | undefined, progress: number, stage: string): void {
  try {
    onProgress?.({ progress: Math.max(0, Math.min(1, progress)), stage });
  } catch {
    // Progress display must never fail the audio analysis.
  }
}

/** Analyze a PCM source incrementally in a worker without allocating a full decoded buffer. */
export function analyzeMasterPcmStreamAsync(
  source: MasterPcmStreamSource,
  profile: MasterProfile,
  options: AnalyzeMasterBufferOptions = {},
): Promise<MasterBufferAnalysis> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (
    !Number.isFinite(source.sampleRate) ||
    source.sampleRate < 8000 ||
    source.sampleRate > 384000 ||
    !Number.isInteger(source.channelCount) ||
    source.channelCount < 1 ||
    source.channelCount > 2 ||
    !Number.isSafeInteger(source.frameCount) ||
    source.frameCount <= 0 ||
    typeof source.readChunk !== "function"
  ) {
    return Promise.reject(new Error("Master analysis requires a valid mono or stereo PCM source."));
  }
  if (source.frameCount / source.sampleRate > MAX_ANALYSIS_SECONDS) {
    return Promise.reject(new Error(`Master analysis is limited to ${MAX_ANALYSIS_SECONDS / 3600} hours per render.`));
  }
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("This browser cannot run the mastering analysis worker for longer audio."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./analysisWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.reject(
      new Error(
        `Could not start the mastering analysis worker: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const jobId = nextJobId++;
  return new Promise<MasterBufferAnalysis>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let currentOffset = 0;
    let pendingChunk: { offset: number; length: number } | null = null;
    let readingChunk = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    const finish = (result?: MasterBufferAnalysis, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      removeAbortListener();
      worker.terminate();
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Master analysis worker returned no result."));
    };
    const resetWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(undefined, new Error("Master analysis worker stopped responding for 3 minutes.")),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };
    const sendNextChunk = async (): Promise<void> => {
      if (settled || !ready || readingChunk || pendingChunk) return;
      if (currentOffset >= source.frameCount) {
        try {
          worker.postMessage({ type: "MASTER_ANALYSIS_FINISH", jobId });
          resetWatchdog();
          emitProgress(onProgress, 0.9, "Finalizing mastering measurements");
        } catch (error) {
          finish(
            undefined,
            new Error(`Could not start analysis: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
        return;
      }
      readingChunk = true;
      const offset = currentOffset;
      const length = Math.min(CHUNK_FRAMES, source.frameCount - currentOffset);
      try {
        const chunks = await source.readChunk(offset, length);
        if (settled) return;
        readingChunk = false;
        if (
          !Array.isArray(chunks) ||
          chunks.length !== source.channelCount ||
          chunks.some((chunk) => !(chunk instanceof Float32Array) || chunk.length !== length)
        ) {
          finish(undefined, new Error("PCM source returned a malformed mastering-analysis chunk."));
          return;
        }
        pendingChunk = { offset, length };
        worker.postMessage(
          { type: "MASTER_ANALYSIS_CHUNK", jobId, offset, channels: chunks },
          chunks.map((chunk) => chunk.buffer),
        );
        resetWatchdog();
      } catch (error) {
        readingChunk = false;
        finish(
          undefined,
          new Error(
            `Could not transfer PCM to the analysis worker: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.jobId !== jobId || typeof event.data.type !== "string") return;
      const message = event.data;
      if (message.type === "MASTER_ANALYSIS_READY") {
        ready = true;
        resetWatchdog();
        void sendNextChunk();
        return;
      }
      if (message.type === "MASTER_ANALYSIS_CHUNK_ACK") {
        const { offset, length } = message;
        const ackProgress = message.progress;
        if (
          !pendingChunk ||
          offset !== pendingChunk.offset ||
          length !== pendingChunk.length ||
          typeof ackProgress !== "number" ||
          !Number.isFinite(ackProgress) ||
          ackProgress < 0 ||
          ackProgress > 1 ||
          Math.abs(ackProgress - (pendingChunk.offset + pendingChunk.length) / source.frameCount) > 1e-6
        ) {
          finish(undefined, new Error("Master analysis worker returned an invalid PCM acknowledgement."));
          return;
        }
        resetWatchdog();
        currentOffset += pendingChunk.length;
        pendingChunk = null;
        const overallProgress = 0.05 + (currentOffset / source.frameCount) * 0.84;
        emitProgress(onProgress, overallProgress, "Analyzing audio in bounded worker chunks");
        void sendNextChunk();
        return;
      }
      if (message.type === "MASTER_ANALYSIS_PROGRESS") {
        if (
          typeof message.progress === "number" &&
          Number.isFinite(message.progress) &&
          message.progress >= 0 &&
          message.progress <= 1 &&
          typeof message.stage === "string" &&
          message.stage.length <= 120
        ) {
          resetWatchdog();
          emitProgress(onProgress, message.progress, message.stage);
        }
        return;
      }
      if (message.type === "MASTER_ANALYSIS_RESULT") {
        if (!isMasterBufferAnalysis(message.analysis)) {
          finish(undefined, new Error("Master analysis worker returned an invalid report."));
          return;
        }
        if (
          message.analysis.measurements.channelCount !== source.channelCount ||
          Math.abs(message.analysis.mixHealth.durationSec - source.frameCount / source.sampleRate) >
            1 / source.sampleRate
        ) {
          finish(undefined, new Error("Master analysis worker returned measurements for a different PCM buffer."));
          return;
        }
        finish(message.analysis);
        return;
      }
      if (message.type === "MASTER_ANALYSIS_ERROR") {
        const errorText =
          typeof message.message === "string" ? message.message.slice(0, 500) : "Master analysis failed.";
        finish(undefined, new Error(errorText));
      }
    });
    worker.addEventListener("error", (event) => {
      finish(undefined, new Error(`Master analysis worker failed: ${event.message || "unknown worker error"}`));
    });
    worker.addEventListener("messageerror", () => {
      finish(undefined, new Error("Master analysis worker could not decode its response."));
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

    emitProgress(onProgress, 0, "Starting streaming mastering analysis worker");
    try {
      resetWatchdog();
      worker.postMessage({
        type: "MASTER_ANALYSIS_START",
        jobId,
        sampleRate: source.sampleRate,
        frameCount: source.frameCount,
        channelCount: source.channelCount,
        profile,
      });
    } catch (error) {
      finish(
        undefined,
        new Error(`Could not start PCM transfer: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  });
}

/** Run the canonical report analysis in a cancellable, bounded-memory worker. */
export function analyzeMasterBufferAsync(
  buffer: AudioBuffer,
  profile: MasterProfile,
  options: AnalyzeMasterBufferOptions = {},
): Promise<MasterBufferAnalysis> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 || buffer.length <= 0) {
    return Promise.reject(new Error("Master analysis requires a non-empty mono or stereo render."));
  }
  if (!Number.isSafeInteger(buffer.length) || buffer.duration > MAX_ANALYSIS_SECONDS) {
    return Promise.reject(new Error(`Master analysis is limited to ${MAX_ANALYSIS_SECONDS / 3600} hours per render.`));
  }
  if (buffer.duration < WORKER_MIN_SECONDS) {
    try {
      return Promise.resolve(
        analyzeMasterBuffer(buffer, profile, (update) => emitProgress(onProgress, update.progress, update.stage)),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return analyzeMasterPcmStreamAsync(
    {
      sampleRate: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
      frameCount: buffer.length,
      readChunk(offset, length) {
        return Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
          const channelData = buffer.getChannelData(channel);
          return new Float32Array(channelData.subarray(offset, offset + length));
        });
      },
    },
    profile,
    options,
  );
}
