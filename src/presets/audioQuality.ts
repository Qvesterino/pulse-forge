/**
 * Release-facing checks for short factory-preset auditions.
 *
 * The preview bus applies a fixed 0.78 headroom gain before this measurement.
 * These limits are intentionally about user-facing audition safety, not about
 * judging whether a sound is artistically good: a preview must be finite,
 * audible and free of sustained full-scale clipping.
 */

export interface PreviewAudioMetrics {
  finite: boolean;
  peak: number;
  rms: number;
  clippedSamples: number;
  sampleCount: number;
  clippedRatio: number;
}

export const PREVIEW_AUDIO_LIMITS = {
  minPeak: 0.0005,
  maxPeak: 1.05,
  maxClippedRatio: 0.0005,
} as const;

/**
 * Give slow-attack factory sounds enough time to speak during an audition.
 * The upper bound keeps a malformed preset from turning a hover preview into
 * an unbounded render or timer.
 */
export function previewNoteDuration(params: Record<string, number>): number {
  const attack = Number.isFinite(params.attack) ? Math.max(0, params.attack) : 0;
  return Math.min(2.5, Math.max(0.65, attack + 0.35));
}

/** Keep the temporary runtime alive through the note and its audible release. */
export function previewCleanupDelayMs(params: Record<string, number>, durationSec: number): number {
  const release = Number.isFinite(params.release) ? Math.max(0, params.release) : 0.2;
  return Math.max(1_400, Math.ceil((durationSec + Math.min(1.5, release) + 0.25) * 1_000));
}

export function measurePreviewAudio(channels: readonly Float32Array[]): PreviewAudioMetrics {
  let finite = true;
  let peak = 0;
  let sumSquares = 0;
  let clippedSamples = 0;
  let sampleCount = 0;

  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = channel[i];
      sampleCount++;
      if (!Number.isFinite(value)) {
        finite = false;
        continue;
      }
      const abs = Math.abs(value);
      peak = Math.max(peak, abs);
      sumSquares += value * value;
      if (abs >= 0.999) clippedSamples++;
    }
  }

  return {
    finite,
    peak,
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    clippedSamples,
    sampleCount,
    clippedRatio: sampleCount > 0 ? clippedSamples / sampleCount : 1,
  };
}

export function passesPreviewAudio(metrics: PreviewAudioMetrics): boolean {
  return (
    metrics.finite &&
    metrics.peak >= PREVIEW_AUDIO_LIMITS.minPeak &&
    metrics.peak <= PREVIEW_AUDIO_LIMITS.maxPeak &&
    metrics.clippedRatio <= PREVIEW_AUDIO_LIMITS.maxClippedRatio
  );
}
