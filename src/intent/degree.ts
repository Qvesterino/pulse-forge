/**
 * GRADUATED DEGREE — the one ordered scale for "how much".
 *
 * AUDIT 2026-10-18 (intent semantic-precision audit). Before this module the
 * engine carried FOUR independent ladders for the same English sentence:
 *
 *   | word        | production.ts | conversation.ts | mix.ts | param-intent.ts |
 *   | ----------- | ------------- | ---------------- | ------ | --------------- |
 *   | barely      | 0.20          | normal (×0.82)   | medium | medium (0.18)   |
 *   | slightly    | 0.35          | subtle (×0.92)   | subtle | medium (0.18)   |
 *   | a bit       | 0.35          | subtle (×0.92)   | subtle | medium (0.18)   |
 *   | somewhat    | 0.55          | normal           | medium | medium          |
 *   | much        | 0.85          | big (×0.70)      | medium | medium (0.18)   |
 *   | a lot       | 0.85          | big (×0.70)      | huge   | huge (0.32)     |
 *   | fully       | 0.95          | full (×0.50)     | medium | medium          |
 *
 * Three provable defects fall out of that table:
 *
 *   1. "slightly more reverb" and "slightly longer delay on the reverb" are
 *      the SAME phrase to a user, but mix.ts called the first `subtle` (0.5)
 *      and param-intent.ts called the second `medium` (0.18) — the weaker
 *      knob moved, the stronger one did not.
 *   2. "much" was unhandled outside production.ts, so "much more reverb" was
 *      MEDIUM while "a lot more reverb" was HUGE — the weaker adverb produced
 *      the stronger change. Inverted order against production.ts (0.85).
 *   3. "barely" had no rung at all outside production.ts and silently fell to
 *      the medium default.
 *
 * This module is the shared vocabulary and the shared CALIBRATION, not a
 * fifth ladder. production.ts keeps its own table (it is concept-window
 * scoped and pinned by tests/intent-production-degree.test.ts); its numeric
 * anchors are the ones reproduced below, so the two agree by construction.
 *
 * ── DESIGN RULE: ADDITIVE ONLY ────────────────────────────────────────────
 * Every numeric anchor here equals the value some existing code already used.
 * New words are ADDED to bands; no previously-handled word is renumbered.
 * That is what lets a five-ladder engine become one without changing a single
 * tuned audio constant that a human has already listened to.
 */

/**
 * The seven ordered levels. The number IS the rank — `level` is what callers
 * compare, `value` is what they calibrate with.
 */
export type DegreeLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type DegreeName = "minimal" | "verySmall" | "small" | "moderate" | "large" | "veryLarge" | "maximum";

export interface Degree {
  level: DegreeLevel;
  name: DegreeName;
  /** Normalised 0..1 degree. Monotone in `level` — see the ordering note below. */
  value: number;
  /** The exact text that matched, for the inspectable plan / read-back. */
  matched: string;
}

interface DegreeBand {
  level: DegreeLevel;
  name: DegreeName;
  value: number;
  /**
   * Words are matched on DEACCENTED lowercase text (callers may pass raw).
   * Every band is the union of the four vocabularies this module replaces, so
   * no word that used to be recognised can be lost: `dost` is here because
   * "o dosť" deaccents to "dost" and production.ts's `doš` never matched it.
   */
  words: RegExp;
}

/**
 * Ordered strongest-last so that scanning ascending gives the strongest band
 * on first hit; resolution itself is distance-based (see `parseDegree`).
 *
 * SATURATION IS DOCUMENTED, NOT HIDDEN: bands 6 and 7 share the 0.85 anchor
 * band for most words, so "a lot" and "fully" are separated by the CALIBRATION
 * curve (0.85 vs 0.95), not by the vocabulary. Band 1 has no legacy peer
 * outside production.ts, which is why its value 0.20 is untouched.
 */
