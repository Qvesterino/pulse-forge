/**
 * LUFS level matching for blind A/B / ABX listening (quality roadmap P4).
 *
 * A pair that is not level-matched measures loudness preference, not sound
 * quality — the louder version wins even when it sounds worse. This helper
 * derives symmetric per-file playback gains that land both files on their
 * mean integrated loudness, so neither side is privileged and the comparison
 * is decided by tone, not level.
 *
 * PURE by contract (AGENTS invariant #4): deterministic, no state, never
 * throws. Unmeasurable loudness degrades honestly to native levels with
 * `matched: false` — the UI must surface that, not hide it.
 */

/** Safety clamp: beyond this the two mixes are wildly different objects. */
export const MAX_LEVEL_MATCH_GAIN_DB = 12;

export interface LevelMatchGains {
  /** False when either side's LUFS was unavailable — gains stay 0. */
  matched: boolean;
  /** The common loudness both files are played at (null when unmatched). */
  targetLufs: number | null;
  gainDbA: number;
  gainDbB: number;
  /** Human-readable status for the listening page (honest, no jargon). */
  note: string;
}

function clampGain(db: number): number {
  return Math.min(MAX_LEVEL_MATCH_GAIN_DB, Math.max(-MAX_LEVEL_MATCH_GAIN_DB, db));
}

export function levelMatchGainsDb(lufsA: number | null, lufsB: number | null): LevelMatchGains {
  if (lufsA === null || lufsB === null || !Number.isFinite(lufsA) || !Number.isFinite(lufsB)) {
    return {
      matched: false,
      targetLufs: null,
      gainDbA: 0,
      gainDbB: 0,
      note: "not level-matched — loudness could not be measured for one side",
    };
  }
  // Symmetric target: normalizing onto A (or B) would bias exposure toward
  // the other side's native level; the mean treats both versions equally.
  const targetLufs = (lufsA + lufsB) / 2;
  const rawA = targetLufs - lufsA;
  const rawB = targetLufs - lufsB;
  const gainDbA = clampGain(rawA);
  const gainDbB = clampGain(rawB);
  const clamped = Math.abs(gainDbA - rawA) > 1e-9 || Math.abs(gainDbB - rawB) > 1e-9;
  const a = gainDbA === 0 ? "±0.0" : `${gainDbA > 0 ? "+" : ""}${gainDbA.toFixed(1)}`;
  const b = gainDbB === 0 ? "±0.0" : `${gainDbB > 0 ? "+" : ""}${gainDbB.toFixed(1)}`;
  return {
    matched: true,
    targetLufs,
    gainDbA,
    gainDbB,
    note:
      `level-matched to ${targetLufs.toFixed(1)} LUFS (A ${a} dB, B ${b} dB)` +
      (clamped ? ` — clamped at ±${MAX_LEVEL_MATCH_GAIN_DB} dB` : ""),
  };
}
