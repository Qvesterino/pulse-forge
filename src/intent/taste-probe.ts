import { FEATURE_COUNT } from "../ai/features/pattern-features";
import { preferenceFeatureIndicesForReason } from "./personal-ranker";
import type { PreferenceReason } from "./preference-ledger-core";

const PROBE_REASONS: readonly PreferenceReason[] = ["groove", "drums", "melody", "space", "energy", "novelty"];
const MIN_AXIS_DELTA = 0.08;
const MIN_AXIS_DOMINANCE = 1.5;
const MIN_OFF_AXIS_FLOOR = 0.025;
const MAX_GLOBAL_SCORE_GAP = 0.1;

export interface TasteProbeCandidate<T> {
  candidate: T;
  candidateIndex: number;
  contentHash: string;
  features: ArrayLike<number>;
  globalScore?: number;
  globalScoreVersion?: string;
}

export interface TasteProbePair<T> {
  candidateA: TasteProbeCandidate<T>;
  candidateB: TasteProbeCandidate<T>;
  reason: PreferenceReason;
  /** RMS distance on the named feature axis, with every feature normalized to [0, 1]. */
  axisDelta: number;
  /** RMS distance across all other features; used to reject confounded pairs. */
  offAxisDelta: number;
  globalScoreGap: number;
}

function isUsable(candidate: TasteProbeCandidate<unknown>): boolean {
  return (
    candidate.contentHash.length > 0 &&
    candidate.features.length === FEATURE_COUNT &&
    candidate.globalScore !== undefined &&
    Number.isFinite(candidate.globalScore) &&
    candidate.globalScore >= 0 &&
    candidate.globalScore <= 1 &&
    typeof candidate.globalScoreVersion === "string" &&
    candidate.globalScoreVersion.length > 0 &&
    Array.from(candidate.features).every((feature) => Number.isFinite(feature) && feature >= 0 && feature <= 1)
  );
}

function rmsDistance(
  featuresA: ArrayLike<number>,
  featuresB: ArrayLike<number>,
  indices: readonly number[],
): number | null {
  if (indices.length === 0) return null;
  const squaredDistance = indices.reduce((sum, index) => {
    const a = featuresA[index] ?? 0;
    const b = featuresB[index] ?? 0;
    return sum + (a - b) ** 2;
  }, 0);
  return Math.sqrt(squaredDistance / indices.length);
}

/**
 * Suggest a controlled local A/B taste question from candidates that already
 * passed the ordinary generation gates. It requires a matched global-selector
 * version and near-tied global scores, then prefers a pair whose measurable
 * difference is concentrated on one supported preference axis.
 *
 * This selects a useful question, not a winner; no observation is written.
 */
export function suggestTasteProbePair<T>(candidates: readonly TasteProbeCandidate<T>[]): TasteProbePair<T> | null {
  const usable = candidates
    .filter(isUsable)
    .slice()
    .sort((a, b) => a.candidateIndex - b.candidateIndex || a.contentHash.localeCompare(b.contentHash));
  if (usable.length < 2) return null;

  const allFeatureIndices = Array.from({ length: FEATURE_COUNT }, (_, index) => index);
  let best: (TasteProbePair<T> & { quality: number }) | null = null;

  for (let left = 0; left < usable.length; left++) {
    for (let right = left + 1; right < usable.length; right++) {
      const candidateA = usable[left];
      const candidateB = usable[right];
      if (!candidateA || !candidateB || candidateA.contentHash === candidateB.contentHash) continue;
      if (candidateA.globalScoreVersion !== candidateB.globalScoreVersion) continue;

      const globalScoreGap = Math.abs(candidateA.globalScore! - candidateB.globalScore!);
      if (globalScoreGap > MAX_GLOBAL_SCORE_GAP) continue;

      for (const reason of PROBE_REASONS) {
        const axisIndices = preferenceFeatureIndicesForReason(reason);
        if (!axisIndices || axisIndices.length === 0) continue;
        const axisSet = new Set(axisIndices);
        const offAxisIndices = allFeatureIndices.filter((index) => !axisSet.has(index));
        const axisDelta = rmsDistance(candidateA.features, candidateB.features, axisIndices);
        const offAxisDelta = rmsDistance(candidateA.features, candidateB.features, offAxisIndices);
        if (axisDelta === null || offAxisDelta === null || axisDelta < MIN_AXIS_DELTA) continue;
        if (axisDelta < MIN_AXIS_DOMINANCE * Math.max(offAxisDelta, MIN_OFF_AXIS_FLOOR)) continue;

        const quality = axisDelta - offAxisDelta - globalScoreGap * 0.25;
        const next = { candidateA, candidateB, reason, axisDelta, offAxisDelta, globalScoreGap, quality };
        if (
          !best ||
          next.quality > best.quality ||
          (next.quality === best.quality &&
            (candidateA.candidateIndex < best.candidateA.candidateIndex ||
              (candidateA.candidateIndex === best.candidateA.candidateIndex &&
                candidateB.candidateIndex < best.candidateB.candidateIndex)))
        ) {
          best = next;
        }
      }
    }
  }

  if (!best) return null;
  const { quality: _quality, ...pair } = best;
  return pair;
}
