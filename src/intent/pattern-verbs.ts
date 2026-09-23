/**
 * PATTERN-DIFF VERBS (vibe-code wave 1): the words that EDIT the pattern
 * you're hearing — "fewer hats", "menej hi-hatov", "denser snare", "add
 * ghosts", "simplify", "swing it" — instead of reaching for the grid.
 *
 * Parser: EN + SK (de-accented matching, like route.ts). Targets resolve to
 * classifyPads families; no family named + a pattern word ("beat/drums")
 * means ALL pads; thin/densify without any target return null (too
 * destructive to guess).
 *
 * Ops are DETERMINISTIC given (text, seed): the rng derives from the seed +
 * the verb signature, so the same sentence re-applied to the same pattern
 * produces the same edit. Swing is the exception — it's a groove setting,
 * not rows, and it composes (current + 0.12, clamped).
 */
import type { DrumPad, Pattern } from "../project-model/types";
import { classifyPads } from "../assist/patternOps";

export type PatternVerbKind = "thin" | "densify" | "ghosts" | "simplify" | "swing";
export type VerbFamily = "kicks" | "snares" | "hats" | "others" | "all";

export interface PatternVerb {
  kind: PatternVerbKind;
  family: VerbFamily;
}

export interface PatternVerbsParse {
  verbs: PatternVerb[];
  /** The matched phrases — echoed in the status line. */
  detected: string[];
}

/** De-accent + lowercase, matching route.ts conventions. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const VERB_WORDS: ReadonlyArray<readonly [RegExp, PatternVerbKind]> = [
  [/\bghosts?\b|\bghost (?:notes?|hits?)\b|\bghosty\b/, "ghosts"],
  [/\bsimpl(?:er|ify|ify it)\b|\bzjednodus(?:it)?\b|\bjednoduchsi\b/, "simplify"],
  [/\bswing(?: it|y)?\b|\bhojdat\b|\bojdat\b|\bswingova(t|c)\b/, "swing"],
  [/\bfewer\b|\bless\b|\bthin(?:ner| out)?\b|\btoner\b|\bmenej\b|\bredi(?:t|s)\b|\bsubtlejsi\b/, "thin"],
  [/\bdenser\b|\busier\b|\bmore (?:hits|notes|stuff)\b|\bhustej(?:si)?\b|\bviac\b|\bpridaj\b|\bplnejsi\b/, "densify"],
];

const FAMILY_WORDS: ReadonlyArray<readonly [RegExp, VerbFamily]> = [
  [/\bhi[ -]?ha(?:t|ty|tov|te|om)?\b|\bhats?\b|\bhaty\b|\bcymbals?\b|\brids?\b|\bcrash\b|\bciinel\b/, "hats"],
  [/\bsnares?\b|\bsnar\b|\bclaps?\b|\bclapy\b|\brims?\b|\bvenier\b|\bveníky\b/, "snares"],
  [/\bkicks?\b|\bkick drum\b|\bbass drum\b|\bkop(?:ak|áka|ák)\b/, "kicks"],
  [/\bpercs?\b|\bpercussion\b|\bshakers?\b/, "others"],
  [/\bbeats?\b|\bpatterns?\b|\bdrums?\b|\bbic\b|\bbicie\b|\ball\b|\bcely\b/, "all"],
];

/**
 * Parse pattern-diff verbs from free text. Returns null when no verb fires
 * (the caller falls through to generation/production).
 */
