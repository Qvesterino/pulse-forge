/**
 * PRODUCER PERSONAS (AI Producer Sessions — killer-feature wave) — curated
 * producer identities for the Session Theatre: the user "hires" 2–3 of them
 * and watches each build its own take of the brief in a split view.
 *
 * DESIGN CONTRACT:
 * - DETERMINISTIC: same brief + same persona → same flavored prompt + same
 *   seed (AGENTS invariant #4). The persona only RECOLORS the user's brief
 *   — it never overrides explicit section requests or keys.
 * - Data only, no engine coupling: a persona is a PROMPT FLAVOR + ranking
 *   biases, applied through the existing compose pipeline (composeFullTrack
 *   with seed + input patch).
 * - Every persona is grounded in an existing engine genre + a real artist
 *   preset family (622-strong bank) — no invented vocabulary.
 */

export interface ProducerPersona {
  slug: string;
  name: string;
  /** One-line bio for the theatre card. */
  tagline: string;
  /** Engine genre this producer lives in. */
  genre: string;
  /** Emoji avatar for the theatre strip. */
  avatar: string;
  /** Flavor phrase appended to the user's brief (prompt recolor). */
  flavorPhrase: string;
  /** Extra prompt words steering FX/mix character. */
  mixWords: string;
  /** Energy/density nudges (0..1) layered over the user's brief defaults. */
  energyBias: number;
  densityBias: number;
  /** Deterministic seed suffix — different producers never share seeds. */
  seedTag: string;
}

export const PRODUCER_PERSONAS: readonly ProducerPersona[] = [
  {
    slug: "katarina-afterhours",
    name: "Katarína — Afterhours",
    tagline: "Deep rolling lows, long breaths, lights-off groove",
    genre: "techno",
    avatar: "🌃",
    flavorPhrase: "deep rolling afterhours groove, long tension, sparse top end",
    mixWords: "dark tilt, tight reverb, controlled punch",
    energyBias: -0.05,
    densityBias: -0.1,
    seedTag: "kat",
  },
  {
    slug: "marek-bounce",
    name: "Marek — Bounce Dept.",
    tagline: "Jersey bounce, club percussion, everything snaps",
    genre: "jersey",
    avatar: "🥁",
    flavorPhrase: "jersey club bounce, kicked five-oh, chant-ready top",
    mixWords: "bright tilt, snappy transients, forward vocals",
    energyBias: 0.15,
    densityBias: 0.15,
    seedTag: "mar",
  },
  {
    slug: "eva-reese",
    name: "Eva — Reese & Rain",
    tagline: "dnb rollers, Reese weight, rain-soaked atmospheres",
    genre: "dnb",
    avatar: "🌧",
    flavorPhrase: "rolling dnb breaks, Reese bass weight, rainy pad wash",
    mixWords: "wide reverb, soft clip glue, sub-forward",
    energyBias: 0.1,
    densityBias: 0.05,
    seedTag: "eva",
  },
  {
    slug: "dusan-dust",
    name: "Dušan — Dust Tape",
    tagline: "Boom-bap dust, tape hiss, wrong-in-the-right-way swings",
    genre: "boombap",
    avatar: "📼",
    flavorPhrase: "dusty boom-bap swing, tape saturation, vinyl breath",
    mixWords: "warm tilt, loose glue, vinyl noise bed",
    energyBias: -0.1,
    densityBias: 0,
    seedTag: "dus",
  },
  {
    slug: "leo-lullaby",
    name: "Leo — Lullaby Engine",
    tagline: "Ambient bloom, everything fading like a sunset",
    genre: "ambient",
    avatar: "🌅",
    flavorPhrase: "ambient bloom, slow swells, no drums rushing anywhere",
    mixWords: "soft tilt, hall reverb, gentle top",
    energyBias: -0.2,
    densityBias: -0.15,
    seedTag: "leo",
  },
  {
    slug: "petra-punch",
    name: "Petra — Punchline",
    tagline: "Trap drums that hit like headlines, 808 slides for days",
    genre: "trap",
    avatar: "📰",
    flavorPhrase: "modern trap drums, sliding 808s, sparse menacing lead",
    mixWords: "dark tilt, hard-limited punch, sub weight",
    energyBias: 0.1,
    densityBias: -0.05,
    seedTag: "pet",
  },
];

/** Deterministic persona lookup (slug → persona). Unknown slugs → null. */
export function personaBySlug(slug: string): ProducerPersona | null {
  return PRODUCER_PERSONAS.find((persona) => persona.slug === slug) ?? null;
}

/** Default theatre cast: the first three personas (variety of genres). */
export function defaultCast(): readonly ProducerPersona[] {
  return [PRODUCER_PERSONAS[0], PRODUCER_PERSONAS[1], PRODUCER_PERSONAS[2]];
}
