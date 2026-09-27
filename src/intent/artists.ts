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
  /** Optional named-plugin concept words riding the generation ("metallic"). */
  fx?: readonly string[];
  /** Rap flow grid for the lead line (flow density) — user words override. */
  flow?: "straight" | "triplet" | "offbeat";
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
    flow: "triplet",
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
    flow: "offbeat",
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
    flow: "offbeat",
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
    flow: "straight",
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
  // ── electronic wave additions: sophie / burial / hyperpop ─────────────
  // (overmono/flume/duskus already live in the culture-wave roster below —
  // first-match order means duplicates here would shadow them)
  {
    names: ["burial", "burial type beat"],
    // The future garage school: heavy shuffle, skittery ghost hats,
    // atmosphere over pressure — ambient.futuregarage groove (the genre
    // home the culture wave gave future garage).
    genre: "ambient",
    style: "future garage",
    mood: "dark",
    energy: 0.45,
    density: 0.45,
    bpmRange: [130, 140],
    fx: ["lofi"],
    label: "burial / future garage",
  },
  {
    names: ["hyperpop", "hyper pop", "hyperpop type beat"],
    // The generic hyperpop ask — extreme BPM and energy on the hyper groove.
    genre: "hyperpop",
    style: "hyper",
    mood: "energetic",
    energy: 0.9,
    density: 0.75,
    bpmRange: [145, 160],
    label: "hyperpop",
  },
  // ── melo-club & bass music wave ────────────────────────────────────────
  {
    names: ["anyma", "anyma type beat"],
    // Melodic techno, cinematic Afterlife scale — the techno.melodic groove
    // at club tempo.
    genre: "techno",
    style: "melodic",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [122, 126],
    label: "anyma",
  },
  {
    names: ["tale of us", "afterlife", "tale of us type beat"],
    genre: "techno",
    style: "melodic",
    mood: "dark",
    energy: 0.72,
    density: 0.55,
    bpmRange: [124, 128],
    label: "tale of us",
  },
  {
    names: ["artbat", "artbat type beat"],
    genre: "techno",
    style: "melodic",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [124, 128],
    label: "artbat",
  },
  {
    names: ["camelphat", "camelphat type beat"],
    // Melodic club house — a touch slower, same melodic bed.
    genre: "techno",
    style: "melodic",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [122, 126],
    label: "camelphat",
  },
  {
    names: ["seven lions", "seven lions type beat"],
    // Melodic dubstep — the emotional halftime, big supersaw drops.
    genre: "trap",
    style: "dubstep",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [140, 150],
    label: "seven lions",
  },
  {
    names: ["illenium", "illenium type beat"],
    genre: "trap",
    style: "dubstep",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [140, 150],
    label: "illenium",
  },
  {
    names: ["excision", "excision type beat", "headbanger"],
    // The headbanger corner — heavier, faster dubstep.
    genre: "trap",
    style: "dubstep",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [145, 155],
    label: "excision",
  },
  {
    names: ["subtronics", "subtronics type beat", "riddim"],
    genre: "trap",
    style: "dubstep",
    mood: "aggressive",
    energy: 0.88,
    density: 0.68,
    bpmRange: [142, 152],
    label: "subtronics",
  },
  {
    names: ["black coffee", "black coffee type beat"],
    // Afro house — the house.afro groove at its native tempo.
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 124],
    label: "black coffee",
  },
  {
    names: ["pinkpantheress", "pink pantheress", "pinkpantheress type beat"],
    // 2-step/pop hybrids — ukg groove, bright and bouncy.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.65,
    density: 0.5,
    bpmRange: [132, 140],
    label: "pinkpantheress",
  },
  // ── hip-hop sub-genre sweep (all the variations) ───────────────────────
  {
    names: ["asap rocky", "a$ap rocky", "asap mob", "pretty flacko"],
    // Cloud-adjacent fashion trap — the sparse groove with swagger.
    genre: "trap",
    style: "sparse",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [130, 145],
    label: "a$ap rocky",
  },
  {
    names: ["yung lean", "drain gang", "bladee", "sadboys"],
    // Cloud rap: dreamy, hazy, melancholic — the sparse groove underwater.
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.4,
    density: 0.4,
    bpmRange: [120, 135],
    fx: ["lofi"],
    label: "yung lean / drain gang",
  },
  {
    names: ["clams casino", "cloud rap", "instrumental cloud"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.35,
    density: 0.4,
    bpmRange: [125, 140],
    label: "cloud rap",
  },
  {
    names: ["dj screw", "chopped and screwed", "screwed", "slowed", "houston"],
    // Houston: the groove itself is slowed — 66-78 BPM with heavy lean.
    genre: "trap",
    style: "screwed",
    mood: "chill",
    energy: 0.3,
    density: 0.4,
    bpmRange: [66, 78],
    fx: ["tape"],
    flow: "straight",
    label: "dj screw / chopped and screwed",
  },
  {
    names: ["plugg", "pluggnb", "plugg type beat"],
    // Bell-forward springy producer genre — plugg groove, bright bells.
    genre: "trap",
    style: "plugg",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [140, 160],
    label: "plugg",
  },
  {
    names: ["babytron", "baby tron", "michigan"],
    // Detroit/Michigan loop rap — offbeat bouncy, punchline cadence.
    genre: "trap",
    style: "detroit",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [138, 148],
    flow: "offbeat",
    label: "babytron",
  },
  {
    names: ["veeze", "detroit rap", "detroit type beat"],
    genre: "trap",
    style: "detroit",
    mood: "chill",
    energy: 0.6,
    density: 0.55,
    bpmRange: [130, 144],
    flow: "offbeat",
    label: "veeze / detroit",
  },
  {
    names: ["skepta", "grime", "grime type beat", "bbk"],
    // 140 eski — nearly straight, stabbing, aggressive.
    genre: "drill",
    style: "grime",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [138, 144],
    flow: "straight",
    label: "skepta / grime",
  },
  {
    names: ["wiley", "jme", "eski beat", "wiley type beat"],
    genre: "drill",
    style: "grime",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [138, 144],
    label: "wiley / jme",
  },
  {
    names: ["e-40", "e40", "hyphy", "bay area"],
    // Bay Area bounce — the stubble-dance pocket.
    genre: "trap",
    style: "hyphy",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [96, 106],
    label: "e-40 / hyphy",
  },
  {
    names: ["mac dre", "thizz", "mac dre type beat"],
    genre: "trap",
    style: "hyphy",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [94, 104],
    label: "mac dre",
  },
  {
    names: ["lil jon", "crunk", "crunk type beat", "east side boyz"],
    genre: "trap",
    style: "crunk",
    mood: "aggressive",
    energy: 0.95,
    density: 0.65,
    bpmRange: [98, 108],
    flow: "straight",
    label: "lil jon / crunk",
  },
  {
    names: ["kendrick", "kendrick lamar", "gnx", "not like us", "kendrick type beat"],
    // Modern West Coast conscious — the headnod pocket, GNX era energy.
    genre: "trap",
    style: "headnod",
    mood: "dark",
    energy: 0.7,
    density: 0.6,
    bpmRange: [92, 110],
    label: "kendrick lamar",
  },
  {
    names: ["j cole", "j. cole", "cole world", "dreamville"],
    // Conscious boom bap — the classic groove, laid-back pen.
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [84, 92],
    label: "j. cole",
  },
  {
    names: ["nas", "nas type beat", "illmatic", "ny hip hop", "new york rap"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.55,
    density: 0.5,
    bpmRange: [88, 96],
    label: "nas / ny boom bap",
  },
  {
    names: ["mf doom", "mf doon", "madvillain", "doom type beat"],
    // Dusty lo-fi boom bap — comic-book villain loop digger.
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.45,
    density: 0.5,
    bpmRange: [86, 94],
    fx: ["lofi"],
    label: "mf doom",
  },
  {
    names: ["old school rap", "80s rap", "electro hip hop", "old school type beat"],
    // The TR-808 era — thin electro snare, straight hats, 98-110.
    genre: "trap",
    style: "oldschool",
    mood: "energetic",
    energy: 0.65,
    density: 0.5,
    bpmRange: [98, 110],
    fx: ["lofi"],
    label: "old school / electro",
  },
  // ── mainstream heavyweights wave ───────────────────────────────────────
  {
    names: ["drake", "drake type beat", "ovo", "6ix", "champagne papi"],
    // Toronto atmospheric trap/R&B hybrid — sparse groove with room for
    // the sung hook.
    genre: "trap",
    style: "sparse",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [128, 142],
    label: "drake",
  },
  {
    names: ["kodak black", "kodak", "kodak type beat"],
    // Florida lazy melodic trap — laid-back drawl over sparse drums.
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [125, 140],
    flow: "offbeat",
    label: "kodak black",
  },
  {
    names: ["lil durk", "durk", "lil durk type beat", "otf"],
    // Chicago-adjacent melodic drill.
    genre: "drill",
    style: "dark",
    mood: "dark",
    energy: 0.7,
    density: 0.6,
    bpmRange: [135, 145],
    label: "lil durk",
  },
  {
    names: ["nba youngboy", "youngboy", "youngboy never break again", "4ktrey"],
    // Aggressive melodic trap — rolling and relentless.
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.85,
    density: 0.7,
    bpmRange: [130, 150],
    label: "nba youngboy",
  },
  {
    names: ["polo g", "polo g type beat", "capalot"],
    // Melodic drill/trap — the Hall of Fame pocket.
    genre: "drill",
    style: "dark",
    mood: "dark",
    energy: 0.7,
    density: 0.6,
    bpmRange: [135, 150],
    label: "polo g",
  },
  {
    names: ["rod wave", "rod wave type beat", "nostalgia"],
    // Emotional sung-trap — sparse, room for the vocal to carry.
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [128, 140],
    label: "rod wave",
  },
  {
    names: ["juice wrld", "juice wrld type beat", "999"],
    // Emo trap — rolling 140s with melodic pain.
    genre: "trap",
    style: "rolling",
    mood: "dark",
    energy: 0.75,
    density: 0.6,
    bpmRange: [135, 155],
    flow: "offbeat",
    label: "juice wrld",
  },
  {
    names: ["xxxtentacion", "xxx type beat", "x type beat", "members only"],
    // The aggro/sad split — hyper groove carries the Members Only energy.
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [140, 160],
    label: "xxxtentacion",
  },
  {
    names: ["tyler the creator", "tyler creator", "igor", "flower boy", "golf wang"],
    // Neo-soul boom bap — the classic groove at Igor/Flower Boy tempo.
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [75, 105],
    label: "tyler, the creator",
  },
  {
    names: ["mac miller", "mac miller type beat", "circles", "kidd"],
    // Jazz-tinged boom bap — laid-back pen over warm loops.
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.45,
    density: 0.5,
    bpmRange: [80, 100],
    label: "mac miller",
  },
  {
    names: ["denzel curry", "denzel", "ultimate", "ta13oo"],
    // Aggressive Florida rap — hyper tempo, mosh energy.
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [140, 160],
    label: "denzel curry",
  },
  {
    names: ["jpegmafia", "peggy", "devon hendryx", "experimental rap"],
    // Glitchy experimental trap — hyper groove, maximum density.
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.85,
    density: 0.75,
    bpmRange: [135, 160],
    label: "jpegmafia",
  },
  {
    names: ["megan thee stallion", "megan", "hot girl", "megan thee stallion type beat"],
    // Houston heritage — rolling trap at Tina Snow tempo.
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [125, 140],
    label: "megan thee stallion",
  },
  {
    names: ["lil peep", "lil peep type beat", "gbc", "hellboy"],
    // Emo guitar trap — sparse and hazy under the samples.
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.45,
    density: 0.45,
    bpmRange: [120, 150],
    fx: ["lofi"],
    label: "lil peep",
  },
  {
    names: ["a boogie", "a boogie wit da hoodie", "a boogie type beat"],
    // NY melodic — sparse bed for the sung hook.
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [128, 140],
    label: "a boogie",
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
    genre: "ukg",
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
    style: "amapiano",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 116],
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
    // psytrance in this lane rides its own style below; the trance lane
    // itself now has a dedicated groove (offbeat open hat, 136-142).
    genre: "techno",
    style: "trance",
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
    // The modern organic wave (Muyè / Say What) — hand-drum hypnotia over
    // the soft floor, not the classic afro-house groove.
    genre: "house",
    style: "organic",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [120, 124],
    label: "afro house",
  },
  {
    names: ["overmono", "joy orbison"],
    genre: "ukg",
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
    mood: "dark",
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
    fx: ["tape"],
    flow: "straight",
    label: "memphis phonk",
  },
  // ── Phonk bounce: TikTok-era cowbell-forward phonk, busy hat work ───────
  // The post-2020 cowbell-led phonk template — artists built around aggressive
  // swung cowbell + rolling hats, bouncy energy 0.85-0.95, BPM 130-145.
  {
    names: ["dvrst", "phonk killer", "anti x"],
    // "anti x" is the humanised alias for the Dvrst / Phon-killer echo-cowbell lane
    genre: "phonk",
    style: "bounce",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [130, 145],
    label: "phonk bounce",
  },
  // ── Phonk horror: dark cinematic reverb tail, sparse arrangement ─────────
  // NOLA horrorcore / dark Russian phonk — sparse memphis cowbell + low kick,
  // heavy reverb tail, low density, BPM 125-140.
  {
    // ghostemane + soudiere: dark cinematic phonk. "moon deity/moondeity" + "$uicideboy$"
    // already live in the world-roster (drift) and target-roster (memphis) entries, so we
    // keep this preset's names set disjoint to preserve the matcher priority order.
    names: ["ghostemane", "soudiere"],
    genre: "phonk",
    style: "horror",
    mood: "dark",
    energy: 0.55,
    density: 0.4,
    bpmRange: [125, 140],
    label: "phonk horror",
  },
  // ── Drift phonk (TikTok drift lane) — clean cowbell syncopation, more headroom ─
  // The 'drift' school — fast swung 808-style cowbell, melodic, BPM 145-160.
  {
    names: ["phonk walkerson", "rare akuma", "rxseboy", "lil darkie"],
    // Rare Akuma + Rxseboy + Lil Darkie all sit in the post-Kordhell cowbell-dominant lane
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [145, 160],
    label: "drift phonk (tiktok)",
  },
  // ── Aggressive drift phonk — 808 cowbell + vocal chops, BPM 150-170 ─────
  // Heavier Drift-school artists pushing into Rage tempos.
  {
    names: ["freddie dredd", "ghostface playah", "phonk walker"],
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [150, 170],
    label: "aggressive drift",
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
    genre: "ukg",
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
    genre: "ukg",
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
    genre: "hyperpop",
    style: "hyper",
    mood: "dark",
    energy: 0.8,
    density: 0.65,
    bpmRange: [100, 140],
    label: "arca",
  },
  {
    names: ["sophie", "sophie type beat", "pc music"],
    genre: "hyperpop",
    style: "hyper",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [120, 140],
    fx: ["metallic"],
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
  // ── pop wave (dance-pop base = house, pop-rap = trap; BPM researched:
  // Dua ~103-125, Weeknd synth-pop 90-171, Billie bedroom 70-100,
  // Charli hyperpop 130-160) ─────────────────────────────
  {
    names: ["dua lipa", "dua lipa type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [103, 125],
    label: "dua lipa",
  },
  {
    names: ["the weeknd", "weeknd", "weeknd type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [90, 130],
    label: "the weeknd",
  },
  {
    names: ["billie eilish", "billie", "billie eilish type beat"],
    genre: "ambient",
    style: "sparse",
    mood: "dark",
    energy: 0.4,
    density: 0.35,
    bpmRange: [70, 100],
    label: "billie eilish",
  },
  {
    names: ["ariana grande", "ariana", "ariana grande type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [100, 120],
    label: "ariana grande",
  },
  {
    names: ["bruno mars", "bruno mars type beat"],
    genre: "house",
    style: "funky",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [100, 115],
    label: "bruno mars",
  },
  {
    names: ["olivia rodrigo", "olivia", "olivia rodrigo type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [100, 130],
    label: "olivia rodrigo",
  },
  {
    names: ["charli xcx", "charli", "brat"],
    genre: "trap",
    style: "hyper",
    mood: "energetic",
    energy: 0.9,
    density: 0.7,
    bpmRange: [130, 160],
    label: "charli xcx",
  },
  {
    names: ["taylor swift", "taylor", "taylor swift type beat"],
    genre: "house",
    style: "pop",
    mood: "chill",
    energy: 0.6,
    density: 0.45,
    bpmRange: [90, 120],
    label: "taylor swift",
  },
  {
    names: ["lorde", "lorde type beat"],
    genre: "ambient",
    style: "sparse",
    mood: "dark",
    energy: 0.45,
    density: 0.4,
    bpmRange: [70, 110],
    label: "lorde",
  },
  {
    names: ["tate mcrae", "tate", "tate mcrae type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [100, 125],
    label: "tate mcrae",
  },
  {
    names: ["lady gaga", "gaga", "lady gaga type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [110, 130],
    label: "lady gaga",
  },
  {
    names: ["rihanna", "rihanna type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [95, 120],
    label: "rihanna",
  },
  // ── pop wave 2 (BPM researched: mixgraph.io / tunebat / tempo-tunes /
  //    jog.fm — dance-pop 120-136, pop-rap 80-130, retro-pop 100-120) ─────
  // Dance-pop block — club/EDM-pop crossover pocket (~125-128 sweet spot)
  {
    names: ["sia", "sia type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [120, 133],
    label: "sia",
  },
  {
    names: ["katy perry", "katy perry type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [100, 128],
    label: "katy perry",
  },
  {
    names: ["ava max", "ava max type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [125, 135],
    label: "ava max",
  },
  {
    names: ["zedd", "zedd type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [105, 128],
    label: "zedd",
  },
  {
    names: ["calvin harris", "calvin harris type beat"],
    genre: "house",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [99, 128],
    label: "calvin harris",
  },
  {
    names: ["kesha", "ke$ha"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [120, 140],
    label: "kesha",
  },
  // Pop-rap block — laid-back half-time pocket (80-110, double-time feel)
  {
    names: ["post malone", "post malone type beat"],
    genre: "trap",
    style: "pop",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [80, 95],
    label: "post malone",
  },
  {
    names: ["doja cat", "doja cat type beat"],
    genre: "trap",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [105, 130],
    label: "doja cat",
  },
  {
    names: ["the kid laroi", "kid laroi", "kid laroi type beat"],
    genre: "trap",
    style: "pop",
    mood: "energetic",
    energy: 0.65,
    density: 0.5,
    bpmRange: [85, 140],
    label: "the kid laroi",
  },
  {
    names: ["justin bieber", "bieber", "justin bieber type beat"],
    genre: "house",
    style: "pop",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [90, 130],
    label: "justin bieber",
  },
  // Retro/funk-pop revival — the 100-120 disco-pop sweet spot
  {
    names: ["miley cyrus", "miley", "miley cyrus type beat"],
    genre: "house",
    style: "funky",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [105, 120],
    label: "miley cyrus",
  },
  // ── disco pop wave (nu-disco / disco-pop on house.disco; BPM researched:
  // Kylie 115-128 (Padam 128, Can't Get You 123), Bee Gees 100-110
  // (Stayin' Alive 104, Night Fever 109), Chic 115-125 (Le Freak 122,
  // Good Times 120), Jessie Ware 108-124 (Free Yourself ~122, Pearls 118)) ──
  {
    names: ["kylie minogue", "kylie", "kylie minogue type beat", "padam"],
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [115, 128],
    label: "kylie minogue",
  },
  {
    names: ["bee gees", "beegees", "bee gees type beat"],
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.65,
    density: 0.5,
    bpmRange: [100, 110],
    label: "bee gees",
  },
  {
    names: ["chic", "nile rodgers", "chic type beat"],
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [115, 125],
    label: "chic",
  },
  {
    names: ["jessie ware", "jessie ware type beat"],
    genre: "house",
    style: "disco",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [108, 124],
    label: "jessie ware",
  },
  // ── country pop wave (house.countrypop train beat; BPM researched:
  // Shania 96-122 (Man! I Feel 108, I'm Gonna Getcha Good ~120),
  // Kacey 88-118 (High Horse 118, Golden Hour ballads ~90),
  // The Chicks 100-130 (Cowboy Take Me Away, Sin Wagon pushes 130),
  // Carrie Underwood 92-120 (Before He Cheats 92, Blown Away ~120)) ──
  {
    names: ["shania twain", "shania", "shania twain type beat"],
    genre: "house",
    style: "countrypop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [96, 122],
    label: "shania twain",
  },
  {
    names: ["kacey musgraves", "kacey", "kacey musgraves type beat"],
    genre: "house",
    style: "countrypop",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [88, 118],
    label: "kacey musgraves",
  },
  {
    names: ["the chicks", "dixie chicks", "the chicks type beat"],
    genre: "house",
    style: "countrypop",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [100, 130],
    label: "the chicks",
  },
  {
    names: ["carrie underwood", "carrie underwood type beat"],
    genre: "house",
    style: "countrypop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [92, 120],
    label: "carrie underwood",
  },
  // ── latin pop wave (house.dembow chop; Bad Bunny / J Balvin / Rosalía
  // lanes already exist above; BPM researched: Shakira 92-105 (Hips Don't
  // Lie 99, Whenever 93), Karol G 88-102 (Provenza/TQG pocket ~95),
  // Luis Fonsi 92-100 (Despacito 96), Rauw Alejandro 90-102 (Todo de Ti
  // is the disco-latin edge ~104)) ──
  {
    names: ["shakira", "shakira type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [92, 105],
    label: "shakira",
  },
  {
    names: ["karol g", "karol g type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [88, 102],
    label: "karol g",
  },
  {
    names: ["luis fonsi", "fonsi", "despacito", "luis fonsi type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [92, 100],
    label: "luis fonsi",
  },
  {
    names: ["rauw alejandro", "rauw", "rauw alejandro type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [90, 104],
    label: "rauw alejandro",
  },
  // ── electronic depth wave — progressive house / trance / electro /
  // moombahton / slap house / deep dubstep (BPM researched: Prydz 124-128
  // (Opus 126, bae 125), deadmau5 122-130 (Strobe 128 area), Sasha &
  // Digweed 124-130; Above & Beyond 132-138 (Sun & Moon 132), van Dyk
  // 134-142 (For an Angel 138); Egyptian Lover 120-132 (Egypt, Egypt ~127);
  // Dillon Francis/Major Lazer moombahton 100-112; Alok/Imanbek/Meduza
  // slap 118-126 (In My Mind 120); Skream/Benga/Mystikz 138-142) ──
  {
    names: ["eric prydz", "prydz", "eric prydz type beat"],
    genre: "house",
    style: "progressive",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [124, 128],
    label: "eric prydz",
  },
  {
    names: ["deadmau5", "deadmau5 type beat"],
    genre: "house",
    style: "progressive",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [122, 130],
    label: "deadmau5",
  },
  {
    names: ["sasha", "john digweed", "sasha and john digweed"],
    genre: "house",
    style: "progressive",
    mood: "chill",
    energy: 0.6,
    density: 0.45,
    bpmRange: [124, 130],
    label: "sasha and digweed",
  },
  {
    names: ["above and beyond", "above & beyond", "anjunabeats", "anjunadeep"],
    genre: "techno",
    style: "trance",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [132, 138],
    label: "above and beyond",
  },
  {
    names: ["paul van dyk", "pvd", "paul van dyk type beat"],
    genre: "techno",
    style: "trance",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [134, 142],
    label: "paul van dyk",
  },
  {
    names: ["egyptian lover", "egypt egypt"],
    genre: "techno",
    style: "electro",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [120, 132],
    label: "egyptian lover",
  },
  {
    names: ["dillon francis", "dillon francis type beat"],
    genre: "house",
    style: "moombahton",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [105, 112],
    label: "dillon francis",
  },
  {
    names: ["major lazer", "diplo", "major lazer type beat"],
    genre: "house",
    style: "moombahton",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [100, 112],
    label: "major lazer",
  },
  {
    names: ["alok", "alok type beat"],
    genre: "house",
    style: "slaphouse",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [118, 126],
    label: "alok",
  },
  {
    names: ["imanbek", "imanbek type beat"],
    genre: "house",
    style: "slaphouse",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [118, 124],
    label: "imanbek",
  },
  {
    names: ["meduza", "meduza type beat"],
    genre: "house",
    style: "slaphouse",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [120, 126],
    label: "meduza",
  },
  {
    names: ["skream", "skream type beat"],
    genre: "trap",
    style: "deepdubstep",
    mood: "dark",
    energy: 0.6,
    density: 0.45,
    bpmRange: [138, 142],
    label: "skream",
  },
  {
    names: ["benga", "benga type beat"],
    genre: "trap",
    style: "deepdubstep",
    mood: "dark",
    energy: 0.65,
    density: 0.5,
    bpmRange: [138, 142],
    label: "benga",
  },
  {
    names: ["digital mystikz", "mala dmz", "digital mystikz type beat"],
    genre: "trap",
    style: "deepdubstep",
    mood: "dark",
    energy: 0.55,
    density: 0.4,
    bpmRange: [140, 142],
    label: "digital mystikz",
  },
  // ── gqom + dembow 2.0 wave (researched: DJ Lag / Distruction Boyz — the
  // Durban broken-kick mutation; El Alfa / Rochy RD — dembow dominicano,
  // rawer 16th-filled chop; Tomasa del Real (coined "neoperreo") / Ms Nina —
  // the DIY deconstructed reggaeton lane) ──
  {
    names: ["dj lag", "dj lag type beat"],
    genre: "house",
    style: "gqom",
    mood: "dark",
    energy: 0.75,
    density: 0.5,
    bpmRange: [115, 128],
    label: "dj lag",
  },
  {
    names: ["distruction boyz", "distruction boyz type beat"],
    genre: "house",
    style: "gqom",
    mood: "energetic",
    energy: 0.8,
    density: 0.55,
    bpmRange: [118, 128],
    label: "distruction boyz",
  },
  {
    names: ["el alfa", "el jefe", "el alfa type beat"],
    genre: "house",
    style: "dembowdom",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [100, 112],
    label: "el alfa",
  },
  {
    names: ["rochy rd", "rochy rd type beat"],
    genre: "house",
    style: "dembowdom",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [95, 110],
    label: "rochy rd",
  },
  {
    names: ["tomasa del real", "tomasa", "tomasa del real type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [88, 100],
    label: "tomasa del real",
  },
  {
    names: ["ms nina", "ms. nina", "ms nina type beat"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [90, 102],
    label: "ms nina",
  },
  // ── amapiano + organic house wave (researched: MDU aka Mas — "king of the
  // log drum", MFR Souls, Daliwonga on the amapiano groove; Adam Port
  // (Keinemusik solo) and HUGEL on the modern organic wave, 118-126) ──
  {
    names: ["mdu aka mas", "mdu", "king of the log drum"],
    genre: "house",
    style: "amapiano",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [110, 116],
    label: "mdu aka mas",
  },
  {
    names: ["mfr souls", "mfr souls type beat"],
    genre: "house",
    style: "amapiano",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 115],
    label: "mfr souls",
  },
  {
    names: ["daliwonga", "daliwonga type beat"],
    genre: "house",
    style: "amapiano",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 116],
    label: "daliwonga",
  },
  {
    names: ["adam port", "adam port type beat"],
    genre: "house",
    style: "organic",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [120, 124],
    label: "adam port",
  },
  {
    names: ["hugel", "hugel type beat"],
    genre: "house",
    style: "organic",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [120, 126],
    label: "hugel",
  },
  // ── ghettotech + alté wave (researched: DJ Godfather — ghettotech pioneer,
  // DJ Assault, DJ Funk — the Dance Mania ghetto house bridge; Odunsi (The
  // Engine), Lady Donli, Santi — the Lagos alté alternative lane) ──
  {
    names: ["dj godfather", "dj godfather type beat"],
    genre: "house",
    style: "ghettotech",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 140],
    label: "dj godfather",
  },
  {
    names: ["dj assault", "dj assault type beat"],
    genre: "house",
    style: "ghettotech",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 140],
    label: "dj assault",
  },
  {
    names: ["dj funk", "dj funk type beat"],
    genre: "house",
    style: "ghettotech",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [128, 140],
    label: "dj funk",
  },
  {
    names: ["odunsi", "odunsi the engine", "odunsi type beat"],
    genre: "house",
    style: "afropop",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [90, 105],
    label: "odunsi",
  },
  {
    names: ["lady donli", "lady donli type beat"],
    genre: "house",
    style: "afropop",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [90, 108],
    label: "lady donli",
  },
  {
    names: ["santi", "santi type beat"],
    genre: "house",
    style: "afropop",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [92, 108],
    label: "santi",
  },
  {
    names: ["sabrina carpenter", "sabrina", "sabrina carpenter type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.65,
    density: 0.5,
    bpmRange: [100, 112],
    label: "sabrina carpenter",
  },
  {
    names: ["chappell roan", "chappell"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [105, 120],
    label: "chappell roan",
  },
  {
    names: ["harry styles", "harry styles type beat"],
    genre: "house",
    style: "pop",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [85, 130],
    label: "harry styles",
  },
  {
    names: ["troye sivan", "troye sivan type beat"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [110, 130],
    label: "troye sivan",
  },
  {
    names: ["halsey", "halsey type beat"],
    genre: "house",
    style: "pop",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [90, 136],
    label: "halsey",
  },
  // Ballad pop — slow, voice-first
  {
    names: ["adele", "adele type beat"],
    genre: "ambient",
    style: "pop",
    mood: "dark",
    energy: 0.3,
    density: 0.3,
    bpmRange: [70, 100],
    label: "adele",
  },
  {
    names: ["sam smith", "sam smith type beat"],
    genre: "ambient",
    style: "pop",
    mood: "chill",
    energy: 0.35,
    density: 0.35,
    bpmRange: [85, 110],
    label: "sam smith",
  },
  // ── drum & bass wave (researched pockets: dancefloor/jump-up 172–178,
  // liquid rollers 170–176, neuro 172–178, jungle/ragga 160–170) ─────────────
  // Styles map ONLY to existing dnb.* grooves (twostep/liquid/jumpup/roller/
  // amen/dancefloor/neuro). Bare common-word names are qualified ("break
  // dnb", never bare "break") so arrangement talk never hijacks.
  // Liquid rollers — silky subs, summer festival energy
  {
    names: ["netsky", "netsky type beat"],
    genre: "dnb",
    style: "liquid",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [172, 176],
    label: "netsky",
  },
  {
    names: ["hybrid minds"],
    genre: "dnb",
    style: "liquid",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [172, 176],
    label: "hybrid minds",
  },
  {
    names: ["high contrast"],
    genre: "dnb",
    style: "liquid",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [172, 176],
    label: "high contrast",
  },
  {
    names: ["ltj bukem", "ltj bukem type beat", "bukem"],
    genre: "dnb",
    style: "liquid",
    mood: "chill",
    energy: 0.6,
    density: 0.45,
    bpmRange: [168, 172],
    label: "ltj bukem",
  },
  {
    names: ["dj marky", "marky", "sambass", "samba bass"],
    genre: "dnb",
    style: "liquid",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [172, 176],
    label: "dj marky",
  },
  // Jump-up — wobble bass party starters
  {
    names: ["turno", "turno type beat"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "turno",
  },
  {
    names: ["kanine", "kanine type beat"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "kanine",
  },
  {
    names: ["upgrade type beat", "dj upgrade"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "upgrade",
  },
  {
    names: ["a.m.c", "amc type beat"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "a.m.c",
  },
  {
    // bare "serum" would hijack wavetable-synth talk — qualified only
    names: ["serum type beat", "serum dnb"],
    genre: "dnb",
    style: "jumpup",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 178],
    label: "serum (dnb)",
  },
  // Dancefloor — mainstage rollers and anthems
  {
    names: ["andy c", "andy c type beat"],
    genre: "dnb",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 176],
    label: "andy c",
  },
  {
    names: ["dimension", "dimension type beat"],
    genre: "dnb",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "dimension",
  },
  {
    names: ["culture shock"],
    genre: "dnb",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "culture shock",
  },
  {
    names: ["metrik", "metrik type beat"],
    genre: "dnb",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "metrik",
  },
  {
    names: ["grafix", "grafix type beat"],
    genre: "dnb",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [172, 176],
    label: "grafix",
  },
  // Neurofunk / techstep — reese tearout pressure
  {
    names: ["noisia", "noisia type beat"],
    genre: "dnb",
    style: "neuro",
    mood: "aggressive",
    energy: 0.95,
    density: 0.75,
    bpmRange: [172, 178],
    label: "noisia",
  },
  {
    names: ["black sun empire"],
    genre: "dnb",
    style: "neuro",
    mood: "dark",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "black sun empire",
  },
  {
    names: ["phace", "phace type beat"],
    genre: "dnb",
    style: "neuro",
    mood: "dark",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "phace",
  },
  {
    names: ["misanthrop", "misanthrop type beat"],
    genre: "dnb",
    style: "neuro",
    mood: "dark",
    energy: 0.9,
    density: 0.7,
    bpmRange: [172, 178],
    label: "misanthrop",
  },
  {
    names: ["ed rush", "optical", "ed rush & optical", "ed rush and optical"],
    genre: "dnb",
    style: "neuro",
    mood: "dark",
    energy: 0.85,
    density: 0.7,
    bpmRange: [172, 178],
    label: "ed rush & optical",
  },
  {
    names: ["dom and roland", "dom & roland"],
    genre: "dnb",
    style: "neuro",
    mood: "dark",
    energy: 0.85,
    density: 0.65,
    bpmRange: [172, 176],
    label: "dom & roland",
  },
  // Deep / minimal rollers — stripped steppers
  {
    // bare "break" would hijack arrangement talk — qualified only
    names: ["break dnb", "break type beat"],
    genre: "dnb",
    style: "roller",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [172, 176],
    label: "break (dnb)",
  },
  {
    names: ["skeptical", "skeptical type beat"],
    genre: "dnb",
    style: "roller",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [172, 176],
    label: "skeptical",
  },
  {
    names: ["alix perez", "alix perez type beat"],
    genre: "dnb",
    style: "roller",
    mood: "dark",
    energy: 0.8,
    density: 0.6,
    bpmRange: [172, 176],
    label: "alix perez",
  },
  {
    names: ["dillinja", "dillinja type beat"],
    genre: "dnb",
    style: "roller",
    mood: "dark",
    energy: 0.85,
    density: 0.65,
    bpmRange: [170, 176],
    label: "dillinja",
  },
  // Jungle / ragga — chopped amens, dancehall pressure (slower pocket)
  {
    names: ["congo natty", "congo natty type beat", "rebel mc"],
    genre: "dnb",
    style: "amen",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [160, 168],
    label: "congo natty",
  },
  // Jungle-specific lane (chopped-breaks groove) beside the amen lanes above.
  {
    names: ["remarc", "remarc type beat"],
    genre: "dnb",
    style: "jungle",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [155, 165],
    label: "remarc",
  },
  {
    names: ["dj hype", "dj hype type beat"],
    genre: "dnb",
    style: "jungle",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [158, 168],
    label: "dj hype",
  },
  // UK funky lane (soca-bounce groove).
  {
    names: ["roska", "roska type beat"],
    genre: "house",
    style: "ukfunky",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [125, 130],
    label: "roska",
  },
  {
    names: ["lil silva", "lil silva type beat"],
    genre: "house",
    style: "ukfunky",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [124, 130],
    label: "lil silva",
  },
  {
    names: ["shy fx", "shy fx type beat"],
    genre: "dnb",
    style: "amen",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [162, 170],
    label: "shy fx",
  },
  {
    names: ["general levy"],
    genre: "dnb",
    style: "amen",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [160, 168],
    label: "general levy",
  },
  // Two-step stepper — roni size's represent-era swing
  {
    names: ["roni size", "roni size type beat", "reprazent"],
    genre: "dnb",
    style: "twostep",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [168, 174],
    label: "roni size",
  },
  // ── 90s NY legends (classic 88–96 pocket, dark) ─────────────────────────
  // Boom-bap BPMs are researched (Illmatic / Ready to Die / Enter the 36 /
  // Reasonable Doubt / The Infamous era); the classic groove carries them —
  // planGeneration clamps the prior to the requested window.
  {
    names: ["2pac", "tupac", "makaveli", "2pac type beat"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.6,
    density: 0.55,
    bpmRange: [88, 95],
    label: "2pac",
  },
  {
    names: ["biggie", "notorious big", "biggie smalls", "big poppa"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.6,
    density: 0.55,
    bpmRange: [87, 94],
    label: "biggie",
  },
  {
    // Raekwon rides in the same entry (Cuban Linx pocket = the clan pocket).
    names: ["wu-tang", "wu tang", "rza", "raekwon", "ghostface killah", "method man", "gza", "ol dirty"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [88, 96],
    label: "wu-tang",
  },
  {
    names: ["jay-z", "jay z", "jigga", "hov", "reasonable doubt"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.55,
    density: 0.5,
    bpmRange: [86, 95],
    label: "jay-z",
  },
  {
    names: ["mobb deep", "havoc type beat", "shook ones", "the infamous"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [90, 95],
    label: "mobb deep",
  },
  // ── Dirty South founders ───────────────────────────────────────────────
  {
    names: ["outkast", "andre 3000", "andre three thousand", "big boi", "atliens", "stankonia"],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.6,
    density: 0.55,
    bpmRange: [90, 102],
    label: "outkast",
  },
  {
    names: ["ugk", "bun b", "pimp c", "ridin dirty"],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [82, 94],
    label: "ugk",
  },
  {
    names: ["geto boys", "scarface type beat", "willie d", "bushwick bill"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.55,
    density: 0.5,
    bpmRange: [84, 94],
    label: "scarface / geto boys",
  },
  {
    // Dots never survive parser normalization ("t.i." → "t i"), so the
    // canonical alias is written post-normalization; "tip" alone is SK for
    // "type" and must never become an artist match.
    names: ["t i", "grand hustle", "ti type beat", "trap muzik"],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [96, 108],
    label: "t.i.",
  },
  {
    names: ["jeezy", "young jeezy", "jeezy type beat", "thug motivation"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 142],
    label: "jeezy",
  },
  {
    names: ["gucci mane", "gucci type beat", "guwop", "la flare"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [130, 142],
    label: "gucci mane",
  },
  {
    // Cash Money bounce — remaps to trap.bounce once the bounce groove lands.
    names: ["mannie fresh", "cash money", "big tymers"],
    genre: "trap",
    style: "bounce",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [95, 108],
    label: "mannie fresh",
  },
  // ── 2000s mainstream ───────────────────────────────────────────────────
  {
    names: ["eminem", "slim shady", "marshall mathers", "eminem type beat", "8 mile"],
    genre: "trap",
    style: "classic",
    mood: "aggressive",
    energy: 0.7,
    density: 0.55,
    bpmRange: [85, 95],
    label: "eminem",
  },
  {
    names: ["50 cent", "fifty cent", "g-unit", "get rich", "50 cent type beat"],
    genre: "trap",
    style: "classic",
    mood: "aggressive",
    energy: 0.7,
    density: 0.55,
    bpmRange: [86, 96],
    label: "50 cent",
  },
  {
    names: ["lil wayne", "weezy", "lil tunechi", "carter type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [130, 145],
    label: "lil wayne",
  },
  {
    names: ["rick ross", "rozay", "maybach", "rick ross type beat"],
    genre: "trap",
    style: "rolling",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 140],
    label: "rick ross",
  },
  {
    names: ["dmx", "dark man x", "ruff ryders", "dmx type beat"],
    genre: "trap",
    style: "classic",
    mood: "aggressive",
    energy: 0.75,
    density: 0.55,
    bpmRange: [86, 96],
    label: "dmx",
  },
  {
    names: ["busta rhymes", "busta type beat", "flipmode"],
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [95, 110],
    label: "busta rhymes",
  },
  {
    names: ["missy elliott", "missy type beat", "timbaland", "neptunes", "pharrell type beat", "supa dupa"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [95, 110],
    label: "missy / timbaland",
  },
  // ── Bay / LA g-era ─────────────────────────────────────────────────────
  {
    // "$hort" can never match (\b fails before "$"); the plain spelling
    // carries the preset.
    names: ["too short", "short dog", "too short type beat"],
    genre: "trap",
    style: "gfunk",
    mood: "chill",
    energy: 0.6,
    density: 0.55,
    bpmRange: [92, 100],
    label: "too $hort",
  },
  {
    names: ["dj quik", "quik type beat"],
    genre: "trap",
    style: "gfunk",
    mood: "chill",
    energy: 0.6,
    density: 0.55,
    bpmRange: [92, 100],
    label: "dj quik",
  },
  {
    names: ["kurupt", "dogg pound", "daz dillinger", "kurupt type beat"],
    genre: "trap",
    style: "headnod",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [92, 98],
    label: "kurupt",
  },
  {
    // Mustard ratchet — minimal loop-rap bounce, the detroit offbeat vehicle.
    names: ["yg type beat", "yg", "dj mustard", "mustard type beat", "400 type beat"],
    genre: "trap",
    style: "detroit",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [95, 110],
    label: "yg / mustard",
  },
  {
    names: ["nipsey hussle", "nipsey", "nip hussle", "victory lap", "crenshaw"],
    genre: "trap",
    style: "headnod",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [90, 100],
    label: "nipsey hussle",
  },
  {
    // Offbeat specialita — the detroit loop-rap bounce carries the flow.
    names: ["blueface", "blue face", "bleedem", "blueface type beat"],
    genre: "trap",
    style: "detroit",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [135, 148],
    label: "blueface",
  },
  // ── Three 6 Mafia (memphis phonk — the groove exists) ──────────────────
  {
    names: [
      "three 6 mafia",
      "three six mafia",
      "dj paul",
      "juicy j",
      "project pat",
      "gangsta boo",
      "triple six",
      "hypnotize minds",
    ],
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.65,
    density: 0.5,
    bpmRange: [130, 142],
    label: "three 6 mafia",
  },
  // ── Griselda dust (boom-bap renesancia — lacné: groove existuje) ────────
  {
    names: [
      "westside gunn",
      "conway the machine",
      "benny the butcher",
      "roc marciano",
      "alchemist type beat",
      "daringer",
      "griselda",
      "gxfr",
    ],
    genre: "trap",
    style: "classic",
    mood: "dark",
    energy: 0.55,
    density: 0.5,
    bpmRange: [84, 94],
    label: "griselda",
  },
  {
    names: ["navy blue", "earl sweatshirt", "earl type beat", "mike type beat", "ka type beat"],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.45,
    density: 0.5,
    bpmRange: [80, 92],
    label: "underground poet",
  },
  // ── Jersey / drill / phonk depth wave ───────────────────────────────────
  // Researched: jersey club 130–140 + five-kick 4-4-3-3-2 + bed squeak
  // (orphiq.com guide, Wikipedia; UNIIQU3 catalog median ~136 — Mixgraph);
  // drill UK ~141 / NY ~142 half-time, sliding 808s (se7en BPM Index,
  // Audeobox, OurMusicWorld); sexy drill = R&B-smooth sample drill
  // (NYT/Mixmag/Complex: Cash Cobain, Chow Lee, Lonny Love); drift phonk
  // = faster cowbell-forward TikTok lane, "Scary Garry" 2016 (Wikipedia,
  // EECOP; Pitchfork: Freddie Dredd keeps the original style).
  // Jersey club — the queen, the pioneer, the exporter, the viral wave.
  {
    names: ["uniiqu3", "microdosing"],
    // Queen of Jersey Club (Splice cover story, Fendaci soundtrack);
    // catalog sits 135–140, median ~136.
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [134, 140],
    label: "uniiqu3",
  },
  {
    names: ["dj tameil", "tameil", "brick bandits"],
    // The origin point (Brick Bandits crew) — origin-era tempo, same bounce.
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [128, 136],
    label: "dj tameil",
  },
  {
    names: ["dj sliink", "sliink"],
    // The exporter wave (2010s festivals + international circuits).
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 140],
    label: "dj sliink",
  },
  {
    names: ["2rare", "2 rare"],
    // Philly viral bounce (Q-Pid / Big Drippa lane), hard 140 landing.
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [134, 142],
    label: "2rare",
  },
  {
    names: ["cash cobain", "chow lee", "lonny love", "sexy drill", "slizzy", "2 slizzy"],
    // Sexy drill: drill bounce + smooth R&B samples, less-is-more drums
    // (2 Slizzy 2 Sexy, Fisherrr) — drill family, bounce groove, party mood.
    genre: "drill",
    style: "bounce",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [138, 145],
    label: "cash cobain",
  },
  // NY drill — harder distorted 808s, punchier kick (~142).
  {
    names: ["fivio foreign", "fivio", "big drip"],
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [140, 145],
    label: "fivio foreign",
  },
  {
    names: ["sheff g", "sleepy hallow", "no suburban"],
    // The Brooklyn wave (No Suburban) — same 140 pocket, anthem bounce.
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.8,
    density: 0.55,
    bpmRange: [138, 143],
    label: "sheff g / sleepy hallow",
  },
  // UK drill — sliding 808s, syncopated hats, dark piano (~141).
  {
    names: ["headie one", "headie"],
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [138, 143],
    label: "headie one",
  },
  {
    names: ["digga d", "digga"],
    genre: "drill",
    style: "uk",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [138, 144],
    label: "digga d",
  },
  {
    names: ["808melo", "808 melo"],
    // The UK→BK architect (Pop Smoke's Welcome to the Party) — long
    // portamento 808 slides carry the entry.
    genre: "drill",
    style: "dark",
    mood: "dark",
    energy: 0.8,
    density: 0.6,
    bpmRange: [138, 144],
    label: "808melo",
  },
  {
    names: ["axl beats", "axl"],
    // UK→BK crossover — catchy accessible melodies over the slide.
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [138, 143],
    label: "axl beats",
  },
  {
    names: ["ghosty", "ghosty beats"],
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [136, 142],
    label: "ghosty",
  },
  {
    names: ["g herbo", "herbo", "lil herb", "swervo"],
    // Chicago drill — punchier, shorter-sustain 808s, harder swing.
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [138, 146],
    label: "g herbo",
  },
  {
    names: ["m1onthebeat", "m1 beats", "m1"],
    // Sharper percussive UK school (Carns Hill lane).
    genre: "drill",
    style: "uk",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [138, 144],
    label: "m1onthebeat",
  },
  // Phonk — drift originators + memphis-lofi rap lane.
  {
    names: ["kaito shoma", "kaito", "scary garry"],
    // "Scary Garry" (2016) — one of the first drift phonk records.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.6,
    bpmRange: [140, 155],
    label: "kaito shoma",
  },
  {
    names: ["pharmacist", "pharmacist type beat"],
    // Drift pioneer — night-drive cowbell pressure.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [140, 155],
    label: "pharmacist",
  },
  {
    names: ["xavier wulf", "hollow squad"],
    // Memphis-revival rap (Hollow Squad) — Euclid-era menace.
    genre: "phonk",
    style: "memphis",
    mood: "aggressive",
    energy: 0.75,
    density: 0.55,
    bpmRange: [125, 140],
    label: "xavier wulf",
  },
  {
    names: ["night lovell", "dark light"],
    // Dark lo-fi (Dark Light) — slowed menace, room to breathe.
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.45,
    bpmRange: [120, 135],
    label: "night lovell",
  },
  {
    names: ["bones", "teamsesh", "sesh"],
    // TeamSESH cloud/lo-fi — the chillest memphis corner.
    genre: "phonk",
    style: "memphis",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [120, 130],
    label: "bones",
  },
  // ── Southern specialties (new grooves: bounce / miamibass / snap) ────
  // ── + afroswing + countrytune ─────────────────────────────────────────
  {
    names: ["big freedia", "dj jubilee", "juvenile", "back that azz", "bounce type beat"],
    genre: "trap",
    style: "bounce",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [98, 104],
    label: "nola bounce",
  },
  {
    names: ["2 live crew", "uncle luke", "luther campbell", "luke type beat"],
    genre: "trap",
    style: "miamibass",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [115, 125],
    label: "2 live crew",
  },
  {
    names: ["soulja boy", "crank dat", "soulja boy type beat"],
    genre: "trap",
    style: "snap",
    mood: "energetic",
    energy: 0.65,
    density: 0.4,
    bpmRange: [80, 95],
    label: "soulja boy",
  },
  {
    names: ["dem franchize", "d4l", "laffy taffy", "snap type beat"],
    genre: "trap",
    style: "snap",
    mood: "energetic",
    energy: 0.65,
    density: 0.4,
    bpmRange: [80, 95],
    label: "snap era",
  },
  {
    names: ["j hus", "jhus", "mostack", "mo stack", "nsg", "afroswing type beat"],
    genre: "house",
    style: "afroswing",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [100, 108],
    label: "afroswing",
  },
  {
    // "lil nas x" always blends with the nas preset ("nas" matches inside) —
    // energy/density sit nas-adjacent so the blend stays in the pocket and
    // the BPM intersection ([88,92]) lands inside the countrytune window.
    names: ["lil nas x", "old town road", "lil nas x type beat"],
    genre: "trap",
    style: "countrytune",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [78, 92],
    label: "lil nas x",
  },
  // ── Chicago now (drill + conscious) ────────────────────────────────
  {
    // Bare "von" is German for "from" — qualified only.
    names: ["king von", "king von type beat", "von type beat", "grandson", "otf"],
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [135, 145],
    label: "king von",
  },
  {
    // Bare "chance" is a common word — qualified only. "acid rap" doubles as
    // the genre phrase (same trap family), so the pocket survives regardless.
    names: [
      "chance the rapper",
      "chance type beat",
      "acid rap",
      "coloring book",
      "noname",
      "noname type beat",
      "telefone",
      "room 25",
      "saba",
      "saba type beat",
      "care for me",
      "pivot gang",
    ],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [82, 94],
    label: "chicago conscious",
  },
  // ── Detroit now (the detroit loop-rap bounce carries all three) ────
  {
    // Bare "sada" is SK for "now" — qualified only. Bare "rio" is the city.
    names: [
      "sada baby",
      "skuba",
      "sada baby type beat",
      "icewear vezzo",
      "vezzo type beat",
      "icewear",
      "rich off pints",
      "rio da yung og",
      "rio type beat",
    ],
    genre: "trap",
    style: "detroit",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 148],
    label: "detroit now",
  },
  // ── LA now (whisper-flow detroit + sung sparse) ─────────────────────
  {
    names: ["drakeo", "drakeo the ruler", "flu flam", "remble", "remble type beat"],
    genre: "trap",
    style: "detroit",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 144],
    label: "drakeo",
  },
  {
    names: ["blxst", "blxst type beat", "sixtape", "bino rideaux", "bino type beat"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [125, 140],
    label: "blxst",
  },
  // ── Rage / new jazz (opium-adjacent, jerk-plugg edge) ───────────────
  {
    // Bare "osa" is SK for "wasp" — qualified only. Nettspend / 2hollis live
    // in the parallel "plugg newer wave" entry (plugg pocket) — this one
    // carries the rage-bounce side (osamason) only.
    names: ["osamason", "osamason type beat", "new rage type beat"],
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [148, 165],
    label: "new rage",
  },
  // ── UK pop-drill (headie lives in the depth wave already) ───────────
  {
    // Bare "dave" is anyone's producer — qualified only.
    names: ["santan dave", "dave type beat", "psychodrama"],
    genre: "drill",
    style: "melodic",
    mood: "chill",
    energy: 0.6,
    density: 0.55,
    bpmRange: [138, 145],
    label: "dave",
  },
  {
    names: ["stormzy", "stormzy type beat", "vossi bop"],
    genre: "drill",
    style: "grime",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [138, 144],
    label: "stormzy",
  },
  {
    names: ["22gz", "22gz type beat"],
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [140, 150],
    label: "22gz",
  },
  // ── Female rap (the biggest open lane) ─────────────────────────────
  {
    names: ["nicki minaj", "nicki type beat", "pink friday", "barbz"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 145],
    label: "nicki minaj",
  },
  {
    names: ["cardi b", "cardi type beat", "bodak yellow", "bodak"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [130, 142],
    label: "cardi b",
  },
  {
    names: ["latto", "latto type beat", "big latto", "big energy"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [125, 140],
    label: "latto",
  },
  {
    // Dots never survive normalization ("f.n.f." → "f n f") — see t.i.
    names: ["glorilla", "glo type beat", "f n f"],
    genre: "trap",
    style: "crunk",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [98, 108],
    label: "glorilla",
  },
  {
    names: ["sexyy red", "sexyy type beat", "pound town"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 145],
    label: "sexyy red",
  },
  {
    names: ["doechii", "doechii type beat", "swamp princess"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 145],
    label: "doechii",
  },
  {
    names: ["little simz", "simz", "simbi", "grey area"],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [86, 94],
    label: "little simz",
  },
  // ── Latin trap + French cloud ──────────────────────────────────────
  {
    names: ["bad bunny", "benito type beat", "un verano"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [95, 125],
    label: "bad bunny",
  },
  {
    names: ["myke towers", "myke type beat"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [95, 125],
    label: "myke towers",
  },
  {
    names: ["duki", "duki type beat"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 150],
    label: "duki",
  },
  {
    names: ["pnl", "pnl type beat", "qlf", "deux freres"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [128, 142],
    label: "pnl",
  },
  // ── SoundCloud era ─────────────────────────────────────────────────
  {
    names: ["ski mask", "slump god", "ski mask type beat", "stokeley"],
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [140, 160],
    label: "ski mask",
  },
  {
    names: ["smokepurpp", "smokepurpp type beat", "purpp", "deadstar"],
    genre: "trap",
    style: "rolling",
    mood: "dark",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 150],
    label: "smokepurpp",
  },
  {
    // Bare "pump" is a common verb — qualified only.
    names: ["lil pump", "lil pump type beat", "gucci gang", "gazzy"],
    genre: "trap",
    style: "rolling",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [130, 150],
    label: "lil pump",
  },
  // ── Experimental edge ──────────────────────────────────────────────
  {
    names: ["death grips", "death grips type beat", "mc ride"],
    genre: "dnb",
    style: "amen",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [160, 168],
    label: "death grips",
  },
  {
    // Bare "clipping" is an audio term — qualified only.
    names: ["clipping type beat", "clipping band", "daveed diggs"],
    genre: "phonk",
    style: "horror",
    mood: "dark",
    energy: 0.7,
    density: 0.5,
    bpmRange: [132, 150],
    label: "clipping.",
  },
  // ── Bass house — heavy tech-house with rolling sub-bass + groovy drops ───
  // The post-Fisher / ACRAZE wave (2018+). Tech-house groove with layered
  // punch kick + offbeat clap + busy 16th-hat work; mid-tempo pocket 124-130.
  // Routes to groove 'house.basshouse' (Wave 3 groove).
  {
    names: ["chris lake", "acraze", "sidepiece"],
    genre: "house",
    style: "basshouse",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [124, 130],
    label: "bass house",
  },
  // ── G-house — French house / R&B vocal-chop tech-house ──────────────────
  // Don Diablo's "g-house" coinage (2014+): deep groove + pitched R&B
  // acapellas. 120-126 floor, the chill-deep side of the house spectrum.
  // Routes to groove 'house.ghouse' (Wave 3 groove).
  {
    names: ["don diablo", "tchami", "malaa"],
    genre: "house",
    style: "ghouse",
    mood: "chill",
    energy: 0.75,
    density: 0.55,
    bpmRange: [120, 126],
    label: "g-house",
  },
  // ── Future bass — melodic half-time pop-EDM, chopped vocal leads ──────────
  // The bright side of post-2014 pop-future-bass (Marshmello / Said The Sky).
  // Flume's existing entry covers the 'lux' trap-flavour; this entry adds
  // the brighter pop-future-bass side via 'broken' (closest existing groove
  // to choppy future bass).
  {
    names: ["marshmello", "said the sky"],
    genre: "house",
    style: "broken",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [140, 150],
    label: "future bass",
  },
  // ── Riddim dubstep — aggressive riddim / neuro, mid-tempo heavy drops ────
  // Existing entries (Skrillex, Subtronics, Seven Lions) cover mainline +
  // melodic dubstep. This one fills the riddim / heavy-mid lane (Virtual
  // Riot / Borgore). Routes to groove 'trap.dubstep' (140-150).
  {
    names: ["virtual riot", "borgore", "riddim"],
    genre: "trap",
    style: "dubstep",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [140, 150],
    label: "riddim dubstep",
  },
  // ── Hardstyle — euphoric reverse-bass kicks + supersaw leads ─────────────
  // Hardstyle sits adjacent to techno. The new 'techno.hardstyle' groove
  // (Wave 3) captures the reverse-bass kick + layered kick-alt signature,
  // 150-155 BPM (post-2015 euphoric pocket). Grid-locked swing 0.
  {
    names: ["headhunterz", "sound rush", "ran-d"],
    genre: "techno",
    style: "hardstyle",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [150, 155],
    label: "hardstyle",
  },
  // ── Psytrance — acid-driven 140 with rolling TB-303 lines + psy leads ─────
  // The harder psy side of trance. Existing trance entry (Tiesto/Armin)
  // covers melodic trance at 136-142 via 'driving'; this entry covers the
  // psy side via the new 'techno.psytrance' groove (Wave 3). 138-145 pocket.
  {
    names: ["astrix", "vini vici", "infected mushroom"],
    genre: "techno",
    style: "psytrance",
    mood: "energetic",
    energy: 0.9,
    density: 0.65,
    bpmRange: [138, 145],
    label: "psytrance",
  },
  // ── Club depth wave 2 (same research base as wave 1) ────────────────────
  // Jersey second line: the Just-Wanna-Rock architect, the 2010s online
  // wave (Jayhood / Nadus / R3LL) and the Jersey Drill song-format founder.
  {
    names: ["mcvertt", "just wanna rock"],
    // Newark producer behind Lil Uzi Vert's Just Wanna Rock (2022) and
    // Bandmanrill's HeartBroken — the mainstream jersey-club bounce.
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [136, 142],
    label: "mcvertt",
  },
  {
    names: ["dj jayhood", "jayhood"],
    // 2010s online wave — pushed the club sound onto festival stages.
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 140],
    label: "dj jayhood",
  },
  {
    names: ["nadus", "thread"],
    // #THREAD party series — eclectic club formats, bounce-forward.
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 140],
    label: "nadus",
  },
  {
    names: ["r3ll"],
    // Festival-circuit club — clean big-room-ready bounce.
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [132, 142],
    label: "r3ll",
  },
  {
    names: ["unicorn151", "killa kherk cobain"],
    // First Jersey Drill song-format record (Jack N Drill, 2021, with
    // Bandmanrill) — drill delivery over the club bounce.
    genre: "jersey",
    style: "club",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [138, 144],
    label: "unicorn151",
  },
  // Bronx drill — sample-heavy, raspy, a touch more aggressive than BK.
  {
    names: ["b-lovee", "blovee"],
    // Bronx-to-sexy bridge (My Everything's Mary J. Blige flip) —
    // melodic but still gutter.
    genre: "drill",
    style: "dark",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [140, 145],
    label: "b-lovee",
  },
  {
    names: ["kay flock", "kta"],
    // Bronx drill front line — full-aggression sample drill.
    genre: "drill",
    style: "dark",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [140, 145],
    label: "kay flock",
  },
  // UK drill — Homerton forefront.
  {
    names: ["unknown t", "homerton"],
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.8,
    density: 0.55,
    bpmRange: [138, 144],
    label: "unknown t",
  },
  // Drift phonk anthems — the two Spotify-era records.
  {
    names: ["interworld", "metamorphosis"],
    // Metamorphosis — the drift anthem with Russian-hard-bass DNA.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.6,
    bpmRange: [140, 155],
    label: "interworld",
  },
  {
    names: ["dxrk", "rave"],
    // Rave — Algerian-French take on the cowbell lane.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [140, 155],
    label: "dxrk",
  },
  // ── Vaporwave — slowed 80s-pop + chopped sample aesthetic ────────────────
  // The 2010-2015 net-art movement (Macintosh Plus 'Floral Shoppe' / Vektroid
  // 'Sacred Tapestry' / George Clanton's bright variant). Slowed & reverbed
  // 80s pop, BPM 70-85, very low energy + density. Routes to ambient.drifting.
  //
  // The bare "vaporwave" name is owned by an earlier parallel-session entry
  // (the 2814 / vaporwave ambient-drifting dark preset at L1566). We use the
  // unique artist names here so the matcher priority picks this entry when
  // the user names a specific vaporwave producer.
  {
    names: ["macintosh plus", "vektroid", "george clanton", "saint pepsi", "luxury elite"],
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.2,
    density: 0.4,
    bpmRange: [70, 85],
    label: "vaporwave",
  },
  // ── Synthwave — 80s-style analog synth leads + driving four-on-the-floor ─
  // Kavinsky 'Nightcall' / The Midnight / FM-84 / Mitch Murder / Timecop1983.
  // Mid-tempo pocket 95-115, dreamy-energetic mood, organic instrumentation.
  // Routes to ambient.organic (closest groove for the analog-synth side of
  // the ambient spectrum; synthwave isn't a first-class groove).
  {
    names: ["synthwave", "kavinsky", "the midnight", "fm-84", "mitch murder", "timecop1983", "lazerhawk"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [95, 115],
    label: "synthwave",
  },
  // ── Lo-fi hip-hop — Nujabes lane, jazz-sample boom-bap at slow tempo ────
  // Nujabes 'Metaphorical Music' / DJ Okawari / Idealism / Tom Misch / Potsu.
  // BPM 75-92, jazz chords, dusty drums. Routes to ambient.drifting.
  {
    names: ["lofi", "lo-fi", "nujabes", "dj okawari", "idealism", "tom misch", "potsu"],
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.35,
    density: 0.45,
    bpmRange: [75, 92],
    label: "lofi (nujabes lane)",
  },
  // ── Downtempo — Bonobo / Caribou / Bibio / Oddisee ───────────────────────
  // Organic-instrument downtempo (Bonobo 'The North Borders' / Caribou 'Our
  // Love'). Four Tet's existing house/organic entry covers the dancier end;
  // this covers the slower organic-instrument side via ambient/organic.
  // BPM 92-110, chill mood.
  {
    names: ["downtempo", "bonobo", "caribou", "bibio", "oddisee"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [92, 110],
    label: "downtempo",
  },
  // ── Plugg newer wave — Nettspend / Autumn! / Homixide Gang / 2hollis ────
  // Post-Ken Carson / Destroy Lonely plugg wave (2023+). Plugg groove at
  // 140-160 with auto-tune-heavy vocal chops. Routes to trap.plugg.
  {
    names: ["nettspend", "autumn", "homixide gang", "homixide", "2hollis"],
    genre: "trap",
    style: "plugg",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [130, 150],
    label: "plugg newer wave",
  },
  // ── Trap soul / R&B-trap — Bryson Tiller / PartyNextDoor / 6LACK ─────────
  // Slow R&B-leaning trap (Bryson Tiller 'TrapSoul' / PartyNextDoor). Drake's
  // existing trap/sparse entry covers the mid-tempo Toronto hybrid; this
  // covers the slow sung-R&B-trap side. BPM 78-95, sparse grooves for vocal
  // lead. Routes to trap.sparse.
  {
    names: ["trap soul", "trapsoul", "bryson tiller", "partynextdoor", "6lack"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [78, 95],
    label: "trap soul",
  },
  // ── Afrobeats / Afropop (modern) — Wizkid / Burna Boy / Davido / Tems ────
  // Modern West-African pop (Wizkid 'Essence' / Burna Boy 'Last Last' /
  // Davido 'Fall'). Routes to house.afropop — the dedicated afrobeats pop
  // groove (3+3+2 kick, rim melody); amapiano / Rema / Tyla stay on
  // house.afro. BPM 100-112.
  {
    names: ["wizkid", "burna boy", "davido", "tems", "asake", "victony", "ayra starr"],
    genre: "house",
    style: "afropop",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [100, 112],
    label: "afrobeats",
  },
  // ── Latin urban / Reggaeton pop — J Balvin / Ozuna / Farruko / Rosalía ───
  // Modern reggaeton-pop (J Balvin 'Mi Gente' / Ozuna / Farruko / Rosalía
  // 'MALAMENTE'). Bad Bunny's existing entry covers the harder perreo side;
  // this covers the brighter dancefloor-pop reggaeton. Routes to
  // house.dembow (the chop). BPM 88-100.
  {
    names: ["j balvin", "ozuna", "farruko", "rosalia", "anuel aa", "anuel"],
    genre: "house",
    style: "dembow",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [88, 100],
    label: "latin urban",
  },
  // ── K-pop / Korean R&B — BTS / NewJeans / IU / Stray Kids / BLACKPINK ────
  // Korean pop production (BTS 'Dynamite' / NewJeans 'OMG' / IU). High-energy
  // pop at 100-120, closest groove is house.pop (the pop-dancefloor side).
  {
    names: ["kpop", "k-pop", "bts", "newjeans", "iu", "stray kids", "blackpink"],
    genre: "house",
    style: "pop",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [100, 120],
    label: "k-pop",
  },
  // ── Dancehall / Reggae-pop — Sean Paul / Damian Marley / Popcaan / Vybz ───
  // Caribbean dancehall (Sean Paul 'Temperature' / Popcaan / Vybz Kartel).
  // The trap.bounce groove (98-104 BPM) is the closest fit — driving
  // half-time riddim with room for the toasting vocal lead. BPM 88-105.
  {
    names: ["dancehall", "sean paul", "damian marley", "popcaan", "vybz kartel", "shaggy"],
    genre: "trap",
    style: "bounce",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [88, 105],
    label: "dancehall",
  },
  // ── City pop (Japanese 80s) — Anri / Tatsuro / Mariya Takeuchi ──────────
  // The 1980s Japanese studio-pop movement (Anri 'Last Summer Whisper' /
  // Tatsuro Yamashita / Mariya Takeuchi 'Plastic Love'). Lush AOR production,
  // 100-125, organic-instrument heavy. Routes to ambient.organic.
  {
    names: ["city pop", "anri", "tatsuro", "tatsuro yamashita", "mariya takeuchi"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [100, 125],
    label: "city pop",
  },
  // ── 88rising / Asian-American pop — Joji / Rich Brian / NIKI ────────────
  // The 88rising wave (Joji 'Sanctuary' / Rich Brian 'Dat $tick'). Lush
  // bedroom-R&B / indie-pop at slower tempos. Routes to trap.lux (closest
  // trap groove for the lo-fi-indie-pop side of the trap spectrum).
  {
    names: ["88rising", "joji", "rich brian", "niki", "atarashii gakko"],
    genre: "trap",
    style: "lux",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [80, 110],
    label: "88rising",
  },
  // ── Trap producers (the "type beat" search language) ───────────────────
  // Anchors: Drip Too Hard 113 (SongBPM), Black Beatles 146, HUMBLE. 150,
  // Life Is Good 142 — trap counts half-time, ranges follow the 130-150
  // production pocket.
  {
    names: ["wheezy"],
    // 808 Mafia melodic corner — airy plucks over sparse knock (Drip Too
    // Hard, Bad and Boujee).
    genre: "trap",
    style: "lux",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [130, 146],
    label: "wheezy",
  },
  {
    names: ["southside", "808 mafia"],
    // 808 Mafia aggressive corner — dark, hard, relentless.
    genre: "trap",
    style: "dark",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [130, 145],
    label: "southside",
  },
  {
    names: ["tm88"],
    // Black Beatles (146) bounce — melodic and playful.
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [138, 150],
    label: "tm88",
  },
  {
    names: ["murda beatz", "murda", "murda on the beat"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 145],
    label: "murda beatz",
  },
  {
    names: ["mike will", "mike will made it", "mike will made-it", "mike will madeit"],
    // HUMBLE. (150) — the hard-hitting dark-keys corner.
    genre: "trap",
    style: "dark",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [138, 150],
    label: "mike will made-it",
  },
  {
    names: ["hit-boy", "hit boy"],
    // Versatile A-list: rolling pockets, wide tempo window.
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [130, 150],
    label: "hit-boy",
  },
  {
    names: ["london on da track", "london on the track"],
    genre: "trap",
    style: "bouncy",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 145],
    label: "london on da track",
  },
  {
    names: ["wondagurl", "wonda"],
    // Cinematic dark trap (Take Care-era, Travis placements).
    genre: "trap",
    style: "dark",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [140, 150],
    label: "wondagurl",
  },
  {
    names: ["sonny digital"],
    genre: "trap",
    style: "rolling",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [130, 145],
    label: "sonny digital",
  },
  // ── Memphis OG producers (the original phonk source tapes) ─────────────
  {
    names: ["dj squeeky"],
    // The lo-fi tape origin — hiss, cowbell, half-time menace.
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 140],
    label: "dj squeeky",
  },
  {
    names: ["dj spanish fly"],
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 140],
    label: "dj spanish fly",
  },
  {
    names: ["kingpin skinny pimp", "skinny pimp"],
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [125, 142],
    label: "kingpin skinny pimp",
  },
  {
    names: ["playa fly"],
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [122, 140],
    label: "playa fly",
  },
  {
    names: ["tommy wright", "tommy wright iii"],
    // Still Pimpin (the tape Beyoncé opened RENAISSANCE with).
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [125, 142],
    label: "tommy wright iii",
  },
  // ── UKG new wave (post-2020 revival) ───────────────────────────────────
  {
    names: ["conducta"],
    // Kiwi Rekords — warm, vocal-forward 2-step revival.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 140],
    label: "conducta",
  },
  {
    names: ["interplanetary criminal"],
    // The 2022 revival anthem corner (B.O.T.A. energy).
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [132, 142],
    label: "interplanetary criminal",
  },
  {
    names: ["sammy virji", "virji"],
    // Bass-forward speed-garage bounce.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 140],
    label: "sammy virji",
  },
  {
    names: ["piri"],
    // piri & tommy — the pop-facing, melodic UKG lane.
    genre: "ukg",
    style: "ukg",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [132, 140],
    label: "piri",
  },
  // ── UK drill second line ────────────────────────────────────────────────
  {
    names: ["ofb", "bandokay"],
    // Broadwater Farm / OFB — dark, sparse, slide-heavy.
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.8,
    density: 0.55,
    bpmRange: [138, 144],
    label: "ofb",
  },
  {
    names: ["loski", "harlem spartans"],
    genre: "drill",
    style: "uk",
    mood: "aggressive",
    energy: 0.85,
    density: 0.6,
    bpmRange: [138, 145],
    label: "loski",
  },
  {
    names: ["digdat"],
    genre: "drill",
    style: "uk",
    mood: "dark",
    energy: 0.75,
    density: 0.55,
    bpmRange: [138, 144],
    label: "digdat",
  },
  // ── Hyperpop wave — A.G. Cook / 100 gecs / Underscores / Danny L Harle ───
  // The PC Music / hyperpop scene (A.G. Cook 'Apple' / 100 gecs 'money
  // machine' / Danny L Harle). Charli XCX's existing entry covers the pop-
  // hyperpop lane; this entry covers the deconstructionist + maximalist side.
  // Routes to trap.hyper (140-160, glitchy + dense).
  {
    names: [
      "a.g. cook",
      "ag cook",
      "100 gecs",
      "100gecs",
      "underscores",
      "danny l harle",
      "iglooghost",
      "hudson mohawke",
    ],
    genre: "hyperpop",
    style: "hyper",
    mood: "energetic",
    energy: 0.9,
    density: 0.8,
    bpmRange: [140, 160],
    label: "hyperpop wave",
  },
  // ── Baile funk — Anitta / MC Kevin o Chris / DJ Rennan da Penha ──────────
  // Brazilian baile funk (Anitta 'Envolver' / MC Kevin o Chris). The closest
  // groove is house.dancefloor (driving four-on-the-floor) since baile funk
  // shares the percussive-bass-led pocket. BPM 130-150.
  {
    names: ["baile funk", "funk carioca", "anitta", "mc kevin o chris", "mc kevin", "dj rennan da penha", "dj guh mix"],
    genre: "house",
    style: "dancefloor",
    mood: "energetic",
    energy: 0.85,
    density: 0.7,
    bpmRange: [130, 150],
    label: "baile funk",
  },
  // ── Corridos tumbados — Peso Pluma / Natanael Cano / Junior H ───────────
  // The corridos-tumbados movement (Peso Pluma 'Ella Baila Sola' / Natanael
  // Cano). Mexican trap-Americana hybrid; closest groove is trap.countrytune
  // (slower 75-90 BPM with country-tinged instrumentation). Routes there.
  // BPM 90-130 to capture the tamborazo-sampling range.
  {
    names: ["corridos tumbados", "peso pluma", "natanael cano", "junior h", "eslabon armado", "fuerza regida"],
    genre: "trap",
    style: "countrytune",
    mood: "dark",
    energy: 0.7,
    density: 0.55,
    bpmRange: [90, 130],
    label: "corridos tumbados",
  },
  // ── Industrial techno / EBM — Surgeon / Ancient Methods / Vatican Shadow ─
  // The industrial-techno / EBM scene (Surgeon 'Lum' / Ancient Methods).
  // Routes to techno.industrial (driving distorted four-on-the-floor).
  // BPM 130-140.
  {
    names: ["industrial techno", "ebm", "surgeon", "ancient methods", "vatican shadow", "boy harsher", "phase fatale"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.9,
    density: 0.65,
    bpmRange: [130, 140],
    label: "industrial techno",
  },
  // ── Footwork / juke — RP Boo / DJ Rashad / Traxman / DJ Deeon ───────────
  // Chicago footwork / juke (RP Boo 'Baby Come On' / DJ Rashad 'Drumma
  // Boy'). Routes to the new 'house.footwork' groove (Wave 3): polyrhythmic
  // kick against a steady snare, busy hats, perc stabs. Straight-grid swing
  // 0 — footwork's signature is dead-grid precision. BPM 155-165.
  {
    names: ["footwork", "juke", "rp boo", "dj rashad", "traxman", "dj deeon", "teklife"],
    genre: "house",
    style: "footwork",
    mood: "energetic",
    energy: 0.95,
    density: 0.75,
    bpmRange: [155, 165],
    label: "footwork / juke",
  },
  // ── Melodic house — Tinlicker / Lane 8 / Yotto / Nora En Pure ────────────
  // Melodic-house / progressive-house (Lane 8 'Brightest Lights' / Tinlicker
  // / Nora En Pure). Ben Böhmer's existing entry covers one flavor; this
  // covers the deeper / more club-oriented melodic side. Routes to
  // house.deep. BPM 120-128.
  {
    names: ["melodic house", "tinlicker", "lane 8", "lane8", "yotto", "nora en pure", "le youth"],
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [120, 128],
    label: "melodic house",
  },
  // ── Plugg / opium producers (the type-beat search language) ─────────────
  // Plugg stays in the 140-160 springy bell pocket (registry's plugg entry);
  // opium/rage sits at 150-165 bouncy (registry's opium rage entry).
  {
    names: ["mexikodro"],
    // The plugg architect (Playboi Carti / UnoTheActivist era) — the
    // springy bell template the whole lane borrows.
    genre: "trap",
    style: "plugg",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [140, 160],
    label: "mexikodro",
  },
  {
    names: ["cashcache"],
    // Pluggnb's modern face — soft bells, gliding 808s.
    genre: "trap",
    style: "plugg",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [140, 160],
    label: "cashcache",
  },
  {
    names: ["xangang"],
    genre: "trap",
    style: "plugg",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [140, 158],
    label: "xangang",
  },
  {
    names: ["senseiatl", "sensei atl"],
    genre: "trap",
    style: "plugg",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [140, 158],
    label: "senseiatl",
  },
  {
    names: ["forza"],
    // Pluggnb keys + vocal-chop textures.
    genre: "trap",
    style: "plugg",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [140, 158],
    label: "forza",
  },
  {
    names: ["f1lthy", "outtatown", "lil 88", "star boy"],
    // The opium production room (Whole Lotta Red era) — distorted rage.
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [150, 165],
    label: "f1lthy / outtatown",
  },
  {
    names: ["ojivolta", "richie souf"],
    // Opium-adjacent A-list rage placements.
    genre: "trap",
    style: "bouncy",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [148, 162],
    label: "ojivolta / richie souf",
  },
  {
    names: ["whitearmor", "yung gud"],
    // Drain Gang / sadboys — ethereal, blurred plugg-gaze. (Bare "drain
    // gang" stays with the yung lean entry above — first-match order.)
    genre: "trap",
    style: "plugg",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [135, 155],
    label: "whitearmor / yung gud",
  },
  // ── Amapiano / afro-house producers ────────────────────────────────────
  // Registry anchors: amapiano 110-115, afro house 120-124 (both house/afro).
  {
    names: ["kabza de small", "dj maphorisa"],
    // The amapiano kings (John Wick era) — log-drum-forward.
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 116],
    label: "kabza de small / maphorisa",
  },
  {
    names: ["mr jazziq", "jazziq"],
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 116],
    label: "mr jazziq",
  },
  {
    names: ["uncle waffles"],
    // The amapiano-to-mainstream bridge (Tanzania).
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [110, 115],
    label: "uncle waffles",
  },
  {
    names: ["major league djz", "major league"],
    genre: "house",
    style: "afro",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [110, 115],
    label: "major league djz",
  },
  {
    names: ["focalistic"],
    // Pitori rap over amapiano — energetic vocal-forward side.
    genre: "house",
    style: "afro",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [110, 115],
    label: "focalistic",
  },
  {
    names: ["kelvin momo", "sun-el musician", "sun el"],
    // Soulful amapiano (smooth piano + vocal pads).
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [110, 116],
    label: "kelvin momo",
  },
  {
    names: ["shimza", "black motion"],
    // Afro-house/afro-tech — deeper, more driving than amapiano.
    genre: "house",
    style: "afro",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [118, 126],
    label: "shimza / black motion",
  },
  {
    names: ["da capo", "eno napa", "kususa", "caiiro"],
    // Afro-house producer school — percussive, melodic, patient.
    genre: "house",
    style: "afro",
    mood: "chill",
    energy: 0.65,
    density: 0.55,
    bpmRange: [118, 126],
    label: "afro house producer school",
  },
  {
    names: ["themba"],
    genre: "house",
    style: "afro",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [120, 126],
    label: "themba",
  },
  // ── Phonk TikTok second wave (glitch/sigilkore + drift next gen) ───────
  // Faster cowbell-forward lane, 145-170 (registry's drift pocket extends
  // to 170 for the TikTok era).
  {
    names: ["hensonn", "g3ox_em", "g3ox em"],
    // The sped-up drift remix generation — maximal cowbell, no restraint.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [150, 170],
    label: "hensonn / g3ox_em",
  },
  {
    names: ["cypariss", "kslv"],
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [145, 165],
    label: "cypariss / kslv",
  },
  {
    names: ["sxmpra"],
    // The "Cowbell Warrior" lane — hard, compressed, vocal-chop driven.
    genre: "phonk",
    style: "drift",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [150, 170],
    label: "sxmpra",
  },
  {
    names: ["mythic", "backwhen", "yung vamp"],
    // The rare-phonk / dark-cloud school (slower, tape-warped).
    genre: "phonk",
    style: "memphis",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [125, 145],
    label: "rare phonk",
  },
  // ── techno depth wave (the genre's biggest hole: 24 presets vs trap's 140) ──
  // Legendary floors that were missing entirely: Detroit, dub techno, acid,
  // micro-house, electro and the 90s UK/US hard techno lineage. All styles
  // resolve to existing techno.* grooves (driving / minimal / dub / acid /
  // industrial / hard / melodic).
  {
    names: ["jeff mills", "the wizard", "purpose maker"],
    // Detroit techno's axis: hypnotic loops, relentless drive, sci-fi motif.
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.9,
    density: 0.65,
    bpmRange: [135, 145],
    label: "jeff mills",
  },
  {
    names: ["richie hawtin", "plastikman", "minus"],
    // Minimal/micro master: sparse, surgical, late-night pressure.
    genre: "techno",
    style: "minimal",
    mood: "dark",
    energy: 0.65,
    density: 0.4,
    bpmRange: [124, 132],
    label: "richie hawtin",
  },
  {
    names: ["derrick may", "mayday", "strings of life"],
    // Detroit's string-heavy high-tech soul.
    genre: "techno",
    style: "melodic",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [125, 133],
    label: "derrick may",
  },
  {
    names: ["juan atkins", "model 500", "cybotron"],
    // Electro-techno originator: machine funk, 808 backbone — now rides the
    // dedicated techno.electro groove instead of driving techno.
    genre: "techno",
    style: "electro",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [125, 135],
    label: "juan atkins",
  },
  {
    // NOTE: no bare "reese" alias — "Reese bass" is a DnB technique and the
    // name would hijack every "reese bass" prompt. Full name only.
    names: ["kevin saunderson", "inner city type beat"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [124, 132],
    label: "kevin saunderson",
  },
  {
    names: ["carl craig", "paperclip people", "69 type beat"],
    // Detroit techno's eclectic edge — from ambient to jacking.
    genre: "techno",
    style: "driving",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [124, 134],
    label: "carl craig",
  },
  {
    names: ["robert hood", "minimal nation", "monobox"],
    // The minimal-nation architect: stripped, loopy, surgical.
    genre: "techno",
    style: "minimal",
    mood: "dark",
    energy: 0.75,
    density: 0.4,
    bpmRange: [128, 138],
    label: "robert hood",
  },
  {
    names: ["octave one", "black water", "lenny burden"],
    genre: "techno",
    style: "melodic",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [124, 132],
    label: "octave one",
  },
  {
    names: ["terrence dixon", "dixon techno"],
    // Detroit's live-improvisation wizard.
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [128, 138],
    label: "terrence dixon",
  },
  {
    names: ["omar s", "omar-s", "fxhe"],
    // Detroit raw analogue house-techno crossover.
    genre: "techno",
    style: "driving",
    mood: "chill",
    energy: 0.65,
    density: 0.5,
    bpmRange: [120, 128],
    label: "omar s",
  },
  {
    names: ["moodymann", "moodyman", "kenny dixon jr"],
    // Detroit deep house-techo soul (raw, sample-driven).
    genre: "techno",
    style: "melodic",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [118, 126],
    label: "moodymann",
  },
  {
    names: ["theo parrish", "sound signature"],
    genre: "techno",
    style: "melodic",
    mood: "chill",
    energy: 0.55,
    density: 0.5,
    bpmRange: [115, 125],
    label: "theo parrish",
  },
  {
    names: ["dave clarke", "red 2", "charcoal"],
    // 90s UK/US hard-but-functional techno.
    genre: "techno",
    style: "hard",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [138, 148],
    label: "dave clarke",
  },
  {
    names: ["ben sims", "hardgroove", "hard groove type beat"],
    // The hardgroove inventor: driving, percussive, no-nonsense.
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.9,
    density: 0.7,
    bpmRange: [136, 145],
    label: "ben sims",
  },
  {
    names: ["oscar mulero", "pole group"],
    genre: "techno",
    style: "driving",
    mood: "dark",
    energy: 0.85,
    density: 0.6,
    bpmRange: [132, 142],
    label: "oscar mulero",
  },
  {
    names: ["dvs1", "dvs-1"],
    genre: "techno",
    style: "driving",
    mood: "dark",
    energy: 0.85,
    density: 0.6,
    bpmRange: [132, 142],
    label: "dvs1",
  },
  {
    names: ["dax j", "monnom black"],
    genre: "techno",
    style: "industrial",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [138, 148],
    label: "dax j",
  },
  {
    names: ["len faki", "figure techno"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [132, 142],
    label: "len faki",
  },
  {
    names: ["speedy j", "public energy", "electric deluxe"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.85,
    density: 0.6,
    bpmRange: [135, 145],
    label: "speedy j",
  },
  {
    names: ["paula temple", "noise manifesto"],
    genre: "techno",
    style: "industrial",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [138, 150],
    label: "paula temple",
  },
  {
    names: ["rebecca black techno", "rebecca black dj"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [138, 148],
    label: "rebecca black",
  },
  {
    names: ["999999999", "nine nine nine"],
    // Modern acid-rave hard techno.
    genre: "techno",
    style: "acid",
    mood: "aggressive",
    energy: 0.95,
    density: 0.7,
    bpmRange: [140, 150],
    label: "999999999",
  },
  {
    names: ["nico moreno", "the acid brother"],
    genre: "techno",
    style: "acid",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [142, 152],
    label: "nico moreno",
  },
  {
    // Matching runs on DE-ACCENTED text, so the alias must be the ASCII form.
    names: ["shlomo techno", "shlomo"],
    genre: "techno",
    style: "industrial",
    mood: "dark",
    energy: 0.85,
    density: 0.6,
    bpmRange: [132, 142],
    label: "shlømo",
  },
  // Acid lineage — the techno.acid groove had NO artist entries at all.
  {
    names: ["dj pierre", "phuture", "acid tracks"],
    // The acid-house fountainhead (Chicago 1987).
    genre: "techno",
    style: "acid",
    mood: "energetic",
    energy: 0.85,
    density: 0.6,
    bpmRange: [122, 132],
    label: "dj pierre",
  },
  {
    names: ["hardfloor", "acid bath"],
    genre: "techno",
    style: "acid",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 140],
    label: "hardfloor",
  },
  {
    names: ["emmanuel top", "acid phase"],
    genre: "techno",
    style: "acid",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [135, 145],
    label: "emmanuel top",
  },
  {
    // No bare "plug" — it is a generic English word ("plug in") and the
    // plugg roster in trap already owns that sound space.
    names: ["luke vibert", "wagon christ"],
    genre: "techno",
    style: "acid",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [120, 135],
    label: "luke vibert",
  },
  {
    names: ["tin man", "acid test"],
    genre: "techno",
    style: "acid",
    mood: "dark",
    energy: 0.7,
    density: 0.5,
    bpmRange: [122, 132],
    label: "tin man",
  },
  {
    names: ["donato dozzy", "voices from the lake"],
    // Hypnotic/psychedelic techno — slow, deep, trippy.
    genre: "techno",
    style: "dub",
    mood: "dark",
    energy: 0.6,
    density: 0.4,
    bpmRange: [122, 132],
    label: "donato dozzy",
  },
  // Dub techno — an entire sub-genre with zero presets (the techno.dub groove
  // existed with no artist consumer).
  {
    names: ["basic channel", "maurizio", "rhythm & sound", "rhythm and sound"],
    // The Berlin dub-techno originators (Chord/Quadrant lineage).
    genre: "techno",
    style: "dub",
    mood: "chill",
    energy: 0.45,
    density: 0.35,
    bpmRange: [118, 128],
    label: "basic channel",
  },
  {
    names: ["deepchord", "cv313", "rod modell"],
    // Modern dub techno's deep end.
    genre: "techno",
    style: "dub",
    mood: "chill",
    energy: 0.45,
    density: 0.35,
    bpmRange: [118, 126],
    label: "deepchord",
  },
  {
    names: ["deadbeat", "scott monteith"],
    genre: "techno",
    style: "dub",
    mood: "chill",
    energy: 0.5,
    density: 0.4,
    bpmRange: [120, 130],
    label: "deadbeat",
  },
  {
    names: ["monolake", "robert henke"],
    genre: "techno",
    style: "dub",
    mood: "dark",
    energy: 0.6,
    density: 0.45,
    bpmRange: [125, 135],
    label: "monolake",
  },
  {
    names: ["yagya", "quantec", "bvdub"],
    genre: "techno",
    style: "dub",
    mood: "chill",
    energy: 0.4,
    density: 0.35,
    bpmRange: [112, 124],
    label: "yagya",
  },
  {
    names: ["villalobos", "ricardo villalobos"],
    // Micro-house's maximal-minimal maestro.
    genre: "techno",
    style: "minimal",
    mood: "chill",
    energy: 0.55,
    density: 0.45,
    bpmRange: [120, 128],
    label: "villalobos",
  },
  {
    // No bare "zip" / "perlon" alone is fine but "zip" is a common word —
    // both stay qualified.
    names: ["zip type beat", "sonja moonear", "perlon type beat"],
    genre: "techno",
    style: "minimal",
    mood: "chill",
    energy: 0.6,
    density: 0.45,
    bpmRange: [122, 130],
    label: "perlon",
  },
  // Electro — Detroit's other half; rides the dedicated techno.electro groove.
  {
    names: ["drexciya", "dopplereffekt", "japanese telecom"],
    genre: "techno",
    style: "electro",
    mood: "dark",
    energy: 0.75,
    density: 0.6,
    bpmRange: [125, 138],
    label: "drexciya",
  },
  {
    names: ["dj stingray", "313 bass mechanics"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.8,
    density: 0.65,
    bpmRange: [128, 140],
    label: "dj stingray",
  },
  {
    names: ["helena hauff", "return to mono"],
    genre: "techno",
    style: "driving",
    mood: "dark",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 140],
    label: "helena hauff",
  },
  {
    names: ["aux 88", "cybotron electro", "electro techno"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [125, 135],
    label: "aux 88",
  },
  {
    names: ["client_03", "client 03"],
    genre: "techno",
    style: "driving",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 140],
    label: "client_03",
  },
  // ── experimental edges (roadmap wave 12) + score/neoclassical depth ──
  {
    names: ["kevin abstract", "brockhampton", "bh"],
    // Hyperpop-adjacent boyband: genre-hopping, bright, restless.
    genre: "trap",
    style: "hyper",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [120, 150],
    label: "brockhampton",
  },
  // (clipping. already has its phonk/horror entry above — not re-added)
  {
    names: ["dalek", "dälek type beat", "clouddead", "cLOUDDEAD type beat"],
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.45,
    density: 0.45,
    bpmRange: [80, 100],
    label: "abstract hip-hop",
  },
  {
    names: ["flying lotus", "flylo", "brainfeeder"],
    // LA beat-scene experimental: wonky, cosmic, jazzy.
    genre: "ambient",
    style: "glitch",
    mood: "energetic",
    energy: 0.65,
    density: 0.6,
    bpmRange: [90, 110],
    label: "flying lotus",
  },
  {
    names: ["rapsody type beat", "rapsody"],
    genre: "trap",
    style: "classic",
    mood: "chill",
    energy: 0.5,
    density: 0.5,
    bpmRange: [85, 95],
    label: "rapsody",
  },
  {
    names: ["currensy", "spitta", "wiz khalifa", "taylor gang"],
    genre: "trap",
    style: "sparse",
    mood: "chill",
    energy: 0.5,
    density: 0.45,
    bpmRange: [120, 132],
    label: "currensy",
  },
  {
    // Neoclassical / modern score — the ambient genre's biggest hole.
    names: ["ludovico einaudi", "einaudi", "olafur arnalds", "nils frahm"],
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.35,
    density: 0.35,
    bpmRange: [60, 85],
    label: "neoclassical",
  },
  {
    names: ["max richter", "hildur", "johann johannsson", "hans zimmer type beat", "clint mansell"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.4,
    density: 0.4,
    bpmRange: [55, 80],
    label: "modern score",
  },
  {
    names: ["vangelis", "jean-michel jarre", "jean michel jarre", "tangerine dream type beat"],
    genre: "ambient",
    style: "organic",
    mood: "energetic",
    energy: 0.5,
    density: 0.5,
    bpmRange: [80, 110],
    label: "cosmic classical",
  },
  {
    names: ["steve roach", "robert rich", "alva noto", "ryuichi sakamoto"],
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.3,
    density: 0.3,
    bpmRange: [50, 75],
    label: "deep ambient",
  },
  {
    names: ["loscil", "biosphere", "hammock"],
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.35,
    density: 0.35,
    bpmRange: [60, 90],
    label: "isolationism",
  },
  // (footwork / juke already has a roster entry above — not re-added)
  // 2-step garage lineage (UKG had the revival wave but not the originators).
  {
    names: ["mj cole", "artful dodger", "craig david type beat"],
    genre: "ukg",
    style: "ukg",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [128, 136],
    label: "2-step origin",
  },
  {
    names: ["zed bias", "el-b", "el b", "wookie"],
    // The dark side of UKG — ghostly, sub-heavy.
    genre: "ukg",
    style: "ukg",
    mood: "dark",
    energy: 0.65,
    density: 0.55,
    bpmRange: [130, 138],
    label: "dark 2-step",
  },
  // Big-beat / breaks lineage (house family, the breaks floor).
  {
    // No bare "big beat" — generic English that would hijack any promo text.
    names: ["fatboy slim", "chemical brothers", "crystal method"],
    genre: "house",
    style: "bigbeat",
    mood: "energetic",
    energy: 0.9,
    density: 0.7,
    bpmRange: [125, 140],
    label: "big beat",
  },
  {
    names: ["prodigy", "orbital", "underworld", "leftfield"],
    genre: "techno",
    style: "driving",
    mood: "aggressive",
    energy: 0.9,
    density: 0.65,
    bpmRange: [128, 145],
    label: "90s rave",
  },
  // ── Jersey / Baltimore / UKG producer depth (the crate-digger lane) ────
  // Jersey club: 134-142 (jersey.club groove); Baltimore club runs the same
  // breakbeat at a touch slower (125-135); bassline/speed garage 130-140
  // (house.ukg groove).
  {
    names: ["dj lilman", "lilman"],
    // The 2010s jersey-club second wave (festival circuit, club-anthem).
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [134, 142],
    label: "dj lilman",
  },
  {
    names: ["kayy drizz"],
    // The dance-challenge vocal queen of the new wave.
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [134, 142],
    label: "kayy drizz",
  },
  {
    names: ["so dellirious", "dellirious"],
    // Brick Bandits-adjacent — original-era bounce feel.
    genre: "jersey",
    style: "bounce",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [130, 138],
    label: "so dellirious",
  },
  {
    names: ["dj problem"],
    // Newark drill-era club flips — hard 140 landing.
    genre: "jersey",
    style: "flip",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [136, 144],
    label: "dj problem",
  },
  {
    names: ["dj delish"],
    genre: "jersey",
    style: "flip",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [134, 142],
    label: "dj delish",
  },
  {
    names: ["dj tim dolla"],
    // Original Brick Bandits crew — the foundation tempo.
    genre: "jersey",
    style: "club",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [128, 136],
    label: "dj tim dolla",
  },
  // Baltimore club — the parent genre (slower, breakbeat + "Think" chops).
  {
    names: ["baltimore club", "dj k-swift", "k-swift", "scottie b", "debonair samir"],
    // Scottie B / K-Swift / Debonair Samir — the Unruly Records school, on
    // the dedicated "Think"-break stomp groove (not the jersey triple-kick).
    genre: "jersey",
    style: "baltimore",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [125, 135],
    label: "baltimore club",
  },
  {
    names: ["kw griff", "dj technics", "miss tonya", "rod lee"],
    // The deeper Baltimore lineage (Rod Lee / Technics / KW Griff).
    genre: "jersey",
    style: "baltimore",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [125, 135],
    label: "baltimore lineage",
  },
  {
    names: ["blaqstarr"],
    // Baltimore-to-global (Diplo co-signs) — chant-forward breaks.
    genre: "jersey",
    style: "bounce",
    mood: "aggressive",
    energy: 0.85,
    density: 0.65,
    bpmRange: [126, 136],
    label: "blaqstarr",
  },
  // UKG / bassline / speed garage producers.
  {
    names: ["salute"],
    // The 2020s UKG-via-electronic-pop lane — bright, emotional, club-ready.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [132, 140],
    label: "salute",
  },
  {
    names: ["barry can't swim", "barry cant swim"],
    // The UKG-adjacent indie-dance crossover (emotional, vocal-led).
    genre: "ukg",
    style: "ukg",
    mood: "chill",
    energy: 0.7,
    density: 0.55,
    bpmRange: [128, 136],
    label: "barry can't swim",
  },
  {
    names: ["dj q", "t2", "burgaboy", "jamie duggan", "trc"],
    // Bassline / Niche Sheffield school — speed-garage bass pressure.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [132, 140],
    label: "bassline / niche",
  },
  // ── Hyperpop deconstruction + sigilkore/hexd underworld ────────────────
  // hyper lane, 140-170 (trap.hyper groove); the sigilkore/hexd world keeps
  // the same lane but slower and murkier (130-155).
  {
    names: ["umru", "felicita", "easyfun", "life sim", "hdmird"],
    // The PC Music production room outside A.G. Cook — deconstructed club
    // maximalism (umru, felicita, easyFun).
    genre: "hyperpop",
    style: "hyper",
    mood: "energetic",
    energy: 0.9,
    density: 0.8,
    bpmRange: [150, 170],
    label: "pc music room",
  },
  {
    names: ["shygirl", "jockstrap", "black dresses"],
    // The art-pop / deconstructed-club edge (Shygirl, Jockstrap, Black
    // Dresses) — vocals against broken club pressure.
    genre: "hyperpop",
    style: "hyper",
    mood: "aggressive",
    energy: 0.85,
    density: 0.75,
    bpmRange: [140, 165],
    label: "deconstructed club",
  },
  {
    names: ["machine girl", "alice gas"],
    // Digital hardcore / breakcore revival — punk speed + electronic rage.
    genre: "dnb",
    style: "amen",
    mood: "aggressive",
    energy: 0.95,
    density: 0.75,
    bpmRange: [170, 180],
    label: "digital hardcore",
  },
  {
    names: ["food house", "gupi", "fraxiom", "that kid"],
    // The 2020 hyperpop scene's DIY heart (food house = gupi + fraxiom).
    genre: "hyperpop",
    style: "hyper",
    mood: "energetic",
    energy: 0.9,
    density: 0.8,
    bpmRange: [150, 170],
    label: "hyperpop DIY",
  },
  {
    names: ["sewerslvt", "goreshit"],
    // Breakcore / jungle's internet revival — amen choppage + melancholy.
    genre: "dnb",
    style: "amen",
    mood: "dark",
    energy: 0.9,
    density: 0.7,
    bpmRange: [170, 180],
    label: "breakcore revival",
  },
  {
    names: ["luci4", "sellasouls", "nosgov", "axxturel"],
    // Sigilkore — the occult-coded plugg/hexd underworld (Luci4 / Sellasouls).
    genre: "trap",
    style: "hyper",
    mood: "dark",
    energy: 0.85,
    density: 0.7,
    bpmRange: [135, 155],
    label: "sigilkore",
  },
  {
    names: ["sematary", "ghost mountain", "buckshot", "turnabout", "hackle"],
    // Haunted Mound — the trap-rave/goth-country fusion (Sematary crew).
    genre: "trap",
    style: "hyper",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [140, 165],
    label: "haunted mound",
  },
  {
    names: ["salem", "crim3s", "ooooo", "white ring"],
    // Witch house — the 2010 originators (slowed, chopped, occult).
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.35,
    density: 0.45,
    bpmRange: [70, 90],
    label: "witch house",
  },
  {
    names: ["crystal castles", "ic3peak", "zheani", "kumo 99"],
    // The dark-electronic / witch-adjacent vocal lane.
    genre: "ambient",
    style: "glitch",
    mood: "aggressive",
    energy: 0.8,
    density: 0.65,
    bpmRange: [80, 120],
    label: "dark electronic",
  },
  // ── house depth wave — the genre's FOUNDING history was missing entirely ──
  // Chicago (1984-88), Detroit house, the NJ/NY garage axis, French filter
  // and the modern deep/melodic school. All styles resolve to existing
  // house.* grooves (soulful / deep / funky / driving / disco / minimal).
  {
    names: ["frankie knuckles", "the godfather of house", "knuckles"],
    // Chicago house's founding DJ — the Warehouse/Paradise sound.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [118, 126],
    label: "frankie knuckles",
  },
  {
    names: ["larry heard", "mr fingers", "fingers inc", "fingers inc."],
    // The other Chicago pillar — deep, melancholy, string-led.
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [116, 124],
    label: "larry heard",
  },
  {
    names: ["marshall jefferson", "move your body house"],
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [118, 126],
    label: "marshall jefferson",
  },
  {
    names: ["ron hardy", "music box chicago"],
    // The wilder Chicago counterpoint — raw, jacking, tape edits.
    genre: "house",
    style: "funky",
    mood: "aggressive",
    energy: 0.8,
    density: 0.6,
    bpmRange: [120, 128],
    label: "ron hardy",
  },
  {
    names: ["steve hurley", "farley jackmaster funk", "jesse saunders", "chip e", "adonis house"],
    // The Chicago production/compilation era (Trax / DJ International).
    genre: "house",
    style: "funky",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [118, 128],
    label: "chicago trax",
  },
  {
    names: ["ten city", "byron stingily", "inner city house"],
    // Chicago's vocal-house wing.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.7,
    density: 0.55,
    bpmRange: [114, 124],
    label: "chicago vocal",
  },
  {
    names: ["blake baxter", "eddie fowlkes", "kelli hand", "terrence parker", "dream 2 science"],
    // Detroit house — techno's soulful sibling (the house side of the axis).
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [118, 128],
    label: "detroit house",
  },
  {
    names: ["kerri chandler", "kaidi tatham", "apollo era"],
    // The NJ deep-house master — warm, spiritual, endless grooves.
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [118, 126],
    label: "kerri chandler",
  },
  {
    names: ["tony humphries", "basement boys", "jovonn", "dj spen"],
    // The Jersey/Baltimore garage-house axis.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [120, 128],
    label: "jersey house",
  },
  {
    names: ["masters at work", "little louie vega", "louie vega", "kenny dope", "maw house"],
    // The NYC production duo that defined 90s garage house.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [120, 128],
    label: "masters at work",
  },
  {
    names: ["todd terry", "strictly rhythm type beat", "mark kinchen"],
    genre: "house",
    style: "funky",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [120, 128],
    label: "todd terry",
  },
  {
    names: ["larry levan", "paradise garage", "david morales", "danny tenaglia", "francois k", "joe claussell"],
    // The NY loft/garage DJ lineage — long, ecstatic, vocal-driven sets.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [118, 128],
    label: "ny loft",
  },
  {
    // kavinsky already lives in the synthwave entry above — this block owns
    // the darker French-electro lineage only. "justice" stays qualified (a
    // generic word alone would shadow unrelated prompts).
    names: ["gesaffelstein", "justice type beat", "sebastian ed banger"],
    genre: "techno",
    style: "driving",
    mood: "dark",
    energy: 0.85,
    density: 0.6,
    bpmRange: [120, 132],
    label: "darksynth (fr)",
  },
  {
    names: ["french house", "daft punk type beat", "cassius", "stardust", "alan braxe", "breakbot"],
    // The filter-house school — Daft Punk's family. (Bare "daft punk" is
    // deliberately NOT an alias: the robot-duo name alone is a genre word and
    // would shadow every "daft punk" prompt the pop roster may want.)
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [118, 126],
    label: "french filter house",
  },
  {
    names: ["bob sinclar", "martin solveig", "modjo"],
    // The 2000s French touch revival.
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [118, 126],
    label: "french touch 2000s",
  },
  {
    // tinlicker / lane 8 / yotto / nora en pure already live in the melodic
    // house entry above — this block owns Marsh only (the qualified spelling
    // keeps the habitat word safe).
    names: ["marsh house"],
    // Modern melodic/deep-progressive school.
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [118, 124],
    label: "melodic deep",
  },
  {
    names: ["harrison bdp", "fouk", "braxton", "djt"],
    genre: "house",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 128],
    label: "uk deep house",
  },
  {
    names: ["jody wisternoff", "anja schneider", "maya jane coles"],
    genre: "house",
    style: "minimal",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [120, 126],
    label: "minimal deep",
  },
  {
    names: ["robert owens", "adeva", "barbara tucker"],
    // The classic vocal-house voices.
    genre: "house",
    style: "soulful",
    mood: "energetic",
    energy: 0.7,
    density: 0.5,
    bpmRange: [118, 126],
    label: "vocal house",
  },
  {
    names: ["atjazz", "osunlade", "quintus"],
    genre: "house",
    style: "soulful",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [116, 126],
    label: "afro-soul house",
  },
  {
    names: ["musa keys", "young stunna", "de mthuda", "sir trill"],
    // Amapiano second line (the school's next generation).
    genre: "house",
    style: "afro",
    mood: "energetic",
    energy: 0.7,
    density: 0.6,
    bpmRange: [110, 116],
    label: "amapiano wave 2",
  },
  {
    names: ["giorgio moroder", "cerrone", "disco generic", "eurodisco"],
    // The pre-house disco/eurodisco foundation.
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [110, 124],
    label: "eurodisco",
  },
  {
    // nile rodgers / chic already have their disco entry above — this block
    // owns the remaining 70s disco/boogie names only.
    names: ["sister sledge", "kool and the gang", "arthur russell"],
    // The 70s disco/boogie wellspring house music grew from.
    genre: "house",
    style: "disco",
    mood: "energetic",
    energy: 0.75,
    density: 0.55,
    bpmRange: [104, 120],
    label: "disco origin",
  },
  // ── ambient / score depth wave — the roster's thinnest genre (37) ────────
  // Missing entirely: the ambient originators' peers, drone/dark ambient,
  // new age/Japanese environmental, modern composition and the score
  // composers. Styles ride existing ambient.* grooves (drifting / glitch /
  // organic) — no new DSP, and every alias below is collision-checked.
  {
    names: ["harold budd", "robert fripp", "fripp type beat", "larry fast"],
    // The Eno collaborators — 4th world / ambient guitar.
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.3,
    density: 0.3,
    bpmRange: [55, 80],
    label: "4th world",
  },
  {
    names: ["terry riley", "la monte young", "pauline oliveros"],
    // The minimalist avant-garde ancestors (drone/just intonation).
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.3,
    density: 0.25,
    bpmRange: [50, 75],
    label: "minimalist avant",
  },
  {
    // "coil" alone is a common word — the alias stays qualified.
    names: ["coil type beat", "throbbing gristle", "nurse with wound"],
    // Industrial's ambient underbelly — musique concrète, tape, dread.
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.4,
    density: 0.45,
    bpmRange: [70, 100],
    label: "industrial ambient",
  },
  {
    names: ["lustmord", "sunn o)))", "sunn o", "kevin drumsm", "deathprod"],
    // Dark ambient / drone metal's low-end: monumental, slow, cavernous.
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.25,
    density: 0.3,
    bpmRange: [40, 70],
    label: "dark drone",
  },
  {
    names: ["svarte greiner", "kammarheit", "desiderii margini", "raison d'etre", "eleh"],
    // The isolationist / "death ambient" school.
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.25,
    density: 0.35,
    bpmRange: [45, 75],
    label: "isolationist",
  },
  {
    names: ["laraaji", "constance demby", "george winston", "windham hill", "hiroshi yoshimura"],
    // New age / healing: bright, meditative, acoustic-electronic.
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.3,
    density: 0.3,
    bpmRange: [55, 85],
    label: "new age",
  },
  {
    names: ["midori takada", "satoshi ashikawa", "yasuaki shimizu", "kankyo ongaku"],
    // Japanese environmental music — the kankyō ongaku school.
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.3,
    density: 0.35,
    bpmRange: [60, 90],
    label: "kankyō ongaku",
  },
  {
    names: ["philip glass", "steve reich", "michael nyman"],
    // The minimalists proper — pulsing, repetitive, film-score DNA.
    genre: "ambient",
    style: "organic",
    mood: "energetic",
    energy: 0.55,
    density: 0.6,
    bpmRange: [90, 130],
    label: "minimalist",
  },
  {
    names: [
      "ennio morricone",
      "angelo badalamenti",
      "james horner",
      "john williams",
      "howard shore",
      "alexandre desplat",
    ],
    // The orchestral score tradition.
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.4,
    density: 0.45,
    bpmRange: [55, 90],
    label: "orchestral score",
  },
  {
    names: ["thomas newman", "trent reznor", "atticus ross", "yann tiersen", "jozef van wissem"],
    // Modern film / television composers (the "prestige drama" palette).
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.35,
    density: 0.4,
    bpmRange: [55, 85],
    label: "modern score",
  },
  {
    names: ["lubomyr melnyk", "peter broderick", "goldmund", "dustin ohalloran"],
    // Continuous-music piano / post-classical minimalism.
    genre: "ambient",
    style: "organic",
    mood: "chill",
    energy: 0.4,
    density: 0.5,
    bpmRange: [60, 100],
    label: "post-classical",
  },
  {
    names: ["caterina barbieri", "alessandro cortini", "sarah davachi", "kali malone"],
    // Modular/electroacoustic composition — the modern art wing.
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.35,
    density: 0.4,
    bpmRange: [55, 85],
    label: "electroacoustic",
  },
  {
    names: ["kaitlyn aurelia smith", "emily a sprague", "julianna barwick", "ana roxanne", "claire rousay"],
    // The 2010s ambient revival (voice-as-texture, tape, patience).
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.3,
    density: 0.35,
    bpmRange: [55, 90],
    label: "ambient revival",
  },
  {
    names: ["huerco s", "lilien rosarian", "space afrika"],
    genre: "ambient",
    style: "glitch",
    mood: "chill",
    energy: 0.4,
    density: 0.45,
    bpmRange: [70, 110],
    label: "ambient club",
  },
  {
    // moore mother / lotic / herndon live in the hyperpop + experimental
    // entries above where relevant — no "arca" here (it has its own entry).
    names: ["moor mother", "lotic", "holly herndon"],
    // Experimental club's ambient/industrial edge.
    genre: "ambient",
    style: "glitch",
    mood: "aggressive",
    energy: 0.55,
    density: 0.55,
    bpmRange: [70, 120],
    label: "experimental club",
  },
  {
    names: ["ryoji ikeda", "florian hecker", "alva noto type beat", "ben frost"],
    // The glitch/ultrasonic school — sine, noise, system.
    genre: "ambient",
    style: "glitch",
    mood: "dark",
    energy: 0.4,
    density: 0.5,
    bpmRange: [60, 110],
    label: "glitch school",
  },
  {
    names: ["haxan cloak", "squarepusher", "venetian snares", "amon tobin"],
    // Drill'n'bass / breakcore's experimental wing (ambient-adjacent).
    genre: "ambient",
    style: "glitch",
    mood: "aggressive",
    energy: 0.75,
    density: 0.7,
    bpmRange: [120, 175],
    label: "breakcore experimental",
  },
  {
    names: ["global communication", "solar fields", "purl", "segue", "brock van wey"],
    // Ambient techno / dub ambient (the chill side of the techno axis).
    genre: "ambient",
    style: "drifting",
    mood: "chill",
    energy: 0.35,
    density: 0.4,
    bpmRange: [70, 110],
    label: "ambient techno",
  },
  {
    names: ["explosions in the sky", "mogwai", "sigur ros", "this will destroy you", "balmorhea"],
    // Post-rock — the crescendo guitar school (score's loud sibling).
    genre: "ambient",
    style: "drifting",
    mood: "energetic",
    energy: 0.6,
    density: 0.5,
    bpmRange: [70, 120],
    label: "post-rock",
  },
  {
    names: ["godspeed you black emperor", "godspeed you! black emperor", "gybe"],
    genre: "ambient",
    style: "drifting",
    mood: "dark",
    energy: 0.5,
    density: 0.5,
    bpmRange: [60, 100],
    label: "post-rock dark",
  },
  // ── UKG depth wave — the genre had 14 entries and none of its history ────
  // Originators (2-step/speed garage), the bassline/niche north, the deep
  // dark side, the UK funky/afroswing bridge and the speed-garage revival.
  // Styles ride ukg.ukg / ukg.bassline / ukg.deep (all first-class grooves).
  {
    names: ["so solid crew", "so solid", "oxide neutrino", "groove chronicles", "dem 2", "tuff jam", "grant nelson"],
    // The 1998-2001 UKG golden era: pirate-radio 2-step and speed garage.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [128, 136],
    label: "ukg originators",
  },
  {
    names: ["todd edwards", "armand van helden", "187 lockdown", "double 99", "ripperman", "baffled republic"],
    // Speed garage — the 4x4 reese-bass wing (Todd Edwards' garage cuts).
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [130, 138],
    label: "speed garage",
  },
  {
    names: ["tina moore", "spun", "kronz", "nu birth"],
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [130, 138],
    label: "garage vocal",
  },
  {
    names: ["ts7", "booda", "paleface", "witney", "trc bassline"],
    // Bassline / Niche (the Sheffield-Leeds north sound).
    genre: "ukg",
    style: "bassline",
    mood: "aggressive",
    energy: 0.9,
    density: 0.7,
    bpmRange: [134, 142],
    label: "niche bassline",
  },
  {
    names: ["horsepower productions", "benny ill", "kode9", "loefah"],
    // The dark 2-step / proto-dubstep corridor (El-B's lineage).
    genre: "ukg",
    style: "deep",
    mood: "dark",
    energy: 0.6,
    density: 0.5,
    bpmRange: [132, 140],
    label: "dark 2-step",
  },
  {
    // "uk funky" is owned by the house.ukfunky entries — this block owns the
    // dubstep-side spelling only.
    names: ["crazy cousins", "appleblim"],
    // UK funky — the 2008 bridge between garage and house.
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.8,
    density: 0.6,
    bpmRange: [126, 134],
    label: "uk funky",
  },
  {
    // mostack / nsg already have their afroswing entry — this block owns the
    // remaining names only.
    names: ["kojo funds", "yungen"],
    // Afroswing — the afrobeat/UKG hybrid (rides ukg.ukg).
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.75,
    density: 0.6,
    bpmRange: [100, 110],
    label: "afroswing",
  },
  {
    names: ["main phase", "badger", "ellie ukg", "hamdi"],
    // Speed-garage revival (the post-2020 4x4 wave).
    genre: "ukg",
    style: "ukg",
    mood: "energetic",
    energy: 0.85,
    density: 0.65,
    bpmRange: [132, 140],
    label: "speed garage now",
  },
  {
    names: ["mura masa", "joy anonymous", "bakongo", "north base"],
    // The indie-adjacent UKG/bass crossover.
    genre: "ukg",
    style: "deep",
    mood: "chill",
    energy: 0.6,
    density: 0.5,
    bpmRange: [126, 136],
    label: "ukg crossover",
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
    /** Primary artist label — keys the artist mix-signature table. */
    artist?: string;
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
      // The PRIMARY artist keys the mix-signature table in blends.
      artist: a.label,
    },
    label: `${a.label} × ${b.label}`,
  };
}

/** Named-plugin concept words an artist preset carries (empty when none). */
export function fxWordsForArtist(label: string | undefined | null): readonly string[] {
  if (!label) return [];
  return ARTIST_PRESETS.find((p) => p.label === label)?.fx ?? [];
}
