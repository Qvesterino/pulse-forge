import type { SceneRole } from "../project-model/types";
import type { ProductionConcept, ProductionIntent, ProductionTarget } from "./production";
import { CONCEPTS } from "./production";
import type { SongSectionSpec } from "./song";

/**
 * SECTION VOCABULARY (wave 2): the beatmaker names the passages in the
 * sentence — "wobbly drill with a 16-bar intro and a vinyl break" — and the
 * song form obeys: resize/duplicate/omit sections, and scope an FX request
 * to ONE section ("vinyl break" → vinyl only in the break).
 *
 * EN + SK, matched accent-tolerantly on the ORIGINAL text (mostík matches
 * "mostik" and vice versa) so the remaining text keeps its diacritics for
 * the downstream SK-aware parsers. Everything here is deterministic.
 */

/** One structural request extracted from the text. */
export interface SectionRequest {
  role: SceneRole;
  /** "16-bar intro" — resize the first section of this role. */
  bars?: number;
  /** "chorus twice" / "2x drop" — total copies of the section. */
  repeats?: number;
  /** "no break" / "bez breaku" — remove the role from the form. */
  omit?: boolean;
}

/** An FX request scoped to one section role ("vinyl break"). */
export interface ScopedFx {
  role: SceneRole;
  fx: ProductionIntent;
}

export interface SectionParse {
  requests: SectionRequest[];
  scopedFx: ScopedFx[];
  /** Text with all matched section/fx phrases removed — safe to re-parse. */
  remainingText: string;
}

const ROLE_WORDS: readonly { role: SceneRole; words: readonly string[] }[] = [
  { role: "intro", words: ["intro"] },
  { role: "verse", words: ["verse", "zloha", "sloha"] },
  { role: "chorus", words: ["chorus", "refren", "hook"] },
  { role: "bridge", words: ["bridge", "mostík"] },
  { role: "break", words: ["break", "breakdown"] },
  { role: "drop", words: ["drop"] },
  { role: "build", words: ["build"] },
  { role: "outro", words: ["outro", "záver", "ending"] },
];

/**
 * FX surface forms → canonical concept. The words people actually attach to
 * a section; full production detection still runs on the remaining text.
 */
const FX_WORDS: readonly { word: string; concept: ProductionConcept }[] = [
  { word: "vinyl", concept: "lofi" },
  { word: "lofi", concept: "lofi" },
  { word: "wobbly", concept: "wobbly" },
  { word: "houpavý", concept: "wobbly" },
  { word: "robotic", concept: "robotic" },
  { word: "robotický", concept: "robotic" },
  { word: "metallic", concept: "metallic" },
  { word: "kovový", concept: "metallic" },
  { word: "warmer", concept: "warmer" },
  { word: "teplejší", concept: "warmer" },
  { word: "deeper", concept: "deeper" },
  { word: "hlbší", concept: "deeper" },
  { word: "punchier", concept: "punchier" },
  { word: "darker", concept: "darker" },
  { word: "tmavší", concept: "darker" },
  { word: "brighter", concept: "brighter" },
  { word: "svetlejší", concept: "brighter" },
  { word: "grittier", concept: "grittier" },
  { word: "dirtier", concept: "grittier" },
];

const OMIT_WORDS = ["no", "without", "bez", "žiadny", "žiadne"];
const BAR_UNITS = "bars?|barov|taktov|takty|takt";

const ALL_ROLE_WORDS = ROLE_WORDS.flatMap((r) => r.words);
const ALL_FX_WORDS = FX_WORDS.map((f) => f.word);

/**
 * Accent-tolerant word regex: every spellable SK vowel/consonant becomes a
 * character class, so "mostík" compiles to /most[ií]k/ and matches both
 * spellings directly on the original (accented) text.
 */
const ACCENTS: Record<string, string> = {
  a: "[aá]",
  c: "[cč]",
  d: "[dď]",
  e: "[eé]",
  i: "[ií]",
  l: "[lľ]",
  n: "[nň]",
  o: "[oó]",
  s: "[sš]",
  t: "[tť]",
  u: "[uú]",
  y: "[yý]",
  z: "[zž]",
};

const deacc = (word: string): string =>
  word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const w = (word: string): string =>
  // De-accent FIRST so accented vocabulary ("mostík") expands into classes
  // and matches both spellings — the ACCENTS map keys are base letters.
  deacc(word)
    .split("")
    .map((ch) => ACCENTS[ch] ?? ch)
    .join("");

