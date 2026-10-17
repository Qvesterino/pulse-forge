/**
 * SHADOW ADJUDICATION (CI for taste).
 *
 * The ranker already has an off/shadow/active idiom for model traffic. This
 * module extends the same idea to a MUSICAL policy — the audio-fit weight —
 * with the one property that makes shadow mode worth anything: the decision
 * that was NOT shown gets adjudicated later against what the human actually
 * kept.
 *
 * HOW IT WORKS, AND WHY IT NEEDS NO NEW RUNTIME COST
 * --------------------------------------------------
 * The audio-fit ledger already stores, per generation, every finalist's
 * (firstPass, audio) coordinates and which candidate the engine delivered. The
 * human's pick arrives through the reaction join (`candidateIndex` on the
 * applied proposal). With those three facts, ANY weight's ordering is a pure
 * function — so the counterfactual is computed at report time, not rendered:
 *
 *   combined(candidate) = (1 - weight) * firstPass + weight * audio
 *   winner              = argmax combined, ties broken by the smaller
 *                         candidateIndex (the rerank's own tiebreak)
 *
 * The verdict answers the only question that matters: *which ordering would
 * have picked what the human kept?* A shadow that wins becomes the active
 * policy; a shadow that loses was still worth the experiment, and the report
 * says so instead of quietly discarding it.
 *
 * Nothing here is a claim about musical quality — it is a claim about
 * AGREEMENT with decisions the human already made.
 */
import type { AudioFitObservationV1 } from "./audio-fit-ledger";

/** The pick a given weight would make for one generation's finalists. */
export function winnerCandidateIndexAtWeight(observation: AudioFitObservationV1, weight: number): number | null {
  const candidates = observation.candidates;
  if (candidates.length === 0) return null;
  const w = Math.max(0, Math.min(1, weight));
  let best = candidates[0]!;
  let bestScore = (1 - w) * best.firstPass + w * best.audio;
  for (const candidate of candidates.slice(1)) {
    const score = (1 - w) * candidate.firstPass + w * candidate.audio;
    // Deterministic tiebreak mirrors the rerank: lower candidateIndex wins.
    if (
      score > bestScore + 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 && candidate.candidateIndex < best.candidateIndex)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.candidateIndex;
}

export interface ShadowAdjudicationRow {
  generationId: string;
  /** The candidate the ACTIVE policy would have picked. */
  activeWinner: number | null;
  /** The candidate the SHADOW policy would have picked. */
  shadowWinner: number | null;
  /** The candidate the human actually applied, when known. */
  humanPick: number | null;
  activeAgrees: boolean | null;
  shadowAgrees: boolean | null;
  /** True when both policies pick the same candidate (the generation cannot separate them). */
  indistinguishable: boolean;
}

export interface ShadowAdjudicationReport {
  rows: ShadowAdjudicationRow[];
  /** Generations where the human's pick is known (the only ones that can judge). */
  adjudicable: number;
  activeAgreed: number;
  shadowAgreed: number;
  /** Generations where the two policies picked the same candidate. */
  indistinguishable: number;
  /** Human picks that NEITHER policy would have made. */
  neitherAgreed: number;
  verdict: "active" | "shadow" | "tie" | "no-evidence";
  detail: string;
}

export interface ShadowAdjudicationInput {
  observations: readonly AudioFitObservationV1[];
  /** The policy currently in force (e.g. the learned weight). */
  activeWeight: number;
  /** The policy being trialled in shadow (e.g. the shipped default). */
  shadowWeight: number;
  /** Human picks by generation id (from the reaction join). */
  humanPicks: ReadonlyMap<string, number>;
}

export function adjudicateShadow(input: ShadowAdjudicationInput): ShadowAdjudicationReport {
  // A comparison of a policy with itself is not an experiment. Say so first,
  // rather than reporting a meaningless "tie" the reader could misread as
  // evidence that both are equal in quality.
  if (Math.abs(input.activeWeight - input.shadowWeight) < 1e-9) {
    return {
      rows: [],
      adjudicable: 0,
      activeAgreed: 0,
      shadowAgreed: 0,
      indistinguishable: 0,
      neitherAgreed: 0,
      verdict: "tie",
      detail: `both policies use weight ${input.shadowWeight} — nothing to adjudicate`,
    };
  }

  const rows: ShadowAdjudicationRow[] = [];
  let adjudicable = 0;
  let activeAgreed = 0;
  let shadowAgreed = 0;
  let indistinguishable = 0;
  let neitherAgreed = 0;

  for (const observation of input.observations) {
    const activeWinner = winnerCandidateIndexAtWeight(observation, input.activeWeight);
    const shadowWinner = winnerCandidateIndexAtWeight(observation, input.shadowWeight);
    const humanPick = input.humanPicks.get(observation.generationId) ?? null;
    const same = activeWinner != null && activeWinner === shadowWinner;
    const row: ShadowAdjudicationRow = {
      generationId: observation.generationId,
      activeWinner,
      shadowWinner,
      humanPick,
      activeAgrees: humanPick == null ? null : activeWinner === humanPick,
      shadowAgrees: humanPick == null ? null : shadowWinner === humanPick,
      indistinguishable: same,
    };
    rows.push(row);
    if (humanPick == null) continue;
    adjudicable += 1;
    if (same) indistinguishable += 1;
    if (row.activeAgrees === true) activeAgreed += 1;
    if (row.shadowAgrees === true) shadowAgreed += 1;
    if (row.activeAgrees !== true && row.shadowAgrees !== true) neitherAgreed += 1;
  }

  let verdict: ShadowAdjudicationReport["verdict"];
  if (adjudicable < 2) verdict = "no-evidence";
  else if (activeAgreed === shadowAgreed) verdict = "tie";
  else verdict = activeAgreed > shadowAgreed ? "active" : "shadow";

  const detail =
    verdict === "no-evidence"
      ? `not enough adjudicable generations (${adjudicable}) — the shadow needs at least 2 human picks`
      : verdict === "tie"
        ? `the two policies agree with the human equally often (${activeAgreed}/${adjudicable}) — keep the simpler one`
        : verdict === "active"
          ? `the ACTIVE policy agreed with the human ${activeAgreed}/${adjudicable}, the shadow ${shadowAgreed}/${adjudicable} — keep the active policy`
          : `the SHADOW policy agreed with the human ${shadowAgreed}/${adjudicable}, the active ${activeAgreed}/${adjudicable} — the shadow is the better policy on this evidence`;

  return {
    rows,
    adjudicable,
    activeAgreed,
    shadowAgreed,
    indistinguishable,
    neitherAgreed,
    verdict,
    detail,
  };
}
