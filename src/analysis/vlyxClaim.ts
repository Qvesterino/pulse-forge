/**
 * VLYX SOUND IDENTITY — the measured claim (Prestige §3.4, chosen 2026-10-18).
 *
 * THE CLAIM, IN ONE SENTENCE
 * --------------------------
 * "VLYX's target-correction rule moves an analysed track toward its reference
 * curve: the mean absolute deviation across the ten octave bands drops, and the
 * drop is measurable on the analysis's own spectral profile."
 *
 * WHY THIS IS HONEST
 * ------------------
 * The rules here are the CORE's, not invented for marketing: the analysis
 * derives ten octave-band levels from `features.spectralProfile`
 * (`db = 10·log10(ratio·10)`), the deviation is `current − target` (non-finite
 * targets sanitised to 0), and the correction is `clamp(−deviation/2, ±6 dB)`
 * applied only when `|deviation| ≥ 1.5 dB`. Those constants are read from
 * `mixAssistant.analyzeWithTarget` (src/effects/ultina-core/) and pinned by
 * `tests/vlyx-claim.test.ts`, including the monotonicity invariant that the
 * mean deviation can never INCREASE (for |dev| ≥ 1.5 the magnitude halves; for
 * smaller deviations nothing is changed).
 *
 * What this deliberately does NOT claim: that the render sounds better. That is
 * the measured A/B the panel already does (render + integrated LUFS), and the
 * card states both numbers separately. A claim about taste would be a lie; a
 * claim about the reference-curve distance is arithmetic.
 *
 * Pure: ratios and a target curve in, numbers out — no audio, no DOM.
 */

/** Octave bands the analysis reports (aligned with `spectralProfile`). */
export const VLYX_OCTAVE_HZ = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
/** The core only corrects deviations at or above this magnitude. */
export const VLYX_TARGET_THRESHOLD_DB = 1.5;
/** The core caps every single correction at this magnitude. */
export const VLYX_TARGET_MAX_ADJUSTMENT_DB = 6;
/** The core halves the deviation (an under-correction on purpose). */
export const VLYX_TARGET_CORRECTION_RATIO = 0.5;

export interface VlyxTonalClaim {
  bands: number;
  /** Mean |current − target| before the correction. */
  meanDeviationDbBefore: number;
  /** Mean |current − target| after applying the rule's corrections. */
  meanDeviationDbAfter: number;
  /** before − after; never negative (see the monotonicity note above). */
  improvementDb: number;
  /** Bands whose |deviation| reached the correction threshold. */
  correctedBands: number;
  /** The prescribed correction per octave band, aligned with VLYX_OCTAVE_HZ. */
  correctionsDb: number[];
}

/** `10·log10(ratio·10)` — the core's dB conversion, with its −60 dB floor. */
export function spectralProfileDb(ratios: readonly number[]): number[] {
  return ratios.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? 10 * Math.log10(ratio * 10 + 1e-20) : -60));
}

/** Deviation from the target, with non-finite targets treated as flat (0 dB). */
export function tonalDeviationDb(currentDb: readonly number[], targetDb: readonly number[]): number[] {
  return currentDb.map((current, index) => {
    const target = targetDb[index];
    return current - (typeof target === "number" && Number.isFinite(target) ? target : 0);
  });
}

/** The core's correction per band: none below the threshold, else half, capped. */
export function tonalCorrectionsDb(deviationDb: readonly number[]): number[] {
  return deviationDb.map((deviation) => {
    if (!Number.isFinite(deviation) || Math.abs(deviation) < VLYX_TARGET_THRESHOLD_DB) return 0;
    return Math.max(
      -VLYX_TARGET_MAX_ADJUSTMENT_DB,
      Math.min(VLYX_TARGET_MAX_ADJUSTMENT_DB, -deviation * VLYX_TARGET_CORRECTION_RATIO),
    );
  });
}

function meanAbs(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
}

/**
 * The claim computed from the analysis's OWN spectral profile:
 * `ratios` = `features.spectralProfile[i].ratio`, `targetDb` = the reference
 * curve in dB per octave band. Returns null when there is nothing to analyse.
 */
export function vlyxTonalClaim(ratios: readonly number[], targetDb: readonly number[]): VlyxTonalClaim | null {
  if (ratios.length === 0) return null;
  const currentDb = spectralProfileDb(ratios);
  const deviation = tonalDeviationDb(currentDb, targetDb);
  const corrections = tonalCorrectionsDb(deviation);
  const after = deviation.map((value, index) => value + corrections[index]!);
  const before = meanAbs(deviation);
  const afterMean = meanAbs(after);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    bands: ratios.length,
    meanDeviationDbBefore: round(before),
    meanDeviationDbAfter: round(afterMean),
    improvementDb: round(before - afterMean),
    correctedBands: corrections.filter((value) => value !== 0).length,
    correctionsDb: corrections.map(round),
  };
}

/** One line for a card or a report: "mean deviation 3.8 → 1.9 dB (−1.9 dB, 6/10 bands)". */
export function formatVlyxClaim(claim: VlyxTonalClaim): string {
  const delta =
    claim.improvementDb > 0
      ? `−${claim.improvementDb.toFixed(1)}`
      : claim.improvementDb < 0
        ? `+${Math.abs(claim.improvementDb).toFixed(1)}`
        : "±0.0";
  return (
    `mean deviation from the reference curve ${claim.meanDeviationDbBefore.toFixed(1)} → ` +
    `${claim.meanDeviationDbAfter.toFixed(1)} dB (${delta} dB, ${claim.correctedBands}/${claim.bands} bands)`
  );
}
