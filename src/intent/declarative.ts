/**
 * DESCRIPTIVE vs IMPERATIVE — the P0 guard from the 2026-10-20 semantic audit.
 *
 * The intent parsers match DIRECTION words, not sentence mood. That is fine for
 * "turn down the bass", but it also made pure descriptions into commands:
 *
 *   "the bass is quieter than the lead"            → moved the bass fader
 *   "the bass is much less loud than the lead"     → moved the bass fader
 *   "the pads have too much reverb"                → added MORE reverb
 *   "the mix is significantly louder than the reference" → loudness action
 *
 * These are complaints/observations. The product rule is to diagnose or ask,
 * never to mutate on a description. This module is the ONE home for that
 * distinction, shared by the router and the fader/effect/param parsers so a
 * direct caller cannot bypass it.
 *
 * It is deliberately conservative:
 *   - an imperative verb anywhere in the sentence keeps every parser's current
 *     behaviour ("the bass is too loud, turn it down" still executes);
 *   - the description must also name a MIX SUBJECT (a track family, the mix, an
 *     effect, or a frequency region), so a creative prompt such as
 *     "a beat that is dark and warm" is not mistaken for a complaint.
 */

const IMPERATIVE =
  /\b(?:make|turn|bring|push|pull|drop|lower|raise|lift|take|cut|boost|reduce|increase|decrease|give|set|keep|leave|apply|add|use|want|need|ease|adjust|move|pan|mute|unmute|solo|bypass|insert|remove|delete|zniz|stis|ztlm|zvys|pridaj|daj|potiahni|tahaj|hlasnej|tichs|spomal|zrychli|urob|nastav|odstran|vyhod|vypni|zapni)\b/;

const DESCRIPTIVE_SUBJECT =
  /\b(?:bass|808|sub|drums?|kick|snare|claps?|hats?|hi.?hats?|lead|synth|vocals?|vox|chords?|keys?|pads?|master|mix|reverb|delay|echo|chorus|compress(?:ion|or)?|saturat\w*|pump|\beq\b|top\s+end|high\s+end|low\s+end|highs?|mids?|low\s+mids?|this|it)\b/;

const DESCRIPTION_WORDS =
  /(?:quiet|louder|quieter|loud(?:er)?|harsh(?:er)?|bright(?:er)?|dark(?:er)?|warm(?:er)?|cold(?:er)?|muddy|muddier|boomy|dry|drier|wet|wetter|buried|present|audible|compressed|saturated|pumping|thin|flat|dull|muffled|boxy|sharp(?:er)?|soft(?:er)?|punchy|punchier)/;

const DEGREE_BEFORE_DESCRIPTION =
  /(?:not\s+)?(?:(?:very|really|extremely|quite|pretty|fairly|rather|so|too|way|much|far|a\s+lot|a\s+little(?:\s+bit)?|a\s+bit|a\s+touch|a\s+tad|a\s+hair|just\s+a\s+(?:bit|little|touch)|slightly|somewhat|significantly|considerably|noticeably|markedly|barely|hardly|scarcely|more|less|as)\s+)*/;

const COPULA_DESCRIPTION = new RegExp(
  String.raw`\b(?:is|are|was|were|sounds?|seems?|feels?|looks?)\s+` +
    DEGREE_BEFORE_DESCRIPTION.source +
    DESCRIPTION_WORDS.source +
    String.raw`\b`,
);

const POSSESSIVE_DESCRIPTION = /\b(?:have|has|got)\s+(?:too\s+(?:much|little)|not\s+enough)\b/;

const TOO_MUCH_DESCRIPTION =
  /\btoo\s+(?:much|little)\s+(?:reverb|delay|compression|saturation|pump|sub|top|low|high|noise|mud|space|attack|release)\b/;

const QUANTITY_DESCRIPTION =
  /\b(?:is|are|was|were)\s+(?:much\s+|way\s+|a\s+lot\s+|a\s+little\s+|slightly\s+)?(?:less|more)\s+(?:reverb|delay|compression|saturation|pump|sub|top|noise|low|high|space)\b/;

/**
 * True when the sentence is a DESCRIPTION of the current sound, not an
 * instruction to change it. Imperatives always win: a description followed by
 * "turn it down" is a command with context.
 */
export function isDescriptiveStatement(text: string): boolean {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0161\u0165]/g, (character) => (character === "\u0161" ? "s" : "t"))} `;
  if (IMPERATIVE.test(lower)) return false;
  if (!DESCRIPTIVE_SUBJECT.test(lower)) return false;
  return (
    COPULA_DESCRIPTION.test(lower) ||
    POSSESSIVE_DESCRIPTION.test(lower) ||
    TOO_MUCH_DESCRIPTION.test(lower) ||
    QUANTITY_DESCRIPTION.test(lower)
  );
}
