import type { IntentSpec } from "./types";
import { artistMixProfileFromDeep } from "./artist-profiles";

/**
 * ARTIST MIX SIGNATURES — the mix/master character an artist preset carries.
 *
 * The groove/BPM side of an artist lives in the preset (artists.ts); the
 * production side lives here: tone tilt, punch, space and sidechain pump —
 * the decisions planMixProfile makes. Keyed by the preset's stable `label`
 * (IntentSpec.artist, set by the parser on match). An artist signature sits
 * ABOVE the genre default but BELOW explicit user words — "drake type beat"
 * sounds like Drake, "drake type beat brighter" sounds brighter.
 *
 * Adding an artist: one row here + `label:` in the roster. No row = the
 * genre default applies (the table is an override layer, not a registry).
 *
 * Phase 2 fallback (2026-09-26): the deep profile layer
 * (src/intent/artist-profiles/) carries a richer dataset (signature sound,
 * mix traits, master target, gear, vibe) for ~22 artists that the curated
 * ARTIST_MIX_PROFILES table does not cover. When the curated table misses,
 * `artistMixProfileOf` falls through to the deep layer and derives an
 * ArtistMixProfile shape from the deep profile's mix traits. The curated
 * table is ALWAYS tried first so manually-tuned overrides win.
 */

export interface ArtistMixProfile {
  /** Master/track tilt family (maps to TONE_MASTER_TILT_DB in mix.ts). */
  tone?: "dark" | "bright" | "warm" | "cold";
  /** Dynamic pressure default. */
  punch?: "more" | "less";
  /** Space default — "huge" reads as the reverb-more-max case. */
  reverb?: "less" | "more" | "huge";
  /** Sidechain pump default (usually house/techno — signatures can force it). */
  pump?: boolean;
}

export const ARTIST_MIX_PROFILES: Readonly<Record<string, ArtistMixProfile>> = {
  // ── hip-hop / rap ──────────────────────────────────────────────────────
  drake: { tone: "dark", reverb: "more" },
  "kendrick lamar": { tone: "warm", punch: "more" },
  "dr. dre": { tone: "warm", punch: "more" },
  "snoop dogg": { tone: "warm", reverb: "more" },
  "warren g & nate dogg": { tone: "warm", reverb: "more" },
  "ty dolla $ign": { tone: "warm" },
  "travis scott": { tone: "dark", reverb: "huge", punch: "more" },
  "yung lean / drain gang": { tone: "cold", reverb: "huge" },
  "a$ap rocky": { tone: "dark", reverb: "more" },
  "dj screw / chopped and screwed": { tone: "warm", reverb: "huge" },
  "juice wrld": { tone: "dark", reverb: "more" },
  "lil peep": { tone: "cold", reverb: "more" },
  babytron: { punch: "more" },
  "lil jon / crunk": { punch: "more", reverb: "less" },
  "mf doom": { tone: "warm", reverb: "less" },
  "burial / future garage": { tone: "dark", reverb: "huge" },
  // ── electronic ─────────────────────────────────────────────────────────
  "fred again (ukg)": { tone: "bright", pump: true },
  sophie: { tone: "bright", punch: "more", reverb: "less" },
  anyma: { tone: "dark", reverb: "huge" },
  "seven lions": { tone: "bright", reverb: "huge", punch: "more" },
  excision: { tone: "dark", punch: "more", reverb: "less", pump: false },
  "black coffee": { tone: "warm", reverb: "more" },
  pinkpantheress: { tone: "bright", punch: "more" },
  "skepta / grime": { tone: "cold", punch: "more", reverb: "less" },
};

/** Artist signature lookup; unknown/absent labels yield the genre default path. */
export function artistMixProfileOf(intent: IntentSpec): ArtistMixProfile | null {
  if (!intent.artist) return null;
  const explicit = ARTIST_MIX_PROFILES[intent.artist];
  if (explicit) return explicit;
  // Phase 2 fallback: the curated ARTIST_MIX_PROFILES table covers 21
  // artists; the deep profile layer covers 22 more (some overlap). If the
  // parser matched an artist the curated table doesn't know, derive an
  // ArtistMixProfile from the deep layer's mix traits. Curated overrides
  // always win when present.
  return artistMixProfileFromDeep(intent.artist);
}
