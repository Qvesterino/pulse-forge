import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "../audio-engine/phase-vocoder";

/** Avoid paying worker startup/clone overhead for short renders. */
const WORKER_MIN_SAMPLES = 44100 * 2;

/**
 * Watchdog ceiling for the background render. Deliberately generous — a long
 * clip on a slow machine legitimately takes tens of seconds. Unlike the other
 * worker clients this one REJECTS on timeout instead of running the sync
 * fallback: the phase vocoder is the expensive path, and if a pathological
 * input hung the worker, running the identical core on the main thread would
 * freeze the UI permanently. A rejection releases the caller's in-flight claim
 * (warpManager) and degrades that clip to repitch.
 */
const WORKER_TIMEOUT_MS = 120_000;

/**
 * Render a pitch-preserving warp without blocking the main thread.
 *
 * The channel views are copied before transfer because transferring the
 * originals would detach buffers owned by the project/audio bank. Without a
 * module-worker environment (or for short renders, or on abort/error) the
 * same pure core runs synchronously — deterministic either way, so a warmed
 * live cache and the offline render are sample-exact.
 */
export function renderWarpPreserveAsync(
  channels: Float32Array[],
  sampleRate: number,
  intervals: WarpRateInterval[],
  outLen: number,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const runSync = (): Float32Array[] => {
    const rateAt = warpRateEnvelope(intervals);
    return channels.map((ch) => phaseVocoderWarpChannel(ch, sampleRate, rateAt, Math.floor(outLen)));
  };
  if (signal?.aborted) return Promise.resolve([]);
  const total = channels.reduce((sum, ch) => sum + ch.length, 0);
  if (
    typeof Worker === "undefined" ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(outLen) ||
    outLen <= 0 ||
    total < WORKER_MIN_SAMPLES
  ) {
    return Promise.resolve(runSync());
  }

  return new Promise<Float32Array[]>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./warp-render.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(runSync());
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    const settle = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      removeAbortListener();
      worker.terminate();
    };
    const finish = (result: Float32Array[]) => {
      if (settled) return;
      settled = true;
      settle();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      settle();
      reject(error);
    };
    worker.onmessage = (event: MessageEvent<{ channels?: unknown; error?: unknown }>) => {
      const data = event.data;
      if (data && Array.isArray(data.channels) && data.channels.every((c) => c instanceof Float32Array)) {
        finish(data.channels as Float32Array[]);
        return;
      }
      // The worker reported its OWN failure and told us why. That reason must
      // not be dropped — and the expensive core must not be re-run on the main
      // thread after the worker already failed on that very input: this
      // client's contract is that a failed worker REJECTS ("running the
      // identical core on the main thread would freeze the UI permanently").
      // The synchronous fallback stays where it belongs — for the cases where
      // there is no usable worker at all.
      const reason =
        typeof data?.error === "string" && data.error.length > 0 ? data.error : "worker reported a failure";
      fail(new Error(`warp render worker failed: ${reason}`));
    };
    // Audit 12 D1: a throw inside runSync() must REJECT (settling the
    // promise) rather than escaping the handler and leaving the promise
    // pending forever — callers claim their cache key until settlement.
    worker.onerror = (event: ErrorEvent) => {
      const reason = typeof event?.message === "string" && event.message.length > 0 ? event.message : "worker error";
      fail(new Error(`warp render worker failed: ${reason}`));
    };
    timer = setTimeout(
      () => fail(new Error("Warp render worker timed out; this clip falls back to repitch")),
      WORKER_TIMEOUT_MS,
    );
    if (signal) {
      const onAbort = () => finish([]);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish([]);
        return;
      }
    }

    try {
      const copies = channels.map((ch) => Float32Array.from(ch));
      worker.postMessage(
        { channels: copies, sampleRate, intervals, outLen: Math.floor(outLen) },
        copies.map((c) => c.buffer),
      );
    } catch {
      try {
        finish(runSync());
      } catch (error) {
        fail(error);
      }
    }
  });
}
