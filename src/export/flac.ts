import { registerFlacEncoder } from "@mediabunny/flac-encoder";
import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  FlacOutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import { mulberry32, quantizeInt16Sample, quantizeInt24Sample } from "./quantize";
import { assertFlacOutputChunkRange, FLAC_STREAM_CHUNK_BYTES } from "./flac-limits";
import { formatFlacSupportedSampleRates, isFlacSampleRateSupported } from "./flac-capabilities";

export type FlacBitDepth = 16 | 24;

export interface FlacOptions {
  bitDepth?: FlacBitDepth;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const ENCODE_BLOCK_FRAMES = 65_536;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Export cancelled", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Export cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 0);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Encode a rendered master to 16- or 24-bit FLAC. Input samples are quantized
 * in bounded blocks; Mediabunny's FLAC worker owns codec work and each awaited
 * add respects output backpressure. No sample-rate conversion is performed.
 */
export async function encodeFlac(buffer: AudioBuffer, options: FlacOptions = {}): Promise<Blob> {
  throwIfAborted(options.signal);
  const bitDepth = options.bitDepth ?? 24;
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error("FLAC delivery supports 16-bit or 24-bit integer PCM.");
  if (!isFlacSampleRateSupported(buffer.sampleRate)) {
    throw new Error(
      `FLAC export does not support ${buffer.sampleRate} Hz. Supported rates: ${formatFlacSupportedSampleRates()}.`,
    );
  }
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8) {
    throw new Error("FLAC export supports between 1 and 8 channels.");
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const random = mulberry32(bitDepth === 16 ? 0x464c3136 : 0x464c3234);
  const outputChunks = new Map<number, Uint8Array<ArrayBuffer>>();
  let outputByteLength = 0;
  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write({ data, position }) {
        const end = assertFlacOutputChunkRange(position, data.byteLength);
        if (position > outputByteLength) throw new Error("The FLAC encoder produced a file with a missing byte range.");
        let sourceOffset = 0;
        while (sourceOffset < data.byteLength) {
          const absolutePosition = position + sourceOffset;
          const chunkIndex = Math.floor(absolutePosition / FLAC_STREAM_CHUNK_BYTES);
          const chunkOffset = absolutePosition % FLAC_STREAM_CHUNK_BYTES;
          const chunkLength = Math.min(FLAC_STREAM_CHUNK_BYTES - chunkOffset, data.byteLength - sourceOffset);
          let chunk = outputChunks.get(chunkIndex);
          if (!chunk) {
            chunk = new Uint8Array(FLAC_STREAM_CHUNK_BYTES);
            outputChunks.set(chunkIndex, chunk);
          }
          chunk.set(data.subarray(sourceOffset, sourceOffset + chunkLength), chunkOffset);
          sourceOffset += chunkLength;
        }
        outputByteLength = Math.max(outputByteLength, end);
      },
      abort() {
        outputChunks.clear();
        outputByteLength = 0;
      },
    }),
    { chunked: true, chunkSize: FLAC_STREAM_CHUNK_BYTES },
  );
  const output = new Output({
    format: new FlacOutputFormat(),
    target,
  });
  const source = new AudioSampleSource({ codec: "flac" });
  output.addAudioTrack(source);
  let finalized = false;

  try {
    if (!(await canEncodeAudio("flac"))) registerFlacEncoder();
    await output.start();
    for (let start = 0; start < buffer.length; start += ENCODE_BLOCK_FRAMES) {
      throwIfAborted(options.signal);
      const frameCount = Math.min(ENCODE_BLOCK_FRAMES, buffer.length - start);
      let sample: AudioSample;
      if (bitDepth === 16) {
        const data = new Int16Array(frameCount * channels.length);
        for (let channel = 0; channel < channels.length; channel++) {
          const input = channels[channel];
          const channelOffset = channel * frameCount;
          for (let frame = 0; frame < frameCount; frame++) {
            data[channelOffset + frame] = quantizeInt16Sample(input[start + frame], random, "reject");
          }
        }
        sample = new AudioSample({
          data,
          format: "s16-planar",
          numberOfChannels: channels.length,
          sampleRate: buffer.sampleRate,
          timestamp: start / buffer.sampleRate,
        });
      } else {
        // Mediabunny's FLAC bridge consumes signed 32-bit PCM and shifts away
        // the low 8 bits for 24-bit output. Store each dithered 24-bit sample
        // left-aligned so that shift is exact and deterministic.
        const data = new Int32Array(frameCount * channels.length);
        for (let channel = 0; channel < channels.length; channel++) {
          const input = channels[channel];
          const channelOffset = channel * frameCount;
          for (let frame = 0; frame < frameCount; frame++) {
            const quantized = quantizeInt24Sample(input[start + frame], random, "reject");
            data[channelOffset + frame] = quantized * 256;
          }
        }
        sample = new AudioSample({
          data,
          format: "s32-planar",
          numberOfChannels: channels.length,
          sampleRate: buffer.sampleRate,
          timestamp: start / buffer.sampleRate,
        });
      }

      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
      throwIfAborted(options.signal);
      options.onProgress?.(Math.min(1, (start + frameCount) / Math.max(1, buffer.length)));
      await yieldToEventLoop(options.signal);
    }
    throwIfAborted(options.signal);
    await output.finalize();
    finalized = true;
    if (outputByteLength < 42) throw new Error("The FLAC encoder produced an empty file.");
    const parts: Uint8Array<ArrayBuffer>[] = [];
    const chunkCount = Math.ceil(outputByteLength / FLAC_STREAM_CHUNK_BYTES);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const chunk = outputChunks.get(chunkIndex);
      if (!chunk) throw new Error("The FLAC encoder produced a file with a missing byte range.");
      const remainingBytes = outputByteLength - chunkIndex * FLAC_STREAM_CHUNK_BYTES;
      parts.push(chunk.subarray(0, Math.min(FLAC_STREAM_CHUNK_BYTES, remainingBytes)));
    }
    const blob = new Blob(parts, { type: "audio/flac" });
    outputChunks.clear();
    return blob;
  } catch (error) {
    if (!finalized) await output.cancel().catch(() => undefined);
    throw error;
  }
}
