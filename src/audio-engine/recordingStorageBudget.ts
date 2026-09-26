export interface BrowserStorageEstimate {
  quota?: number;
  usage?: number;
}

export interface RecordingStoragePreflight {
  availableBytes: number;
  requiredBytes: number;
  targetSeconds: number;
  estimatedAvailableSeconds: number;
  channels: number;
  sampleRate: number;
  sufficientForTarget: boolean;
}

/** Align the advisory headroom target with the 30-minute Studio capture gate. */
export const RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS = 30 * 60;

// Leave room for IndexedDB record/index overhead, project metadata and other
// origin data. Browser quota estimates are approximate, so this is advisory.
const STORAGE_HEADROOM_MULTIPLIER = 1.25;
const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;

export function estimateRecordingStoragePreflight(
  estimate: BrowserStorageEstimate,
  sampleRate: number,
  channels: number,
): RecordingStoragePreflight | null {
  const { quota, usage } = estimate;
  if (
    !Number.isFinite(quota) ||
    !Number.isFinite(usage) ||
    quota! < 0 ||
    usage! < 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0
  ) {
    return null;
  }

  const bytesPerSecond = sampleRate * channels * BYTES_PER_SAMPLE * STORAGE_HEADROOM_MULTIPLIER;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const availableBytes = Math.max(0, quota! - usage!);
  const requiredBytes = Math.ceil(bytesPerSecond * RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS);
  const estimatedAvailableSeconds = availableBytes / bytesPerSecond;

  return {
    availableBytes,
    requiredBytes,
    targetSeconds: RECORDING_STORAGE_PREFLIGHT_TARGET_SECONDS,
    estimatedAvailableSeconds,
    channels,
    sampleRate,
    sufficientForTarget: availableBytes >= requiredBytes,
  };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function recordingStorageWarning(preflight: RecordingStoragePreflight | null): string | null {
  if (!preflight || preflight.sufficientForTarget) return null;
  const minutes = Math.floor(preflight.estimatedAvailableSeconds / 60);
  return `Browser storage estimates ${formatGiB(preflight.availableBytes)} free (about ${minutes} min at ${preflight.channels} ch); a 30-minute take may need ${formatGiB(preflight.requiredBytes)}. You can record shorter, but stop before storage fills. Committed PCM blocks remain recoverable if quota is reached.`;
}
