import { Mp3Encoder } from "@breezystack/lamejs";
import { mulberry32, quantizeInt16Sample, type IntegerOverflowPolicy } from "./quantize";

export interface Mp3Options {
  /** Target bitrate in kbps (default 192). */
  kbps?: number;
  /** Progress callback, fraction 0..1. */
  onProgress?: (fraction: number) => void;
  /** Abort support (release roadmap 1.4): checked at every yield point. */
  signal?: AbortSignal;
  /** Use `reject` for mastering delivery to prevent automatic saturation before MP3 encoding. */
  integerOverflowPolicy?: IntegerOverflowPolicy;
}

async function quantizeChannelAsync(
  input: Float32Array,
  seed: number,
  completedSamplesBeforeChannel: number,
  totalSamples: number,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
  overflowPolicy: IntegerOverflowPolicy,
): Promise<Int16Array<ArrayBuffer>> {
  const rand = mulberry32(seed);
  const output = new Int16Array(input.length);
  const chunkSize = 65_536;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const end = Math.min(input.length, offset + chunkSize);
    for (let index = offset; index < end; index++) {
      output[index] = quantizeInt16Sample(input[index], rand, overflowPolicy);
    }
    onProgress?.(((completedSamplesBeforeChannel + end) / Math.max(1, totalSamples)) * 0.2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  }
  return output;
}

/**
 * Encode an AudioBuffer to an MP3 Blob (LAME via wasm).
 *
 * The shareable format: a 30 s stereo WAV (~5 MB at 16-bit) lands around
 * 700 kB at 192 kbps — small enough for chat apps and social uploads where
 * WAV is a non-starter.
 *
 * Encoding yields to the event loop between blocks so long renders keep
 * the UI responsive and progress can be reported.
 */
export async function encodeMp3(buffer: AudioBuffer, options: Mp3Options = {}): Promise<Blob> {
  if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  const kbps = options.kbps ?? 192;
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
  // Audit 11 D7: LAME's MPEG tables only express standard rates — a 96 kHz
  // buffer (e.g. a live-context-rate render) produced corrupt garbage
  // instead of an error.
  const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  if (!SUPPORTED_RATES.includes(buffer.sampleRate)) {
    throw new Error(`MP3 export does not support ${buffer.sampleRate} Hz — use 44100 or 48000 Hz, or export WAV`);
  }
  const encoder = new Mp3Encoder(channelCount, buffer.sampleRate, kbps);

  // Legacy exports retain the soft-knee policy; mastering delivery can opt
  // into rejection so the encoder never changes over-range samples silently.
  // Seeds differ per channel to decorrelate dither and keep output reproducible.
  const overflowPolicy = options.integerOverflowPolicy ?? "soft-knee";
  const channelLength = buffer.length;
  const totalSamples = channelLength * channelCount;
  const left = await quantizeChannelAsync(
    buffer.getChannelData(0),
    0x4c4631,
    0,
    totalSamples,
    options.onProgress,
    options.signal,
    overflowPolicy,
  );
  const right =
    channelCount === 2
      ? await quantizeChannelAsync(
          buffer.getChannelData(1),
          0x4c4632,
          channelLength,
          totalSamples,
          options.onProgress,
          options.signal,
          overflowPolicy,
        )
      : null;
  if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

  const blockSize = 1152; // LAME's MP3 frame size
  const chunks: Uint8Array[] = [];
  const totalBlocks = Math.ceil(left.length / blockSize);
  for (let block = 0; block < totalBlocks; block++) {
    const i = block * blockSize;
    const l = left.subarray(i, i + blockSize);
    const encoded = right ? encoder.encodeBuffer(l, right.subarray(i, i + blockSize)) : encoder.encodeBuffer(l);
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
    // Yield regularly so cancellation remains responsive on long mastering sessions.
    if (block % 100 === 99) {
      options.onProgress?.(0.2 + (block / totalBlocks) * 0.8);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Abort only at a yield point — no partial Blob is ever produced.
      if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    }
  }
  if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  options.onProgress?.(1);
  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}
