import { registerFlacEncoder } from "@mediabunny/flac-encoder";
import { AudioSample, AudioSampleSource, BufferTarget, canEncodeAudio, FlacOutputFormat, Output } from "mediabunny";
import { assertIntegerPcmRange, mulberry32, quantizeInt16Sample } from "./quantize";

export type FlacBitDepth = 16 | 24;

export interface FlacOptions {
  bitDepth?: FlacBitDepth;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** BufferTarget is intentionally bounded; use a shorter render when the estimated file exceeds this. */
export const MAX_FLAC_OUTPUT_BYTES = 96 * 1024 * 1024;

const ENCODE_BLOCK_FRAMES = 65_536;
const FLAC_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000]);

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
  if (!FLAC_SAMPLE_RATES.has(buffer.sampleRate)) {
    throw new Error(
      `FLAC export does not support ${buffer.sampleRate} Hz. Choose a supported project rate (44.1 or 48 kHz).`,
    );
  }
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8) {
    throw new Error("FLAC export supports between 1 and 8 channels.");
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const random = mulberry32(bitDepth === 16 ? 0x464c3136 : 0x464c3234);
  const target = new BufferTarget();
  const output = new Output({
    format: new FlacOutputFormat({
      onFrame: (data, position) => {
        if (position + data.byteLength > MAX_FLAC_OUTPUT_BYTES) {
          throw new Error(
            `FLAC output exceeded KYX's ${Math.floor(MAX_FLAC_OUTPUT_BYTES / (1024 * 1024))} MiB in-memory export limit. Shorten the render or export a section.`,
          );
        }
      },
    }),
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
            const value = input[start + frame];
            assertIntegerPcmRange(value);
            const dither = random() + random() - 1;
            const quantized = Math.max(-0x800000, Math.min(0x7fffff, Math.round(value * 0x800000 + dither)));
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
    if (!target.buffer || target.buffer.byteLength < 42) throw new Error("The FLAC encoder produced an empty file.");
    return new Blob([target.buffer], { type: "audio/flac" });
  } catch (error) {
    if (!finalized) await output.cancel().catch(() => undefined);
    throw error;
  }
}
