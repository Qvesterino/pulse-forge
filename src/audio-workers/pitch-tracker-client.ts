import { trackPitch, type PitchFrame } from "./pitch-tracker";

/** Avoid paying worker startup/clone overhead for very short samples. */
const WORKER_MIN_SECONDS = 2;

/**
 * Run hum pitch tracking without blocking the UI for longer takes.
 *
 * The AudioBuffer channel is copied before transfer (transferring the bank's
 * view would detach it — onset-detector-client contract). If a browser cannot
 * construct module workers, the same pure tracker remains a deterministic
 * capability fallback.
 */
export function trackPitchAsync(data: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<PitchFrame[]> {
  if (signal?.aborted) return Promise.resolve([]);
  if (
    typeof Worker === "undefined" ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    data.length < sampleRate * WORKER_MIN_SECONDS
  ) {
    return Promise.resolve(trackPitch(data, sampleRate));
  }

  return new Promise<PitchFrame[]>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./pitch-tracker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(trackPitch(data, sampleRate));
      return;
    }

    let settled = false;
    let removeAbortListener: () => void = () => undefined;
    const finish = (frames: PitchFrame[]) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      worker.terminate();
      resolve(frames);
    };
    worker.onmessage = (event: MessageEvent<{ frames?: unknown }>) => {
      const raw = Array.isArray(event.data?.frames) ? event.data.frames : [];
      const frames = raw.filter(
        (frame): frame is PitchFrame =>
          !!frame &&
          typeof frame === "object" &&
          typeof (frame as PitchFrame).timeSec === "number" &&
          Number.isFinite((frame as PitchFrame).timeSec) &&
          typeof (frame as PitchFrame).midi === "number" &&
          typeof (frame as PitchFrame).clarity === "number" &&
          typeof (frame as PitchFrame).rms === "number",
      );
      finish(frames);
    };
    worker.onerror = () => finish(trackPitch(data, sampleRate));
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
      worker.postMessage({ channelData: copy, sampleRate }, [copy.buffer]);
    } catch {
      finish(trackPitch(data, sampleRate));
    }
  });
}
