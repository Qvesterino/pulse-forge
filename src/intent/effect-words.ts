import type { EffectType } from "../project-model/types";

/**
 * The effect NAMES a sentence can use — the word list that turns "add delay
 * to the drop" into a concrete effect type.
 *
 * WHY THIS IS ITS OWN MODULE. `src/intent/mix.ts` is the mix planner: it
 * imports the effect command set, the effect preset library (40 KB) and the
 * artist mix profiles — together about 83 KB built. The arrangement word
 * parser (`src/intent/arrangeWords.ts`) sits on the studio boot path through
 * the context menu, and it needed exactly ONE thing from that module: this
 * word list. Asking the planner for a word table dragged the whole planner
 * into the boot path.
 *
 * The table is self-contained (it needs nothing but the effect type union),
 * so it lives here now. `mix.ts` re-exports `effectWordIn`, so every existing
 * importer keeps working.
 */
const EFFECT_WORDS: ReadonlyArray<readonly [RegExp, EffectType]> = [
  // PREFIX stems (no trailing \b) — SK/EN inflections ride on the stem
  // ("reverbu", "delayu", "chorusu"…). Anchor \b at the start only.
  [/\breverb|\bdozvuk|\bozven/, "reverb"],
  [/\bdelay|\becho|\bdekou/, "delay"],
  [/\bdistort|\bsaturat|\bsaturac|\bdriv/, "saturation"],
  [/\bchorus|\bkorus/, "chorus"],
  [/\bflanger/, "flanger"],
  [/\bphaser|\bfazer/, "phaser"],
  [/\btremolo/, "tremolo"],
  [/\bbitcrush|\bcrush/, "bitcrusher"],
  [/\bcompress|\bkompres/, "compressor"],
  [/\bsidechain|\bpump(?:a|e|u)?/, "pump"],
  [/\bbass.?harmon|\bkoren\b|\bharmonik/, "bassHarmonic"],
  [/\bskrutka|\btwist\b|\bdispers/, "skrutka"],
  // Formant is the word beatmakers actually reach for; "harmony" already
  // routes to GROW above, so the match is deliberately vowel-anchored on
  // "rezonan" plus explicit formant/voice words rather than a bare \bharmon.
  [/\brezonan|\bformant/, "rezonans"],
  [/\beq\b|\bfilter|\bfiltr|\bekvaliz/, "eq"],
  // P2 domain calibration (2026-10-20): the dynamics and filter effects are
  // addressable by name so threshold/attack/release/cutoff/Q asks can resolve
  // to a concrete effect before the param layer picks the knob.
  [/\blimiter\b/, "limiter"],
  [/\bgate\b|\bnoise gate\b/, "gate"],
  [/\bhaas\b|\bwidener\b/, "haasWidener"],
  [/\bsvf\b|\bsv filter\b|\bstate.variable\b/, "svFilter"],
];

/** The effect named in a lowercased clause, or null when it names none. */
export function effectWordIn(lower: string): EffectType | null {
  for (const [re, type] of EFFECT_WORDS) {
    if (re.test(lower)) return type;
  }
  return null;
}
