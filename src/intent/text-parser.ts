import type { IntentInput, IntentRole } from "./types";
import type { IntentGenre } from "./types";

/**
 * Natural language → IntentInput parser (goal: "dark rolling techno at 140").
 *
 * Deterministic keyword matching — no AI, no network, no RNG. The user types
 * a description; the parser extracts genre, style, energy, density, complexity,
 * variation, BPM and roles. Anything not recognised falls back to defaults.
 *
 * This is the TEXT → INTENT bridge that makes the Intent Engine accessible
 * without inzenerké sliders — the "hlavný ťahák" of the product.
 */

/** Genre keyword → IntentGenre mapping. */
const GENRE_KEYWORDS: Record<string, IntentGenre> = {
  house: "house",
  deep: "house", // "deep house"
  techno: "techno",
  tech: "techno",
  trap: "trap",
  ambient: "ambient",
  drill: "techno", // drill is closest to techno tempo
  jersey: "house", // jersey club is house-adjacent
  phonk: "trap", // phonk is trap-adjacent
  reggaeton: "house",
  lofi: "ambient", // lo-fi is ambient-adjacent
  ukg: "house", // UK garage is house-family
  garage: "house",
  scene: "house", // scene score default
  score: "ambient", // scene score uses ambient palette
};

/** Style keyword mapping (checked against available styles per genre). */
const STYLE_KEYWORDS: Record<string, string> = {
  classic: "classic",
  deep: "deep",
  organs: "organs",
  drive: "drive",
  driving: "drive",
  rolling: "rolling",
  acid: "acid",
  dark: "dark",
  bright: "bright",
  roll: "roll",
  drift: "drift",
  lush: "lush",
};

/** Character keyword → parameter adjustments. */
interface CharacterTrait {
  energy?: number;
  density?: number;
  complexity?: number;
  variation?: number;
}

const CHARACTER_KEYWORDS: Record<string, CharacterTrait> = {
  dark: { energy: 0.3 },
  bright: { energy: 0.8 },
  warm: { energy: 0.5 },
  cold: { energy: 0.35 },
  sparse: { density: 0.2 },
  minimal: { density: 0.25, complexity: 0.25 },
  busy: { density: 0.8 },
  dense: { density: 0.8 },
  simple: { complexity: 0.2 },
  complex: { complexity: 0.8 },
  intricate: { complexity: 0.85 },
  aggressive: { energy: 0.9, density: 0.7 },
  chill: { energy: 0.3, density: 0.4 },
  relaxed: { energy: 0.3 },
  driving: { energy: 0.8, density: 0.7 },
  rolling: { variation: 0.6 },
  euphoric: { energy: 0.95, density: 0.7 },
  melancholic: { energy: 0.35, complexity: 0.5 },
  hypnotic: { variation: 0.2, complexity: 0.3 },
  evolving: { variation: 0.8 },
  punchy: { energy: 0.75, density: 0.6 },
  smooth: { energy: 0.4, complexity: 0.35 },
  hard: { energy: 0.9 },
  soft: { energy: 0.35 },
  heavy: { energy: 0.85, density: 0.7 },
  light: { energy: 0.35, density: 0.4 },
  tight: { complexity: 0.4 },
  wide: { complexity: 0.6 },
};

/** Role keywords → role flags. */
const ROLE_KEYWORDS: Record<string, string> = {
  drums: "drums",
  kick: "drums",
  bass: "bass",
  chords: "chords",
  pad: "chords",
  lead: "lead",
  melody: "lead",
  arp: "lead",
  nodrums: "nodrums",
  "no drums": "nodrums",
  "no bass": "nobass",
};

export interface ParsedIntent {
  input: IntentInput;
  /** Keywords recognised by the parser (for diagnostics/UI feedback). */
  detected: string[];
}

/**
 * Parse natural language text into an IntentInput.
 * Pure function — same text → same result.
 */
export function parseIntentText(text: string): ParsedIntent {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/[\s,.]+/).filter(Boolean);
  const detected: string[] = [];

  let genre: IntentGenre | undefined;
  let style: string | undefined;
  let bpm: number | undefined;
  const trait: CharacterTrait = {};
  const roles = new Set<IntentRole>();
  let hasRoleKeyword = false;

  // Genre detection (first match wins)
  for (const word of words) {
    if (GENRE_KEYWORDS[word] && !genre) {
      genre = GENRE_KEYWORDS[word];
      detected.push(word);
      break;
    }
  }

  // Style detection (only if it matches the detected genre's styles)
  for (const word of words) {
    if (STYLE_KEYWORDS[word] && !style) {
      style = STYLE_KEYWORDS[word];
      detected.push(word);
      break;
    }
  }

  // BPM detection: "at 140", "140 bpm", "150"
  const bpmMatch = lower.match(/(?:at|bpm)\s*(\d{2,3})/) ?? lower.match(/(\d{2,3})\s*bpm/);
  if (bpmMatch) {
    bpm = Number(bpmMatch[1]);
    if (bpm >= 40 && bpm <= 240) detected.push(`${bpm}bpm`);
    else bpm = undefined;
  }

  // Character traits
  for (const word of words) {
    if (CHARACTER_KEYWORDS[word]) {
      const t = CHARACTER_KEYWORDS[word];
      if (t.energy !== undefined) trait.energy = t.energy;
      if (t.density !== undefined) trait.density = t.density;
      if (t.complexity !== undefined) trait.complexity = t.complexity;
      if (t.variation !== undefined) trait.variation = t.variation;
      detected.push(word);
    }
  }

  // Role detection
  let noDrums = false;
  for (const word of words) {
    const role = ROLE_KEYWORDS[word];
    if (role === "nodrums") noDrums = true;
    else if (role === "nobass") roles.delete("bass");
    else if (role && role !== "nodrums" && role !== "nobass") roles.add(role as IntentRole);
    if (ROLE_KEYWORDS[word]) hasRoleKeyword = true;
  }
  if (lower.includes("no drums") || lower.includes("without drums")) noDrums = true;
  if (lower.includes("drums only")) {
    roles.clear();
    roles.add("drums");
    hasRoleKeyword = true;
  }

  const input: IntentInput = {
    ...(genre ? { genre } : {}),
    ...(style ? { style } : {}),
    ...(bpm ? { bpmRange: [bpm, bpm] as [number, number] } : {}),
    ...(hasRoleKeyword
      ? {
          roles: noDrums
            ? ([...roles].filter((r) => r !== "drums") as IntentRole[])
            : [...roles].length > 0
              ? ([...roles] as IntentRole[])
              : (["drums", "bass"] as IntentRole[]),
        }
      : {}),
    // Trait adjustments layer on top of defaults — normalizeIntent handles
    // missing values with genre-appropriate defaults.
    energy: trait.energy,
    density: trait.density,
    complexity: trait.complexity,
    variation: trait.variation,
  };

  return { input, detected };
}