export function parsePatternVerbs(text: string): PatternVerbsParse | null {
  const folded = ` ${fold(text).replace(/[\s,.]+/g, " ").trim()} `;
  const verbs: PatternVerb[] = [];
  const detected: string[] = [];

  for (const [pattern, kind] of VERB_WORDS) {
    const match = folded.match(pattern);
    if (!match) continue;
    detected.push(match[0].trim());
    // Swing is grid-wide; ghosts and simplify spread sensibly. Thin/densify
    // need a family — resolve the NEAREST family word after the verb, then
    // anywhere in the sentence; unresolvable thin/densify are skipped (too
    // destructive to guess).
    if (kind === "swing") {
      verbs.push({ kind, family: "all" });
      continue;
    }
    const tail = folded.slice(folded.indexOf(match[0].toLowerCase()) + match[0].length);
    let family: VerbFamily | null = null;
    for (const [familyPattern, key] of FAMILY_WORDS) {
      const fm = tail.match(familyPattern);
      const headMatch = fold(text).slice(0, folded.indexOf(match[0].toLowerCase())).match(familyPattern);
      if (fm) {
        family = key;
        break;
      }
      if (headMatch && family === null) family = key;
    }
    if (kind === "ghosts" || kind === "simplify") {
      verbs.push({ kind, family: family ?? "all" });
    } else if (family) {
      verbs.push({ kind, family });
    }
  }

  if (verbs.length === 0) return null;
  // Dedupe (kind, family) — "fewer hats, fewer hats" is one op.
  const seen = new Set<string>();
  const unique = verbs.filter((verb) => {
    const key = `${verb.kind}:${verb.family}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { verbs: unique, detected };
}

/** Pads of the family, or every pad for "all". */
export function padsForFamily(pads: DrumPad[], family: VerbFamily): DrumPad[] {
  if (family === "all") return pads;
  const fams = classifyPads(pads);
  return fams[family];
}

/**
 * Deterministic RNG seeded by (seed, applied verb signature) — the same
 * sentence re-applied to the same pattern produces the same edit.
 */
function verbRng(seed: string, verbs: PatternVerb[]): () => number {
  const sig = `${seed}|${verbs.map((v) => `${v.kind}:${v.family}`).join(",")}`;
  let h = 2166136261;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Apply the parsed verbs to a pattern's rows (pure — returns the new rows).
 * Thin keeps downbeat anchors and never empties a row entirely; ghosts add
 * quiet off-beat hits; simplify removes whisper-velocity steps first.
 */
export function applyVerbRows(
  pattern: Pattern,
  pads: DrumPad[],
  verbs: PatternVerb[],
  seed: string,
): { rows: Record<string, number[]>; grooveSwingDelta: number } {
  const rng = verbRng(seed, verbs);
  const rows: Record<string, number[]> = {};
  for (const pad of pads) {
    const row = pattern.rows[pad.id];
    if (row) rows[pad.id] = [...row];
  }
  let grooveSwingDelta = 0;

  for (const verb of verbs) {
    const familyPads = padsForFamily(pads, verb.family);
    for (const pad of familyPads) {
      const row = rows[pad.id];
      if (!row) continue;
      const hits = row.filter((v) => v > 0).length;
      for (let step = 0; step < row.length; step++) {
        const isDownbeat = step % 16 === 0;
        const isOffBeat = step % 4 !== 0;
        switch (verb.kind) {
          case "thin":
            if (row[step] > 0 && !isDownbeat && hits > 1 && rng() < 0.45) {
              row[step] = 0;
            }
            break;
          case "densify":
            if (!(row[step] > 0) && rng() < 0.32) row[step] = 0.55 + rng() * 0.25;
            break;
          case "ghosts":
            if (!(row[step] > 0) && isOffBeat && rng() < 0.4) row[step] = 0.14 + rng() * 0.14;
            break;
          case "simplify":
            if (row[step] > 0 && row[step] < 0.4 && rng() < 0.7) row[step] = 0;
            else if (row[step] > 0 && !isDownbeat && hits > 1 && rng() < 0.2) row[step] = 0;
            break;
          case "swing":
            // handled at groove level below
            break;
        }
      }
      // Never leave a family row entirely empty — keep the first original hit.
      if (verb.family !== "all" && !row.some((v) => v > 0)) {
        const original = (pattern.rows[pad.id] ?? []) as number[];
        const firstHit = original.findIndex((v) => v > 0);
        if (firstHit >= 0) row[firstHit] = original[firstHit];
      }
    }
    if (verb.kind === "swing") grooveSwingDelta += 0.12;
  }
  return { rows, grooveSwingDelta };
}
