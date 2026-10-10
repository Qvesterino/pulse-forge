import { mp3AudioStartOffset, parseMp3FrameHeader, sameMp3Stream, type Mp3FrameHeader } from "./mp3Frames";

const READ_BLOCK_BYTES = 128 * 1024;
const DECODE_BATCH_FRAMES = 64;
const MAX_DURATION_SECONDS = 12 * 60;

interface WorkerScope {
  AudioDecoder?: typeof AudioDecoder;
  EncodedAudioChunk?: typeof EncodedAudioChunk;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

interface ExpectedMp3 {
  channels: number;
  sampleRate: number;
}

const scope = self as unknown as WorkerScope;
let activeRequestId: number | null = null;
let pendingReady: { requestId: number; resolve: () => void; reject: (error: Error) => void } | null = null;
let pendingAck: { requestId: number; sequence: number; resolve: () => void; reject: (error: Error) => void } | null =
  null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "The browser MP3 decoder failed.";
}

function post(requestId: number, type: string, details: Record<string, unknown> = {}, transfer?: Transferable[]): void {
  scope.postMessage({ type, requestId, ...details }, transfer);
}

function bytesStartWithTag(bytes: Uint8Array, offset: number): boolean {
  return (
    offset + 3 <= bytes.length && bytes[offset] === 0x54 && bytes[offset + 1] === 0x41 && bytes[offset + 2] === 0x47
  );
}

function waitForReady(requestId: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingReady?.requestId !== requestId) return;
        pendingReady = null;
        reject(new Error("The main thread did not allocate the MP3 destination buffer."));
      },
      3 * 60 * 1000,
    );
    pendingReady = {
      requestId,
      resolve: () => {
        clearTimeout(timeout);
        pendingReady = null;
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingReady = null;
        reject(error);
      },
    };
  });
}

function waitForAck(requestId: number, sequence: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingAck?.requestId !== requestId || pendingAck.sequence !== sequence) return;
        pendingAck = null;
        reject(new Error("The main thread did not acknowledge a decoded MP3 sample batch."));
      },
      3 * 60 * 1000,
    );
    pendingAck = {
      requestId,
      sequence,
      resolve: () => {
        clearTimeout(timeout);
        pendingAck = null;
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingAck = null;
        reject(error);
      },
    };
  });
}

async function scanMp3Frames(
  blob: Blob,
  expected: ExpectedMp3,
  requestId: number,
  pass: 1 | 2,
  onFrame: (data: Uint8Array, header: Mp3FrameHeader) => Promise<void>,
): Promise<number> {
  if (blob.size < 4) throw new Error("The MP3 file is too short to contain an audio frame.");
  const headerBytes = await blob.slice(0, Math.min(10, blob.size)).arrayBuffer();
  let readOffset = mp3AudioStartOffset(headerBytes);
  if (!Number.isSafeInteger(readOffset) || readOffset < 0 || readOffset >= blob.size) {
    throw new Error("The MP3 ID3 tag contains no following audio frames.");
  }
  const audioStartOffset = readOffset;
  let carry = new Uint8Array(0);
  let firstHeader: Mp3FrameHeader | null = null;
  let encodedFrames = 0;
  let trailingTag = false;

  while (readOffset < blob.size) {
    const blockStart = readOffset;
    const block = new Uint8Array(
      await blob.slice(blockStart, Math.min(blob.size, blockStart + READ_BLOCK_BYTES)).arrayBuffer(),
    );
    if (block.length === 0) break;
    readOffset += block.length;
    const combined = new Uint8Array(carry.length + block.length);
    combined.set(carry);
    combined.set(block, carry.length);
    const baseOffset = blockStart - carry.length;
    const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
    let cursor = 0;
    let awaitingMore = false;

    while (cursor + 4 <= combined.length) {
      const header = parseMp3FrameHeader(view, cursor);
      if (!header) {
        const absoluteOffset = baseOffset + cursor;
        if (encodedFrames === 0 && cursor < 64 * 1024) {
          cursor++;
          continue;
        }
        if (bytesStartWithTag(combined, cursor) && absoluteOffset + 128 === blob.size) {
          trailingTag = true;
          cursor = combined.length;
          break;
        }
        if (readOffset === blob.size && combined.length - cursor < 4) {
          awaitingMore = true;
          break;
        }
        throw new Error(`Invalid or truncated MP3 frame sequence at byte ${absoluteOffset}.`);
      }
      if (!firstHeader) firstHeader = header;
      else if (!sameMp3Stream(firstHeader, header)) {
        throw new Error("The MP3 changes sample rate, channel count or MPEG version mid-file.");
      }
      if (header.sampleRate !== expected.sampleRate || header.channels !== expected.channels) {
        throw new Error("The MP3 frame layout differs from its inspected metadata.");
      }
      if (header.frameBytes < 4 || cursor + header.frameBytes > combined.length) {
        awaitingMore = true;
        break;
      }
      if (((encodedFrames + 1) * header.samplesPerFrame) / header.sampleRate > MAX_DURATION_SECONDS) {
        throw new Error("The MP3 source exceeds KYX's 12-minute mastering-session duration limit.");
      }
      await onFrame(combined.slice(cursor, cursor + header.frameBytes), header);
      encodedFrames++;
      cursor += header.frameBytes;
    }

    carry = awaitingMore ? combined.slice(cursor) : combined.slice(cursor);
    post(requestId, "MP3_PCM_DECODE_PROGRESS", {
      progress: Math.min(0.24, ((readOffset - audioStartOffset) / Math.max(1, blob.size - audioStartOffset)) * 0.24),
      stage:
        pass === 1 ? "Measuring MP3 decode length in bounded frame blocks" : "Decoding MP3 in bounded frame blocks",
    });
    if (trailingTag || readOffset === blob.size) break;
  }

  if (encodedFrames === 0 || !firstHeader)
    throw new Error("No valid MPEG Layer III frames were found in the MP3 file.");
  if (!trailingTag && carry.length > 0) {
    const isCompleteTrailingId3 = carry.length >= 3 && bytesStartWithTag(carry, 0) && readOffset + 128 === blob.size;
    if (!isCompleteTrailingId3) throw new Error("The MP3 ends with an incomplete audio frame.");
  }
  return encodedFrames;
}

