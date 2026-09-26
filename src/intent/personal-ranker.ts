/**
 * Small deterministic pairwise preference model (Producer DNA v1).
 * It learns only from explicit A/B decisions and never replaces hard gates or
 * the global selector. The bounded residual can only reorder valid finalists.
 */
import { FEATURE_COUNT, FEATURE_NAMES } from "../ai/features/pattern-features";
import {
  isValidPreferenceObservation,
  type PreferenceContext,
  type PreferenceObservationV1,
  type PreferenceReason,
} from "./preference-ledger-core";

const MIN_COMPARISONS = 2;
const MAX_PERSONAL_RESIDUAL = 0.2;
const MAX_REASON_RESIDUAL = 0.08;
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
  reason: PreferenceReason | null;
}

export interface PersonalSearchBias {
  energy: number;
  density: number;
  complexity: number;
  variation: number;
  /** Positive values favor recurring melodic motifs; negative values favor novelty. */
  motifRepetition: number;
  /** Positive values favor syncopated grooves; negative values favor straighter grooves. */
  grooveSyncopation: number;
  evidenceCount: number;
}

const indicesForNames = (...names: string[]): readonly number[] =>
  names.map((name) => FEATURE_NAMES.indexOf(name)).filter((index) => index >= 0);

const indicesForPrefix = (prefix: string): readonly number[] =>
  FEATURE_NAMES.flatMap((name, index) => (name.startsWith(prefix) ? [index] : []));

const REASON_FEATURE_INDICES: Readonly<Record<PreferenceReason, readonly number[] | null>> = {
  groove: indicesForNames(
    "drums.syncopation",
    "drums.offbeatRatio",
    "drums.styleDistanceFit",
    "drums.barRepetition",
    "drums.velocitySpread",
    "drums.microtimingPresence",
  ),
  drums: indicesForPrefix("drums."),
  // features.v1 has no bass-track or chord-progression measurements. Do not
  // pretend unrelated drum/melody dimensions explain those preferences.
  bass: null,
  harmony: null,
  melody: indicesForPrefix("melodic."),
  // In this pattern-level model, “space” means phrase spacing, not stereo
  // width, reverb, or mix depth (none of those are features.v1 dimensions).
  space: indicesForNames("melodic.restRatio", "melodic.longestGap"),
  // These are arrangement proxies, not measured loudness or mix energy.
  energy: indicesForNames("intent.energyFit", "drums.density", "drums.velocitySpread", "melodic.noteDensity"),
  novelty: indicesForNames(
    "melodic.motifNovelty",
    "melodic.intervalVariety",
    "melodic.motifRepetition",
    "drums.barRepetition",
  ),
};

const SUPPORTED_REASONS = Object.keys(REASON_FEATURE_INDICES).filter(
  (reason) => REASON_FEATURE_INDICES[reason as PreferenceReason]?.length,
) as PreferenceReason[];

const SEARCH_AXES = {
  energy: [
    ["intent.energyFit", 1],
    ["drums.velocitySpread", 1],
    ["drums.density", 1],
    ["melodic.noteDensity", 1],
  ],
  density: [
    ["drums.density", 1],
    ["melodic.noteDensity", 1],
    ["melodic.occupiedSteps", 1],
    ["melodic.restRatio", -1],
    ["melodic.longestGap", -1],
  ],
  complexity: [
    ["drums.syncopation", 1],
    ["drums.offbeatRatio", 1],
    ["drums.ghostRatio", 1],
    ["melodic.intervalVariety", 1],
    ["melodic.motifNovelty", 1],
    ["melodic.pitchRange", 1],
  ],
  variation: [
    ["drums.barRepetition", -1],
    ["melodic.motifRepetition", -1],
    ["melodic.motifNovelty", 1],
  ],
  motifRepetition: [
    ["melodic.motifRepetition", 1],
    ["melodic.motifNovelty", -1],
  ],
  grooveSyncopation: [
    ["drums.syncopation", 1],
    ["drums.offbeatRatio", 1],
  ],
} as const;

