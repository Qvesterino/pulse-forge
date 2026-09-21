import type { IntentGenre } from "./types";

/**
 * TEXT DESCRIPTION GENERATOR (INTENT_ENGINE.md Fáza A) — procedural text
 * descriptions for every pattern in the library, EN + SK.
 *
 * These descriptions are the TRAINING DATA for embedding-conditioned priors:
 * each description is embedded by MiniLM and paired with the pattern's
 * features. At inference, the user's text is embedded and matched to the
 * nearest description — the conditioning comes from MEANING, not keywords.
 *
 * Templates are COMBINATORIAL: genre synonyms × style descriptors × mood
 * words × tempo references × sentence structures. The result is 20-50
 * diverse, natural-sounding descriptions per pattern — enough for the
 * embedding space to capture the style's meaning, not just its label.
 */

export interface DescriptionSet {
  genre: IntentGenre;
  style: string;
  /** All generated descriptions (EN + SK), deduplicated. */
  descriptions: string[];
}

// ── Vocabulary pools ────────────────────────────────────────────────────────

const GENRE_SYNONYMS: Record<string, string[]> = {
  house: ["house", "four-on-floor", "club", "dance", "house music"],
  techno: ["techno", "techno beat", "warehouse", "peak-time"],
  trap: ["trap", "trap beat", "hip-hop", "808 beat"],
  ambient: ["ambient", "atmospheric", "soundscape", "textures"],
};

const STYLE_SYNONYMS: Record<string, string[]> = {
  driving: ["driving", "driving beat", "steady drive", "rolling energy"],
  minimal: ["minimal", "stripped back", "less is more", "clean minimal"],
  funky: ["funky", "funky groove", "groovy", "swinging"],
  deep: ["deep", "deep and dubby", "sub-heavy", "warm and round"],
  ukg: ["UKG", "UK garage", "two-step", "speed garage"],
  afro: ["afro", "afrobeat", "tribal", "organic percussion"],
  industrial: ["industrial", "harsh", "metallic", "warehouse industrial"],
  dub: ["dubby", "dub techno", "space echo", "echoes"],
  acid: ["acid", "303 acid", "acid lines", "squelchy acid"],
  classic: ["classic", "golden era", "timeless", "traditional"],
  rolling: ["rolling", "rolling energy", "rolling bass", "rolling grooves"],
  sparse: ["sparse", "spacious", "minimal elements", "space between notes"],
  bouncy: ["bouncy", "bouncy energy", "jumping", "playful bounce"],
  drifting: ["drifting", "floating", "weightless", "slow drift"],
  glitch: ["glitchy", "glitch textures", "stuttering", "micro-edits"],
  organic: ["organic", "natural textures", "earthy", "living sound"],
};

const MOOD_WORDS: Record<string, { en: string[]; sk: string[] }> = {
  dark: { en: ["dark", "moody", "menacing", "nocturnal", "brooding"], sk: ["tmavý", "temný", "nočný"] },
  aggressive: { en: ["aggressive", "hard", "pounding", "relentless"], sk: ["agresívny", "tvrdý", "drvivý"] },
  chill: { en: ["chill", "relaxed", "laid-back", "smooth"], sk: ["pokojný", "uvoľnený", "jemný"] },
  energetic: { en: ["energetic", "uplifting", "euphoric", "driving"], sk: ["energický", "dvíhajúci", "sila"] },
};

const TEMPO_WORDS: Record<string, string[]> = {
  house: ["at 124", "at 126", "at 128", "groove tempo"],
  techno: ["at 138", "at 145", "at 140", "driving tempo"],
  trap: ["at 140", "at 145", "at 150", "half-time feel"],
  ambient: ["slow", "at 80", "at 90", "spacious tempo"],
};

// ── Template engine ─────────────────────────────────────────────────────────

type Template = (genre: string, style: string, mood: string | null, bpm: string) => string;

const EN_TEMPLATES: Template[] = [
  (g, s, m, b) => `${m ? m + " " : ""}${s} ${g} ${b}`,
  (g, s, m) => `${m ? m + " " : ""}${g} with ${s} grooves`,
  (g, s, m) => `${s} ${g}${m ? ", " + m + " vibe" : ""}`,
  (g, s, m) => `a ${m ? m + " " : ""}${s} ${g} instrumental`,
  (g, s) => `${s} ${g} roller`,
  (g, s, m) => `${m ? m + " and " : ""}${s} ${g} for the floor`,
  (g, s, m) => `${s} ${g}${m ? " with " + m + " atmosphere" : ""}`,
  (g, s, m) => `${m ? m + " " : ""}${g} with ${s} character`,
  (g, s) => `${s} feeling ${g}`,
  (g, s, m) => `${m ? m + " " : ""}${s} ${g} soundscape`,
];

const SK_TEMPLATES: Template[] = [
  (g, s, m) => `${m ? m + " " : ""}${s} ${g}`,
  (g, s, m) => `${s} ${g} s ${m ? m + "ou atmosférou" : "groovom"}`,
  (g, s) => `${s} ${g} beat`,
  (g, s) => `${s} ${g} pre floor`,
];

/**
 * Generate diverse text descriptions for a genre×style×mood combination.
 * Deduplicates and returns up to `max` descriptions.
 */
export function generateDescriptions(
  genre: IntentGenre,
  style: string,
  mood: string | null,
  bpmRange: [number, number] | null,
  max = 30,
): string[] {
  const genreWords = GENRE_SYNONYMS[genre] ?? [genre];
  const styleWords = STYLE_SYNONYMS[style] ?? [style];
  const moodEn = mood ? (MOOD_WORDS[mood]?.en ?? [mood]) : [""];
  const moodSk = mood ? (MOOD_WORDS[mood]?.sk ?? [mood]) : [""];
  const bpmMid = bpmRange ? Math.round((bpmRange[0] + bpmRange[1]) / 2) : null;
  const bpmWord = bpmMid ? `${bpmMid}` : (TEMPO_WORDS[genre]?.[0] ?? "");

  const descriptions = new Set<string>();

  for (const g of genreWords) {
    for (const s of styleWords) {
      for (const m of moodEn) {
        const moodStr = m || "";
        for (const template of EN_TEMPLATES) {
          const desc = template(g, s, moodStr, bpmWord);
          if (desc.trim().length > 5) descriptions.add(desc);
          if (descriptions.size >= max) break;
        }
        if (descriptions.size >= max) break;
      }
      if (descriptions.size >= max) break;

      // SK descriptions
      for (const template of SK_TEMPLATES) {
        const mSk = moodSk[0] ?? "";
        const desc = template(g, s, mSk, bpmWord);
        if (desc.trim().length > 5) descriptions.add(desc);
        if (descriptions.size >= max) break;
      }
      if (descriptions.size >= max) break;
    }
    if (descriptions.size >= max) break;
  }

  return [...descriptions];
}

/**
 * Generate descriptions for ALL genre×style combinations in the library.
 * Used by the dataset generator to create text→embedding→pattern training pairs.
 */
export function generateAllDescriptions(genres: readonly IntentGenre[]): Map<string, DescriptionSet> {
  const result = new Map<string, DescriptionSet>();
  for (const genre of genres) {
    for (const styleKey of Object.keys(STYLE_SYNONYMS)) {
      const descriptions = generateDescriptions(genre, styleKey, null, null, 20);
      result.set(`${genre}:${styleKey}`, { genre, style: styleKey, descriptions });
    }
  }
  return result;
}
