/** Maximum complete FLAC file retained for browser download. */
export const MAX_FLAC_OUTPUT_BYTES = 96 * 1024 * 1024;

/** Chunk size used by the seekable FLAC stream target. */
export const FLAC_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/** Session guard shared with external file mastering. */
export const MAX_FLAC_EXPORT_WORKING_SET_BYTES = 512 * 1024 * 1024;

/** Validate an encoder write against the exact in-memory FLAC file cap. */
export function assertFlacOutputChunkRange(position: number, byteLength: number): number {
  const end = position + byteLength;
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    !Number.isSafeInteger(end) ||
    end > MAX_FLAC_OUTPUT_BYTES
  ) {
    throw new Error(
      `FLAC output exceeded KYX's ${Math.floor(MAX_FLAC_OUTPUT_BYTES / (1024 * 1024))} MiB in-memory export limit. Shorten the render or export a section.`,
    );
  }
  return end;
}

const FLAC_TARGET_TRANSIENT_BYTES = 24 * 1024 * 1024;
const FLAC_FRAME_OVERHEAD_FACTOR = 1.05;
const FLAC_METADATA_RESERVE_BYTES = 1024 * 1024;
const FLAC_ENCODER_BASE_RESERVE_BYTES = 64 * 1024 * 1024;
const FLAC_ENCODER_OUTPUT_HEADROOM_FACTOR = 3.25;

/**
 * Estimate the extra peak memory needed by the FLAC output target, immutable
 * Blob snapshot, and WASM encoder. The encoder reserve is calibrated above the
 * Windows Chromium process-tree increase measured while hitting the 96 MiB cap.
 * The cap is exact; compressed size is estimated from integer PCM plus frame
 * overhead because audio entropy is unknown before encoding.
 */
export function estimateFlacOutputWorkingSetBytes(
  audio: Pick<AudioBuffer, "length" | "numberOfChannels">,
  bitDepth: 16 | 24,
): number {
  if (
    !Number.isSafeInteger(audio.length) ||
    audio.length <= 0 ||
    !Number.isInteger(audio.numberOfChannels) ||
    audio.numberOfChannels < 1 ||
    audio.numberOfChannels > 8 ||
    (bitDepth !== 16 && bitDepth !== 24)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const pcmBytes = audio.length * audio.numberOfChannels * (bitDepth / 8);
  if (!Number.isSafeInteger(pcmBytes)) return Number.POSITIVE_INFINITY;
  const estimatedFileBytes = Math.min(
    MAX_FLAC_OUTPUT_BYTES,
    Math.ceil(pcmBytes * FLAC_FRAME_OVERHEAD_FACTOR + FLAC_METADATA_RESERVE_BYTES),
  );
  // Model file/Blob copies, bounded muxer chunks, and the measured encoder/WASM
  // headroom. High-entropy input can approach the in-memory file cap.
  const encoderHeadroom =
    FLAC_ENCODER_BASE_RESERVE_BYTES + Math.ceil(estimatedFileBytes * FLAC_ENCODER_OUTPUT_HEADROOM_FACTOR);
  return estimatedFileBytes * 2 + FLAC_TARGET_TRANSIENT_BYTES + encoderHeadroom;
}

export function assertFlacExportWorkingSetBudget(existingBytes: number, outputBytes: number): void {
  if (
    !Number.isSafeInteger(existingBytes) ||
    existingBytes < 0 ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes <= 0
  ) {
    throw new Error("KYX could not estimate the memory needed for this FLAC export.");
  }
  const totalBytes = existingBytes + outputBytes;
  if (totalBytes > MAX_FLAC_EXPORT_WORKING_SET_BYTES) {
    const estimateMiB = Math.ceil(totalBytes / (1024 * 1024));
    const limitMiB = Math.floor(MAX_FLAC_EXPORT_WORKING_SET_BYTES / (1024 * 1024));
    throw new Error(
      `This FLAC export may need about ${estimateMiB} MiB across the current source/render and encoded file, above KYX's ${limitMiB} MiB working-set limit. Shorten the render or use WAV.`,
    );
  }
}
