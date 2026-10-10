export interface Mp3PcmDecodeMetadata {
  sampleRate: number;
  channels: number;
}

export type Mp3PcmDecodeResult = { status: "decoded"; buffer: AudioBuffer } | { status: "unsupported"; reason: string };

const MAX_MP3_DECODE_BYTES = 96 * 1024 * 1024;
const WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
let nextRequestId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("MP3 decoding cancelled", "AbortError");
}

function emitProgress(
  onProgress: ((progress: number, stage: string) => void) | undefined,
  progress: number,
  stage: string,
): void {
  try {
    onProgress?.(Math.max(0, Math.min(1, progress)), stage);
  } catch {
    // Progress UI must not fail a decoded source.
  }
}

/** Use the bounded WebCodecs MP3 path when this browser exposes all required APIs. */
export function isBoundedMasteringMp3DecodeAvailable(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof AudioBuffer !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof EncodedAudioChunk !== "undefined"
  );
}

/** Decode MP3 frame ranges in two passes, then write acknowledged PCM batches into one AudioBuffer. */
export function decodeMp3BlobToAudioBuffer(
  blob: Blob,
  file: Mp3PcmDecodeMetadata,
  options: {
    maxPcmBytes: number;
    signal?: AbortSignal;
    onProgress?: (progress: number, stage: string) => void;
  },
): Promise<Mp3PcmDecodeResult> {
  const { signal, maxPcmBytes, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_MP3_DECODE_BYTES) {
    return Promise.reject(new Error("The MP3 source is empty or exceeds KYX's 96 MiB mastering-file limit."));
  }
  if (
    !Number.isSafeInteger(file.sampleRate) ||
    file.sampleRate < 8000 ||
    file.sampleRate > 192000 ||
    !Number.isInteger(file.channels) ||
    file.channels < 1 ||
    file.channels > 2 ||
    !Number.isSafeInteger(maxPcmBytes) ||
    maxPcmBytes <= 0
  ) {
    return Promise.reject(new Error("The MP3 decoder received invalid file metadata."));
  }
  if (!isBoundedMasteringMp3DecodeAvailable()) {
    return Promise.resolve({ status: "unsupported", reason: "This browser does not expose WebCodecs MP3 decoding." });
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./mp3PcmDecodeWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.resolve({
      status: "unsupported",
      reason: `Could not start the bounded MP3 decoder worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const requestId = nextRequestId++;
  return new Promise<Mp3PcmDecodeResult>((resolve, reject) => {
    let settled = false;
    let prepared = false;
    let target: AudioBuffer | null = null;
    let frameOffset = 0;
    let expectedSequence = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => {};

    const finish = (result?: Mp3PcmDecodeResult, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      removeAbortListener();
      worker.terminate();
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new Error("The MP3 decoder worker returned no result."));
    };
    const resetWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(undefined, new Error("The MP3 decoder worker stopped responding for 3 minutes.")),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };
    const fail = (reason: string): void => finish(undefined, new Error(reason.slice(0, 500)));

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.requestId !== requestId || typeof event.data.type !== "string") return;
      const message = event.data;
      if (message.type === "MP3_PCM_DECODE_PROGRESS") {
        if (
          typeof message.progress === "number" &&
          Number.isFinite(message.progress) &&
          message.progress >= 0 &&
          message.progress <= 0.24 &&
          typeof message.stage === "string" &&
          message.stage.length <= 120
        ) {
          resetWatchdog();
          const progress = prepared ? 0.2 + (message.progress / 0.24) * 0.75 : (message.progress / 0.24) * 0.2;
          emitProgress(onProgress, progress, message.stage);
        }
        return;
      }
      if (message.type === "MP3_PCM_DECODE_UNSUPPORTED") {
        const reason =
          typeof message.reason === "string" ? message.reason.slice(0, 500) : "WebCodecs MP3 decoding is unavailable.";
        if (prepared) fail(`The MP3 WebCodecs decoder became unavailable after buffer allocation: ${reason}`);
        else finish({ status: "unsupported", reason });
        return;
      }
      if (message.type === "MP3_PCM_DECODE_ERROR") {
        fail(typeof message.message === "string" ? message.message : "The MP3 decoder failed.");
        return;
      }
      if (message.type === "MP3_PCM_DECODE_PREPARE") {
        const frameCount = message.frameCount;
        if (
          prepared ||
          !Number.isSafeInteger(frameCount) ||
          (frameCount as number) <= 0 ||
          message.sampleRate !== file.sampleRate ||
          message.channels !== file.channels ||
          !Number.isSafeInteger((frameCount as number) * file.channels * Float32Array.BYTES_PER_ELEMENT) ||
          (frameCount as number) * file.channels * Float32Array.BYTES_PER_ELEMENT > maxPcmBytes
        ) {
          fail("The WebCodecs MP3 decoder reported an invalid duration or memory requirement.");
          return;
        }
        try {
          target = new AudioBuffer({
            length: frameCount as number,
            numberOfChannels: file.channels,
            sampleRate: file.sampleRate,
          });
        } catch (error) {
          fail(
            `The browser could not allocate the MP3 destination buffer: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        prepared = true;
        resetWatchdog();
        emitProgress(onProgress, 0.2, "Preparing the measured MP3 duration");
        worker.postMessage({ type: "MP3_PCM_DECODE_READY", requestId });
        return;
      }
      if (message.type === "MP3_PCM_DECODE_CHUNK") {
        const sequence = message.sequence;
        const chunkFrameOffset = message.frameOffset;
        const frameCount = message.frameCount;
        const channels = message.channels;
        if (
          !target ||
          !Number.isSafeInteger(sequence) ||
          sequence !== expectedSequence ||
          !Number.isSafeInteger(chunkFrameOffset) ||
          chunkFrameOffset !== frameOffset ||
          !Number.isSafeInteger(frameCount) ||
          (frameCount as number) <= 0 ||
          frameOffset + (frameCount as number) > target.length ||
          !Array.isArray(channels) ||
          channels.length !== file.channels ||
          channels.some((samples) => !(samples instanceof Float32Array) || samples.length !== frameCount)
        ) {
          fail("The MP3 decoder returned an invalid or out-of-order PCM batch.");
          return;
        }
        for (let channel = 0; channel < file.channels; channel++) {
          const destination = target.getChannelData(channel);
          const source = channels[channel];
          if (!(source instanceof Float32Array)) {
            fail("The MP3 decoder returned a missing audio channel.");
            return;
          }
          destination.set(source, frameOffset);
        }
        frameOffset += frameCount as number;
        expectedSequence++;
        resetWatchdog();
        emitProgress(
          onProgress,
          0.2 + Math.min(0.75, (frameOffset / target.length) * 0.75),
          "Copying decoded MP3 sample batches",
        );
        worker.postMessage({ type: "MP3_PCM_DECODE_ACK", requestId, sequence });
        return;
      }
      if (message.type === "MP3_PCM_DECODE_DONE") {
        if (!target || !prepared || frameOffset !== target.length || message.frameCount !== target.length) {
          fail("The MP3 decoder ended before it filled the measured destination buffer.");
          return;
        }
        emitProgress(onProgress, 1, "MP3 decode complete");
        finish({ status: "decoded", buffer: target });
      }
    });
    worker.addEventListener("error", (event) => {
      const reason = `MP3 decoder worker failed: ${event.message || "unknown worker error"}`;
      if (!prepared) finish({ status: "unsupported", reason });
      else finish(undefined, new Error(reason));
    });
    worker.addEventListener("messageerror", () => {
      if (!prepared) finish({ status: "unsupported", reason: "The MP3 worker could not start its WebCodecs decoder." });
      else finish(undefined, new Error("The MP3 decoder worker returned an unreadable response."));
    });

    if (signal) {
      const onAbort = () => finish(undefined, abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish(undefined, abortError());
        return;
      }
    }

    try {
      resetWatchdog();
      emitProgress(onProgress, 0, "Checking browser MP3 decoder support");
      worker.postMessage({ type: "MP3_PCM_DECODE_START", requestId, blob, expected: file });
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error("Could not start the bounded MP3 decoder worker."));
    }
  });
}
