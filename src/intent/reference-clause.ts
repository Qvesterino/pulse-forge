/**
 * REFERENCE CLAUSE — the part of a sentence that names what something is
 * COMPARED to, not what to edit.
 *
 * AUDIT 2026-10-19. This used to live as `FADER_REFERENCE_CLAUSE` inside
 * conversation.ts, so only the family fader parser stripped it. Two other
 * paths resolved their targets from the WHOLE sentence:
 *
 *   "bring the Rhodes up so it sits louder than the kick"
 *     → parseNamedTrackFaderIntent returned BOTH track ids; the kick, the
 *       yardstick, was raised along with the Rhodes.
 *   "more delay on the pad, like the lead"
 *     → parseEffectIntent collected both targets and put delay on the lead.
 *
 * Three copies of one vocabulary is how "than" ended up honoured in one route
 * and ignored in another, so it now has one home. Extending it here extends
 * every route at once — which is the whole point.
 *
 * The vocabulary is deliberately CLOSED: an unknown comparison word must not
 * silently become an edit target. If a producer says something we cannot
 * recognise as a comparison, the sentence still resolves to its plain reading —
 * see tests/intent-reference-clause.test.ts, which pins both directions.
 *
 * `match` is the one genuinely ambiguous entry. English allows it as a primary
 * verb ("make the Rhodes match the kick") AND as a comparison ("…, match the
 * bass"). Its tail is therefore greedy, which means a sentence-INITIAL "match"
 * consumes the rest of the sentence and the fader path declines. The narrower
 * alternative — anchoring `match` to a non-initial position so a leading verb
 * survives — was measured and rejected: it makes "match the Rhodes to the Kick
 * and raise it" resolve BOTH tracks, i.e. it reintroduces P0-2. A visible
 * decline beats a clever parse that mutates the yardstick.
 */
export const REFERENCE_CLAUSE =
  /\b(?:behind|beneath|under(?:neath)?|ahead of|in front of|compared with|compared to|than|relative to|like|such as|match(?:ing|ed)?(?:\s+to)?|same as|similar to|versus|vs\.?|as (?:before|it was|the last one)|za|pred|oproti|napriek)\b.{0,56}/gi;

/**
 * Strip every reference clause from an already DEACCENTED, lowercased string
 * and return the residue — the part that may legitimately name edit targets.
 *
 * Used with a fresh literal per call because the pattern is global: sharing one
 * RegExp instance across calls would carry `lastIndex` between sentences and
 * skip matches.
 */
export function stripReferenceClauses(deaccentedLower: string): string {
  return ` ${deaccentedLower.replace(new RegExp(REFERENCE_CLAUSE.source, REFERENCE_CLAUSE.flags), " ")} `;
}
