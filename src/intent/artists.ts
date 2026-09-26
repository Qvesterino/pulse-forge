import type { ProductionProfile } from "../project-model/types";
import type { IntentGenre } from "./types";

/**
 * ARTIST "TYPE BEAT" ALIAS DICTIONARY (INTENT_ENGINE.md C1) — the beat-maker
 * language. "travis scott type beat" is how the world asks for a beat; this
 * registry maps well-known references to OUR canonical vocabulary
 * (genre + existing groove style + composition profile + mood/sliders/BPM prior).
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
  productionProfile?: ProductionProfile;
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
    productionProfile: "dark-atmospheric-trap",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 140],
    label: "travis scott",
  },
  {
    names: ["kid cudi", "cudi", "kid cudi type beat"],
    genre: "trap",
    style: "lux",
    productionProfile: "spacey-melodic-rap",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [118, 128],
    label: "kid cudi",
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
  // ── west coast / g-funk (researched pocket: Still D.R.E. ~93, G Thang /
  // Gin and Juice / Regulate ~95 — all mapped to the trap.headnod /
  // trap.gfunk grooves) ───────────────────────────────────────────────────
  {
    names: ["snoop", "snoop dogg", "snoop type beat", "doggy style", "doggystyle"],
    genre: "trap",
    style: "headnod",
    mood: "chill",
    energy: 0.55,
    density: 0.55,
    bpmRange: [92, 96],
    label: "snoop dogg",
  },
  {
    names: ["dre", "dr dre", "dr. dre", "dre type beat", "chronic", "2001"],
    genre: "trap",
    style: "gfunk",
    mood: "dark",
    energy: 0.6,
    density: 0.55,
    bpmRange: [93, 96],
    label: "dr. dre",
  },
  {
    names: ["warren g", "warren", "regulate", "nate dogg", "nate"],
    // Regulate (Warren G ft. Nate Dogg) — same 95 BPM pocket, one entry
    // serves both names; the sung-hook feel is the groove's laid-back snare.
    genre: "trap",
    style: "headnod",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [94, 96],
    label: "warren g & nate dogg",
  },
  {
    names: ["ty dolla", "ty dolla sign", "ty dolla $ign", "ty$", "modern west"],
    // Modern west coast: a touch faster and harder than the 90s pocket.
    genre: "trap",
    style: "gfunk",
    mood: "energetic",
    energy: 0.65,
    density: 0.6,
    bpmRange: [95, 105],
    label: "ty dolla $ign",
  },
  // ── house / club ────────────────────────────────────────────────────────
  {
    names: ["fred again type beat", "fred again.. type", "actual life"],
    // The Actual Life sound: choppy UKG-influenced house, emotional vocal
    // cuts, punchy low end — lands on ukg grooves with driving energy.
    // Listed BEFORE the plain-name preset so the "type beat" phrasing
    // (the beat-maker language) wins the first-match order.
    genre: "house",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.65,
    bpmRange: [130, 145],
    label: "fred again (ukg)",
  },
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
    names: ["suicideboys", "suicide boys", "$uicideboy$", "g59", "grey 59"],
    // NOLA horrorcore: dark sparse trap with memphis phonk DNA — the darkest
    // corner of our vocab on purpose
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.45,
    bpmRange: [130, 150],
    label: "suicideboys",
  },
  {
    names: ["macky gee", "mackie gee"],
    // Jump-up / dancefloor DNB — punchy rollers, festival energy
    genre: "dnb",
    style: "jumpup",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 177],
    label: "macky gee",
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
  {
    names: ["duskus", "duskus type beat"],
    // Duskus: future garage / melodic bass — atmospheric halftime, mellow
    // but driving. Ambient carries it; the style phrase refines the drums.
    genre: "ambient",
    style: "future garage",
    mood: "deep",
    energy: 0.55,
    density: 0.45,
    bpmRange: [130, 140],
    label: "duskus (future garage)",
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
  // ── world-roster wave (BPM ranges researched: mixgraph.io, beatport.com,
  //    tunebat.com, r/DnB consensus, type-beat marketplace listings) ────────
  {
    names: ["adam beyer", "drumcode"],
    genre: "techno",
    style: "driving",
    energy: 0.8,
    density: 0.65,
    bpmRange: [130, 138],
    label: "drumcode techno",
  },
  {
    names: ["enrico sangiuliano"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [128, 136],
    label: "sangiuliano",
  },
  {
    names: ["klangkuenstler", "klangkuenstler type beat"],
    genre: "techno",
    style: "industrial",
    mood: "aggressive",
    energy: 0.95,
    density: 0.75,
    bpmRange: [145, 155],
    label: "klang techno",
  },
  {
    names: ["hi-lo", "hi lo"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.85,
    density: 0.7,
    bpmRange: [136, 144],
    label: "hi-lo",
  },
  {
    names: ["kobosil"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.8,
    density: 0.6,
    bpmRange: [138, 146],
    label: "kobosil",
  },
  {
    names: ["four tet", "fourtet"],
    genre: "house",
    style: "organic",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [122, 128],
    label: "four tet",
  },
  {
    names: ["bicep"],
    genre: "house",
    style: "deep",
    energy: 0.6,
    density: 0.55,
    bpmRange: [122, 128],
    label: "bicep",
  },
  {
    names: ["jamie xx"],
    genre: "house",
    style: "ukg",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [120, 128],
    label: "jamie xx",
  },
  {
    names: ["ben bohmer", "ben böhmer"],
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [118, 124],
    label: "ben bohmer",
  },
  {
    names: ["young thug", "young thug type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [130, 142],
    label: "young thug",
  },
  {
    names: ["don toliver", "don toliver type beat"],
    genre: "trap",
    style: "sparse",
    mood: "dark",
    energy: 0.55,
    density: 0.45,
    bpmRange: [118, 128],
    label: "don toliver",
  },
  {
    names: ["lil uzi vert", "uzi vert", "lil uzi type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [140, 152],
    label: "lil uzi",
  },
  {
    names: ["trippie redd"],
    genre: "trap",
    style: "rolling",
    mood: "dark",
    energy: 0.7,
    density: 0.5,
    bpmRange: [140, 150],
    label: "trippie redd",
  },
  {
    names: ["moondeity", "moon deity"],
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.6,
    bpmRange: [150, 160],
    label: "moondeity",
  },
  {
    names: ["dvrst"],
    genre: "phonk",
    style: "drift",
    mood: "energetic",
    energy: 0.8,
    density: 0.55,
    bpmRange: [140, 150],
    label: "dvrst",
  },
  {
    names: ["chase & status", "chase and status"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.85,
    density: 0.7,
    bpmRange: [172, 176],
    label: "chase & status",
  },
  {
    names: ["bou"],
    genre: "dnb",
    style: "roller",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "bou",
  },
  {
    names: ["1991", "ninety one"],
    genre: "dnb",
    style: "jumpup",
    mood: "energetic",
    energy: 0.88,
    density: 0.68,
    bpmRange: [172, 178],
    label: "1991",
  },
  {
    names: ["calibre"],
    genre: "dnb",
    style: "liquid",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [170, 174],
    label: "calibre",
  },

  // ── bedroom pop (DIY, intimate, 80-120 BPM) ───────────
  {
    names: ["clairo", "clairo type beat"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.35,
    density: 0.4,
    bpmRange: [75, 110],
    label: "clairo",
  },
  {
    names: ["rex orange county", "rex orange"],
    genre: "house",
    style: "deep",
    mood: "energetic",
    energy: 0.55,
    density: 0.45,
    bpmRange: [100, 130],
    label: "rex orange county",
  },
  {
    names: ["mac demarco", "mac demarco type beat"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.3,
    density: 0.35,
    bpmRange: [80, 100],
    label: "mac demarco",
  },
  {
    names: ["beabadoobee", "bea type beat"],
    genre: "ambient",
    style: "drifting",
    energy: 0.4,
    density: 0.4,
    bpmRange: [70, 120],
    label: "beabadoobee",
  },
  // ── lo-fi house (tape saturation, hazy nostalgia) ─────
  {
    names: ["dj seinfeld", "dj seinfeld type beat"],
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [110, 125],
    label: "dj seinfeld",
  },
  {
    names: ["ross from friends", "ross fm"],
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [110, 125],
    label: "ross from friends",
  },
  {
    names: ["mall grab"],
    genre: "house",
    style: "minimal",
    mood: "chill",
    energy: 0.45,
    density: 0.4,
    bpmRange: [110, 125],
    label: "mall grab",
  },
  // ── UK bass / breaks ──────────────────────────────────
  {
    names: ["overmono", "overmono type beat"],
    genre: "house",
    style: "ukg",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 140],
    label: "overmono",
  },
  // ── future bass / dubstep ─────────────────────────────
  {
    names: ["flume", "flume type beat"],
    genre: "trap",
    style: "lux",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [130, 150],
    label: "flume",
  },
  {
    names: ["skrillex", "skrillex type beat"],
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [138, 145],
    label: "skrillex",
  },
  // ── trip-hop ──────────────────────────────────────────
  {
    names: ["portishead", "portishead type beat"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.25,
    density: 0.35,
    bpmRange: [70, 90],
    label: "portishead",
  },
  {
    names: ["massive attack", "massive attack type beat"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.3,
    density: 0.4,
    bpmRange: [80, 100],
    label: "massive attack",
  },
  // ── post-punk / punk (motorik root of industrial techno) ──
  {
    names: ["joy division", "joy division type beat"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 135],
    label: "joy division",
  },
  {
    names: ["interpol", "interpol type beat"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [120, 135],
    label: "interpol",
  },
  {
    names: ["the cure", "the cure type beat"],
    genre: "techno",
    style: "driving",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [125, 150],
    label: "the cure",
  },
  {
    names: ["idles", "idles type beat"],
    genre: "techno",
    style: "industrial",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [140, 160],
    label: "idles",
  },
  {
    names: ["fontaines dc", "fontaines dc type beat"],
    genre: "techno",
    style: "industrial",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [140, 155],
    label: "fontaines dc",
  },
  {
    names: ["turnstile", "turnstile type beat"],
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.95,
    density: 0.75,
    bpmRange: [140, 170],
    label: "turnstile",
  },

  // ── drone / deep ambient (40-70 BPM or beatless — the slowest corner) ──
  {
    names: ["stars of the lid", "stars of the lid type beat"],
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.15,
    density: 0.25,
    bpmRange: [40, 65],
    label: "stars of the lid",
  },
  {
    names: ["tim hecker", "tim hecker type beat"],
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.2,
    density: 0.3,
    bpmRange: [45, 70],
    label: "tim hecker",
  },
  {
    names: ["william basinski", "basinski", "disintegration loops"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.15,
    density: 0.25,
    bpmRange: [40, 60],
    label: "basinski",
  },
  {
    names: ["grouper", "grouper type beat"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.2,
    density: 0.25,
    bpmRange: [40, 65],
    label: "grouper",
  },
  {
    names: ["thomas koner", "thomas köner"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.15,
    density: 0.2,
    bpmRange: [40, 60],
    label: "thomas koner",
  },
  // ── experimental / IDM / deconstructed club ───────────
  {
    names: ["autechre", "autechre type beat"],
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.6,
    density: 0.65,
    bpmRange: [120, 160],
    label: "autechre",
  },
  {
    names: ["arca", "arca type beat"],
    genre: "trap",
    style: "hyper",
    mood: "dark",
    energy: 0.8,
    density: 0.65,
    bpmRange: [100, 140],
    label: "arca",
  },
  {
    names: ["sophie", "sophie type beat", "pc music"],
    genre: "trap",
    style: "hyper",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [120, 140],
    label: "sophie",
  },
  {
    names: ["oneohtrix point never", "opn", "oneohtrix"],
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.4,
    density: 0.5,
    bpmRange: [80, 130],
    label: "opn",
  },
  {
    names: ["fennesz", "fennesz type beat"],
    genre: "ambient",
    style: "glitch",
    mood: "chill",
    energy: 0.2,
    density: 0.3,
    bpmRange: [50, 80],
    label: "fennesz",
  },
  {
    names: ["2814", "vaporwave", "vaporwave type beat"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.3,
    density: 0.35,
    bpmRange: [60, 90],
    label: "vaporwave",
  },
  // ── Berlin School / krautrock (analog sequencer 80-120) ──
  {
    names: ["tangerine dream", "tangerine dream type beat", "phaedra"],
    genre: "techno",
    style: "melodic",
    mood: "chill",
    energy: 0.45,
    density: 0.5,
    bpmRange: [80, 120],
    label: "tangerine dream",
  },
  {
    names: ["klaus schulze", "klaus schulze type beat"],
    genre: "techno",
    style: "minimal",
    mood: "dark",
    energy: 0.35,
    density: 0.4,
    bpmRange: [80, 110],
    label: "klaus schulze",
  },
  {
    names: ["manuel gotttsching", "manuel gottsching", "ash ra tempel", "e2-e4"],
    genre: "house",
    style: "minimal",
    mood: "chill",
    energy: 0.4,
    density: 0.4,
    bpmRange: [100, 120],
    label: "gotttsching e2-e4",
  },
];

export interface ArtistMatch {
  preset: ArtistPreset;
  /** The phrase that matched (for diagnostics). */
  matched: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artistNamePattern(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`);
}

function artistIdentity(preset: ArtistPreset): string {
  // Parenthetical labels distinguish a production-era/style preset for one
  // artist (e.g. "fred again (ukg)"), not a second artist in a blend.
  return preset.label
    .replace(/\s*\([^)]*\)$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Find the FIRST artist preset whose any name phrase occurs in the text.
 * List order = priority; pure — same text ⇒ same match (or none).
 */
export function matchArtistPreset(lowerText: string): ArtistMatch | null {
  for (const preset of ARTIST_PRESETS) {
    for (const name of preset.names) {
      const pattern = artistNamePattern(name);
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
 * blend — generic pairs use the first artist as the base and blend sliders;
 * named pairs may define a symmetric production profile. The intent TEXT
 * keeps both names for embedding-conditioned providers.
 */
export function matchAllArtistPresets(lowerText: string): ArtistMatch[] {
  const matches: Array<ArtistMatch & { position: number }> = [];
  for (const preset of ARTIST_PRESETS) {
    for (const name of preset.names) {
      const pattern = artistNamePattern(name);
      const match = pattern.exec(lowerText);
      if (match) {
        matches.push({ preset, matched: name, position: match.index });
        break;
      }
    }
  }
  const unique: ArtistMatch[] = [];
  const seenArtists = new Set<string>();
  for (const match of matches.sort((a, b) => a.position - b.position)) {
    const identity = artistIdentity(match.preset);
    if (seenArtists.has(identity)) continue;
    seenArtists.add(identity);
    unique.push({ preset: match.preset, matched: match.matched });
  }
  return unique;
}

export interface VibeBlend {
  presetA: ArtistPreset;
  presetB: ArtistPreset;
  /** Merged intent patch — genre/style from A, mood/sliders blended. */
  patch: {
    genre: ArtistPreset["genre"];
    style?: string;
    productionProfile?: ProductionProfile;
    mood?: ArtistPreset["mood"];
    energy?: number;
    density?: number;
    bpmRange?: [number, number];
  };
  label: string;
}

/**
 * Blend two artist presets. Generic pairs keep the first-hit base and blend
 * available sliders; explicitly profiled pairs use their own stable merge.
 * Explicit words in the prompt still override the blend afterwards.
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
  const isCudiTravisBlend =
    new Set([a.label, b.label]).size === 2 &&
    [a.label, b.label].includes("kid cudi") &&
    [a.label, b.label].includes("travis scott");
  const bpmBlend = (): [number, number] | undefined => {
    if (isCudiTravisBlend) return [128, 140];
    if (a.bpmRange && b.bpmRange) {
      const low = Math.max(a.bpmRange[0], b.bpmRange[0]);
      const high = Math.min(a.bpmRange[1], b.bpmRange[1]);
      if (low <= high) return [low, high];
      const centers = [(a.bpmRange[0] + a.bpmRange[1]) / 2, (b.bpmRange[0] + b.bpmRange[1]) / 2].sort((x, y) => x - y);
      return [Math.round(centers[0]), Math.round(centers[1])];
    }
    return a.bpmRange ? [...a.bpmRange] : b.bpmRange ? [...b.bpmRange] : undefined;
  };
  const blendedBpmRange = bpmBlend();
  return {
    presetA: a,
    presetB: b,
    patch: {
      genre: a.genre,
      ...(isCudiTravisBlend
        ? { style: "rolling", productionProfile: "spacey-dark-trap" as const, mood: "dark" as const }
        : {
            ...(a.style || b.style ? { style: a.style ?? b.style } : {}),
            ...(a.productionProfile || b.productionProfile
              ? { productionProfile: a.productionProfile ?? b.productionProfile }
              : {}),
            ...(a.mood || b.mood ? { mood: a.mood ?? b.mood } : {}),
          }),
      ...(avg(a.energy, b.energy) !== undefined ? { energy: avg(a.energy, b.energy) } : {}),
      ...(avg(a.density, b.density) !== undefined ? { density: avg(a.density, b.density) } : {}),
      ...(blendedBpmRange ? { bpmRange: blendedBpmRange } : {}),
    },
    label: `${a.label} × ${b.label}`,
  };
}
