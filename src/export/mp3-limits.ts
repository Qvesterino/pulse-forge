import { isMp3SampleRateSupported } from "./mp3-capabilities";

/** Maximum resident working set allowed for a mastered MP3 delivery operation. */
export const MAX_MP3_EXPORT_WORKING_SET_BYTES = 512 * 1024 * 1024;

/** Keep in sync with the largest MP3 sent through Web Audio's whole-file decoder. */
export const MAX_MP3_DECODE_BYTES = 12 * 1024 * 1024;
/** Keep the AudioBuffer allocated by whole-file MP3 decode below 64 MiB. */
export const MAX_MP3_DECODE_PCM_BYTES = 64 * 1024 * 1024;

const MP3_OUTPUT_METADATA_RESERVE_BYTES = 64 * 1024;
// Calibrated against a four-minute 320 kbps Chromium delivery soak, which
// measured about 480 MiB of incremental process-tree working set.
export const MP3_DELIVERY_RUNTIME_RESERVE_BYTES = 192 * 1024 * 1024;
const MP3_FRAME_PADDING_SECONDS = 0.1;

/**
 * Estimate temporary MP3 delivery memory around an already resident Float32
 * render. LAME quantizes both channels into retained Int16 arrays, the output
 * Blob may duplicate its encoded chunks, and short files allocate both an
 * encoded ArrayBuffer and a decoded AudioBuffer during post-encode inspection.
 * Long files use the bounded WebCodecs worker path instead of a full PCM decode.
 */
export function estimateMp3ExportAdditionalWorkingSetBytes(
  renderPcmBytes: number,
  sampleRate: number,
  kbps: number,
  channelCount = 2,
): number {
  if (
    !Number.isSafeInteger(renderPcmBytes) ||
    renderPcmBytes <= 0 ||
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 2 ||
    renderPcmBytes % (channelCount * Float32Array.BYTES_PER_ELEMENT) !== 0 ||
    !isMp3SampleRateSupported(sampleRate) ||
    !Number.isInteger(kbps) ||
    kbps < 8 ||
    kbps > 320
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const frames = renderPcmBytes / (channelCount * Float32Array.BYTES_PER_ELEMENT);
  const paddingFrames = Math.ceil(sampleRate * MP3_FRAME_PADDING_SECONDS);
  const durationSeconds = frames / sampleRate;
  const encodedBytes = Math.ceil(
    ((durationSeconds + MP3_FRAME_PADDING_SECONDS) * kbps * 1000) / 8 + MP3_OUTPUT_METADATA_RESERVE_BYTES,
  );
  if (!Number.isSafeInteger(encodedBytes) || !Number.isSafeInteger(frames + paddingFrames)) {
    return Number.POSITIVE_INFINITY;
  }

  const quantizedPcmBytes = frames * channelCount * Int16Array.BYTES_PER_ELEMENT;
  // Small MP3 files use decodeAudioData and retain a complete encoded buffer;
  // larger files are inspected as bounded WebCodecs blocks.
  const projectedDecodePcmBytes = (frames + paddingFrames) * channelCount * Float32Array.BYTES_PER_ELEMENT;
  const wholeFileDecode = encodedBytes <= MAX_MP3_DECODE_BYTES && projectedDecodePcmBytes <= MAX_MP3_DECODE_PCM_BYTES;
  const encodedCopies = wholeFileDecode ? 3 : 2;
  const inspectionPcmBytes = wholeFileDecode ? projectedDecodePcmBytes : 0;
  const additionalBytes =
    quantizedPcmBytes + encodedBytes * encodedCopies + inspectionPcmBytes + MP3_DELIVERY_RUNTIME_RESERVE_BYTES;
  return Number.isSafeInteger(additionalBytes) ? additionalBytes : Number.POSITIVE_INFINITY;
}

/** Reject before allocating MP3 quantization arrays or starting post-encode inspection. */
export function assertMp3ExportWorkingSetBudget(residentBytes: number, additionalBytes: number): void {
  if (
    !Number.isSafeInteger(residentBytes) ||
    residentBytes < 0 ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes <= 0 ||
    !Number.isSafeInteger(residentBytes + additionalBytes)
  ) {
    throw new Error("KYX could not estimate the memory needed for this MP3 export.");
  }
  const totalBytes = residentBytes + additionalBytes;
  if (totalBytes > MAX_MP3_EXPORT_WORKING_SET_BYTES) {
    const estimateMiB = Math.ceil(totalBytes / (1024 * 1024));
    const limitMiB = Math.floor(MAX_MP3_EXPORT_WORKING_SET_BYTES / (1024 * 1024));
    throw new Error(
      `This MP3 export may need about ${estimateMiB} MiB across the current render, encoder, encoded file and verification buffers, above KYX's ${limitMiB} MiB working-set limit. Shorten the render or export a section.`,
    );
  }
}
