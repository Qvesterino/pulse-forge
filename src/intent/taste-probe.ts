import { FEATURE_COUNT } from "../ai/features/pattern-features";
import { FEATURE_V2_COUNT, isSupportedFeatureVector } from "../ai/features/pattern-features-v2";
import { createPreferencePairUncertaintyScorer, preferenceFeatureIndicesForReason } from "./personal-ranker";
import type { PreferenceContext, PreferenceObservationV1, PreferenceReason } from "./preference-ledger-core";

/**
 * W4: "bass" and "harmony" are real, measured axes since features.v2 — the
 * picker can now ask the question those votes actually train.
 */
const PROBE_REASONS: readonly PreferenceReason[] = [
  "groove",
  "drums",
  "bass",
  "harmony",
  "melody",
  "space",
  "energy",
  "novelty",
];
const MIN_AXIS_DELTA = 0.08;
const MIN_AXIS_DOMINANCE = 1.5;
const MIN_OFF_AXIS_FLOOR = 0.025;
const MAX_GLOBAL_SCORE_GAP = 0.1;
const PILOT_SCORE_TIE_EPSILON = 1e-9;

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

export interface BlindProducerDnaPilotCandidate<T> {
  candidate: T;
  candidateIndex: number;
  contentHash: string;
  globalScore?: number;
  personalScore?: number;
  globalScoreVersion?: string;
}

export interface BlindProducerDnaPilotPair<T> {
  globalCandidate: BlindProducerDnaPilotCandidate<T>;
  personalCandidate: BlindProducerDnaPilotCandidate<T>;
}

/** Stable key so a pair is recognized independently of its displayed A/B sides. */
export function tasteProbePairKey(contentHashA: string, contentHashB: string): string {
  return JSON.stringify([contentHashA, contentHashB].sort());
}

/** Keep the probe's display-side assignment independent from candidate rank. */
export function orderTasteProbeSides<T>(
  pair: TasteProbePair<T>,
  swapSides: boolean,
): readonly [TasteProbeCandidate<T>, TasteProbeCandidate<T>] {
  return swapSides ? [pair.candidateB, pair.candidateA] : [pair.candidateA, pair.candidateB];
}

/**
 * Compare the global and personal selector's top picks from one shared bank.
 * Both selectors need a unique winner and matching global-policy versions;
 * otherwise the pair cannot measure which ranking better matched the user.
 */
export function suggestBlindProducerDnaPilotPair<T>(
  candidates: readonly BlindProducerDnaPilotCandidate<T>[],
): BlindProducerDnaPilotPair<T> | null {
  const usable = candidates.filter(
    (candidate) =>
      candidate.contentHash.length > 0 &&
      typeof candidate.globalScore === "number" &&
      Number.isFinite(candidate.globalScore) &&
      candidate.globalScore >= 0 &&
      candidate.globalScore <= 1 &&
      typeof candidate.personalScore === "number" &&
      Number.isFinite(candidate.personalScore) &&
      candidate.personalScore >= 0 &&
      candidate.personalScore <= 1 &&
      typeof candidate.globalScoreVersion === "string" &&
      candidate.globalScoreVersion.length > 0,
  );
  const versions = new Set(usable.map((candidate) => candidate.globalScoreVersion));
  if (usable.length < 2 || versions.size !== 1) return null;

  const byScore =
    (score: "globalScore" | "personalScore") =>
    (a: BlindProducerDnaPilotCandidate<T>, b: BlindProducerDnaPilotCandidate<T>) =>
      (b[score] ?? 0) - (a[score] ?? 0) ||
      a.candidateIndex - b.candidateIndex ||
      a.contentHash.localeCompare(b.contentHash);
  const globalRanking = [...usable].sort(byScore("globalScore"));
  const personalRanking = [...usable].sort(byScore("personalScore"));
  const globalCandidate = globalRanking[0];
  const globalRunnerUp = globalRanking[1];
  const personalCandidate = personalRanking[0];
  const personalRunnerUp = personalRanking[1];
  if (!globalCandidate || !globalRunnerUp || !personalCandidate || !personalRunnerUp) return null;
  if (
    globalCandidate.contentHash === personalCandidate.contentHash ||
    (globalCandidate.globalScore ?? 0) - (globalRunnerUp.globalScore ?? 0) <= PILOT_SCORE_TIE_EPSILON ||
    (personalCandidate.personalScore ?? 0) - (personalRunnerUp.personalScore ?? 0) <= PILOT_SCORE_TIE_EPSILON
  ) {
    return null;
  }
  return { globalCandidate, personalCandidate };
}

function isUsable(candidate: TasteProbeCandidate<unknown>): boolean {
  return (
    candidate.contentHash.length > 0 &&
    // W4 dual-read: a v1 or v2 vector is probe-able; the axis widths are read
    // from the candidate's own vector, so v2-only reasons simply have no
    // signal on a v1 bank and are skipped by the axisDelta threshold.
    isSupportedFeatureVector(candidate.features) &&
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
export function suggestTasteProbePair<T>(
  candidates: readonly TasteProbeCandidate<T>[],
  excludedPairKeys: ReadonlySet<string> = new Set(),
  reasonEvidenceCounts: Partial<Record<PreferenceReason, number>> = {},
  preferenceObservations?: readonly PreferenceObservationV1[],
  context?: PreferenceContext,
): TasteProbePair<T> | null {
  const usable = candidates
    .filter(isUsable)
    .slice()
    .sort((a, b) => a.candidateIndex - b.candidateIndex || a.contentHash.localeCompare(b.contentHash));
  if (usable.length < 2) return null;

  // The off-axis set must cover the WIDER of the two contracts, so a v1 pair is
  // not "confounded" by the v2 axes it does not have.
  const allFeatureIndices = Array.from({ length: Math.max(FEATURE_COUNT, FEATURE_V2_COUNT) }, (_, index) => index);
  const uncertaintyForPair =
    preferenceObservations && context ? createPreferencePairUncertaintyScorer(preferenceObservations, context) : null;
  let best: (TasteProbePair<T> & { quality: number }) | null = null;

  for (let left = 0; left < usable.length; left++) {
    for (let right = left + 1; right < usable.length; right++) {
      const candidateA = usable[left];
      const candidateB = usable[right];
      if (!candidateA || !candidateB || candidateA.contentHash === candidateB.contentHash) continue;
      if (excludedPairKeys.has(tasteProbePairKey(candidateA.contentHash, candidateB.contentHash))) continue;
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

        const measurableQuality = axisDelta - offAxisDelta - globalScoreGap * 0.25;
        // Prefer an otherwise equally clean axis that has not been explicitly
        // explored yet; this is an information-gain proxy, not a taste score.
        const evidenceCount = Math.max(0, reasonEvidenceCounts[reason] ?? 0);
        const uncertainty = uncertaintyForPair
          ? uncertaintyForPair(reason, candidateA.features, candidateB.features)
          : 1 / Math.sqrt(1 + evidenceCount);
        const quality = measurableQuality * uncertainty;
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
