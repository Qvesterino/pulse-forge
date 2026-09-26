/**
 * Small deterministic pairwise preference model (Producer DNA v1).
 * It learns only from explicit A/B decisions and never replaces hard gates or
 * the global selector. The bounded residual can only reorder valid finalists.
 */
import { FEATURE_COUNT } from "../ai/features/pattern-features";
import {
  isValidPreferenceObservation,
  type PreferenceContext,
  type PreferenceObservationV1,
} from "./preference-ledger-core";

const MIN_COMPARISONS = 2;
const MAX_PERSONAL_RESIDUAL = 0.2;
const EPOCHS = 48;
const LEARNING_RATE = 0.12;
const L2 = 0.035;

interface PairExample {
  difference: number[];
  weight: number;
  at: number;
  tieBreak: string;
}

export interface PersonalPreferenceModel {
  weights: readonly number[];
  comparisonCount: number;
  effectiveComparisonCount: number;
}

function contextWeight(observed: PreferenceContext, current: PreferenceContext): number {
  if (observed.key === current.key) return 1;
  if (observed.genre !== current.genre || observed.task !== current.task) return 0;
  const profileWeight = observed.productionProfile === current.productionProfile ? 1 : 0.3;
  const observedRoles = new Set(observed.roleScope);
  const currentRoles = new Set(current.roleScope);
  const union = new Set([...observedRoles, ...currentRoles]);
  const roleSimilarity = union.size === 0 ? 1 : [...observedRoles].filter((role) => currentRoles.has(role)).length / union.size;
  const roleWeight = union.size === 0 ? 1 : 0.25 + 0.75 * roleSimilarity;
  return profileWeight * roleWeight * 0.45;
}

function pairExamples(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): PairExample[] {
  return observations
    .filter(isValidPreferenceObservation)
    .filter((observation) => observation.choice === "a" || observation.choice === "b")
    .map((observation) => {
      const weight = contextWeight(observation.context, context);
      const direction = observation.choice === "a" ? 1 : -1;
      const difference = observation.candidateA.features.map(
        (feature, index) => direction * (feature - observation.candidateB.features[index]),
      );
      return {
        difference,
        weight,
        at: observation.createdAt,
        tieBreak: `${observation.context.key}:${observation.candidateA.contentHash}:${observation.candidateB.contentHash}`,
      };
    })
    .filter((example) => example.weight > 0)
    .sort((a, b) => a.at - b.at || a.tieBreak.localeCompare(b.tieBreak));
}

function sigmoid(value: number): number {
  const bounded = Math.max(-12, Math.min(12, value));
  return 1 / (1 + Math.exp(-bounded));
}

/** Fit an L2-regularized logistic preference model from A/B comparisons. */
export function fitPersonalPreferenceModel(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): PersonalPreferenceModel | null {
  const examples = pairExamples(observations, context);
  if (examples.length < MIN_COMPARISONS) return null;

  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (const example of examples) {
      let margin = 0;
      for (let index = 0; index < FEATURE_COUNT; index++) margin += weights[index] * example.difference[index];
      const gradient = example.weight * (1 - sigmoid(margin));
      for (let index = 0; index < FEATURE_COUNT; index++) {
        const next = weights[index] + LEARNING_RATE * (gradient * example.difference[index] - L2 * weights[index]);
        weights[index] = Math.max(-3, Math.min(3, next));
      }
    }
  }

  return {
    weights,
    comparisonCount: examples.length,
    effectiveComparisonCount: examples.reduce((sum, example) => sum + example.weight, 0),
  };
}

function modelScore(model: PersonalPreferenceModel, features: ArrayLike<number>): number {
  let margin = 0;
  for (let index = 0; index < FEATURE_COUNT; index++) {
    const feature = features[index];
    if (!Number.isFinite(feature) || feature < 0 || feature > 1) return 0.5;
    margin += model.weights[index] * feature;
  }
  return sigmoid(margin);
}

export interface PreferenceRankCandidate {
  candidateIndex: number;
  contentHash: string;
}

/**
 * Add a bounded personal residual to an already-valid, globally ranked bank.
 * `baseScores` must be in the same order and bounded [0, 1].
 */
export function rerankWithPersonalPreferences<T extends PreferenceRankCandidate>(
  candidates: readonly T[],
  baseScores: readonly number[],
  featureByHash: ReadonlyMap<string, ArrayLike<number>>,
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): T[] {
  if (candidates.length < 2 || candidates.length !== baseScores.length) return [...candidates];
  const model = fitPersonalPreferenceModel(observations, context);
  if (!model) return [...candidates];

  const scores = candidates.map((candidate) => {
    const features = featureByHash.get(candidate.contentHash);
    return features ? modelScore(model, features) : 0.5;
  });
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const confidence = model.effectiveComparisonCount / (model.effectiveComparisonCount + 2);
  const residualWeight = MAX_PERSONAL_RESIDUAL * confidence;
  return candidates
    .map((candidate, index) => {
      const base = Math.max(0, Math.min(1, Number.isFinite(baseScores[index]) ? baseScores[index] : 0));
      return {
        candidate,
        score: base + residualWeight * (scores[index] - mean),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.candidateIndex - b.candidate.candidateIndex ||
        a.candidate.contentHash.localeCompare(b.candidate.contentHash),
    )
    .map(({ candidate }) => candidate);
}
