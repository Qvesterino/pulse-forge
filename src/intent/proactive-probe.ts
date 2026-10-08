import { suggestTasteProbePair, tasteProbePairKey, type TasteProbeCandidate, type TasteProbePair } from "./taste-probe";
import type { PreferenceContext, PreferenceObservationV1, PreferenceReason } from "./preference-ledger-core";

/**
 * W3 — PROACTIVE TASTE PROBES.
 *
 * The Producer DNA panel has always waited for the user to press "NAVRHNÚŤ
 * TASTE PROBE". That is a decision, and a DAW should not have to be asked
 * twice to learn: after N generations in the same context WITHOUT an explicit
 * vote, the panel offers a question on its own.
 *
 * The rules that keep this from becoming annoying are deliberately strict:
 *   - it is ONE question, not a queue (dismissal resets the streak),
 *   - it only fires on a controlled pair (the existing picker guarantees a
 *     single measurable axis and a near-tied global score),
 *   - it is suppressed while learning is paused, when there is no usable
 *     bank, or when the same pair was already compared in this context,
 *   - nothing is ever recorded without an explicit user choice.
 *
 * Pure decision logic lives in `proactiveProbeState` so it is unit-testable;
 * the counters are session state (a reload legitimately starts fresh).
 */

/** Generations without a vote before the panel offers a question. */
export const PROBE_PATIENCE = 3;

export interface ProactiveProbeInput<T> {
  candidates: readonly TasteProbeCandidate<T>[];
  /** Generations completed in this context since the last explicit vote. */
  generationsWithoutVote: number;
  /** Learning must be on — a paused ledger must not be poked. */
  learningEnabled: boolean;
  /** Pair keys already compared in this context. */
  excludedPairKeys?: ReadonlySet<string>;
  /** Directional evidence already collected per axis in this context. */
  reasonEvidenceCounts?: Partial<Record<PreferenceReason, number>>;
  /** Current ledger and ranking context used to estimate the model's uncertainty. */
  preferenceObservations?: readonly PreferenceObservationV1[];
  preferenceContext?: PreferenceContext;
}

export interface ProactiveProbeState<T> {
  /** A question the panel should offer right now. */
  proposal: TasteProbePair<T> | null;
  /** How many more generations before the next offer. */
  remaining: number;
  reason: "ready" | "patience" | "learning-paused" | "no-usable-pair" | "all-pairs-compared";
}

/** Evaluate whether the panel should proactively ask, and why (or why not). */
export function proactiveProbeState<T>(input: ProactiveProbeInput<T>): ProactiveProbeState<T> {
  if (!input.learningEnabled) {
    return { proposal: null, remaining: PROBE_PATIENCE, reason: "learning-paused" };
  }
  if (input.generationsWithoutVote < PROBE_PATIENCE) {
    return {
      proposal: null,
      remaining: PROBE_PATIENCE - input.generationsWithoutVote,
      reason: "patience",
    };
  }
  const excluded = input.excludedPairKeys ?? new Set<string>();
  const proposal = suggestTasteProbePair(
    input.candidates,
    excluded,
    input.reasonEvidenceCounts,
    input.preferenceObservations,
    input.preferenceContext,
  );
  if (!proposal) {
    // Either the bank cannot support a controlled question, or every viable
    // pair was already compared here. Both mean "ask nothing".
    return { proposal: null, remaining: PROBE_PATIENCE, reason: "no-usable-pair" };
  }
  return { proposal, remaining: PROBE_PATIENCE, reason: "ready" };
}

/** Session counter: generations since the last explicit Producer DNA vote. */
let generationsWithoutVote = 0;

/** One generation completed. */
export function noteGenerationWithoutVote(): number {
  generationsWithoutVote += 1;
  return generationsWithoutVote;
}

/** An explicit comparison was recorded — the streak (and the offer) resets. */
export function noteProducerDnaVote(): void {
  generationsWithoutVote = 0;
}

/** The proposal was shown and then dismissed — do not ask again immediately. */
export function noteProbeDismissed(): void {
  generationsWithoutVote = 0;
}

export function generationsWithoutProducerDnaVote(): number {
  return generationsWithoutVote;
}

/** Test hook: reset the session counter. */
export function resetProactiveProbe(): void {
  generationsWithoutVote = 0;
}

/** Keys of pairs already compared in the current context, for the picker. */
export function comparedPairKeys(
  observations: readonly {
    context: { key: string };
    candidateA: { contentHash: string };
    candidateB: { contentHash: string };
  }[],
  contextKey: string,
): Set<string> {
  const keys = new Set<string>();
  for (const observation of observations) {
    if (observation.context.key !== contextKey) continue;
    keys.add(tasteProbePairKey(observation.candidateA.contentHash, observation.candidateB.contentHash));
  }
  return keys;
}
