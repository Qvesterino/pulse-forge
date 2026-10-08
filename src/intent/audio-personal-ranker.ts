import type { AudioFeatures, AudioFeaturesV2, StereoAudioFeatures } from "../ai/audio-features";
import {
  AUDIO_PREFERENCE_FEATURE_COUNT,
  AUDIO_PREFERENCE_V2_FEATURE_COUNT,
  isValidPreferenceObservation,
  type AudioPreferenceVector,
  type AudioPreferenceVectorV1,
  type AudioPreferenceVectorV2,
  type PreferenceContext,
  type PreferenceObservationV1,
  type PreferenceReason,
} from "./preference-ledger-core";

const MIN_COMPARISONS = 2;
const CONFIDENCE_PRIOR_WEIGHT = 6;
const MAX_PERSONAL_AUDIO_RESIDUAL = 0.12;
const MAX_REASON_AUDIO_RESIDUAL = 0.045;
const EPOCHS = 48;
const LEARNING_RATE = 0.12;
const L2 = 0.035;

const AUDIO_REASON_INDICES: Partial<Record<PreferenceReason, readonly number[]>> = {
  level: [0, 1],
  dynamics: [2],
  brightness: [3, 5, 6, 7],
  lowEnd: [4],
  timbre: [5, 6, 7],
  voicing: [8],
  stereo: [9, 10],
  mix: [0, 1, 2, 9, 10],
};
const AUDIO_REASONS = Object.keys(AUDIO_REASON_INDICES) as PreferenceReason[];
const AUDIO_REASON_SET = new Set<PreferenceReason>(AUDIO_REASONS);

export function isAudioPreferenceReason(reason: PreferenceReason): boolean {
  return AUDIO_REASON_SET.has(reason);
}

interface PairExample {
  difference: number[];
  weight: number;
  at: number;
  tieBreak: string;
}

interface AudioPreferenceModel {
  weights: number[];
  effectiveComparisonCount: number;
  reason: PreferenceReason | null;
}

export interface AudioPreferenceCandidate {
  candidateIndex: number;
  contentHash: string;
}

