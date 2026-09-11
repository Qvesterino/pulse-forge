import { extractPatternFeatures, type PatternFeatureVector } from "../features/pattern-features";
import { scoreCandidateFeatures, rankerMode, type RankerMode } from "./ranker-client";
import { currentRankerManifest } from "./ranker-client";
import { rankCandidateBank, type CandidateBankEntry } from "../../intent/candidate-bank";
import type { GenerationPlan } from "../../intent/types";
import type { ProjectDocument } from "../../project-model/types";

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
  const modelScores: (number | null)[] = heuristicOrder.map(() => null);

  if (mode === "off" || heuristicOrder.length < 2) {
    return {
      order: heuristicOrder,
      mode,
      source: mode === "off" ? "off" : "fallback",
      modelScores,
      featureVersion: null,
      rankerVersion: null,
      modelHash: null,
    };
  }

  // Feature extraction for every surviving candidate (batch-relative features
  // see the whole batch — deterministic order).
  const patterns = heuristicOrder.map((entry) => entry.pattern);
  const vectors: PatternFeatureVector[] = patterns.map((pattern) =>
    extractPatternFeatures({
      doc,
      pattern,
      intent: plan.intent,
      options: plan.options,
      resolvedBpm: plan.resolvedBpm,
      batch: patterns,
    }),
  );

  const batch = new Float32Array(heuristicOrder.length * vectors[0].values.length);
  vectors.forEach((vector, index) => batch.set(vector.values, index * vector.values.length));
  const result = await scoreCandidateFeatures(batch, heuristicOrder.length);

  if (!result.ok || !result.scores) {
    // Missing model / timeout / invalid output → heuristic ranking (goal doc).
    return {
      order: heuristicOrder,
      mode,
      source: "fallback",
      modelScores,
      featureVersion: vectors[0]?.version ?? null,
      rankerVersion: null,
      modelHash: null,
    };
  }

  result.scores.forEach((score, index) => {
    modelScores[index] = score;
  });

  if (mode === "shadow") {
    // Shadow: record the ONNX order in diagnostics but DO NOT change the
    // selected result.
    return {
      order: heuristicOrder,
      mode,
      source: "model",
      modelScores,
      featureVersion: vectors[0]?.version ?? null,
      rankerVersion: currentRankerManifest()?.rankerVersion ?? null,
      modelHash: currentRankerManifest()?.modelHash ?? null,
    };
  }

  // Active: deterministic combination, stable sort (score desc, candidate
  // index asc, content hash asc).
  const withScores = heuristicOrder.map((entry, index) => ({
    entry,
    finalScore:
      HEURISTIC_WEIGHT * entry.score + MODEL_WEIGHT * (modelScores[index] ?? entry.score),
  }));
  withScores.sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      a.entry.candidateIndex - b.entry.candidateIndex ||
      a.entry.contentHash.localeCompare(b.entry.contentHash),
  );
  return {
    order: withScores.map((withScore) => withScore.entry),
    mode,
    source: "model",
    modelScores,
    featureVersion: vectors[0]?.version ?? null,
    rankerVersion: currentRankerManifest()?.rankerVersion ?? null,
    modelHash: currentRankerManifest()?.modelHash ?? null,
  };
}
