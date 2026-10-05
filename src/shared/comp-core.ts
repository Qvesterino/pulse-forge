/**
 * COMP PLAN CORE — the shared spine of both comping planners.
 *
 * Two producers in this codebase assemble "the best take per bar" from
 * different lanes and different evidence:
 *
 *   - the VOCAL RECORDING LANE (`src/vocal/comping.ts`) plans over measured
 *     `VocalProfile`s — phrase energy, bar RMS, SNR;
 *   - the ARRANGEMENT TAKE LANE (`src/commands/smart-comp.ts`) plans over
 *     recorded audio clips — groove lock, pitch drift, noise floor, clipping.
 *
 * The METRICS must stay separate: they answer different questions about
 * different inputs and share no thresholds. The PLANNING SHAPE is identical
 * and was duplicated line for line:
 *
 *   1. for every bar on the shared grid, the eligible take with the best
 *      score wins (ties go to the earlier take);
 *   2. consecutive bars with the same winner MERGE into one span — every
 *      seam is an edit point (a crossfade in arrangement, a note gap in the
 *      vocal comp), and fewer seams is a feature;
 *   3. a bar NO take can serve stays an honest HOLE — reported, never
 *      silently filled with the nearest bar or digital silence.
 *
 * This module is that shape and nothing else. It is pure, deterministic and
 * has no imports: the caller brings the takes, the grid length and a
 * per-bar score function. Both planners delegate here, so the merge/hole/tie
 * semantics can no longer drift apart between the lanes.
 */

export interface CompBarScore {
  /** Whether this take can serve this bar AT ALL (coverage / sings). */
  eligible: boolean;
  /** Preference within the bar. Only compared when both are eligible. */
  score: number;
}

export interface CompCoreTake<TId> {
  /** Identity the plan reports back (index, take id — whatever the lane uses). */
  takeId: TId;
  /** Score this take for `bar` (0-based, bar < grid bars). */
  scoreBar: (bar: number) => CompBarScore;
}

export interface CompCoreSegment<TId> {
  /** First bar (INCLUSIVE). */
  startBar: number;
  /** Last bar (INCLUSIVE). Convert per lane if you need exclusive ends. */
  endBar: number;
  /** Identity of the take that won this span. */
  winner: TId;
  /** Highest bar score inside the span (the span's confidence reading). */
  score: number;
}

export interface CompCorePlan<TId> {
  /** Merged spans in timeline order. Empty when nothing is covered. */
  segments: CompCoreSegment<TId>[];
  /** Bars where at least one take was eligible. */
  coveredBars: number;
  /** Bars where NO take was eligible, ascending — the honest holes. */
  uncoveredBars: number[];
  /** Bars contributed per take (0 for takes that never won). */
  perTakeBars: Map<TId, number>;
  /** Take contributing the most bars; earlier take wins ties; null when nothing is covered. */
  winner: TId | null;
  /** Grid length the plan was built on. */
  bars: number;
}

/**
 * Plan a comp over a 0..bars-1 grid.
 *
 * Selection rule (both lanes depend on it):
 *   - the FIRST eligible take starts as the winner of a bar;
 *   - a later eligible take replaces it only with a STRICTLY higher score,
 *     so equal scores keep the earlier take — callers order their takes by
 *     their own priority when they want a different tie-break;
 *   - a bar with no eligible take becomes a hole (`uncoveredBars`).
 */
export function planCompCore<TId>(takes: readonly CompCoreTake<TId>[], bars: number): CompCorePlan<TId> {
  const safeBars = Number.isFinite(bars) ? Math.max(0, Math.floor(bars)) : 0;
  const perTakeBars = new Map<TId, number>();
  for (const take of takes) {
    if (!perTakeBars.has(take.takeId)) perTakeBars.set(take.takeId, 0);
  }

  const segments: CompCoreSegment<TId>[] = [];
  const uncoveredBars: number[] = [];
  let coveredBars = 0;
  let current: CompCoreSegment<TId> | null = null;

  for (let bar = 0; bar < safeBars; bar++) {
    let winner: CompCoreTake<TId> | null = null;
    let winnerScore = 0;
    let sawEligible = false;
    for (const take of takes) {
      const { eligible, score } = take.scoreBar(bar);
      if (!eligible) continue;
      if (!sawEligible || score > winnerScore) {
        winner = take;
        winnerScore = score;
        sawEligible = true;
      }
    }

    if (!winner) {
      uncoveredBars.push(bar);
      current = null;
      continue;
    }

    coveredBars += 1;
    perTakeBars.set(winner.takeId, (perTakeBars.get(winner.takeId) ?? 0) + 1);
    if (current && current.winner === winner.takeId && current.endBar === bar - 1) {
      current.endBar = bar;
      if (winnerScore > current.score) current.score = winnerScore;
    } else {
      current = { startBar: bar, endBar: bar, winner: winner.takeId, score: winnerScore };
      segments.push(current);
    }
  }

  let best: TId | null = null;
  let bestBars = -1;
  for (const [takeId, count] of perTakeBars) {
    if (count > bestBars) {
      best = takeId;
      bestBars = count;
    }
  }
  return {
    segments,
    coveredBars,
    uncoveredBars,
    perTakeBars,
    winner: bestBars > 0 ? best : null,
    bars: safeBars,
  };
}
