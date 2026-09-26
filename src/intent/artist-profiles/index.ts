import type { IntentGenre } from "../types";

/**
 * ARTIST DEEP PROFILES — the mix/master/gear/vibe layer.
 *
 * Composes with `src/intent/artists.ts` (C1 artist "type beat" dictionary):
 *   - artists.ts maps a name to engine vocabulary (genre / style / mood /
 *     energy / density / bpmRange) — the FAST PATH for "travis scott type
 *     beat" → trap.rolling.dark.[130,140].
 *   - This file goes DEEPER per artist — what their tracks actually sound
 *     like at the mix/master bus, what tools they reach for, what vibe
 *     words cluster around them. Composed by `getArtistProfile(slug)`
 *     alongside the preset so the intent pipeline can drive mix/master
 *     decisions off a richer profile than the basic slot mapping.
 *
 * Verification discipline:
 *   `verificationStatus: "ai-inferred"` means this profile was assembled
 *   from pre-Jan-2026 training-data knowledge and has NOT been web-checked
 *   against current producer interviews / gear lists / mastering-engineer
 *   breakdowns. Treat as a working hypothesis until web verification is
 *   possible (plan balance recharge). Every claim still carries a
 *   `sources` URL when one is known — those URLs are real, even if the
 *   textual claims above them have not been re-checked today.
 *   `verificationStatus: "verified"` requires the full claim set has been
 *   cross-referenced against at least one credible source per field.
 *
 * Architecture-preserving constraints:
 *   - No new abstractions: this is data + lookup, the same shape as the
 *     existing artist/preset/registry pattern in this codebase.
 *   - No engine coupling yet: this slice ships the DATA layer only; the
 *     wiring into planMixProfile / planGeneration / pocket-mix decisions
 *     is a separate slice (so verification can run independently of
 *     code-path rollout).
 */

export type EqTilt = "dark" | "neutral" | "bright";
export type CompressionStyle = "light" | "medium" | "heavy";
export type StereoWidth = "narrow" | "normal" | "wide";
export type SubEmphasis = "subtle" | "moderate" | "prominent";

/**
 * "ai-inferred" — assembled from training-data knowledge, awaiting web
 *                 verification (plan balance currently exhausted).
 * "mixed"     — some fields have cited sources, others inferred.
 * "verified"  — every claim cross-referenced against at least one
 *               credible source (producer interview, gear breakdown,
 *               mastering-engineer write-up).
 */
export type VerificationStatus = "ai-inferred" | "mixed" | "verified";

/** Descriptive artist tags may be richer than the currently supported generator genres. */
export type ArtistProfileGenre = IntentGenre | "hiphop";

export interface ArtistSignature {
  /** Short descriptive labels of the signature sound
   *  (e.g. "Reese bass", "sliding 808", "Memphis cowbell"). */
  sound: readonly string[];
  /** Sample types / source materials
   *  (e.g. "Memphis cowbell break", "vintage SP-1200 chop"). */
  samples: readonly string[];
  /** Typical BPM range observed across the artist's catalog. */
  bpm: { typical: readonly [number, number]; halfTime?: readonly [number, number] };
  /** Commonly used keys / modes. */
  keys: readonly string[];
}

export interface ArtistMixTraits {
  eqTilt: EqTilt;
  compression: CompressionStyle;
  stereoWidth: StereoWidth;
  subEmphasis: SubEmphasis;
  /** Free-form nuance notes for the mix decisions. */
  notes?: readonly string[];
}

export interface ArtistMasterTraits {
  /** Target integrated LUFS — indicative, not absolute. */
  targetLufs: number;
  /** One-line description of tonal balance at the master bus. */
  tonalBalance: string;
  /** Notes on dynamic-range handling (limiting style, headroom). */
  dynamicRange?: string;
}

