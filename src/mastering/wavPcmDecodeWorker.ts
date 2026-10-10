interface WavPcmDecodeDescriptor {
  channels: number;
  dataBytes: number;
  dataOffset: number;
  bitDepth: 16 | 24 | 32;
  blockAlign: number;
  formatCode: 1 | 3;
  frameCount: number;
  sampleRate: number;
}

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
const MAX_ENCODED_BYTES = 96 * 1024 * 1024;
const MAX_PCM_BYTES = 128 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;

let activeRequestId: number | null = null;
let expectedAckSequence = -1;
let resolveAck: (() => void) | null = null;
let ackTimeout: ReturnType<typeof setTimeout> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validateDescriptor(value: unknown, blob: Blob): value is WavPcmDecodeDescriptor {
  if (!isRecord(value)) return false;
  const { channels, dataBytes, dataOffset, bitDepth, blockAlign, formatCode, frameCount, sampleRate } = value;
  if (
    !isSafeInteger(channels) ||
    channels < 1 ||
    channels > 2 ||
    !isSafeInteger(dataBytes) ||
    dataBytes <= 0 ||
    !isSafeInteger(dataOffset) ||
    dataOffset < 12 ||
    !isSafeInteger(blockAlign) ||
    !isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    !isSafeInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) ||
    (formatCode !== 1 && formatCode !== 3)
  ) {
    return false;
  }
  if ((formatCode === 1 && bitDepth === 32) || (formatCode === 3 && bitDepth !== 32)) return false;
  const bytesPerSample = bitDepth / 8;
  return (
    dataBytes <= MAX_ENCODED_BYTES &&
    blockAlign === channels * bytesPerSample &&
    dataBytes === frameCount * blockAlign &&
    Number.isSafeInteger(dataOffset + dataBytes) &&
    dataOffset + dataBytes <= blob.size &&
    frameCount * channels * Float32Array.BYTES_PER_ELEMENT <= MAX_PCM_BYTES
  );
}

function postError(requestId: number, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  workerScope.postMessage({
    type: "WAV_PCM_DECODE_ERROR",
    requestId,
    message: message.slice(0, 500),
  });
}

function waitForAck(requestId: number, sequence: number): Promise<void> {
  expectedAckSequence = sequence;
  return new Promise<void>((resolve) => {
    resolveAck = resolve;
    // A missing acknowledgement cannot keep this worker alive indefinitely.
    ackTimeout = setTimeout(
      () => {
        if (activeRequestId === requestId && expectedAckSequence === sequence && resolveAck === resolve) {
          resolveAck = null;
          expectedAckSequence = -1;
          activeRequestId = null;
          postError(requestId, "The main thread did not acknowledge a decoded WAV sample chunk.");
          resolve();
        }
      },
      3 * 60 * 1000,
    );
  });
}

async function decode(blob: Blob, descriptor: WavPcmDecodeDescriptor, requestId: number): Promise<void> {
  const bytesPerSample = descriptor.bitDepth / 8;
  const framesPerChunk = Math.max(1, Math.floor(MAX_CHUNK_BYTES / descriptor.blockAlign));
  let frameOffset = 0;
  let sequence = 0;

  while (frameOffset < descriptor.frameCount) {
    const frameCount = Math.min(framesPerChunk, descriptor.frameCount - frameOffset);
    const start = descriptor.dataOffset + frameOffset * descriptor.blockAlign;
    const end = start + frameCount * descriptor.blockAlign;
    const bytes = await blob.slice(start, end).arrayBuffer();
    if (bytes.byteLength !== end - start) throw new Error("The WAV sample range could not be read completely.");
    const view = new DataView(bytes);
    const channels = Array.from({ length: descriptor.channels }, () => new Float32Array(frameCount));

    for (let frame = 0; frame < frameCount; frame++) {
      const frameStart = frame * descriptor.blockAlign;
      for (let channel = 0; channel < descriptor.channels; channel++) {
        const sampleOffset = frameStart + channel * bytesPerSample;
        let sample: number;
        if (descriptor.formatCode === 3) {
          sample = view.getFloat32(sampleOffset, true);
          if (!Number.isFinite(sample)) throw new Error("The WAV contains a non-finite floating-point sample.");
        } else if (descriptor.bitDepth === 16) {
          sample = view.getInt16(sampleOffset, true) / 0x8000;
        } else {
          let value = view.getUint8(sampleOffset) | (view.getUint8(sampleOffset + 1) << 8);
          value |= view.getUint8(sampleOffset + 2) << 16;
          if (value & 0x800000) value -= 0x1000000;
          sample = value / 0x800000;
        }
        channels[channel][frame] = sample;
      }
    }

    workerScope.postMessage(
      { type: "WAV_PCM_DECODE_CHUNK", requestId, sequence, frameOffset, frameCount, channels },
      channels.map((channel) => channel.buffer),
    );
    await waitForAck(requestId, sequence);
    if (activeRequestId !== requestId) return;
    frameOffset += frameCount;
    sequence++;
  }

  activeRequestId = null;
  workerScope.postMessage({ type: "WAV_PCM_DECODE_DONE", requestId });
}

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRecord(event.data) || typeof event.data.type !== "string") return;
  const message = event.data;
  if (message.type === "WAV_PCM_DECODE_ACK") {
    if (activeRequestId === message.requestId && expectedAckSequence === message.sequence && resolveAck !== null) {
      const resolve = resolveAck;
      resolveAck = null;
      expectedAckSequence = -1;
      if (ackTimeout !== null) clearTimeout(ackTimeout);
      ackTimeout = null;
      resolve();
    }
    return;
  }
  if (message.type !== "WAV_PCM_DECODE_START") return;
  const requestId = message.requestId;
  const blob = message.blob;
  if (!isSafeInteger(requestId) || !(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_ENCODED_BYTES) {
    if (isSafeInteger(requestId)) postError(requestId, "The WAV source is empty, too large or invalid.");
    return;
  }
  if (!validateDescriptor(message.descriptor, blob)) {
    postError(requestId, "The inspected WAV sample layout is invalid or exceeds KYX's decode limits.");
    return;
  }
  if (activeRequestId !== null) {
    postError(requestId, "The WAV decoder worker is already processing another file.");
    return;
  }
  activeRequestId = requestId;
  void decode(blob, message.descriptor, requestId).catch((error: unknown) => {
    if (activeRequestId !== requestId) return;
    activeRequestId = null;
    resolveAck = null;
    expectedAckSequence = -1;
    if (ackTimeout !== null) clearTimeout(ackTimeout);
    ackTimeout = null;
    postError(requestId, error);
  });
});
