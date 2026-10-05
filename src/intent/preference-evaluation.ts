import { isValidPreferenceObservation, type PreferenceObservationV1 } from "./preference-ledger-core";
import { scoreWithPersonalPreferences } from "./personal-ranker";

const SCORE_TIE_EPSILON = 1e-9;
const MIN_TRAINING_CHOICES = 2;

export interface PersonalPreferenceEvaluationReport {
  inputObservations: number;
  validObservations: number;
  explicitChoiceObservations: number;
  evaluatedComparisons: number;
  /** Accuracy on later A/B choices, with exact score ties worth half a point. */
  globalAccuracy: number | null;
  personalAccuracy: number | null;
  personalLift: number | null;
  /**
   * Conservative bounded-data intervals. They assume independent comparison
   * rows; the ledger currently lacks session grouping, so these are diagnostic
   * uncertainty estimates rather than population-level confidence claims.
   */
  uncertainty95: {
    globalAccuracy: { lower: number; upper: number } | null;
    personalAccuracy: { lower: number; upper: number } | null;
    personalLift: { lower: number; upper: number } | null;
  };
  globalScoreVersions: string[];
  skipped: {
    nonDirectionalChoice: number;
    missingGlobalScore: number;
    mixedGlobalScoreVersion: number;
    previouslySeenCandidate: number;
    insufficientPriorChoices: number;
    unavailablePersonalModel: number;
  };
  caveat: string;
}

function observationKey(observation: PreferenceObservationV1): string {
  return [
    observation.context.key,
    observation.candidateA.contentHash,
    observation.candidateB.contentHash,
    observation.choice,
  ].join(":");
}

function choiceCredit(scoreA: number, scoreB: number, choice: "a" | "b"): number {
  if (Math.abs(scoreA - scoreB) <= SCORE_TIE_EPSILON) return 0.5;
  return (scoreA > scoreB ? "a" : "b") === choice ? 1 : 0;
}

function boundedHoeffdingInterval(
  values: readonly number[],
  lowerBound: number,
  upperBound: number,
): { lower: number; upper: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const radius = (upperBound - lowerBound) * Math.sqrt(Math.log(40) / (2 * values.length));
  return {
    lower: Math.max(lowerBound, mean - radius),
    upper: Math.min(upperBound, mean + radius),
  };
}

/**
 * Evaluate future explicit choices against the score from the non-personal
 * selector captured with each comparison. Training is strictly chronological;
 * ties in timestamps are held out together, and a candidate content hash that
 * appeared in prior data cannot also score as a held-out candidate.
 *
 * This is a diagnostic, not a claim of population-level statistical validity:
 * the local ledger has no prompt/session grouping, so the report states that
 * limitation explicitly.
 */
export function evaluatePersonalPreferences(input: readonly unknown[]): PersonalPreferenceEvaluationReport {
  const observations = input
    .filter(isValidPreferenceObservation)
    .sort((a, b) => a.createdAt - b.createdAt || observationKey(a).localeCompare(observationKey(b)));
  const training: PreferenceObservationV1[] = [];
  const seenCandidateHashes = new Set<string>();
  const globalVersions = new Set<string>();
  const skipped = {
    nonDirectionalChoice: 0,
    missingGlobalScore: 0,
    mixedGlobalScoreVersion: 0,
    previouslySeenCandidate: 0,
    insufficientPriorChoices: 0,
    unavailablePersonalModel: 0,
  };
  let explicitChoiceObservations = 0;
  let evaluatedComparisons = 0;
  const globalCredits: number[] = [];
  const personalCredits: number[] = [];
  const pairedLift: number[] = [];

  for (let start = 0; start < observations.length;) {
    const timestamp = observations[start]?.createdAt;
    let end = start + 1;
    while (end < observations.length && observations[end]?.createdAt === timestamp) end++;
    const group = observations.slice(start, end);

    for (const observation of group) {
      if (observation.source === "edit") {
        // Corrections are valid training evidence for later explicit choices,
        // but they have no captured global baseline and are not evaluation rows.
        continue;
      }
      if (observation.choice !== "a" && observation.choice !== "b") {
        skipped.nonDirectionalChoice++;
        continue;
      }
      explicitChoiceObservations++;

      const { candidateA, candidateB } = observation;
      if (
        candidateA.globalScore === undefined ||
        candidateB.globalScore === undefined ||
        candidateA.globalScoreVersion === undefined ||
        candidateB.globalScoreVersion === undefined
      ) {
        skipped.missingGlobalScore++;
        continue;
      }
      if (candidateA.globalScoreVersion !== candidateB.globalScoreVersion) {
        skipped.mixedGlobalScoreVersion++;
        continue;
      }
      if (seenCandidateHashes.has(candidateA.contentHash) || seenCandidateHashes.has(candidateB.contentHash)) {
        skipped.previouslySeenCandidate++;
        continue;
      }

      const priorChoices = training.filter((item) => item.choice === "a" || item.choice === "b").length;
      if (priorChoices < MIN_TRAINING_CHOICES) {
        skipped.insufficientPriorChoices++;
        continue;
      }

      const pair = [
        { candidateIndex: 0, contentHash: candidateA.contentHash },
        { candidateIndex: 1, contentHash: candidateB.contentHash },
      ];
      const features = new Map([
        [candidateA.contentHash, candidateA.features],
        [candidateB.contentHash, candidateB.features],
      ]);
      const personal = scoreWithPersonalPreferences(
        pair,
        [candidateA.globalScore, candidateB.globalScore],
        features,
        training,
        observation.context,
      );
      if (!personal) {
        skipped.unavailablePersonalModel++;
        continue;
      }

      const globalCredit = choiceCredit(candidateA.globalScore, candidateB.globalScore, observation.choice);
      const personalCredit = choiceCredit(personal[0]?.score ?? 0.5, personal[1]?.score ?? 0.5, observation.choice);
      globalCredits.push(globalCredit);
      personalCredits.push(personalCredit);
      pairedLift.push(personalCredit - globalCredit);
      globalVersions.add(candidateA.globalScoreVersion);
      evaluatedComparisons++;
    }

    // Outcomes at the same timestamp are not allowed to train one another.
    for (const observation of group) {
      seenCandidateHashes.add(observation.candidateA.contentHash);
      seenCandidateHashes.add(observation.candidateB.contentHash);
      if (observation.choice === "a" || observation.choice === "b") training.push(observation);
    }
    start = end;
  }

  const globalAccuracy =
    evaluatedComparisons > 0 ? globalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalAccuracy =
    evaluatedComparisons > 0 ? personalCredits.reduce((sum, credit) => sum + credit, 0) / evaluatedComparisons : null;
  const personalLift =
    evaluatedComparisons > 0 ? pairedLift.reduce((sum, lift) => sum + lift, 0) / evaluatedComparisons : null;
  return {
    inputObservations: input.length,
    validObservations: observations.length,
    explicitChoiceObservations,
    evaluatedComparisons,
    globalAccuracy,
    personalAccuracy,
    personalLift,
    uncertainty95: {
      globalAccuracy: boundedHoeffdingInterval(globalCredits, 0, 1),
      personalAccuracy: boundedHoeffdingInterval(personalCredits, 0, 1),
      personalLift: boundedHoeffdingInterval(pairedLift, -1, 1),
    },
    globalScoreVersions: [...globalVersions].sort(),
    skipped,
    caveat:
      "Chronological, candidate-hash-disjoint holdout within the local ledger; prompt/session groups are not stored, so this is a diagnostic and not a statistically independent user study.",
  };
}
