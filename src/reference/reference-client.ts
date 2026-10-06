import { analyzeReference, type AnalyzeReferenceInput, type AnalyzeReferenceOutput } from "./analysis/analyzeReference";
import { transcribeTrack, type UnsunoTranscription } from "./transcribe";
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
      // Channels are structured-cloned, NOT transferred: the main-thread
      // fallback path still needs them if the worker never answers, and
      // detaching them here would silently turn every stereo file into a
      // width-0 report on the exact machines that lack module workers.
      const channels = rest.channels?.map((c) => new Float32Array(c));
      worker.postMessage(
        {
          type: "ANALYZE_REFERENCE",
          jobId: Date.now() & 0xffff,
          mono: copy,
          channels,
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

/**
 * U6 — UN-SUNO transcription off the main thread: same deterministic core
 * as {@link transcribeTrack}, run in the reference worker for long buffers
 * so a 3-minute track never freezes the UI. Below the worker threshold (or
 * when module workers are unavailable) it degrades to the synchronous
 * main-thread call — still deterministic, just blocking.
 */
export function transcribeTrackAsync(
  pcm: Float32Array,
  sampleRate: number,
  options: {
    sections?: ReadonlyArray<{ role: string; startSec: number; endSec: number }>;
    separation?: "off" | "hpss" | "model";
    signal?: AbortSignal;
  } = {},
): Promise<UnsunoTranscription> {
  const run = (): UnsunoTranscription =>
    transcribeTrack(pcm, sampleRate, { sections: options.sections, separation: options.separation });
  if (options.signal?.aborted) return Promise.resolve(run());
  if (typeof Worker === "undefined" || pcm.length < WORKER_MIN_SAMPLES) {
    return Promise.resolve(run());
  }
  return new Promise<UnsunoTranscription>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./workers/reference.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(run());
      return;
    }
    let settled = false;
    const finish = (payload: UnsunoTranscription): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(payload);
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const msg = event.data as { type?: unknown; payload?: UnsunoTranscription } | null;
      if (!msg || msg.type !== "TRANSCRIBE_RESULT" || !msg.payload) return;
      finish(msg.payload);
    };
    const onError = (): void => finish(run());
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    try {
      const copy = new Float32Array(pcm);
      worker.postMessage(
        {
          type: "TRANSCRIBE_TRACK",
          jobId: Date.now() & 0xffff,
          mono: copy,
          sampleRate,
          sections: options.sections,
          separation: options.separation,
        },
        [copy.buffer],
      );
    } catch {
      finish(run());
    }
  });
}
