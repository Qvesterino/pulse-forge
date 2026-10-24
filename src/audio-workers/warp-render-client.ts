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
 *
 * THE FALLBACK RULE. The synchronous core may run on the main thread only when
 * the worker never rendered the input: there is no worker at all, the render
 * is too short to be worth one, the payload could not be posted, or the worker
 * DIED without delivering a render (its module failed to load, or the delivery
 * threw). Once the worker has run the input and reported that it failed, the
 * identical core would fail identically on the main thread — that is not a
 * recovery, it is the same work twice with a frozen UI in between — so the
 * call REJECTS with the worker's own reason and the clip degrades to repitch.
 *
 * The two failure classes are distinguishable without a race: in the worker
 * the render lives inside a try/catch, so a failure ON THE INPUT is always
 * reported as a message ({error}) and never as an error event.
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
      // The worker RAN on this input and reported that it failed (the phase
      // vocoder threw). The identical core on the main thread would throw the
      // identical way, so the fallback is not a recovery here — it is the same
      // work twice with a frozen UI in between. The worker's reason is the
      // diagnosis, so it rides out with the rejection.
      const reason =
        typeof data?.error === "string" && data.error.length > 0 ? data.error : "worker reported a failure";
      fail(new Error(`warp render worker failed: ${reason}`));
    };
    /**
     * The worker DIED without delivering a render.
     *
     * In the warp worker the render lives inside a try/catch, so a failure ON
     * THE INPUT is always reported as a message ({error}) and never as an
     * error event. An error event therefore means the worker never delivered a
     * render at all: its module failed to load, or the delivery of the result
     * (or of the failure report) threw. In both cases the worker never
     * rendered this input — so the main thread may still do the work, and the
     * fallback is a RECOVERY rather than a repeat of a failure.
     *
     * If the fallback fails as well, the rejection carries BOTH reasons: the
     * worker's death and the main thread's own error. Nothing is dropped.
     */
    worker.onerror = (event: ErrorEvent) => {
      const reason = typeof event?.message === "string" && event.message.length > 0 ? event.message : "worker error";
      try {
        finish(runSync());
      } catch (error) {
        const syncReason = error instanceof Error ? error.message : String(error);
        fail(new Error(`warp render worker failed: ${reason}; the main-thread fallback failed too: ${syncReason}`));
      }
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
