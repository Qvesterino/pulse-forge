import type { IntentInput, IntentRole } from "./types";
import type { IntentGenre } from "./types";

/**
 * Natural language → IntentInput parser (goal: "dark rolling techno at 140
 * in F# minor with a lead, 8 bars").
 *
 * Deterministic phrase matching — no AI, no network, no RNG. The user types
 * a description; the parser extracts genre, style, energy, density, complexity,
 * variation, mood, BPM (single or range), musical key, length and roles.
 * Anything not recognised falls back to normalizeIntent defaults.
 *
 * v2 (EN): phrase-aware matching over the full text (word boundaries, so
 * multi-word styles and "no drums" work), BPM ranges, key detection with
 * enharmonic flats, bar-count length, and a style vocabulary that mirrors the
 * actual groove library (house/techno/trap/ambient/hybrid styles).
 */

/** Genre keyword → IntentGenre mapping. More specific genres win by list order. */
const GENRE_PHRASES: ReadonlyArray<readonly [RegExp, IntentGenre]> = [
  [/\bdeep house\b/, "house"],
  [/\btech house\b/, "house"],
  [/\bfrench house\b/, "house"],
  [/\bbig room\b/, "house"],
  [/\bhouse\b/, "house"],
  [/\bdeep\b/, "house"],
  [/\bgarage\b|\bukg\b|\buk garage\b/, "house"],
  [/\bjersey\b/, "house"],
  [/\bafro\b|\bafrobeat\b|\bafro house\b/, "house"],
  [/\breggaeton\b/, "house"],
  [/\btechno\b/, "techno"],
  [/\btech\b/, "techno"],
  [/\bacid\b/, "techno"],
  [/\bindustrial\b/, "techno"],
  [/\bdub techno\b|\bdubtech\b|\bdub\b/, "techno"],
  [/\bhardcore\b|\bgabber\b/, "techno"],
  [/\bdrill\b/, "techno"],
  [/\btrap\b/, "trap"],
  [/\bphonk\b/, "trap"],
  [/\bdrill beat\b/, "trap"],
  [/\bhip ?hop\b|\bboombap\b|\bboom bap\b/, "trap"],
  [/\bambient\b/, "ambient"],
  [/\blofi\b|\blo-?fi\b/, "ambient"],
  [/\bscore\b|\bscene\b|\bsoundscape\b|\bcinematic\b/, "ambient"],
];

/** Style phrases → canonical groove style names (resolveGroove expects these). */
const STYLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdriving\b|\bdrive\b/, "driving"],
  [/\bminimal\b/, "minimal"],
  [/\bfunky\b|\bfunk\b/, "funky"],
  [/\bdeep\b/, "deep"],
  [/\bukg\b|\buk garage\b|\bgarage\b/, "ukg"],
  [/\bafro\b/, "afro"],
  [/\bindustrial\b/, "industrial"],
  [/\bdub\b/, "dub"],
  [/\bacid\b/, "acid"],
  [/\bclassic\b|\btraditional\b/, "classic"],
  [/\brolling\b|\broll\b/, "rolling"],
  [/\bsparse\b/, "sparse"],
  [/\bbouncy\b|\bbounce\b/, "bouncy"],
  [/\bdrifting\b|\bdrift\b/, "drifting"],
  [/\bglitch\b|\bglitchy\b/, "glitch"],
  [/\borganic\b/, "organic"],
];

/** Character phrase → canonical mood (mapping.ts applies mood tweaks). */
const MOOD_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdark\b|\bmoody\b|\bmenacing\b|\beerie\b/, "dark"],
  [/\baggressive\b|\bhard\b|\bharsh\b|\bbrutal\b/, "aggressive"],
  [/\bchill\b|\bsoft\b|\bmellow\b|\brelaxed\b|\blaid back\b|\blaid-?back\b/, "chill"],
  [/\benergetic\b|\bbright\b|\buplifting\b|\beuphoric\b/, "energetic"],
];

/** Additional character phrases that only shape sliders (no mood tweaks). */
interface CharacterTrait {
  energy?: number;
  density?: number;
  complexity?: number;
  variation?: number;
}