/** Feature dimensions a reason-specific adapter is allowed to learn from. */
export function preferenceFeatureIndicesForReason(reason: PreferenceReason): readonly number[] | null {
  return REASON_FEATURE_INDICES[reason];
}

export function isPreferenceReasonRankable(reason: PreferenceReason): boolean {
  return (REASON_FEATURE_INDICES[reason]?.length ?? 0) > 0;
}

function contextWeight(observed: PreferenceContext, current: PreferenceContext): number {
  if (observed.key === current.key) return 1;
  if (observed.genre !== current.genre || observed.task !== current.task) return 0;
  const profileWeight = observed.productionProfile === current.productionProfile ? 1 : 0.3;
  const observedRoles = new Set(observed.roleScope);
  const currentRoles = new Set(current.roleScope);
  const union = new Set([...observedRoles, ...currentRoles]);
  const roleSimilarity =
    union.size === 0 ? 1 : [...observedRoles].filter((role) => currentRoles.has(role)).length / union.size;
  const roleWeight = union.size === 0 ? 1 : 0.25 + 0.75 * roleSimilarity;
  return profileWeight * roleWeight * 0.45;
}

function pairExamples(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
  reason?: PreferenceReason,
): PairExample[] {
  const allowedFeatures = reason ? new Set(preferenceFeatureIndicesForReason(reason) ?? []) : null;
  return (
    observations
      .filter(isValidPreferenceObservation)
      .filter((observation) => observation.choice === "a" || observation.choice === "b")
      // Unlabelled A/B votes teach the general adapter. A reason-tagged vote
      // trains only that reason's adapter, never unrelated feature dimensions.
      .filter((observation) => (reason ? observation.reason === reason : observation.reason === undefined))
      .map((observation) => {
        const weight = contextWeight(observation.context, context);
        const direction = observation.choice === "a" ? 1 : -1;
        const difference = observation.candidateA.features.map((feature, index) =>
          allowedFeatures && !allowedFeatures.has(index)
            ? 0
            : direction * (feature - observation.candidateB.features[index]),
        );
        return {
          difference,
          weight,
          at: observation.createdAt,
          tieBreak: `${observation.context.key}:${observation.candidateA.contentHash}:${observation.candidateB.contentHash}`,
        };
      })
      .filter((example) => example.weight > 0 && example.difference.some((value) => Math.abs(value) > 1e-8))
      .sort((a, b) => a.at - b.at || a.tieBreak.localeCompare(b.tieBreak))
  );
}

function sigmoid(value: number): number {
  const bounded = Math.max(-12, Math.min(12, value));
  return 1 / (1 + Math.exp(-bounded));
}

/** Fit an L2-regularized logistic preference model from A/B comparisons. */
export function fitPersonalPreferenceModel(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
  reason?: PreferenceReason,
): PersonalPreferenceModel | null {
  if (reason && !isPreferenceReasonRankable(reason)) return null;
  const examples = pairExamples(observations, context, reason);
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
    reason: reason ?? null,
  };
}

function fitAvailablePreferenceModels(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): PersonalPreferenceModel[] {
  return [
    fitPersonalPreferenceModel(observations, context),
    ...SUPPORTED_REASONS.map((reason) => fitPersonalPreferenceModel(observations, context, reason)),
  ].filter((model): model is PersonalPreferenceModel => model !== null);
}

/**
 * Translate learned feature preferences into small, bounded search nudges.
 * These are soft generator inputs only; the original intent remains the gate
 * and provenance source. Axes are intentionally coarse and deterministic.
 */
