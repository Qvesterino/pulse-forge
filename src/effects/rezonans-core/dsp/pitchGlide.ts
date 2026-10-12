import { clamp, MAX_RATIO, MIN_RATIO } from "./harmony.js";

const MIN_SHIFT_SEMITONES = 12 * Math.log2(MIN_RATIO);
const MAX_SHIFT_SEMITONES = 12 * Math.log2(MAX_RATIO);

/** One direction-symmetric glide step, expressed in musical pitch units. */
export function glidePitchShiftSemitones(current: number, targetRatio: number, retention: number): number {
  const currentSemitones = clamp(Number.isFinite(current) ? current : 0, MIN_SHIFT_SEMITONES, MAX_SHIFT_SEMITONES);
  const safeRatio = Number.isFinite(targetRatio) ? clamp(targetRatio, MIN_RATIO, MAX_RATIO) : 1;
  const targetSemitones = 12 * Math.log2(safeRatio);
  const hold = Number.isFinite(retention) ? clamp(retention, 0, 1) : 0;
  const delta = targetSemitones - currentSemitones;
  const distance = Math.abs(delta);
  if (distance === 0 || hold === 1) return currentSemitones;

  // Preserve the established upward-transposition glide curve, then mirror
  // that same movement for downward shifts. A direct one-pole on ratios is
  // fast in cents for upward shifts and slow for downward shifts; a linear
  // one-pole in semitones fixes symmetry but softens the fast side too much.
  const ratioSpan = Math.pow(2, distance / 12) - 1;
  const moved = 12 * Math.log2(1 + ratioSpan * (1 - hold));
  return currentSemitones + Math.sign(delta) * moved;
}

/** Convert a smoothed pitch offset back into the phase vocoder's ratio domain. */
export function pitchShiftRatio(semitones: number): number {
  const safeSemitones = clamp(Number.isFinite(semitones) ? semitones : 0, MIN_SHIFT_SEMITONES, MAX_SHIFT_SEMITONES);
  return Math.pow(2, safeSemitones / 12);
}
