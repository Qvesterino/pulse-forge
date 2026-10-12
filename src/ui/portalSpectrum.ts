import { SPECTRAL_BANDS } from "../effects/spectral-core/dsp/SpectralProcessor";

/**
 * PORTAL — band geometry, shared by the DSP and the panel.
 *
 * This mapping is a CONTRACT, not a convenience. The processor builds its
 * band edges from 20 Hz to Nyquist, so the telemetry sample rate participates
 * in every geometry function. A fixed 24 kHz axis silently mislabels the upper
 * bands at common 44.1 kHz sessions.
 *
 * That is why it lives here and is imported by both, instead of being written
 * out twice and hoped over. The values here MUST match `BAND_MIN_HZ` and the
 * log spacing in `SpectralProcessor.buildBandEdges`.
 */

/** Lowest displayed frequency. Matches `BAND_MIN_HZ` in the processor. */
export const PORTAL_AXIS_MIN_HZ = 20;

/** Default upper frequency, for geometry calls without a live meter frame. */
export const PORTAL_AXIS_MAX_HZ = 24000;

export const PORTAL_DEFAULT_SAMPLE_RATE = 48000;

/** The top of the processor's band map for this audio context. */
export function portalNyquistHz(sampleRate = PORTAL_DEFAULT_SAMPLE_RATE): number {
  const validRate = Number.isFinite(sampleRate) && sampleRate > PORTAL_AXIS_MIN_HZ * 2;
  return validRate ? sampleRate / 2 : PORTAL_AXIS_MAX_HZ;
}

/** Band count, re-exported so the panel never hard-codes 64. */
export const PORTAL_BAND_COUNT = SPECTRAL_BANDS;

/** Band index → centre frequency in Hz (log-spaced, matching the processor). */
export function bandHz(band: number, sampleRate = PORTAL_DEFAULT_SAMPLE_RATE): number {
  const b = Math.max(0, Math.min(PORTAL_BAND_COUNT - 1, band));
  const maxHz = portalNyquistHz(sampleRate);
  return PORTAL_AXIS_MIN_HZ * Math.pow(maxHz / PORTAL_AXIS_MIN_HZ, (b + 0.5) / PORTAL_BAND_COUNT);
}

/** Frequency in Hz → fractional band index, for the FOCUS/SHIFT markers. */
export function hzToBand(hz: number, sampleRate = PORTAL_DEFAULT_SAMPLE_RATE): number {
  const maxHz = portalNyquistHz(sampleRate);
  const clamped = Math.min(maxHz, Math.max(PORTAL_AXIS_MIN_HZ, hz));
  return (Math.log(clamped / PORTAL_AXIS_MIN_HZ) / Math.log(maxHz / PORTAL_AXIS_MIN_HZ)) * PORTAL_BAND_COUNT - 0.5;
}

/** Frequency → x position in [0, width]. The panel's log axis. */
export function hzToX(hz: number, width: number, sampleRate = PORTAL_DEFAULT_SAMPLE_RATE): number {
  const maxHz = portalNyquistHz(sampleRate);
  const clamped = Math.min(maxHz, Math.max(PORTAL_AXIS_MIN_HZ, hz));
  return (Math.log(clamped / PORTAL_AXIS_MIN_HZ) / Math.log(maxHz / PORTAL_AXIS_MIN_HZ)) * width;
}

/** Compact axis label: 1k, 20k, 440. */
export function formatAxisHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}
