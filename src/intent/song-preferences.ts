import { extractPatternFeaturesV2, FEATURE_V2_COUNT } from "../ai/features/pattern-features-v2";
import { extractSongDramaturgyFeatures } from "../ai/features/song-dramaturgy-v1";
import { canonicalizePattern } from "../ai/evaluation";
import { scoreCandidate } from "./candidate-bank";
import { generateOptionsFromIntent } from "./plan";
import {
  audioPreferenceVectorV2,
  personalAudioPreferenceEvidence,
  scoreWithPersonalAudioPreferences,
} from "./audio-personal-ranker";
import type { SongAudioReview } from "./song-audio-review";
import { normalizeIntent } from "./normalize";
import { scoreWithPersonalPreferences } from "./personal-ranker";
import { scoreWithSongDramaturgyPreferences } from "./song-dramaturgy-ranker";
import { createSongSectionIntent } from "./song-section-intent";
import { hashString } from "../shared/rng";
import type { PreferenceCandidateInput } from "./preference-ledger";
import { preferenceContextForIntent } from "./preference-ledger";
import type { PreferenceContext, PreferenceObservationV1 } from "./preference-ledger-core";
import type { IntentInput, IntentSpec } from "./types";
import type { ProjectDocument } from "../project-model/types";
import type { SongBuildSection } from "./song";

export interface SongPreferenceCandidate extends PreferenceCandidateInput {
  candidateIndex: number;
}

export interface RankedSongPreferenceCandidate {
  candidate: SongPreferenceCandidate;
  score: number;
  globalScore: number;
  symbolicResidual: number;
  audioResidual: number;
  dramaturgyResidual: number;
}

export interface RankedSongPreferences {
  context: PreferenceContext;
  candidates: RankedSongPreferenceCandidate[];
  comparisonCount: number;
  confidenceWeight: number;
  audioPreferenceApplied: boolean;
  dramaturgyComparisonCount: number;
  dramaturgyConfidenceWeight: number;
  dramaturgyPreferenceApplied: boolean;
}

const MAX_COMBINED_SONG_RESIDUAL = 0.2;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Re-rank only complete song candidates that have both a global snapshot and
 * a successful rendered-audio vector. The song task remains isolated, and
 * the combined personal residual keeps the existing pattern-ranker ceiling.
 */
export function rankRenderedSongPreferences(
  candidates: readonly SongPreferenceCandidate[],
  observations: readonly PreferenceObservationV1[],
  baseIntent: IntentSpec,
): RankedSongPreferences | null {
  if (candidates.length < 2) return null;
  const unique = new Set(candidates.map((candidate) => candidate.contentHash));
  if (unique.size < 2 || candidates.some((candidate) => !candidate.audioFeatures)) return null;

  const context = preferenceContextForIntent(baseIntent, "song");
  const globalScores = candidates.map((candidate) => clamp01(candidate.globalScore ?? 0.5));
  const symbolicScores = scoreWithPersonalPreferences(
    candidates,
    globalScores,
    new Map(candidates.map((candidate) => [candidate.contentHash, candidate.features])),
    observations,
    context,
  );
  const audioFeatures = new Map(
    candidates.flatMap((candidate) =>
      candidate.audioFeatures ? [[candidate.contentHash, candidate.audioFeatures] as const] : [],
    ),
  );
  const audioScores = scoreWithPersonalAudioPreferences(candidates, globalScores, audioFeatures, observations, context);
  const dramaturgyScores = scoreWithSongDramaturgyPreferences(candidates, globalScores, observations, context);
  if (!audioScores && !symbolicScores && !dramaturgyScores) return null;
  const evidence = personalAudioPreferenceEvidence(observations, context);
  const ranked = candidates.map((candidate, index) => {
    const globalScore = globalScores[index] ?? 0.5;
    const symbolicResidual = (symbolicScores?.[index]?.score ?? globalScore) - globalScore;
    const audioResidual = (audioScores?.[index] ?? globalScore) - globalScore;
    const dramaturgyResidual = (dramaturgyScores?.candidates[index]?.score ?? globalScore) - globalScore;
    const combinedResidual = Math.max(
      -MAX_COMBINED_SONG_RESIDUAL,
      Math.min(MAX_COMBINED_SONG_RESIDUAL, symbolicResidual + audioResidual + dramaturgyResidual),
    );
    return {
      candidate: { ...candidate, personalScore: clamp01(globalScore + combinedResidual) },
      globalScore,
      symbolicResidual,
      audioResidual,
      dramaturgyResidual,
      score: clamp01(globalScore + combinedResidual),
    };
  });
  ranked.sort((a, b) => b.score - a.score || a.candidate.candidateIndex - b.candidate.candidateIndex);
  return {
    context,
    candidates: ranked,
    comparisonCount: evidence.comparisonCount,
    confidenceWeight: evidence.confidenceWeight,
    audioPreferenceApplied: audioScores !== null,
    dramaturgyComparisonCount: dramaturgyScores?.comparisonCount ?? 0,
    dramaturgyConfidenceWeight: dramaturgyScores?.confidenceWeight ?? 0,
    dramaturgyPreferenceApplied: dramaturgyScores?.applied ?? false,
  };
}

