export interface FlacAudioDescriptor {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  bitDepth?: number;
}

export class FlacDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlacDataError";
  }
}

const FLAC_COPY_CHUNK_FRAMES = 131_072;
const FLAC_WORKER_OPERATION_TIMEOUT_MS = 120_000;

/** Peak retained memory while the decoder worker owns a file clone and PCM is copied into AudioBuffer. */
export function estimateFlacDecoderWorkingSetBytes(encodedBytes: number, pcmBytes: number, encodedCopies = 2): number {
  if (
    !Number.isSafeInteger(encodedBytes) ||
    encodedBytes <= 0 ||
    !Number.isSafeInteger(pcmBytes) ||
    pcmBytes <= 0 ||
    !Number.isInteger(encodedCopies) ||
    encodedCopies < 1 ||
    encodedCopies > 4
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const estimate = encodedBytes * encodedCopies + pcmBytes * 2;
  return Number.isSafeInteger(estimate) ? estimate : Number.POSITIVE_INFINITY;
}

function cancelledError(): DOMException {
  return new DOMException("FLAC decoding cancelled", "AbortError");
}

function awaitWithFlacAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal | undefined,
  abort: () => void,
  timeoutMs = FLAC_WORKER_OPERATION_TIMEOUT_MS,
): Promise<T> {
  if (signal?.aborted) {
    abort();
    return Promise.reject(cancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timeout !== null) clearTimeout(timeout);
      complete();
    };
    const onAbort = () =>
      finish(() => {
        abort();
        reject(cancelledError());
      });
    const onTimeout = () =>
      finish(() => {
        abort();
        reject(new Error("The FLAC worker did not finish within two minutes. Try a shorter file or another browser."));
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timeout = setTimeout(onTimeout, timeoutMs);
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (reason: unknown) => finish(() => reject(reason)),
    );
    if (signal?.aborted) onAbort();
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Decode FLAC in a terminable worker and reject any file with skipped/corrupt frames. */
export async function decodeFlacAudioBuffer(
  bytes: ArrayBuffer,
  expected: FlacAudioDescriptor,
  options: { maxPcmBytes: number; signal?: AbortSignal },
): Promise<AudioBuffer> {
  const { signal, maxPcmBytes } = options;
  if (signal?.aborted) throw cancelledError();
  if (
    bytes.byteLength < 42 ||
    !Number.isSafeInteger(expected.sampleRate) ||
    expected.sampleRate < 8000 ||
    expected.sampleRate > 192000 ||
    !Number.isInteger(expected.channels) ||
    expected.channels < 1 ||
    expected.channels > 8 ||
    !Number.isFinite(expected.durationSeconds) ||
    expected.durationSeconds <= 0 ||
    (expected.bitDepth !== undefined &&
      (!Number.isInteger(expected.bitDepth) || expected.bitDepth < 4 || expected.bitDepth > 32))
  ) {
    throw new Error("The FLAC decoder received invalid file metadata.");
  }
  const expectedFrames = Math.round(expected.durationSeconds * expected.sampleRate);
  const pcmBytes = expectedFrames * expected.channels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0 || !Number.isSafeInteger(pcmBytes)) {
    throw new Error("The FLAC file declares an unsupported decoded duration.");
  }
  if (!Number.isFinite(maxPcmBytes) || pcmBytes > maxPcmBytes) {
    throw new Error("The decoded FLAC would exceed KYX's working-memory limit.");
  }

  let FLACDecoderWebWorker: typeof import("@wasm-audio-decoders/flac").FLACDecoderWebWorker;
  try {
    ({ FLACDecoderWebWorker } = await awaitWithFlacAbort(import("@wasm-audio-decoders/flac"), signal, () => undefined));
  } catch (reason) {
    if (signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) throw reason;
    throw new Error("KYX could not load its FLAC decoder. Check the connection, then retry or use a WAV file.");
  }
  if (signal?.aborted) throw cancelledError();
  let decoder: InstanceType<typeof FLACDecoderWebWorker> & { terminate(): void };
  try {
    decoder = new FLACDecoderWebWorker() as InstanceType<typeof FLACDecoderWebWorker> & { terminate(): void };
  } catch {
    throw new Error(
      "This browser could not start KYX's FLAC decoder worker. Allow Web Workers and WebAssembly, or use WAV.",
    );
  }
  let decoderTerminated = false;
  let decoderFreed = false;
  const terminateDecoder = () => {
    if (decoderTerminated || decoderFreed) return;
    decoderTerminated = true;
    decoder.terminate();
  };

  try {
    await awaitWithFlacAbort(decoder.ready, signal, terminateDecoder);
    const decoded = await awaitWithFlacAbort(decoder.decodeFile(new Uint8Array(bytes)), signal, terminateDecoder);
    await awaitWithFlacAbort(decoder.free(), signal, terminateDecoder);
    decoderFreed = true;

    if (
      !decoded ||
      !Array.isArray(decoded.errors) ||
      !Array.isArray(decoded.channelData) ||
      !Number.isSafeInteger(decoded.samplesDecoded) ||
      !Number.isInteger(decoded.sampleRate) ||
      !Number.isInteger(decoded.bitDepth)
    ) {
      throw new FlacDataError("The FLAC decoder returned incomplete audio metadata.");
    }
    if (decoded.errors.length > 0) {
      const firstMessage = decoded.errors[0]?.message;
      const firstError = typeof firstMessage === "string" ? firstMessage.slice(0, 240) : "frame decode error";
      throw new FlacDataError(
        `The FLAC contains ${decoded.errors.length} damaged or unreadable frame(s): ${firstError}`,
      );
    }
    if (
      decoded.samplesDecoded !== expectedFrames ||
      decoded.sampleRate !== expected.sampleRate ||
      decoded.channelData.length !== expected.channels ||
      (expected.bitDepth !== undefined && decoded.bitDepth !== expected.bitDepth)
    ) {
      throw new FlacDataError("The decoded FLAC sample count or audio metadata does not match STREAMINFO.");
    }
    if (signal?.aborted) throw cancelledError();

    const context = new OfflineAudioContext(1, 1, decoded.sampleRate);
    const buffer = context.createBuffer(decoded.channelData.length, decoded.samplesDecoded, decoded.sampleRate);
    for (let channel = 0; channel < decoded.channelData.length; channel++) {
      const source = decoded.channelData[channel];
      const destination = buffer.getChannelData(channel);
      if (!(source instanceof Float32Array) || source.length !== decoded.samplesDecoded) {
        throw new FlacDataError("The FLAC decoder returned an incomplete channel.");
      }
      for (let start = 0; start < source.length; start += FLAC_COPY_CHUNK_FRAMES) {
        if (signal?.aborted) throw cancelledError();
        const end = Math.min(source.length, start + FLAC_COPY_CHUNK_FRAMES);
        for (let frame = start; frame < end; frame++) {
          if (!Number.isFinite(source[frame]))
            throw new FlacDataError("The FLAC decoder returned a non-finite sample.");
        }
        destination.set(source.subarray(start, end), start);
        if (end < source.length) await nextTask();
      }
    }
    return buffer;
  } finally {
    if (!decoderFreed && !decoderTerminated) await decoder.free().catch(() => undefined);
  }
}
