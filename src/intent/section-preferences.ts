import { extractPatternFeaturesV2, FEATURE_V2_COUNT } from "../ai/features/pattern-features-v2";
import { canonicalizePattern } from "../ai/evaluation";
import { hashString } from "../shared/rng";
import type { ProjectDocument } from "../project-model/types";
import { audioPreferenceVectorV2, scoreWithPersonalAudioPreferences } from "./audio-personal-ranker";
import { scoreWithPersonalPreferences } from "./personal-ranker";
import { scoreCandidate } from "./candidate-bank";
import { preferenceContextForIntent, type PreferenceCandidateInput } from "./preference-ledger";
import type { PreferenceObservationV1 } from "./preference-ledger-core";
import { generateOptionsFromIntent } from "./plan";
import { normalizeIntent } from "./normalize";
import type { SongAudioReview } from "./song-audio-review";
import type { SongBuildSection } from "./song";
import { createSongSectionIntent } from "./song-section-intent";
import type { IntentInput, IntentSpec } from "./types";
import type { SearchLane } from "./candidate-search";

export interface SectionPreferenceCandidate extends PreferenceCandidateInput {
  candidateIndex: number;
  sectionIndex: number;
  role: string;
  bars: number;
  lane: SearchLane | null;
  intent: IntentSpec;
}

/** Create a privacy-safe symbolic/audio snapshot for one complete section take. */
export function sectionPreferenceCandidate(
  doc: ProjectDocument,
  baseIntent: IntentSpec,
  section: SongBuildSection,
  sectionIndex: number,
  candidateIndex: number,
  lane: SearchLane | null,
  audioReview?: SongAudioReview | null,
): SectionPreferenceCandidate | null {
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || !section.pattern) return null;
  const storedIntent = section.pattern.generation?.intent;
  const intent = storedIntent
    ? normalizeIntent(storedIntent as unknown as IntentInput)
    : createSongSectionIntent(baseIntent, {
        index: sectionIndex,
        role: section.role,
        bars: section.bars,
        energy: baseIntent.energy + section.energyDelta,
        density: baseIntent.density + section.densityDelta,
        complexity: baseIntent.complexity + section.complexityDelta,
        candidateCount: 1,
        roles: section.roles,
      });
  const features = extractPatternFeaturesV2({
    doc,
    pattern: section.pattern,
    intent,
    options: generateOptionsFromIntent(intent),
    resolvedBpm: section.pattern.generation?.resolvedBpm ?? null,
    batch: [section.pattern],
  });
  if (features.values.length !== FEATURE_V2_COUNT) return null;

  const audioFeatures = audioReview
    ? audioPreferenceVectorV2(audioReview.audioFeatures, audioReview.stereoFeatures)
    : undefined;
  const content = JSON.stringify({
    pattern: canonicalizePattern(doc, section.pattern),
    role: section.role,
    bars: section.bars,
    fx: section.fx ?? null,
  });

  return {
    candidateIndex,
    contentHash: hashString(content).toString(16).padStart(8, "0"),
    features: features.values,
    ...(audioFeatures ? { audioFeatures } : {}),
    globalScore: scoreCandidate(section.pattern),
    globalScoreVersion: "global-section.v1:pattern-quality",
    sectionIndex,
    role: section.role,
    bars: section.bars,
    lane,
    intent,
  };
}

/** Attach the exact section-level personal scores used at feedback time. */
export function scoreSectionPreferencePair(
  candidates: readonly [SectionPreferenceCandidate, SectionPreferenceCandidate],
  observations: readonly PreferenceObservationV1[],
): readonly [SectionPreferenceCandidate, SectionPreferenceCandidate] {
  const [candidateA, candidateB] = candidates;
  const context = preferenceContextForIntent(candidateA.intent, "section");
  const pair = [candidateA, candidateB] as const;
  const globalScores = pair.map((candidate) => Math.max(0, Math.min(1, candidate.globalScore ?? 0.5)));
  const symbolicScores = scoreWithPersonalPreferences(
    pair,
    globalScores,
    new Map(pair.map((candidate) => [candidate.contentHash, candidate.features])),
    observations,
    context,
  );
  const audioFeatures = new Map(
    pair.flatMap((candidate) =>
      candidate.audioFeatures ? [[candidate.contentHash, candidate.audioFeatures] as const] : [],
    ),
  );
  const audioScores = scoreWithPersonalAudioPreferences(pair, globalScores, audioFeatures, observations, context);
  if (!symbolicScores && !audioScores) return pair;
  const residuals = pair.map((_, index) => {
    const global = globalScores[index] ?? 0.5;
    const symbolicResidual = (symbolicScores?.[index]?.score ?? global) - global;
    const audioResidual = (audioScores?.[index] ?? global) - global;
    return Math.max(-0.2, Math.min(0.2, symbolicResidual + audioResidual));
  });
  return [
    { ...candidateA, personalScore: Math.max(0, Math.min(1, (globalScores[0] ?? 0.5) + (residuals[0] ?? 0))) },
    { ...candidateB, personalScore: Math.max(0, Math.min(1, (globalScores[1] ?? 0.5) + (residuals[1] ?? 0))) },
  ];
}