const wordList = (words: readonly string[]): string => words.map(w).join("|");

/**
 * Role atom — the vocabulary plus one optional SK declension suffix
 * ("bez breaku", "dlhý mostík"). roleForWord strips the suffix again when
 * canonicalizing the match.
 */
const ROLE_ATOM = `((?:${wordList(ALL_ROLE_WORDS)})(?:u|a|om|e|y|i)?)`;

/**
 * SK declensions ("bez breaku", "dlhý mostík", "dva chorussy") append a
 * short suffix to the role word — match the vocabulary with one trailing
 * suffix stripped.
 */
const roleForWord = (de: string): SceneRole | null => {
  const find = (candidate: string): SceneRole | null =>
    ROLE_WORDS.find((r) => r.words.some((word) => deacc(word) === candidate))?.role ?? null;
  return find(de) ?? find(de.replace(/(?:ua|u|a|om|e|y|i|s)$/i, ""));
};

const conceptForWord = (de: string): ProductionConcept | null =>
  FX_WORDS.find((f) => deacc(f.word) === de)?.concept ?? null;

const defaultTargetFor = (concept: ProductionConcept): ProductionTarget =>
  CONCEPTS.find((c) => c.concept === concept)?.defaultTarget ?? "drums";

const clampSectionBars = (bars: number): number => Math.max(2, Math.min(16, bars));

/**
 * Parse section requests + section-scoped FX from free text. Returns null
 * when the sentence carries no section vocabulary at all.
 */
export function parseSectionRequests(text: string): SectionParse | null {
  let working = ` ${text.replace(/[\s,.]+/g, " ").trim()} `;
  const requests: SectionRequest[] = [];
  const scopedFx: ScopedFx[] = [];

  const cut = (match: RegExpMatchArray): void => {
    working = working.replace(match[0], " ");
  };
  // The matches come from accent-tolerant regexes over the ACCENTED text;
  // to canonicalize a matched word back to a role/concept, de-accent it and
  // compare against the de-accented vocabulary.
  const de = deacc;

  // 1) Scoped FX — "vinyl break", optional bar count between the words
  //    ("vinyl 8-bar break"). One request per (concept, role).
  const scopedRe = new RegExp(
    `\\b(${wordList(ALL_FX_WORDS)})\\s+(?:(?:\\d{1,3})[\\s-]*(?:${BAR_UNITS})\\s+)?${ROLE_ATOM}\\b`,
    "i",
  );
  for (let match = working.match(scopedRe); match; match = working.match(scopedRe)) {
    const role = roleForWord(de(match[2]!));
    const concept = conceptForWord(de(match[1]!));
    if (role && concept && !scopedFx.some((s) => s.role === role && s.fx.goals[0]?.concept === concept)) {
      scopedFx.push({
        role,
        fx: {
          targets: [defaultTargetFor(concept)],
          goals: [{ concept, amount: 0.7 }],
          sourceText: match[0].trim(),
        },
      });
    }
    cut(match);
  }

  // 2) Omit — "no break", "without intro", "bez breaku", "žiadny drop".
  const omitRe = new RegExp(`\\b(?:${wordList(OMIT_WORDS)})\\s+${ROLE_ATOM}\\b`, "i");
  for (let match = working.match(omitRe); match; match = working.match(omitRe)) {
    const role = roleForWord(de(match[1]!));
    if (role && !requests.some((r) => r.role === role)) requests.push({ role, omit: true });
    cut(match);
  }

  // 3) Repeats — "chorus twice", "2x drop", "drop 3x", "refren dvakrát".
  const N = "\\d{1,2}";
  const X = `(?:(${N})\\s*x|x\\s*(${N})|twice|dvakrát)`;
  const repeatsAfter = new RegExp(`\\b${ROLE_ATOM}\\s+${X}\\b`, "i");
  const repeatsBefore = new RegExp(`\\b${X}\\s+${ROLE_ATOM}\\b`, "i");
  // Per-pass group maps: [roleIdx, firstNumIdx, secondNumIdx] — the number
  // groups sit BEFORE the role group in the "2x drop" form and after it in
  // "drop 3x", so a shared index would read the role word as a number.
  for (const [re, roleIdx, num1Idx, num2Idx] of [
    [repeatsAfter, 1, 2, 3],
    [repeatsBefore, 3, 1, 2],
  ] as const) {
    for (let match = working.match(re); match; match = working.match(re)) {
      const role = roleForWord(de(match[roleIdx]!));
      const n = Number(match[num1Idx] ?? match[num2Idx] ?? 2);
      if (role && n >= 2 && n <= 8 && !requests.some((r) => r.role === role && r.repeats)) {
        requests.push({ role, repeats: n });
      }
      cut(match);
    }
  }

  // 4) Bars — "16-bar intro", "16 bar intro", "16 taktov intro",
  //    "intro 16 bars", "intro 16 taktov".
  const NUM = "\\d{1,3}";
  const barsBefore = new RegExp(`\\b(?:(${NUM})[\\s-]*(?:${BAR_UNITS})?[\\s-]+)${ROLE_ATOM}\\b`, "i");
  const barsAfter = new RegExp(`\\b${ROLE_ATOM}\\s+(?:(${NUM})[\\s-]*(?:${BAR_UNITS}))\\b`, "i");
  for (const [re, roleIdx, numIdx] of [
    [barsBefore, 2, 1],
    [barsAfter, 1, 2],
  ] as const) {
    for (let match = working.match(re); match; match = working.match(re)) {
      const role = roleForWord(de(match[roleIdx]!));
      const bars = Number(match[numIdx] ?? 0);
      // Cut only on a RECORDED request — "808 break" must survive the
      // sentence for the downstream bass parsing when 808 is a number, not
      // a bar count.
      if (role && bars >= 2 && bars <= 16 && !requests.some((r) => r.role === role && r.bars)) {
        requests.push({ role, bars });
        cut(match);
      } else {
        break;
      }
    }
  }

  // An EMPTY remainder is correct when the sentence was pure section
  // vocabulary ("vinyl break") — falling back to the full text would make
  // the downstream production parse double-apply the same fx words.
  const remainingText = working.replace(/\s+/g, " ").trim();
  if (requests.length === 0 && scopedFx.length === 0) return null;
  return { requests, scopedFx, remainingText };
}

