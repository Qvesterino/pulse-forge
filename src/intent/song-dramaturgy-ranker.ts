import {
  SONG_DRAMATURGY_FEATURE_COUNT,
  SONG_FOCUS_FEATURE_INDICES,
  type SongDramaturgyFeatureVectorV1,
  type SongPreferenceFocus,
} from "../ai/features/song-dramaturgy-v1";
import {
  isValidPreferenceObservation,
  type PreferenceContext,
  type PreferenceObservationV1,
} from "./preference-ledger-core";
import { preferenceContextWeight } from "./personal-ranker";

const TRAINING_FOCUSES = ["overall", "development", "transitions", "contrast", "harmony"] as const;
const MIN_COMPARISONS = 2;
const CONFIDENCE_PRIOR_WEIGHT = 6;
const MAX_COMBINED_RESIDUAL = 0.12;
const MAX_FOCUS_RESIDUAL = 0.035;
const EPOCHS = 48;
const LEARNING_RATE = 0.12;
const L2 = 0.035;

interface SongPreferenceCandidateFeatures {
  candidateIndex: number;
  contentHash: string;
  songDramaturgyFeatures?: SongDramaturgyFeatureVectorV1;
}

interface SongPreferenceModel {
  focus: (typeof TRAINING_FOCUSES)[number];
  weights: number[];
  examples: number;
  effectiveExamples: number;
}

export interface SongDramaturgyScore<T extends SongPreferenceCandidateFeatures> {
  candidate: T;
  score: number;
}

export interface SongDramaturgyRanking<T extends SongPreferenceCandidateFeatures> {
  candidates: SongDramaturgyScore<T>[];
  comparisonCount: number;
  confidenceWeight: number;
  applied: boolean;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, value))));
}

function modelForFocus(
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
  focus: (typeof TRAINING_FOCUSES)[number],
): SongPreferenceModel | null {
  const allowed = SONG_FOCUS_FEATURE_INDICES[focus];
  const allowedSet = allowed ? new Set(allowed) : null;
  const examples = observations
    .filter(isValidPreferenceObservation)
    .filter((observation) => observation.context.task === "song")
    .filter((observation) => (observation.songReason ?? "overall") === focus)
    .filter((observation) => observation.reason === undefined)
    .filter((observation) => observation.choice === "a" || observation.choice === "b")
    .flatMap((observation) => {
      const a = observation.candidateA.songDramaturgyFeatures?.values;
      const b = observation.candidateB.songDramaturgyFeatures?.values;
      if (!a || !b || a.length !== SONG_DRAMATURGY_FEATURE_COUNT || b.length !== SONG_DRAMATURGY_FEATURE_COUNT)
        return [];
      const weight = preferenceContextWeight(observation.context, context);
      if (weight <= 0) return [];
      const direction = observation.choice === "a" ? 1 : -1;
      const difference = a.map((feature, index) =>
        allowedSet && !allowedSet.has(index) ? 0 : direction * (feature - (b[index] ?? feature)),
      );
      if (!difference.some((value) => Math.abs(value) > 1e-8)) return [];
      return [
        {
          difference,
          weight,
          at: observation.createdAt,
          tieBreak: [
            observation.context.key,
            observation.candidateA.contentHash,
            observation.candidateB.contentHash,
            focus,
          ].join(":"),
        },
      ];
    })
    .sort((a, b) => a.at - b.at || a.tieBreak.localeCompare(b.tieBreak));
  if (examples.length < MIN_COMPARISONS) return null;

  const weights = new Array<number>(SONG_DRAMATURGY_FEATURE_COUNT).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (const example of examples) {
      let margin = 0;
      for (let index = 0; index < SONG_DRAMATURGY_FEATURE_COUNT; index++) {
        margin += weights[index]! * example.difference[index]!;
      }
      const gradient = example.weight * (1 - sigmoid(margin));
      for (let index = 0; index < SONG_DRAMATURGY_FEATURE_COUNT; index++) {
        weights[index] = Math.max(
          -3,
          Math.min(3, weights[index]! + LEARNING_RATE * (gradient * example.difference[index]! - L2 * weights[index]!)),
        );
      }
    }
  }
  return {
    focus,
    weights,
    examples: examples.length,
    effectiveExamples: examples.reduce((sum, example) => sum + example.weight, 0),
  };
}

function preferenceScore(model: SongPreferenceModel, features: SongDramaturgyFeatureVectorV1): number {
  let margin = 0;
  for (let index = 0; index < SONG_DRAMATURGY_FEATURE_COUNT; index++) {
    margin += model.weights[index]! * features.values[index]!;
  }
  return sigmoid(margin);
}

/** Add a bounded, task-specific song-form residual to an existing global score. */
export function scoreWithSongDramaturgyPreferences<T extends SongPreferenceCandidateFeatures>(
  candidates: readonly T[],
  baseScores: readonly number[],
  observations: readonly PreferenceObservationV1[],
  context: PreferenceContext,
): SongDramaturgyRanking<T> | null {
  if (
    context.task !== "song" ||
    candidates.length < 2 ||
    candidates.length !== baseScores.length ||
    candidates.some(
      (candidate) =>
        !candidate.songDramaturgyFeatures ||
        candidate.songDramaturgyFeatures.values.length !== SONG_DRAMATURGY_FEATURE_COUNT,
    )
  ) {
    return null;
  }
  const models = TRAINING_FOCUSES.map((focus) => modelForFocus(observations, context, focus)).filter(
    (model): model is SongPreferenceModel => model !== null,
  );
  if (models.length === 0) return null;

  const residuals = new Array<number>(candidates.length).fill(0);
  for (const model of models) {
    const scores = candidates.map((candidate) => preferenceScore(model, candidate.songDramaturgyFeatures!));
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const confidence = model.effectiveExamples / (model.effectiveExamples + CONFIDENCE_PRIOR_WEIGHT);
    const weight = (MAX_FOCUS_RESIDUAL / models.length) * confidence;
    scores.forEach((score, index) => {
      residuals[index] += weight * (score - mean);
    });
  }
  const spread = Math.max(...residuals) - Math.min(...residuals);
  const scale = spread > MAX_COMBINED_RESIDUAL ? MAX_COMBINED_RESIDUAL / spread : 1;
  const ranked = candidates.map((candidate, index) => {
    const base = Math.max(0, Math.min(1, Number.isFinite(baseScores[index]) ? baseScores[index]! : 0.5));
    return { candidate, score: Math.max(0, Math.min(1, base + residuals[index]! * scale)) };
  });
  const effectiveExamples = models.reduce((sum, model) => sum + model.effectiveExamples, 0);
  const comparisonCount = models.reduce((sum, model) => sum + model.examples, 0);
  return {
    candidates: ranked,
    comparisonCount,
    confidenceWeight: effectiveExamples / (effectiveExamples + CONFIDENCE_PRIOR_WEIGHT),
    applied: spread > 1e-8,
  };
}

export function isSongPreferenceFocus(value: unknown): value is SongPreferenceFocus {
  return (
    value === "overall" ||
    value === "development" ||
    value === "transitions" ||
    value === "contrast" ||
    value === "harmony" ||
    value === "sound" ||
    value === "mix"
  );
}
