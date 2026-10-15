/**
 * F2 — REACTIONS → LEARNING (docs/INTENT-REACTION-LISTENING-PLAN.md §2).
 *
 * Turns resolved reactions into the three things F2 names: a REPORT, a
 * RERANK signal, and a MODEL-GATE counter.
 *
 * ── What the plan asked for, and what the data can honestly carry ───────────
 * The plan's corpus line says "undone action + tweaked after-state = a new
 * teacher pair". That pair cannot be built here, and pretending otherwise
 * would be the most expensive kind of wrong:
 *
 *   - F1 records NO prompt text (the privacy boundary is "prompt text, audio,
 *     project names, track names" — see reaction-ledger.ts). A teacher pair is
 *     (instruction → action); without the instruction there is no pair.
 *   - The one place that does keep prompts, `src/intent/failure-log.ts`, is
 *     the MODEL mining log: it fires on model-hit / model-miss / clarify, so a
 *     deterministic-parser route ("zvys bass") has no prompt row to join with.
 *   - A rejection also does not record WHAT the human did instead — only that
 *     they touched the same tracks. "Tweaked" is a direction, not a label.
 *
 * So the corpus F2 can actually ship is the (action descriptor → outcome)
 * table below: it teaches SELECTION which proposals this owner rejects, which
 * is exactly the plan's own bias guard — reactions REORDER gated candidates,
 * never invent actions outside the scheme.
 *
 * ── Shrinkage, because one undo is not ten undos ───────────────────────────
 * A raw keep-rate turns a single frustrated undo into "never suggest that
 * again". Two guards:
 *
 *   - a FLOOR of `MIN_DECIDED_FOR_WEIGHT` decided reactions. One considered
 *     undo is thin evidence; two independent rejections are a pattern. Below
 *     the floor the weight is 0 — "I don't know yet" — and the bias guard
 *     reads 0 as "leave the order alone".
 *   - a PRIOR pulling every weight toward zero, so ten undos (-0.71) hit far
 *     harder than two (-0.33) without ever reaching certainty.
 *
 * Nothing here learns from audio content — only from what the human did.
 * Everything here is derived, deterministic, and local.
 */
import type { ReactionEntry } from "./reaction-ledger";

/** Below this many decided reactions a descriptor earns no opinion. */
export const MIN_DECIDED_FOR_WEIGHT = 2;
/** Pseudo-reactions pulling every weight toward zero. Larger = more cautious. */
export const WEIGHT_PRIOR = 4;
/** The plan's model gate: never retrain on fewer reactions than this. */
export const RETRAIN_MIN_REACTIONS = 50;

export interface ReactionActionStat {
  /** Closed-vocabulary descriptor, e.g. "adjust:effect:rel". Never prose. */
  action: string;
  routeKind: string;
  kept: number;
  undone: number;
  tweaked: number;
  decided: number;
  keepRate: number;
  /** [-1, 1], shrunk by the prior; 0 when there is not enough evidence. */
  weight: number;
}

export interface ReactionReport {
  totals: { kept: number; undone: number; tweaked: number; pending: number; decided: number; keepRate: number };
  byRouteKind: Record<string, { kept: number; undone: number; tweaked: number; decided: number; keepRate: number }>;
  /** Most-rejected first, then most-decided, then descriptor — fully deterministic. */
  byAction: ReactionActionStat[];
  /** Total decided reactions, which is what the model gate counts. */
  decided: number;
}

export interface ReactionWeightOptions {
  minDecided?: number;
  prior?: number;
}

/**
 * Build the report from ledger entries. Pending proposals are counted but never
 * vote: an unresolved proposal has no verdict yet, and letting it count as
 * "kept" is precisely the false positive F1 was built to prevent.
 */
export function buildReactionReport(entries: readonly ReactionEntry[]): ReactionReport {
  const totals = { kept: 0, undone: 0, tweaked: 0, pending: 0, decided: 0, keepRate: 0 };
  const byRouteKind: ReactionReport["byRouteKind"] = {};
  const byAction = new Map<string, ReactionActionStat>();

  for (const entry of entries) {
    if (entry.outcome === "pending") {
      totals.pending += 1;
      continue;
    }
    totals[entry.outcome] += 1;
    totals.decided += 1;

    const kindBucket = (byRouteKind[entry.routeKind] ??= { kept: 0, undone: 0, tweaked: 0, decided: 0, keepRate: 0 });
    kindBucket[entry.outcome] += 1;
    kindBucket.decided += 1;

    // Keyed by (routeKind, action), not by action alone: "adjust:effect:rel"
    // reached through `effectIntent` and through `paramIntent` are two
    // different lessons, and collapsing them would let one route kind's
    // verdict launder the other's.
    let stat = byAction.get(reactionKey(entry.routeKind, entry.action));
    if (!stat) {
      stat = {
        action: entry.action,
        routeKind: entry.routeKind,
        kept: 0,
        undone: 0,
        tweaked: 0,
        decided: 0,
        keepRate: 0,
        weight: 0,
      };
      byAction.set(reactionKey(entry.routeKind, entry.action), stat);
    }
    stat[entry.outcome] += 1;
    stat.decided += 1;
  }

  for (const bucket of Object.values(byRouteKind))
    bucket.keepRate = keepRateOf(bucket.kept, bucket.undone, bucket.tweaked);

  const actions = [...byAction.values()].map((stat) => ({
    ...stat,
    keepRate: keepRateOf(stat.kept, stat.undone, stat.tweaked),
    weight: reactionWeight(stat.kept, stat.undone, stat.tweaked),
  }));
  actions.sort(
    (a, b) =>
      a.weight - b.weight ||
      b.decided - a.decided ||
      a.action.localeCompare(b.action) ||
      a.routeKind.localeCompare(b.routeKind),
  );

  totals.keepRate = keepRateOf(totals.kept, totals.undone, totals.tweaked);
  return { totals, byRouteKind, byAction: actions, decided: totals.decided };
}

