import { mulberry32, quantizeInt16Sample, softClipSample } from "../export/quantize";
import { downloadBlob } from "../export/download";

export type WavBitDepth = 16 | 24 | 32;

/** Internal: RIFF header + container sizing shared by sync/async encoders. */
function createWavContainer(
  numChannels: number,
  sampleRate: number,
  frames: number,
  bitDepth: WavBitDepth,
): { arrayBuffer: ArrayBuffer; view: DataView; dataSize: number } {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  // RIFF chunk fields are unsigned 32-bit. Past ~4 GB they wrap and the file
  // is silently corrupt — an explicit failure beats wasting a 20-minute
  // render on a WAV no player will read.
  if (dataSize > 0xffffffff - 44) {
    throw new Error(
      `Render too large for WAV export (${(dataSize / 1024 ** 3).toFixed(1)} GB data). Export in segments or lower the sample rate/bit depth.`,
    );
  }
  // Audit 11 D4: RIFF requires an odd `data` chunk to carry one pad byte —
  // currently unreachable (all sources are stereo), but encodeWav is public
  // API and a future mono/odd-frame call would emit a spec-violating file.
  const padByte = dataSize % 2 === 1 ? 1 : 0;
  const arrayBuffer = new ArrayBuffer(44 + dataSize + padByte);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  // RIFF sizes count the data chunk WITH its pad byte (spec: chunks are
  // word-aligned); the declared `dataSize` stays the raw sample bytes.
  view.setUint32(4, 36 + dataSize + padByte, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  return { arrayBuffer, view, dataSize };
}

/** Internal: one sample write, shared by sync/async encoders. */
function writeSample(
  view: DataView,
  offset: number,
  input: number,
  bitDepth: WavBitDepth,
  ditherRand: () => number,
): number {
  // Keep non-finite render artefacts from poisoning the file, but feed
  // hot finite samples through the shared soft-knee policy. Clamping
  // before softClipSample would turn the 24/32-bit paths into a hidden
  // hard clip at exactly full scale.
  const sample = Number.isFinite(input) ? input : 0;
  if (bitDepth === 16) {
    view.setInt16(offset, quantizeInt16Sample(sample, ditherRand), true);
    return offset + 2;
  }
  // 32-bit float is the interchange/mastering format: retain finite
  // over-range samples and let the receiving DAW preserve the headroom.
  // Integer PCM still uses the export soft-knee to avoid hard clipping.
  const clipped = bitDepth === 32 ? sample : softClipSample(sample);
  if (bitDepth === 24) {
    const value = Math.round(clipped * (clipped < 0 ? 0x800000 : 0x7fffff));
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
    return offset + 3;
  }
  view.setFloat32(offset, clipped, true);
  return offset + 4;
}

export function encodeWav(buffer: AudioBuffer, bitDepth: WavBitDepth): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const { arrayBuffer, view } = createWavContainer(numChannels, sampleRate, frames, bitDepth);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  // TPDF dither PRNG for the 16-bit path (seeded → byte-reproducible exports)
  const ditherRand = mulberry32(0x57415631);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      offset = writeSample(view, offset, channels[ch][i], bitDepth, ditherRand);
    }
  }
  return arrayBuffer;
}

export interface EncodeWavAsyncOptions {
  /** Progress fraction 0..1 — fired once per processed block. */
  onProgress?: (fraction: number) => void;
  /** Aborts between blocks. */
  signal?: AbortSignal;
}

const ENCODE_BLOCK_FRAMES = 65536;

/**
 * Audit 11 (reliability wave): yielding variant of {@link encodeWav} for
 * long masters — the sync encoder freezes the main thread for the whole
 * per-sample loop (~seconds on a 4-minute 24-bit master), while this one
 * processes 64k-frame blocks and hands control back to the event loop
 * between them, reporting progress and honoring an abort signal.
 * Byte-identical output: same soft-knee/dither policy, one continuous
 * seeded PRNG across blocks.
 */
export async function encodeWavAsync(
  buffer: AudioBuffer,
  bitDepth: WavBitDepth,
  options: EncodeWavAsyncOptions = {},
): Promise<ArrayBuffer> {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const { arrayBuffer, view } = createWavContainer(numChannels, sampleRate, frames, bitDepth);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  const ditherRand = mulberry32(0x57415631); // same seed → identical bytes
  for (let start = 0; start < frames; start += ENCODE_BLOCK_FRAMES) {
    const end = Math.min(frames, start + ENCODE_BLOCK_FRAMES);
    for (let i = start; i < end; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        offset = writeSample(view, offset, channels[ch][i], bitDepth, ditherRand);
      }
    }
    options.onProgress?.(end / frames);
    if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    // Hand control back to the event loop so the UI stays alive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return arrayBuffer;
}

export function downloadWav(arrayBuffer: ArrayBuffer, filename: string): void {
  downloadBlob(new Blob([arrayBuffer], { type: "audio/wav" }), filename);
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "pulse-forge"
  );
}
