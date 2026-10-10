/**
 * Lossy share/web delivery: OGG (Opus) and M4A (AAC).
 *
 * Both go through Mediabunny's `Output`, which wraps the browser's WebCodecs
 * `AudioEncoder` and — crucially — muxes the encoded packets into a real
 * container. Hand-rolling the OGG/MP4 container would have been the alternative;
 * Mediabunny is already a dependency for FLAC (`flac.ts`), so this reuses a
 * proven path instead of adding a second, parallel implementation.
 *
 * Encoding is NOT real-time (unlike the MediaRecorder path in `video.ts`), so a
 * four-minute master takes seconds rather than four minutes.
 *
 * Like `flac.ts`, this module carries a static Mediabunny import and must be
 * loaded dynamically (`await import("../export/compressed-audio")`) so the media
 * library stays out of the eager DAW bundle.
 */
import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  OutputFormat,
  Quality,
  BufferTarget,
  type QualityLevel,
} from "mediabunny";
import {
  canEncodeCompressedAudio,
  findCompressedAudioFormat,
  isCompressedAudioSampleRateSupported,
  COMPRESSED_AUDIO_SAMPLE_RATES,
  type CompressedAudioFormatId,
} from "./compressed-audio-capabilities";

/** Mediabunny quality tiers, named without importing the deprecated constants. */
export type CompressedAudioQuality = "medium" | "high" | "very-high";

export interface CompressedAudioOptions {
  target: CompressedAudioFormatId;
  quality?: CompressedAudioQuality;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * ~0.75 s per block. Small enough that Cancel feels immediate and the encoded
 * queue stays bounded, large enough that per-block overhead disappears against
 * the encoder's own work.
 */
const ENCODE_BLOCK_FRAMES = 36_000;

/**
 * Mediabunny quality tiers, named without importing the deprecated `QUALITY_*`
 * constants. Typed as `QualityLevel` so the mapping cannot silently widen to
 * `string` and fall out of the union `Quality` accepts.
 */
const QUALITY_TIERS: Record<CompressedAudioQuality, QualityLevel> = {
  medium: "medium",
  high: "high",
  "very-high": "very-high",
};

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
 * Encode a rendered master to OGG (Opus) or M4A (AAC).
 *
 * Throws with an actionable message — never a raw WebCodecs failure — when the
 * browser cannot encode the codec, so the panel can surface a real reason
 * instead of "Error: Unable to configure encoder".
 */
export async function encodeCompressedAudio(buffer: AudioBuffer, options: CompressedAudioOptions): Promise<Blob> {
  throwIfAborted(options.signal);
  const target = findCompressedAudioFormat(options.target);
  if (!isCompressedAudioSampleRateSupported(buffer.sampleRate)) {
    throw new Error(
      `${target.label} export does not support ${buffer.sampleRate} Hz. Supported rates: ${COMPRESSED_AUDIO_SAMPLE_RATES.map(
        (rate) => `${rate / 1000} kHz`,
      ).join(", ")}.`,
    );
  }
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8) {
    throw new Error("Compressed audio export supports between 1 and 8 channels.");
  }

  if (!(await canEncodeCompressedAudio(target.codec))) {
    throw new Error(
      target.codec === "aac"
        ? "This browser cannot encode AAC. Chrome, Edge or Safari 26+ can; Firefox cannot."
        : "This browser cannot encode Opus. Chrome, Edge, Firefox (desktop) or Safari 26+ can.",
    );
  }

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const container: OutputFormat = target.codec === "opus" ? new OggOutputFormat() : new Mp4OutputFormat();
  const bufferTarget = new BufferTarget();
  const output = new Output({ format: container, target: bufferTarget });
  const source = new AudioSampleSource({
    codec: target.codec,
    quality: new Quality(QUALITY_TIERS[options.quality ?? "high"]),
  });
  output.addAudioTrack(source);
  let finalized = false;

  try {
    // Guard against Mediabunny's internal probe disagreeing with the pre-check
    // (e.g. the AudioEncoder appeared but rejected this exact configuration).
    if (!(await canEncodeAudio(target.codec))) {
      throw new Error(`This browser rejected the ${target.codec} encoder configuration for this render.`);
    }
    await output.start();
    for (let start = 0; start < buffer.length; start += ENCODE_BLOCK_FRAMES) {
      throwIfAborted(options.signal);
      const frameCount = Math.min(ENCODE_BLOCK_FRAMES, buffer.length - start);
      // f32-planar matches the renderer's own Float32 channel layout, so each
      // block is one interleaved copy per channel and no quantisation pass runs.
      // Layout is planar: channel N occupies [N*frameCount, (N+1)*frameCount).
      const data = new Float32Array(frameCount * channels.length);
      for (let channel = 0; channel < channels.length; channel++) {
        data.set(channels[channel].subarray(start, start + frameCount), channel * frameCount);
      }
      const sample = new AudioSample({
        data,
        format: "f32-planar",
        numberOfChannels: channels.length,
        sampleRate: buffer.sampleRate,
        timestamp: start / buffer.sampleRate,
      });
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
    const encoded = bufferTarget.buffer;
    if (!encoded || encoded.byteLength === 0) throw new Error(`The ${target.codec} encoder produced an empty file.`);
    return new Blob([encoded], { type: target.mimeType });
  } catch (error) {
    if (!finalized) await output.cancel().catch(() => undefined);
    throw error;
  }
}
