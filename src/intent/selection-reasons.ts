/**
 * SELECTION REASONS (Wave E1) — the "why this candidate?" layer.
 *
 * The ranking stack already records machine provenance (score versions,
 * `candidate-bank-selected:<idx>`, audio-rerank displacement tokens). What it
 * never produced is a sentence a musician can argue with. This module derives
 * one from MEASURED data only: the bank scores that exist, the rerank that
 * actually displaced someone, the personal residual that actually moved the
 * order, the tempo that actually resolved. Nothing here is invented — when
 * there is nothing to say (one candidate, no reorder), it says exactly that.
 *
 * Deliberately dependency-free (a structural input type, no imports) so the
 * selection type in `src/intent/types.ts` can reference it without dragging
 * the candidate-bank module into anything.
 */

export type SelectionReasonCode =
  | "no-candidates"
  | "direct-pick"
  | "single-candidate"
  | "heuristic-top"
  | "ranker-model"
  | "audio-rerank"
  | "personal-taste"
  | "clear-lead"
  | "narrow-lead"
  | "tie"
  | "tempo-resolved";

export interface SelectionReason {
  code: SelectionReasonCode;
  /** One sentence, safe to show next to the winner. */
  text: string;
}

/** The subset of a ranked bank entry this module reads. */
export interface SelectionReasonEntry {
  candidateIndex: number;
  score: number;
  source?: string;
  globalScore?: number;
  personalScore?: number;
}

export interface SelectionReasonInput {
  bank: readonly SelectionReasonEntry[];
  selectedIndex: number | null;
  /**
   * Whether the run produced a proposal at all. An EMPTY bank with a proposal
   * is not a failure — it means the run took the single-candidate fast path
   * and no bank ranking happened (claiming "nothing survived the gates" there
   * would be a lie).
   */
  proposalExists?: boolean;
  /** Which first-pass scorer produced the order. */
  rankerMode?: "off" | "shadow" | "active";
  rankerSource?: "model" | "fallback";
  /** Present only when sound scoring displaced the first-pass winner. */
  audioRerank?: { displacedCandidateIndex: number; selectedCandidateIndex: number; personalized?: boolean };
  /** Tempo the engine actually rendered at (plan.resolvedBpm). */
  resolvedBpm?: number | null;
  /** Tempo range the prompt asked for, when the parser found one. */
  requestedBpmRange?: readonly [number, number] | null;
}

/** Margin above which a lead counts as decisive for the "audition the rest" hint. */
export const CLEAR_LEAD_MARGIN = 0.05;

export function explainSelection(input: SelectionReasonInput): SelectionReason[] {
  const reasons: SelectionReason[] = [];
  const seen = new Set<SelectionReasonCode>();
  const push = (reason: SelectionReason) => {
    if (seen.has(reason.code)) return;
    seen.add(reason.code);
    reasons.push(reason);
  };

  const { bank, selectedIndex } = input;
  if (bank.length === 0) {
    return input.proposalExists === true
      ? [
          {
            code: "direct-pick",
            text: "The engine produced this pattern directly — this run had a single candidate, so no bank ranking happened.",
          },
        ]
      : [{ code: "no-candidates", text: "No candidate survived the gates — nothing was applied." }];
  }
  if (selectedIndex == null) return [];
  if (bank.length === 1) {
    return [{ code: "single-candidate", text: "Only one candidate survived the gates, so no ranking was needed." }];
  }
  const selected = bank.find((entry) => entry.candidateIndex === selectedIndex);
  if (selected == null) return [];

  // The LAST stage that acted gets the first word — it is the reason the
  // winner is not what the first pass would have picked.
  if (input.audioRerank != null) {
    push({
      code: "audio-rerank",
      text: `Preferred after auditioning the render: candidate #${input.audioRerank.selectedCandidateIndex + 1} displaced #${input.audioRerank.displacedCandidateIndex + 1} on sound.`,
    });
    if (input.audioRerank.personalized === true) {
      push({
        code: "personal-taste",
        text: "The sound weighting that reordered the finalists includes your own kept generations.",
      });
    }
  } else if (input.rankerMode === "active" && input.rankerSource === "model") {
    push({
      code: "ranker-model",
      text: "The learned ranker (active: heuristic 0.6 + model 0.4) put this first.",
    });
  } else {
    const topByScore = [...bank].sort((a, b) => b.score - a.score)[0];
    if (topByScore?.candidateIndex === selectedIndex) {
      push({
        code: "heuristic-top",
        text: `Highest deterministic fit score in the bank (${selected.score.toFixed(3)}).`,
      });
    }
  }

  // Margin to the runner-up: the honest confidence signal.
  let runnerUp = -Infinity;
  for (const entry of bank) {
    if (entry.candidateIndex === selectedIndex) continue;
    if (entry.score > runnerUp) runnerUp = entry.score;
  }
  if (Number.isFinite(runnerUp)) {
    const gap = selected.score - runnerUp;
    if (gap > 1e-9) {
      push(
        gap >= CLEAR_LEAD_MARGIN
          ? { code: "clear-lead", text: `Clear lead over the runner-up (+${gap.toFixed(3)}).` }
          : {
              code: "narrow-lead",
              text: `Narrow lead over the runner-up (+${gap.toFixed(3)}) — audition the alternatives.`,
            },
      );
    } else {
      push({ code: "tie", text: "Tied with the runner-up; the order was broken deterministically." });
    }
  }

  // Personal residual — only when it ACTUALLY moved this order.
  const personalMoved = selected.personalScore !== undefined && selected.personalScore !== selected.globalScore;
  const personalPresent = bank.some(
    (entry) => entry.personalScore !== undefined && entry.personalScore !== entry.globalScore,
  );
  if (personalMoved) {
    push({
      code: "personal-taste",
      text: "Your own A/B choices reordered the bank (personal taste is a bounded residual, never a hard constraint).",
    });
  } else if (personalPresent && selected.personalScore !== undefined) {
    push({ code: "personal-taste", text: "Your A/B history was applied and agreed with this pick." });
  }

  // Tempo: only report a substitution, never a silent one.
  const range = input.requestedBpmRange;
  if (input.resolvedBpm != null && range != null) {
    const [min, max] = range;
    if (input.resolvedBpm < min || input.resolvedBpm > max) {
      push({
        code: "tempo-resolved",
        text: `Tempo resolved to ${input.resolvedBpm} BPM — outside your requested ${min}–${max} BPM range.`,
      });
    }
  }

  return reasons;
}

/** Compact one-line form for a tooltip or status line. */
export function formatSelectionReasons(reasons: readonly SelectionReason[]): string {
  return reasons.map((reason) => reason.text).join(" ");
}