const DEGREE_BANDS: readonly DegreeBand[] = [
  {
    level: 1,
    name: "minimal",
    value: 0.2,
    words:
      /\b(?:barely|hardly|scarcely|minimally|takmer|minimalne|almost imperceptibly|nearly imperceptibly|the tiniest bit|tiny bit|a hair's breadth)\b/,
  },
  {
    level: 2,
    name: "verySmall",
    // NEW BAND. No legacy word sat between "barely" (0.20) and "a little"
    // (0.35), so this slot renumbers nothing. Sits at 0.27, i.e. clearly
    // weaker than "a little" and clearly stronger than "barely".
    value: 0.27,
    words: /\b(?:a hair|a jot|a touch|a tad|a smidge|just a tiny bit|a smidge more|nepatrno|o vlasko)\b/,
  },
  {
    level: 3,
    name: "small",
    // 0.35 — the exact value production.ts already returns for this band.
    value: 0.35,
    words: /\b(?:slightly|subtle|a bit|a little|smidge|trochu|mierne|jemne|naputok|kusok|malic(?:ko|y)?|mali|mahko)\b/,
  },
  {
    level: 4,
    name: "moderate",
    value: 0.55,
    words: /\b(?:somewhat|fairly|moderately|reasonably|rather|stredne|primerane|pomerne)\b/,
  },
  {
    level: 5,
    name: "large",
    // 0.70 — production.ts's "quite / noticeably / significantly" band. Kept
    // at 0.70 rather than raised so the pinned 0.7 fixture still holds.
    //
    // SATURATION, DOCUMENTED: 0.70 is the ANCHOR of the unqualified default in
    // the effect-knob and param-fraction curves, so level 5 calibrates to
    // exactly the default there. That is not a bug — production.ts has the
    // same property (DEFAULT_AMOUNT = 0.7). Level 5 only pulls its weight
    // above the default in the gain curve, where the default sits at 0.82.
    // The SK intensity adverbs ("veľmi", "mocne", "o dosť") are therefore NOT
    // here: the fader ladder has always called them `big`, so they belong at
    // 0.85 to keep ×0.70.
    value: 0.7,
    words:
      /\b(?:quite|pretty|notably|substantially|significantly|noticeably|considerably|considerrably|znacne|znaene|vyrazne|markedly)\b/,
  },
  {
    level: 6,
    name: "veryLarge",
    // 0.85 — production.ts's "much / a lot / heavily" band. `much` now REACHES
    // this band in the fader/effect/param ladders too, which is defect 2 above.
    value: 0.85,
    words:
      /\b(?:much|way|a lot|lots|heavily|strongly|dramatically|drastically|huge|massively|really|obri|vela|hodn\w*|velmi\w*|mocne|poriadne|dost|dosť)\b/,
  },
  {
    level: 7,
    name: "maximum",
    // 0.95 — production.ts's "max / fully / completely" band.
    value: 0.95,
    words:
      /\b(?:max(?:imal|imum)?|fully|totally|completely|complete|plne|upln|uplne|naplno|extrem\w*|as far as possible|as much as possible|to the limit|all the way|nast maximum|maximalne)\b/,
  },
];

/** Deaccent + lowercase + pad, the house style for every intent matcher. */
export function deaccentLower(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0161\u0165]/g, (c) => (c === "\u0161" ? "s" : "t"))} `;
}

/**
 * A softener in front of "too much" is ONE phrase, not two competing degree
 * tokens. Without this the nearer/stronger "much" masks the attenuation
 * ("make it a bit too much punchier" reading as a hard ask). Production.ts
 * already learned this (production.ts:483); it is reproduced here so every
 * caller gets it, not just the production goals.
 */
const SOFTENER_BEFORE_TOO_MUCH =
  /\b(?:slightly|a bit|a little|a touch|a tad|trochu|mierne|jemne|barely|naputok)\s+too\s+much\b/;

/**
 * Resolve the degree named in `text`.
 *
 * `anchor` is an optional index into `text` (a concept/param match position).
 * When given, the CLOSEST degree word to that anchor wins, because people
 * write the qualifier nearest the thing they are qualifying — "slightly deeper
 * bass, much punchier drums" must not let "much" bleed onto "deeper". With no
 * anchor the leftmost occurrence wins, which is correct for the single-target
 * asks ("make it a little quieter").
 *
 * Ties break toward the STRONGER word so "deeper, much" and "much, deeper"
 * agree. Returns null when the text names no degree at all — callers keep
 * their documented default, which is why nothing here can silently change an
 * unqualified ask.
 */
export function parseDegree(text: string, anchor?: number): Degree | null {
  const lower = deaccentLower(text);
  const soft = SOFTENER_BEFORE_TOO_MUCH.exec(lower);
  if (soft) {
    const band = DEGREE_BANDS.find((b) => b.words.test(soft[0]));
    // The softener band (level 1 or 3) wins outright over the "much" inside.
    if (band) return { level: band.level, name: band.name, value: band.value, matched: soft[0] };
  }

  const target = anchor === undefined ? 0 : deaccentLower(text.slice(0, Math.max(0, anchor))).length - 1;
  let best: { degree: Degree; distance: number } | null = null;
  for (const band of DEGREE_BANDS) {
    const hit = band.words.exec(lower);
    if (!hit) continue;
    const start = hit.index;
    const end = hit.index + hit[0].length;
    // Distance from the anchor span to this word's span (0 when it overlaps).
    const distance = anchor === undefined ? start : Math.max(0, Math.max(start - target, target - end));
    const degree: Degree = { level: band.level, name: band.name, value: band.value, matched: hit[0] };
    if (!best || distance < best.distance || (distance === best.distance && degree.level > best.degree.level)) {
      best = { degree, distance };
    }
  }
  return best?.degree ?? null;
}

// ── Calibration ──────────────────────────────────────────────────────────────
//
// The levels are SEMANTIC, not percentages: "a little" and "0.35" mean the
// same thing only because the domain's own curve says so. Each domain keeps
// its own unit — a gain factor (multiplicative, dB-shaped), a knob scale
// (multiplier on the per-effect delta) and a range fraction (applied in the
// param's own log/linear domain). The ANCHORS are the legacy tables verbatim,
// so calibration reproduces every pre-existing value exactly and only fills
// the gaps the old ladders left.

function lerpAnchors(anchors: ReadonlyArray<readonly [number, number]>, value: number): number {
  if (anchors.length === 0) return value;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return value;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const next = anchors[i];
    if (!prev || !next) continue;
    if (value <= next[0]) {
      const span = next[0] - prev[0];
      const ratio = span === 0 ? 0 : (value - prev[0]) / span;
      return prev[1] + ratio * (next[1] - prev[1]);
    }
  }
  return last[1];
}

/**
 * GAIN. Anchors are `FADER_FACTORS` verbatim (conversation.ts:431): 0.35 →
 * subtle 0.92/1.08, 0.70 → normal 0.82/1.22, 0.85 → big 0.70/1.35,
 * 0.95 → full 0.50/1.60. Identity at 0 so an absent degree means no change.
 */
const FADER_ANCHORS_DOWN: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.35, 0.92],
  [0.7, 0.82],
  [0.85, 0.7],
  [0.95, 0.5],
];
const FADER_ANCHORS_UP: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.35, 1.08],
  [0.7, 1.22],
  [0.85, 1.35],
  [0.95, 1.6],
];

/** Multiplicative fader factor for a degree. Down factors ≤ 1, up ≥ 1. */
export function calibrateFaderFactor(value: number, direction: "down" | "up"): number {
  const raw = direction === "down" ? lerpAnchors(FADER_ANCHORS_DOWN, value) : lerpAnchors(FADER_ANCHORS_UP, value);
  // Round to the 2 dp the gain clamp uses, so the engine and the read-back
  // print the same number the command actually wrote.
  return Math.round(raw * 100) / 100;
}

/**
 * EFFECT KNOB. Anchors are `AMOUNT_SCALE` verbatim (mix.ts:1017) applied to the
 * 0.16 base: 0.35 → subtle 0.5, 0.70 → medium 1, 0.85 → huge 1.75.
 */
const KNOB_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.35, 0.5],
  [0.7, 1],
  [0.85, 1.75],
];

export function calibrateKnobScale(value: number): number {
  return lerpAnchors(KNOB_ANCHORS, value);
}

/**
 * PARAM RANGE FRACTION. Anchors are `AMOUNT_FRACTION` verbatim
 * (param-intent.ts:109): 0.35 → subtle 0.08, 0.70 → medium 0.18,
 * 0.85 → huge 0.32. Applied in the param's OWN domain (log when taper:"log"),
 * so a 0.05 step means something different on reverb.decay than on compressor
 * — that is the point, and it is why this is a fraction and not a raw delta.
 */
const PARAM_FRACTION_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.35, 0.08],
  [0.7, 0.18],
  [0.85, 0.32],
];

export function calibrateParamFraction(value: number): number {
  return lerpAnchors(PARAM_FRACTION_ANCHORS, value);
}

// ── Legacy enum projection ───────────────────────────────────────────────────
// The `amount` fields are pinned by existing tests and by the model schema
// (`intent-model-schema.ts` ships "subtle"/"normal"/… as classes), so the
// enums stay. These projections keep the enum and the degree in ONE agreement:
// every word keeps the bucket it had before, and only the gaps fill in.

export type FaderAmountName = "subtle" | "normal" | "big" | "full";

/**
 * The enum is derived from the LEVEL, but the level boundaries here are the
 * ones the legacy fader ladder actually used — not the calibration anchors of
 * the other two domains:
 *
 *   level 1-3 -> "subtle" (legacy: trochu / kusok / jemne / slightly / a bit /
 *                              a little / subtle)
 *   level 4-5 -> "normal" (new words; "normal" was the unqualified default)
 *   level 6   -> "big"     (legacy: o dosť / dosť / veľmi / hodne / a lot /
 *                              much / way / hugely)
 *   level 7   -> "full"    (legacy: úplne / plne / maximálne / complete / fully)
 *
 * Levels 4 and 5 calibrate to a factor BETWEEN subtle and normal, so labelling
 * them "normal" is the honest bucket: the label is a range, not the magnitude.
 */
export function degreeToFaderAmount(level: DegreeLevel): FaderAmountName {
  if (level <= 3) return "subtle";
  if (level <= 5) return "normal";
  if (level === 6) return "big";
  return "full";
}

export type EffectAmountName = "subtle" | "medium" | "huge";

export function degreeToEffectAmount(level: DegreeLevel): EffectAmountName {
  if (level <= 3) return "subtle";
  if (level <= 5) return "medium";
  return "huge";
}

/** Every band's words, for the taxonomy documentation test. */
export function degreeBandVocabulary(): ReadonlyArray<{ level: DegreeLevel; value: number; pattern: string }> {
  return DEGREE_BANDS.map((band) => ({ level: band.level, value: band.value, pattern: band.words.source }));
}

/** All bands ordered by level — the exported taxonomy for tests and docs. */
export function degreeBands(): ReadonlyArray<DegreeBand> {
  return DEGREE_BANDS;
}
