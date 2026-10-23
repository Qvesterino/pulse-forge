import { analyzeReference, type AnalyzeReferenceInput, type AnalyzeReferenceOutput } from "./analysis/analyzeReference";
import { transcribeTrack, type UnsunoTranscription } from "./transcribe";
import { separateTrackModel } from "../analysis/stem-model/client";
import type { ReferenceStage } from "./types";

/** Above this length (s × sr) we pay worker startup + transfer cost; below it we stay on the main thread. */
const WORKER_MIN_SAMPLES = 22050 * 2; // 2 seconds at 22.05 kHz
/**
 * Bounded wait for the reference worker. A worker can die WITHOUT firing
 * `error` (killed under memory pressure, module torn down) — without this the
 * returned promise never settles and the UI waits forever. 120 s matches the
 * heavy-render convention (warp-render); the deterministic sync path is the
 * documented degradation for a missing/failed worker.
 */
const REFERENCE_WORKER_TIMEOUT_MS = 120_000;

/**
 * Job ids must be UNIQUE, not merely present.
 *
 * The id used to be `Date.now() & 0xffff` — the low 16 bits of the clock.
 * That WRAPS every 65 536 ms, so two analyses a minute apart could carry the
 * same id. A monotonic counter cannot repeat, so a job id now identifies one
 * job for the whole session.
 */
let nextJobId = 1;
const newJobId = (): number => nextJobId++;

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const jobId = newJobId();
    const finish = (payload: AnalyzeReferenceOutput) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      removeAbortListener();
      worker.terminate();
      resolve(payload);
    };
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: unknown; jobId?: unknown; payload?: AnalyzeReferenceOutput } | null;
      if (!msg) return;
      // Every worker answer carries the id of the job it belongs to. An
      // answer for ANOTHER job is not ours — accepting it would settle this
      // call with a foreign result.
      if (msg.jobId !== jobId) return;
      // The worker reports its OWN failures as REFERENCE_ERROR (it catches
      // everything and posts the reason). The client used to ignore that
      // message, so a failed analysis waited the full 120 s timeout and only
      // then ran the synchronous fallback — two minutes of silence followed by
      // a main-thread freeze. An error the worker already told us about must
      // settle the promise NOW, exactly like the `error` event does.
      if (msg.type === "REFERENCE_ERROR") {
        finish(analyzeReference({ ...rest, onStage }));
        return;
      }
      if (msg.type !== "REFERENCE_RESULT" || !msg.payload) return;
      // Mirror progress stages to the caller so the UI sees the same
      // transitions whether we ran in a worker or on the main thread.
      finish(msg.payload);
    };
    const onWorkerError = () => finish(analyzeReference({ ...rest, onStage }));
    const onProgress = (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: unknown; jobId?: unknown; stage?: ReferenceStage } | null;
      if (msg?.type === "PROGRESS_STAGE" && msg.jobId === jobId && onStage && msg.stage) onStage(msg.stage);
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
          jobId,
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
    // Arm AFTER the post so a synchronous throw cannot leave a timer behind.
    if (!settled) {
      timer = setTimeout(
        () => finish(analyzeReference({ ...rest, onStage: () => undefined })),
        REFERENCE_WORKER_TIMEOUT_MS,
      );
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
  // S4 — the MODEL path orchestrates here: neural stems first (never-throw),
  // then the sync core reads them directly. Any failure degrades to the
  // requested non-model path, exactly like the model lanes' own fallback.
  if (options.separation === "model") {
    const runModel = async (): Promise<UnsunoTranscription> => {
      const model = await separateTrackModel(pcm, sampleRate, {
        maxSeconds: options.sections?.reduce((max, s) => Math.max(max, s.endSec), 0) || undefined,
        signal: options.signal,
      });
      if (model) {
        return transcribeTrack(pcm, sampleRate, {
          sections: options.sections,
          modelStems: {
            vocals: model.stems[0],
            drums: model.stems[1],
            bass: model.stems[2],
            chords: model.stems[3],
          },
        });
      }
      // model unavailable → hpss guide stems (Tier 1 fallback chain)
      return transcribeTrack(pcm, sampleRate, { sections: options.sections, separation: "hpss" });
    };
    return runModel();
  }
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
    let removeAbortListener: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const jobId = newJobId();
    const finish = (payload: UnsunoTranscription): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      removeAbortListener();
      worker.terminate();
      resolve(payload);
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const msg = event.data as { type?: unknown; jobId?: unknown; payload?: UnsunoTranscription } | null;
      if (!msg) return;
      // An answer for another job is not ours (see the analysis lane).
      if (msg.jobId !== jobId) return;
      // Same contract as the analysis lane: the worker posts TRANSCRIBE_ERROR
      // when it fails on its own, and that must settle the promise now rather
      // than after the 120 s timeout.
      if (msg.type === "TRANSCRIBE_ERROR") {
        finish(run());
        return;
      }
      if (msg.type !== "TRANSCRIBE_RESULT" || !msg.payload) return;
      finish(msg.payload);
    };
    const onError = (): void => finish(run());
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    // Abort DURING the wait must settle like the pre-check does (skip the
    // worker, compute synchronously). Without this listener an aborted
    // transcription still waited for the worker or the timeout.
    if (options.signal) {
      const onAbort = () => finish(run());
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        finish(run());
        return;
      }
    }
    try {
      const copy = new Float32Array(pcm);
      worker.postMessage(
        {
          type: "TRANSCRIBE_TRACK",
          jobId,
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
    // Arm AFTER the post so a synchronous throw cannot leave a timer behind.
    if (!settled) {
      timer = setTimeout(() => finish(run()), REFERENCE_WORKER_TIMEOUT_MS);
    }
  });
}
