/** Diversity-aware ordering for the already gated, already ranked candidate bank. */
import { FEATURE_NAMES } from "../ai/features/pattern-features";

export interface DiverseCandidate {
  candidateIndex: number;
  contentHash: string;
  search?: { lane: string };
}

const DIVERSITY_HEAD_SIZE = 3;
const RELEVANCE_WEIGHT = 0.72;
const STRUCTURAL_FEATURE_INDICES = FEATURE_NAMES.flatMap((name, index) =>
  name.startsWith("drums.") || name.startsWith("melodic.") ? [index] : [],
);

function validVector(vector: ArrayLike<number> | undefined): vector is ArrayLike<number> {
  if (!vector || vector.length !== FEATURE_NAMES.length) return false;
  for (const index of STRUCTURAL_FEATURE_INDICES) {
    const value = vector[index];
    if (!Number.isFinite(value) || value < 0 || value > 1) return false;
  }
  return STRUCTURAL_FEATURE_INDICES.length > 0;
}

/** Average L1 structural distance, excluding prompt-fit and batch-relative features. */
export function candidateFeatureDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!validVector(a) || !validVector(b)) return 0;
  let total = 0;
  for (const index of STRUCTURAL_FEATURE_INDICES) total += Math.abs(a[index] - b[index]);
  return total / STRUCTURAL_FEATURE_INDICES.length;
}

/**
 * Keep the current best candidate first, then use MMR to avoid showing near-
 * identical alternatives next to one another. The rest of the bank retains
 * its incoming order; no candidate is removed and no invalid candidate can
 * enter because callers pass through the shared invariant gate first.
 */
export function diversifyCandidateOrder<T extends DiverseCandidate>(
  ranked: readonly T[],
  featuresByHash: ReadonlyMap<string, ArrayLike<number>>,
  headSize = DIVERSITY_HEAD_SIZE,
): T[] {
  if (ranked.length <= 2 || ranked.some((candidate) => !validVector(featuresByHash.get(candidate.contentHash)))) {
    return [...ranked];
  }

  const limit = Math.max(1, Math.min(Math.floor(headSize), ranked.length));
  if (limit <= 1) return [...ranked];
  const chosen: T[] = [ranked[0]];
  const remaining = ranked.slice(1);

  while (chosen.length < limit && remaining.length > 0) {
    const representedLanes = new Set(chosen.map((candidate) => candidate.search?.lane).filter(Boolean));
    const missingLanePositions = remaining.flatMap((candidate, position) =>
      candidate.search && !representedLanes.has(candidate.search.lane) ? [position] : [],
    );
    // Prefer a representative from each available creative lane before
    // filling the shortlist with another take from an already shown lane.
    const eligiblePositions = missingLanePositions.length > 0 ? missingLanePositions : remaining.map((_, i) => i);
    let bestPosition = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const position of eligiblePositions) {
      const candidate = remaining[position];
      const candidateFeatures = featuresByHash.get(candidate.contentHash)!;
      const rank = ranked.indexOf(candidate);
      // Smooth relevance keeps viable lower-ranked ideas in play without
      // treating the ordinal as a calibrated musical-quality score.
      const relevance = 1 / Math.sqrt(rank + 1);
      const redundancy = Math.max(
        ...chosen.map(
          (selected) => 1 - candidateFeatureDistance(candidateFeatures, featuresByHash.get(selected.contentHash)!),
        ),
      );
      const utility = RELEVANCE_WEIGHT * relevance - (1 - RELEVANCE_WEIGHT) * redundancy;
      if (utility > bestUtility + 1e-12) {
        bestUtility = utility;
        bestPosition = position;
      }
    }
    chosen.push(remaining.splice(bestPosition, 1)[0]);
  }

  const chosenSet = new Set(chosen);
  return [...chosen, ...ranked.filter((candidate) => !chosenSet.has(candidate))];
}
