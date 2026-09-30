import type { EffectType, ProjectDocument } from "../project-model/types";
import { hashString } from "../shared/rng";

/**
 * Production Intent layer (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md §4.3, §19,
 * §21 Phase 1+2): sonic GOALS in natural language — "make the bass deeper" —
 * compiled deterministically into existing KYX effect operations.
 *
 * v1 is intentionally narrow (master doc §22): 9 concepts × a handful of
 * targets, comparative/imperative phrasing only, no models. SK extends
 * DETECTION; canonical concept ids stay English (repo convention).
 *
 * Language proposes intent. KYX owns execution.
 */

export type ProductionConcept =
  | "deeper"
  | "punchier"
  | "warmer"
  | "darker"
  | "brighter"
  | "wider"
  | "grittier"
  | "telephone"
  | "tape"
  | "stutter"
  | "glue"
  | "lofi"
  | "wobbly"
  | "robotic"
  | "metallic"
  // Level 3 — device-level asks. Each maps onto an effect that already
  // exists in the registry with canonical params, so nothing here invents
  // a new DSP path: the concept only decides WHICH device and with which
  // starting values, and the amount scales the primary parameter.
  | "filter"
  | "sidechain"
  | "notch"
  | "phaser"
  | "chorus"
  | "sharper"
  | "reverse"
  | "crunchy"
  | "vinyl"
  | "wide"
  | "sub"
  | "air"
  | "deess";

export type ProductionTarget = "drums" | "bass" | "lead" | "chords" | "kick" | "snare" | "hats" | "mix";

export interface ProductionGoal {
  concept: ProductionConcept;
  amount: number; // 0..1, default 0.7
  /** Explicit frequency for surgical concepts (notch/notch-filter). */
  targetHz?: number;
}

export interface ProductionIntent {
  targets: ProductionTarget[];
  goals: ProductionGoal[];
  sourceText: string;
  /**
   * ELEMENT-LEVEL targets (vibe-code wave): "kick more knock" names a PAD
   * family inside the drum track. The planner adds per-pad gain
   * adjustments on top of the track FX.
   */
  padTargets?: Array<"kick" | "snare" | "hats">;
}

/** One planned DSP change on one track — params fold over effect defaults. */
export interface ProductionAction {
  trackId: string;
  type: EffectType;
  params: Record<string, number>;
  /** beatMangler only — 16-step volume/pitch envelope planted with the instance. */
  volumeSteps?: number[];
  pitchSteps?: number[];
}

export interface ProductionPlan {
  label: string;
  summary: string;
  actions: ProductionAction[];
  /** Per-pad gain adjustments for pad-family targets (element-level intents). */
  padAdjustments?: Array<{ family: "kicks" | "snares" | "hats"; factor: number }>;
}

/**
 * Concept → per-pad gain factor for pad-family targets. All concepts are
 * intensifiers, so every factor leans ≥ 1; amounts scale the step.
 */
const PAD_CONCEPT_FACTOR: Partial<Record<ProductionConcept, number>> = {
  punchier: 1.3,
  deeper: 1.15,
  grittier: 1.2,
  warmer: 1.05,
  metallic: 1.1,
  robotic: 1.1,
  wobbly: 1.15,
  brighter: 1.05,
  glue: 1.1,
  lofi: 0.9,
};

interface ConceptDef {
  concept: ProductionConcept;
  /** Detection regexes — comparative/imperative forms (SK extends detection). */
  patterns: RegExp[];
  /** Default target when the text names none. */
  defaultTarget: ProductionTarget;
}

export const PRODUCTION_CONCEPTS: readonly ProductionConcept[] = [
  "deeper",
  "punchier",
  "warmer",
  "darker",
  "brighter",
  "wider",
  "grittier",
  "glue",
  "lofi",
  "wobbly",
  "robotic",
  "metallic",
  "filter",
  "sidechain",
  "notch",
  "phaser",
  "chorus",
  "sharper",
  "reverse",
  "crunchy",
  "vinyl",
  "wide",
  "sub",
  "air",
  "deess",
];

export const PRODUCTION_TARGETS: readonly ProductionTarget[] = ["drums", "bass", "lead", "chords"];

