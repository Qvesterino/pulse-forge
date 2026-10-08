import { extractPatternFeatures, type PatternFeatureVector } from "../features/pattern-features";
import { extractPatternFeaturesV2 } from "../features/pattern-features-v2";
import { scoreCandidateFeatures, rankerMode, type RankerMode } from "./ranker-client";
import { currentRankerManifest } from "./ranker-client";
import { rankCandidateBank, type CandidateBankEntry } from "../../intent/candidate-bank";
import type { GenerationPlan } from "../../intent/types";
import type { Pattern, ProjectDocument } from "../../project-model/types";
import {
  isPreferenceLearningEnabled,
  preferenceContextForIntent,
  readPreferenceLedger,
} from "../../intent/preference-ledger";
import { scoreWithPersonalPreferences } from "../../intent/personal-ranker";
import { diversifyCandidateOrder } from "../../intent/candidate-diversity";

/**
 * Candidate-bank integration (goal doc Fáze 4): the heuristic ranking stays
 * the baseline and the FALLBACK; the ONNX ranker re-orders already-valid
 * candidates only, and — in "shadow" mode — records its order without
 * changing the selected result.
 *
 * hardGate is implicit: only candidates that survived the invariant gates
 * reach this module, and the model can never promote a rejected candidate.
 */
export interface RankerRanking {
  order: CandidateBankEntry[];
  mode: RankerMode;
  source: "model" | "fallback" | "off";
  modelScores: readonly (number | null)[];
  featureVersion: string | null;
  rankerVersion: string | null;
  modelHash: string | null;
  /** Present when the model path failed unexpectedly (vs a controlled score fallback). */
  fallbackReason?: string;
}

const HEURISTIC_WEIGHT = 0.6;
const MODEL_WEIGHT = 0.4;

