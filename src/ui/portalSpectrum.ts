import { SPECTRAL_BANDS } from "../effects/spectral-core/dsp/SpectralProcessor";

/**
 * PORTAL — band geometry, shared by the DSP and the panel.
 *
 * This mapping is a CONTRACT, not a convenience. The processor builds its
 * band edges from 20 Hz to Nyquist and the panel draws from 20 Hz to 24 kHz;
 * if the two ever disagree the canvas still renders, still looks correct, and
 * every frequency the user reads off it is wrong — the FOCUS window drawn over
 * the wrong octave, the SHIFT line in the wrong place.
 *
 * That is why it lives here and is imported by both, instead of being written
 * out twice and hoped over. The values here MUST match `BAND_MIN_HZ` and the
 * log spacing in `SpectralProcessor.buildBandEdges`.
 */

/** Lowest displayed frequency. Matches `BAND_MIN_HZ` in the processor. */
export const PORTAL_AXIS_MIN_HZ = 20;

/** Highest displayed frequency. Matches Nyquist at the 48 kHz project rate. */
export const PORTAL_AXIS_MAX_HZ = 24000;

/** Band count, re-exported so the panel never hard-codes 64. */
export const PORTAL_BAND_COUNT = SPECTRAL_BANDS;

/** Band index → centre frequency in Hz (log-spaced, matching the processor). */
export function bandHz(band: number): number {
  const b = Math.max(0, Math.min(PORTAL_BAND_COUNT - 1, band));
  return PORTAL_AXIS_MIN_HZ * Math.pow(PORTAL_AXIS_MAX_HZ / PORTAL_AXIS_MIN_HZ, (b + 0.5) / PORTAL_BAND_COUNT);
}

/** Frequency in Hz → fractional band index, for the FOCUS/SHIFT markers. */
export function hzToBand(hz: number): number {
  const clamped = Math.min(PORTAL_AXIS_MAX_HZ, Math.max(PORTAL_AXIS_MIN_HZ, hz));
  return (
    (Math.log(clamped / PORTAL_AXIS_MIN_HZ) / Math.log(PORTAL_AXIS_MAX_HZ / PORTAL_AXIS_MIN_HZ)) * PORTAL_BAND_COUNT -
    0.5
  );
}

/** Frequency → x position in [0, width]. The panel's log axis. */
export function hzToX(hz: number, width: number): number {
  const clamped = Math.min(PORTAL_AXIS_MAX_HZ, Math.max(PORTAL_AXIS_MIN_HZ, hz));
  return (Math.log(clamped / PORTAL_AXIS_MIN_HZ) / Math.log(PORTAL_AXIS_MAX_HZ / PORTAL_AXIS_MIN_HZ)) * width;
}

/** Compact axis label: 1k, 20k, 440. */
export function formatAxisHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}