export function inferPersonalSearchBias(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): PersonalSearchBias | null {
  const models = fitAvailablePreferenceModels(observations, context);
  if (models.length === 0) return null;

  const nudge = (axis: keyof typeof SEARCH_AXES): number => {
    const features = SEARCH_AXES[axis]
      .map(([name, polarity]) => ({ index: FEATURE_NAMES.indexOf(name), polarity }))
      .filter(({ index }) => index >= 0);
    if (features.length === 0) return 0;

    const modelSignals = models
      .map((model) => {
        const reasonFeatures = model.reason ? new Set(preferenceFeatureIndicesForReason(model.reason) ?? []) : null;
        const relevant = features.filter(({ index }) => !reasonFeatures || reasonFeatures.has(index));
        if (relevant.length === 0) return null;
        const signal =
          relevant.reduce((sum, feature) => sum + model.weights[feature.index] * feature.polarity, 0) /
          Math.sqrt(relevant.length);
        const confidence = model.effectiveComparisonCount / (model.effectiveComparisonCount + 2);
        return signal * confidence;
      })
      .filter((signal): signal is number => signal !== null && Math.abs(signal) > 1e-8);
    if (modelSignals.length === 0) return 0;
    const average = modelSignals.reduce((sum, signal) => sum + signal, 0) / modelSignals.length;
    return Math.max(-0.12, Math.min(0.12, average * 0.08));
  };

  const bias = {
    energy: nudge("energy"),
    density: nudge("density"),
    complexity: nudge("complexity"),
    variation: nudge("variation"),
    motifRepetition: nudge("motifRepetition"),
    grooveSyncopation: nudge("grooveSyncopation"),
    evidenceCount: Math.max(...models.map((model) => model.comparisonCount)),
  };
  return [
    bias.energy,
    bias.density,
    bias.complexity,
    bias.variation,
    bias.motifRepetition,
    bias.grooveSyncopation,
  ].some((value) => Math.abs(value) > 1e-8)
    ? bias
    : null;
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

/** Per-candidate score after adding the bounded DNA residual to the global baseline. */
export interface PersonalPreferenceScore<T extends PreferenceRankCandidate> {
  candidate: T;
  score: number;
}

/**
 * Score an already-valid bank with the same bounded personal residual used by
 * {@link rerankWithPersonalPreferences}. Returns null when no learnable model
 * is available, which lets offline evaluation distinguish cold-start from a
 * real personal prediction.
 */
export function scoreWithPersonalPreferences<T extends PreferenceRankCandidate>(
  candidates: readonly T[],
  baseScores: readonly number[],
  featureByHash: ReadonlyMap<string, ArrayLike<number>>,
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): PersonalPreferenceScore<T>[] | null {
  if (candidates.length < 2 || candidates.length !== baseScores.length) return null;
  const models = fitAvailablePreferenceModels(observations, context);
  if (models.length === 0) return null;

  const featuresByCandidate = candidates.map((candidate) => featureByHash.get(candidate.contentHash));
  const residualByIndex = new Array<number>(candidates.length).fill(0);
  const reasonModels = models.filter((model) => model.reason !== null);
  for (const model of models) {
    const scores = featuresByCandidate.map((features) => (features ? modelScore(model, features) : 0.5));
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const confidence = model.effectiveComparisonCount / (model.effectiveComparisonCount + 2);
    const maxResidual = model.reason === null ? MAX_PERSONAL_RESIDUAL : MAX_REASON_RESIDUAL / reasonModels.length;
    const residualWeight = maxResidual * confidence;
    scores.forEach((score, index) => {
      residualByIndex[index] += residualWeight * (score - mean);
    });
  }

  // Even when several reason adapters are available, the combined personal
  // signal remains bounded and can never overwhelm global relevance.
  const minimumResidual = Math.min(...residualByIndex);
  const maximumResidual = Math.max(...residualByIndex);
  const residualSpread = maximumResidual - minimumResidual;
  const scale = residualSpread > MAX_PERSONAL_RESIDUAL ? MAX_PERSONAL_RESIDUAL / residualSpread : 1;
  return candidates.map((candidate, index) => {
    const base = Math.max(0, Math.min(1, Number.isFinite(baseScores[index]) ? baseScores[index] : 0));
    return {
      candidate,
      score: base + residualByIndex[index] * scale,
    };
  });
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
  const scored = scoreWithPersonalPreferences(candidates, baseScores, featureByHash, observations, context);
  if (!scored) return [...candidates];
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.candidateIndex - b.candidate.candidateIndex ||
        a.candidate.contentHash.localeCompare(b.candidate.contentHash),
    )
    .map(({ candidate }) => candidate);
}
