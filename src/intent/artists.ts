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
    genre: "trap",
    style: "sparse",
    mood: "dark",
    energy: 0.65,
    density: 0.45,
    bpmRange: [140, 145],
    label: "drill",
  },
  {
    names: ["ice spice", "jersey club", "jersey beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [140, 150],
    label: "jersey",
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