/** Build a fixed-width, duration-weighted symbolic snapshot for a complete song. */
export function songPreferenceCandidate(
  doc: ProjectDocument,
  baseIntent: IntentSpec,
  sections: readonly SongBuildSection[],
  candidateIndex: number,
  audioReview?: SongAudioReview | null,
): SongPreferenceCandidate | null {
  if (sections.length === 0) return null;
  const patterns = sections.map((section) => section.pattern);
  const vectorSums = new Array<number>(FEATURE_V2_COUNT).fill(0);
  let totalBars = 0;
  let scoreSum = 0;
  const contentParts: string[] = [];
  const sectionFeatureVectors: Float32Array[] = [];

  sections.forEach((section, index) => {
    const storedIntent = section.pattern.generation?.intent;
    const intent = storedIntent
      ? normalizeIntent(storedIntent as unknown as IntentInput)
      : createSongSectionIntent(baseIntent, {
          index,
          role: section.role,
          bars: section.bars,
          energy: baseIntent.energy + section.energyDelta,
          density: baseIntent.density + section.densityDelta,
          complexity: baseIntent.complexity + section.complexityDelta,
          candidateCount: 1,
          roles: section.roles,
        });
    const feature = extractPatternFeaturesV2({
      doc,
      pattern: section.pattern,
      intent,
      options: generateOptionsFromIntent(intent),
      resolvedBpm: section.pattern.generation?.resolvedBpm ?? null,
      batch: patterns,
    });
    sectionFeatureVectors.push(feature.values);
    const bars = Math.max(1, Number.isFinite(section.bars) ? section.bars : 1);
    for (let featureIndex = 0; featureIndex < vectorSums.length; featureIndex++) {
      vectorSums[featureIndex] += (feature.values[featureIndex] ?? 0.5) * bars;
    }
    totalBars += bars;
    scoreSum += scoreCandidate(section.pattern) * bars;
    contentParts.push(JSON.stringify(canonicalizePattern(doc, section.pattern)));
  });

  const audioFeatures = audioReview
    ? audioPreferenceVectorV2(audioReview.audioFeatures, audioReview.stereoFeatures)
    : undefined;
  return {
    candidateIndex,
    contentHash: hashString(contentParts.join("|song-section|")).toString(16).padStart(8, "0"),
    features: vectorSums.map((value) => value / Math.max(1, totalBars)),
    songDramaturgyFeatures: extractSongDramaturgyFeatures(sections, sectionFeatureVectors),
    ...(audioFeatures ? { audioFeatures } : {}),
    globalScore: scoreSum / Math.max(1, totalBars),
    globalScoreVersion: "global-song.v1:section-quality-mean",
  };
}
