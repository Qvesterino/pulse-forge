import { Mp3Encoder } from "@breezystack/lamejs";

export interface Mp3Options {
  /** Target bitrate in kbps (default 192). */
  kbps?: number;
  /** Progress callback, fraction 0..1. */
  onProgress?: (fraction: number) => void;
}

/** Convert float32 samples [-1..1] to LAME's int16 PCM input. */
function floatToInt16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
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

  const left = floatToInt16(buffer.getChannelData(0));
  const right = channelCount === 2 ? floatToInt16(buffer.getChannelData(1)) : null;

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
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  options.onProgress?.(1);
  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}