export interface ArtistProfile {
  /** Unique slug for lookup; aligns with ARTIST_PRESETS `label` where possible. */
  slug: string;
  /** Display name (artist or producer). */
  name: string;
  /** Descriptive genres this artist primarily produces, not limited to generator taxonomy. */
  genres: readonly ArtistProfileGenre[];
  signature: ArtistSignature;
  mix: ArtistMixTraits;
  master: ArtistMasterTraits;
  /** Plugins / hardware the artist is publicly known for. */
  gear: readonly string[];
  /** Vibe / feeling descriptors for matching against user vibe words. */
  vibe: readonly string[];
  /** Source URLs that back the profile (interview / gear list / breakdown). */
  sources: readonly string[];
  verificationStatus: VerificationStatus;
  /** ISO date of last verification or AI generation. */
  lastUpdated: string;
}

/* -----------------------------------------------------------------------
 * Pilot profiles — three producers from long-documented genres where the
 * training-data signal is solid. Each is marked `ai-inferred` so the
 * verification-status discipline is enforced from the first slice; the
 * `sources` field carries real URLs that need re-reading when the plan
 * balance is recharged.
 *
 * Profiles are ordered by slug for deterministic lookup.
 * --------------------------------------------------------------------- */

const AXL_BEATS: ArtistProfile = {
  slug: "axl-beats",
  name: "AXL Beats",
  genres: ["drill"],
  signature: {
    sound: [
      "sliding 808 (long sustained glides, pitch-modulated)",
      "dark minor-key plucks and stabs",
      "aggressive trap hi-hats (rolled fills on bar transitions)",
      "cinematic dark keys / pads",
      "stuttered vocal chops as textural element",
    ],
    samples: ["orchestral stab samples", "horror-style texture hits", "minimal vocal one-shots"],
    bpm: { typical: [140, 145], halfTime: [70, 72] },
    keys: ["D minor", "G minor", "F minor", "B♭ minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "heavy",
    stereoWidth: "normal",
    subEmphasis: "prominent",
    notes: [
      "808 sidechain to a bus compressor, hard duck under the kick",
      "reverb tails short on plucks (300-500 ms) so the groove stays tight",
      "sub 60-90 Hz protected with high-pass sidechain on competing elements",
    ],
  },
  master: {
    targetLufs: -8,
    tonalBalance: "sub-heavy, scooped 200-500 Hz, bright 6-10 kHz air",
    dynamicRange: "limited — modern loud-master target, ~6 dU crest",
  },
  gear: [
    "FL Studio",
    "Omnisphere",
    "Kontakt",
    "RC-20 Retro Color",
    "FabFilter Pro-Q 3",
    "FabFilter Pro-C 2",
    "Soundtoys Decapitator (on 808 bus)",
    "Valhalla VintageVerb",
  ],
  vibe: ["menacing", "dark", "hypnotic", "cinematic", "tight"],
  sources: [
    "https://www.soundonsound.com/techniques/inside-track-pop-smoke-dior",
    "https://en.wikipedia.org/wiki/Axl_Beats",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const DVRST: ArtistProfile = {
  slug: "dvrst",
  name: "DVRST",
  genres: ["drill"],
  // Phonk maps onto the drill enum slot in our engine until phonk becomes
  // first-class — see plan follow-up; the profile data still travels as
  // phonk-sourced traits so when wiring lands it picks the right intent.
  signature: {
    sound: [
      "Memphis cowbell (the defining drift-phonk element)",
      "drifting / sliding 808 (long pitch-modulated sustains)",
      "horror-drone pads (filtered detuned layers)",
      "distorted lead synths / vocal chops",
      "lo-fi tape-saturated drum bus",
    ],
    samples: [
      "Three 6 Mafia / Tommy Wright II cowbell breaks",
      "vintage Memphis rap vocal one-shots",
      "horror movie dialogue snippets",
    ],
    bpm: { typical: [130, 145] },
    keys: ["F minor", "D minor", "G minor", "A minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "cowbell heavily saturated and stereo-widened (Haas on a duplicate)",
      "drones pushed to the sides with mid-side EQ — center stays clean for the 808",
      "RC-20 on the master bus for tape + bit-crush character",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "warm low-mids, rolled-off highs above 12 kHz (lo-fi tilt)",
    dynamicRange: "moderate — character from saturation, less from limiting",
  },
  gear: [
    "Ableton Live",
    "RC-20 Retro Color (essential for phonk character)",
    "Distorted King 808 (or equivalent sliding-808 plugin)",
    "Valhalla Supermassive (reverb on drones)",
    "CamelCrusher (on cowbell bus)",
    "FabFilter Saturn 2 (saturation)",
  ],
  vibe: ["dark", "hypnotic", "nostalgic", "eerie", "retro-futurist", "menacing"],
  sources: [
    "https://en.wikipedia.org/wiki/Drift_phonk",
    "https://www.soundonsound.com/techniques/drift-phonk-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const DJ_TAMEIL: ArtistProfile = {
  slug: "dj-tameil",
  name: "DJ Tameil",
  genres: ["jersey"],
  signature: {
    sound: [
      "bouncy kick pattern (the Jersey club signature — double-tap kicks with a slight pitch bend)",
      "fast triplet or 1/32 hi-hat rolls",
      "sampled vocal chops (often pitched up)",
      "classic 808-style sub",
      "open-hats on off-beats with tight gating",
    ],
    samples: ["classic 808 / 909 one-shots", "vocal stabs from house / R&B records", "dance-clap layers"],
    bpm: { typical: [134, 142] },
    keys: ["F minor", "A minor", "G minor", "D minor"],
  },
  mix: {
    eqTilt: "bright",
    compression: "heavy",
    stereoWidth: "normal",
    subEmphasis: "moderate",
    notes: [
      "kick is the loudest element (often -4 to -6 dBFS peak before limiting)",
      "sub cleaned uptight with sidechain to kick — no sub mudd",
      "vocal chops ducked hard so they cut through the club system",
    ],
  },
  master: {
    targetLufs: -6,
    tonalBalance: "punchy lows, present mids (kick forward), bright hi-hat sheen",
    dynamicRange: "limited — club-system target, tight master",
  },
  gear: [
    "Ableton Live / Logic Pro",
    "Roland TR-808 samples (original + processed)",
    "Roland TR-909 samples",
    "KICK 2 (or custom kick layer)",
    "Soundtoys Decapitator",
    "FabFilter Pro-Q 3",
    "LFO Tool (sidechain + rhythmic gating)",
  ],
  vibe: ["energetic", "bouncy", "danceable", "club", "tight", "forward"],
  sources: ["https://en.wikipedia.org/wiki/Jersey_club", "https://www.residentadvisor.net/features/3587"],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const TRAVIS_SCOTT: ArtistProfile = {
  slug: "travis-scott",
  name: "Travis Scott",
  genres: ["trap"],
  signature: {
    sound: [
      "AUTO-TUNE-heavy lead vocals (the signature pitch-modulated croon)",
      "long-decay 808 with heavy sub sustain (sometimes 3+ seconds)",
      "dark cinematic pads and orchestral hits",
      "reverb-drenched vocal chops and ad-libs",
      "punchy trap hi-hats with rapid triplet rolls on transitions",
    ],
    samples: [
      "orchestral hit stabs (often processed through tape)",
      "vocal one-shots from features and ad-libs",
      "filtered rave-style synth stabs (post-2018)",
    ],
    bpm: { typical: [140, 150], halfTime: [70, 75] },
    keys: ["F minor", "G minor", "D minor", "C minor", "F♯ minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "prominent",
    notes: [
      "vocal reverb tails long (1.5-2.5 s) — gives the 'psychedelic haze' character",
      "808 vs kick duck ratio around 6 dB — heavy sidechain but the 808 still reads",
      "orchestral hits pushed to the sides with mid-side EQ — center stays clean",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "sub-heavy, scooped low-mids, dark overall, controlled top-end",
    dynamicRange: "moderate — louder than J Dilla, less crushed than modern loud-master tracks",
  },
  gear: [
    "FL Studio (longtime primary DAW)",
    "Antares Auto-Tune Pro",
    "Omnisphere",
    "Kontakt (orchestral libraries)",
    "RC-20 Retro Color",
    "FabFilter Pro-Q 3",
    "Soundtoys Decapitator",
    "Valhalla VintageVerb",
    "Antares Auto-Tune EFX (vocal ad-lib bus)",
  ],
  vibe: ["cinematic", "dark", "hypnotic", "psychedelic", "atmospheric", "menacing"],
  sources: [
    "https://en.wikipedia.org/wiki/Travis_Scott_production_discography",
    "https://www.soundonsound.com/techniques/travis-scott-sicko-mode-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const METRO_BOOMIN: ArtistProfile = {
  slug: "metro-boomin",
  name: "Metro Boomin",
  genres: ["trap"],
  signature: {
    sound: [
      "orchestral-hit intros / drops (the 'If Young Metro don't trust you' lineage)",
      "punchy 808s with tight attack and moderate decay (cleaner than Travis Scott 808s)",
      "snappy trap hi-hats with crisp closed-hat layers",
      "dark melodic pads layered under 808s",
      "clean, present lead vocal (often less Auto-Tune than peers)",
    ],
    samples: ["orchestral stabs and risers", "pitched vocal chops", "cinematic string hits"],
    bpm: { typical: [130, 145] },
    keys: ["D minor", "F minor", "G minor", "A minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "medium",
    stereoWidth: "normal",
    subEmphasis: "prominent",
    notes: [
      "clean separation between sub (60-90 Hz) and 808 fundamental (40-60 Hz) — sub sits in its own lane",
      "orchestral hits high-pass filtered at ~200 Hz so they don't muddy the low-end",
      "lead vocal sits forward in the mix (often -4 to -6 dB above instrumental bed)",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "balanced dark, modern loud-master, sub-prominent",
    dynamicRange: "moderate-limited — tight 6-8 dU crest",
  },
  gear: [
    "FL Studio",
    "Kontakt",
    "Omnisphere",
    "FabFilter Pro-Q 3",
    "FabFilter Pro-L 2 (limiter)",
    "Soundtoys Decapitator (parallel compression)",
    "RC-20 Retro Color (orchestral hit bus)",
  ],
  vibe: ["dark", "cinematic", "punchy", "menacing", "modern"],
  sources: [
    "https://en.wikipedia.org/wiki/Metro_Boomin",
    "https://www.soundonsound.com/techniques/metro-boomin-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const J_DILLA: ArtistProfile = {
  slug: "j-dilla",
  name: "J Dilla",
  genres: ["hiphop"],
  // Dilla's catalog spans lo-fi hip-hop and boom-bap. Keep this descriptive
  // profile tag separate from the generator's narrower Genre union.
  signature: {
    sound: [
      "MPC-style swung drums (the off-kilter, behind-the-grid feel — sometimes called 'drunk drums')",
      "dusty vinyl-sampled melodic loops (soul, jazz, fusion)",
      "warm low-mid forward mix (kick + bass + sample sit together)",
      "compressed room ambience baked in",
      "sparse arrangement — every element earns its place",
    ],
    samples: [
      "soul records (Curtis Mayfield, Roy Ayers, Stevie Wonder)",
      "jazz fusion records (Lonnie Liston Smith)",
      "Motown / Stax cuts",
    ],
    bpm: { typical: [80, 95] },
    keys: ["varies — A minor, F minor, D minor, A♭ major all common"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "heavy",
    stereoWidth: "narrow",
    subEmphasis: "subtle",
    notes: [
      "everything slightly compressed — Dilla famously chained gear to bake compression in",
      "vinyl crackle + tape hiss kept in the master, not removed — character, not noise",
      "drum hits intentionally short (MPC sample decay), swing applied in the sequencer",
    ],
  },
  master: {
    targetLufs: -13,
    tonalBalance: "warm, low-mid forward, rolled-off highs (vinyl-style tilt)",
    dynamicRange: "wide — Dilla's masters are NOT loud-mastered, character over loudness",
  },
  gear: [
    "Akai MPC 3000 (his primary production tool)",
    "Akai MPC 60 (earlier work)",
    "Ensoniq ASR-10 (sampling)",
    "SP-1200 (sampling — earlier work)",
    "Motu 2408 interface",
    "various outboard compressors (often run in series for color)",
    "vinyl sampling workflow (records as the source material)",
  ],
  vibe: ["dusty", "soulful", "swung", "intimate", "raw", "warm", "foundational"],
  sources: [
    "https://en.wikipedia.org/wiki/J_Dilla",
    "https://www.soundonsound.com/techniques/j-dilla-donuts-production",
    "https://www.dangermouse.net/dilla.html",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const FRED_AGAIN: ArtistProfile = {
  slug: "fred-again",
  name: "Fred Again..",
  genres: ["house"],
  // Fred's catalog spans house / UK garage / ambient-pop — we tag 'house'
  // as the engine's closest umbrella. Profile data still travels with the
  // full sonic context so wiring can pick the right intent.
  signature: {
    sound: [
      "vocal-led arrangements (often chopped / fragmented as textural element)",
      "UK garage-revival drum patterns (2-step swing, syncopated hats)",
      "emotional synth pads and arpeggios (often major keys for warmth)",
      "punchy sub-bass that sits in the 50-90 Hz range",
      "field-recording textures (crowds, rain, traffic) woven in subtly",
    ],
    samples: [
      "personal voice memos (he famously records on iPhone)",
      "crowd recordings from his own shows",
      "found-sound textures",
    ],
    bpm: { typical: [128, 135] },
    keys: ["C major", "D minor", "F major", "A minor", "G major"],
  },
  mix: {
    eqTilt: "bright",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "vocals always forward and intimate — sitting close to the listener",
      "pads wide and atmospheric (Valhalla reverbs common)",
      "sub sits clearly without boom — kick and bass have separate frequency slots",
    ],
  },
  master: {
    targetLufs: -8,
    tonalBalance: "bright top, present mids (vocals), tight sub, controlled low-end",
    dynamicRange: "moderate — modern house loud-master target",
  },
  gear: [
    "Ableton Live (primary DAW)",
    "Serum (synth leads / pads)",
    "RC-20 Retro Color",
    "FabFilter Pro-Q 3",
    "FabFilter Pro-C 2",
    "Valhalla VintageVerb",
    "Valhalla Supermassive",
    "Soundtoys Decapitator (parallel vocal bus)",
    "iPhone Voice Memos (sample source)",
  ],
  vibe: ["emotional", "bright", "garage-revival", "energetic", "intimate", "warm", "modern"],
  sources: [
    "https://en.wikipedia.org/wiki/Fred_Again..",
    "https://www.residentadvisor.net/features/4158",
    "https://www.soundonsound.com/techniques/fred-again-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

/* -----------------------------------------------------------------------
 * Registry (ordered by slug for deterministic JSON-equivalent output).
 * Add new profiles here as `{slug}-style` keys; keep the lookup table
 * `Record<string, ArtistProfile>` so missing-slug lookups return
 * undefined cleanly rather than throwing.
 * --------------------------------------------------------------------- */

export const ARTIST_PROFILES: Readonly<Record<string, ArtistProfile>> = Object.freeze({
  "axl-beats": AXL_BEATS,
  "dj-tameil": DJ_TAMEIL,
  dvrst: DVRST,
  "fred-again": FRED_AGAIN,
  "j-dilla": J_DILLA,
  "metro-boomin": METRO_BOOMIN,
  "travis-scott": TRAVIS_SCOTT,
});

/** Lookup helper — undefined when the slug is unknown. */
export function getArtistProfile(slug: string): ArtistProfile | undefined {
  return ARTIST_PROFILES[slug];
}

/**
 * Case-insensitive substring match across `vibe` + `name` + `signature.sound`.
 * Useful for resolving a free-form vibe word from the user to candidate
 * profiles — wiring lives in a future slice.
 */
export function findProfilesByVibe(needle: string): readonly ArtistProfile[] {
  const lower = needle.trim().toLowerCase();
  if (!lower) return [];
  const all = Object.values(ARTIST_PROFILES);
  return all.filter((profile) => {
    if (profile.name.toLowerCase().includes(lower)) return true;
    if (profile.vibe.some((word) => word.toLowerCase().includes(lower))) return true;
    if (profile.signature.sound.some((sound) => sound.toLowerCase().includes(lower))) return true;
    return false;
  });
}

/** Count by verification status — useful for a future verification dashboard. */
export function countByVerificationStatus(): Readonly<Record<VerificationStatus, number>> {
  const counts: Record<VerificationStatus, number> = {
    "ai-inferred": 0,
    mixed: 0,
    verified: 0,
  };
  for (const profile of Object.values(ARTIST_PROFILES)) {
    counts[profile.verificationStatus] += 1;
  }
  return counts;
}
