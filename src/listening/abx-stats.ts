/**
 * ABX LISTENING STATISTICS (docs/INTENT-MCP-EXPANSION-PLAN.md — Phase C
 * validation tool).
 *
 * Problem: a listening verdict from ONE person is a sample of one. Solution:
 * forced-choice ABX trials with randomized stimulus order — the listener
 * hears X, then A and B in random order, and must decide whether X was A or
 * B. Chance is 50 %, so N repeated trials turn a taste opinion into a
 * DISCRIMINATION measurement with a real p-value: 18/20 correct is
 * p ≈ 0.0002 even with a single listener.
 *
 * Pure functions only — the listening page (self-contained HTML) carries a
 * mirrored minimal implementation, tests pin the math here.
 */

export interface AbxTrial {
  lane: string;
  /** Which stimulus was X (the reference the listener had to identify). */
  xWas: "A" | "B";
  /** What the listener answered. */
  answer: "A" | "B";
  /** true when answer === xWas. */
  correct: boolean;
  /** Milliseconds from first playback to the choice (bias/haste signal). */
  reactionMs?: number;
  receivedAt?: number;
}

/**
 * Exact two-sided binomial test against chance 0.5: the probability of an
 * outcome at least as extreme as k correct out of n. Stable iterative pmf
 * (no factorials) — valid for any realistic n.
 */
export function binomialTwoSidedPValue(correct: number, total: number): number {
  if (total <= 0) return 1;
  if (correct < 0 || correct > total) return 0;
  // pmf(k) iteratively; track the sum of all pmf values ≤ pmf(kObs).
  let pmf = Math.pow(0.5, total); // pmf(0)
  const pmfObs = (() => {
    let value = pmf;
    for (let k = 1; k <= correct; k++) value = (value * (total - k + 1)) / k;
    return value;
  })();
  let sum = 0;
  for (let k = 0; k <= total; k++) {
    if (k > 0) pmf = (pmf * (total - k + 1)) / k;
    if (pmf <= pmfObs * (1 + 1e-9)) sum += pmf;
  }
  return Math.min(1, sum);
}

export interface AbxSummary {
  total: number;
  correct: number;
  accuracy: number;
  /** Exact two-sided p-value vs 50 % chance. */
  pValue: number;
  /** Standard listening-test threshold. */
  significant: boolean;
  /** Trials faster than this (ms) are treated as haste, not listening. */
  hastyExcluded: number;
  perLane: Array<{ lane: string; total: number; correct: number; pValue: number; significant: boolean }>;
}

/** Haste threshold: a choice under 1.5 s (after audio started) is a click. */
const HASTY_MS = 1500;

export function summarizeAbxTrials(trials: AbxTrial[]): AbxSummary {
  const counted = trials.filter((trial) => !(trial.reactionMs != null && trial.reactionMs < HASTY_MS));
  const hastyExcluded = trials.length - counted.length;
  const correct = counted.filter((trial) => trial.correct).length;
  const pValue = binomialTwoSidedPValue(correct, counted.length);

  const byLaneMap = new Map<string, AbxTrial[]>();
  for (const trial of counted) {
    const list = byLaneMap.get(trial.lane) ?? [];
    list.push(trial);
    byLaneMap.set(trial.lane, list);
  }
  const perLane = [...byLaneMap.entries()].map(([lane, list]) => {
    const laneCorrect = list.filter((trial) => trial.correct).length;
    const laneP = binomialTwoSidedPValue(laneCorrect, list.length);
    return { lane, total: list.length, correct: laneCorrect, pValue: laneP, significant: laneP < 0.05 };
  });

  return {
    total: counted.length,
    correct,
    accuracy: counted.length > 0 ? correct / counted.length : 0,
    pValue,
    significant: pValue < 0.05,
    hastyExcluded,
    perLane,
  };
}

/**
 * Aggregate a JSONL trials file (one AbxTrial per line). Tolerates blank
 * lines and skips malformed rows — a corrupted line must not poison the
 * whole history.
 */
export function parseAbxTrialsJsonl(content: string): AbxTrial[] {
  const trials: AbxTrial[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line) as Partial<AbxTrial>;
      if (
        typeof raw.lane === "string" &&
        (raw.xWas === "A" || raw.xWas === "B") &&
        (raw.answer === "A" || raw.answer === "B")
      ) {
        trials.push({
          lane: raw.lane,
          xWas: raw.xWas,
          answer: raw.answer,
          correct: raw.xWas === raw.answer,
          ...(typeof raw.reactionMs === "number" ? { reactionMs: raw.reactionMs } : {}),
          ...(typeof raw.receivedAt === "number" ? { receivedAt: raw.receivedAt } : {}),
        });
      }
    } catch {
      /* a corrupted line must not poison the history */
    }
  }
  return trials;
}