/** Exposed for section-scoped FX parsing ("vinyl break") in intent/sections.ts. */
export const CONCEPTS: readonly ConceptDef[] = [
  // SK adjective boundaries: JS \b is ASCII-only (\w = [A-Za-z0-9_]), so a
  // word ENDING in a diacritic ("hlbší") has no \b at its end and a word
  // STARTING with one ("širšie") never matches after a space. Concepts are
  // matched on the raw lowercase text, so the SK patterns close with an
  // ASCII lookahead instead of \b and tolerate the deaccented stem ("sirš").
  {
    concept: "deeper",
    defaultTarget: "bass",
    patterns: [
      /\bdeeper\b/,
      /\bhlb\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/,
      /\bsub-ier\b/,
      /\bhlb\u010d\b/,
    ],
  },
  {
    concept: "punchier",
    defaultTarget: "drums",
    patterns: [/\bpunchier\b/, /\bmore punch\b/, /\bknock\b/, /\bv\u00e4\u010d\u0161\u00ed punch\b/, /\brazantnej/i],
  },
  {
    concept: "warmer",
    defaultTarget: "bass",
    patterns: [/\bwarmer\b/, /\bteplej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/],
  },
  {
    concept: "darker",
    defaultTarget: "drums",
    patterns: [/\bdarker\b/, /\btmav\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/],
  },
  {
    concept: "brighter",
    defaultTarget: "drums",
    patterns: [
      /\bbrighter\b/,
      /\bsvetlej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/,
      /\bjasnej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/,
    ],
  },
  {
    concept: "wider",
    defaultTarget: "lead",
    patterns: [/\bwider\b/, /(?:^|[^a-z0-9])[s\u0161]ir[s\u0161](ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/],
  },
  {
    concept: "grittier",
    defaultTarget: "drums",
    patterns: [
      /\bgrittier\b/,
      /\bdirtier\b/,
      /\b\u0161pinavej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/,
      /\bmore grit\b/,
      /\bviac gritu\b/,
    ],
  },
  {
    concept: "glue",
    defaultTarget: "drums",
    patterns: [/\bmore glue\b/, /\bviac lepidla\b/, /\bglue(?:-?ier)?\b/],
  },
  {
    concept: "lofi",
    defaultTarget: "drums",
    patterns: [/\blo-?fi(er)?\b/, /\bvinyl(?:-?ier)?\b/, /\bvintage(?:-?r)?\b/, /\bstar\u0161\u00ed zvuk\b/],
  },
  {
    concept: "wobbly",
    defaultTarget: "drums",
    patterns: [/\bwobbl/i, /\bhoupav/i, /\bweird(er)?\b/i, /\bskreslen/i],
  },
  {
    concept: "robotic",
    defaultTarget: "lead",
    patterns: [/\brobot/i, /\brobotick/i, /\bmachine-?like\b/i],
  },
  {
    concept: "metallic",
    defaultTarget: "drums",
    patterns: [/\bmetallic/i, /\bkovov/i, /\bmetalov/i],
  },
  // Named-plugin asks (Vlna 8: pluginy cez intent) — the concept names the
  // DEVICE, not just a tone direction.
  {
    concept: "telephone",
    defaultTarget: "lead",
    patterns: [/\btele?phone\b/, /\btelef\u00f3n/i, /\bhandset\b/, /\bhouka\u010dk/i],
  },
  {
    concept: "tape",
    defaultTarget: "drums",
    patterns: [/\btape\b/, /\bp\u00e1ska\b/, /\bp\u00e1skov\u00fd zvuk\b/],
  },
  // ---- Level 3: device-level asks (EN first, SK alongside) ----------
  {
    concept: "filter",
    defaultTarget: "lead",
    // "filter" alone is a DEVICE name; without a movement word it is far
    // too generic to claim a request ("add a filter to the mix" is a mix
    // ask, not a lead ask), so the pattern requires a sweep-ish verb
    // alongside it and accepts the bare device name only after one of
    // the add/apply verbs.
    patterns: [
      /\bauto-?filter\b/,
      /\badd (?:an? )?filter\b/,
      /\b(?:sweep|sweeping|filter sweep|filter sweep)\b/,
      /\bautofiltr\b/,
      /\bautomatick[ýy] filter\b/,
    ],
  },
  {
    concept: "sidechain",
    defaultTarget: "bass",
    patterns: [
      /\bside-?chain\b/,
      /\bpumping\b/,
      /\bpump(?:s|ing|ed)? (?:bass|under|to)\b/,
      /\bduck(?:s|ing|ed)?\b/,
      /\bdukladn[ýy] bass\b/,
    ],
  },
  {
    concept: "notch",
    defaultTarget: "mix",
    patterns: [/\bnotch\b/i, /\brezonanc\w*\b/i, /\bvypichn\w*\b/i, /\bringy (?:freq|tone|resonanc)\w*\b/i],
  },
  {
    concept: "phaser",
    defaultTarget: "lead",
    patterns: [/\bphaser\b/, /\bphase-?r\b/i, /\bfazov[ýy] filter\b/, /\bfázovka\b/],
  },
  {
    concept: "chorus",
    defaultTarget: "lead",
    patterns: [/\bchorus(?: (?:effect|on))?\b/, /\bchorus-?er\b/, /\bchorus-?ed\b/, /\bchór(u|us)?\b/, /\bchvrv/i],
  },
  {
    concept: "sharper",
    defaultTarget: "lead",
    // Sharper is the TRANSPOSE ask ("sharper", "two steps up"), distinct
    // from "brighter" which is a tone/tilt ask on the same word family.
    patterns: [
      /\bsharper\b/,
      /\b(?:two|2|three|3) (?:steps?|semitones?|keys?) up\b/,
      /\bo dva (?:kroky|tóny|polotóny) vyššie\b/,
      /\btranspose (?:up|higher)\b/,
    ],
  },
  {
    concept: "reverse",
    defaultTarget: "lead",
    // Diacritic-safe stems: JS \b does not fire between a word char and a
    // diacritic, so an accented word needs an explicit literal rather than a
    // \b-anchored pattern, and the ASCII stem is what actually generalises.
    patterns: [/\breverse(?:d)?\b/, /\bbackwards?\b/, /obráten/, /\bspätn/, /\bskúten/, /\bspatn/],
  },
  {
    concept: "crunchy",
    defaultTarget: "drums",
    patterns: [
      /\bcrunchy\b/,
      /\bbit-?crush(?:ed|er)?\b/,
      /\bbit-?crush\b/,
      /\b8-?bit\b/,
      /\blo-?fi bit\b/,
      /\bkŕhav[ýy] zvuk\b/,
    ],
  },
  {
    concept: "vinyl",
    defaultTarget: "drums",
    // "lofi" already owns the vintage/vinyl word family, so this concept
    // is the EXPLICIT device ask. Deliberately no bare /\bvinyl\b/ — the
    // first matching concept in CONCEPTS order wins, and "lofi" is
    // declared earlier with /\bvinyl(?:-?ier)?\b/, so a bare "vinyl"
    // still routes there. This catches "crackle" and "wow/flutter",
    // the two things a user names when they mean the DEVICE.
    patterns: [
      /\bcrackle\b/,
      /\bpop(?:s|ping) and hissl?\b/,
      /\bwow(?: and| \+)? flutter\b/,
      /\bvinyl (?:crackle|effect|noise)\b/,
      /\bsk[rv]ip(?:nutie|ov|\\u011b?)\b/,
    ],
  },
  {
    concept: "wide",
    defaultTarget: "chords",
    // Distinct from "wider" (a gradient on the same haasWidener):
    // "wide" asks for a STEREO image on a track that has none, which
    // is a mix ask, so it targets chords and blends the two.
    patterns: [/\bwide(?:r)? stereo\b/, /\bwide mix\b/, /\bstereo width\b/, /\bsirok[ýy] mix\b/],
  },
  {
    concept: "sub",
    defaultTarget: "bass",
    patterns: [/\bmore sub\b/, /\bsub-?heavy\b/, /\bfat sub\b/, /\bsub boost\b/, /\bhust[ýy] sub\b/],
  },
  {
    concept: "air",
    defaultTarget: "lead",
    patterns: [
      /\bmore air\b/,
      /\bairy\b/,
      /\bair(?:y)? (?:top|top end|presence)\b/,
      /\bopen (?:the )?(?:top|highs?)\b/,
      /\bvzduch\b/,
      /\bosvecenie\b/,
    ],
  },
  {
    concept: "deess",
    defaultTarget: "lead",
    patterns: [/\bde-?ess\w*\b/i, /\bsibilan\w*\b/i, /\bess\w*\b/i, /\bsibi?lin\w*\b/i],
  },
  {
    concept: "stutter",
    defaultTarget: "drums",
    patterns: [/\bstutter\b/, /\bst\u00e1kanie\b/, /\bsekaj\u00fac/i],
  },
];

const TARGET_PATTERNS: [RegExp, ProductionTarget][] = [
  [/((?:^|[^a-z0-9])kicks?(?:[^a-z0-9]|$))|kopák/i, "kick"],
  [/((?:^|[^a-z0-9])snares?(?:[^a-z0-9]|$))|claps?|ženír/i, "snare"],
  [/hi-?hats?|((?:^|[^a-z0-9])hats?(?:[^a-z0-9]|$))|činel/i, "hats"],
  // SK prefix + full inflections: "bicie/bicím/bubny" — the strict \bbicíc
  // form silently dropped every post-noun SK drums row at corpus time
  [/\bdrums?\b|\bbic|\bbubny\b/i, "drums"],
  [/\bbass\b|\b808\b|\bsub\b|\bbas(?:a|u|y|i|ou|ov|om)?\b/i, "bass"],
  [/\blead\b|\bsynth\b|\bsynt\u00e9z/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
];

/**
 * True when the text explicitly names a production target track family
 * ("the drums", "the bass", …). The unified router uses this to give a
 * TARGETED production intent precedence over the global mix profile —
 * "make the drums darker" names where, so the change lands on the drums
 * track, not on the master tilt.
 */
export function namesProductionTarget(text: string): boolean {
  return TARGET_PATTERNS.some(([re]) => re.test(text));
}

/** Default amount when the text carries no degree word at all. */
const DEFAULT_AMOUNT = 0.7;

/**
 * Degree ladder - ENGLISH FIRST, Slovak secondary. The old two-step
 * (slightly=0.45 / much=0.9 / else=0.7) made "make it a touch deeper" and
 * "make it deeper" resolve to the SAME number, so the engine could not tell
 * a polite ask from a hard one. The ladder gives each adverb its own step.
 *
 * Order matters: scanned top to bottom, FIRST match wins, strongest first.
 * "a bit too much" therefore reads as "a bit" rather than "much" - the
 * attenuator nearer the verb wins, which matches how people actually speak
 * ("make it slightly too punchy").
 */
const DEGREE_LADDER: readonly (readonly [RegExp, number])[] = [
  // --- strongest ---
  [/\b(?:max(?:imal|imum)?|fully|totally|completely|maximálne|naplno|úplne)\b/, 0.95],
  [/\b(?:much|way|a lot|lots|heavily|hard|strongly|ve\u013emi|mocno|poriadne|silne|dos\u0165)\b/, 0.85],
  // --- strong-ish ---
  [/\b(?:quite|pretty|notably|substantially|significantly|noticeably|značne|vyrazne)\b/, 0.7],
  // --- the default band ---
  [/\b(?:somewhat|fairly|moderately|reasonably|rather|stredne|primerane|pomerne)\b/, 0.55],
  // --- attenuated ---
  [/\b(?:slightly|a bit|a little|a touch|a tad|trochu|mierne|jemne|napútok)\b/, 0.35],
  [/\b(?:barely|hardly|scarcely|minimally|takmer|minimálne)\b/, 0.2],
];

/**
 * Numeric degree - "by one", "by two", "by half". A count is a far more
 * precise ask than an adverb, so it is checked FIRST and wins:
 *
 *   1 -> 0.4 / 2 -> 0.5 / 3 -> 0.62 / 4+ or half -> 0.7
 *
 * so "by one" lands BELOW the untouched 0.7 default and "by four" reaches
 * it. That keeps the raw phrase and the ladder in agreement instead of
 * having a numeric ask read as "no degree at all".
 */
const NUMERIC_DEGREE: readonly (readonly [RegExp, number])[] = [
  [/\bby\s+(?:four|4)\b|\b(?:four|4)\s+notches?\b|\bo\s+(?:styri|4)\b|\bby\s+half\b/i, 0.7],
  [/\bby\s+(?:three|3)\b|\b(?:three|3)\s+notches?\b|\bo\s+(?:tri|3)\b/i, 0.62],
  [/\bby\s+(?:two|2)\b|\b(?:two|2)\s+notches?\b|\bo\s+(?:dve|dva|2)\b/i, 0.5],
  [/\bby\s+(?:one|1|a\s+single)\b|\b(?:one|1)\s+notch\b|\bo\s+(?:jednu|jedna|jedno|1)\b/i, 0.4],
];

/**
 * Resolve the 0..1 amount for ONE goal.
 *
 * Scoped to a window AROUND the matched concept so a degree word in a
 * neighbouring clause does not scale a concept it was never near ("make the
 * drums punchy and the bass slightly deeper" - the "slightly" belongs to
 * the bass, not to the drums). Without this, every goal in a multi-concept
 * request inherited the same single global amount, which is what made
 * "slightly deeper bass, much punchier drums" impossible to express.
 */
function detectAmount(text: string, conceptIndex: number, conceptLength: number): number {
  const start = Math.max(0, conceptIndex - 48);
  const end = Math.min(text.length, conceptIndex + conceptLength + 48);
  const window = text.slice(start, end);
  // Treat a softener before "too much" as one phrase, not as two competing
  // degree tokens; otherwise the nearer "much" masks the user's attenuation.
  if (/\b(?:slightly|a bit|a little|a touch|a tad|trochu|mierne|jemne|napútok)\s+too\s+much\b/.test(window)) {
    return 0.35;
  }

  // NEAREST match wins, not strongest. Scanning the ladder strongest-first
  // meant "make it a bit too much deeper" resolved to 0.85 because "much"
  // outranked "a bit" even though "a bit" sat closer to the ask. People
  // write the qualifier nearest the verb, so the window is scanned for
  // every degree word and the one with the smallest distance to the concept
  // decides. Ties break toward the STRONGER word, so "deeper, much" and
  // "much, deeper" agree.
  const best: { current: { amount: number; distance: number } | null } = { current: null };
  const conceptStart = conceptIndex - start;
  const conceptEnd = conceptStart + conceptLength;
  const consider = (re: RegExp, amount: number) => {
    const hit = re.exec(window);
    if (!hit) return;
    const hitEnd = hit.index + hit[0].length;
    const distance =
      hitEnd < conceptStart ? conceptStart - hitEnd : hit.index > conceptEnd ? hit.index - conceptEnd : 0;
    const current = best.current;
    if (!current || distance < current.distance || (distance === current.distance && amount > current.amount)) {
      best.current = { amount, distance };
    }
  };
  // Numeric first only as a TIE-break preference, not a hard override: a
  // bare "by one" sitting far from the concept should still lose to a
  // "slightly" pressed right against it.
  for (const [re, amount] of DEGREE_LADDER) consider(re, amount);
  for (const [re, amount] of NUMERIC_DEGREE) consider(re, amount);
  return best.current ? best.current.amount : DEFAULT_AMOUNT;
}

/**
 * Parse a production intent from free text. Returns null when the text is a
 * generation intent (no comparative/imperative production phrase matched) —
 * the caller then falls back to the pattern-generation pipeline.
 */
/**
 * Clause boundaries. A comma, semicolon, "and", or sentence break separates
 * two independent asks, so "punchier drums, deeper bass" can name a
 * different target (and a different degree) on each side. English markers
 * first, Slovak equivalents alongside.
 */
const CLAUSE_BREAK =
  /[;,!?]|(?<!\d)\.(?!\d)|\b(?:and|then|also|while|but|plus)\b|\b(?:taky|ale|tiež|tom|alebo)\b|\ba\b(?!\s+(?:bit|lot|little|touch|tad|single)\b)/gi;

/** Targets named inside one clause, in order of first appearance. */
function targetsInClause(clause: string): ProductionTarget[] {
  const out: ProductionTarget[] = [];
  for (const [re, target] of TARGET_PATTERNS) {
    if (re.test(clause) && !out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * Which target serves THIS concept. Preference order:
 *
 *   1. A target named in the SAME clause as the concept match. This is the
 *      "level 2" behaviour: "add a filter to the bass", "punchier drums,
 *      deeper bass" each land on the track they actually named instead of
 *      every concept piling onto whichever track happened to be detected
 *      first in the whole string.
 *   2. The concept's own natural home (ConceptDef.defaultTarget) when the
 *      clause named nothing.
 *   3. A target named anywhere in the request, as a last resort for a
 *      clause-scoped miss.
 *
 * Step 1 is what makes per-clause targeting real: without it the parser
 * collected targets globally, so a two-clause request applied BOTH concepts
 * to the SAME track and the second ask silently overwrote the first.
 */
function targetForConcept(
  clause: string,
  def: ConceptDef,
  globalTargets: readonly ProductionTarget[],
): ProductionTarget | undefined {
  const local = targetsInClause(clause);
  if (local.length) return local[0];
  if (globalTargets.length) return globalTargets[0];
  return def.defaultTarget;
}

export function parseProductionIntent(text: string): ProductionIntent | null {
  const lower = text.toLowerCase();
  const goals: ProductionGoal[] = [];
  // Per-clause target index: the clause each concept was matched in, so a
  // two-clause request can aim its halves at two different tracks.
  const clauseOfConcept: string[] = [];

  // Split ONCE and reuse: splitting per concept would disagree about
  // boundaries and could put the same match in two different clauses.
  const clauses = lower.split(CLAUSE_BREAK).filter((part) => part.trim().length > 0);
  const searchClauses = clauses.length ? clauses : [lower];

  for (const def of CONCEPTS) {
    let matched = false;
    for (const clause of searchClauses) {
      for (const re of def.patterns) {
        const hit = re.exec(clause);
        if (!hit) continue;
        const goal: ProductionGoal = { concept: def.concept, amount: detectAmount(clause, hit.index, hit[0].length) };
        // Surgical notch: extract the explicit frequency from the clause
        // ("notch at 347 Hz", "rezonancia na 1.2k", "vypichni 2.2k").
        if (def.concept === "notch") {
          const hzM = /([\d.]+)\s*(?:hz|k)\b/.exec(clause) || /(\d{2,5})\b\s*(?:hz)?/.exec(clause);
          if (hzM) {
            const raw = Number(hzM[1]);
            goal.targetHz = hzM[0].includes("k") && raw <= 20 ? raw * 1000 : raw;
          }
        }
        goals.push(goal);
        clauseOfConcept.push(clause);
        matched = true;
        break;
      }
      if (matched) break;
    }
  }
  if (goals.length === 0) return null;

  // Every target named anywhere, for the last-resort branch above.
  const globalTargets: ProductionTarget[] = targetsInClause(lower);

  const targets: ProductionTarget[] = [];
  for (const [index, goal] of goals.entries()) {
    const def = CONCEPTS.find((c) => c.concept === goal.concept)!;
    const target = targetForConcept(clauseOfConcept[index], def, globalTargets);
    if (target && !targets.includes(target)) targets.push(target);
  }

  // ELEMENT-LEVEL targets: pad families ride along separately so the
  // planner can add per-pad adjustments on top of the track FX.
  const padTargets = targets.filter(
    (target): target is "kick" | "snare" | "hats" => target === "kick" || target === "snare" || target === "hats",
  );

  return { targets, goals, sourceText: text, padTargets: padTargets.length > 0 ? padTargets : undefined };
}

/**
 * Resolve targets to concrete track ids. Throws with an actionable message
 * when a named target has no matching track — production intents must fail
 * clearly rather than silently doing nothing (master doc §17.12).
 */
export function resolveProductionTargets(doc: ProjectDocument, targets: ProductionTarget[]): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    if (target === "mix") {
      // The model has no master FX rack — a "whole mix" ask (surgical notch,
      // glue) is realized per-lane: one device per non-group track, all in
      // the caller's single undo step.
      ids.push(...doc.tracks.filter((t) => t.kind !== "group").map((t) => t.id));
      continue;
    }
    if (target === "drums" || target === "kick" || target === "snare" || target === "hats") {
      // Pad-family targets land on the drum track too — the per-pad part
      // rides in the planner result's padAdjustments field, the track FX
      // apply normally.
      const drum = doc.tracks.find((t) => t.kind === "drum");
      if (drum) ids.push(drum.id);
      continue;
    }
    const instruments = doc.tracks.filter((t) => t.kind === "instrument");
    // STRICT resolution — no positional fallback. The old `?? instruments[0]`
    // for "lead" used to route lead-named asks (fader/effect/production/
    // transpose) onto whatever instrument happened to be first (usually the
    // bass): a silent wrong-target mutation. Unmatched targets now surface
    // through the planner's actionable "No matching track for targets" error.
    const match = instruments.find((t) => {
      if (target === "bass") {
        return ["bass", "808", "logdrum"].includes(t.instrument) || /\bbass\b|\b808\b|\bsub\b/i.test(t.name);
      }
      if (target === "chords") {
        return /\bchord|\bkeys?\b|\bpad\b/i.test(t.name) || t.instrument === "keys";
      }
      return /\blead\b|\bsynth\b|\bpluck\b/i.test(t.name) || ["lead", "pluck", "spectral"].includes(t.instrument);
    });
    if (match) ids.push(match.id);
  }
  return [...new Set(ids)];
}

/**
 * Deterministic planner: concept × target → concrete effect operations.
 * Folded over effect DEFAULTS (never raw guesses) with the goal amount
 * scaling the primary parameter. One mechanism per concept in v1 — the
 * planner stays explainable (master doc §15 keeps multi-candidate ranking
 * for later phases).
 */
export function planProductionActions(
  doc: ProjectDocument,
  intent: ProductionIntent,
): {
  actions: ProductionAction[];
  padAdjustments?: Array<{ family: "kicks" | "snares" | "hats"; factor: number }>;
  plan: ProductionPlan;
} {
  const trackIds = resolveProductionTargets(doc, intent.targets);
  if (trackIds.length === 0) {
    throw new Error(
      `No matching track for targets: ${intent.targets.join(", ")} — add the track first or name another target`,
    );
  }
  const actions: ProductionAction[] = [];
  for (const trackId of trackIds) {
    for (const goal of intent.goals) {
      switch (goal.concept) {
        case "deeper":
          actions.push({
            trackId,
            type: "pitchShift",
            params: { semitones: -Math.round(2 + goal.amount * 5), grainMs: 65, mix: 1 },
          });
          break;
        case "punchier":
          actions.push({
            trackId,
            type: "transient",
            params: { attack: Math.min(1, 0.25 + goal.amount * 0.6), sustain: -0.5 * goal.amount, mix: 1 },
          });
          break;
        case "warmer":
          actions.push({
            trackId,
            type: "tapeSat",
            params: {
              drive: Math.min(1, 0.2 + goal.amount * 0.5),
              tone: Math.round(6500 - goal.amount * 2500),
              mix: 1,
            },
          });
          break;
        case "darker":
          actions.push({
            trackId,
            type: "svFilter",
            params: { cutoff: Math.round(16000 / Math.pow(10, goal.amount * 1.2)), mode: 0, mix: 1 },
          });
          break;
        case "brighter":
          actions.push({
            trackId,
            type: "svFilter",
            params: { mode: 3, cutoff: Math.round(120 + goal.amount * 260), mix: 1 },
          });
          break;
        case "wider":
          actions.push({
            trackId,
            type: "haasWidener",
            params: { width: Math.min(1, 0.25 + goal.amount * 0.6), delayMs: 14 },
          });
          break;
        case "grittier":
          actions.push({
            trackId,
            type: "distortion",
            params: { drive: Math.min(1, 0.15 + goal.amount * 0.65), tone: 6000, mix: 1 },
          });
          break;
        case "glue":
          actions.push({
            trackId,
            type: "drumBuss",
            params: { compressor: Math.min(1, 0.25 + goal.amount * 0.45), drive: 0.25, mix: 1 },
          });
          break;
        case "lofi":
          actions.push({
            trackId,
            type: "vinyl",
            params: { amount: Math.min(1, 0.3 + goal.amount * 0.6), crackle: 0.5, wow: 0.5, year: 0.7, mix: 1 },
          });
          break;
        case "wobbly":
          actions.push({
            trackId,
            type: "beatMangler",
            params: { playMode: 0, repeatFill: 4, mix: 1 },
            volumeSteps: [1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55],
            pitchSteps: [0, 0, 12, 0, 0, -12, 0, 0, 0, 0, 12, 0, -12, 0, 0, 0],
          });
          break;
        case "robotic":
          actions.push({
            trackId,
            type: "ringMod",
            params: { frequency: 95, feedback: 0.4, mix: 0.9 },
          });
          break;
        case "metallic":
          actions.push({
            trackId,
            type: "freqShifter",
            params: { shift: Math.round(300 + goal.amount * 500), mix: 0.9 },
          });
          break;
        case "deess":
          // Compressor DE-ESS mode (band detector): amount scales ratio —
          // subtle ~3:1, full ~10:1. Threshold rides with amount so subtle
          // only catches the worst offenders.
          actions.push({
            trackId,
            type: "compressor",
            params: {
              scMode: 1,
              scBandHz: 6500,
              threshold: Math.round(-24 - goal.amount * 12),
              ratio: Math.round(3 + goal.amount * 7),
              attack: 0.001,
              release: 0.06,
              knee: 2,
              mix: 1,
            },
          });
          break;
        case "notch": {
          // EQ free surgical band as a deep notch: the intent parser or the
          // caller supplies the frequency via `goal.targetHz`; without it
          // the sweep defaults to 350 Hz (the classic boxy resonance).
          const notchHz = Math.max(30, Math.min(18000, goal.targetHz ?? 350));
          const notchQ = 4 + goal.amount * 12;
          actions.push({
            trackId,
            type: "eq",
            params: {
              free1Type: 1, // notch
              free1Freq: Math.round(notchHz),
              free1Q: Math.round(notchQ * 10) / 10,
              free1Gain: -24,
            },
          });
          break;
        }
        case "telephone":
          // The handset chain: narrow band-pass + the crackle drive —
          // two devices, one concept (the telephone preset recipe).
          actions.push({
            trackId,
            type: "svFilter",
            params: { cutoff: Math.round(1000 + goal.amount * 700), mode: 1, mix: 1 },
          });
          actions.push({
            trackId,
            type: "distortion",
            params: { drive: Math.min(1, 0.25 + goal.amount * 0.3), tone: 5200, mix: 1 },
          });
          break;
        case "tape":
          // Heavier than "warmer" — full tape saturation, tone pulled down.
          actions.push({
            trackId,
            type: "tapeSat",
            params: {
              drive: Math.min(1, 0.45 + goal.amount * 0.4),
              tone: Math.round(5200 - goal.amount * 1500),
              mix: 1,
            },
          });
          break;
        // ---- Level 3 device asks. Params are CANONICAL ids verified
        // against src/effects/definitions.ts — normalizeEffects drops any
        // key that is not in the effect's own ParamDef list, so an id
        // that looks right but is not whitelisted would make the whole
        // action silent.
        case "filter":
          // svFilter mode 2 is the band-pass sweep family; cutoff lands
          // between a musical 400 Hz and a sub-audible 80 Hz so the
          // amount reads as sweep depth, not as a static filter.
          actions.push({
            trackId,
            type: "svFilter",
            params: {
              mode: 2,
              cutoff: Math.round(900 / Math.pow(10, goal.amount * 0.7)),
              resonance: Math.min(1, 0.3 + goal.amount * 0.5),
              mix: Math.min(1, 0.4 + goal.amount * 0.5),
            },
          });
          break;
        case "sidechain":
          // The PUMP effect, not the raw sidechain compressor: pump is the
          // one already keyed from the drum track by the registry, and its
          // amount / rate / release map 1:1 onto the ask with no invented
          // fields. The sidechain compressor's amount is a blend of a
          // threshold+ratio reduction, which is not what "pumping" means.
          actions.push({
            trackId,
            type: "pump",
            params: {
              amount: Math.min(1, 0.4 + goal.amount * 0.6),
              rate: Math.round(0.4 + goal.amount * 1.6),
              release: Math.round(120 + goal.amount * 220),
            },
          });
          break;
        case "phaser":
          actions.push({
            trackId,
            type: "phaser",
            params: {
              rate: Math.round(0.15 + goal.amount * 0.6),
              depth: Math.min(1, 0.4 + goal.amount * 0.5),
              center: 800,
              feedback: Math.min(0.9, goal.amount * 0.45),
              stages: 4,
              mix: Math.min(1, 0.5 + goal.amount * 0.45),
            },
          });
          break;
        case "chorus":
          actions.push({
            trackId,
            type: "chorus",
            params: {
              rate: Math.round(0.2 + goal.amount * 0.5),
              depth: Math.min(1, 0.3 + goal.amount * 0.5),
              base: 12,
              spread: Math.min(1, 0.4 + goal.amount * 0.5),
              voices: 3,
              mix: Math.min(1, 0.4 + goal.amount * 0.5),
            },
          });
          break;
        case "sharper":
          // Transpose ask: semitones is the primary and the amount
          // scales it, so "sharper" nudges +2 and "much sharper" +7.
          actions.push({
            trackId,
            type: "pitchShift",
            params: {
              semitones: Math.round(1 + goal.amount * 6),
              fine: 0,
              grainMs: 55,
              width: 0.2,
              mix: 1,
            },
          });
          break;
        case "reverse":
          actions.push({
            trackId,
            type: "reverseSwell",
            params: {
              engaged: 1,
              time: Math.round(0.4 + goal.amount * 2.4),
              reach: Math.min(1, 0.5 + goal.amount * 0.5),
              curve: 2,
              tone: 4200,
              level: Math.min(1, 0.4 + goal.amount * 0.5),
              mix: 1,
            },
          });
          break;
        case "crunchy":
          // bits is DESCENDING: fewer bits = crunchier, so the amount
          // maps straight onto the bit count and the range is kept off
          // 1 (a true 1-bit crush is a square wave, not a usable loop).
          actions.push({
            trackId,
            type: "bitcrusher",
            params: {
              bits: Math.max(3, Math.round(12 - goal.amount * 7)),
              downsample: Math.max(1, Math.round(2 + goal.amount * 6)),
              drive: Math.min(1, 0.1 + goal.amount * 0.5),
              tone: 6000,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "vinyl":
          // The DEVICE ask, distinct from the "lofi" tone concept which
          // already owns the bare word: crackle and wow/flutter are the
          // two things a user names when they mean the device.
          actions.push({
            trackId,
            type: "vinyl",
            params: {
              amount: Math.min(1, 0.3 + goal.amount * 0.6),
              crackle: Math.min(1, 0.3 + goal.amount * 0.6),
              hiss: Math.min(1, goal.amount * 0.5),
              wow: Math.min(1, goal.amount * 0.6),
              flutter: Math.min(1, goal.amount * 0.45),
              rumble: Math.min(1, goal.amount * 0.4),
              year: 0.7,
              toneLp: 9000,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "wide":
          // haasWidener with crossfeed for a genuinely wide image
          // rather than the "wider" concept's single-stage Haas.
          actions.push({
            trackId,
            type: "haasWidener",
            params: {
              delayMs: 18,
              width: Math.min(1, 0.45 + goal.amount * 0.55),
              crossfeed: Math.min(0.5, goal.amount * 0.4),
              feedback: 0,
            },
          });
          break;
        case "sub":
          // bassBuss subEnhance is the dedicated sub driver; a plain
          // lowShelf would lift the mud along with the sub.
          actions.push({
            trackId,
            type: "bassBuss",
            params: {
              subEnhance: Math.min(1, 0.3 + goal.amount * 0.6),
              subOsc: 0,
              subFrequency: 42,
              drive: 0,
              compression: 0.2,
              monoBassFrequency: 110,
              mix: Math.min(1, 0.5 + goal.amount * 0.5),
            },
          });
          break;
        case "air":
          // highShelfGain is the air band; an EQ lowShelf is NOT a
          // substitute because it moves energy the user did not ask for.
          actions.push({
            trackId,
            type: "eq",
            params: {
              highShelfFreq: 11000,
              highShelfGain: Math.round(2 + goal.amount * 6),
              highMidFreq: 3000,
              highMidGain: Math.round(1 + goal.amount * 3),
            },
          });
          break;
        case "stutter":
          // Tighter divisions with more intent amount; feedback stays dry.
          actions.push({
            trackId,
            type: "stutter",
            params: {
              division: goal.amount >= 0.75 ? 5 : 4,
              mix: Math.min(1, 0.6 + goal.amount * 0.3),
              feedback: 0,
            },
          });
          break;
      }
    }
  }
  // ELEMENT-LEVEL: pad families named in the intent get per-pad gain
  // adjustments scaled by the concepts aimed at them — on top of the
  // track FX actions above.
  const FAMILY_ALIAS: Record<"kick" | "snare" | "hats", "kicks" | "snares" | "hats"> = {
    kick: "kicks",
    snare: "snares",
    hats: "hats",
  };
  const padAdjustments = (intent.padTargets ?? []).map((family) => {
    const factor = intent.goals.reduce((product, goal) => {
      const per = PAD_CONCEPT_FACTOR[goal.concept] ?? 1.1;
      return product * (1.0 + (per - 1.0) * goal.amount);
    }, 1.0);
    return { family: FAMILY_ALIAS[family], factor: Math.round(factor * 100) / 100 };
  });

  const summary = intent.goals.map((g) => `${g.concept} ×${g.amount.toFixed(2)}`).join(", ");
  return {
    actions,
    padAdjustments: (intent.padTargets ?? []).length > 0 ? padAdjustments : undefined,
    plan: {
      label: `Production: ${intent.targets.join("+")} → ${intent.goals.map((g) => g.concept).join(", ")}`,
      summary: `${summary} on ${trackIds.length} track(s)`,
      actions,
    },
  };
}

/** Stable display hash for provenance (intent text + goals). */
export function productionIntentHash(intent: ProductionIntent): string {
  return hashString(`${intent.sourceText}|${intent.goals.map((g) => `${g.concept}:${g.amount}`).join("|")}`).toString(
    36,
  );
}

/**
 * Sanitize untrusted fx data (normalized intents carry it through share
 * codes, song builds and candidate plans). Returns null unless the shape is
 * a valid ProductionIntent with known concepts/targets — an invalid fx field
 * must never reject the whole intent.
 */
export function sanitizeFxIntent(raw: unknown): ProductionIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.targets) || !Array.isArray(r.goals)) return null;
  const targets = [...new Set(r.targets.filter((t): t is ProductionTarget => PRODUCTION_TARGETS.includes(t as never)))];
  const goals: ProductionGoal[] = [];
  for (const goal of r.goals) {
    if (typeof goal !== "object" || goal === null) continue;
    const g = goal as Record<string, unknown>;
    if (typeof g.concept !== "string" || !PRODUCTION_CONCEPTS.includes(g.concept as never)) continue;
    const amount =
      typeof g.amount === "number" && Number.isFinite(g.amount) ? Math.min(1, Math.max(0, g.amount)) : DEFAULT_AMOUNT;
    goals.push({ concept: g.concept as ProductionConcept, amount });
  }
  if (goals.length === 0) return null;
  return {
    targets,
    goals,
    sourceText: typeof r.sourceText === "string" ? r.sourceText.slice(0, 500) : "",
  };
}

/**
 * VERIFICATION READ-BACK — confirm the planned DSP actually landed: for each
 * planned action, the effect instance must exist on the track in the
 * post-execution document and the first planned param reads back with its
 * real (clamped) value. A missing instance reports ✗ instead of pretending.
 */
export function productionReadback(before: ProjectDocument, after: ProjectDocument, intent: ProductionIntent): string {
  try {
    const { plan } = planProductionActions(before, intent);
    const fmt = (value: number): number => Math.round(value * 100) / 100;
    const entries: string[] = [];
    for (const action of plan.actions.slice(0, 3)) {
      const track = after.tracks.find((candidate) => candidate.id === action.trackId);
      const fx = track?.effects.find((effect) => effect.type === action.type);
      if (!track || !fx) {
        entries.push(`${action.type} ✗`);
        continue;
      }
      const firstParam = Object.entries(action.params)[0];
      if (!firstParam) {
        entries.push(`${action.type} ✓ ${track.name}`);
        continue;
      }
      entries.push(`${action.type} ${firstParam[0]}=${fmt(fx.params[firstParam[0]] ?? 0)} ${track.name}`);
    }
    return entries.join(", ");
  } catch {
    return ""; // re-planning against a changed doc — stay silent, the label stands
  }
}