interface DecodePassResult {
  encodedFrames: number;
  decodedFrames: number;
}

class Mp3WebCodecsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp3WebCodecsUnavailableError";
  }
}

async function decodePass(
  requestId: number,
  blob: Blob,
  expected: ExpectedMp3,
  Decoder: typeof AudioDecoder,
  EncodedChunk: typeof EncodedAudioChunk,
  pass: 1 | 2,
): Promise<DecodePassResult> {
  let decodeError: string | null = null;
  let decodedFrames = 0;
  let timestampUs = 0;
  let framesSinceFlush = 0;
  let outputBatchFrames = 0;
  let outputBatch: Float32Array[][] = Array.from({ length: expected.channels }, () => []);
  let sentFrames = 0;
  let sequence = 0;
  let decoder: AudioDecoder;

  const config: AudioDecoderConfig = {
    codec: "mp3",
    sampleRate: expected.sampleRate,
    numberOfChannels: expected.channels,
  };
  try {
    decoder = new Decoder({
      output(audioData) {
        try {
          if (
            audioData.sampleRate !== expected.sampleRate ||
            audioData.numberOfChannels !== expected.channels ||
            !Number.isSafeInteger(audioData.numberOfFrames) ||
            audioData.numberOfFrames <= 0 ||
            decodedFrames + audioData.numberOfFrames > expected.sampleRate * MAX_DURATION_SECONDS
          ) {
            throw new Error("The MP3 decoder changed the sample rate, channel count or frame layout.");
          }
          if (pass === 2) {
            for (let channel = 0; channel < expected.channels; channel++) {
              const bytes = audioData.allocationSize({ format: "f32-planar", planeIndex: channel });
              if (
                !Number.isSafeInteger(bytes) ||
                bytes < audioData.numberOfFrames * Float32Array.BYTES_PER_ELEMENT ||
                bytes % Float32Array.BYTES_PER_ELEMENT !== 0
              ) {
                throw new Error("The MP3 decoder returned an invalid planar audio block.");
              }
              const samples = new Float32Array(bytes / Float32Array.BYTES_PER_ELEMENT);
              audioData.copyTo(samples, { format: "f32-planar", planeIndex: channel });
              for (let frame = 0; frame < audioData.numberOfFrames; frame++) {
                if (!Number.isFinite(samples[frame])) throw new Error("The MP3 decoder returned a non-finite sample.");
              }
              outputBatch[channel].push(samples.subarray(0, audioData.numberOfFrames));
            }
            outputBatchFrames += audioData.numberOfFrames;
          }
          decodedFrames += audioData.numberOfFrames;
        } catch (error) {
          decodeError = errorText(error);
        } finally {
          audioData.close();
        }
      },
      error(error) {
        decodeError = errorText(error);
      },
    });
    decoder.configure(config);
  } catch (error) {
    throw new Mp3WebCodecsUnavailableError(`The browser could not configure MP3 WebCodecs: ${errorText(error)}`);
  }

  const emitBatch = async (): Promise<void> => {
    await decoder.flush();
    if (decodeError) throw new Error(decodeError);
    if (pass !== 2 || outputBatchFrames === 0) return;
    const channels = outputBatch.map((parts) => {
      const samples = new Float32Array(outputBatchFrames);
      let offset = 0;
      for (const part of parts) {
        samples.set(part, offset);
        offset += part.length;
      }
      return samples;
    });
    const frameCount = outputBatchFrames;
    const frameOffset = sentFrames;
    const currentSequence = sequence++;
    sentFrames += frameCount;
    outputBatchFrames = 0;
    outputBatch = Array.from({ length: expected.channels }, () => []);
    scope.postMessage(
      { type: "MP3_PCM_DECODE_CHUNK", requestId, sequence: currentSequence, frameOffset, frameCount, channels },
      channels.map((channel) => channel.buffer),
    );
    await waitForAck(requestId, currentSequence);
  };

  try {
    const encodedFrames = await scanMp3Frames(blob, expected, requestId, pass, async (data, header) => {
      if (decodeError) throw new Error(decodeError);
      const duration = Math.round((header.samplesPerFrame * 1_000_000) / header.sampleRate);
      decoder.decode(new EncodedChunk({ type: "key", timestamp: timestampUs, duration, data }));
      timestampUs += duration;
      framesSinceFlush++;
      if (framesSinceFlush >= DECODE_BATCH_FRAMES) {
        await emitBatch();
        framesSinceFlush = 0;
      }
    });
    await emitBatch();
    return { encodedFrames, decodedFrames: pass === 2 ? sentFrames : decodedFrames };
  } finally {
    try {
      decoder.close();
    } catch {
      // A decoder that failed during flush may already be closed.
    }
  }
}

