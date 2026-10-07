/** Maximum complete FLAC file retained for browser download. */
export const MAX_FLAC_OUTPUT_BYTES = 96 * 1024 * 1024;

/** Chunk size used by the seekable FLAC stream target. */
export const FLAC_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/** Session guard shared with external file mastering. */
export const MAX_FLAC_EXPORT_WORKING_SET_BYTES = 512 * 1024 * 1024;

const FLAC_TARGET_TRANSIENT_BYTES = 24 * 1024 * 1024;
const FLAC_FRAME_OVERHEAD_FACTOR = 1.05;
const FLAC_METADATA_RESERVE_BYTES = 1024 * 1024;

/**
 * Estimate the extra peak memory needed while a FLAC file is retained and
 * copied into an immutable Blob. The cap is exact; compression size is
 * estimated conservatively from uncompressed integer PCM plus frame overhead.
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
  // One retained file plus the immutable Blob snapshot and bounded muxer chunks.
  return estimatedFileBytes * 2 + FLAC_TARGET_TRANSIENT_BYTES;
}

export function assertFlacExportWorkingSetBudget(existingBytes: number, outputBytes: number): void {
  if (!Number.isFinite(existingBytes) || existingBytes < 0 || !Number.isFinite(outputBytes) || outputBytes <= 0) {
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
