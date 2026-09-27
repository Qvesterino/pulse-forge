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
  dnb: ["drum and bass", "dnb", "jungle", "neurofunk", "liquid dnb"],
  hyperpop: ["hyperpop", "hyper pop", "maximalist pop", "deconstructed club"],
  ukg: ["UK garage", "ukg", "2-step", "speed garage"],
  drill: ["drill", "drill beat", "sliding 808", "dark drill"],
  phonk: ["phonk", "memphis phonk", "drift phonk", "cowbell phonk"],
  jersey: ["jersey club", "brick city club", "bounce club", "jersey bounce"],
  boombap: ["boom bap", "boombap", "hip-hop", "90s rap", "golden era"],
  amapiano: ["amapiano", "yanos", "log drum", "South African house"],
  trance: ["trance", "uplifting", "psytrance", "supersaw"],
  detroit: ["detroit techno", "detroit electro", "machine funk", "808 talk"],
};

const STYLE_SYNONYMS: Record<string, string[]> = {
  driving: ["driving", "driving beat", "steady drive", "rolling energy"],
  minimal: ["minimal", "stripped back", "less is more", "clean minimal"],
  funky: ["funky", "funky groove", "groovy", "swinging"],
  deep: ["deep", "deep and dubby", "sub-heavy", "warm and round"],
  ukg: ["UKG", "UK garage", "two-step", "speed garage"],
  hyper: ["hyper", "hyperpop", "maximalist", "stuttering"],
  rage: ["rage", "rage beat", "distorted rage", "opium rage"],
  golden: ["golden era", "90s breakbeat", "premier-style", "dusty loops"],
  jazz: ["jazz rap", "jazzy", "upright bass", "smoky jazz"],
  lofi: ["lo-fi", "off-kilter", "dilla-style", "drunk drums"],
  drumless: ["drumless", "sample-only", "no drums", "loop-driven"],
  trapbap: ["trap bap", "trap-bap", "808 boom bap", "hybrid boom bap"],
  modern: ["modern boom bap", "griselda-style", "dusty trap", "cinematic loop"],
  yanos: ["yanos", "log drum", "Kabza-style", "deep amapiano"],
  soulful: ["soulful amapiano", "private school piano", "mellow log drum", "jazz chords"],
  sgija: ["s'gija", "sgija", "stripped amapiano", "hypnotic log"],
  bacardi: ["bacardi", "new age bacardi", "Pretoria bacardi", "raw stabs"],
  quantum: ["quantum sound", "taxi kick", "gqom 2.0", "re-edit energy"],
  popiano: ["popiano", "pop amapiano", "Tyla-style", "bright log drum"],
  afro: ["afro", "afrobeat", "tribal", "organic percussion"],
  industrial: ["industrial", "harsh", "metallic", "warehouse industrial"],
  dub: ["dubby", "dub techno", "space echo", "echoes"],
  // Trance school tree — the trance-specific tokens sit ABOVE the techno
  // `acid` entry so "acid trance" never renders as a plain 303 line.
  uplifting: ["uplifting trance", "anthem trance", "euphoric build", "supersaw lead"],
  progressive: ["progressive trance", "prog trance", "deep rolling trance", "long build"],
  psy: ["psytrance", "psy trance", "goa", "full-on"],
  tech: ["tech trance", "warehouse trance", "hard rolling trance", "metallic trance"],
  dream: ["dream trance", "piano trance", "euphoric piano", "soft trance"],
  belleville: ["belleville", "first wave detroit", "808 syncopation", "tom talk"],
  secondwave: ["underground resistance", "second wave", "militant techno", "stripped machine"],
  technobass: ["techno bass", "detroit bass", "808 pressure", "machine bass"],
  electro: ["electro", "classic electro", "cybotron", "vocoder funk"],
  ghettotech: ["ghettotech", "detroit booty", "fast 808", "raw machine"],
  acid: ["acid", "303 acid", "acid lines", "squelchy acid"],
  classic: ["classic", "golden era", "timeless", "traditional"],
  rolling: ["rolling", "rolling energy", "rolling bass", "rolling grooves"],
  sparse: ["sparse", "spacious", "minimal elements", "space between notes"],
  bouncy: ["bouncy", "bouncy energy", "jumping", "playful bounce"],
  drifting: ["drifting", "floating", "weightless", "slow drift"],
  glitch: ["glitchy", "glitch textures", "stuttering", "micro-edits"],
  organic: ["organic", "natural textures", "earthy", "living sound"],
  pianohouse: ["piano house", "piano-led", "piano stabs", "bright piano groove"],
  midtempo: ["midtempo", "half-time bass", "slow bass drop", "half-time stomp"],
  breakbeat: ["breakbeat", "big beat", "breaks", "chopped break"],
  sadchill: ["sad chill", "emotional lo-fi", "melancholic beat", "late-night sad"],
  dirtyambient: ["dirty ambient", "corroded textures", "decaying room", "tape-degraded"],
  liquid: ["liquid", "liquid grooves", "silky rollers", "smooth summer liquid"],
  jumpup: ["jump up", "jump-up", "filthy jump up", "wobbly party jump up"],
  neuro: ["neuro", "neurofunk", "reese-driven", "tearout neuro bass"],
  roller: ["rollers", "roller groove", "steppy rollers", "deep minimal rollers"],
  amen: ["amen", "amen breaks", "chopped breaks", "jungle breaks"],
  dancefloor: ["dancefloor", "festival dnb", "mainstage energy", "party anthem"],
  twostep: ["two-step", "two step", "steppy stepper", "swing stepper"],
  jungle: ["jungle", "ragga jungle", "rudeboy pressure", "dancehall jungle"],
  bounce: ["bounce", "nola bounce", "triggerman bounce", "call-and-response bounce"],
  miamibass: ["miami bass", "booty bass", "bass-heavy miami", "808 booty bounce"],
  snap: ["snap", "snap music", "ringtone snap", "finger-snap minimal"],
  afroswing: ["afroswing", "afro swing", "uk afroswing", "mellow afro bounce"],
  countrytune: ["country tune", "country rap", "country trap", "bluesy country rap"],
  // Vocabulary-gap depth lanes (docs/VOCABULARY-GAP-RESEARCH.md) — training
  // text for the lanes whose phrases landed before their dedicated grooves.
  synthwave: ["synthwave", "outrun", "retrowave", "darksynth", "night drive"],
  futuregarage: ["future garage", "duskus school", "chopped vocal garage", "rainy garage"],
  altrock: ["alt rock", "shoegaze", "dream pop", "wall of guitars", "post-rock crescendo"],
  broken: ["broken beat", "nu jazz", "West London broken", "UK jazz renaissance"],
  hard: ["hard", "gabber", "hardcore techno", "uptempo", "150+ hard"],
  hardstyle: ["hardstyle", "reverse bass", "euphoric hardstyle", "screech lead"],
  lofimap: ["lo-fi trap", "lo-fi map", "dusty trap", "warped sample trap"],
  ambienttechno: ["ambient techno", "deep space techno", "Berlin ambient", "hypnotic pads"],
  techhouse: ["tech house", "warehouse groove", "rolling tech house", "club tool"],
  // P2 dedicated lanes (the wave that closed the closest-fit mappings).
  triphop: ["trip-hop", "downtempo", "dusty samples", "Bonobo lane", "halftime haze"],
  gabber: ["gabber", "hardcore techno", "uptempo", "160-180 stomp", "distorted kick"],
  shoegaze: ["shoegaze", "wall of guitars", "dream pop", "buried drums", "wash of reverb"],
  reggae: ["reggae", "one drop", "roots", "ska skank", "dub delays"],
  bassdubstep: ["bass dubstep", "brostep", "tearout", "drop-era", "machine-gun hats"],
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
  dnb: ["at 174", "at 176", "at 172", "breakneck tempo"],
  drill: ["at 142", "at 145", "at 140", "sliding tempo"],
  phonk: ["at 145", "at 150", "at 130", "drift tempo"],
  jersey: ["at 140", "at 138", "at 135", "bounce tempo"],
  ukg: ["at 132", "at 134", "at 130", "shuffle tempo"],
  hyperpop: ["at 150", "at 160", "at 140", "glitch tempo"],
  pianohouse: ["at 126", "at 124", "at 128", "piano tempo"],
  midtempo: ["at 100", "at 95", "at 105", "half-time tempo"],
  breakbeat: ["at 132", "at 136", "at 128", "breaks tempo"],
  sadchill: ["at 80", "at 75", "at 85", "sad tempo"],
  dirtyambient: ["at 70", "at 65", "at 80", "degraded tempo"],
  trance: ["at 138", "at 140", "at 136", "euphoric tempo"],
  synthwave: ["at 105", "at 110", "at 100", "night-drive tempo"],
  altrock: ["at 110", "at 120", "at 100", "wall-of-sound tempo"],
  hard: ["at 160", "at 170", "at 155", "hard tempo"],
  hardstyle: ["at 152", "at 150", "at 155", "reverse-bass tempo"],
  triphop: ["at 90", "at 85", "at 95", "dusty halftime tempo"],
  gabber: ["at 170", "at 175", "at 165", "gabber stomp tempo"],
  shoegaze: ["at 110", "at 105", "at 115", "wall-of-guitars tempo"],
  reggae: ["at 75", "at 80", "at 70", "one-drop tempo"],
  bassdubstep: ["at 145", "at 150", "at 140", "drop tempo"],
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
