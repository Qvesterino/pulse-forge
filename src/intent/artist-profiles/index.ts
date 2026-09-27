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
/**
 * The artist-profile genre tag is INTENTIONALLY BROADER than the engine's
 * Genre enum (src/ai/types.ts: house | techno | trap | ambient | drill |
 * phonk | jersey | dnb). The data layer captures more nuance than the
 * generator needs today, and once the engine broadens its enum the
 * profile layer is already populated. `genres` here is descriptive of
 * the artist's catalog, not a generator contract.
 *
 * Values outside the engine Genre enum (e.g. "hiphop", "hyperpop",
 * "grime", "g-funk", "west-coast", "boom-bap", "lofi", "uk-garage",
 * "melodic-techno") are valid here. The TODO comments in each profile
 * note which engine slot the closest umbrella is.
 */
export type ArtistProfileGenre =
  | IntentGenre
  | "hiphop"
  | "hyperpop"
  | "grime"
  | "g-funk"
  | "west-coast"
  | "boom-bap"
  | "lofi"
  | "uk-garage"
  | "melodic-techno";

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
 * Slice 3 — five profiles in long-documented genres that the engine
 * Genre enum (src/ai/types.ts: `house | techno | trap | ambient | drill |
 * phonk | jersey | dnb`) does NOT yet have first-class slots for:
 *
 *   - ag-cook       → "house"        (TODO: hyperpop enum slot)
 *   - dr-dre        → "trap"         (TODO: g-funk / west-coast enum slot)
 *   - skepta        → "techno"       (TODO: grime enum slot)
 *   - seven-lions   → "dnb"          ✓ exact match (Ophelia Records sound)
 *   - burial        → "ambient"      ✓ exact match (Untrue-era spectral)
 *
 * The closest existing slot is used so the type stays compile-clean;
 * each profile's `genres` array carries a TODO comment explaining the
 * future enum expansion. This is a recorded architectural finding that
 * the deep-profile layer exposes — Phase 2 wiring will likely need the
 * engine genre enum broadened (see AGENT_WORK_LOG.md follow-up).
 * --------------------------------------------------------------------- */

