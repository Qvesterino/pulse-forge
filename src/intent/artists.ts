import type { IntentGenre } from "./types";

/**
 * ARTIST "TYPE BEAT" ALIAS DICTIONARY (INTENT_ENGINE.md C1) — the beat-maker
 * language. "travis scott type beat" is how the world asks for a beat; this
 * registry maps well-known references to OUR canonical vocabulary
 * (genre + existing style + mood + sliders + BPM prior).
 *
 * Rules:
 * - presets map ONLY to existing engine vocabulary — no new capabilities,
 *   no content copying (a name → a style description, legally clean);
 * - the preset is a BASE: explicit words in the text still override it
 *   ("travis scott type beat bright" → energetic wins over the preset's
 *   dark) — enforced by application order in text-parser;
 * - deterministic and offline; when the text-embedding understanding lands
 *   (T1 step 2), this stays as the fast-path fallback.
 *
 * BPM priors are researched (Mixed In Key / LANDR / producer forums,
 * see docs/intent-artists-and-revise-plan.md).
 */

export interface ArtistPreset {
  /** Match phrases — lowercase, de-accented, word-boundary matched. */
  names: readonly string[];
  genre: IntentGenre;
  style?: string;
  mood?: "dark" | "aggressive" | "chill" | "energetic";
  energy?: number;
  density?: number;
  bpmRange?: [number, number];
  /** UI chip label. */
  label: string;
}