const TRAIT_PHRASES: ReadonlyArray<readonly [RegExp, CharacterTrait]> = [
  [/\bwarm\b/, { energy: 0.5 }],
  [/\bcold\b|\bicy\b/, { energy: 0.35 }],
  [/\bsparse\b|\bminimal\b/, { density: 0.25, complexity: 0.25 }],
  [/\bbusy\b|\bdense\b/, { density: 0.8 }],
  [/\bsimple\b|\bstraightforward\b/, { complexity: 0.2 }],
  [/\bcomplex\b|\bintricate\b|\bdetailed\b/, { complexity: 0.8 }],
  [/\bhypnotic\b|\btrippy\b/, { variation: 0.2, complexity: 0.3 }],
  [/\bevolving\b|\bdynamic\b/, { variation: 0.8 }],
  [/\bpunchy\b/, { energy: 0.75, density: 0.6 }],
  [/\bsmooth\b|\bsilky\b/, { energy: 0.4, complexity: 0.35 }],
  [/\bheavy\b|\bweighty\b/, { energy: 0.85, density: 0.7 }],
  [/\blight\b|\bairy\b/, { energy: 0.35, density: 0.4 }],
  [/\btight\b/, { complexity: 0.4 }],
  [/\bwide\b|\bbig\b/, { complexity: 0.6 }],
  [/\bgroovy\b/, { variation: 0.6, energy: 0.7 }],
  [/\bfast\b/, { energy: 0.85 }],
  [/\bslow\b/, { energy: 0.3 }],
  // moods also nudge sliders so "dark" both tweaks mood AND lowers energy
  [/\bdark\b|\bmoody\b|\bmenacing\b|\beerie\b/, { energy: 0.3 }],
  [/\bchill\b|\brelaxed\b|\blaid back\b|\blaid-?back\b/, { energy: 0.3, density: 0.4 }],
  [/\baggressive\b|\bhard\b/, { energy: 0.9, density: 0.7 }],
  [/\benergetic\b|\beuphoric\b|\buplifting\b/, { energy: 0.95, density: 0.7 }],
  [/\bdriving\b/, { energy: 0.8, density: 0.7 }],
  [/\brolling\b/, { variation: 0.6 }],
  [/\bmelancholic\b|\bemotional\b/, { energy: 0.35, complexity: 0.5 }],
];

/** Role phrase → role flag. Matched against the full text. */
const ROLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bno drums\b|\bwithout drums\b|\bdrumless\b|\bdrum-?less\b/, "nodrums"],
  [/\bno bass\b|\bwithout bass\b|\bbassless\b/, "nobass"],
  [/\bdrums only\b|\bbeat only\b|\bpercussion only\b/, "drumsonly"],
  [/\bmelody only\b|\bno drums just melody\b/, "melodyonly"],
  [/\bfull beat\b|\beverything\b|\bfull arrangement\b/, "all"],
  [/\bdrums\b|\bthe beat\b|\bpercussion\b|\bkick\b/, "drums"],
  [/\bbass\b|\b808\b|\bsub\b/, "bass"],
  [/\bchords\b|\bpads\b|\bstabs\b|\bkeys\b/, "chords"],
  [/\blead\b|\bmelody\b|\barp\b|\barpeggio\b|\btopline\b|\btop line\b|\bsynth\b/, "lead"],
];

