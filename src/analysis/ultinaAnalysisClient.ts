import type { AnalysisRequest, AnalysisResult } from "../effects/ultina-core/analysis/assistant";
import type {
  UltinaAnalysisWorkerRequest,
  UltinaAnalysisWorkerResponse,
  UltinaTargetCurveResult,
} from "./ultinaAnalysisWorker";

export class UltinaAnalysisCancelledError extends Error {
  constructor() {
    super("VLYX analysis cancelled");
    this.name = "UltinaAnalysisCancelledError";
  }
}

export function isUltinaAnalysisCancelledError(error: unknown): error is UltinaAnalysisCancelledError {
  return error instanceof UltinaAnalysisCancelledError;
}

export interface UltinaAnalysisTask<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * Watchdog ceiling, mirroring the mastering analysis client's idle bound. The
 * worker is fast for real material; three minutes means either a pathological
 * input or a worker that was killed without firing `error` (OOM reclaim) — in
 * both cases the caller must be settled rather than left pending, because the
 * panel's busy state clears in a `finally` that a hang never reaches.
 */
const ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000;

function copyChannels(channels: Float32Array[]): { channels: Float32Array[]; transfer: Transferable[] } {
  const copies = channels.map((channel) => channel.slice());
  return {
    channels: copies,
    transfer: copies.map((channel) => channel.buffer as ArrayBuffer),
  };
}

function startWorkerTask<T>(
  request: UltinaAnalysisWorkerRequest,
  transfer: Transferable[],
  readResponse: (response: UltinaAnalysisWorkerResponse) => T,
): UltinaAnalysisTask<T> {
  let worker: Worker | null = null;
  let settled = false;
  let rejectTask: (reason?: unknown) => void = () => undefined;

  const promise = new Promise<T>((resolve, reject) => {
    rejectTask = reject;
    if (typeof Worker === "undefined") {
      reject(new Error("VLYX analysis worker is unavailable in this browser."));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      worker?.terminate();
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      settle();
      resolve(value);
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      settle();
      reject(reason);
    };

    try {
      worker = new Worker(new URL("./ultinaAnalysisWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<UltinaAnalysisWorkerResponse>) => {
        try {
          succeed(readResponse(event.data));
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => {
        fail(new Error(event.message || "VLYX analysis worker failed."));
      };
      worker.onmessageerror = () => {
        fail(new Error("VLYX analysis worker returned an unreadable result."));
      };
      timer = setTimeout(
        () => fail(new Error("VLYX analysis timed out — the worker did not respond.")),
        ANALYSIS_TIMEOUT_MS,
      );
      worker.postMessage(request, transfer);
    } catch (error) {
      fail(error);
    }
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      rejectTask(new UltinaAnalysisCancelledError());
    },
  };
}

function readAnalysisResponse(response: UltinaAnalysisWorkerResponse): AnalysisResult {
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== "analysis") throw new Error("Unexpected VLYX analysis response.");
  return response.result;
}

function readTargetResponse(response: UltinaAnalysisWorkerResponse): UltinaTargetCurveResult {
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== "target-curve") throw new Error("Unexpected VLYX target response.");
  return response.result;
}

function readLoudnessResponse(response: UltinaAnalysisWorkerResponse): { integratedLufs: number | null } {
  if (!response.ok) throw new Error(response.error);
  if (response.kind !== "loudness") throw new Error("Unexpected VLYX loudness response.");
  const value = response.result.integratedLufs;
  if (value !== null && !Number.isFinite(value)) throw new Error("VLYX loudness response was not finite.");
  return { integratedLufs: value };
}

export function startUltinaAnalysis(
  request: AnalysisRequest,
  targetCurve?: number[],
): UltinaAnalysisTask<AnalysisResult> {
  const copied = copyChannels(request.channels);
  const workerRequest: UltinaAnalysisWorkerRequest = {
    id: 1,
    kind: "analyze",
    request: { ...request, channels: copied.channels },
    ...(targetCurve ? { targetCurve: [...targetCurve] } : {}),
  };
  return startWorkerTask(workerRequest, copied.transfer, readAnalysisResponse);
}

export function startUltinaTargetAnalysis(
  channels: Float32Array[],
  sampleRate: number,
): UltinaAnalysisTask<UltinaTargetCurveResult> {
  const copied = copyChannels(channels);
  return startWorkerTask(
    { id: 1, kind: "target-curve", channels: copied.channels, sampleRate },
    copied.transfer,
    readTargetResponse,
  );
}

/** Measure audition loudness off the UI thread without retaining full filtered copies. */
export function startUltinaLoudnessMeasurement(
  channels: Float32Array[],
  sampleRate: number,
): UltinaAnalysisTask<{ integratedLufs: number | null }> {
  const copied = copyChannels(channels);
  return startWorkerTask(
    { id: 1, kind: "loudness", channels: copied.channels, sampleRate },
    copied.transfer,
    readLoudnessResponse,
  );
}
