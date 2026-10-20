/**
 * PRIOR-DELTA REFERENCES — phrases that point at an EARLIER adjustment.
 *
 * "a little less than last time", "half that adjustment", "do the same on
 * track two" cannot be answered from the project document alone. They need the
 * previous command's magnitude (and, for the last one, its target).
 *
 * The engine has no durable adjustment ledger yet. Before this module those
 * sentences were handled in the worst possible way: "turn the bass down a
 * little less than last time" parsed as an ordinary level-3 fader step, so
 * the reference was silently DISCARDED and a guessed magnitude was applied —
 * exactly the silent fallback the intent contract forbids. "half that
 * adjustment" and "do the same on track two" fell through to pattern
 * generation, which replaces the producer's song.
 *
 * This module is the ONE home for the vocabulary, used by the router (to
 * decline with a focused clarification), the fader/effect/param parsers (so a
 * direct caller cannot bypass that decline) and later by a real ledger.
 * Deliberately NOT exported as an intent: an unimplemented reference must
 * never look like a parsed one.
 */

const PRIOR_DELTA_SOURCE = [
  // "less than last time", "different from the previous adjustment"
  String.raw`\b(?:than|from)\s+(?:the\s+)?(?:last|previous|prior)\s+(?:time|adjustment|change|step|one)\b`,
  // "the last adjustment", "the previous change"
  String.raw`\b(?:the\s+)?(?:last|previous|prior)\s+(?:adjustment|change|step)\b`,
  // "half that adjustment", "half of the last change", "half your last step"
  String.raw`\bhalf\s+(?:of\s+)?(?:that|the|your|last)\s+(?:adjustment|change|amount|step|delta)\b`,
  // "half as much as last time"
  String.raw`\bhalf\s+as\s+much\s+as\s+(?:last|before|the\s+last)\b`,
  // "do the same on track two", "apply the same to the bass"
  String.raw`\b(?:do|apply|use|repeat)\s+(?:the\s+)?same\b.{0,24}\b(?:on|to|for)\b`,
  // "the same adjustment as before"
  String.raw`\b(?:same|identical)\s+(?:adjustment|change)\s+as\b`,
].join("|");

const PRIOR_DELTA_REFERENCE = new RegExp(PRIOR_DELTA_SOURCE, "i");
const PRIOR_DELTA_REFERENCE_GLOBAL = new RegExp(PRIOR_DELTA_SOURCE, "gi");

/** True when the text refers to a magnitude/target from an earlier command. */
export function isPriorDeltaReference(text: string): boolean {
  return PRIOR_DELTA_REFERENCE.test(text);
}

/**
 * The sentence with the reference phrase removed — used only to offer an
 * EXECUTABLE suggestion ("turn the bass down a little" from "…a little less
 * than last time"). Returns the input unchanged when nothing matched.
 */
export function stripPriorDeltaReference(text: string): string {
  return text.replace(PRIOR_DELTA_REFERENCE_GLOBAL, " ").replace(/\s+/g, " ").trim();
}
