import { Mp3Encoder } from "@breezystack/lamejs";
import { quantizeInt16 } from "./quantize";

export interface Mp3Options {
  /** Target bitrate in kbps (default 192). */
  kbps?: number;
  /** Progress callback, fraction 0..1. */
  onProgress?: (fraction: number) => void;
  /** Abort support (release roadmap 1.4): checked at every yield point. */
  signal?: AbortSignal;
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
  const kbps = options.kbps ?? 192;
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const encoder = new Mp3Encoder(channelCount, buffer.sampleRate, kbps);

  // Soft-knee clip + TPDF dither before 16-bit quantization: hot masters
  // lose the hard-clip crunch, quiet passages fade into noise instead of
  // digital silence. Seeds differ per channel to decorrelate the dither;
  // fixed seeds keep exports byte-reproducible.
  const left = quantizeInt16(buffer.getChannelData(0), 0x4c4631);
  const right = channelCount === 2 ? quantizeInt16(buffer.getChannelData(1), 0x4c4632) : null;

  const blockSize = 1152; // LAME's MP3 frame size
  const chunks: Uint8Array[] = [];
  const totalBlocks = Math.ceil(left.length / blockSize);
  for (let block = 0; block < totalBlocks; block++) {
    const i = block * blockSize;
    const l = left.subarray(i, i + blockSize);
    const encoded = right ? encoder.encodeBuffer(l, right.subarray(i, i + blockSize)) : encoder.encodeBuffer(l);
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
    // Yield every ~250 blocks (~6.5 s of audio) so the UI stays alive.
    if (block % 250 === 249) {
      options.onProgress?.(block / totalBlocks);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Abort only at a yield point — no partial Blob is ever produced.
      if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  options.onProgress?.(1);
  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}