export async function rankCandidatesWithModel(
  doc: ProjectDocument,
  candidates: readonly CandidateBankEntry[],
  plan: GenerationPlan,
  preferenceTask: import("../../intent/preference-ledger-core").PreferenceTask = "pattern",
): Promise<RankerRanking> {
  const heuristicOrder = rankCandidateBank(doc, candidates);
  const mode = rankerMode();
  const observations = isPreferenceLearningEnabled() ? readPreferenceLedger() : [];
  const hasPairwiseSignal = observations.some(
    (observation) => observation.choice === "a" || observation.choice === "b",
  );
  const needsModel = mode !== "off" && heuristicOrder.length > 1;
  const needsPersonalFeatures = hasPairwiseSignal && heuristicOrder.length > 1;
  const needsDiversity = heuristicOrder.length > 2;
  const modelScoreByIndex = new Map<number, number>();
  const baseScoreByIndex = new Map(heuristicOrder.map((entry) => [entry.candidateIndex, entry.score]));
  let vectors: PatternFeatureVector[] = [];

  if (!needsModel && !needsPersonalFeatures && !needsDiversity) {
    return {
      order: heuristicOrder,
      mode,
      source: mode === "off" ? "off" : "fallback",
      modelScores: heuristicOrder.map(() => null),
      featureVersion: null,
      rankerVersion: null,
      modelHash: null,
    };
  }

  // Both the ONNX and personal selector consume the same versioned,
  // deterministic feature vectors. Batch-relative values see the same bank.
  const patterns = heuristicOrder.map((entry) => entry.pattern);
  const featureInput = (pattern: Pattern) => ({
    doc,
    pattern,
    intent: plan.intent,
    options: plan.options,
    resolvedBpm: plan.resolvedBpm,
    batch: patterns,
  });
  vectors = patterns.map((pattern) => extractPatternFeatures(featureInput(pattern)));
  const featureByHash = new Map(heuristicOrder.map((entry, index) => [entry.contentHash, vectors[index].values]));
  const featureVersion = vectors[0]?.version ?? null;
  // W4: the personal residual and diversity need the v2 contract (bass /
  // harmony / arrangement axes); the shipped ONNX ranker keeps its 54-dim
  // v1 vectors. v2 extends v1 by a byte-identical prefix, so the two
  // consumers can coexist on the same bank.
  const personalVectors = needsPersonalFeatures
    ? heuristicOrder.map((entry) => extractPatternFeaturesV2(featureInput(entry.pattern)))
    : null;
  const personalFeatureByHash =
    personalVectors === null
      ? featureByHash
      : new Map(heuristicOrder.map((entry, index) => [entry.contentHash, personalVectors[index].values]));

  const finish = (
    baseOrder: CandidateBankEntry[],
    source: RankerRanking["source"],
    rankerVersion: string | null,
    modelHash: string | null,
  ): RankerRanking => {
    const globalScoreVersion =
      source === "model" && mode === "active"
        ? `global-selector.v1:hybrid:${rankerVersion ?? "unknown"}`
        : "global-selector.v1:heuristic";
    const globallyScored = baseOrder.map((entry) => ({
      ...entry,
      globalScore: baseScoreByIndex.get(entry.candidateIndex) ?? entry.score,
      globalScoreVersion,
    }));
    let order = globallyScored;
    if (needsPersonalFeatures) {
      const personalScores = scoreWithPersonalPreferences(
        globallyScored,
        globallyScored.map((entry) => entry.globalScore ?? entry.score),
        personalFeatureByHash,
        observations,
        preferenceContextForIntent(plan.intent, preferenceTask),
      );
      if (personalScores) {
        order = personalScores
          .map(({ candidate, score }) => ({ ...candidate, personalScore: score }))
          .sort(
            (a, b) =>
              (b.personalScore ?? b.globalScore ?? b.score) - (a.personalScore ?? a.globalScore ?? a.score) ||
              a.candidateIndex - b.candidateIndex ||
              a.contentHash.localeCompare(b.contentHash),
          );
      }
    }
    if (needsDiversity) order = diversifyCandidateOrder(order, featureByHash);
    return {
      order,
      mode,
      source,
      modelScores: order.map((entry) => modelScoreByIndex.get(entry.candidateIndex) ?? null),
      featureVersion,
      rankerVersion,
      modelHash,
    };
  };

  if (!needsModel) {
    return finish(heuristicOrder, "off", null, null);
  }

  const batch = new Float32Array(heuristicOrder.length * vectors[0].values.length);
  vectors.forEach((vector, index) => batch.set(vector.values, index * vector.values.length));
  const result = await scoreCandidateFeatures(batch, heuristicOrder.length);

  if (!result.ok || !result.scores) {
    // A model failure leaves the global heuristic intact; stored local
    // preferences may still add their bounded, post-gate residual.
    return finish(heuristicOrder, "fallback", null, null);
  }

  result.scores.forEach((score, index) => {
    const candidate = heuristicOrder[index];
    if (candidate) modelScoreByIndex.set(candidate.candidateIndex, score);
  });

  if (mode === "shadow") {
    // Shadow: record ONNX scores without letting them reorder the bank.
    return finish(
      heuristicOrder,
      "model",
      currentRankerManifest()?.rankerVersion ?? null,
      currentRankerManifest()?.modelHash ?? null,
    );
  }

  // Active: global ranker remains the baseline; personal taste is a bounded
  // residual applied after this ordering, never a hard-constraint bypass.
  const withScores = heuristicOrder.map((entry) => {
    const modelScore = modelScoreByIndex.get(entry.candidateIndex) ?? entry.score;
    const finalScore = HEURISTIC_WEIGHT * entry.score + MODEL_WEIGHT * modelScore;
    baseScoreByIndex.set(entry.candidateIndex, finalScore);
    return { entry, finalScore };
  });
  withScores.sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      a.entry.candidateIndex - b.entry.candidateIndex ||
      a.entry.contentHash.localeCompare(b.entry.contentHash),
  );
  return finish(
    withScores.map((withScore) => withScore.entry),
    "model",
    currentRankerManifest()?.rankerVersion ?? null,
    currentRankerManifest()?.modelHash ?? null,
  );
}
