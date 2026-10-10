export interface WavPcmDecodeDescriptor {
  channels: number;
  dataBytes: number;
  dataOffset: number;
  bitDepth: 16 | 24 | 32;
  blockAlign: number;
  formatCode: 1 | 3;
  frameCount: number;
  sampleRate: number;
}

export interface WavPcmDecodeProgress {
  progress: number;
  stage: string;
}

const WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
let nextRequestId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("WAV decode cancelled", "AbortError");
}

function emitProgress(onProgress: ((progress: WavPcmDecodeProgress) => void) | undefined, progress: number): void {
  try {
    onProgress?.({ progress: Math.max(0, Math.min(1, progress)), stage: "Decoding PCM WAV in bounded worker chunks" });
  } catch {
    // Progress UI must not fail a decoded source.
  }
}

/** Decode interleaved PCM ranges in a worker and copy one acknowledged chunk into the destination buffer at a time. */
export function decodeWavPcmBlobToAudioBuffer(
  blob: Blob,
  descriptor: WavPcmDecodeDescriptor,
  target: AudioBuffer,
  options: { signal?: AbortSignal; onProgress?: (progress: WavPcmDecodeProgress) => void } = {},
): Promise<void> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(blob instanceof Blob) || blob.size <= 0) return Promise.reject(new Error("The WAV source file is empty."));
  if (
    target.numberOfChannels !== descriptor.channels ||
    target.length !== descriptor.frameCount ||
    target.sampleRate !== descriptor.sampleRate
  ) {
    return Promise.reject(new Error("The WAV decode target does not match its inspected format."));
  }
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("This browser cannot run the bounded PCM WAV decoder worker."));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./wavPcmDecodeWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.reject(
      new Error(
        `Could not start the PCM WAV decoder worker: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const requestId = nextRequestId++;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let nextSequence = 0;
    let nextFrameOffset = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => {};
    const destinations = Array.from({ length: descriptor.channels }, (_, channel) => target.getChannelData(channel));

    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      removeAbortListener();
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const resetWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(new Error("The PCM WAV decoder worker stopped responding for 3 minutes.")),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };
    const fail = (message: string): void => finish(new Error(message.slice(0, 500)));

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.requestId !== requestId || typeof event.data.type !== "string") return;
      const message = event.data;
      if (message.type === "WAV_PCM_DECODE_CHUNK") {
        const frameOffset = message.frameOffset;
        const frameCount = message.frameCount;
        const channels = message.channels;
        const sequence = message.sequence;
        if (
          !Number.isSafeInteger(sequence) ||
          sequence !== nextSequence ||
          !Number.isSafeInteger(frameOffset) ||
          frameOffset !== nextFrameOffset ||
          !Number.isSafeInteger(frameCount) ||
          (frameCount as number) <= 0 ||
          (frameOffset as number) + (frameCount as number) > descriptor.frameCount ||
          !Array.isArray(channels) ||
          channels.length !== descriptor.channels ||
          channels.some((samples) => !(samples instanceof Float32Array) || samples.length !== frameCount)
        ) {
          fail("The PCM WAV decoder returned an invalid or out-of-order sample chunk.");
          return;
        }

        for (let channel = 0; channel < descriptor.channels; channel++) {
          const destination = destinations[channel];
          const source = channels[channel];
          if (!destination || !(source instanceof Float32Array)) {
            fail("The PCM WAV decoder returned a missing audio channel.");
            return;
          }
          destination.set(source, frameOffset as number);
        }
        nextFrameOffset += frameCount as number;
        nextSequence++;
        resetWatchdog();
        emitProgress(onProgress, nextFrameOffset / descriptor.frameCount);
        try {
          worker.postMessage({ type: "WAV_PCM_DECODE_ACK", requestId, sequence });
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Could not acknowledge a decoded WAV sample chunk."));
        }
        return;
      }
      if (message.type === "WAV_PCM_DECODE_DONE") {
        if (nextFrameOffset !== descriptor.frameCount) {
          fail("The PCM WAV decoder ended before it filled the inspected source duration.");
          return;
        }
        emitProgress(onProgress, 1);
        finish();
        return;
      }
      if (message.type === "WAV_PCM_DECODE_ERROR") {
        fail(typeof message.message === "string" ? message.message : "The PCM WAV decoder failed.");
      }
    });
    worker.addEventListener("error", (event) => {
      finish(new Error(`PCM WAV decoder worker failed: ${event.message || "unknown worker error"}`));
    });
    worker.addEventListener("messageerror", () => {
      finish(new Error("The PCM WAV decoder worker returned an unreadable response."));
    });

    if (signal) {
      const onAbort = () => finish(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish(abortError());
        return;
      }
    }

    try {
      resetWatchdog();
      emitProgress(onProgress, 0);
      worker.postMessage({ type: "WAV_PCM_DECODE_START", requestId, blob, descriptor });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not send the WAV source to the decoder worker."));
    }
  });
}