async function run(requestId: number, blob: Blob, expected: ExpectedMp3): Promise<void> {
  const Decoder = scope.AudioDecoder;
  const EncodedChunk = scope.EncodedAudioChunk;
  if (!Decoder || !EncodedChunk) {
    post(requestId, "MP3_PCM_DECODE_UNSUPPORTED", {
      reason: "This browser does not expose WebCodecs MP3 decoding in workers.",
    });
    activeRequestId = null;
    return;
  }

  const config: AudioDecoderConfig = {
    codec: "mp3",
    sampleRate: expected.sampleRate,
    numberOfChannels: expected.channels,
  };
  let support: AudioDecoderSupport;
  try {
    support = await Decoder.isConfigSupported(config);
  } catch (error) {
    post(requestId, "MP3_PCM_DECODE_UNSUPPORTED", { reason: `MP3 capability check failed: ${errorText(error)}` });
    activeRequestId = null;
    return;
  }
  if (!support.supported) {
    post(requestId, "MP3_PCM_DECODE_UNSUPPORTED", { reason: "This browser does not support MP3 through WebCodecs." });
    activeRequestId = null;
    return;
  }

  let firstPass: DecodePassResult;
  try {
    firstPass = await decodePass(requestId, blob, expected, Decoder, EncodedChunk, 1);
  } catch (error) {
    if (error instanceof Mp3WebCodecsUnavailableError) {
      post(requestId, "MP3_PCM_DECODE_UNSUPPORTED", { reason: errorText(error) });
      activeRequestId = null;
      return;
    }
    throw error;
  }
  if (firstPass.decodedFrames <= 0) throw new Error("The MP3 decoder returned no audio samples.");
  post(requestId, "MP3_PCM_DECODE_PREPARE", {
    frameCount: firstPass.decodedFrames,
    sampleRate: expected.sampleRate,
    channels: expected.channels,
  });
  await waitForReady(requestId);
  const secondPass = await decodePass(requestId, blob, expected, Decoder, EncodedChunk, 2);
  if (secondPass.encodedFrames !== firstPass.encodedFrames || secondPass.decodedFrames !== firstPass.decodedFrames) {
    throw new Error("The MP3 decoder returned inconsistent frame counts across its bounded passes.");
  }
  post(requestId, "MP3_PCM_DECODE_DONE", { frameCount: secondPass.decodedFrames });
  activeRequestId = null;
}

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRecord(event.data) || typeof event.data.type !== "string") return;
  const message = event.data;
  if (message.type === "MP3_PCM_DECODE_READY") {
    const ready = pendingReady;
    if (ready && ready.requestId === message.requestId) ready.resolve();
    return;
  }
  if (message.type === "MP3_PCM_DECODE_ACK") {
    const ack = pendingAck;
    if (ack && ack.requestId === message.requestId && ack.sequence === message.sequence) {
      ack.resolve();
    }
    return;
  }
  if (message.type !== "MP3_PCM_DECODE_START") return;
  const requestId = message.requestId;
  const blob = message.blob;
  const expected = message.expected;
  if (
    !isSafeInteger(requestId) ||
    requestId <= 0 ||
    !(blob instanceof Blob) ||
    blob.size < 4 ||
    blob.size > 96 * 1024 * 1024 ||
    !isRecord(expected) ||
    !isSafeInteger(expected.sampleRate) ||
    expected.sampleRate < 8000 ||
    expected.sampleRate > 192000 ||
    !isSafeInteger(expected.channels) ||
    expected.channels < 1 ||
    expected.channels > 2
  ) {
    if (isSafeInteger(requestId))
      post(requestId, "MP3_PCM_DECODE_ERROR", { message: "The MP3 decode request is invalid." });
    return;
  }
  if (activeRequestId !== null) {
    post(requestId, "MP3_PCM_DECODE_ERROR", { message: "The MP3 decode worker is already processing a file." });
    return;
  }
  activeRequestId = requestId;
  void run(requestId, blob, { sampleRate: expected.sampleRate, channels: expected.channels }).catch(
    (error: unknown) => {
      activeRequestId = null;
      pendingReady?.reject(new Error("MP3 decode stopped before the destination buffer was ready."));
      pendingAck?.reject(new Error("MP3 decode stopped before the sample batch was acknowledged."));
      post(requestId, "MP3_PCM_DECODE_ERROR", { message: errorText(error) });
    },
  );
});