export const ARTIST_PRESETS: readonly ArtistPreset[] = [
  // ── trap / hip-hop ──────────────────────────────────────────────────────
  {
    names: ["travis scott", "travis scott type beat"],
    genre: "trap",
    style: "rolling",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 140],
    label: "travis scott",
  },
  {
    names: ["metro boomin", "metroboomin"],
    genre: "trap",
    style: "dark",
    mood: "dark",
    energy: 0.65,
    density: 0.5,
    bpmRange: [130, 140],
    label: "metro boomin",
  },
  {
    names: ["21 savage", "21 savage type beat"],
    genre: "trap",
    style: "dark",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [130, 140],
    label: "21 savage",
  },
  {
    names: ["playboi carti", "carti type beat", "rage beat", "rage type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [150, 165],
    label: "rage (carti)",
  },
  {
    names: ["yeat", "yeat type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [150, 160],
    label: "yeat",
  },
  {
    names: ["southstar", "south star", "kyle beat"],
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [150, 160],
    label: "hyper-rage",
  },
  {
    names: ["pop smoke", "uk drill", "central cee", "drill type beat"],
    // First-class drill since the sound-quality pass — own grooves + kit swap
    // (sliding-808 kick, dark snare) instead of folding into trap.
    genre: "drill",
    style: "sparse",
    mood: "dark",
    energy: 0.65,
    density: 0.45,
    bpmRange: [140, 145],
    label: "drill",
  },
  {
    names: ["ice spice", "jersey club", "jersey beat"],
    // First-class jersey since the sound-quality pass — bouncy club grooves
    // + punchy kit instead of folding into trap.
    genre: "jersey",
    style: "bouncy",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [134, 142],
    label: "jersey",
  },
  {
    names: ["pendulum", "goldie", "liquid dnb", "neurofunk", "jungle beat"],
    genre: "dnb",
    style: "liquid",
    mood: "dark",
    energy: 0.8,
    density: 0.6,
    bpmRange: [172, 178],
    label: "dnb",
  },
  {
    names: ["kanye", "kanye west", "kanye type beat", "boom bap", "boombap", "boom-bap"],
    genre: "trap",
    style: "classic",
    // boom-bap warmth = classic style + low energy + slow BPM (no canonical
    // "warm" mood exists in mapIntentToOptions)
    energy: 0.55,
    density: 0.5,
    bpmRange: [86, 92],
    label: "boom bap",
  },
  // ── house / club ────────────────────────────────────────────────────────
  {
    names: ["fred again", "fred again.."],
    genre: "house",
    style: "deep",
    energy: 0.75,
    density: 0.6,
    bpmRange: [128, 136],
    label: "fred again",
  },
  {
    names: ["disclosure", "uk garage house"],
    genre: "house",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.65,
    bpmRange: [128, 135],
    label: "ukg",
  },
  {
    names: ["fisher", "tech house", "techhouse"],
    genre: "house",
    style: "driving",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [124, 128],
    label: "tech house",
  },
  {
    names: ["amapiano", "rema", "tyla", "afrobeat"],
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 115],
    label: "amapiano",
  },
  {
    names: ["swedish house mafia", "big room", "martin garrix"],
    genre: "house",
    style: "driving",
    mood: "energetic",
    energy: 0.95,
    density: 0.8,
    bpmRange: [126, 130],
    label: "big room",
  },
  // ── expanded roster (vocabulary wave) ────────────────────────────────────
  // trap / hip-hop
  {
    names: ["future type beat", "future beat"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 150],
    label: "future",
  },
  {
    names: ["gunna", "lil baby"],
    genre: "trap",
    style: "bouncy",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 145],
    label: "gunna / lil baby",
  },
  {
    names: ["ken carson", "destroy lonely", "opium"],
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [150, 165],
    label: "opium rage",
  },
  {
    names: ["pierre bourne", "pi'erre bourne"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 150],
    label: "pi'erre bourne",
  },
  {
    names: ["zaytoven"],
    genre: "trap",
    style: "classic",
    energy: 0.65,
    density: 0.55,
    bpmRange: [130, 142],
    label: "zaytoven",
  },
  {
    names: ["tay keith"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [130, 145],
    label: "tay keith",
  },
  {
    names: ["chief keef"],
    genre: "drill",
    style: "dark",
    mood: "dark",
    energy: 0.7,
    density: 0.5,
    bpmRange: [130, 142],
    label: "chief keef",
  },
  {
    names: ["lex luger"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.7,
    density: 0.5,
    bpmRange: [138, 145],
    label: "lex luger",
  },
  // techno
  {
    names: ["charlotte de witte", "amelie lens"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [145, 152],
    label: "peak-time techno",
  },
  {
    names: ["ben klock"],
    genre: "techno",
    style: "minimal",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [126, 134],
    label: "berlin techno",
  },
  {
    names: ["sara landry", "i hate models", "trym"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.95,
    density: 0.75,
    bpmRange: [148, 155],
    label: "hard techno",
  },
  {
    names: ["boris brejcha"],
    genre: "techno",
    style: "minimal",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [120, 126],
    label: "high-tech minimal",
  },
  {
    names: ["trance", "tiesto", "armin van buuren", "psytrance"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [136, 142],
    label: "trance",
  },
  // house
  {
    names: ["dom dolla", "john summit"],
    genre: "house",
    style: "driving",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [124, 127],
    label: "tech house",
  },
  {
    names: ["keinemusik", "&me", "rampa"],
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [120, 124],
    label: "afro house",
  },
  {
    names: ["overmono", "joy orbison"],
    genre: "house",
    style: "ukg",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 136],
    label: "ukg",
  },
  // ambient
  {
    names: ["brian eno", "eno type beat"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.25,
    density: 0.35,
    bpmRange: [60, 80],
    label: "ambient pioneer",
  },
  {
    names: ["aphex twin", "aphex"],
    genre: "ambient",
    style: "glitch",
    energy: 0.5,
    density: 0.5,
    bpmRange: [70, 110],
    label: "aphex twin",
  },
  {
    names: ["boards of canada", "tycho"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.45,
    density: 0.45,
    bpmRange: [80, 100],
    label: "nostalgic ambient",
  },
  // phonk
  {
    names: ["kordhell", "drift phonk"],
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [150, 165],
    label: "drift phonk",
  },
  {
    names: ["dj smokey", "memphis rap", "ghostface playa"],
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [128, 140],
    label: "memphis phonk",
  },
  // dnb
  {
    names: ["sub focus", "wilkinson"],
    genre: "dnb",
    style: "liquid",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "dancefloor dnb",
  },
  {
    names: ["hedex", "jump up", "jumpup"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [174, 178],
    label: "jump up",
  },
  // jersey
  {
    names: ["bandmanrill", "cookiee kawaii"],
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.8,
    density: 0.65,
    bpmRange: [134, 142],
    label: "jersey club",
  },
];

export interface ArtistMatch {
  preset: ArtistPreset;
  /** The phrase that matched (for diagnostics). */
  matched: string;
}

/**
 * Find the FIRST artist preset whose any name phrase occurs in the text.
 * List order = priority; pure — same text ⇒ same match (or none).
 */
export function matchArtistPreset(lowerText: string): ArtistMatch | null {
  for (const preset of ARTIST_PRESETS) {
    for (const name of preset.names) {
      const pattern = new RegExp(`\\b${name.replace(/[-.]/g, "\\$&")}\\b`);
      if (pattern.test(lowerText)) {
        return { preset, matched: name };
      }
    }
  }
  return null;
}

/**
 * MULTI-VIBE BLEND ("Travis stretne Burial", vibe-code wave): every DISTINCT
 * artist preset mentioned in the text, in match order. Two+ matches make a
 * blend — the intent patch merges (first artist is the base, the second
 * contributes its mood and averages the sliders), and the intent TEXT keeps
 * both names, so the MiniLM conditioning embeds the blend naturally.
 */
export function matchAllArtistPresets(lowerText: string): ArtistMatch[] {
  const matches: Array<ArtistMatch & { position: number }> = [];
  for (const preset of ARTIST_PRESETS) {
    for (const name of preset.names) {
      const escaped = name.replace(/[-.]/g, "\$&");
      const pattern = new RegExp(`\b${escaped}\b`);
      const match = pattern.exec(lowerText);
      if (match) {
        matches.push({ preset, matched: name, position: match.index });
        break;
      }
    }
  }
  return matches.sort((a, b) => a.position - b.position);
}

export interface VibeBlend {
  presetA: ArtistPreset;
  presetB: ArtistPreset;
  /** Merged intent patch — genre/style from A, mood/sliders blended. */
  patch: {
    genre: ArtistPreset["genre"];
    style?: string;
    mood?: ArtistPreset["mood"];
    energy?: number;
    density?: number;
    bpmRange?: [number, number];
  };
  label: string;
}

/**
 * Blend two artist presets: the FIRST is the base (repo convention — first
 * hit wins), the second contributes its mood and averages the sliders.
 * Explicit words in the prompt still override the blend afterwards
 * (text-parser applies them on top, same as the single-artist path).
 */
export function parseVibeBlend(lowerText: string): VibeBlend | null {
  const all = matchAllArtistPresets(lowerText);
  const distinct: ArtistPreset[] = [];
  for (const match of all) {
    if (!distinct.some((p) => p === match.preset)) distinct.push(match.preset);
    if (distinct.length === 2) break;
  }
  if (distinct.length < 2) return null;
  const [a, b] = distinct;
  const avg = (x: number | undefined, y: number | undefined): number | undefined =>
    x !== undefined && y !== undefined ? Math.round(((x + y) / 2) * 100) / 100 : (x ?? y);
  return {
    presetA: a,
    presetB: b,
    patch: {
      genre: a.genre,
      ...(a.style || b.style ? { style: a.style ?? b.style } : {}),
      ...(a.mood || b.mood ? { mood: a.mood ?? b.mood } : {}),
      ...(avg(a.energy, b.energy) !== undefined ? { energy: avg(a.energy, b.energy) } : {}),
      ...(avg(a.density, b.density) !== undefined ? { density: avg(a.density, b.density) } : {}),
      ...(a.bpmRange && b.bpmRange
        ? { bpmRange: [Math.max(a.bpmRange[0], b.bpmRange[0]), Math.min(a.bpmRange[1], b.bpmRange[1])] as [number, number] }
        : a.bpmRange
          ? { bpmRange: [...a.bpmRange] as [number, number] }
          : b.bpmRange
            ? { bpmRange: [...b.bpmRange] as [number, number] }
            : {}),
    },
    label: `${a.label} × ${b.label}`,
  };
}
