import { analyzeReference, type AnalyzeReferenceInput, type AnalyzeReferenceOutput } from "./analysis/analyzeReference";
import type { ReferenceStage } from "./types";

/** Above this length (s × sr) we pay worker startup + transfer cost; below it we stay on the main thread. */
const WORKER_MIN_SAMPLES = 22050 * 2; // 2 seconds at 22.05 kHz

/**
 * Run the deterministic reference analyzer without blocking the UI on long
 * buffers. The AudioBuffer channel data is copied before transfer so the
 * project's audio-bank ownership is preserved. If a browser cannot
 * construct module workers, {@link analyzeReference} is invoked directly
 * on the main thread — still deterministic, just synchronous.
 *
 * Mirrors the pattern in src/audio-workers/onset-detector-client.ts.
 */
export function analyzeReferenceAsync(
  input: AnalyzeReferenceInput & { onStage?: (stage: ReferenceStage) => void; signal?: AbortSignal },
): Promise<AnalyzeReferenceOutput> {
  const { onStage, signal, ...rest } = input;
  const { mono } = rest;

  if (signal?.aborted) {
    return Promise.resolve(analyzeReference({ ...rest, onStage: () => undefined }));
  }

  if (
    typeof Worker === "undefined" ||
    !(mono instanceof Float32Array) ||
    !Number.isFinite(rest.metadata.sampleRate) ||
    rest.metadata.sampleRate <= 0 ||
    mono.length < WORKER_MIN_SAMPLES
  ) {
    return Promise.resolve(analyzeReference({ ...rest, onStage }));
  }

  return new Promise<AnalyzeReferenceOutput>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./workers/reference.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(analyzeReference({ ...rest, onStage }));
      return;
    }

    let settled = false;
    let removeAbortListener: () => void = () => undefined;
    const finish = (payload: AnalyzeReferenceOutput) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      worker.terminate();
      resolve(payload);
    };
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: unknown; payload?: AnalyzeReferenceOutput } | null;
      if (!msg || msg.type !== "REFERENCE_RESULT" || !msg.payload) return;
      // Mirror progress stages to the caller so the UI sees the same
      // transitions whether we ran in a worker or on the main thread.
      finish(msg.payload);
    };
    const onWorkerError = () => finish(analyzeReference({ ...rest, onStage }));
    const onProgress = (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: unknown; stage?: ReferenceStage } | null;
      if (msg?.type === "PROGRESS_STAGE" && onStage && msg.stage) onStage(msg.stage);
    };
    worker.addEventListener("message", onProgress);
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", onWorkerError);

    if (signal) {
      const onAbort = () => {
        finish(analyzeReference({ ...rest, onStage: () => undefined }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish(analyzeReference({ ...rest, onStage: () => undefined }));
        return;
      }
    }

    try {
      const copy = new Float32Array(mono);
      worker.postMessage(
        {
          type: "ANALYZE_REFERENCE",
          jobId: Date.now() & 0xffff,
          mono: copy,
          metadata: rest.metadata,
          options: rest.options,
        },
        [copy.buffer],
      );
    } catch {
      finish(analyzeReference({ ...rest, onStage }));
    }
  });
}
