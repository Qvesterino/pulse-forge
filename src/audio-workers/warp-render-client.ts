import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "../audio-engine/phase-vocoder";

/** Avoid paying worker startup/clone overhead for short renders. */
const WORKER_MIN_SAMPLES = 44100 * 2;

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
    let removeAbortListener: () => void = () => undefined;
    const finish = (result: Float32Array[]) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      worker.terminate();
      resolve(result);
    };
    worker.onmessage = (event: MessageEvent<{ channels?: unknown; error?: unknown }>) => {
      const data = event.data;
      if (data && Array.isArray(data.channels) && data.channels.every((c) => c instanceof Float32Array)) {
        finish(data.channels as Float32Array[]);
      } else {
        finish(runSync());
      }
    };
    // Audit 12 D1: a throw inside runSync() must REJECT (settling the
    // promise) rather than escaping the handler and leaving the promise
    // pending forever — callers claim their cache key until settlement.
    worker.onerror = () => {
      try {
        finish(runSync());
      } catch (error) {
        reject(error);
      }
    };
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
      finish(runSync());
    }
  });
}
