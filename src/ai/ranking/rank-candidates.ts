import { extractPatternFeatures, type PatternFeatureVector } from "../features/pattern-features";
import { scoreCandidateFeatures, rankerMode, type RankerMode } from "./ranker-client";
import { currentRankerManifest } from "./ranker-client";
import { rankCandidateBank, type CandidateBankEntry } from "../../intent/candidate-bank";
import type { GenerationPlan } from "../../intent/types";
import type { ProjectDocument } from "../../project-model/types";
import { isPreferenceLearningEnabled, preferenceContextForIntent, readPreferenceLedger } from "../../intent/preference-ledger";
import { rerankWithPersonalPreferences } from "../../intent/personal-ranker";

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
): Promise<RankerRanking> {
  const heuristicOrder = rankCandidateBank(doc, candidates);
  const mode = rankerMode();
  const observations = isPreferenceLearningEnabled() ? readPreferenceLedger() : [];
  const hasPairwiseSignal = observations.some((observation) => observation.choice === "a" || observation.choice === "b");
  const needsModel = mode !== "off" && heuristicOrder.length > 1;
  const needsPersonalFeatures = hasPairwiseSignal && heuristicOrder.length > 1;
  const modelScoreByIndex = new Map<number, number>();
  const baseScoreByIndex = new Map(heuristicOrder.map((entry) => [entry.candidateIndex, entry.score]));
  let vectors: PatternFeatureVector[] = [];

  if (!needsModel && !needsPersonalFeatures) {
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
  vectors = patterns.map((pattern) =>
    extractPatternFeatures({
      doc,
      pattern,
      intent: plan.intent,
      options: plan.options,
      resolvedBpm: plan.resolvedBpm,
      batch: patterns,
    }),
  );
  const featureByHash = new Map(heuristicOrder.map((entry, index) => [entry.contentHash, vectors[index].values]));
  const featureVersion = vectors[0]?.version ?? null;

  const finish = (
    baseOrder: CandidateBankEntry[],
    source: RankerRanking["source"],
    rankerVersion: string | null,
    modelHash: string | null,
  ): RankerRanking => {
    let order = baseOrder;
    if (needsPersonalFeatures) {
      order = rerankWithPersonalPreferences(
        baseOrder,
        baseOrder.map((entry) => baseScoreByIndex.get(entry.candidateIndex) ?? entry.score),
        featureByHash,
        observations,
        preferenceContextForIntent(plan.intent),
      );
    }
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
    // A model failure leaves the global heuristic intact; explicit local
    // preferences may still add their bounded, post-gate residual.
    return finish(heuristicOrder, "fallback", null, null);
  }

  result.scores.forEach((score, index) => {
    const candidate = heuristicOrder[index];
    if (candidate) modelScoreByIndex.set(candidate.candidateIndex, score);
  });

  if (mode === "shadow") {
    // Shadow: record ONNX scores without letting them reorder the bank.
    return finish(heuristicOrder, "model", currentRankerManifest()?.rankerVersion ?? null, currentRankerManifest()?.modelHash ?? null);
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
