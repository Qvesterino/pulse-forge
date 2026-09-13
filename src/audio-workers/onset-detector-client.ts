import { detectTransients } from "./onset-detector";

/** Avoid paying worker startup/clone overhead for very short samples. */
const WORKER_MIN_SECONDS = 2;

/**
 * Run onset detection without blocking the UI for longer samples.
 *
 * The AudioBuffer channel is copied before transfer because transferring the
 * original view would detach the buffer owned by the project/audio bank. If a
 * browser cannot construct module workers, the same pure detector remains a
 * deterministic capability fallback.
 */
export function detectTransientsAsync(
  data: Float32Array,
  sampleRate: number,
  sensitivity = 1,
  signal?: AbortSignal,
): Promise<number[]> {
  if (signal?.aborted) return Promise.resolve([]);
  if (
    typeof Worker === "undefined" ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    data.length < sampleRate * WORKER_MIN_SECONDS
  ) {
    return Promise.resolve(detectTransients(data, sampleRate, sensitivity));
  }

  return new Promise<number[]>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./onset-detector.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(detectTransients(data, sampleRate, sensitivity));
      return;
    }

    let settled = false;
    let removeAbortListener: () => void = () => undefined;
    const finish = (times: number[]) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      worker.terminate();
      resolve(times);
    };
    worker.onmessage = (event: MessageEvent<{ times?: unknown }>) => {
      const times = Array.isArray(event.data?.times)
        ? event.data.times.filter((time): time is number => typeof time === "number" && Number.isFinite(time))
        : [];
      finish(times);
    };
    worker.onerror = () => finish(detectTransients(data, sampleRate, sensitivity));
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
      const copy = new Float32Array(data);
      worker.postMessage({ channelData: copy, sampleRate, sensitivity }, [copy.buffer]);
    } catch {
      finish(detectTransients(data, sampleRate, sensitivity));
    }
  });
}
