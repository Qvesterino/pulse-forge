/**
 * F2 CLOSURE — REACTIONS FEED THE RERANK FIT (Wave B, the spec's last line).
 *
 * The pre-registered line is "reakcie kŕmia rerank-weights fit (už existuje) —
 * selekcia sa učí poriadky, nie len audio-fit". This module is that feed, and
 * it exists because the join was missing: the reaction ledger speaks in
 * (routeKind, action) and the fit speaks in generations, so nothing could be
 * joined without a shared identity. That identity now exists
 * (`rerankGenerationId`, derived once and carried by both sides), and these
 * are the honest rules for using it:
 *
 *   - `undone`  → DROP the generation. The observation's ground truth is "the
 *                 candidate the engine delivered was the kept one"; the human
 *                 reverted exactly that. Training the weight toward a rejected
 *                 pick is worse than having no sample.
 *   - `kept` / `tweaked` → the applied candidate becomes the ground truth. If
 *                 the human applied a DIFFERENT bank candidate than the engine
 *                 delivered (audition-first: that is the normal case), the fit
 *                 learns from the HUMAN's pick — which is what "selekcia sa
 *                 učí poriadky" actually means. A correction ("tweaked") is
 *                 still a kept choice, not a rejection.
 *   - `pending` and unknown generations → untouched, no evidence yet.
 *
 * Everything is pure: observations + verdicts in, samples + a report out. The
 * fit script prints the report so a run can never silently change what it
 * learned from.
 */
import type { AudioFitObservationV1 } from "./audio-fit-ledger";
import { audioFitLedgerSamples } from "./audio-fit-ledger";
import type { ReactionEntry } from "./reaction-ledger";
import type { RerankSample } from "./rerank-weights";

/** A resolved human verdict on the proposal that applied a generation. */
export interface RerankReactionVerdict {
  outcome: "kept" | "undone" | "tweaked";
  /** Bank index of the candidate the human applied, when one was chosen. */
  candidateIndex?: number;
}

/**
 * Verdicts by generation id. Pending proposals carry NO evidence and are
 * skipped; when a generation was applied more than once, the LAST resolved
 * verdict wins (entries are chronological) — a later `undone` must be able to
 * overrule an earlier `kept`, or the ledger's own history would be ignored.
 */
export function rerankVerdictsFromEntries(entries: readonly ReactionEntry[]): Map<string, RerankReactionVerdict> {
  const verdicts = new Map<string, RerankReactionVerdict>();
  for (const entry of entries) {
    if (entry.generationId === undefined) continue;
    if (entry.outcome === "pending") continue;
    verdicts.set(entry.generationId, {
      outcome: entry.outcome,
      ...(entry.candidateIndex !== undefined ? { candidateIndex: entry.candidateIndex } : {}),
    });
  }
  return verdicts;
}

export interface ReactionAdjustedFitInput {
  samples: (RerankSample & { genre: string })[];
  report: {
    /** Observations considered. */
    generations: number;
    /** Dropped because the human reverted the applied candidate. */
    dropped: number;
    /** Re-targeted to the candidate the human actually applied. */
    retargeted: number;
    /** Left exactly as recorded (no verdict, or the applied pick already was it). */
    untouched: number;
  };
}

/**
 * Apply the human verdicts to the audio-fit observations and build the fit
 * samples. Pure — same inputs, same samples, always.
 */
export function reactionAdjustedFitSamples(
  observations: readonly AudioFitObservationV1[],
  verdicts: ReadonlyMap<string, RerankReactionVerdict>,
): ReactionAdjustedFitInput {
  const kept: AudioFitObservationV1[] = [];
  let dropped = 0;
  let retargeted = 0;
  let untouched = 0;
  for (const observation of observations) {
    const verdict = verdicts.get(observation.generationId);
    if (verdict === undefined) {
      kept.push(observation);
      untouched += 1;
      continue;
    }
    if (verdict.outcome === "undone") {
      dropped += 1;
      continue;
    }
    const applied = verdict.candidateIndex;
    const position = applied === undefined ? -1 : observation.candidates.findIndex((c) => c.candidateIndex === applied);
    if (position < 0 || position === observation.selectedIndex) {
      kept.push(observation);
      untouched += 1;
      continue;
    }
    kept.push({
      ...observation,
      selectedIndex: position,
      candidates: observation.candidates.map((candidate, index) => ({ ...candidate, selected: index === position })),
    });
    retargeted += 1;
  }
  return {
    samples: audioFitLedgerSamples(kept),
    report: { generations: observations.length, dropped, retargeted, untouched },
  };
}