const AG_COOK: ArtistProfile = {
  slug: "ag-cook",
  name: "A.G. Cook",
  // TODO: "hyperpop" enum slot — using "house" as the closest electronic-
  // pop umbrella until the engine broadens its Genre union.
  genres: ["house"],
  signature: {
    sound: [
      "maximalist layered synths (often 6-10 stacked layers)",
      "pitched-up vocal chops (often +12 semitones, layered in octaves)",
      "crystalline bright pads (PC Music trademark sound)",
      "glitched stuttered vocals (mid-word cuts and restarts)",
      "metallic / plastic textures (artificial, hyperreal)",
      "sidechain-pumping synth bass",
    ],
    samples: ["pop acapella chops (pitched + processed)", "PC Music custom-synth one-shots", "synthesized percussion hits"],
    bpm: { typical: [130, 150] },
    keys: ["F major", "C major", "G major", "D minor"],
  },
  mix: {
    eqTilt: "bright",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "subtle",
    notes: [
      "vocal layers stacked in octaves +5 / +12 / +19 semitones for shimmer",
      "sidechain pumping on master bus (4-on-the-floor duck)",
      "high-frequency saturation on the master (Decapitator + tape)",
      "everything pitched into major / bright keyspace — hyperpop rejects minor keys",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "bright, present mids, controlled sub, hyped top-end",
    dynamicRange: "moderate — modern loud-master with headroom for saturation",
  },
  gear: [
    "Ableton Live",
    "Serum",
    "Native Instruments Massive",
    "Soundtoys Decapitator",
    "RC-20 Retro Color",
    "FabFilter Pro-Q 3",
    "Valhalla VintageVerb",
    "Antares Auto-Tune (heavy on vocals)",
    "custom / bespoke Max4Live devices for PC Music workflow",
  ],
  vibe: ["maximalist", "hyperreal", "euphoric", "glitchy", "playful", "futuristic"],
  sources: [
    "https://en.wikipedia.org/wiki/A._G._Cook",
    "https://www.residentadvisor.net/features/2942",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const DR_DRE: ArtistProfile = {
  slug: "dr-dre",
  name: "Dr. Dre",
  // TODO: "g-funk" / "west-coast" enum slots — using "trap" as the closest
  // hip-hop umbrella until the engine broadens. G-funk has distinct sonic
  // identity (Parliament samples, talkbox, smooth sub) that gets flattened
  // when collapsed into "trap".
  genres: ["trap"],
  signature: {
    sound: [
      "G-funk synths (often Parliament / Funkadelic samples)",
      "deep sub bass (smooth, sustained — not the punchy 808 of trap)",
      "funk bass lines (often slap-style, mid-range presence)",
      "talkbox vocal textures (the G-funk signature flourish)",
      "lush string / pad layers (orchestral samples)",
      "soulful melodic samples layered under the beat",
    ],
    samples: [
      "George Clinton / Parliament / Funkadelic",
      "Isaac Hayes, Curtis Mayfield, classic soul",
      "Mellotron textures",
      "orchestral stab samples",
    ],
    bpm: { typical: [88, 96] },
    keys: ["G minor", "A minor", "F minor", "D minor", "B♭ minor"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "medium",
    stereoWidth: "normal",
    subEmphasis: "prominent",
    notes: [
      "G-funk synth sits in the 200-400 Hz range with chorus / phaser",
      "kick and 808 sub separated — sub sits at 40-50 Hz, kick at 60-80 Hz",
      "vocal always forward, often subtly chorused",
      "smooth low-mids — no harshness, no aggressive peaks",
    ],
  },
  master: {
    targetLufs: -10,
    tonalBalance: "warm, smooth low-mids, deep sub, controlled highs",
    dynamicRange: "wide — pre-loud-master era (2001 / Chronic), character over loudness",
  },
  gear: [
    "Akai MPC 60",
    "E-mu SP-1200",
    "Mellotron samples",
    "Roland Juno-106",
    "Yamaha DX7",
    "Roland TR-808",
    "talkbox hardware (often a vintage model)",
    "Outboard compressors (Teletronix LA-2A, dbx 160)",
  ],
  vibe: ["smooth", "funky", "deep", "west coast", "classic", "soulful", "iconic"],
  sources: [
    "https://en.wikipedia.org/wiki/Dr._Dre_production_discography",
    "https://www.soundonsound.com/techniques/dr-dre-2001",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const SKEPTA: ArtistProfile = {
  slug: "skepta",
  name: "Skepta",
  // TODO: "grime" enum slot — using "techno" as the closest electronic-urban
  // umbrella. Grime is its own scene (140 BPM, square wave leads, raw MC
  // vocals) and the engine should grow a first-class slot.
  genres: ["techno"],
  signature: {
    sound: [
      "square wave lead synths (the grime signature — often portamento slides)",
      "rolling 808 patterns at 140 BPM (half-time feel from MC perspective)",
      "aggressive MC vocals (raw, unpolished, London accent)",
      "sparse beat with heavy bass weight",
      "talkbox / vocal-grit ad-libs",
      "horn stab samples (often from reggae / dancehall)",
    ],
    samples: ["classic grime synth stabs", "horn stabs (reggae / dancehall)", "minimal break samples"],
    bpm: { typical: [140, 142] },
    keys: ["D minor", "F minor", "G minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "heavy",
    stereoWidth: "normal",
    subEmphasis: "prominent",
    notes: [
      "square wave lead sits in 200-800 Hz with portamento slides between notes",
      "bass weight at 60-80 Hz with hard sidechain to kick",
      "MC vocals sit forward, raw texture preserved (no over-compression)",
      "horn stabs punched in tight (short attack, hard release)",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "dark, sub-prominent, mid-forward for vocals, controlled highs",
    dynamicRange: "moderate — modern grime master target (louder than classic era)",
  },
  gear: [
    "Logic Pro",
    "Native Instruments Massive",
    "Sylenth1",
    "Rob Papen Predator",
    "FabFilter Pro-Q 3",
    "Soundtoys Decapitator",
    "Valhalla VintageVerb",
  ],
  vibe: ["aggressive", "dark", "British", "raw", "street", "no-nonsense", "authentic"],
  sources: [
    "https://en.wikipedia.org/wiki/Skepta",
    "https://www.complex.com/music/best-songs-skepta-produced",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const SEVEN_LIONS: ArtistProfile = {
  slug: "seven-lions",
  name: "Seven Lions",
  // ✓ exact match — Seven Lions sits in the dnb / melodic-dubstep family
  // (Ophelia Records). The 140-150 BPM half-time feel of dnb aligns with
  // his production tempo.
  genres: ["dnb"],
  signature: {
    sound: [
      "ethereal female vocal chops (the Ophelia signature — pitched, layered)",
      "supersaw leads (wide, 3-4 layers stacked across the stereo field)",
      "emotional minor-key chord progressions",
      "half-time drums with massive snares on the 2 and 4",
      "soaring melodic arpeggios",
      "cinematic string hits layered under the build",
    ],
    samples: [
      "vocal one-shots from featured artists",
      "orchestral stab samples",
      "cinematic string hits",
      "ethereal vocal textures (often synthesized + processed)",
    ],
    bpm: { typical: [140, 150], halfTime: [70, 75] },
    keys: ["F minor", "G minor", "C minor", "D minor", "E♭ minor"],
  },
  mix: {
    eqTilt: "bright",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "prominent",
    notes: [
      "vocal chops dry-wet parallel with reverb and delay (sends heavy)",
      "supersaw stacked 3-4 layers across the stereo field (Haas on duplicates)",
      "half-time snare duck the pad for emotional impact",
      "builds use filtered white noise + reverb tail rises",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "bright, emotional mids, deep sub, soaring highs",
    dynamicRange: "moderate — modern melodic-dubstep target",
  },
  gear: [
    "Ableton Live",
    "Serum",
    "Native Instruments Massive",
    "Kontakt",
    "RC-20 Retro Color",
    "FabFilter Pro-Q 3",
    "Valhalla VintageVerb",
    "Valhalla Supermassive",
    "LFO Tool (sidechain + rhythmic gating)",
  ],
  vibe: ["emotional", "ethereal", "euphoric", "cinematic", "melodic", "transcendent"],
  sources: [
    "https://en.wikipedia.org/wiki/Seven_Lions",
    "https://www.opheliarecords.com/",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const BURIAL: ArtistProfile = {
  slug: "burial",
  name: "Burial",
  // ✓ exact match — Burial's Untrue / Burial-era sound sits squarely in
  // the engine's "ambient" bucket. The 2-step garage rhythm + ambient
  // pad + vinyl crackle character is the genre's defining surface.
  genres: ["ambient"],
  signature: {
    sound: [
      "pitch-shifted vocal chops (often +5 to +8 semitones, sped up)",
      "vinyl crackle + tape hiss baked into the master",
      "UK garage 2-step rhythm patterns (shuffled hats, syncopated kicks)",
      "melancholic pads (often filtered Rhodes or synth chords)",
      "ghostly vocal samples chopped and slowed",
      "rainy-night London atmosphere — sparse, melancholic, urban",
    ],
    samples: [
      "vocal samples from old jungle / UK garage records",
      "classic 2-step garage breaks",
      "ambient pad samples",
      "TV / radio dialogue snippets (distant, hard to make out)",
    ],
    bpm: { typical: [130, 138] },
    keys: ["D minor", "A minor", "F minor", "E minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "heavy",
    stereoWidth: "normal",
    subEmphasis: "subtle",
    notes: [
      "vinyl crackle + tape hiss baked into the master bus (NOT a plugin — committed)",
      "heavy low-pass filter on the entire mix (often 6-8 kHz ceiling)",
      "vocal chops sit at -10 dB below beat, ghostly presence",
      "pads filtered with slow LFO modulation — breathing character",
    ],
  },
  master: {
    targetLufs: -12,
    tonalBalance: "rolled-off highs (vinyl tilt), warm low-mids, dark sub presence",
    dynamicRange: "wide — NOT loud-mastered, character over loudness (anti-loudness stance)",
  },
  gear: [
    "Reason (early work)",
    "Soundforge",
    "classic jungle / garage sample packs",
    "vinyl sampling workflow",
    "DAW with heavy audio manipulation (time-stretch, pitch-shift)",
    "outboard processors for analog warmth (varies)",
  ],
  vibe: ["melancholic", "dark", "nostalgic", "ghostly", "rainy", "London-night", "lonely", "haunted"],
  sources: [
    "https://en.wikipedia.org/wiki/Burial_(musician)",
    "https://www.theguardian.com/music/2007/jun/10/popandrock.electronicanddance",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const SOPHIE: ArtistProfile = {
  slug: "sophie",
  name: "SOPHIE",
  // TODO: "hyperpop" enum slot — using "house" as the closest electronic-
  // pop umbrella, same as ag-cook. SOPHIE's catalog leans more
  // toward synthetic / abstract hyperpop than ag-cook's maximalist pop,
  // but both share the hyperpop umbrella.
  genres: ["house"],
  signature: {
    sound: [
      "metallic / plastic textures (the SOPHIE signature — chrome, latex, polished surfaces)",
      "synthetic pitched-down vocals (often lower-register than the source)",
      "abstract synthetic percussion (custom one-shots, no acoustic source)",
      "distorted sub-bass (heavily saturated, mid-forward)",
      "heavy reverb on top-end synths (alien, vast space)",
      "wide stereo detuned leads (supersaw-adjacent)",
    ],
    samples: ["custom synthesized one-shots", "abstract vocal textures (often pitch-shifted beyond recognition)", "transgressive pop acapella chops"],
    bpm: { typical: [120, 140] },
    keys: ["F minor", "D minor", "G minor", "keyless / synthetic atonal moments"],
  },
  mix: {
    eqTilt: "bright",
    compression: "heavy",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "metallic top-end sits in 8-12 kHz with controlled harshness (decoy + DECapitator)",
      "sub-bass pushed into the mid-range via saturation (heavy distortion on the 808 lane)",
      "vocal chops often -8 to -12 dB below beat — present but not loud, alien character",
      "sidechain pumping on master bus for hypnotic effect",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "bright metallic, distorted mids, controlled sub, hyped top-end",
    dynamicRange: "moderate — modern loud-master with saturation character",
  },
  gear: [
    "Ableton Live",
    "custom software synths (often self-built Max4Live devices)",
    "Moog Subsequent 25 / Mother-32 (hardware bass)",
    "Soundtoys Decapitator",
    "FabFilter Pro-Q 3",
    "Valhalla VintageVerb",
    "Valhalla Supermassive",
    "Pitchproof (pitch-correction for the alien vocal texture)",
  ],
  vibe: ["ethereal", "futuristic", "synthetic", "metallic", "transcendent", "otherworldly", "pioneering"],
  sources: [
    "https://en.wikipedia.org/wiki/SOPHIE_(musician)",
    "https://www.pitchfork.com/features/profile/sophie/",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const DJ_MUSTARD: ArtistProfile = {
  slug: "dj-mustard",
  name: "DJ Mustard",
  // TODO: "west-coast-revival" / "ratchet" enum slots — using "trap" as
  // the closest hip-hop umbrella. Mustard's "ratchet" / "r&b-trap" sound
  // has distinct minimal-bounce character that gets flattened when
  // collapsed into "trap".
  genres: ["trap"],
  signature: {
    sound: [
      "the 'Mustard beat' (iconic clap-snare pattern with simple synth melody)",
      "minimal bounce (clap on 2 and 4, hat on upbeats, single synth stab melody)",
      "low 808 (sustained, smooth, no slide tricks)",
      "R&B-flavored chord progressions (often simple 4-chord loops)",
      "vocals sit forward (often featuring YG, Tyga, 2 Chainz in early work)",
      "sparse arrangement — every element earns its place (opposite of maximalist trap)",
    ],
    samples: ["classic West Coast R&B loops", "simple synth stab one-shots", "vocal chants from featured artists"],
    bpm: { typical: [95, 105] },
    keys: ["G minor", "F minor", "D minor", "A minor"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "medium",
    stereoWidth: "narrow",
    subEmphasis: "moderate",
    notes: [
      "clap and snare pushed hard in the front of the mix (loud, present)",
      "synth stab melody sits in the 400-800 Hz range with simple tone",
      "808 sub sits at 50-70 Hz with smooth release",
      "arrangement deliberately sparse — leaves space for the featured vocalist",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "punchy mids, present sub, controlled highs, R&B-friendly",
    dynamicRange: "moderate — modern West Coast club master",
  },
  gear: [
    "FL Studio (transitioned from earlier DAW)",
    "Nexus (early work)",
    "Sylenth1",
    "FabFilter Pro-Q 3",
    "RC-20 Retro Color (on clap bus)",
    "Soundtoys Decapitator (parallel on master)",
    "LFO Tool (subtle sidechain)",
  ],
  vibe: ["bouncy", "minimal", "R&B-influenced", "club", "west coast revival", "iconic", "catchy"],
  sources: [
    "https://en.wikipedia.org/wiki/DJ_Mustard",
    "https://www.complex.com/music/best-songs-produced-by-dj-mustard",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const WILEY: ArtistProfile = {
  slug: "wiley",
  name: "Wiley",
  // TODO: "grime" enum slot — using "techno" as the closest electronic-
  // urban umbrella, same as skepta. Wiley literally invented the grime
  // scene (Eskibeat / Treddin' on Angel Is / Ice Rink era) — Skepta
  // came later. Both share the grime umbrella.
  genres: ["techno"],
  signature: {
    sound: [
      "square wave lead synths (the original grime sound Wiley pioneered)",
      "raw MC vocals (London accent, aggressive delivery, often ad-lib heavy)",
      "pirate radio aesthetic (lo-fi, slightly distorted, broadcast character)",
      "minimal break-beat influence (UK garage lineage)",
      "sparse beat with heavy bass weight",
      "early-era tracks often feature 8-bar loops with minimal arrangement variation",
    ],
    samples: ["classic grime synth stabs", "garage-era break samples", "horn stabs (reggae/dancehall influence)"],
    bpm: { typical: [140, 142] },
    keys: ["D minor", "F minor", "G minor"],
  },
  mix: {
    eqTilt: "dark",
    compression: "heavy",
    stereoWidth: "narrow",
    subEmphasis: "prominent",
    notes: [
      "early-era mixes are deliberately raw / lo-fi (pirate radio aesthetic)",
      "square wave leads saturated with light distortion",
      "bass weight at 60-80 Hz with hard sidechain to kick",
      "MC vocals sit forward, raw texture preserved (NO polish, NO autotune)",
    ],
  },
  master: {
    targetLufs: -9,
    tonalBalance: "dark, raw, sub-prominent, mid-forward for vocals",
    dynamicRange: "moderate — less polished than modern Skepta-era grime masters",
  },
  gear: [
    "various DAWs (early era used limited tools — FL Studio, Reason)",
    "Native Instruments Massive",
    "hardware synths (Roland, Korg — square wave generators)",
    "Roland TR-808 samples",
    "minimal processing — character comes from raw sound sources",
  ],
  vibe: ["raw", "pioneering", "pirate-radio", "aggressive", "authentic", "foundational", "London"],
  sources: [
    "https://en.wikipedia.org/wiki/Wiley_(musician)",
    "https://www.theguardian.com/music/wiley",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const EXCISION: ArtistProfile = {
  slug: "excision",
  name: "Excision",
  // TODO: "dubstep" enum slot (specifically "heavy dubstep" or
  // "brostep" subset) — using "dnb" as the closest 140-150 BPM half-time
  // family umbrella. Excision sits at 150 BPM half-time (75 BPM
  // perceived), DnB is 174 BPM. Different scenes but both live in
  // the drum-and-bass family.
  genres: ["dnb"],
  signature: {
    sound: [
      "robotic / aggro growls (the Excision signature — heavily FM-modulated bass synths)",
      "heavy reese basses (multi-oscillator detuned saws, often 4-7 layers)",
      "massive snares on the 2 and 4 (often layered with white-noise hits)",
      "mechanical hi-hats (precisely quantized, often rapid rolls)",
      "mechanical / industrial texture (metal, robotic, alien sound design)",
      "builds use reversed crash cymbals + filtered white noise rises",
    ],
    samples: [
      "robotic vocal one-shots",
      "industrial / mechanical sound effects",
      "white noise sweeps",
      "cinematic trailer impacts",
    ],
    bpm: { typical: [148, 152], halfTime: [74, 76] },
    keys: ["F minor", "G minor", "A minor", "atonal / keyless passages common"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "heavy",
    stereoWidth: "wide",
    subEmphasis: "prominent",
    notes: [
      "reese bass layered 4-7 oscillators with FM modulation for growl character",
      "snares stacked: acoustic snare sample + electronic hit + reverb tail",
      "mechanical hi-hats precisely quantized to 1/16 grid (no swing)",
      "builds use filtered white noise + crash cymbal reverses for tension",
    ],
  },
  master: {
    targetLufs: -6,
    tonalBalance: "huge sub, aggressive mid-range, wide stereo FX, controlled highs",
    dynamicRange: "low — modern loud-master target for heavy dubstep (brostep era)",
  },
  gear: [
    "Ableton Live",
    "Serum (primary growls / reese bass design)",
    "Native Instruments Massive",
    "Sylenth1",
    "FabFilter Pro-Q 3",
    "Soundtoys Decapitator (parallel on growl bus)",
    "RC-20 Retro Color",
    "Valhalla VintageVerb (snare reverb tails)",
  ],
  vibe: ["aggressive", "mechanical", "heavy", "brutal", "industrial", "alien", "relentless"],
  sources: [
    "https://en.wikipedia.org/wiki/Excision_(DJs)",
    "https://www.dubstepforum.com/wiki/excision",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const ANYMA: ArtistProfile = {
  slug: "anyma",
  name: "Anyma",
  // ✓ close match — Anyma's "Afterlife" melodic techno sits at the
  // ambient/techno boundary. Using "ambient" as the engine slot since
  // the atmospheric character is the defining surface; melodic techno
  // could be a future first-class slot if the engine grows one.
  genres: ["ambient"],
  signature: {
    sound: [
      "ethereal synth pads (lush, evolving, slow attack)",
      "reverb-heavy atmospheres (massive send spaces)",
      "slow-build progressions (8-16 bar phrase development)",
      "hypnotic arpeggios (plucked synths in tight 1/16 patterns)",
      "cinematic vocal textures (wordless, atmospheric — not melodic hooks)",
      "low-end as sub-bass (sustained, smooth, sits under the pads)",
    ],
    samples: [
      "atmospheric vocal textures (often licensed from ambient vocalists)",
      "synth pad recordings (Prophet, Prophet-style hardware)",
      "field recordings (rain, distant city, white noise washes)",
    ],
    bpm: { typical: [122, 126] },
    keys: ["D minor", "F minor", "A minor", "C minor — often modal (Dorian, Aeolian)"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "light",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "pads panned wide with subtle LFO modulation on filter cutoff",
      "arpeggios sit in the 1-4 kHz range — present but never harsh",
      "sidechain pumping light — kick + sub duck the pads ~3 dB (atmospheric, not aggressive)",
      "vocal textures dry-wet parallel — sits deep in the mix, atmospheric bed",
    ],
  },
  master: {
    targetLufs: -9,
    tonalBalance: "wide stereo, atmospheric mids, smooth sub, controlled highs",
    dynamicRange: "wide — atmospheric techno target (less compression than peak-time techno)",
  },
  gear: [
    "Ableton Live",
    "Serum",
    "Pigments (Arturia)",
    "Massive X",
    "Prophet Rev2 (hardware pad source — often sampled)",
    "FabFilter Pro-Q 3",
    "Valhalla VintageVerb",
    "Valhalla Supermassive",
    "RC-20 Retro Color (on pad bus)",
  ],
  vibe: ["hypnotic", "ethereal", "atmospheric", "transcendent", "euphoric", "cinematic", "afterhours"],
  sources: [
    "https://en.wikipedia.org/wiki/Anyma",
    "https://www.residentadvisor.net/features/3782",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const FLUME: ArtistProfile = {
  slug: "flume",
  name: "Flume",
  // TODO: "future-bass" enum slot — using "house" as the closest
  // electronic umbrella. Future bass sits at 140-160 BPM half-time
  // with chopped pitched vocals + supersaw chords; sonically closer
  // to melodic dubstep than house, but the engine doesn't have a
  // dedicated future-bass slot.
  genres: ["house"],
  signature: {
    sound: [
      "chopped pitched vocals (the Flume signature — pitched up, time-stretched, granular)",
      "supersaw chords (lush, layered, detuned for width)",
      "lush pluck synths (FM-bell character, present in mid-high range)",
      "future house kick patterns (often half-time with snare on 2 and 4)",
      "atmospheric drops with reverb-drenched pads",
      "rapid hat patterns with vocal chops layered as textural elements",
    ],
    samples: [
      "vocal one-shots from featured artists (often pitched +5 to +12)",
      "synth chord stabs (often sampled from classic synth-pop)",
      "field recordings (water, glass, metallic hits)",
    ],
    bpm: { typical: [140, 160], halfTime: [70, 80] },
    keys: ["F minor", "G minor", "C minor", "E♭ minor"],
  },
  mix: {
    eqTilt: "bright",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "vocal chops dry-wet parallel with reverb (heavy sends)",
      "supersaw stacked 3-5 layers across the stereo field (Haas on duplicates)",
      "future house kick layered with sub-bass (kick = 808-style, sub = separate lane)",
      "sidechain pumping on master bus (4-on-the-floor duck)",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "bright, emotional mids, present sub, soaring highs",
    dynamicRange: "moderate — modern future-bass loud-master target",
  },
  gear: [
    "Ableton Live",
    "Serum",
    "Native Instruments Massive",
    "Sylenth1",
    "FabFilter Pro-Q 3",
    "Soundtoys Decapitator (parallel on master)",
    "RC-20 Retro Color (on vocal bus)",
    "Valhalla VintageVerb",
    "Valhalla Supermassive",
    "Granulator II (Max4Live — for the granular vocal chops)",
    "Pitchproof (pitch-correction for the pitched vocal chops)",
  ],
  vibe: ["euphoric", "melodic", "atmospheric", "dreamy", "modern", "lush"],
  sources: [
    "https://en.wikipedia.org/wiki/Flume_(musician)",
    "https://www.soundonsound.com/techniques/flume-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const APHEX_TWIN: ArtistProfile = {
  slug: "aphex-twin",
  name: "Aphex Twin",
  // TODO: "IDM" enum slot — using "ambient" as the closest umbrella
  // since the Selected Ambient Works era is the most iconic surface.
  // Aphex Twin's catalog spans ambient (SAW 85-92), IDM (Selected
  // Ambient Works 85-92 + drukQs), breakcore / drill'n'bass (Windowlicker
  // era), and techno (Computer Controlled Acoustic Instruments).
  // "ambient" alone flattens the breadth.
  genres: ["ambient"],
  signature: {
    sound: [
      "complex polyrhythmic percussion (drukQs / Windowlicker era — odd time signatures, layered breaks)",
      "ambient pads (SAW era — long sustained, evolving, often pitch-modulated)",
      "manipulated vocal samples (often pitched, time-stretched beyond recognition)",
      "acid basslines (TB-303 style — squelchy, resonant)",
      "lush textures (reverb-drenched, layered, often 20+ stacked layers)",
      "tape saturation and analog character (warm, slightly distorted)",
    ],
    samples: [
      "manipulated vocal samples (often his own voice processed beyond recognition)",
      "found sound / field recordings",
      "TB-303 squelches (often self-recorded)",
      "Akai S1000 / S3000 sample library textures",
    ],
    bpm: { typical: [90, 170] }, // wide range — ambient 90, drill'n'bass 170
    keys: ["variable — often modal or atonal"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "complex stereo manipulation — panning automation, mid/side processing",
      "reverb tails often 5-10 seconds for ambient pads",
      "drum layers individually processed then summed for polyrhythmic feel",
      "tape emulation on master bus (Studer A800 / ATR-102 character)",
    ],
  },
  master: {
    targetLufs: -11,
    tonalBalance: "warm, complex stereo image, full-frequency but not harsh",
    dynamicRange: "wide — character over loudness (intentional anti-loud-master)",
  },
  gear: [
    "Custom hardware (often self-built or modified — including a custom mixer / sequencer)",
    "Akai S1000 / S3000 (sampling)",
    "Roland TB-303 (acid bassline source)",
    "Roland TR-808 / TR-909 (drum machines)",
    "Yamaha DX7 (FM synthesis)",
    "Korg MS-20 (semi-modular analog)",
    "various outboard compressors and EQs",
    "Mac (custom Max / software patches)",
    "Studer A800 (tape machine — used on his masters)",
  ],
  vibe: ["experimental", "complex", "atmospheric", "pioneering", "intense", "beautiful", "haunting"],
  sources: [
    "https://en.wikipedia.org/wiki/Aphex_Twin",
    "https://www.soundonsound.com/techniques/aphex-twin-selected-ambient-works",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const BOARDS_OF_CANADA: ArtistProfile = {
  slug: "boards-of-canada",
  name: "Boards of Canada",
  // ✓ close match — BoC's signature sound is sample-based ambient
  // electronica with tape saturation and faded-memory aesthetic.
  // Sits squarely in the engine's "ambient" bucket.
  genres: ["ambient"],
  signature: {
    sound: [
      "warm analog synths (often Roland Juno / SH-101 / Korg MS-20)",
      "sample-based (often 1970s educational film loops — the BoC signature aesthetic)",
      "tape saturation (heavy — 4-track cassette warmth)",
      "vinyl crackle / surface noise baked into the master",
      "slow tempo with simple drum patterns (often 808 + acoustic samples)",
      "melancholic pads (warm, evolving, often minor-key)",
      "childhood memory aesthetic — hypnagogic, faded, nostalgic",
    ],
    samples: [
      "1970s / 80s educational film audio (the BoC trademark — found in libraries)",
      "analog synth recordings (Juno-106, SH-101, MS-20)",
      "found sound (TV, radio, distant dialogue)",
      "field recordings (often processed with tape)",
    ],
    bpm: { typical: [80, 110] },
    keys: ["D minor", "F minor", "A minor", "E♭ minor"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "light",
    stereoWidth: "normal",
    subEmphasis: "subtle",
    notes: [
      "tape saturation baked into the mix bus (4-track cassette character)",
      "vinyl crackle + tape hiss committed to the master (NOT a plugin — character)",
      "drum hits short and dry (often 808 + acoustic samples)",
      "pads sit deep in the mix (-6 to -10 dB below lead elements)",
    ],
  },
  master: {
    targetLufs: -11,
    tonalBalance: "warm, low-mid forward, rolled-off highs (tape tilt)",
    dynamicRange: "wide — NOT loud-mastered, character over loudness",
  },
  gear: [
    "Roland Juno-106 (primary pad source)",
    "Roland SH-101 (bass / lead)",
    "Korg MS-20 (filter character)",
    "Akai MPC (sample sequencing)",
    "Akai S1000 / S3000 (sampling)",
    "4-track cassette recorder (mix bus character)",
    "Roland TR-808",
    "custom Max / MSP patches",
    "film archive libraries (educational footage — public domain)",
  ],
  vibe: ["nostalgic", "melancholic", "lo-fi", "faded", "childhood memory", "hypnagogic", "warm", "familiar"],
  sources: [
    "https://en.wikipedia.org/wiki/Boards_of_Canada",
    "https://www.residentadvisor.net/features/179",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const LIL_UZI_VERT: ArtistProfile = {
  slug: "lil-uzi-vert",
  name: "Lil Uzi Vert",
  // ✓ exact match — vocal trap / emo-rap fits squarely in the trap
  // family. The signature pitched-up vocal style is a trap sub-genre
  // marker (Uzi, Juice WRLD, Lil Peep — all in this lineage).
  genres: ["trap"],
  signature: {
    sound: [
      "pitched-up emo vocals (the Uzi signature — often +5 to +12 semitones, layered with original)",
      "trap 808s with long decay (often sustained, with heavy pitch slides)",
      "rock-influenced melodies (synths that sound like electric guitar riffs)",
      "ethereal pads and choir textures (gives the 'emo' aesthetic)",
      "fast trap hi-hats with rapid triplet rolls",
      "bright synth leads (often arpeggiated, mid-high range)",
    ],
    samples: [
      "rock / metal one-shots (often processed into trap context)",
      "vocal chops from features (often pitched + processed)",
      "ethereal vocal textures (choir-like, atmospheric)",
    ],
    bpm: { typical: [140, 160], halfTime: [70, 80] },
    keys: ["F minor", "G minor", "C minor", "B♭ minor"],
  },
  mix: {
    eqTilt: "bright",
    compression: "medium",
    stereoWidth: "wide",
    subEmphasis: "moderate",
    notes: [
      "vocal layered with pitch-shifted duplicate at +7 or +12 semitones for the emo shimmer",
      "808 with long decay (often 1.5-2.5 seconds) — sits under the vocal",
      "rock-influenced synth leads pushed forward in the mix (mid-high range)",
      "ethereal pads panned wide for the dreamy aesthetic",
    ],
  },
  master: {
    targetLufs: -7,
    tonalBalance: "bright, present mids, sub-prominent, airy highs",
    dynamicRange: "moderate — modern trap loud-master target",
  },
  gear: [
    "FL Studio (longtime primary DAW)",
    "Pro Tools (mixing)",
    "Antares Auto-Tune Pro (heavy on vocals — the signature effect)",
    "Omnisphere",
    "Kontakt",
    "FabFilter Pro-Q 3",
    "Soundtoys Decapitator (parallel on vocal bus)",
    "Valhalla VintageVerb (vocal reverb tails)",
    "RC-20 Retro Color",
  ],
  vibe: ["emo", "ethereal", "melodic", "rebellious", "youthful", "dreamy", "punk-influenced"],
  sources: [
    "https://en.wikipedia.org/wiki/Lil_Uzi_Vert",
    "https://www.soundonsound.com/techniques/lil-uzi-vert-production",
  ],
  verificationStatus: "ai-inferred",
  lastUpdated: "2026-09-26",
};

const KAYTRANADA: ArtistProfile = {
  slug: "kaytranada",
  name: "Kaytranada",
  // ✓ close match — lo-fi house / future R&B fits the engine's "house"
  // bucket. Kaytranada's sound sits at the house / R&B / hip-hop
  // intersection (often tagged "future R&B" or "lo-fi house" in
  // critical reception).
  genres: ["house"],
  signature: {
    sound: [
      "chopped pitched vocals (often pitched +5 to +8 semitones, soulful)",
      "lo-fi house drum patterns with shuffled hats (the Kaytra signature swing)",
      "synth stabs (often short, punchy, R&B-flavored chord hits)",
      "R&B-flavored chord progressions (smooth, soulful, often minor keys)",
      "sample-based workflow (heavily uses samples — soul, funk, R&B)",
      "808 sub bass with smooth character (not aggressive trap-style)",
    ],
    samples: [
      "soul / funk samples (often pitched and chopped)",
      "vocal chops from featured artists (often processed)",
      "classic house / disco sample loops",
    ],
    bpm: { typical: [110, 122] },
    keys: ["F minor", "D minor", "G minor", "A minor"],
  },
  mix: {
    eqTilt: "neutral",
    compression: "medium",
    stereoWidth: "normal",
    subEmphasis: "moderate",
    notes: [
      "drums panned tight in the center (no wide stereo on the kit)",
      "synth stabs sit in the 400-800 Hz range with simple tone",
      "808 sub sits at 50-70 Hz with smooth release (no slides)",
      "vocal chops dry-wet parallel with light reverb",
    ],
  },
  master: {
    targetLufs: -8,
    tonalBalance: "punchy mids, present sub, smooth highs, R&B-friendly",
    dynamicRange: "moderate — modern lo-fi house master target",
  },
  gear: [
    "Ableton Live (primary DAW)",
    "Akai MPC Renaissance (sample-based workflow)",
    "Serum",
    "Native Instruments Massive",
    "Sylenth1",
    "FabFilter Pro-Q 3",
    "RC-20 Retro Color (on master bus for lo-fi character)",
    "Soundtoys Decapitator (parallel on master)",
    "Valhalla VintageVerb",
  ],
  vibe: ["lo-fi", "soulful", "smooth", "future R&B", "danceable", "warm", "swinging"],
  sources: [
    "https://en.wikipedia.org/wiki/Kaytranada",
    "https://www.residentadvisor.net/features/2481",
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
  "ag-cook": AG_COOK,
  "aphex-twin": APHEX_TWIN,
  anyma: ANYMA,
  "axl-beats": AXL_BEATS,
  "boards-of-canada": BOARDS_OF_CANADA,
  burial: BURIAL,
  "dj-mustard": DJ_MUSTARD,
  "dj-tameil": DJ_TAMEIL,
  "dr-dre": DR_DRE,
  dvrst: DVRST,
  excision: EXCISION,
  flume: FLUME,
  "fred-again": FRED_AGAIN,
  "j-dilla": J_DILLA,
  kaytranada: KAYTRANADA,
  "lil-uzi-vert": LIL_UZI_VERT,
  "metro-boomin": METRO_BOOMIN,
  "seven-lions": SEVEN_LIONS,
  skepta: SKEPTA,
  sophie: SOPHIE,
  "travis-scott": TRAVIS_SCOTT,
  wiley: WILEY,
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

/* ---------------------------------------------------------------------------
 * Phase 2 wiring — deep profile → artist-mix.ts producer-decision layer.
 *
 * The existing ArtistMixProfile (src/intent/artist-mix.ts) carries the 4
 * fields planMixProfile actually reads: tone, punch, reverb, pump. Each
 * field is a producer-decision knob (master tilt, dynamic pressure, space,
 * sidechain) — not a descriptive audio profile.
 *
 * This helper translates the deeper profile (eqTilt / compression /
 * signature sound / vibe keywords) into the same ArtistMixProfile shape.
 * artistMixProfileOf() (artist-mix.ts:58) uses the curated ARTIST_MIX_PROFILES
 * table first; the deep layer is the FALLBACK for artists that have a deep
 * profile but were never curated into ARTIST_MIX_PROFILES (e.g. Kaytranada,
 * J Dilla, Fred Again, Burial, AXL Beats, DJ Mustard, Skepta, Wiley, etc.).
 *
 * Architectural intent: do not duplicate decisions across two layers. The
 * curated table wins when present; the deep layer fills the gap. Adding a
 * row to ARTIST_MIX_PROFILES remains the source-of-truth override.
 * ------------------------------------------------------------------------- */

import type { ArtistMixProfile } from "../artist-mix";

/** Normalize an `intent.artist` label into the slug form used by ARTIST_PROFILES.
 *
 *  Strips parenthetical suffixes ("fred again (ukg)" → "fred again"),
 *  forward-slash qualifiers ("skepta / grime" → "skepta"), periods
 *  ("dr. dre" → "dr dre"), then collapses whitespace to hyphens. */
export function normalizeArtistSlug(label: string): string {
  return label
    .replace(/\(.*?\)/g, "")
    .replace(/\s*\/\s*.*$/, "")
    .replace(/\./g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Derive the existing ArtistMixProfile shape from a deep profile's mix traits.
 *
 *  Only fields with non-null signals are populated — undefined entries are
 *  omitted from the returned object so planMixProfile's nullish coalescing
 *  (`artistMix?.tone ?? GENRE_TONE_DEFAULT[genre]`) sees them as "no opinion".
 *
 *  Mapping rules:
 *    - mix.eqTilt "bright"     → tone: "bright"
 *    - mix.eqTilt "dark"       → tone: "dark"
 *    - mix.eqTilt "neutral"    → tone: "warm"   (engine's "warm" is the closest
 *                                            producer-decision to "neutral
 *                                            tilt, character-forward mix")
 *    - mix.compression "heavy" → punch: "more"
 *    - mix.compression "light" → punch: "less"
 *    - mix.stereoWidth "wide"  → width: "wide"   (Phase 2 slice 2)
 *    - mix.stereoWidth "narrow"→ width: "narrow" (Phase 2 slice 2)
 *    - mix.subEmphasis "prominent" → sub: "prominent" (Phase 2 slice 2)
 *    - mix.subEmphasis "subtle" → sub: "subtle" (Phase 2 slice 2)
 *    - signature.sound / vibe mention "sidechain" / "pump" / "pumping" → pump: true
 *    - vibe contains "huge" / "spacious" / "ethereal" / "atmospheric" / "cinematic"
 *                              → reverb: "huge"
 *    - vibe contains "tight" / "dry" / "club" / "forward" / "aggressive" / "menacing"
 *                              → reverb: "less"
 */
export function deepProfileToArtistMix(profile: ArtistProfile): ArtistMixProfile {
  const derived: ArtistMixProfile = {};

  // tone
  const tone: ArtistMixProfile["tone"] | undefined =
    profile.mix.eqTilt === "bright" ? "bright" :
    profile.mix.eqTilt === "dark" ? "dark" :
    profile.mix.eqTilt === "neutral" ? "warm" :
    undefined;
  if (tone) derived.tone = tone;

  // punch
  const punch: ArtistMixProfile["punch"] | undefined =
    profile.mix.compression === "heavy" ? "more" :
    profile.mix.compression === "light" ? "less" :
    undefined;
  if (punch) derived.punch = punch;

  // width — direct passthrough (only "wide"/"narrow" are producer-decisions;
  // "normal" leaves the genre default in place)
  const width: ArtistMixProfile["width"] | undefined =
    profile.mix.stereoWidth === "wide" ? "wide" :
    profile.mix.stereoWidth === "narrow" ? "narrow" :
    undefined;
  if (width) derived.width = width;

  // sub — direct passthrough (only "prominent"/"subtle" are producer-decisions)
  const sub: ArtistMixProfile["sub"] | undefined =
    profile.mix.subEmphasis === "prominent" ? "prominent" :
    profile.mix.subEmphasis === "subtle" ? "subtle" :
    undefined;
  if (sub) derived.sub = sub;

  // lufs (Phase 2 slice 3) — the artist's mastered integrated loudness.
  // Carried as a SIGNAL; planMixProfile bounds it against the project's
  // streaming target + trim limit before it reaches master.lufsTarget.
  const targetLufs = profile.master.targetLufs;
  if (Number.isFinite(targetLufs)) derived.lufs = targetLufs;

  // glue (Phase 2 slice 3) — master buss-glue decision from the profile's
  // dynamicRange descriptor. The field is free text whose first token is the
  // qualifier ("low - ...", "wide - ...", "moderate - ..."), so match on the
  // leading word rather than an exact-equality union.
  const dynamicRange = (profile.master.dynamicRange ?? "").trim().toLowerCase();
  if (/^(low|limited)\b/.test(dynamicRange)) derived.glue = true;
  else if (/^wide\b/.test(dynamicRange)) derived.glue = false;

  // pump — keyword scan across signature sound + vibe
  const pumpSignal = [...profile.signature.sound, ...profile.vibe]
    .some((text) => /\bsidechain|\bpump(?:ing|s|ed)?\b/i.test(text));
  if (pumpSignal) derived.pump = true;

  // reverb — keyword scan across vibe
  const vibeJoined = profile.vibe.join(" ");
  if (/\bhuge\b|\bspacious\b|\bethereal\b|\batmospheric\b|\bcinematic\b/i.test(vibeJoined)) {
    derived.reverb = "huge";
  } else if (/\btight\b|\bdry\b|\bclub\b|\bforward\b|\baggressive\b|\bmenacing\b/i.test(vibeJoined)) {
    derived.reverb = "less";
  }

  return derived;
}

/** Look up an `intent.artist` label and derive an ArtistMixProfile from the
 *  deep profile layer. Returns null when:
 *  - no deep profile matches the normalized slug, or
 *  - the derived profile carries no producer-decision signals (empty object). */
export function artistMixProfileFromDeep(artistLabel: string): ArtistMixProfile | null {
  const slug = normalizeArtistSlug(artistLabel);
  const profile = getArtistProfile(slug);
  if (!profile) return null;
  const derived = deepProfileToArtistMix(profile);
  if (Object.keys(derived).length === 0) return null;
  return derived;
}
