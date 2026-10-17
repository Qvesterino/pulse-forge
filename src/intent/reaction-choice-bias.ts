/**
 * F2 CLOSURE — THE BIAS GUARD, APPLIED WHERE A HUMAN CHOOSES (Wave B).
 *
 * The pre-registered rule (docs/INTENT-REACTION-LISTENING-PLAN.md §2) is
 * exact: "reactions REORDER gated candidates, never create, drop or edit one".
 * This module applies it to the one place the app presents a LIST of already
 * validated interpretations for a human to pick: the INTENT? clarification
 * chips (ambiguous send-vs-return).
 *
 * ── Why here, and not inside the router ─────────────────────────────────────
 * `routeIntentText` is pure and deterministic — the 108-case router corpus and
 * every golden pin depend on that. Injecting owner history into the router
 * would make the same sentence route differently per machine, which is exactly
 * the kind of drift this codebase spends real effort preventing. The chips are
 * a HUMAN decision surface, so the bias belongs at the surface: an owner who
 * keeps `sendIntent` proposals and returns `fader` ones should see the send
 * interpretation first — and an owner with no history must see no change at all.
 *
 * ── The guarantees this module inherits and re-states ───────────────────────
 *   - `applyReactionBias` is a STABLE sort over the existing list: same length,
 *     same members, always. Nothing here can invent, drop or rewrite an option.
 *   - No ledger, no decisions, or any failure → the INPUT ARRAY ITSELF is
 *     returned (identity), so a user without history experiences byte-identical
 *     behaviour. The kill switch (`pf:reaction-ledger` off) is respected because
 *     `activeReactionLedger()` already answers null.
 */
import { activeReactionLedger, sanitizeAction } from "./reaction-ledger";
import { applyReactionBias, buildReactionReport, reactionKey, reactionWeights } from "./reaction-learning";
import { describeIntentAction } from "./reaction-bridge";
import type { IntentClarificationChoice } from "./route";

/**
 * Order the clarification choices by what THIS owner historically keeps.
 *
 * Returns the input array unchanged unless there is measured evidence to
 * reorder: at least one decided reaction and a weight that separates options.
 * A tie keeps the original order (the stable sort's index tiebreak).
 */
export function orderClarificationChoices(
  choices: readonly IntentClarificationChoice[],
): readonly IntentClarificationChoice[] {
  if (choices.length < 2) return choices;
  const ledger = activeReactionLedger();
  if (!ledger) return choices;
  try {
    const report = buildReactionReport(ledger.entries());
    if (report.decided === 0) return choices;
    const weights = reactionWeights(report);
    return applyReactionBias(
      choices,
      (choice) => reactionKey(choice.route.kind, sanitizeAction(describeIntentAction(choice.route))),
      weights,
    );
  } catch {
    // The bias guard must never be able to break a routing surface.
    return choices;
  }
}
