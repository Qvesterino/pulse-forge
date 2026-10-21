import type { TimeSignature } from "../project-model/types";

/**
 * THE METRICAL PHRASE VOCABULARY — the one owner of "which metre does this
 * text ask for?".
 *
 * Before this module the metre was reachable only as the literal phrase
 * "time signature 3/4" / "meter 6/8" (`src/intent/exact.ts`), which is an API
 * spelling, not a human one. A user who typed "make me a beat in 6/8" got a
 * 4/4 beat and a 4/4 project — the metre word was silently ignored, which is
 * the worst kind of failure: no error, just a beat in the wrong metre.
 *
 * Two parsers read user text, and they must NOT disagree about the metre:
 *
 * - the TEXT parser (`src/intent/text-parser.ts`) — the generation path, where
 *   the requested metre decides the pattern's LENGTH and the metre the
 *   content is generated in;
 * - the EXACT parser (`src/intent/exact.ts`) — the command path, where the
 *   metre is a document change.
 *
 * So the vocabulary lives here and both ask it. The bare form ("6/8") is
 * offered separately from the explicit one ("time signature 6/8"): the
 * EXACT parser must NOT take the bare form, because a bare "3/4" in "make me
 * a 3/4 beat" would turn a generation request into a document command — and
 * then the user would get a metre change and NO BEAT.
 *
 * The vocabulary is deliberately narrow about what a metre WORD means:
 *
 * - "waltz" / "valčík" → 3/4 — a waltz IS a 3/4, in every genre.
 * - "shuffle" is NOT a metre. A UKG shuffle is 4/4 with a swung SIXTEENTH —
 *   a feel, not a bar. Mapping it to 6/8 would hijack every UKG request and
 *   change the genre's sound, so the word is left alone.
 */
export interface MeterPhrase {
  numerator: number;
  denominator: number;
  /** The matched phrase — for the readback chip. */
  phrase: string;
  /** True when the metre was NAMED ("time signature 6/8", "waltz"), not bare ("6/8"). */
  explicit: boolean;
}

/** The beat units a document may declare (the same set the command validates). */
const DENOMINATORS = new Set([2, 4, 8, 16]);

function deaccent(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toMeter(numerator: number, denominator: number): MeterPhrase | null {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return null;
  if (numerator < 1 || numerator > 16) return null;
  if (!DENOMINATORS.has(denominator)) return null;
  return { numerator, denominator, phrase: `${numerator}/${denominator}`, explicit: true };
}

/**
 * The metre a text asks for, or null.
 *
 * `bareAllowed` opens the nameless form ("6/8"). The generation path wants it
 * ("make me a beat in 6/8"); the command path does not.
 */
export function meterPhraseIn(text: string, options: { bareAllowed?: boolean } = {}): MeterPhrase | null {
  const lower = deaccent(text);

  // 1. THE NAMED FORM — "time signature 6/8", "meter 3/4", "takt 7/8",
  //    "signatura 5/4". The word may sit on either side of the number.
  const named =
    /\b(?:time signature|signatura|takt|meter|metre)\b[^0-9]{0,16}(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(lower) ??
    /(\d{1,2})\s*\/\s*(\d{1,2})\b\s*(?:time signature|signatura|takt|meter|metre)\b/.exec(lower);
  if (named) {
    const meter = toMeter(Number(named[1]), Number(named[2]));
    if (meter) return { ...meter, phrase: named[0].trim() };
  }

  // 2. THE NAMED FEEL — "waltz" / "valčík" is a 3/4 in every genre.
  const waltz = /\b(?:waltz|valcik)\b/.exec(lower);
  if (waltz) return { numerator: 3, denominator: 4, phrase: waltz[0].trim(), explicit: true };

  // 3. THE BARE FORM — "6/8", "3/4". The lookbehind keeps "6/8" out of
  //    "16/8" and "2/3" out of "12/3".
  if (options.bareAllowed) {
    const bare = /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(lower);
    if (bare) {
      const meter = toMeter(Number(bare[1]), Number(bare[2]));
      if (meter) return { ...meter, phrase: bare[0].trim(), explicit: false };
    }
  }

  return null;
}

/** The metrical signature a phrase asks for, or null. */
export function meterSignatureIn(text: string, options: { bareAllowed?: boolean } = {}): TimeSignature | null {
  const phrase = meterPhraseIn(text, options);
  return phrase ? { numerator: phrase.numerator, denominator: phrase.denominator } : null;
}