/** Note-name normalization for key parsing (flats → sharps). */
const NOTE_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/c#/, "C#"],
  [/db/, "C#"],
  [/d#/, "D#"],
  [/eb/, "D#"],
  [/e/, "E"],
  [/f#/, "F#"],
  [/gb/, "F#"],
  [/g#/, "G#"],
  [/ab/, "G#"],
  [/a#/, "A#"],
  [/bb/, "A#"],
  [/a/, "A"],
  [/b/, "B"],
  [/c/, "C"],
  [/d/, "D"],
  [/f/, "F"],
  [/g/, "G"],
];

const SCALE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bharmonic minor\b/, "Harmonic Minor"],
  [/\bmelodic minor\b/, "Melodic Minor"],
  [/\bnatural minor\b|\bminor\b|\baeolian\b/, "Natural Minor"],
  [/\bmajor\b|\bionian\b/, "Major"],
  [/\bdorian\b/, "Dorian"],
  [/\bphrygian\b/, "Phrygian"],
  [/\bmixolydian\b/, "Mixolydian"],
  [/\bpentatonic major\b/, "Pentatonic Major"],
  [/\bpentatonic minor\b|\bpentatonic\b/, "Pentatonic Minor"],
];

export interface ParsedIntent {
  input: IntentInput;
  /** Keywords/phrases recognised by the parser (for diagnostics/UI feedback). */
  detected: string[];
}

/** Find the first phrase (by list order = specificity) present in the text. */
function firstPhrase(phrases: ReadonlyArray<readonly [RegExp, string]>, text: string): string | null {
  for (const [re, value] of phrases) {
    if (re.test(text)) return value;
  }
  return null;
}

/** Parse "in f# minor" / "g major" / "db phrygian" into a MusicalKey string. */
export function parseKeyPhrase(text: string): string | null {
  const match = /\bin ([a-g](?:#|b)?)\s*([a-z ]+?)?\b(?=(?:\bwith\b|\bat\b|\bplus\b|\band\b|\b\d)|$)/.exec(text);
  const bare = /\b([a-g](?:#|b)?)\s+(harmonic minor|melodic minor|natural minor|dorian|phrygian|mixolydian|major|minor|pentatonic)\b/.exec(
    text,
  );
  const rootRaw = (match?.[1] ?? bare?.[1] ?? "").toLowerCase();
  if (!rootRaw) return null;
  let root: string | null = null;
  for (const [re, name] of NOTE_NAMES) {
    if (re.test(rootRaw)) {
      root = name;
      break;
    }
  }
  if (!root) return null;
  const scaleText = bare?.[2] ?? match?.[2] ?? "";
  const scale = firstPhrase(SCALE_PHRASES, scaleText.length > 0 ? ` ${scaleText} ` : " minor ");
  // No scale word → minor default: the overwhelmingly dominant mode for beats.
  return `${root} ${scale ?? "Natural Minor"}`;
}

/**
 * Parse natural language text into an IntentInput.
 * Pure function — same text → same result.
 */
export function parseIntentText(text: string): ParsedIntent {
  const lower = ` ${text.toLowerCase().replace(/[\s,.]+/g, " ").trim()} `;
  const detected: string[] = [];

  const input: IntentInput = {};

  // Genre detection (list order = specificity; first hit wins)
  const genre = firstPhrase(GENRE_PHRASES, lower);
  if (genre) {
    input.genre = genre as IntentGenre;
    detected.push(genre);
  }

  // Style detection — v1 rule preserved: an explicit style phrase wins, even
  // if the same word fed genre detection (e.g. "acid techno" → techno + acid).
  const style = firstPhrase(STYLE_PHRASES, lower);
  if (style) {
    input.style = style;
    detected.push(style);
  }

  // Mood — canonical value consumed by mapIntentToOptions tweaks.
  const mood = firstPhrase(MOOD_PHRASES, lower);
  if (mood) {
    input.mood = mood;
    detected.push(mood);
  }

  // Character traits — later matches overwrite earlier ones, list order is
  // therefore part of the contract.
  const trait: CharacterTrait = {};
  for (const [re, t] of TRAIT_PHRASES) {
    if (re.test(lower)) {
      if (t.energy !== undefined) trait.energy = t.energy;
      if (t.density !== undefined) trait.density = t.density;
      if (t.complexity !== undefined) trait.complexity = t.complexity;
      if (t.variation !== undefined) trait.variation = t.variation;
    }
  }
  if (trait.energy !== undefined) input.energy = trait.energy;
  if (trait.density !== undefined) input.density = trait.density;
  if (trait.complexity !== undefined) input.complexity = trait.complexity;
  if (trait.variation !== undefined) input.variation = trait.variation;

  // BPM: "at 140", "140 bpm", "140-150 bpm", "between 138 and 145"
  const rangeMatch =
    /\b(\d{2,3})\s*(?:-|–|to|and)\s*(\d{2,3})\s*(?:bpm\b)?/.exec(lower) ??
    /\bbetween (\d{2,3}) and (\d{2,3})\b/.exec(lower);
  const singleMatch = /\b(?:at|around|about)\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/.exec(lower);
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (lo >= 40 && hi <= 240 && lo <= hi) {
      input.bpmRange = [lo, hi];
      detected.push(`${lo}-${hi}bpm`);
    }
  } else {
    const bpm = Number(singleMatch?.[1] ?? singleMatch?.[2]);
    if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 240) {
      input.bpmRange = [bpm, bpm];
      detected.push(`${bpm}bpm`);
    }
  }

  // Musical key — "in f# minor", "g major", "db phrygian"
  const key = parseKeyPhrase(lower);
  if (key) {
    input.key = key as IntentInput["key"];
    detected.push(key.toLowerCase());
  }

  // Length: "8 bars" / "16 bar" → steps (16 steps per bar), clamped by normalize
  const bars = /\b(\d{1,3})\s*bars?\b/.exec(lower);
  if (bars) {
    const steps = Number(bars[1]) * 16;
    if (steps >= 16 && steps <= 256) {
      input.length = steps;
      detected.push(`${bars[1]}bars`);
    }
  }

  // Roles. Negation phrases precede positive ones in ROLE_PHRASES, so an
  // exclusion seen earlier also suppresses the later positive match ("no
  // drums" contains the word "drums").
  let noDrums = false;
  let noBass = false;
  const roles = new Set<IntentRole>();
  let hasRoleKeyword = false;
  for (const [re, flag] of ROLE_PHRASES) {
    if (!re.test(lower)) continue;
    hasRoleKeyword = true;
    if (flag === "nodrums") {
      noDrums = true;
      roles.delete("drums");
    } else if (flag === "nobass") {
      noBass = true;
      roles.delete("bass");
    } else if (flag === "drumsonly") {
      roles.clear();
      roles.add("drums");
    } else if (flag === "melodyonly") {
      roles.clear();
      roles.add("lead");
    } else if (flag === "all") {
      roles.add("drums");
      roles.add("bass");
      roles.add("chords");
      roles.add("lead");
    } else {
      if (flag === "drums" && noDrums) continue;
      if (flag === "bass" && noBass) continue;
      roles.add(flag as IntentRole);
    }
  }
  if (hasRoleKeyword) {
    const resolved = noDrums ? [...roles].filter((role) => role !== "drums") : [...roles];
    // "no drums" with nothing else named still means the remaining roles.
    input.roles =
      resolved.length > 0
        ? (resolved as IntentRole[])
        : noDrums
          ? (["bass", "chords", "lead"] as IntentRole[])
          : (["drums", "bass"] as IntentRole[]);
    if (noDrums) detected.push("no drums");
  }

  return { input, detected };
}
