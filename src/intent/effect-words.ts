import { EFFECT_META } from "../effects/definitions";
import type { EffectType } from "../project-model/types";

/**
 * THE EFFECT WORD TABLE IS DERIVED FROM THE REGISTRY (R-01, audit 2026-10-24).
 *
 * This used to be a hand-written table of 18 regex rows that was allowed to
 * disagree with the registry — and it disagreed in both directions, all the
 * way to the user:
 *
 *   - "distortion" resolved to SATURATION, while `distortion` is a registered
 *     effect of its own (a harder waveshaper) that the MCP surface inserts.
 *     The same sentence meant two different effects depending on who heard it.
 *   - "sv filter" resolved to EQ, because the generic `\bfilter` row came
 *     first and the lookup took the FIRST match — while the intent layer's own
 *     param layer forced `svFilter` for every cutoff/Q ask. The intent layer
 *     disagreed with itself.
 *   - 41 of the 57 registered effects had NO word at all: "grow", "drift",
 *     "zenit", "apex", "prism", "vinyl suite", "beat mangler"… the names the
 *     UI shows were unspeakable.
 *
 * The registry (`EFFECT_META`) is the single source of truth for what an
 * effect IS and what it is CALLED, so the word table is now DERIVED from it:
 * every effect's id, its camel-split id and its display name are words for
 * that effect and for no other. The hand-written table survives only as the
 * ALIAS layer — the linguistic synonyms no registry can know ("reverbu",
 * "dozvuk", "kompres", "koren").
 *
 * WHY THE IMPORT COSTS NOTHING. The module used to be "self-contained" because
 * `src/intent/mix.ts` drags the effect preset library (40 KB) and the artist
 * mix profiles onto the boot path. `EFFECT_META` lives in
 * `src/effects/definitions.ts`, which the project model already pulls in
 * (`src/project-model/schema.ts`), so the registry sits in the studio boot
 * closure whether or not this module names it. Measured: the boot path did not
 * move (`scripts/check-bundle-size.mjs`, "studio boot path" line).
 *
 * THE MATCH RULE IS SPECIFICITY, NOT ROW ORDER. The longest matched text
 * wins; on a tie a canonical name beats an alias. The old first-match-wins
 * lookup let the ORDER of the rows decide the meaning, which is why the
 * generic `\bfilter` row could swallow the specific "sv filter" name. Now
 * "sv filter" (9 chars) beats "filter" (6 chars) on its own, and the table
 * cannot be mis-ordered by accident.
 */

interface WordRule {
  re: RegExp;
  type: EffectType;
  /** True when the word is the registry's OWN name for the effect. */
  canonical: boolean;
}

/** Escape a literal so it can sit inside a regex. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Separators a canonical phrase accepts between its words. The registry
 * writes one name four ways — "bass harmonic", "bass-harmonic", "M/S EQ" and
 * "Multi-Tap" — and all four are the same name.
 */
const SEPARATOR = "[\\s\\-_/&]+";

/**
 * A canonical rule matches WHOLE words (or a whole phrase), never a bare
 * prefix: "comb" must not match "combined", "grow" must not swallow
 * "growth", and "eq" must not match "sequel".
 */
function canonicalRule(words: string[], type: EffectType): WordRule | null {
  const parts = words.flatMap((word) => word.split(/[^a-z0-9]+/)).filter(Boolean);
  if (parts.length === 0) return null;
  const body = parts.map(escapeLiteral).join(SEPARATOR);
  return { re: new RegExp(`\\b${body}\\b`), type, canonical: true };
}

/**
 * The canonical layer: every registered effect, under its own id, its
 * camel-split id and its display name. Derived, never hand-maintained — a new
 * effect in the registry is speakable the moment it is registered.
 */
function buildCanonicalRules(): WordRule[] {
  const rules: WordRule[] = [];
  for (const type of Object.keys(EFFECT_META) as EffectType[]) {
    const meta = EFFECT_META[type];
    const id = type.toLowerCase();
    const splitId = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    const name = meta.name.toLowerCase();
    for (const words of [id, splitId, name]) {
      const rule = canonicalRule([words], type);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/**
 * THE ALIAS LAYER — linguistic synonyms and inflections the registry cannot
 * know. It may never OUTRANK a canonical name: the longest match wins, and a
 * canonical name wins a tie.
 */
const ALIASES: ReadonlyArray<readonly [RegExp, EffectType]> = [
  // PREFIX stems (no trailing \b) — SK/EN inflections ride on the stem
  // ("reverbu", "delayu", "chorusu"…). Anchor \b at the start only.
  [/\breverb|\bdozvuk|\bozven/, "reverb"],
  [/\bdelay|\becho|\bdekou/, "delay"],
  // "distort" is the stem of DISTORTION, a registered waveshaper of its own.
  // It used to point at saturation, which made the registry's own name
  // resolve to a different effect than the registry says it is.
  [/\bdistort/, "distortion"],
  [/\bsaturat|\bsaturac|\bdriv/, "saturation"],
  [/\bchorus|\bkorus/, "chorus"],
  [/\bflanger/, "flanger"],
  [/\bphaser|\bfazer/, "phaser"],
  [/\btremolo/, "tremolo"],
  [/\bbitcrush|\bcrush/, "bitcrusher"],
  [/\bcompress|\bkompres/, "compressor"],
  // Bare "sidechain" is the SIDECHAIN effect — the registry's own name for it.
  // PUMP stays reachable by its own name and by the compound phrase
  // producers actually say, which is longer than the canonical word and so
  // wins the specificity contest on its own.
  [/\bsidechain[\s-]?pump\b/, "pump"],
  [/\bpump(?:a|e|u)?/, "pump"],
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
  // "sv filter" and "state variable filter" are the registry's own name for
  // svFilter and are handled by the canonical layer; the short forms stay.
  [/\bsvf\b|\bstate.variable\b/, "svFilter"],
];

const ALL_RULES: readonly WordRule[] = [
  ...buildCanonicalRules(),
  ...ALIASES.map(([re, type]) => ({ re, type, canonical: false })),
];

/**
 * The effect named in a lowercased clause, or null when it names none.
 *
 * The LONGEST matched text wins, and a canonical name beats an alias on a
 * tie. Both halves matter: length alone would let a generic alias outrank a
 * specific canonical name of the same length, and canonical-first alone
 * would restore the old "the row order decides the meaning" defect.
 */
export function effectWordIn(lower: string): EffectType | null {
  let bestType: EffectType | null = null;
  let bestLength = -1;
  let bestCanonical = false;
  for (const rule of ALL_RULES) {
    const match = rule.re.exec(lower);
    if (!match) continue;
    const length = match[0].length;
    const better = length > bestLength || (length === bestLength && rule.canonical && !bestCanonical);
    if (better) {
      bestType = rule.type;
      bestLength = length;
      bestCanonical = rule.canonical;
    }
  }
  return bestType;
}