function keepRateOf(kept: number, undone: number, tweaked: number): number {
  const decided = kept + undone + tweaked;
  return decided === 0 ? 0 : (kept + tweaked) / decided;
}

/**
 * Shrunk keep-rate in [-1, 1]. Positive = this owner keeps these proposals,
 * negative = they reject them, 0 = not enough evidence to say.
 *
 * decided=1 all-undo → 0 (below the floor); decided=2 → -0.33;
 * decided=10 → -0.71. One undo is a signal to collect more, not a verdict.
 */
export function reactionWeight(
  kept: number,
  undone: number,
  tweaked: number,
  options: ReactionWeightOptions = {},
): number {
  const minDecided = options.minDecided ?? MIN_DECIDED_FOR_WEIGHT;
  const prior = options.prior ?? WEIGHT_PRIOR;
  const keptCount = Math.max(0, kept);
  const undoneCount = Math.max(0, undone);
  const tweakedCount = Math.max(0, tweaked);
  const decided = keptCount + undoneCount + tweakedCount;
  if (decided < minDecided || prior <= 0) return 0;
  const raw = (keptCount + tweakedCount - undoneCount) / decided;
  const shrunk = (raw * decided) / (decided + prior);
  // Keep the value in range even if a caller passes hostile counts.
  return round4(Math.max(-1, Math.min(1, shrunk)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The bias-guard key: a descriptor is only learned per route kind. */
export function reactionKey(routeKind: string, action: string): string {
  return `${routeKind}|${action}`;
}

/** The report turned into the lookup the bias guard sorts by. */
export function reactionWeights(report: ReactionReport): Map<string, number> {
  return new Map(report.byAction.map((stat) => [reactionKey(stat.routeKind, stat.action), stat.weight]));
}

/**
 * THE BIAS GUARD (pre-registered in the plan): reactions REORDER candidates,
 * they never create, drop, or edit one.
 *
 * A stable sort over an existing list is the only operation here, and that is
 * the guarantee: the returned array has the same length and the same members
 * as the input, always — including when a key is unknown (weight 0, order
 * untouched). `tests/reaction-learning.test.ts` pins that on every mutation of
 * this function.
 */
export function applyReactionBias<T>(
  order: readonly T[],
  keyOf: (item: T, index: number) => string,
  weights: ReadonlyMap<string, number>,
): T[] {
  return order
    .map((item, index) => ({ item, index, weight: weights.get(keyOf(item, index)) ?? 0 }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.item);
}

export interface RetrainGate {
  eligible: boolean;
  reactions: number;
  required: number;
  /** Machine-readable reasons, for a report that must explain itself. */
  reasons: string[];
}

/**
 * The plan's model gate: "retrain ONLY when reactions ≥ 50 AND the val split
 * grows". Both conditions, both explicit. A gate that fires on one of its two
 * conditions is not the gate that was registered.
 *
 * `val` is the OUT-OF-SAMPLE count from the current validation split; pass null
 * when no split has been measured yet, which is NOT a pass.
 */
export function retrainGate(reactions: number, val: { before: number; after: number } | null): RetrainGate {
  const reasons: string[] = [];
  if (reactions < RETRAIN_MIN_REACTIONS) reasons.push(`reactions ${reactions} < ${RETRAIN_MIN_REACTIONS}`);
  if (val === null) reasons.push("no validation split measured");
  else if (val.after <= val.before) reasons.push(`validation split did not grow (${val.before} -> ${val.after})`);
  return { eligible: reasons.length === 0, reactions, required: RETRAIN_MIN_REACTIONS, reasons };
}

/** The descriptors this owner rejects most — the panel/MCP "what to stop doing" line. */
export function topRejections(report: ReactionReport, limit = 3): ReactionActionStat[] {
  return report.byAction.filter((stat) => stat.weight < 0 && stat.decided > 0).slice(0, Math.max(0, limit));
}