export interface AudioPreferenceEvidence {
  comparisonCount: number;
  exactContextComparisons: number;
  effectiveComparisonCount: number;
  confidenceWeight: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Compact, versioned rendered-audio features. Never stores PCM or a spectrogram. */
export function audioPreferenceVector(features: AudioFeatures): AudioPreferenceVectorV1 {
  return {
    version: "audio.v1",
    values: [
      clamp01(Number.isFinite(features.rms) ? features.rms : 0),
      clamp01(Number.isFinite(features.peak) ? features.peak : 0),
      clamp01((Number.isFinite(features.crestFactor) ? features.crestFactor : 0) / 20),
      clamp01((Number.isFinite(features.zeroCrossingRate) ? features.zeroCrossingRate : 0) / 0.4),
      clamp01(Number.isFinite(features.lowBandRatio) ? features.lowBandRatio : 0),
    ],
  };
}

/** audio.v2 retains the audio.v1 prefix and adds timbre, voicing and stereo. */
export function audioPreferenceVectorV2(
  features: AudioFeaturesV2,
  stereo?: StereoAudioFeatures,
): AudioPreferenceVectorV2 {
  const legacy = audioPreferenceVector(features);
  return {
    version: "audio.v2",
    values: [
      ...legacy.values,
      clamp01(features.spectralCentroid),
      clamp01(features.spectralRolloff),
      clamp01(features.spectralFlatness),
      clamp01(features.harmonicity),
      clamp01(stereo?.width ?? 0.5),
      clamp01(stereo?.correlation ?? 0.5),
    ],
    available: [
      ...Array.from({ length: AUDIO_PREFERENCE_FEATURE_COUNT }, () => true),
      true,
      true,
      true,
      true,
      !!stereo,
      !!stereo,
    ],
  };
}

function normalizeVector(vector: AudioPreferenceVector): {
  values: number[];
  available: boolean[];
  version: "audio.v1" | "audio.v2";
} {
  if (vector.version === "audio.v2") {
    return { values: [...vector.values], available: [...vector.available], version: "audio.v2" };
  }
  return {
    values: [...vector.values, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    available: [
      ...Array.from({ length: AUDIO_PREFERENCE_FEATURE_COUNT }, () => true),
      false,
      false,
      false,
      false,
      false,
      false,
    ],
    version: "audio.v1",
  };
}

function commonFeatureMask(a: ReturnType<typeof normalizeVector>, b: ReturnType<typeof normalizeVector>): boolean[] {
  return Array.from(
    { length: AUDIO_PREFERENCE_V2_FEATURE_COUNT },
    (_, index) => (a.available[index] ?? false) && (b.available[index] ?? false),
  );
}

function allowedIndices(reason: PreferenceReason, version: "audio.v1" | "audio.v2"): readonly number[] {
  const indices = AUDIO_REASON_INDICES[reason] ?? [];
  if (version === "audio.v2") return indices;
  return indices.filter((index) => index < AUDIO_PREFERENCE_FEATURE_COUNT);
}

export function supportsAudioPreferenceReason(
  reason: PreferenceReason,
  candidateA: AudioPreferenceVector | undefined,
  candidateB: AudioPreferenceVector | undefined,
): boolean {
  if (!candidateA || !candidateB || !isAudioPreferenceReason(reason)) return false;
  const a = normalizeVector(candidateA);
  const b = normalizeVector(candidateB);
  const allowed = new Set([...allowedIndices(reason, a.version), ...allowedIndices(reason, b.version)]);
  return commonFeatureMask(a, b).some((available, index) => available && allowed.has(index));
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

function observationKey(observation: PreferenceObservationV1): string {
  return [
    observation.context.key,
    observation.candidateA.contentHash,
    observation.candidateB.contentHash,
    observation.choice,
    observation.createdAt,
  ].join(":");
}

function pairExamples(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
  reason?: PreferenceReason,
): PairExample[] {
  return observations
    .filter(isValidPreferenceObservation)
    .filter((observation) => observation.choice === "a" || observation.choice === "b")
    .filter((observation) => (reason ? observation.reason === reason : observation.reason === undefined))
    .filter((observation) => {
      if (observation.context.task !== "song") return true;
      const focus = observation.songReason ?? "overall";
      if (focus === "overall") return reason === undefined;
      if (focus === "sound") return reason === "timbre";
      if (focus === "mix") return reason === "mix";
      return false;
    })
    .filter((observation) => observation.candidateA.audioFeatures && observation.candidateB.audioFeatures)
    .map((observation) => {
      const weight = contextWeight(observation.context, context);
      const direction = observation.choice === "a" ? 1 : -1;
      const a = normalizeVector(observation.candidateA.audioFeatures!);
      const b = normalizeVector(observation.candidateB.audioFeatures!);
      const common = commonFeatureMask(a, b);
      const allowed = reason
        ? new Set([...allowedIndices(reason, a.version), ...allowedIndices(reason, b.version)])
        : null;
      return {
        difference: a.values.map((feature, index) =>
          !common[index] || (allowed && !allowed.has(index)) ? 0 : direction * (feature - (b.values[index] ?? feature)),
        ),
        weight,
        at: observation.createdAt,
        tieBreak: observationKey(observation),
      };
    })
    .filter((example) => example.weight > 0 && example.difference.some((value) => Math.abs(value) > 1e-8))
    .sort((a, b) => a.at - b.at || a.tieBreak.localeCompare(b.tieBreak));
}

function sigmoid(value: number): number {
  const bounded = Math.max(-12, Math.min(12, value));
  return 1 / (1 + Math.exp(-bounded));
}

function fitModel(examples: readonly PairExample[], reason: PreferenceReason | null): AudioPreferenceModel | null {
  if (examples.length < MIN_COMPARISONS) return null;
  const weights = new Array<number>(AUDIO_PREFERENCE_V2_FEATURE_COUNT).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (const example of examples) {
      let margin = 0;
      for (let index = 0; index < AUDIO_PREFERENCE_V2_FEATURE_COUNT; index++) {
        margin += weights[index] * (example.difference[index] ?? 0);
      }
      const gradient = example.weight * (1 - sigmoid(margin));
      for (let index = 0; index < AUDIO_PREFERENCE_V2_FEATURE_COUNT; index++) {
        const difference = example.difference[index] ?? 0;
        weights[index] = Math.max(
          -3,
          Math.min(3, weights[index] + LEARNING_RATE * (gradient * difference - L2 * weights[index])),
        );
      }
    }
  }
  return {
    weights,
    effectiveComparisonCount: examples.reduce((sum, example) => sum + example.weight, 0),
    reason,
  };
}

function fitModels(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): AudioPreferenceModel[] {
  return [
    fitModel(pairExamples(observations, context), null),
    ...AUDIO_REASONS.map((reason) => fitModel(pairExamples(observations, context, reason), reason)),
  ].filter((model): model is AudioPreferenceModel => model !== null);
}

/**
 * Add a small local-audio residual after the deterministic genre audio fit.
 * Candidates without a rendered audio vector are left at their base score.
 */
export function scoreWithPersonalAudioPreferences<T extends AudioPreferenceCandidate>(
  candidates: readonly T[],
  baseScores: readonly number[],
  featureByHash: ReadonlyMap<string, AudioPreferenceVector>,
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): number[] | null {
  if (candidates.length < 2 || candidates.length !== baseScores.length) return null;
  const models = fitModels(observations, context);
  if (models.length === 0) return null;
  const vectors = candidates.map((candidate) => {
    const vector = featureByHash.get(candidate.contentHash);
    return vector ? normalizeVector(vector) : null;
  });
  const availableVectors = vectors.filter((vector): vector is NonNullable<typeof vector> => vector !== null);
  if (availableVectors.length < 2) return null;
  const commonFeatures = Array.from({ length: AUDIO_PREFERENCE_V2_FEATURE_COUNT }, (_, index) =>
    availableVectors.every((vector) => vector.available[index] ?? false),
  );
  const residuals = new Array<number>(candidates.length).fill(0);
  const reasonModels = models.filter((model) => model.reason !== null);
  for (const model of models) {
    const scores = vectors.map((vector) => {
      if (!vector) return null;
      let margin = 0;
      for (let index = 0; index < AUDIO_PREFERENCE_V2_FEATURE_COUNT; index++) {
        if (!commonFeatures[index]) continue;
        margin += model.weights[index] * (vector.values[index] ?? 0.5);
      }
      return sigmoid(margin);
    });
    const present = scores.filter((score): score is number => score !== null);
    if (present.length < 2) continue;
    const mean = present.reduce((sum, score) => sum + score, 0) / present.length;
    const confidence = model.effectiveComparisonCount / (model.effectiveComparisonCount + CONFIDENCE_PRIOR_WEIGHT);
    const residualWeight =
      (model.reason === null ? MAX_PERSONAL_AUDIO_RESIDUAL : MAX_REASON_AUDIO_RESIDUAL / reasonModels.length) *
      confidence;
    scores.forEach((score, index) => {
      if (score !== null) residuals[index] += residualWeight * (score - mean);
    });
  }
  const spread = Math.max(...residuals) - Math.min(...residuals);
  if (spread <= 1e-8) return null;
  const scale = spread > MAX_PERSONAL_AUDIO_RESIDUAL ? MAX_PERSONAL_AUDIO_RESIDUAL / spread : 1;
  return candidates.map((_, index) => {
    const base = clamp01(Number.isFinite(baseScores[index]) ? (baseScores[index] ?? 0) : 0);
    return base + residuals[index] * scale;
  });
}

export function personalAudioPreferenceEvidence(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): AudioPreferenceEvidence {
  const relevantByAdapter = new Map<string, { key: string; weight: number; exact: boolean }[]>();
  for (const observation of observations) {
    if (!isValidPreferenceObservation(observation)) continue;
    if (
      (observation.choice !== "a" && observation.choice !== "b") ||
      !observation.candidateA.audioFeatures ||
      !observation.candidateB.audioFeatures ||
      (observation.reason !== undefined && !isAudioPreferenceReason(observation.reason))
    ) {
      continue;
    }
    const weight = contextWeight(observation.context, context);
    const key = observationKey(observation);
    const a = normalizeVector(observation.candidateA.audioFeatures);
    const b = normalizeVector(observation.candidateB.audioFeatures);
    const allowed = observation.reason
      ? new Set([...allowedIndices(observation.reason, a.version), ...allowedIndices(observation.reason, b.version)])
      : null;
    const common = commonFeatureMask(a, b);
    const differs = common.some(
      (isAvailable, index) =>
        isAvailable &&
        (!allowed || allowed.has(index)) &&
        Math.abs((a.values[index] ?? 0) - (b.values[index] ?? 0)) > 1e-8,
    );
    if (weight <= 0 || !differs) continue;
    const adapter = observation.reason ?? "general";
    const rows = relevantByAdapter.get(adapter) ?? [];
    if (rows.some((row) => row.key === key)) continue;
    rows.push({ key, weight, exact: weight === 1 });
    relevantByAdapter.set(adapter, rows);
  }
  const relevant = [...relevantByAdapter.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const effectiveComparisonCount = relevant.reduce((sum, row) => sum + row.weight, 0);
  return {
    comparisonCount: relevant.length,
    exactContextComparisons: relevant.filter((row) => row.exact).length,
    effectiveComparisonCount,
    confidenceWeight: effectiveComparisonCount / (effectiveComparisonCount + CONFIDENCE_PRIOR_WEIGHT),
  };
}
