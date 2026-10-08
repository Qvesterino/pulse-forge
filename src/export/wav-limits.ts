/** Maximum PCM allocation allowed for one full WAV mastering delivery operation. */
export const MAX_WAV_EXPORT_WORKING_SET_BYTES = 512 * 1024 * 1024;

/** Largest encoded WAV read into one ArrayBuffer during post-encode inspection. */
export const MAX_WAV_DECODE_BYTES = 96 * 1024 * 1024;
/** Keep whole-file WAV decoding below this decoded stereo PCM allocation. */
export const MAX_WAV_DECODE_PCM_BYTES = 64 * 1024 * 1024;

const WAV_CONTAINER_AND_BWF_RESERVE_BYTES = 64 * 1024;
const WAV_ANALYSIS_TRANSIENT_RESERVE_BYTES = 2 * 1024 * 1024;
/** Runtime headroom for Blob assembly and browser/worker overhead during delivery. */
export const WAV_DELIVERY_RUNTIME_RESERVE_BYTES = 64 * 1024 * 1024;

/** Decide whether post-encode WAV read-back may allocate one complete AudioBuffer. */
export function canDecodeWavAsAudioBuffer(encodedFileBytes: number, decodedPcmBytes: number): boolean {
  return (
    Number.isSafeInteger(encodedFileBytes) &&
    encodedFileBytes > 0 &&
    encodedFileBytes <= MAX_WAV_DECODE_BYTES &&
    Number.isSafeInteger(decodedPcmBytes) &&
    decodedPcmBytes > 0 &&
    decodedPcmBytes <= MAX_WAV_DECODE_PCM_BYTES
  );
}

/** Encoded WAV byte length for the stereo renders produced by KYX. */
export function estimateWavEncodedFileBytes(renderPcmBytes: number, bitDepth: 16 | 24 | 32): number {
  if (
    !Number.isSafeInteger(renderPcmBytes) ||
    renderPcmBytes <= 0 ||
    renderPcmBytes % 8 !== 0 ||
    (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const frames = renderPcmBytes / 8;
  const dataBytes = frames * 2 * (bitDepth / 8);
  const encodedFileBytes = dataBytes + WAV_CONTAINER_AND_BWF_RESERVE_BYTES;
  return Number.isSafeInteger(encodedFileBytes) ? encodedFileBytes : Number.POSITIVE_INFINITY;
}

/**
 * Estimate additional WAV delivery memory around an already resident stereo
 * Float32 render. `encodedFileCopies` counts complete encoded-file copies
 * retained in addition to that render; the Blob-backed mastering encoder uses
 * one for large streamed inspections and two for small AudioBuffer read-back.
 */
export function estimateWavExportAdditionalWorkingSetBytes(
  renderPcmBytes: number,
  bitDepth: 16 | 24 | 32,
  encodedFileCopies: 0 | 1 | 2 = 2,
): number {
  if (!Number.isInteger(encodedFileCopies) || encodedFileCopies < 0 || encodedFileCopies > 2) {
    return Number.POSITIVE_INFINITY;
  }

  const encodedFileBytes = estimateWavEncodedFileBytes(renderPcmBytes, bitDepth);
  if (!Number.isSafeInteger(encodedFileBytes)) return Number.POSITIVE_INFINITY;
  const decodedPcmBytes = canDecodeWavAsAudioBuffer(encodedFileBytes, renderPcmBytes) ? renderPcmBytes : 0;
  const additionalBytes =
    encodedFileBytes * encodedFileCopies +
    decodedPcmBytes +
    WAV_ANALYSIS_TRANSIENT_RESERVE_BYTES +
    WAV_DELIVERY_RUNTIME_RESERVE_BYTES;
  return Number.isSafeInteger(additionalBytes) ? additionalBytes : Number.POSITIVE_INFINITY;
}

/** Reject before allocating the encoded WAV or starting post-encode analysis. */
export function assertWavExportWorkingSetBudget(residentBytes: number, additionalBytes: number): void {
  if (
    !Number.isSafeInteger(residentBytes) ||
    residentBytes < 0 ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes <= 0 ||
    !Number.isSafeInteger(residentBytes + additionalBytes)
  ) {
    throw new Error("KYX could not estimate the memory needed for this WAV export.");
  }
  const totalBytes = residentBytes + additionalBytes;
  if (totalBytes > MAX_WAV_EXPORT_WORKING_SET_BYTES) {
    const estimateMiB = Math.ceil(totalBytes / (1024 * 1024));
    const limitMiB = Math.floor(MAX_WAV_EXPORT_WORKING_SET_BYTES / (1024 * 1024));
    throw new Error(
      `This WAV export may need about ${estimateMiB} MiB across the current source/render, encoded file, and verification buffers, above KYX's ${limitMiB} MiB working-set limit. Shorten the render, lower the bit depth, or use FLAC.`,
    );
  }
}
