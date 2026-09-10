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

    try {
      worker = new Worker(new URL("./ultinaAnalysisWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<UltinaAnalysisWorkerResponse>) => {
        if (settled) return;
        settled = true;
        worker?.terminate();
        try {
          resolve(readResponse(event.data));
        } catch (error) {
          reject(error);
        }
      };
      worker.onerror = (event) => {
        if (settled) return;
        settled = true;
        worker?.terminate();
        reject(new Error(event.message || "VLYX analysis worker failed."));
      };
      worker.onmessageerror = () => {
        if (settled) return;
        settled = true;
        worker?.terminate();
        reject(new Error("VLYX analysis worker returned an unreadable result."));
      };
      worker.postMessage(request, transfer);
    } catch (error) {
      settled = true;
      worker?.terminate();
      reject(error);
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
