import type { DrumPad } from "../project-model/types";

/**
 * De-click + slice-resolution helpers (Wave 4c): shared by the trigger path
 * (AudioEngine) and the audition deck (previewDeck). VERBATIM move from
 * AudioEngine.ts — same math, same clamps; AudioEngine re-exports every
 * name so existing consumer imports keep working.
 */

export interface ResolvedSlicePlayback {
  start: number;
  end: number;
  duration: number;
  offset: number;
  rate: number;
  fadeIn: number;
  fadeOut: number;
  reverse: boolean;
}

export const DECLICK_TAIL_SEC = 0.002;

/**
 * Effective fade-out for a voice: the pad's configured fade when it is
 * longer than the de-click floor, otherwise the floor itself (bounded to a
 * quarter of the slice so a very short slice cannot be swallowed).
 */
export function declickFadeOut(configuredFadeOut: number, sliceDuration: number): number {
  const floor = Math.min(DECLICK_TAIL_SEC, Math.max(0, sliceDuration) / 4);
  const configured = Number.isFinite(configuredFadeOut) ? Math.max(0, configuredFadeOut) : 0;
  return Math.max(configured, floor);
}

/**
 * Fit a (fadeIn, fadeOut) pair into a slice duration the same way the engine
 * will, so UI controls can clamp to exactly what will be heard.
 *
 * Rules (mirrored from resolveSlicePlayback — keep them in ONE place):
 *  - non-finite/negative fades become 0;
 *  - each fade is capped at the slice duration;
 *  - when both together exceed the duration they are scaled proportionally
 *    so the envelope always fits.
 */
export function fitSliceFades(
  fadeIn: number,
  fadeOut: number,
  sliceDuration: number,
): { fadeIn: number; fadeOut: number } {
  const duration = Number.isFinite(sliceDuration) ? Math.max(0, sliceDuration) : 0;
  let inSec = Number.isFinite(fadeIn) ? Math.max(0, fadeIn) : 0;
  let outSec = Number.isFinite(fadeOut) ? Math.max(0, fadeOut) : 0;
  inSec = Math.min(inSec, duration);
  outSec = Math.min(outSec, duration);
  if (inSec + outSec > duration) {
    const scale = duration / Math.max(0.001, inSec + outSec);
    inSec *= scale;
    outSec *= scale;
  }
  return { fadeIn: inSec, fadeOut: outSec };
}

export function resolveSlicePlayback(pad: DrumPad, bufferDuration: number): ResolvedSlicePlayback {
  const duration = Math.max(0.001, Number.isFinite(bufferDuration) ? bufferDuration : 0.001);
  let start = Number.isFinite(pad.sliceStart) ? Math.max(0, Math.min(pad.sliceStart!, duration)) : 0;
  let end = Number.isFinite(pad.sliceEnd) ? Math.max(0, Math.min(pad.sliceEnd!, duration)) : duration;
  if (end <= start + 0.001) {
    start = 0;
    end = duration;
  }
  const reverse = pad.sliceReverse === true;
  const pitch = Number.isFinite(pad.pitch) ? pad.pitch : 0;
  const rateMagnitude = Math.pow(2, pitch / 12);
  const rate = (reverse ? -1 : 1) * rateMagnitude;
  const outputDuration = Math.max(0.001, end - start);
  const { fadeIn, fadeOut } = fitSliceFades(pad.sliceFadeIn ?? 0, pad.sliceFadeOut ?? 0, outputDuration);
  return {
    start,
    end,
    duration: outputDuration,
    offset: reverse ? end : start,
    rate,
    fadeIn,
    fadeOut,
    reverse,
  };
}
