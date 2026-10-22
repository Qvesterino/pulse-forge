/**
 * PRIOR-DELTA REFERENCES — phrases that point at an EARLIER adjustment.
 *
 * "a little less than last time", "half that adjustment", "do the same on
 * track two" cannot be answered from the project document alone. They need the
 * previous command's magnitude (and, for the last one, its target).
 *
 * The engine now keeps ONE session ledger for that (`adjustment-ledger.ts`),
 * and the resolver (`prior-adjustment.ts`) turns a remembered change into a new
 * fader intent. This module is the ONE home for the VOCABULARY: it says which
 * sentences name an earlier change, so the router can resolve or decline them
 * and the fader/effect/param parsers can refuse to treat a reference as a
 * fresh ask. A parser that answered "a little less than last time" on its own
 * would silently DISCARD the reference and apply a guessed magnitude — exactly
 * the silent fallback the intent contract forbids.
 *
 * Before this module those sentences were handled in the worst possible way:
 * "turn the bass down a little less than last time" parsed as an ordinary
 * level-3 fader step, "half that adjustment" and "do the same on track two"
 * fell through to pattern generation, which replaces the producer's song.
 *
 * Deliberately NOT exported as an intent: a reference must never look like a
 * parsed one, even now that it can be resolved.
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
  // "same again", "that again", "it again" — a bare REPEAT of the last change.
  // These name an earlier change with no magnitude of their own, so the only
  // honest answer is to repeat the remembered one. Without this line they
  // fell through to pattern generation.
  String.raw`\b(?:same|that|it)\s+again\b`,
  // "do that again", "do it again"
  String.raw`\bdo\s+(?:that|it)\s+again\b`,
  // "repeat that", "repeat it", "repeat the last change"
  String.raw`\brepeat\s+(?:that|it|the\s+last\b)`,
  // "as much as last time", "as much as before" — the last magnitude itself.
  String.raw`\bas\s+much\s+as\s+(?:the\s+)?(?:last|previous|prior)\b`,
  // "the same amount as before", "the same volume as last time"
  String.raw`\b(?:same|identical)\s+(?:amount|volume|level|value|delta)\s+as\b`,
  // "again", "again please" — a bare repeat, and the whole sentence. The
  // anchor matters: "play again" is a TRANSPORT ask (the transport parser
  // decides that one), and only a sentence that IS the repeat is a reference
  // to the last change.
  String.raw`^\s*(?:again|again\s+please|same\s+again|that\s+again|do\s+it\s+again)\s*[.!?]?\s*$`,
  // "one step further", "one more step", "another step" — repeat the last
  // calibrated step (the ledger holds the measured delta).
  String.raw`\b(?:one\s+(?:more\s+)?step|another\s+step)\b`,
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