/**
 * Reshape a planned form with the parsed requests: omit, resize (first
 * match), duplicate, and attach scoped FX to the first matching section.
 * Guards the invariant that the form never empties — an over-eager "no"
 * leaves the previous shape untouched.
 */
export function applySectionRequests(sections: SongSectionSpec[], parse: SectionParse): SongSectionSpec[] {
  let out = [...sections];
  for (const req of parse.requests) {
    if (req.omit) {
      const filtered = out.filter((s) => s.role !== req.role);
      if (filtered.length > 0) out = filtered;
      continue;
    }
    const index = out.findIndex((s) => s.role === req.role);
    if (index === -1) continue;
    if (req.bars !== undefined) {
      out = out.map((s, i) => (i === index ? { ...s, bars: clampSectionBars(req.bars!) } : s));
    }
    if (req.repeats !== undefined && req.repeats > 1) {
      const source = out[index];
      const copies = Array.from({ length: req.repeats - 1 }, (_, k) => ({
        ...source,
        label: `${source.label} ${k + 2}`,
      }));
      out = [...out.slice(0, index + 1), ...copies, ...out.slice(index + 1)];
    }
  }
  for (const scoped of parse.scopedFx) {
    const index = out.findIndex((s) => s.role === scoped.role);
    if (index === -1) {
      // The sentence asks for a section the genre form doesn't have
      // ("vinyl break" on a drill form) — insert a small one before the
      // outro instead of silently dropping the request.
      const insertAt = Math.max(0, out.length - 1);
      const section: SongSectionSpec = {
        role: scoped.role,
        label: `${scoped.role.charAt(0).toUpperCase()}${scoped.role.slice(1)}`,
        bars: 4,
        intensity: 0.45,
        transitionIn: scoped.role === "break" ? "break" : null,
        energyDelta: 0.5,
        densityDelta: 0.45,
        complexityDelta: 0.5,
        instrumentation: ["drums", "bass", "chords", "lead"],
        fx: scoped.fx,
      };
      out = [...out.slice(0, insertAt), section, ...out.slice(insertAt)];
      continue;
    }
    out = out.map((s, i) => (i === index ? { ...s, fx: scoped.fx } : s));
  }
  return out;
}
