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

interface CompactArtistPreset {
  n: string;
  g: IntentGenre;
  s?: string;
  p?: ProductionProfile;
  m?: ArtistPreset["mood"];
  e?: number;
  d?: number;
  b?: [number, number];
  f?: ArtistPreset["flow"];
  l: string;
  x?: readonly string[];
}

function decodeArtistAliases(encoded: string): string[] {
  return encoded.split("|").map((name) => (name.endsWith("~") ? `${name.slice(0, -1)} type beat` : name));
}

function decodeArtistPresets(rows: readonly CompactArtistPreset[]): ArtistPreset[] {
  return rows.map((row) => {
    const preset: ArtistPreset = { names: decodeArtistAliases(row.n), genre: row.g, label: row.l };
    if (row.s !== undefined) preset.style = row.s;
    if (row.p !== undefined) preset.productionProfile = row.p;
    if (row.m !== undefined) preset.mood = row.m;
    if (row.e !== undefined) preset.energy = row.e;
    if (row.d !== undefined) preset.density = row.d;
    if (row.b !== undefined) preset.bpmRange = row.b;
    if (row.f !== undefined) preset.flow = row.f;
    if (row.x !== undefined) preset.fx = row.x;
    return preset;
  });
}

export const ARTIST_PRESETS: readonly ArtistPreset[] = decodeArtistPresets([
  // ── trap / hip-hop ──────────────────────────────────────────────────────
  {
    n: "travis scott|travis scott~",
    g: "trap",
    s: "rolling",
    p: "dark-atmospheric-trap",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [130, 140],
    f: "triplet",
    l: "travis scott",
  },
  {
    n: "kid cudi|cudi|kid cudi~",
    g: "trap",
    s: "lux",
    p: "spacey-melodic-rap",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [118, 128],
    l: "kid cudi",
  },
  {
    n: "metro boomin|metroboomin",
    // Dark sparse pocket (no trap.dark groove; trap.sparse is the real lane).
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.65,
    d: 0.5,
    b: [130, 140],
    l: "metro boomin",
  },
  {
    n: "21 savage|21 savage~",
    // Dark sparse pocket (no trap.dark groove; trap.sparse is the real lane).
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [130, 140],
    l: "21 savage",
  },
  {
    n: "playboi carti|carti~|rage beat|rage~",
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [150, 165],
    l: "rage (carti)",
  },
  {
    n: "yeat|yeat~",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [150, 160],
    l: "yeat",
  },
  {
    n: "southstar|south star|kyle beat",
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [150, 160],
    l: "hyper-rage",
  },
  {
    n: "pop smoke|uk drill|central cee|drill~",
    // First-class drill since the sound-quality pass — own grooves + kit swap
    // (sliding-808 kick, dark snare) instead of folding into trap.
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.65,
    d: 0.45,
    b: [140, 145],
    f: "offbeat",
    l: "drill",
  },
  {
    n: "ice spice|jersey club|jersey beat",
    // First-class jersey since the sound-quality pass — bouncy club grooves
    // + punchy kit instead of folding into trap.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [134, 142],
    l: "jersey",
  },
  {
    n: "pendulum|liquid dnb",
    g: "dnb",
    s: "liquid",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [172, 178],
    l: "dnb",
  },
  {
    n: "kanye|kanye west|kanye~|boom bap|boombap|boom-bap",
    g: "boombap",
    s: "golden",
    // boom-bap warmth = classic style + low energy + slow BPM (no canonical
    // "warm" mood exists in mapIntentToOptions)
    e: 0.55,
    d: 0.5,
    b: [86, 92],
    l: "boom bap",
  },
  // ── west coast / g-funk (researched pocket: Still D.R.E. ~93, G Thang /
  // Gin and Juice / Regulate ~95 — all mapped to the trap.headnod /
  // trap.gfunk grooves) ───────────────────────────────────────────────────
  {
    n: "snoop|snoop dogg|snoop~|doggy style|doggystyle",
    g: "trap",
    s: "headnod",
    m: "chill",
    e: 0.55,
    d: 0.55,
    b: [92, 96],
    f: "offbeat",
    l: "snoop dogg",
  },
  {
    n: "dre|dr dre|dr. dre|dre~|chronic|2001",
    g: "trap",
    s: "gfunk",
    m: "dark",
    e: 0.6,
    d: 0.55,
    b: [93, 96],
    f: "straight",
    l: "dr. dre",
  },
  {
    n: "warren g|warren|regulate|nate dogg|nate",
    // Regulate (Warren G ft. Nate Dogg) — same 95 BPM pocket, one entry
    // serves both names; the sung-hook feel is the groove's laid-back snare.
    g: "trap",
    s: "headnod",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [94, 96],
    l: "warren g & nate dogg",
  },
  {
    n: "ty dolla|ty dolla sign|ty dolla $ign|ty$|modern west",
    // Modern west coast: a touch faster and harder than the 90s pocket.
    g: "trap",
    s: "gfunk",
    m: "energetic",
    e: 0.65,
    d: 0.6,
    b: [95, 105],
    l: "ty dolla $ign",
  },
  // ── house / club ────────────────────────────────────────────────────────
  {
    n: "fred again~|fred again.. type|actual life",
    // The Actual Life sound: choppy UKG-influenced house, emotional vocal
    // cuts, punchy low end — lands on ukg grooves with driving energy.
    // Listed BEFORE the plain-name preset so the "type beat" phrasing
    // (the beat-maker language) wins the first-match order.
    g: "house",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.65,
    b: [130, 145],
    l: "fred again (ukg)",
  },
  {
    n: "fred again|fred again..",
    g: "house",
    s: "deep",
    e: 0.75,
    d: 0.6,
    b: [128, 136],
    l: "fred again",
  },
  // ── electronic wave additions: sophie / burial / hyperpop ─────────────
  // (overmono/flume/duskus already live in the culture-wave roster below —
  // first-match order means duplicates here would shadow them)
  {
    n: "burial|burial~",
    // The future garage school: heavy shuffle, skittery ghost hats,
    // atmosphere over pressure — ambient.futuregarage groove (the genre
    // home the culture wave gave future garage).
    g: "ambient",
    s: "future garage",
    m: "dark",
    e: 0.45,
    d: 0.45,
    b: [130, 140],
    x: ["lofi"],
    l: "burial / future garage",
  },
  {
    n: "hyperpop|hyper pop|hyperpop~",
    // The generic hyperpop ask — extreme BPM and energy on the hyper groove.
    g: "hyperpop",
    s: "hyper",
    m: "energetic",
    e: 0.9,
    d: 0.75,
    b: [145, 160],
    l: "hyperpop",
  },
  // ── melo-club & bass music wave ────────────────────────────────────────
  {
    n: "anyma|anyma~",
    // Melodic techno, cinematic Afterlife scale — the techno.melodic groove
    // at club tempo.
    g: "techno",
    s: "melodic",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [122, 126],
    l: "anyma",
  },
  {
    n: "tale of us|afterlife|tale of us~",
    g: "techno",
    s: "melodic",
    m: "dark",
    e: 0.72,
    d: 0.55,
    b: [124, 128],
    l: "tale of us",
  },
  {
    n: "artbat|artbat~",
    g: "techno",
    s: "melodic",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [124, 128],
    l: "artbat",
  },
  {
    n: "camelphat|camelphat~",
    // Melodic club house — a touch slower, same melodic bed.
    g: "techno",
    s: "melodic",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [122, 126],
    l: "camelphat",
  },
  {
    n: "seven lions|seven lions~",
    // Melodic dubstep — the emotional halftime, big supersaw drops.
    g: "trap",
    s: "dubstep",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [140, 150],
    l: "seven lions",
  },
  {
    n: "illenium|illenium~",
    g: "trap",
    s: "dubstep",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [140, 150],
    l: "illenium",
  },
  {
    n: "excision|excision~|headbanger",
    // The headbanger corner — heavier, faster dubstep.
    g: "trap",
    s: "dubstep",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [145, 155],
    l: "excision",
  },
  {
    n: "subtronics|subtronics~|riddim",
    g: "trap",
    s: "dubstep",
    m: "aggressive",
    e: 0.88,
    d: 0.68,
    b: [142, 152],
    l: "subtronics",
  },
  {
    n: "black coffee|black coffee~",
    // Afro house — the house.afro groove at its native tempo.
    g: "house",
    s: "afro",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [120, 124],
    l: "black coffee",
  },
  {
    n: "pinkpantheress|pink pantheress|pinkpantheress~",
    // 2-step/pop hybrids — ukg groove, bright and bouncy.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [132, 140],
    l: "pinkpantheress",
  },
  // ── hip-hop sub-genre sweep (all the variations) ───────────────────────
  {
    n: "asap rocky|a$ap rocky|asap mob|pretty flacko",
    // Cloud-adjacent fashion trap — the sparse groove with swagger.
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [130, 145],
    l: "a$ap rocky",
  },
  {
    n: "yung lean|drain gang|bladee|sadboys",
    // Cloud rap: dreamy, hazy, melancholic — the sparse groove underwater.
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.4,
    d: 0.4,
    b: [120, 135],
    x: ["lofi"],
    l: "yung lean / drain gang",
  },
  {
    n: "clams casino|cloud rap|instrumental cloud",
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.35,
    d: 0.4,
    b: [125, 140],
    l: "cloud rap",
  },
  {
    n: "dj screw|chopped and screwed|screwed|slowed|houston",
    // Houston: the groove itself is slowed — 66-78 BPM with heavy lean.
    g: "trap",
    s: "screwed",
    m: "chill",
    e: 0.3,
    d: 0.4,
    b: [66, 78],
    x: ["tape"],
    f: "straight",
    l: "dj screw / chopped and screwed",
  },
  {
    n: "plugg|pluggnb|plugg~",
    // Bell-forward springy producer genre — plugg groove, bright bells.
    g: "trap",
    s: "plugg",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [140, 160],
    l: "plugg",
  },
  {
    n: "babytron|baby tron|michigan",
    // Detroit/Michigan loop rap — offbeat bouncy, punchline cadence.
    g: "trap",
    s: "detroit",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [138, 148],
    f: "offbeat",
    l: "babytron",
  },
  {
    n: "veeze|detroit rap|detroit~",
    g: "trap",
    s: "detroit",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [130, 144],
    f: "offbeat",
    l: "veeze / detroit",
  },
  {
    n: "skepta|grime|grime~|bbk",
    // 140 eski — nearly straight, stabbing, aggressive.
    g: "drill",
    s: "grime",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [138, 144],
    f: "straight",
    l: "skepta / grime",
  },
  {
    n: "wiley|jme|eski beat|wiley~",
    g: "drill",
    s: "grime",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [138, 144],
    l: "wiley / jme",
  },
  {
    n: "e-40|e40|hyphy|bay area",
    // Bay Area bounce — the stubble-dance pocket.
    g: "trap",
    s: "hyphy",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [96, 106],
    l: "e-40 / hyphy",
  },
  {
    n: "mac dre|thizz|mac dre~",
    g: "trap",
    s: "hyphy",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [94, 104],
    l: "mac dre",
  },
  {
    n: "lil jon|crunk|crunk~|east side boyz",
    g: "trap",
    s: "crunk",
    m: "aggressive",
    e: 0.95,
    d: 0.65,
    b: [98, 108],
    f: "straight",
    l: "lil jon / crunk",
  },
  {
    n: "kendrick|kendrick lamar|gnx|not like us|kendrick~",
    // Modern West Coast conscious — the headnod pocket, GNX era energy.
    g: "trap",
    s: "headnod",
    m: "dark",
    e: 0.7,
    d: 0.6,
    b: [92, 110],
    l: "kendrick lamar",
  },
  {
    n: "j cole|j. cole|cole world|dreamville",
    // Conscious boom bap — the classic groove, laid-back pen.
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [84, 92],
    l: "j. cole",
  },
  {
    n: "nas|nas~|illmatic|ny hip hop|new york rap",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [88, 96],
    l: "nas / ny boom bap",
  },
  {
    n: "mf doom|mf doon|madvillain|doom~",
    // Dusty lo-fi boom bap — comic-book villain loop digger.
    g: "boombap",
    s: "golden",
    m: "chill",
    e: 0.45,
    d: 0.5,
    b: [86, 94],
    x: ["lofi"],
    l: "mf doom",
  },
  {
    n: "old school rap|80s rap|electro hip hop|old school~",
    // The TR-808 era — thin electro snare, straight hats, 98-110.
    g: "trap",
    s: "oldschool",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [98, 110],
    x: ["lofi"],
    l: "old school / electro",
  },
  // ── mainstream heavyweights wave ───────────────────────────────────────
  {
    n: "drake|drake~|ovo|6ix|champagne papi",
    // Toronto atmospheric trap/R&B hybrid — sparse groove with room for
    // the sung hook.
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [128, 142],
    l: "drake",
  },
  {
    n: "kodak black|kodak|kodak~",
    // Florida lazy melodic trap — laid-back drawl over sparse drums.
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [125, 140],
    f: "offbeat",
    l: "kodak black",
  },
  {
    n: "lil durk|durk|lil durk~|otf",
    // Chicago-adjacent melodic drill.
    g: "drill",
    s: "dark",
    m: "dark",
    e: 0.7,
    d: 0.6,
    b: [135, 145],
    l: "lil durk",
  },
  {
    n: "nba youngboy|youngboy|youngboy never break again|4ktrey",
    // Aggressive melodic trap — rolling and relentless.
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.7,
    b: [130, 150],
    l: "nba youngboy",
  },
  {
    n: "polo g|polo g~|capalot",
    // Melodic drill/trap — the Hall of Fame pocket.
    g: "drill",
    s: "dark",
    m: "dark",
    e: 0.7,
    d: 0.6,
    b: [135, 150],
    l: "polo g",
  },
  {
    n: "rod wave|rod wave~|nostalgia",
    // Emotional sung-trap — sparse, room for the vocal to carry.
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [128, 140],
    l: "rod wave",
  },
  {
    n: "juice wrld|juice wrld~|999",
    // Emo trap — rolling 140s with melodic pain.
    g: "trap",
    s: "rolling",
    m: "dark",
    e: 0.75,
    d: 0.6,
    b: [135, 155],
    f: "offbeat",
    l: "juice wrld",
  },
  {
    n: "xxxtentacion|xxx~|x~|members only",
    // The aggro/sad split — hyper groove carries the Members Only energy.
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [140, 160],
    l: "xxxtentacion",
  },
  {
    n: "tyler the creator|tyler creator|igor|flower boy|golf wang",
    // Neo-soul boom bap — the classic groove at Igor/Flower Boy tempo.
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [75, 105],
    l: "tyler, the creator",
  },
  {
    n: "mac miller|mac miller~|circles|kidd",
    // Jazz-tinged boom bap — laid-back pen over warm loops.
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.45,
    d: 0.5,
    b: [80, 100],
    l: "mac miller",
  },
  {
    n: "denzel curry|denzel|ultimate|ta13oo",
    // Aggressive Florida rap — hyper tempo, mosh energy.
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [140, 160],
    l: "denzel curry",
  },
  {
    n: "jpegmafia|peggy|devon hendryx|experimental rap",
    // Glitchy experimental trap — hyper groove, maximum density.
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.85,
    d: 0.75,
    b: [135, 160],
    l: "jpegmafia",
  },
  {
    n: "megan thee stallion|megan|hot girl|megan thee stallion~",
    // Houston heritage — rolling trap at Tina Snow tempo.
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [125, 140],
    l: "megan thee stallion",
  },
  {
    n: "lil peep|lil peep~|gbc|hellboy",
    // Emo guitar trap — sparse and hazy under the samples.
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.45,
    d: 0.45,
    b: [120, 150],
    x: ["lofi"],
    l: "lil peep",
  },
  {
    n: "a boogie|a boogie wit da hoodie|a boogie~",
    // NY melodic — sparse bed for the sung hook.
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [128, 140],
    l: "a boogie",
  },
  {
    n: "suicideboys|suicide boys|$uicideboy$|g59|grey 59",
    // NOLA horrorcore: dark sparse trap with memphis phonk DNA — the darkest
    // corner of our vocab on purpose
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [130, 150],
    l: "suicideboys",
  },
  {
    n: "macky gee|mackie gee",
    // Jump-up / dancefloor DNB — punchy rollers, festival energy
    g: "dnb",
    s: "jumpup",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 177],
    l: "macky gee",
  },
  {
    n: "disclosure|uk garage house",
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.65,
    b: [128, 135],
    l: "ukg",
  },
  {
    n: "fisher|tech house|techhouse",
    g: "house",
    s: "driving",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [124, 128],
    l: "tech house",
  },
  {
    n: "amapiano|afrobeat",
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 116],
    l: "amapiano",
  },
  {
    n: "swedish house mafia|big room|martin garrix",
    g: "house",
    s: "driving",
    m: "energetic",
    e: 0.95,
    d: 0.8,
    b: [126, 130],
    l: "big room",
  },
  // ── expanded roster (vocabulary wave) ────────────────────────────────────
  // trap / hip-hop
  {
    n: "future~|future beat",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 150],
    l: "future",
  },
  {
    n: "gunna|lil baby",
    g: "trap",
    s: "bouncy",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [130, 145],
    l: "gunna / lil baby",
  },
  {
    n: "ken carson|destroy lonely|opium",
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [150, 165],
    l: "opium rage",
  },
  {
    n: "pierre bourne|pi'erre bourne",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 150],
    l: "pi'erre bourne",
  },
  {
    n: "zaytoven",
    g: "trap",
    s: "classic",
    e: 0.65,
    d: 0.55,
    b: [130, 142],
    l: "zaytoven",
  },
  {
    n: "tay keith",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [130, 145],
    l: "tay keith",
  },
  {
    n: "chief keef",
    g: "drill",
    s: "dark",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [130, 142],
    l: "chief keef",
  },
  {
    n: "lex luger",
    g: "trap",
    s: "classic",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [138, 145],
    l: "lex luger",
  },
  // techno
  {
    n: "charlotte de witte|amelie lens",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [145, 152],
    l: "peak-time techno",
  },
  {
    n: "ben klock",
    g: "techno",
    s: "minimal",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [126, 134],
    l: "berlin techno",
  },
  {
    n: "sara landry|i hate models|trym",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [148, 155],
    l: "hard techno",
  },
  {
    n: "boris brejcha",
    g: "techno",
    s: "minimal",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [120, 126],
    l: "high-tech minimal",
  },
  {
    n: "trance|tiesto|armin van buuren|psytrance",
    // psytrance in this lane rides its own style below; the trance lane
    // itself now has a dedicated groove (offbeat open hat, 136-142).
    g: "trance",
    s: "uplifting",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [136, 142],
    l: "trance",
  },
  // house
  {
    n: "dom dolla|john summit",
    g: "house",
    s: "driving",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [124, 127],
    l: "tech house",
  },
  {
    n: "keinemusik|&me|rampa",
    // The modern organic wave (Muyè / Say What) — hand-drum hypnotia over
    // the soft floor, not the classic afro-house groove.
    g: "house",
    s: "organic",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [120, 124],
    l: "afro house",
  },
  {
    n: "overmono|joy orbison",
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 136],
    l: "ukg",
  },
  {
    n: "duskus|duskus~",
    // Duskus: future garage / melodic bass — atmospheric halftime, mellow
    // but driving. Ambient carries it; the style phrase refines the drums.
    g: "ambient",
    s: "future garage",
    m: "dark",
    e: 0.55,
    d: 0.45,
    b: [130, 140],
    l: "duskus (future garage)",
  },
  // ambient
  {
    n: "brian eno|eno~",
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.25,
    d: 0.35,
    b: [60, 80],
    l: "ambient pioneer",
  },
  {
    n: "aphex twin|aphex",
    g: "ambient",
    s: "glitch",
    e: 0.5,
    d: 0.5,
    b: [70, 110],
    l: "aphex twin",
  },
  {
    n: "boards of canada|tycho",
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.45,
    d: 0.45,
    b: [80, 100],
    l: "nostalgic ambient",
  },
  // phonk
  {
    n: "kordhell|drift phonk",
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [150, 165],
    l: "drift phonk",
  },
  {
    n: "dj smokey|memphis rap|ghostface playa",
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [128, 140],
    x: ["tape"],
    f: "straight",
    l: "memphis phonk",
  },
  // ── Phonk bounce: TikTok-era cowbell-forward phonk, busy hat work ───────
  // The post-2020 cowbell-led phonk template — artists built around aggressive
  // swung cowbell + rolling hats, bouncy energy 0.85-0.95, BPM 130-145.
  {
    n: "dvrst|phonk killer|anti x",
    // "anti x" is the humanised alias for the Dvrst / Phon-killer echo-cowbell lane
    g: "phonk",
    s: "bounce",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [130, 145],
    l: "phonk bounce",
  },
  // ── Phonk horror: dark cinematic reverb tail, sparse arrangement ─────────
  // NOLA horrorcore / dark Russian phonk — sparse memphis cowbell + low kick,
  // heavy reverb tail, low density, BPM 125-140.
  {
    // ghostemane + soudiere: dark cinematic phonk. "moon deity/moondeity" + "$uicideboy$"
    // already live in the world-roster (drift) and target-roster (memphis) entries, so we
    // keep this preset's names set disjoint to preserve the matcher priority order.
    n: "ghostemane|soudiere",
    g: "phonk",
    s: "horror",
    m: "dark",
    e: 0.55,
    d: 0.4,
    b: [125, 140],
    l: "phonk horror",
  },
  // ── Drift phonk (TikTok drift lane) — clean cowbell syncopation, more headroom ─
  // The 'drift' school — fast swung 808-style cowbell, melodic, BPM 145-160.
  {
    n: "phonk walkerson|rare akuma|rxseboy|lil darkie",
    // Rare Akuma + Rxseboy + Lil Darkie all sit in the post-Kordhell cowbell-dominant lane
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [145, 160],
    l: "drift phonk (tiktok)",
  },
  // ── Aggressive drift phonk — 808 cowbell + vocal chops, BPM 150-170 ─────
  // Heavier Drift-school artists pushing into Rage tempos.
  {
    n: "freddie dredd|ghostface playah|phonk walker",
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [150, 170],
    l: "aggressive drift",
  },
  // dnb
  {
    n: "sub focus|wilkinson",
    g: "dnb",
    s: "liquid",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "dancefloor dnb",
  },
  {
    n: "hedex|jump up|jumpup",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [174, 178],
    l: "jump up",
  },
  // jersey
  {
    n: "bandmanrill|cookiee kawaii",
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.8,
    d: 0.65,
    b: [134, 142],
    l: "jersey club",
  },
  // ── world-roster wave (BPM ranges researched: mixgraph.io, beatport.com,
  //    tunebat.com, r/DnB consensus, type-beat marketplace listings) ────────
  {
    n: "adam beyer|drumcode",
    g: "techno",
    s: "driving",
    e: 0.8,
    d: 0.65,
    b: [130, 138],
    l: "drumcode techno",
  },
  {
    n: "enrico sangiuliano",
    g: "techno",
    s: "driving",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [128, 136],
    l: "sangiuliano",
  },
  {
    n: "klangkuenstler|klangkuenstler~",
    g: "techno",
    s: "industrial",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [145, 155],
    l: "klang techno",
  },
  {
    n: "hi-lo|hi lo",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.85,
    d: 0.7,
    b: [136, 144],
    l: "hi-lo",
  },
  {
    n: "kobosil",
    g: "techno",
    s: "industrial",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [138, 146],
    l: "kobosil",
  },
  {
    n: "four tet|fourtet",
    g: "house",
    s: "organic",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [122, 128],
    l: "four tet",
  },
  {
    n: "bicep",
    g: "house",
    s: "deep",
    e: 0.6,
    d: 0.55,
    b: [122, 128],
    l: "bicep",
  },
  {
    n: "jamie xx",
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [120, 128],
    l: "jamie xx",
  },
  {
    n: "ben bohmer|ben böhmer",
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [118, 124],
    l: "ben bohmer",
  },
  {
    n: "young thug|young thug~",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [130, 142],
    l: "young thug",
  },
  {
    n: "don toliver|don toliver~",
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.55,
    d: 0.45,
    b: [118, 128],
    l: "don toliver",
  },
  {
    n: "lil uzi vert|uzi vert|lil uzi~",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [140, 152],
    l: "lil uzi",
  },
  {
    n: "trippie redd",
    g: "trap",
    s: "rolling",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [140, 150],
    l: "trippie redd",
  },
  {
    n: "moondeity|moon deity",
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.6,
    b: [150, 160],
    l: "moondeity",
  },
  {
    n: "dvrst",
    g: "phonk",
    s: "drift",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [140, 150],
    l: "dvrst",
  },
  {
    n: "chase & status|chase and status",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.85,
    d: 0.7,
    b: [172, 176],
    l: "chase & status",
  },
  {
    n: "bou",
    g: "dnb",
    s: "roller",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "bou",
  },
  {
    n: "1991|ninety one",
    g: "dnb",
    s: "jumpup",
    m: "energetic",
    e: 0.88,
    d: 0.68,
    b: [172, 178],
    l: "1991",
  },
  {
    n: "calibre",
    g: "dnb",
    s: "liquid",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [170, 174],
    l: "calibre",
  },

  // ── bedroom pop (DIY, intimate, 80-120 BPM) ───────────
  {
    n: "clairo|clairo~",
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.35,
    d: 0.4,
    b: [75, 110],
    l: "clairo",
  },
  {
    n: "rex orange county|rex orange",
    g: "house",
    s: "deep",
    m: "energetic",
    e: 0.55,
    d: 0.45,
    b: [100, 130],
    l: "rex orange county",
  },
  {
    n: "mac demarco|mac demarco~",
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.3,
    d: 0.35,
    b: [80, 100],
    l: "mac demarco",
  },
  {
    n: "beabadoobee|bea~",
    g: "ambient",
    s: "drifting",
    e: 0.4,
    d: 0.4,
    b: [70, 120],
    l: "beabadoobee",
  },
  // ── lo-fi house (tape saturation, hazy nostalgia) ─────
  {
    n: "dj seinfeld|dj seinfeld~",
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [110, 125],
    l: "dj seinfeld",
  },
  {
    n: "ross from friends|ross fm",
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [110, 125],
    l: "ross from friends",
  },
  {
    n: "mall grab",
    g: "house",
    s: "minimal",
    m: "chill",
    e: 0.45,
    d: 0.4,
    b: [110, 125],
    l: "mall grab",
  },
  // ── UK bass / breaks ──────────────────────────────────
  {
    n: "overmono|overmono~",
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 140],
    l: "overmono",
  },
  // ── future bass / dubstep ─────────────────────────────
  {
    n: "flume|flume~",
    g: "trap",
    s: "lux",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [130, 150],
    l: "flume",
  },
  {
    n: "skrillex|skrillex~",
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [138, 145],
    l: "skrillex",
  },
  // ── trip-hop ──────────────────────────────────────────
  {
    n: "portishead|portishead~",
    g: "ambient",
    s: "drifting",
    m: "dark",
    e: 0.25,
    d: 0.35,
    b: [70, 90],
    l: "portishead",
  },
  {
    n: "massive attack|massive attack~",
    g: "ambient",
    s: "drifting",
    m: "dark",
    e: 0.3,
    d: 0.4,
    b: [80, 100],
    l: "massive attack",
  },
  // ── post-punk / punk (motorik root of industrial techno) ──
  {
    n: "joy division|joy division~",
    g: "techno",
    s: "industrial",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [120, 135],
    l: "joy division",
  },
  {
    n: "interpol|interpol~",
    g: "techno",
    s: "industrial",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [120, 135],
    l: "interpol",
  },
  {
    n: "the cure|the cure~",
    g: "techno",
    s: "driving",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [125, 150],
    l: "the cure",
  },
  {
    n: "idles|idles~",
    g: "techno",
    s: "industrial",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [140, 160],
    l: "idles",
  },
  {
    n: "fontaines dc|fontaines dc~",
    g: "techno",
    s: "industrial",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [140, 155],
    l: "fontaines dc",
  },
  {
    n: "turnstile|turnstile~",
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [140, 170],
    l: "turnstile",
  },

  // ── drone / deep ambient (40-70 BPM or beatless — the slowest corner) ──
  {
    n: "stars of the lid|stars of the lid~",
    g: "drone",
    s: "drone",
    m: "chill",
    e: 0.15,
    d: 0.25,
    b: [40, 65],
    l: "stars of the lid",
  },
  {
    n: "tim hecker|tim hecker~",
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.2,
    d: 0.3,
    b: [45, 70],
    l: "tim hecker",
  },
  {
    n: "william basinski|basinski",
    g: "drone",
    s: "drone",
    m: "dark",
    e: 0.15,
    d: 0.25,
    b: [40, 60],
    l: "basinski",
  },
  {
    // This record title is a widely used ambient prompt, not an artist-name
    // request; keep its timbral lane while selecting the ambient genre.
    n: "disintegration loops",
    g: "ambient",
    s: "drifting",
    m: "dark",
    e: 0.15,
    d: 0.25,
    b: [40, 60],
    l: "basinski",
  },
  {
    n: "grouper|grouper~",
    g: "drone",
    s: "drone",
    m: "dark",
    e: 0.2,
    d: 0.25,
    b: [40, 65],
    l: "grouper",
  },
  {
    n: "thomas koner|thomas köner",
    g: "drone",
    s: "drone",
    m: "dark",
    e: 0.15,
    d: 0.2,
    b: [40, 60],
    l: "thomas koner",
  },
  // ── experimental / IDM / deconstructed club ───────────
  {
    n: "autechre|autechre~",
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.6,
    d: 0.65,
    b: [120, 160],
    l: "autechre",
  },
  {
    n: "arca|arca~",
    g: "hyperpop",
    s: "hyper",
    m: "dark",
    e: 0.8,
    d: 0.65,
    b: [100, 140],
    l: "arca",
  },
  {
    n: "sophie|sophie~|pc music",
    g: "hyperpop",
    s: "hyper",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [120, 140],
    x: ["metallic"],
    l: "sophie",
  },
  {
    n: "oneohtrix point never|opn|oneohtrix",
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.4,
    d: 0.5,
    b: [80, 130],
    l: "opn",
  },
  {
    n: "fennesz|fennesz~",
    g: "ambient",
    s: "glitch",
    m: "chill",
    e: 0.2,
    d: 0.3,
    b: [50, 80],
    l: "fennesz",
  },
  {
    n: "2814|vaporwave|vaporwave~",
    g: "ambient",
    s: "drifting",
    m: "dark",
    e: 0.3,
    d: 0.35,
    b: [60, 90],
    l: "vaporwave",
  },
  // ── Berlin School / krautrock (analog sequencer 80-120) ──
  {
    n: "tangerine dream|tangerine dream~|phaedra",
    g: "techno",
    s: "melodic",
    m: "chill",
    e: 0.45,
    d: 0.5,
    b: [80, 120],
    l: "tangerine dream",
  },
  {
    n: "klaus schulze|klaus schulze~",
    g: "techno",
    s: "minimal",
    m: "dark",
    e: 0.35,
    d: 0.4,
    b: [80, 110],
    l: "klaus schulze",
  },
  {
    n: "manuel gotttsching|manuel gottsching|ash ra tempel|e2-e4",
    g: "house",
    s: "minimal",
    m: "chill",
    e: 0.4,
    d: 0.4,
    b: [100, 120],
    l: "gotttsching e2-e4",
  },
  // ── pop wave (dance-pop base = house, pop-rap = trap; BPM researched:
  // Dua ~103-125, Weeknd synth-pop 90-171, Billie bedroom 70-100,
  // Charli hyperpop 130-160) ─────────────────────────────
  {
    n: "dua lipa|dua lipa~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [103, 125],
    l: "dua lipa",
  },
  {
    n: "the weeknd|weeknd|weeknd~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [90, 130],
    l: "the weeknd",
  },
  {
    n: "billie eilish|billie|billie eilish~",
    g: "ambient",
    s: "sadchill",
    m: "dark",
    e: 0.4,
    d: 0.35,
    b: [70, 100],
    l: "billie eilish",
  },
  {
    n: "ariana grande|ariana|ariana grande~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [100, 120],
    l: "ariana grande",
  },
  {
    n: "bruno mars|bruno mars~",
    g: "house",
    s: "funky",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [100, 115],
    l: "bruno mars",
  },
  {
    n: "olivia rodrigo|olivia|olivia rodrigo~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [100, 130],
    l: "olivia rodrigo",
  },
  {
    n: "charli xcx|charli|brat",
    g: "trap",
    s: "hyper",
    m: "energetic",
    e: 0.9,
    d: 0.7,
    b: [130, 160],
    l: "charli xcx",
  },
  {
    n: "taylor swift|taylor|taylor swift~",
    g: "house",
    s: "pop",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [90, 120],
    l: "taylor swift",
  },
  {
    n: "lorde|lorde~",
    g: "ambient",
    s: "sadchill",
    m: "dark",
    e: 0.45,
    d: 0.4,
    b: [70, 110],
    l: "lorde",
  },
  {
    n: "tate mcrae|tate|tate mcrae~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [100, 125],
    l: "tate mcrae",
  },
  {
    n: "lady gaga|gaga|lady gaga~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [110, 130],
    l: "lady gaga",
  },
  {
    n: "rihanna|rihanna~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [95, 120],
    l: "rihanna",
  },
  // ── pop wave 2 (BPM researched: mixgraph.io / tunebat / tempo-tunes /
  //    jog.fm — dance-pop 120-136, pop-rap 80-130, retro-pop 100-120) ─────
  // Dance-pop block — club/EDM-pop crossover pocket (~125-128 sweet spot)
  {
    n: "sia|sia~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [120, 133],
    l: "sia",
  },
  {
    n: "katy perry|katy perry~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [100, 128],
    l: "katy perry",
  },
  {
    n: "ava max|ava max~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [125, 135],
    l: "ava max",
  },
  {
    n: "zedd|zedd~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [105, 128],
    l: "zedd",
  },
  {
    n: "calvin harris|calvin harris~",
    g: "house",
    s: "dancefloor",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [99, 128],
    l: "calvin harris",
  },
  {
    n: "kesha|ke$ha",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [120, 140],
    l: "kesha",
  },
  // Pop-rap block — laid-back half-time pocket (80-110, double-time feel)
  {
    n: "post malone|post malone~",
    g: "trap",
    s: "pop",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [80, 95],
    l: "post malone",
  },
  {
    n: "doja cat|doja cat~",
    g: "trap",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [105, 130],
    l: "doja cat",
  },
  {
    n: "the kid laroi|kid laroi|kid laroi~",
    g: "trap",
    s: "pop",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [85, 140],
    l: "the kid laroi",
  },
  {
    n: "justin bieber|bieber|justin bieber~",
    g: "house",
    s: "pop",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [90, 130],
    l: "justin bieber",
  },
  // Retro/funk-pop revival — the 100-120 disco-pop sweet spot
  {
    n: "miley cyrus|miley|miley cyrus~",
    g: "house",
    s: "funky",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [105, 120],
    l: "miley cyrus",
  },
  // ── disco pop wave (nu-disco / disco-pop on house.disco; BPM researched:
  // Kylie 115-128 (Padam 128, Can't Get You 123), Bee Gees 100-110
  // (Stayin' Alive 104, Night Fever 109), Chic 115-125 (Le Freak 122,
  // Good Times 120), Jessie Ware 108-124 (Free Yourself ~122, Pearls 118)) ──
  {
    n: "kylie minogue|kylie|kylie minogue~|padam",
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [115, 128],
    l: "kylie minogue",
  },
  {
    n: "bee gees|beegees|bee gees~",
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [100, 110],
    l: "bee gees",
  },
  {
    n: "chic|nile rodgers|chic~",
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [115, 125],
    l: "chic",
  },
  {
    n: "jessie ware|jessie ware~",
    g: "house",
    s: "disco",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [108, 124],
    l: "jessie ware",
  },
  // ── country pop wave (house.countrypop train beat; BPM researched:
  // Shania 96-122 (Man! I Feel 108, I'm Gonna Getcha Good ~120),
  // Kacey 88-118 (High Horse 118, Golden Hour ballads ~90),
  // The Chicks 100-130 (Cowboy Take Me Away, Sin Wagon pushes 130),
  // Carrie Underwood 92-120 (Before He Cheats 92, Blown Away ~120)) ──
  {
    n: "shania twain|shania|shania twain~",
    g: "house",
    s: "countrypop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [96, 122],
    l: "shania twain",
  },
  {
    n: "kacey musgraves|kacey|kacey musgraves~",
    g: "house",
    s: "countrypop",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [88, 118],
    l: "kacey musgraves",
  },
  {
    n: "the chicks|dixie chicks|the chicks~",
    g: "house",
    s: "countrypop",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [100, 130],
    l: "the chicks",
  },
  {
    n: "carrie underwood|carrie underwood~",
    g: "house",
    s: "countrypop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [92, 120],
    l: "carrie underwood",
  },
  // ── latin pop wave (house.dembow chop; Bad Bunny / J Balvin / Rosalía
  // lanes already exist above; BPM researched: Shakira 92-105 (Hips Don't
  // Lie 99, Whenever 93), Karol G 88-102 (Provenza/TQG pocket ~95),
  // Luis Fonsi 92-100 (Despacito 96), Rauw Alejandro 90-102 (Todo de Ti
  // is the disco-latin edge ~104)) ──
  {
    n: "shakira|shakira~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [92, 105],
    l: "shakira",
  },
  {
    n: "karol g|karol g~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [88, 102],
    l: "karol g",
  },
  {
    n: "luis fonsi|fonsi|despacito|luis fonsi~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [92, 100],
    l: "luis fonsi",
  },
  {
    n: "rauw alejandro|rauw|rauw alejandro~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [90, 104],
    l: "rauw alejandro",
  },
  // ── electronic depth wave — progressive house / trance / electro /
  // moombahton / slap house / deep dubstep (BPM researched: Prydz 124-128
  // (Opus 126, bae 125), deadmau5 122-130 (Strobe 128 area), Sasha &
  // Digweed 124-130; Above & Beyond 132-138 (Sun & Moon 132), van Dyk
  // 134-142 (For an Angel 138); Egyptian Lover 120-132 (Egypt, Egypt ~127);
  // Dillon Francis/Major Lazer moombahton 100-112; Alok/Imanbek/Meduza
  // slap 118-126 (In My Mind 120); Skream/Benga/Mystikz 138-142) ──
  {
    n: "eric prydz|prydz|eric prydz~",
    g: "house",
    s: "progressive",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [124, 128],
    l: "eric prydz",
  },
  {
    n: "deadmau5|deadmau5~",
    g: "house",
    s: "progressive",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [122, 130],
    l: "deadmau5",
  },
  {
    n: "sasha|john digweed|sasha and john digweed",
    g: "house",
    s: "progressive",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [124, 130],
    l: "sasha and digweed",
  },
  {
    n: "above and beyond|above & beyond|anjunabeats|anjunadeep",
    g: "trance",
    s: "progressive",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [132, 138],
    l: "above and beyond",
  },
  {
    n: "paul van dyk|pvd|paul van dyk~",
    g: "trance",
    s: "uplifting",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [134, 142],
    l: "paul van dyk",
  },
  {
    n: "egyptian lover|egypt egypt",
    g: "detroit",
    s: "electro",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [120, 132],
    l: "egyptian lover",
  },
  {
    n: "dillon francis|dillon francis~",
    g: "house",
    s: "moombahton",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [105, 112],
    l: "dillon francis",
  },
  {
    n: "major lazer|diplo|major lazer~",
    g: "house",
    s: "moombahton",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [100, 112],
    l: "major lazer",
  },
  {
    n: "alok|alok~",
    g: "house",
    s: "slaphouse",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [118, 126],
    l: "alok",
  },
  {
    n: "imanbek|imanbek~",
    g: "house",
    s: "slaphouse",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [118, 124],
    l: "imanbek",
  },
  {
    n: "meduza|meduza~",
    g: "house",
    s: "slaphouse",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [120, 126],
    l: "meduza",
  },
  {
    n: "skream|skream~",
    g: "trap",
    s: "deepdubstep",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [138, 142],
    l: "skream",
  },
  {
    n: "benga|benga~",
    g: "trap",
    s: "deepdubstep",
    m: "dark",
    e: 0.65,
    d: 0.5,
    b: [138, 142],
    l: "benga",
  },
  {
    n: "digital mystikz|mala dmz|digital mystikz~",
    g: "trap",
    s: "deepdubstep",
    m: "dark",
    e: 0.55,
    d: 0.4,
    b: [140, 142],
    l: "digital mystikz",
  },
  // ── gqom + dembow 2.0 wave (researched: DJ Lag / Distruction Boyz — the
  // Durban broken-kick mutation; El Alfa / Rochy RD — dembow dominicano,
  // rawer 16th-filled chop; Tomasa del Real (coined "neoperreo") / Ms Nina —
  // the DIY deconstructed reggaeton lane) ──
  {
    n: "dj lag|dj lag~",
    g: "house",
    s: "gqom",
    m: "dark",
    e: 0.75,
    d: 0.5,
    b: [115, 128],
    l: "dj lag",
  },
  {
    n: "distruction boyz|distruction boyz~",
    g: "house",
    s: "gqom",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [118, 128],
    l: "distruction boyz",
  },
  {
    n: "el alfa|el jefe|el alfa~",
    g: "house",
    s: "dembowdom",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [100, 112],
    l: "el alfa",
  },
  {
    n: "rochy rd|rochy rd~",
    g: "house",
    s: "dembowdom",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [95, 110],
    l: "rochy rd",
  },
  {
    n: "tomasa del real|tomasa|tomasa del real~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [88, 100],
    l: "tomasa del real",
  },
  {
    n: "ms nina|ms. nina|ms nina~",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [90, 102],
    l: "ms nina",
  },
  // ── amapiano + organic house wave (researched: MDU aka Mas — "king of the
  // log drum", MFR Souls, Daliwonga on the amapiano groove; Adam Port
  // (Keinemusik solo) and HUGEL on the modern organic wave, 118-126) ──
  {
    n: "mdu aka mas|mdu|king of the log drum",
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [110, 116],
    l: "mdu aka mas",
  },
  {
    n: "mfr souls|mfr souls~",
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 115],
    l: "mfr souls",
  },
  {
    n: "daliwonga|daliwonga~",
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 116],
    l: "daliwonga",
  },
  {
    n: "adam port|adam port~",
    g: "house",
    s: "organic",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [120, 124],
    l: "adam port",
  },
  {
    n: "hugel|hugel~",
    g: "house",
    s: "organic",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [120, 126],
    l: "hugel",
  },
  // ── ghettotech + alté wave (researched: DJ Godfather — ghettotech pioneer,
  // DJ Assault, DJ Funk — the Dance Mania ghetto house bridge; Odunsi (The
  // Engine), Lady Donli, Santi — the Lagos alté alternative lane) ──
  {
    n: "dj godfather|dj godfather~",
    g: "detroit",
    s: "ghettotech",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "dj godfather",
  },
  {
    n: "dj assault|dj assault~",
    g: "detroit",
    s: "ghettotech",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "dj assault",
  },
  {
    n: "dj funk|dj funk~",
    g: "house",
    s: "ghettotech",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [128, 140],
    l: "dj funk",
  },
  {
    n: "odunsi|odunsi the engine|odunsi~",
    g: "house",
    s: "afropop",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [90, 105],
    l: "odunsi",
  },
  {
    n: "lady donli|lady donli~",
    g: "house",
    s: "afropop",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [90, 108],
    l: "lady donli",
  },
  {
    n: "santi|santi~",
    g: "house",
    s: "afropop",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [92, 108],
    l: "santi",
  },
  // ── kuduro + tropical wave (researched: Buraka Som Sistema — the Lisbon
  // crew that globalized kuduro; Kygo — tropical house's biggest crossover,
  // Klingande — sax-flavored tropical, Matoma) ──
  {
    n: "buraka som sistema|buraka|buraka som sistema~",
    g: "house",
    s: "kuduro",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "buraka som sistema",
  },
  {
    n: "kygo|kygo~",
    g: "house",
    s: "tropical",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [100, 110],
    l: "kygo",
  },
  {
    n: "klingande|klingande~",
    g: "house",
    s: "tropical",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [100, 112],
    l: "klingande",
  },
  {
    n: "matoma|matoma~",
    g: "house",
    s: "tropical",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [100, 110],
    l: "matoma",
  },
  // ── rock wave (grunge: Nirvana ~95-125 (Smells 117, Lithium 108), Pearl
  // Jam ~95-125; alt rock: Radiohead 75-125 (Creep 92), Weezer 95-130
  // (Buddy Holly 120); rapcore/nu metal 90-115 groove (RATM Killing in the
  // Name 92, Linkin Park One Step Closer 104); synth punk 140-168 machine
  // punk (The Units pioneers, The Faint the dance-punk bridge)) ──
  {
    n: "nirvana|nirvana~",
    g: "house",
    s: "grunge",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [95, 125],
    l: "nirvana",
  },
  {
    n: "pearl jam|pearl jam~",
    g: "house",
    s: "grunge",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [95, 125],
    l: "pearl jam",
  },
  {
    n: "radiohead|radiohead~",
    g: "house",
    s: "altrock",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [75, 125],
    l: "radiohead",
  },
  {
    n: "weezer|weezer~",
    g: "house",
    s: "altrock",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [95, 130],
    l: "weezer",
  },
  {
    n: "rage against the machine|ratm|rage against the machine~",
    g: "house",
    s: "rapcore",
    m: "aggressive",
    e: 0.9,
    d: 0.6,
    b: [90, 110],
    l: "rage against the machine",
  },
  {
    n: "linkin park|linkin park~",
    g: "house",
    s: "rapcore",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [95, 115],
    l: "linkin park",
  },
  {
    n: "the units|units synth punk|the units~",
    g: "house",
    s: "synthpunk",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [140, 168],
    l: "the units",
  },
  // ── gabber / hardcore family (techno.gabber 160-180 stomp; researched:
  // Angerfist mainscreen 160-180, Miss K8 uptempo 170-190, Sefa uptempo
  // piano 175-200, Partyraiser raw 160-180, Dr. Peacock frenchcore 150-170) ──
  {
    n: "angerfist|angerfist~",
    g: "techno",
    s: "gabber",
    m: "aggressive",
    e: 0.95,
    d: 0.65,
    b: [160, 180],
    l: "angerfist",
  },
  {
    n: "miss k8|miss k8~",
    g: "techno",
    s: "gabber",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [170, 190],
    l: "miss k8",
  },
  {
    n: "sefa|sefa~",
    g: "techno",
    s: "gabber",
    m: "aggressive",
    e: 0.95,
    d: 0.65,
    b: [175, 200],
    l: "sefa",
  },
  {
    n: "partyraiser|partyraiser~",
    g: "techno",
    s: "gabber",
    m: "aggressive",
    e: 0.95,
    d: 0.65,
    b: [160, 180],
    l: "partyraiser",
  },
  {
    n: "dr peacock|dr. peacock|dr peacock~",
    g: "techno",
    s: "gabber",
    m: "aggressive",
    e: 0.9,
    d: 0.6,
    b: [150, 170],
    l: "dr peacock",
  },
  {
    n: "the faint|the faint~",
    g: "house",
    s: "synthpunk",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [115, 130],
    l: "the faint",
  },
  // ── metal + hardcore + indie depth wave (researched: Metallica/Slayer
  // thrash 140-180 (Master of Puppets ~120-210 spans, Whiplash 175), Black
  // Sabbath doom 50-80, Bring Me the Horizon metalcore ~140-170, Black Flag
  // / Minor Threat hardcore 150-190, Green Day / blink-182 pop punk 148-175,
  // The Strokes / Arctic Monkeys indie 100-130) ──
  {
    n: "metallica|metallica~",
    g: "house",
    s: "thrash",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [110, 175],
    l: "metallica",
  },
  {
    n: "slayer|slayer~",
    g: "house",
    s: "thrash",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [140, 180],
    l: "slayer",
  },
  {
    n: "black sabbath|sabbath|black sabbath~",
    g: "house",
    s: "doom",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [55, 100],
    l: "black sabbath",
  },
  {
    n: "bring me the horizon|bmth|bring me the horizon~",
    g: "house",
    s: "metalcore",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [140, 170],
    l: "bring me the horizon",
  },
  {
    n: "black flag|black flag~",
    g: "house",
    s: "hardcorepunk",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [150, 190],
    l: "black flag",
  },
  {
    n: "minor threat|minor threat~",
    g: "house",
    s: "hardcorepunk",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [155, 190],
    l: "minor threat",
  },
  {
    n: "green day|green day~",
    g: "house",
    s: "poppunk",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [150, 175],
    l: "green day",
  },
  {
    n: "blink 182|blink-182|blink182|blink 182~",
    g: "house",
    s: "poppunk",
    m: "energetic",
    e: 0.8,
    d: 0.55,
    b: [148, 174],
    l: "blink-182",
  },
  {
    n: "the strokes|strokes|the strokes~",
    g: "house",
    s: "indie",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [105, 130],
    l: "the strokes",
  },
  {
    n: "arctic monkeys|arctic monkeys~",
    g: "house",
    s: "indie",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [100, 140],
    l: "arctic monkeys",
  },
  {
    n: "sabrina carpenter|sabrina|sabrina carpenter~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.65,
    d: 0.5,
    b: [100, 112],
    l: "sabrina carpenter",
  },
  {
    n: "chappell roan|chappell",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [105, 120],
    l: "chappell roan",
  },
  {
    n: "harry styles|harry styles~",
    g: "house",
    s: "pop",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [85, 130],
    l: "harry styles",
  },
  {
    n: "troye sivan|troye sivan~",
    g: "house",
    s: "pop",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [110, 130],
    l: "troye sivan",
  },
  {
    n: "halsey|halsey~",
    g: "house",
    s: "pop",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [90, 136],
    l: "halsey",
  },
  // Ballad pop — slow, voice-first
  {
    n: "adele|adele~",
    g: "ambient",
    s: "pop",
    m: "dark",
    e: 0.3,
    d: 0.3,
    b: [70, 100],
    l: "adele",
  },
  {
    n: "sam smith|sam smith~",
    g: "ambient",
    s: "pop",
    m: "chill",
    e: 0.35,
    d: 0.35,
    b: [85, 110],
    l: "sam smith",
  },
  // ── drum & bass wave (researched pockets: dancefloor/jump-up 172–178,
  // liquid rollers 170–176, neuro 172–178, jungle/ragga 160–170) ─────────────
  // Styles map ONLY to existing dnb.* grooves (twostep/liquid/jumpup/roller/
  // amen/dancefloor/neuro). Bare common-word names are qualified ("break
  // dnb", never bare "break") so arrangement talk never hijacks.
  // Liquid rollers — silky subs, summer festival energy
  {
    n: "netsky|netsky~",
    g: "dnb",
    s: "liquid",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "netsky",
  },
  {
    n: "hybrid minds",
    g: "dnb",
    s: "liquid",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [172, 176],
    l: "hybrid minds",
  },
  {
    n: "high contrast",
    g: "dnb",
    s: "liquid",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [172, 176],
    l: "high contrast",
  },
  {
    n: "ltj bukem|ltj bukem~|bukem",
    g: "dnb",
    s: "liquid",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [168, 172],
    l: "ltj bukem",
  },
  {
    n: "dj marky|marky|innerground",
    g: "dnb",
    s: "sambass",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "dj marky",
  },
  // Jump-up — wobble bass party starters
  {
    n: "turno|turno~",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "turno",
  },
  {
    n: "kanine|kanine~",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "kanine",
  },
  {
    n: "upgrade~|dj upgrade",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "upgrade",
  },
  {
    n: "a.m.c|amc~",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "a.m.c",
  },
  {
    // bare "serum" would hijack wavetable-synth talk — qualified only
    n: "serum~|serum dnb",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [172, 178],
    l: "serum (dnb)",
  },
  // Dancefloor — mainstage rollers and anthems
  {
    n: "andy c|andy c~",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.9,
    d: 0.7,
    b: [172, 176],
    l: "andy c",
  },
  {
    n: "dimension|dimension~",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "dimension",
  },
  {
    n: "culture shock",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "culture shock",
  },
  {
    n: "metrik|metrik~",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "metrik",
  },
  {
    n: "grafix|grafix~",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "grafix",
  },
  // Neurofunk / techstep — reese tearout pressure
  {
    n: "noisia|noisia~",
    g: "dnb",
    s: "neuro",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [172, 178],
    l: "noisia",
  },
  {
    n: "black sun empire",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "black sun empire",
  },
  {
    n: "phace|phace~",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "phace",
  },
  {
    n: "misanthrop|misanthrop~",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.9,
    d: 0.7,
    b: [172, 178],
    l: "misanthrop",
  },
  {
    n: "ed rush|optical|ed rush & optical|ed rush and optical",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.85,
    d: 0.7,
    b: [172, 178],
    l: "ed rush & optical",
  },
  {
    n: "dom and roland|dom & roland",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "dom & roland",
  },
  // Deep / minimal rollers — stripped steppers
  {
    // bare "break" would hijack arrangement talk — qualified only
    n: "break dnb|break~",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [172, 176],
    l: "break (dnb)",
  },
  {
    n: "skeptical|skeptical~",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [172, 176],
    l: "skeptical",
  },
  {
    n: "alix perez|alix perez~",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "alix perez",
  },
  {
    // Total Science — the roller/two-step legends (Breakin Point, CIA label)
    n: "total science|total science~",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [172, 176],
    l: "total science",
  },
  {
    n: "dillinja|dillinja~",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.85,
    d: 0.65,
    b: [170, 176],
    l: "dillinja",
  },
  // Jungle / ragga — chopped amens, dancehall pressure (slower pocket)
  {
    n: "congo natty|congo natty~|rebel mc",
    g: "dnb",
    s: "amen",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [160, 168],
    l: "congo natty",
  },
  // Jungle-specific lane (chopped-breaks groove) beside the amen lanes above.
  {
    n: "remarc|remarc~",
    g: "dnb",
    s: "jungle",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [155, 165],
    l: "remarc",
  },
  {
    n: "dj hype",
    g: "dnb",
    s: "jungle",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 178],
    l: "dj hype",
  },
  {
    n: "sub zero|frontline",
    g: "dnb",
    s: "jumpup",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 178],
    l: "dj hype",
  },
  // UK funky lane (soca-bounce groove).
  {
    n: "roska|roska~",
    g: "house",
    s: "ukfunky",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [125, 130],
    l: "roska",
  },
  {
    n: "lil silva|lil silva~",
    g: "house",
    s: "ukfunky",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [124, 130],
    l: "lil silva",
  },
  {
    n: "shy fx|shy fx~",
    g: "dnb",
    s: "amen",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [162, 170],
    l: "shy fx",
  },
  {
    n: "general levy",
    g: "dnb",
    s: "amen",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [160, 168],
    l: "general levy",
  },
  // Two-step stepper — roni size's represent-era swing
  {
    n: "roni size|roni size~|reprazent",
    g: "dnb",
    s: "twostep",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [168, 174],
    l: "roni size",
  },
  // ── DnB depth wave (2026-09-27): the roster the first sweep missed ──────
  // Each maps to a NEWLY-NATIVE sub-genre groove (techstep / ragga / sambass /
  // halftime / crossbreed / minimal) or an existing lane. BPMs are the
  // sub-genre's researched pocket, not a genre-wide constant.
  {
    n: "goldie|metalheadz|timeless~",
    g: "dnb",
    s: "techstep",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [170, 176],
    l: "goldie",
  },
  {
    n: "photek|source direct|modus operandi",
    g: "dnb",
    s: "techstep",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [168, 174],
    l: "photek",
  },
  {
    n: "doc scott|renegade hardware|nasty habits|no u-turn~",
    g: "dnb",
    s: "techstep",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [170, 176],
    l: "doc scott",
  },
  {
    n: "ray keith|dread recordings|terrorist~",
    g: "dnb",
    s: "ragga",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [162, 172],
    l: "ray keith",
  },
  {
    n: "serial killaz|ariba|jungle cakes",
    g: "dnb",
    s: "ragga",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [160, 170],
    l: "serial killaz",
  },
  {
    n: "ganja kru|ganja records|ragga dnb",
    g: "dnb",
    s: "ragga",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [162, 172],
    l: "ganja kru",
  },
  {
    n: "ivy lab|halftime dnb|20/20~",
    g: "dnb",
    s: "halftime",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [168, 174],
    l: "ivy lab",
  },
  {
    // Bare "sp" is two letters — qualified aliases only.
    n: "s.p.y|sp y dnb|hospital dnb|darkmatter",
    g: "dnb",
    s: "minimal",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [170, 174],
    l: "s.p.y",
  },
  {
    n: "dbridge|exit records|instramental|instra:mental|autonomic",
    g: "dnb",
    s: "minimal",
    m: "dark",
    e: 0.5,
    d: 0.4,
    b: [168, 174],
    l: "dbridge / autonomic",
  },
  {
    // Bare "break" would hijack arrangement talk — qualified only.
    n: "breakage|symmetry recordings",
    g: "dnb",
    s: "minimal",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [170, 176],
    l: "breakage",
  },
  {
    n: "the outside agency|outside agency|crossbreed~",
    g: "dnb",
    s: "crossbreed",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [175, 185],
    l: "the outside agency",
  },
  {
    // Bare "marky" already lives in the world roster (liquid); the sambass
    // aliases route here so "sambass" reaches the Brazilian groove.
    n: "sambass|samba dnb|samba bass|sambass~",
    g: "dnb",
    s: "sambass",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "sambass",
  },
  {
    n: "makoto|hospital records|nu:tone|logistics",
    g: "dnb",
    s: "sambass",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [172, 176],
    l: "makoto / hospital",
  },
  {
    n: "etherwood|dawn wall|alcemist|medschool",
    g: "dnb",
    s: "liquid",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [172, 176],
    l: "med school liquid",
  },
  {
    n: "spectrasoul|ulterior motive|shogun audio|waeys",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "spectrasoul",
  },
  {
    n: "jubei|spinline|survival|metalheadz roller",
    g: "dnb",
    s: "roller",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [172, 176],
    l: "jubei",
  },
  {
    n: "mozey|voltage|king of the rollers",
    g: "dnb",
    s: "jumpup",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 178],
    l: "mozey",
  },
  {
    n: "aries|friction|shogun type dnb|elevate records",
    g: "dnb",
    s: "jumpup",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [174, 178],
    l: "aries / friction",
  },
  {
    n: "dj fresh|bad company|bc uk|bad company uk",
    g: "dnb",
    s: "neuro",
    m: "dark",
    e: 0.85,
    d: 0.65,
    b: [172, 178],
    l: "dj fresh / bad company",
  },
  {
    n: "eprom|tsuruda|halftime bass|left field dnb",
    g: "dnb",
    s: "halftime",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [166, 174],
    l: "eprom / tsuruda",
  },
  {
    n: "koven|monstercat dnb|vocal drum and bass",
    g: "dnb",
    s: "dancefloor",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [172, 176],
    l: "koven",
  },
  {
    n: "submorphics|l-side|macca|soulful dnb",
    g: "dnb",
    s: "liquid",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [172, 176],
    l: "submorphics",
  },
  // ── 90s NY legends (classic 88–96 pocket, dark) ─────────────────────────
  // Boom-bap BPMs are researched (Illmatic / Ready to Die / Enter the 36 /
  // Reasonable Doubt / The Infamous era); the classic groove carries them —
  // planGeneration clamps the prior to the requested window.
  {
    n: "2pac|tupac|makaveli|2pac~",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.6,
    d: 0.55,
    b: [88, 95],
    l: "2pac",
  },
  {
    n: "biggie|notorious big|biggie smalls|big poppa",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.6,
    d: 0.55,
    b: [87, 94],
    l: "biggie",
  },
  {
    // Raekwon rides in the same entry (Cuban Linx pocket = the clan pocket).
    n: "wu-tang|wu tang|rza|raekwon|ghostface killah|method man|gza|ol dirty",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [88, 96],
    l: "wu-tang",
  },
  {
    n: "jay-z|jay z|jigga|hov|reasonable doubt",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [86, 95],
    l: "jay-z",
  },
  {
    n: "mobb deep|havoc~|shook ones|the infamous",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [90, 95],
    l: "mobb deep",
  },
  // ── Dirty South founders ───────────────────────────────────────────────
  {
    n: "outkast|andre 3000|andre three thousand|big boi|atliens|stankonia",
    g: "boombap",
    s: "golden",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [90, 102],
    l: "outkast",
  },
  {
    n: "ugk|bun b|pimp c|ridin dirty",
    g: "boombap",
    s: "golden",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [82, 94],
    l: "ugk",
  },
  {
    n: "geto boys|scarface~|willie d|bushwick bill",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [84, 94],
    l: "scarface / geto boys",
  },
  {
    // Dots never survive parser normalization ("t.i." → "t i"), so the
    // canonical alias is written post-normalization; "tip" alone is SK for
    // "type" and must never become an artist match.
    n: "t i|grand hustle|ti~|trap muzik",
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [96, 108],
    l: "t.i.",
  },
  {
    n: "jeezy|young jeezy|jeezy~|thug motivation",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [130, 142],
    l: "jeezy",
  },
  {
    n: "gucci mane|gucci~|guwop|la flare",
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [130, 142],
    l: "gucci mane",
  },
  {
    // Cash Money bounce — remaps to trap.bounce once the bounce groove lands.
    n: "mannie fresh|cash money|big tymers",
    g: "trap",
    s: "bounce",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [95, 108],
    l: "mannie fresh",
  },
  // ── 2000s mainstream ───────────────────────────────────────────────────
  {
    n: "eminem|slim shady|marshall mathers|eminem~|8 mile",
    g: "boombap",
    s: "golden",
    m: "aggressive",
    e: 0.7,
    d: 0.55,
    b: [85, 95],
    l: "eminem",
  },
  {
    n: "50 cent|fifty cent|g-unit|get rich|50 cent~",
    g: "boombap",
    s: "golden",
    m: "aggressive",
    e: 0.7,
    d: 0.55,
    b: [86, 96],
    l: "50 cent",
  },
  {
    n: "lil wayne|weezy|lil tunechi|carter~",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [130, 145],
    l: "lil wayne",
  },
  {
    n: "rick ross|rozay|maybach|rick ross~",
    g: "trap",
    s: "rolling",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [130, 140],
    l: "rick ross",
  },
  {
    n: "dmx|dark man x|ruff ryders|dmx~",
    g: "boombap",
    s: "golden",
    m: "aggressive",
    e: 0.75,
    d: 0.55,
    b: [86, 96],
    l: "dmx",
  },
  {
    n: "busta rhymes|busta~|flipmode",
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [95, 110],
    l: "busta rhymes",
  },
  {
    n: "missy elliott|missy~|timbaland|neptunes|pharrell~|supa dupa",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [95, 110],
    l: "missy / timbaland",
  },
  // ── Bay / LA g-era ─────────────────────────────────────────────────────
  {
    // "$hort" can never match (\b fails before "$"); the plain spelling
    // carries the preset.
    n: "too short|short dog|too short~",
    g: "trap",
    s: "gfunk",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [92, 100],
    l: "too $hort",
  },
  {
    n: "dj quik|quik~",
    g: "trap",
    s: "gfunk",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [92, 100],
    l: "dj quik",
  },
  {
    n: "kurupt|dogg pound|daz dillinger|kurupt~",
    g: "trap",
    s: "headnod",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [92, 98],
    l: "kurupt",
  },
  {
    // Mustard ratchet — minimal loop-rap bounce, the detroit offbeat vehicle.
    n: "yg~|yg|dj mustard|mustard~|400~",
    g: "trap",
    s: "detroit",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [95, 110],
    l: "yg / mustard",
  },
  {
    n: "nipsey hussle|nipsey|nip hussle|victory lap|crenshaw",
    g: "trap",
    s: "headnod",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [90, 100],
    l: "nipsey hussle",
  },
  {
    // Offbeat specialita — the detroit loop-rap bounce carries the flow.
    n: "blueface|blue face|bleedem|blueface~",
    g: "trap",
    s: "detroit",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [135, 148],
    l: "blueface",
  },
  // ── Three 6 Mafia (memphis phonk — the groove exists) ──────────────────
  {
    n: "three 6 mafia|three six mafia|dj paul|juicy j|project pat|gangsta boo|triple six|hypnotize minds",
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.65,
    d: 0.5,
    b: [130, 142],
    l: "three 6 mafia",
  },
  // ── Griselda dust (boom-bap renesancia — lacné: groove existuje) ────────
  {
    n: "westside gunn|conway the machine|benny the butcher|roc marciano|alchemist~|daringer|griselda|gxfr",
    g: "boombap",
    s: "modern",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [84, 94],
    l: "griselda",
  },
  {
    n: "navy blue|earl sweatshirt|earl~|mike~|ka~",
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.45,
    d: 0.5,
    b: [80, 92],
    l: "underground poet",
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
    n: "uniiqu3|microdosing",
    // Queen of Jersey Club (Splice cover story, Fendaci soundtrack);
    // catalog sits 135–140, median ~136.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [134, 140],
    l: "uniiqu3",
  },
  {
    n: "dj tameil|tameil|brick bandits",
    // The origin point (Brick Bandits crew) — origin-era tempo, same bounce.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [128, 136],
    l: "dj tameil",
  },
  {
    n: "dj sliink|sliink",
    // The exporter wave (2010s festivals + international circuits).
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 140],
    l: "dj sliink",
  },
  {
    n: "2rare|2 rare",
    // Philly viral bounce (Q-Pid / Big Drippa lane), hard 140 landing.
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [134, 142],
    l: "2rare",
  },
  {
    n: "cash cobain|chow lee|lonny love|sexy drill|slizzy|2 slizzy",
    // Sexy drill: drill bounce + smooth R&B samples, less-is-more drums
    // (2 Slizzy 2 Sexy, Fisherrr) — drill family, bounce groove, party mood.
    g: "drill",
    s: "bounce",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [138, 145],
    l: "cash cobain",
  },
  // NY drill — harder distorted 808s, punchier kick (~142).
  {
    n: "fivio foreign|fivio|big drip",
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [140, 145],
    l: "fivio foreign",
  },
  {
    n: "sheff g|sleepy hallow|no suburban",
    // The Brooklyn wave (No Suburban) — same 140 pocket, anthem bounce.
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.8,
    d: 0.55,
    b: [138, 143],
    l: "sheff g / sleepy hallow",
  },
  // UK drill — sliding 808s, syncopated hats, dark piano (~141).
  {
    n: "headie one|headie",
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [138, 143],
    l: "headie one",
  },
  {
    n: "digga d|digga",
    g: "drill",
    s: "uk",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [138, 144],
    l: "digga d",
  },
  {
    n: "808melo|808 melo",
    // The UK→BK architect (Pop Smoke's Welcome to the Party) — long
    // portamento 808 slides carry the entry.
    g: "drill",
    s: "dark",
    m: "dark",
    e: 0.8,
    d: 0.6,
    b: [138, 144],
    l: "808melo",
  },
  {
    n: "axl beats|axl",
    // UK→BK crossover — catchy accessible melodies over the slide.
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [138, 143],
    l: "axl beats",
  },
  {
    n: "ghosty|ghosty beats",
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [136, 142],
    l: "ghosty",
  },
  {
    n: "g herbo|herbo|lil herb|swervo",
    // Chicago drill — punchier, shorter-sustain 808s, harder swing.
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [138, 146],
    l: "g herbo",
  },
  {
    n: "m1onthebeat|m1 beats|m1",
    // Sharper percussive UK school (Carns Hill lane).
    g: "drill",
    s: "uk",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [138, 144],
    l: "m1onthebeat",
  },
  // Phonk — drift originators + memphis-lofi rap lane.
  {
    n: "kaito shoma|kaito|scary garry",
    // "Scary Garry" (2016) — one of the first drift phonk records.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.6,
    b: [140, 155],
    l: "kaito shoma",
  },
  {
    n: "pharmacist|pharmacist~",
    // Drift pioneer — night-drive cowbell pressure.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [140, 155],
    l: "pharmacist",
  },
  {
    n: "xavier wulf|hollow squad",
    // Memphis-revival rap (Hollow Squad) — Euclid-era menace.
    g: "phonk",
    s: "memphis",
    m: "aggressive",
    e: 0.75,
    d: 0.55,
    b: [125, 140],
    l: "xavier wulf",
  },
  {
    n: "night lovell|dark light",
    // Dark lo-fi (Dark Light) — slowed menace, room to breathe.
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [120, 135],
    l: "night lovell",
  },
  {
    n: "bones|teamsesh|sesh",
    // TeamSESH cloud/lo-fi — the chillest memphis corner.
    g: "phonk",
    s: "memphis",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [120, 130],
    l: "bones",
  },
  // ── Southern specialties (new grooves: bounce / miamibass / snap) ────
  // ── + afroswing + countrytune ─────────────────────────────────────────
  {
    n: "big freedia|dj jubilee|juvenile|back that azz|bounce~",
    g: "trap",
    s: "bounce",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [98, 104],
    l: "nola bounce",
  },
  {
    n: "2 live crew|uncle luke|luther campbell|luke~",
    g: "trap",
    s: "miamibass",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [115, 125],
    l: "2 live crew",
  },
  {
    n: "soulja boy|crank dat|soulja boy~",
    g: "trap",
    s: "snap",
    m: "energetic",
    e: 0.65,
    d: 0.4,
    b: [80, 95],
    l: "soulja boy",
  },
  {
    n: "dem franchize|d4l|laffy taffy|snap~",
    g: "trap",
    s: "snap",
    m: "energetic",
    e: 0.65,
    d: 0.4,
    b: [80, 95],
    l: "snap era",
  },
  {
    n: "j hus|jhus|mostack|mo stack|nsg|afroswing~",
    g: "house",
    s: "afroswing",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [100, 108],
    l: "afroswing",
  },
  {
    // "lil nas x" always blends with the nas preset ("nas" matches inside) —
    // energy/density sit nas-adjacent so the blend stays in the pocket and
    // the BPM intersection ([88,92]) lands inside the countrytune window.
    n: "lil nas x|old town road|lil nas x~",
    g: "trap",
    s: "countrytune",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [78, 92],
    l: "lil nas x",
  },
  // ── Chicago now (drill + conscious) ────────────────────────────────
  {
    // Bare "von" is German for "from" — qualified only.
    n: "king von|king von~|von~|grandson|otf",
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [135, 145],
    l: "king von",
  },
  {
    // Bare "chance" is a common word — qualified only. "acid rap" doubles as
    // the genre phrase (same trap family), so the pocket survives regardless.
    n: "chance the rapper|chance~|acid rap|coloring book|noname|noname~|telefone|room 25|saba|saba~|care for me|pivot gang",
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [82, 94],
    l: "chicago conscious",
  },
  // ── Detroit now (the detroit loop-rap bounce carries all three) ────
  {
    // Bare "sada" is SK for "now" — qualified only. Bare "rio" is the city.
    n: "sada baby|skuba|sada baby~|icewear vezzo|vezzo~|icewear|rich off pints|rio da yung og|rio~",
    g: "trap",
    s: "detroit",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 148],
    l: "detroit now",
  },
  // ── LA now (whisper-flow detroit + sung sparse) ─────────────────────
  {
    n: "drakeo|drakeo the ruler|flu flam|remble|remble~",
    g: "trap",
    s: "detroit",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [130, 144],
    l: "drakeo",
  },
  {
    n: "blxst|blxst~|sixtape|bino rideaux|bino~",
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [125, 140],
    l: "blxst",
  },
  // ── Rage / new jazz (opium-adjacent, jerk-plugg edge) ───────────────
  {
    // Bare "osa" is SK for "wasp" — qualified only. Nettspend / 2hollis live
    // in the parallel "plugg newer wave" entry (plugg pocket) — this one
    // carries the rage-bounce side (osamason) only.
    n: "osamason|osamason~|new rage~",
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [148, 165],
    l: "new rage",
  },
  // ── UK pop-drill (headie lives in the depth wave already) ───────────
  {
    // Bare "dave" is anyone's producer — qualified only.
    n: "santan dave|dave~|psychodrama",
    g: "drill",
    s: "melodic",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [138, 145],
    l: "dave",
  },
  {
    n: "stormzy|stormzy~|vossi bop",
    g: "drill",
    s: "grime",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [138, 144],
    l: "stormzy",
  },
  {
    n: "22gz|22gz~",
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [140, 150],
    l: "22gz",
  },
  // ── Female rap (the biggest open lane) ─────────────────────────────
  {
    n: "nicki minaj|nicki~|pink friday|barbz",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 145],
    l: "nicki minaj",
  },
  {
    n: "cardi b|cardi~|bodak yellow|bodak",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [130, 142],
    l: "cardi b",
  },
  {
    n: "latto|latto~|big latto|big energy",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [125, 140],
    l: "latto",
  },
  {
    // Dots never survive normalization ("f.n.f." → "f n f") — see t.i.
    n: "glorilla|glo~|f n f",
    g: "trap",
    s: "crunk",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [98, 108],
    l: "glorilla",
  },
  {
    n: "sexyy red|sexyy~|pound town",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [130, 145],
    l: "sexyy red",
  },
  {
    n: "doechii|doechii~|swamp princess",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 145],
    l: "doechii",
  },
  {
    n: "little simz|simz|simbi|grey area",
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [86, 94],
    l: "little simz",
  },
  // ── Latin trap + French cloud ──────────────────────────────────────
  {
    n: "bad bunny|benito~|un verano",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [95, 125],
    l: "bad bunny",
  },
  {
    n: "myke towers|myke~",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [95, 125],
    l: "myke towers",
  },
  {
    n: "duki|duki~",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [130, 150],
    l: "duki",
  },
  {
    n: "pnl|pnl~|qlf|deux freres",
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [128, 142],
    l: "pnl",
  },
  // ── SoundCloud era ─────────────────────────────────────────────────
  {
    n: "ski mask|slump god|ski mask~|stokeley",
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [140, 160],
    l: "ski mask",
  },
  {
    n: "smokepurpp|smokepurpp~|purpp|deadstar",
    g: "trap",
    s: "rolling",
    m: "dark",
    e: 0.75,
    d: 0.6,
    b: [130, 150],
    l: "smokepurpp",
  },
  {
    // Bare "pump" is a common verb — qualified only.
    n: "lil pump|lil pump~|gucci gang|gazzy",
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [130, 150],
    l: "lil pump",
  },
  // ── Experimental edge ──────────────────────────────────────────────
  {
    n: "death grips|death grips~|mc ride",
    g: "dnb",
    s: "amen",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [160, 168],
    l: "death grips",
  },
  {
    // Bare "clipping" is an audio term — qualified only.
    n: "clipping~|clipping band|daveed diggs",
    g: "phonk",
    s: "horror",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [132, 150],
    l: "clipping.",
  },
  // ── Bass house — heavy tech-house with rolling sub-bass + groovy drops ───
  // The post-Fisher / ACRAZE wave (2018+). Tech-house groove with layered
  // punch kick + offbeat clap + busy 16th-hat work; mid-tempo pocket 124-130.
  // Routes to groove 'house.basshouse' (Wave 3 groove).
  {
    n: "chris lake|acraze|sidepiece",
    g: "house",
    s: "basshouse",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [124, 130],
    l: "bass house",
  },
  // ── G-house — French house / R&B vocal-chop tech-house ──────────────────
  // Don Diablo's "g-house" coinage (2014+): deep groove + pitched R&B
  // acapellas. 120-126 floor, the chill-deep side of the house spectrum.
  // Routes to groove 'house.ghouse' (Wave 3 groove).
  {
    n: "don diablo|tchami|malaa",
    g: "house",
    s: "ghouse",
    m: "chill",
    e: 0.75,
    d: 0.55,
    b: [120, 126],
    l: "g-house",
  },
  // ── Future bass — melodic half-time pop-EDM, chopped vocal leads ──────────
  // The bright side of post-2014 pop-future-bass (Marshmello / Said The Sky).
  // Flume's existing entry covers the 'lux' trap-flavour; this entry adds
  // the brighter pop-future-bass side. Routes to house.futurebass (Wave 5):
  // four-on-the-floor with the genre's syncopated 'skip' bass (kick-alt on
  // the 'e' and 'a' of 2) and a reverse-filling open hat on the last 16th.
  {
    n: "marshmello|said the sky",
    g: "house",
    s: "futurebass",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [140, 150],
    l: "future bass",
  },
  // ── Riddim dubstep — aggressive riddim / neuro, mid-tempo heavy drops ────
  // Existing entries (Skrillex, Subtronics, Seven Lions) cover mainline +
  // melodic dubstep. This one fills the riddim / heavy-mid lane (Virtual
  // Riot / Borgore). Routes to groove 'trap.dubstep' (140-150).
  {
    n: "virtual riot|borgore|riddim",
    g: "trap",
    s: "dubstep",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [140, 150],
    l: "riddim dubstep",
  },
  // ── Hardstyle — euphoric reverse-bass kicks + supersaw leads ─────────────
  // Hardstyle sits adjacent to techno. The new 'techno.hardstyle' groove
  // (Wave 3) captures the reverse-bass kick + layered kick-alt signature,
  // 150-155 BPM (post-2015 euphoric pocket). Grid-locked swing 0.
  {
    n: "headhunterz|sound rush|ran-d",
    g: "techno",
    s: "hardstyle",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [150, 155],
    l: "hardstyle",
  },
  // ── Psytrance — acid-driven 140 with rolling TB-303 lines + psy leads ─────
  // The harder psy side of trance. Existing trance entry (Tiesto/Armin)
  // covers melodic trance at 136-142 via 'driving'; this entry covers the
  // psy side via the new 'techno.psytrance' groove (Wave 3). 138-145 pocket.
  {
    n: "astrix|vini vici|infected mushroom",
    g: "trance",
    s: "psy",
    m: "energetic",
    e: 0.9,
    d: 0.65,
    b: [138, 145],
    l: "psytrance",
  },
  // ── Club depth wave 2 (same research base as wave 1) ────────────────────
  // Jersey second line: the Just-Wanna-Rock architect, the 2010s online
  // wave (Jayhood / Nadus / R3LL) and the Jersey Drill song-format founder.
  {
    n: "mcvertt|just wanna rock",
    // Newark producer behind Lil Uzi Vert's Just Wanna Rock (2022) and
    // Bandmanrill's HeartBroken — the mainstream jersey-club bounce.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [136, 142],
    l: "mcvertt",
  },
  {
    n: "dj jayhood|jayhood",
    // 2010s online wave — pushed the club sound onto festival stages.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 140],
    l: "dj jayhood",
  },
  {
    n: "nadus|thread",
    // #THREAD party series — eclectic club formats, bounce-forward.
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 140],
    l: "nadus",
  },
  {
    n: "r3ll",
    // Festival-circuit club — clean big-room-ready bounce.
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [132, 142],
    l: "r3ll",
  },
  {
    n: "unicorn151|killa kherk cobain",
    // First Jersey Drill song-format record (Jack N Drill, 2021, with
    // Bandmanrill) — drill delivery over the club bounce.
    g: "jersey",
    s: "club",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [138, 144],
    l: "unicorn151",
  },
  // Bronx drill — sample-heavy, raspy, a touch more aggressive than BK.
  {
    n: "b-lovee|blovee",
    // Bronx-to-sexy bridge (My Everything's Mary J. Blige flip) —
    // melodic but still gutter.
    g: "drill",
    s: "dark",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [140, 145],
    l: "b-lovee",
  },
  {
    n: "kay flock|kta",
    // Bronx drill front line — full-aggression sample drill.
    g: "drill",
    s: "dark",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [140, 145],
    l: "kay flock",
  },
  // UK drill — Homerton forefront.
  {
    n: "unknown t|homerton",
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.8,
    d: 0.55,
    b: [138, 144],
    l: "unknown t",
  },
  // Drift phonk anthems — the two Spotify-era records.
  {
    n: "interworld|metamorphosis",
    // Metamorphosis — the drift anthem with Russian-hard-bass DNA.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.6,
    b: [140, 155],
    l: "interworld",
  },
  {
    n: "dxrk|rave phonk",
    // Rave — Algerian-French take on the cowbell lane.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [140, 155],
    l: "dxrk",
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
    n: "macintosh plus|vektroid|george clanton|saint pepsi|luxury elite",
    g: "ambient",
    s: "drifting",
    m: "chill",
    e: 0.2,
    d: 0.4,
    b: [70, 85],
    l: "vaporwave",
  },
  // ── Synthwave — 80s-style analog synth leads + driving four-on-the-floor ─
  // Kavinsky 'Nightcall' / The Midnight / FM-84 / Mitch Murder / Timecop1983.
  // Mid-tempo pocket 95-115 with analog-synth colour. Routes to
  // ambient.synthwave (Wave 5) — a real 4/4 with gated snare on 2 and 4 and
  // driving toms, not the loose ambient pocket of ambient.organic.
  {
    n: "synthwave|kavinsky|the midnight|fm-84|mitch murder|timecop1983|lazerhawk",
    g: "ambient",
    s: "synthwave",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [95, 115],
    l: "synthwave",
  },
  // ── Lo-fi hip-hop — Nujabes lane, jazz-sample boom-bap at slow tempo ────
  // Nujabes 'Metaphorical Music' / DJ Okawari / Idealism / Tom Misch / Potsu.
  // BPM 75-92, jazz chords, dusty drums. Routes to ambient.drifting.
  {
    n: "lofi|lo-fi|nujabes|dj okawari|idealism|tom misch|potsu",
    g: "ambient",
    s: "drifting",
    m: "chill",
    e: 0.35,
    d: 0.45,
    b: [75, 92],
    l: "lofi (nujabes lane)",
  },
  // ── Downtempo — Bonobo / Caribou / Bibio / Oddisee ───────────────────────
  // Organic-instrument downtempo (Bonobo 'The North Borders' / Caribou 'Our
  // Love'). Four Tet's existing house/organic entry covers the dancier end;
  // this covers the slower organic-instrument side via ambient/organic.
  // BPM 92-110, chill mood.
  {
    n: "downtempo|bonobo|caribou|bibio|oddisee",
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [92, 110],
    l: "downtempo",
  },
  // ── Plugg newer wave — Nettspend / Autumn! / Homixide Gang / 2hollis ────
  // Post-Ken Carson / Destroy Lonely plugg wave (2023+). Plugg groove at
  // 140-160 with auto-tune-heavy vocal chops. Routes to trap.plugg.
  {
    n: "nettspend|autumn|homixide gang|homixide|2hollis",
    g: "trap",
    s: "plugg",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [130, 150],
    l: "plugg newer wave",
  },
  // ── Trap soul / R&B-trap — Bryson Tiller / PartyNextDoor / 6LACK ─────────
  // Slow R&B-leaning trap (Bryson Tiller 'TrapSoul' / PartyNextDoor). Drake's
  // existing trap/sparse entry covers the mid-tempo Toronto hybrid; this
  // covers the slow sung-R&B-trap side. Routes to trap.trapsoul (Wave 5):
  // the distinguishing feature vs trap.sparse is the limping kick on 1, the
  // 'and' of 2, 3, and the 'and' of 4, with the snare on 4 only. BPM 78-95.
  {
    n: "trap soul|trapsoul|bryson tiller|partynextdoor|6lack",
    g: "trap",
    s: "trapsoul",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [78, 95],
    l: "trap soul",
  },
  // ── Afrobeats / Afropop (modern) — Wizkid / Burna Boy / Davido / Tems ────
  // Modern West-African pop (Wizkid 'Essence' / Burna Boy 'Last Last' /
  // Davido 'Fall'). Routes to house.afropop — the dedicated afrobeats pop
  // groove (3+3+2 kick, rim melody); amapiano / Rema / Tyla stay on
  // house.afro. BPM 100-112.
  {
    n: "wizkid|burna boy|davido|tems|asake|victony|ayra starr",
    g: "house",
    s: "afropop",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [100, 112],
    l: "afrobeats",
  },
  // ── Latin urban / Reggaeton pop — J Balvin / Ozuna / Farruko / Rosalía ───
  // Modern reggaeton-pop (J Balvin 'Mi Gente' / Ozuna / Farruko / Rosalía
  // 'MALAMENTE'). Bad Bunny's existing entry covers the harder perreo side;
  // this covers the brighter dancefloor-pop reggaeton. Routes to
  // house.dembow (the chop). BPM 88-100.
  {
    n: "j balvin|ozuna|farruko|rosalia|anuel aa|anuel",
    g: "house",
    s: "dembow",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [88, 100],
    l: "latin urban",
  },
  // ── K-pop / Korean R&B — BTS / NewJeans / IU / Stray Kids / BLACKPINK ────
  // Korean pop production (BTS 'Dynamite' / NewJeans 'OMG' / IU). High-energy
  // pop at 100-120. Routes to house.kpop (Wave 5): the half-time snare flip
  // (backbeat on 3, the "k-step" bounce) is what separates it from house.pop.
  {
    n: "kpop|k-pop|bts|newjeans|iu|stray kids|blackpink",
    g: "house",
    s: "kpop",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [100, 120],
    l: "k-pop",
  },
  // ── Dancehall / Reggae-pop — Sean Paul / Damian Marley / Popcaan / Vybz ───
  // Caribbean dancehall (Sean Paul 'Temperature' / Popcaan / Vybz Kartel).
  // Routes to trap.dancehall (Wave 5): the one-drop — snare on 3 (step 8)
  // with the kick on 1 and the 'and' of 2, leaving the sparse 2-3 window the
  // toasting vocal rides. Ride + tick are the skank anchors. BPM 88-105.
  {
    n: "dancehall|sean paul|damian marley|popcaan|vybz kartel|shaggy",
    g: "trap",
    s: "dancehall",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [88, 105],
    l: "dancehall",
  },
  // ── City pop (Japanese 80s) — Anri / Tatsuro / Mariya Takeuchi ──────────
  // The 1980s Japanese studio-pop movement (Anri 'Last Summer Whisper' /
  // Tatsuro Yamashita / Mariya Takeuchi 'Plastic Love'). Lush AOR production,
  // 100-125, organic-instrument heavy. Routes to ambient.citypop (Wave 4) —
  // the rim-shot backbeat on 2 and 4 is the genre's signature, not a snare.
  {
    n: "city pop|anri|tatsuro|tatsuro yamashita|mariya takeuchi",
    g: "ambient",
    s: "citypop",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [100, 125],
    l: "city pop",
  },
  // ── 88rising / Asian-American pop — Joji / Rich Brian / NIKI ────────────
  // The 88rising wave (Joji 'Sanctuary' / Rich Brian 'Dat $tick'). Lush
  // bedroom-R&B / indie-pop. Routes to trap.bedroom (Wave 5): soft
  // offbeat-anchored kick, rim-tap instead of a snare backbeat, 80-110.
  {
    n: "88rising|joji|rich brian|niki|atarashii gakko",
    g: "trap",
    s: "bedroom",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [80, 110],
    l: "88rising",
  },
  // ── Trap producers (the "type beat" search language) ───────────────────
  // Anchors: Drip Too Hard 113 (SongBPM), Black Beatles 146, HUMBLE. 150,
  // Life Is Good 142 — trap counts half-time, ranges follow the 130-150
  // production pocket.
  {
    n: "wheezy",
    // 808 Mafia melodic corner — airy plucks over sparse knock (Drip Too
    // Hard, Bad and Boujee).
    g: "trap",
    s: "lux",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [130, 146],
    l: "wheezy",
  },
  {
    n: "southside|808 mafia",
    // 808 Mafia aggressive corner — dark, hard, relentless (trap.sparse lane).
    g: "trap",
    s: "sparse",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [130, 145],
    l: "southside",
  },
  {
    n: "tm88",
    // Black Beatles (146) bounce — melodic and playful.
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [138, 150],
    l: "tm88",
  },
  {
    n: "murda beatz|murda|murda on the beat",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 145],
    l: "murda beatz",
  },
  {
    n: "mike will|mike will made it|mike will made-it|mike will madeit",
    // HUMBLE. (150) — the hard-hitting dark-keys corner (trap.rolling lane).
    g: "trap",
    s: "rolling",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [138, 150],
    l: "mike will made-it",
  },
  {
    n: "hit-boy|hit boy",
    // Versatile A-list: rolling pockets, wide tempo window.
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [130, 150],
    l: "hit-boy",
  },
  {
    n: "london on da track|london on the track",
    g: "trap",
    s: "bouncy",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 145],
    l: "london on da track",
  },
  {
    n: "wondagurl|wonda",
    // Cinematic dark trap (Take Care-era, Travis placements) — trap.sparse lane.
    g: "trap",
    s: "sparse",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [140, 150],
    l: "wondagurl",
  },
  {
    n: "sonny digital",
    g: "trap",
    s: "rolling",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [130, 145],
    l: "sonny digital",
  },
  // ── Memphis OG producers (the original phonk source tapes) ─────────────
  {
    n: "dj squeeky",
    // The lo-fi tape origin — hiss, cowbell, half-time menace.
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [120, 140],
    l: "dj squeeky",
  },
  {
    n: "dj spanish fly",
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [120, 140],
    l: "dj spanish fly",
  },
  {
    n: "kingpin skinny pimp|skinny pimp",
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [125, 142],
    l: "kingpin skinny pimp",
  },
  {
    n: "playa fly",
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [122, 140],
    l: "playa fly",
  },
  {
    n: "tommy wright|tommy wright iii",
    // Still Pimpin (the tape Beyoncé opened RENAISSANCE with).
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [125, 142],
    l: "tommy wright iii",
  },
  // ── UKG new wave (post-2020 revival) ───────────────────────────────────
  {
    n: "conducta",
    // Kiwi Rekords — warm, vocal-forward 2-step revival.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 140],
    l: "conducta",
  },
  {
    n: "interplanetary criminal",
    // The 2022 revival anthem corner (B.O.T.A. energy).
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [132, 142],
    l: "interplanetary criminal",
  },
  {
    n: "sammy virji|virji",
    // Bass-forward speed-garage bounce.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "sammy virji",
  },
  {
    n: "piri",
    // piri & tommy — the pop-facing, melodic UKG lane.
    g: "ukg",
    s: "ukg",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [132, 140],
    l: "piri",
  },
  // ── UK drill second line ────────────────────────────────────────────────
  {
    n: "ofb|bandokay",
    // Broadwater Farm / OFB — dark, sparse, slide-heavy.
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.8,
    d: 0.55,
    b: [138, 144],
    l: "ofb",
  },
  {
    n: "loski|harlem spartans",
    g: "drill",
    s: "uk",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [138, 145],
    l: "loski",
  },
  {
    n: "digdat",
    g: "drill",
    s: "uk",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [138, 144],
    l: "digdat",
  },
  // ── Hyperpop wave — A.G. Cook / 100 gecs / Underscores / Danny L Harle ───
  // The PC Music / hyperpop scene (A.G. Cook 'Apple' / 100 gecs 'money
  // machine' / Danny L Harle). Charli XCX's existing entry covers the pop-
  // hyperpop lane; this entry covers the deconstructionist + maximalist side.
  // Routes to trap.hyper (140-160, glitchy + dense).
  {
    n: "a.g. cook|ag cook|100 gecs|100gecs|underscores|danny l harle|iglooghost|hudson mohawke",
    g: "hyperpop",
    s: "decon",
    m: "energetic",
    e: 0.9,
    d: 0.8,
    b: [140, 160],
    l: "hyperpop wave",
  },
  // ── Baile funk — Anitta / MC Kevin o Chris / DJ Rennan da Penha ──────────
  // Brazilian baile funk (Anitta 'Envolver' / MC Kevin o Chris). Routes to
  // the new 'house.baile' groove (Wave 4): the tambor (low-tom roll on the
  // offbeat) is the signature, with the shaker doubling the 16ths. BPM
  // 130-150, swing 0.2 (the Brazilian shuffle).
  {
    n: "baile funk|funk carioca|anitta|mc kevin o chris|mc kevin|dj rennan da penha|dj guh mix",
    g: "house",
    s: "baile",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [130, 150],
    l: "baile funk",
  },
  // ── Corridos tumbados — Peso Pluma / Natanael Cano / Junior H ───────────
  // The corridos-tumbados movement (Peso Pluma 'Ella Baila Sola' / Natanael
  // Cano). Mexican trap-Americana hybrid. Routes to the new 'trap.corridos'
  // groove (Wave 4): trap hats + sub-kick, but the snare lands on 3 and 4
  // (a march backbeat) and the low tom carries the tamborazo roll.
  // BPM 90-130.
  {
    n: "corridos tumbados|peso pluma|natanael cano|junior h|eslabon armado|fuerza regida",
    g: "trap",
    s: "corridos",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [90, 130],
    l: "corridos tumbados",
  },
  // ── Industrial techno / EBM — Surgeon / Ancient Methods / Vatican Shadow ─
  // The industrial-techno / EBM scene (Surgeon 'Lum' / Ancient Methods).
  // Routes to the new 'techno.ebm' groove (Wave 4): techno kick on the four,
  // hard snare on 2 and 4, relentless 8th closed hat, tick machine-gun.
  // Near-zero swing 0.02 — the drive is mechanical, not humanised.
  // BPM 130-140.
  {
    n: "industrial techno|ebm|surgeon|ancient methods|vatican shadow|boy harsher|phase fatale",
    g: "techno",
    s: "ebm",
    m: "dark",
    e: 0.9,
    d: 0.65,
    b: [130, 140],
    l: "industrial techno",
  },
  // ── Footwork / juke — RP Boo / DJ Rashad / Traxman / DJ Deeon ───────────
  // Chicago footwork / juke (RP Boo 'Baby Come On' / DJ Rashad 'Drumma
  // Boy'). Routes to the new 'house.footwork' groove (Wave 3): polyrhythmic
  // kick against a steady snare, busy hats, perc stabs. Straight-grid swing
  // 0 — footwork's signature is dead-grid precision. BPM 155-165.
  {
    n: "footwork|juke|rp boo|dj rashad|traxman|dj deeon|teklife",
    g: "house",
    s: "footwork",
    m: "energetic",
    e: 0.95,
    d: 0.75,
    b: [155, 165],
    l: "footwork / juke",
  },
  // ── Melodic house — Tinlicker / Lane 8 / Yotto / Nora En Pure ────────────
  // Melodic-house / progressive-house (Lane 8 'Brightest Lights' / Tinlicker
  // / Nora En Pure). Ben Böhmer's existing entry covers one flavor; this
  // covers the deeper / more club-oriented melodic side. Routes to the new
  // 'house.melodic' groove (Wave 4): rolling ride + soft ghost hats for the
  // long-form forward motion. BPM 120-128, swing 0.16.
  {
    n: "melodic house|tinlicker|lane 8|lane8|yotto|nora en pure|le youth",
    g: "house",
    s: "melodic",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [120, 128],
    l: "melodic house",
  },
  // ── Plugg / opium producers (the type-beat search language) ─────────────
  // Plugg stays in the 140-160 springy bell pocket (registry's plugg entry);
  // opium/rage sits at 150-165 bouncy (registry's opium rage entry).
  {
    n: "mexikodro",
    // The plugg architect (Playboi Carti / UnoTheActivist era) — the
    // springy bell template the whole lane borrows.
    g: "trap",
    s: "plugg",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [140, 160],
    l: "mexikodro",
  },
  {
    n: "cashcache",
    // Pluggnb's modern face — soft bells, gliding 808s.
    g: "trap",
    s: "plugg",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [140, 160],
    l: "cashcache",
  },
  {
    n: "xangang",
    g: "trap",
    s: "plugg",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [140, 158],
    l: "xangang",
  },
  {
    n: "senseiatl|sensei atl",
    g: "trap",
    s: "plugg",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [140, 158],
    l: "senseiatl",
  },
  {
    n: "forza",
    // Pluggnb keys + vocal-chop textures.
    g: "trap",
    s: "plugg",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [140, 158],
    l: "forza",
  },
  {
    n: "f1lthy|outtatown|lil 88|star boy",
    // The opium production room (Whole Lotta Red era) — distorted rage.
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [150, 165],
    l: "f1lthy / outtatown",
  },
  {
    n: "ojivolta|richie souf",
    // Opium-adjacent A-list rage placements.
    g: "trap",
    s: "bouncy",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [148, 162],
    l: "ojivolta / richie souf",
  },
  {
    n: "whitearmor|yung gud",
    // Drain Gang / sadboys — ethereal, blurred plugg-gaze. (Bare "drain
    // gang" stays with the yung lean entry above — first-match order.)
    g: "trap",
    s: "plugg",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [135, 155],
    l: "whitearmor / yung gud",
  },
  // ── Amapiano / afro-house producers ────────────────────────────────────
  // Registry anchors: amapiano 110-115, afro house 120-124 (both house/afro).
  {
    n: "kabza de small|dj maphorisa",
    // The amapiano kings (John Wick era) — log-drum-forward.
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 116],
    l: "kabza de small / maphorisa",
  },
  {
    n: "mr jazziq|jazziq",
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 116],
    l: "mr jazziq",
  },
  {
    n: "uncle waffles",
    // The amapiano-to-mainstream bridge (Tanzania).
    g: "amapiano",
    s: "yanos",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [110, 115],
    l: "uncle waffles",
  },
  {
    n: "major league djz|major league",
    g: "amapiano",
    s: "yanos",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [110, 115],
    l: "major league djz",
  },
  {
    n: "focalistic",
    // Pitori rap over amapiano — energetic vocal-forward side.
    g: "amapiano",
    s: "yanos",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [110, 115],
    l: "focalistic",
  },
  {
    n: "kelvin momo|sun-el musician|sun el",
    // Soulful amapiano (smooth piano + vocal pads).
    g: "amapiano",
    s: "soulful",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [110, 116],
    l: "kelvin momo",
  },
  {
    n: "shimza|black motion",
    // Afro-house/afro-tech — deeper, more driving than amapiano.
    g: "house",
    s: "afro",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [118, 126],
    l: "shimza / black motion",
  },
  {
    n: "da capo|eno napa|kususa|caiiro",
    // Afro-house producer school — percussive, melodic, patient.
    g: "house",
    s: "afro",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [118, 126],
    l: "afro house producer school",
  },
  {
    n: "themba",
    g: "house",
    s: "afro",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [120, 126],
    l: "themba",
  },
  // ── Phonk TikTok second wave (glitch/sigilkore + drift next gen) ───────
  // Faster cowbell-forward lane, 145-170 (registry's drift pocket extends
  // to 170 for the TikTok era).
  {
    n: "hensonn|g3ox_em|g3ox em",
    // The sped-up drift remix generation — maximal cowbell, no restraint.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [150, 170],
    l: "hensonn / g3ox_em",
  },
  {
    n: "cypariss|kslv",
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [145, 165],
    l: "cypariss / kslv",
  },
  {
    n: "sxmpra",
    // The "Cowbell Warrior" lane — hard, compressed, vocal-chop driven.
    g: "phonk",
    s: "drift",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [150, 170],
    l: "sxmpra",
  },
  {
    n: "mythic|backwhen|yung vamp",
    // The rare-phonk / dark-cloud school (slower, tape-warped).
    g: "phonk",
    s: "memphis",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [125, 145],
    l: "rare phonk",
  },
  // ── techno depth wave (the genre's biggest hole: 24 presets vs trap's 140) ──
  // Legendary floors that were missing entirely: Detroit, dub techno, acid,
  // micro-house, electro and the 90s UK/US hard techno lineage. All styles
  // resolve to existing techno.* grooves (driving / minimal / dub / acid /
  // industrial / hard / melodic).
  {
    n: "jeff mills|the wizard|purpose maker",
    // Detroit techno's axis: hypnotic loops, relentless drive, sci-fi motif.
    g: "detroit",
    s: "secondwave",
    m: "energetic",
    e: 0.9,
    d: 0.65,
    b: [135, 145],
    l: "jeff mills",
  },
  {
    n: "richie hawtin|plastikman|minus",
    // Minimal/micro master: sparse, surgical, late-night pressure.
    g: "techno",
    s: "minimal",
    m: "dark",
    e: 0.65,
    d: 0.4,
    b: [124, 132],
    l: "richie hawtin",
  },
  {
    n: "derrick may|mayday|strings of life",
    // Detroit's string-heavy high-tech soul.
    g: "detroit",
    s: "belleville",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [125, 133],
    l: "derrick may",
  },
  {
    n: "juan atkins|model 500|cybotron",
    // Electro-techno originator: machine funk, 808 backbone — now rides the
    // dedicated techno.electro groove instead of driving techno.
    g: "detroit",
    s: "electro",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [125, 135],
    l: "juan atkins",
  },
  {
    // NOTE: no bare "reese" alias — "Reese bass" is a DnB technique and the
    // name would hijack every "reese bass" prompt. Full name only.
    n: "kevin saunderson|inner city~",
    g: "detroit",
    s: "belleville",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [124, 132],
    l: "kevin saunderson",
  },
  {
    n: "carl craig|paperclip people|69~",
    // Detroit techno's eclectic edge — from ambient to jacking.
    g: "detroit",
    s: "secondwave",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [124, 134],
    l: "carl craig",
  },
  {
    n: "robert hood|minimal nation|monobox",
    // The minimal-nation architect: stripped, loopy, surgical.
    g: "detroit",
    s: "minimal",
    m: "dark",
    e: 0.75,
    d: 0.4,
    b: [128, 138],
    l: "robert hood",
  },
  {
    n: "octave one|black water|lenny burden",
    g: "detroit",
    s: "belleville",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [124, 132],
    l: "octave one",
  },
  {
    n: "terrence dixon|dixon techno",
    // Detroit's live-improvisation wizard.
    g: "detroit",
    s: "secondwave",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [128, 138],
    l: "terrence dixon",
  },
  {
    n: "omar s|omar-s|fxhe",
    // Detroit raw analogue house-techno crossover.
    g: "detroit",
    s: "secondwave",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [120, 128],
    l: "omar s",
  },
  {
    n: "moodymann|moodyman|kenny dixon jr",
    // Detroit deep house-techo soul (raw, sample-driven).
    g: "techno",
    s: "melodic",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [118, 126],
    l: "moodymann",
  },
  {
    n: "theo parrish|sound signature",
    g: "techno",
    s: "melodic",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [115, 125],
    l: "theo parrish",
  },
  {
    n: "dave clarke|red 2|charcoal",
    // 90s UK/US hard-but-functional techno.
    g: "techno",
    s: "hard",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [138, 148],
    l: "dave clarke",
  },
  {
    n: "ben sims|hardgroove|hard groove~",
    // The hardgroove inventor: driving, percussive, no-nonsense.
    g: "techno",
    s: "driving",
    m: "energetic",
    e: 0.9,
    d: 0.7,
    b: [136, 145],
    l: "ben sims",
  },
  {
    n: "oscar mulero|pole group",
    g: "techno",
    s: "driving",
    m: "dark",
    e: 0.85,
    d: 0.6,
    b: [132, 142],
    l: "oscar mulero",
  },
  {
    n: "dvs1|dvs-1",
    g: "techno",
    s: "driving",
    m: "dark",
    e: 0.85,
    d: 0.6,
    b: [132, 142],
    l: "dvs1",
  },
  {
    n: "dax j|monnom black",
    g: "techno",
    s: "industrial",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [138, 148],
    l: "dax j",
  },
  {
    n: "len faki|figure techno",
    g: "techno",
    s: "driving",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [132, 142],
    l: "len faki",
  },
  {
    n: "speedy j|public energy|electric deluxe",
    g: "techno",
    s: "industrial",
    m: "dark",
    e: 0.85,
    d: 0.6,
    b: [135, 145],
    l: "speedy j",
  },
  {
    n: "paula temple|noise manifesto",
    g: "techno",
    s: "industrial",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [138, 150],
    l: "paula temple",
  },
  {
    n: "rebecca black techno|rebecca black dj",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [138, 148],
    l: "rebecca black",
  },
  {
    n: "999999999|nine nine nine",
    // Modern acid-rave hard techno.
    g: "techno",
    s: "acid",
    m: "aggressive",
    e: 0.95,
    d: 0.7,
    b: [140, 150],
    l: "999999999",
  },
  {
    n: "nico moreno|the acid brother",
    g: "techno",
    s: "acid",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [142, 152],
    l: "nico moreno",
  },
  {
    // Matching runs on DE-ACCENTED text, so the alias must be the ASCII form.
    n: "shlomo techno|shlomo",
    g: "techno",
    s: "industrial",
    m: "dark",
    e: 0.85,
    d: 0.6,
    b: [132, 142],
    l: "shlømo",
  },
  // Acid lineage — the techno.acid groove had NO artist entries at all.
  {
    n: "dj pierre|phuture|acid tracks",
    // The acid-house fountainhead (Chicago 1987).
    g: "techno",
    s: "acid",
    m: "energetic",
    e: 0.85,
    d: 0.6,
    b: [122, 132],
    l: "dj pierre",
  },
  {
    n: "hardfloor|acid bath",
    g: "techno",
    s: "acid",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "hardfloor",
  },
  {
    n: "emmanuel top|acid phase",
    g: "techno",
    s: "acid",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [135, 145],
    l: "emmanuel top",
  },
  {
    // No bare "plug" — it is a generic English word ("plug in") and the
    // plugg roster in trap already owns that sound space.
    n: "luke vibert|wagon christ",
    g: "techno",
    s: "acid",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [120, 135],
    l: "luke vibert",
  },
  {
    n: "tin man|acid test",
    g: "techno",
    s: "acid",
    m: "dark",
    e: 0.7,
    d: 0.5,
    b: [122, 132],
    l: "tin man",
  },
  {
    n: "donato dozzy|voices from the lake",
    // Hypnotic/psychedelic techno — slow, deep, trippy.
    g: "techno",
    s: "dub",
    m: "dark",
    e: 0.6,
    d: 0.4,
    b: [122, 132],
    l: "donato dozzy",
  },
  // Dub techno — an entire sub-genre with zero presets (the techno.dub groove
  // existed with no artist consumer).
  {
    n: "basic channel|maurizio|rhythm & sound|rhythm and sound",
    // The Berlin dub-techno originators (Chord/Quadrant lineage).
    g: "techno",
    s: "dub",
    m: "chill",
    e: 0.45,
    d: 0.35,
    b: [118, 128],
    l: "basic channel",
  },
  {
    n: "deepchord|cv313|rod modell",
    // Modern dub techno's deep end.
    g: "techno",
    s: "dub",
    m: "chill",
    e: 0.45,
    d: 0.35,
    b: [118, 126],
    l: "deepchord",
  },
  {
    n: "deadbeat|scott monteith",
    g: "techno",
    s: "dub",
    m: "chill",
    e: 0.5,
    d: 0.4,
    b: [120, 130],
    l: "deadbeat",
  },
  {
    n: "monolake|robert henke",
    g: "techno",
    s: "dub",
    m: "dark",
    e: 0.6,
    d: 0.45,
    b: [125, 135],
    l: "monolake",
  },
  {
    n: "yagya|quantec|bvdub",
    g: "techno",
    s: "dub",
    m: "chill",
    e: 0.4,
    d: 0.35,
    b: [112, 124],
    l: "yagya",
  },
  {
    n: "villalobos|ricardo villalobos",
    // Micro-house's maximal-minimal maestro.
    g: "techno",
    s: "minimal",
    m: "chill",
    e: 0.55,
    d: 0.45,
    b: [120, 128],
    l: "villalobos",
  },
  {
    // No bare "zip" / "perlon" alone is fine but "zip" is a common word —
    // both stay qualified.
    n: "zip~|sonja moonear|perlon~",
    g: "techno",
    s: "minimal",
    m: "chill",
    e: 0.6,
    d: 0.45,
    b: [122, 130],
    l: "perlon",
  },
  // Electro — Detroit's other half; rides the dedicated techno.electro groove.
  {
    n: "drexciya|dopplereffekt|japanese telecom",
    g: "detroit",
    s: "electro",
    m: "dark",
    e: 0.75,
    d: 0.6,
    b: [125, 138],
    l: "drexciya",
  },
  {
    n: "dj stingray|313 bass mechanics",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.8,
    d: 0.65,
    b: [128, 140],
    l: "dj stingray",
  },
  {
    n: "helena hauff|return to mono",
    g: "techno",
    s: "driving",
    m: "dark",
    e: 0.85,
    d: 0.65,
    b: [130, 140],
    l: "helena hauff",
  },
  {
    n: "aux 88|cybotron electro|electro techno",
    g: "detroit",
    s: "technobass",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [125, 135],
    l: "aux 88",
  },
  {
    n: "client_03|client 03",
    g: "techno",
    s: "driving",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 140],
    l: "client_03",
  },
  // ── experimental edges (roadmap wave 12) + score/neoclassical depth ──
  {
    n: "kevin abstract|brockhampton|bh",
    // Hyperpop-adjacent boyband: genre-hopping, bright, restless.
    g: "trap",
    s: "hyper",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [120, 150],
    l: "brockhampton",
  },
  // (clipping. already has its phonk/horror entry above — not re-added)
  {
    n: "dalek|dälek~|clouddead|cLOUDDEAD~",
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.45,
    d: 0.45,
    b: [80, 100],
    l: "abstract hip-hop",
  },
  {
    n: "flying lotus|flylo|brainfeeder",
    // LA beat-scene experimental: wonky, cosmic, jazzy.
    g: "ambient",
    s: "glitch",
    m: "energetic",
    e: 0.65,
    d: 0.6,
    b: [90, 110],
    l: "flying lotus",
  },
  {
    n: "rapsody~|rapsody",
    g: "boombap",
    s: "modern",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [85, 95],
    l: "rapsody",
  },
  {
    n: "currensy|spitta|wiz khalifa|taylor gang",
    g: "trap",
    s: "sparse",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [120, 132],
    l: "currensy",
  },
  {
    // Neoclassical / modern score — the ambient genre's biggest hole.
    n: "ludovico einaudi|einaudi|olafur arnalds|nils frahm",
    g: "drone",
    s: "neoclassical",
    m: "chill",
    e: 0.35,
    d: 0.35,
    b: [60, 85],
    l: "neoclassical",
  },
  {
    n: "max richter|hildur|johann johannsson|hans zimmer~|clint mansell",
    g: "drone",
    s: "neoclassical",
    m: "dark",
    e: 0.4,
    d: 0.4,
    b: [55, 80],
    l: "modern score",
  },
  {
    n: "vangelis|jean-michel jarre|jean michel jarre|tangerine dream~",
    g: "ambient",
    s: "organic",
    m: "energetic",
    e: 0.5,
    d: 0.5,
    b: [80, 110],
    l: "cosmic classical",
  },
  {
    n: "steve roach|robert rich|alva noto|ryuichi sakamoto",
    g: "drone",
    s: "drone",
    m: "chill",
    e: 0.3,
    d: 0.3,
    b: [50, 75],
    l: "deep ambient",
  },
  {
    n: "loscil|biosphere|hammock",
    g: "drone",
    s: "isolationism",
    m: "chill",
    e: 0.35,
    d: 0.35,
    b: [60, 90],
    l: "isolationism",
  },
  // (footwork / juke already has a roster entry above — not re-added)
  // 2-step garage lineage (UKG had the revival wave but not the originators).
  {
    n: "mj cole|artful dodger|craig david~",
    g: "ukg",
    s: "ukg",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [128, 136],
    l: "2-step origin",
  },
  {
    n: "zed bias|el-b|el b|wookie",
    // The dark side of UKG — ghostly, sub-heavy.
    g: "ukg",
    s: "ukg",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [130, 138],
    l: "dark 2-step",
  },
  // Big-beat / breaks lineage (house family, the breaks floor).
  {
    // No bare "big beat" — generic English that would hijack any promo text.
    n: "fatboy slim|chemical brothers|crystal method",
    g: "house",
    s: "bigbeat",
    m: "energetic",
    e: 0.9,
    d: 0.7,
    b: [125, 140],
    l: "big beat",
  },
  {
    n: "prodigy|orbital|underworld|leftfield",
    g: "techno",
    s: "driving",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [128, 145],
    l: "90s rave",
  },
  // ── Jersey / Baltimore / UKG producer depth (the crate-digger lane) ────
  // Jersey club: 134-142 (jersey.club groove); Baltimore club runs the same
  // breakbeat at a touch slower (125-135); bassline/speed garage 130-140
  // (house.ukg groove).
  {
    n: "dj lilman|lilman",
    // The 2010s jersey-club second wave (festival circuit, club-anthem).
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [134, 142],
    l: "dj lilman",
  },
  {
    n: "kayy drizz",
    // The dance-challenge vocal queen of the new wave.
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [134, 142],
    l: "kayy drizz",
  },
  {
    n: "so dellirious|dellirious",
    // Brick Bandits-adjacent — original-era bounce feel.
    g: "jersey",
    s: "bounce",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [130, 138],
    l: "so dellirious",
  },
  {
    n: "dj problem",
    // Newark drill-era club flips — hard 140 landing.
    g: "jersey",
    s: "flip",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [136, 144],
    l: "dj problem",
  },
  {
    n: "dj delish",
    g: "jersey",
    s: "flip",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [134, 142],
    l: "dj delish",
  },
  {
    n: "dj tim dolla",
    // Original Brick Bandits crew — the foundation tempo.
    g: "jersey",
    s: "club",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [128, 136],
    l: "dj tim dolla",
  },
  // Baltimore club — the parent genre (slower, breakbeat + "Think" chops).
  {
    n: "baltimore club|dj k-swift|k-swift|scottie b|debonair samir",
    // Scottie B / K-Swift / Debonair Samir — the Unruly Records school, on
    // the dedicated "Think"-break stomp groove (not the jersey triple-kick).
    g: "jersey",
    s: "baltimore",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [125, 135],
    l: "baltimore club",
  },
  {
    n: "kw griff|dj technics|miss tonya|rod lee",
    // The deeper Baltimore lineage (Rod Lee / Technics / KW Griff).
    g: "jersey",
    s: "baltimore",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [125, 135],
    l: "baltimore lineage",
  },
  {
    n: "blaqstarr",
    // Baltimore-to-global (Diplo co-signs) — chant-forward breaks.
    g: "jersey",
    s: "bounce",
    m: "aggressive",
    e: 0.85,
    d: 0.65,
    b: [126, 136],
    l: "blaqstarr",
  },
  // UKG / bassline / speed garage producers.
  {
    n: "salute",
    // The 2020s UKG-via-electronic-pop lane — bright, emotional, club-ready.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [132, 140],
    l: "salute",
  },
  {
    n: "barry can't swim|barry cant swim",
    // The UKG-adjacent indie-dance crossover (emotional, vocal-led).
    g: "ukg",
    s: "ukg",
    m: "chill",
    e: 0.7,
    d: 0.55,
    b: [128, 136],
    l: "barry can't swim",
  },
  {
    n: "dj q|t2|burgaboy|jamie duggan|trc",
    // Bassline / Niche Sheffield school — speed-garage bass pressure.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [132, 140],
    l: "bassline / niche",
  },
  // ── Hyperpop deconstruction + sigilkore/hexd underworld ────────────────
  // hyper lane, 140-170 (trap.hyper groove); the sigilkore/hexd world keeps
  // the same lane but slower and murkier (130-155).
  {
    n: "umru|felicita|easyfun|life sim|hdmird",
    // The PC Music production room outside A.G. Cook — deconstructed club
    // maximalism (umru, felicita, easyFun).
    g: "hyperpop",
    s: "hyper",
    m: "energetic",
    e: 0.9,
    d: 0.8,
    b: [150, 170],
    l: "pc music room",
  },
  {
    n: "shygirl|jockstrap|black dresses",
    // The art-pop / deconstructed-club edge (Shygirl, Jockstrap, Black
    // Dresses) — vocals against broken club pressure.
    g: "hyperpop",
    s: "hyper",
    m: "aggressive",
    e: 0.85,
    d: 0.75,
    b: [140, 165],
    l: "deconstructed club",
  },
  {
    n: "machine girl|alice gas",
    // Digital hardcore / breakcore revival — punk speed + electronic rage.
    g: "dnb",
    s: "amen",
    m: "aggressive",
    e: 0.95,
    d: 0.75,
    b: [170, 180],
    l: "digital hardcore",
  },
  {
    n: "food house|gupi|fraxiom|that kid",
    // The 2020 hyperpop scene's DIY heart (food house = gupi + fraxiom).
    g: "hyperpop",
    s: "hyper",
    m: "energetic",
    e: 0.9,
    d: 0.8,
    b: [150, 170],
    l: "hyperpop DIY",
  },
  {
    n: "sewerslvt|goreshit",
    // Breakcore / jungle's internet revival — amen choppage + melancholy.
    g: "dnb",
    s: "amen",
    m: "dark",
    e: 0.9,
    d: 0.7,
    b: [170, 180],
    l: "breakcore revival",
  },
  {
    n: "luci4|sellasouls|nosgov|axxturel",
    // Sigilkore — the occult-coded plugg/hexd underworld (Luci4 / Sellasouls).
    g: "trap",
    s: "hyper",
    m: "dark",
    e: 0.85,
    d: 0.7,
    b: [135, 155],
    l: "sigilkore",
  },
  {
    n: "sematary|ghost mountain|buckshot|turnabout|hackle",
    // Haunted Mound — the trap-rave/goth-country fusion (Sematary crew).
    g: "trap",
    s: "hyper",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [140, 165],
    l: "haunted mound",
  },
  {
    n: "salem|crim3s|ooooo|white ring",
    // Witch house — the 2010 originators (slowed, chopped, occult).
    g: "ambient",
    s: "drifting",
    m: "dark",
    e: 0.35,
    d: 0.45,
    b: [70, 90],
    l: "witch house",
  },
  {
    n: "crystal castles|ic3peak|zheani|kumo 99",
    // The dark-electronic / witch-adjacent vocal lane.
    g: "ambient",
    s: "glitch",
    m: "aggressive",
    e: 0.8,
    d: 0.65,
    b: [80, 120],
    l: "dark electronic",
  },
  // ── house depth wave — the genre's FOUNDING history was missing entirely ──
  // Chicago (1984-88), Detroit house, the NJ/NY garage axis, French filter
  // and the modern deep/melodic school. All styles resolve to existing
  // house.* grooves (soulful / deep / funky / driving / disco / minimal).
  {
    n: "frankie knuckles|the godfather of house|knuckles",
    // Chicago house's founding DJ — the Warehouse/Paradise sound.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [118, 126],
    l: "frankie knuckles",
  },
  {
    n: "larry heard|mr fingers|fingers inc|fingers inc.",
    // The other Chicago pillar — deep, melancholy, string-led.
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [116, 124],
    l: "larry heard",
  },
  {
    n: "marshall jefferson|move your body house",
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [118, 126],
    l: "marshall jefferson",
  },
  {
    n: "ron hardy|music box chicago",
    // The wilder Chicago counterpoint — raw, jacking, tape edits.
    g: "house",
    s: "funky",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [120, 128],
    l: "ron hardy",
  },
  {
    n: "steve hurley|farley jackmaster funk|jesse saunders|chip e|adonis house",
    // The Chicago production/compilation era (Trax / DJ International).
    g: "house",
    s: "funky",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [118, 128],
    l: "chicago trax",
  },
  {
    n: "ten city|byron stingily|inner city house",
    // Chicago's vocal-house wing.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [114, 124],
    l: "chicago vocal",
  },
  {
    n: "blake baxter|eddie fowlkes|kelli hand|terrence parker|dream 2 science",
    // Detroit house — techno's soulful sibling (the house side of the axis).
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [118, 128],
    l: "detroit house",
  },
  {
    n: "kerri chandler|kaidi tatham|apollo era",
    // The NJ deep-house master — warm, spiritual, endless grooves.
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [118, 126],
    l: "kerri chandler",
  },
  {
    n: "tony humphries|basement boys|jovonn|dj spen",
    // The Jersey/Baltimore garage-house axis.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [120, 128],
    l: "jersey house",
  },
  {
    n: "masters at work|little louie vega|louie vega|kenny dope|maw house",
    // The NYC production duo that defined 90s garage house.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [120, 128],
    l: "masters at work",
  },
  {
    n: "todd terry|strictly rhythm~|mark kinchen",
    g: "house",
    s: "funky",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [120, 128],
    l: "todd terry",
  },
  {
    n: "larry levan|paradise garage|david morales|danny tenaglia|francois k|joe claussell",
    // The NY loft/garage DJ lineage — long, ecstatic, vocal-driven sets.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [118, 128],
    l: "ny loft",
  },
  {
    // kavinsky already lives in the synthwave entry above — this block owns
    // the darker French-electro lineage only. "justice" stays qualified (a
    // generic word alone would shadow unrelated prompts).
    n: "gesaffelstein|justice~|sebastian ed banger",
    g: "techno",
    s: "driving",
    m: "dark",
    e: 0.85,
    d: 0.6,
    b: [120, 132],
    l: "darksynth (fr)",
  },
  {
    n: "french house|daft punk~|cassius|stardust|alan braxe|breakbot",
    // The filter-house school — Daft Punk's family. (Bare "daft punk" is
    // deliberately NOT an alias: the robot-duo name alone is a genre word and
    // would shadow every "daft punk" prompt the pop roster may want.)
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [118, 126],
    l: "french filter house",
  },
  {
    n: "bob sinclar|martin solveig|modjo",
    // The 2000s French touch revival.
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [118, 126],
    l: "french touch 2000s",
  },
  {
    // tinlicker / lane 8 / yotto / nora en pure already live in the melodic
    // house entry above — this block owns Marsh only (the qualified spelling
    // keeps the habitat word safe).
    n: "marsh house",
    // Modern melodic/deep-progressive school.
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [118, 124],
    l: "melodic deep",
  },
  {
    n: "harrison bdp|fouk|braxton|djt",
    g: "house",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [120, 128],
    l: "uk deep house",
  },
  {
    n: "jody wisternoff|anja schneider|maya jane coles",
    g: "house",
    s: "minimal",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [120, 126],
    l: "minimal deep",
  },
  {
    n: "robert owens|adeva|barbara tucker",
    // The classic vocal-house voices.
    g: "house",
    s: "soulful",
    m: "energetic",
    e: 0.7,
    d: 0.5,
    b: [118, 126],
    l: "vocal house",
  },
  {
    n: "atjazz|osunlade|quintus",
    g: "house",
    s: "soulful",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [116, 126],
    l: "afro-soul house",
  },
  {
    n: "musa keys|young stunna|de mthuda|sir trill",
    // Amapiano second line (the school's next generation).
    g: "amapiano",
    s: "yanos",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [110, 116],
    l: "amapiano wave 2",
  },
  {
    n: "giorgio moroder|cerrone|disco generic|eurodisco",
    // The pre-house disco/eurodisco foundation.
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [110, 124],
    l: "eurodisco",
  },
  {
    // nile rodgers / chic already have their disco entry above — this block
    // owns the remaining 70s disco/boogie names only.
    n: "sister sledge|kool and the gang|arthur russell",
    // The 70s disco/boogie wellspring house music grew from.
    g: "house",
    s: "disco",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [104, 120],
    l: "disco origin",
  },
  // ── ambient / score depth wave — the roster's thinnest genre (37) ────────
  // Missing entirely: the ambient originators' peers, drone/dark ambient,
  // new age/Japanese environmental, modern composition and the score
  // composers. Styles ride existing ambient.* grooves (drifting / glitch /
  // organic) — no new DSP, and every alias below is collision-checked.
  {
    n: "harold budd|robert fripp|fripp~|larry fast",
    // The Eno collaborators — 4th world / ambient guitar.
    g: "drone",
    s: "minimalism",
    m: "chill",
    e: 0.3,
    d: 0.3,
    b: [55, 80],
    l: "4th world",
  },
  {
    n: "terry riley|la monte young|pauline oliveros",
    // The minimalist avant-garde ancestors (drone/just intonation).
    g: "drone",
    s: "minimalism",
    m: "chill",
    e: 0.3,
    d: 0.25,
    b: [50, 75],
    l: "minimalist avant",
  },
  {
    // "coil" alone is a common word — the alias stays qualified.
    n: "coil~|throbbing gristle|nurse with wound",
    // Industrial's ambient underbelly — musique concrète, tape, dread.
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.4,
    d: 0.45,
    b: [70, 100],
    l: "industrial ambient",
  },
  {
    n: "lustmord|sunn o)))|sunn o|kevin drumsm|deathprod",
    // Dark ambient / drone metal's low-end: monumental, slow, cavernous.
    g: "drone",
    s: "drone",
    m: "dark",
    e: 0.25,
    d: 0.3,
    b: [40, 70],
    l: "dark drone",
  },
  {
    n: "svarte greiner|kammarheit|desiderii margini|raison d'etre|eleh",
    // The isolationist / "death ambient" school.
    g: "drone",
    s: "isolationism",
    m: "dark",
    e: 0.25,
    d: 0.35,
    b: [45, 75],
    l: "isolationist",
  },
  {
    n: "laraaji|constance demby|george winston|windham hill|hiroshi yoshimura",
    // New age / healing: bright, meditative, acoustic-electronic.
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.3,
    d: 0.3,
    b: [55, 85],
    l: "new age",
  },
  {
    n: "midori takada|satoshi ashikawa|yasuaki shimizu|kankyo ongaku",
    // Japanese environmental music — the kankyō ongaku school.
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.3,
    d: 0.35,
    b: [60, 90],
    l: "kankyō ongaku",
  },
  {
    n: "philip glass|steve reich|michael nyman",
    // The minimalists proper — pulsing, repetitive, film-score DNA.
    g: "drone",
    s: "minimalism",
    m: "energetic",
    e: 0.55,
    d: 0.6,
    b: [90, 130],
    l: "minimalist",
  },
  {
    n: "ennio morricone|angelo badalamenti|james horner|john williams|howard shore|alexandre desplat",
    // The orchestral score tradition.
    g: "drone",
    s: "score",
    m: "dark",
    e: 0.4,
    d: 0.45,
    b: [55, 90],
    l: "orchestral score",
  },
  {
    n: "thomas newman|trent reznor|atticus ross|yann tiersen|jozef van wissem",
    // Modern film / television composers (the "prestige drama" palette).
    g: "drone",
    s: "neoclassical",
    m: "dark",
    e: 0.35,
    d: 0.4,
    b: [55, 85],
    l: "modern score",
  },
  {
    n: "lubomyr melnyk|peter broderick|goldmund|dustin ohalloran",
    // Continuous-music piano / post-classical minimalism.
    g: "ambient",
    s: "organic",
    m: "chill",
    e: 0.4,
    d: 0.5,
    b: [60, 100],
    l: "post-classical",
  },
  {
    n: "caterina barbieri|alessandro cortini|sarah davachi|kali malone",
    // Modular/electroacoustic composition — the modern art wing.
    g: "drone",
    s: "electroacoustic",
    m: "chill",
    e: 0.35,
    d: 0.4,
    b: [55, 85],
    l: "electroacoustic",
  },
  {
    n: "kaitlyn aurelia smith|emily a sprague|julianna barwick|ana roxanne|claire rousay",
    // The 2010s ambient revival (voice-as-texture, tape, patience).
    g: "drone",
    s: "drone",
    m: "chill",
    e: 0.3,
    d: 0.35,
    b: [55, 90],
    l: "ambient revival",
  },
  {
    n: "huerco s|lilien rosarian|space afrika",
    g: "ambient",
    s: "glitch",
    m: "chill",
    e: 0.4,
    d: 0.45,
    b: [70, 110],
    l: "ambient club",
  },
  {
    // moore mother / lotic / herndon live in the hyperpop + experimental
    // entries above where relevant — no "arca" here (it has its own entry).
    n: "moor mother|lotic|holly herndon",
    // Experimental club's ambient/industrial edge.
    g: "ambient",
    s: "glitch",
    m: "aggressive",
    e: 0.55,
    d: 0.55,
    b: [70, 120],
    l: "experimental club",
  },
  {
    n: "ryoji ikeda|florian hecker|alva noto~|ben frost",
    // The glitch/ultrasonic school — sine, noise, system.
    g: "ambient",
    s: "glitch",
    m: "dark",
    e: 0.4,
    d: 0.5,
    b: [60, 110],
    l: "glitch school",
  },
  {
    n: "haxan cloak|squarepusher|venetian snares|amon tobin",
    // Drill'n'bass / breakcore's experimental wing (ambient-adjacent).
    g: "ambient",
    s: "glitch",
    m: "aggressive",
    e: 0.75,
    d: 0.7,
    b: [120, 175],
    l: "breakcore experimental",
  },
  {
    n: "global communication|solar fields|purl|segue|brock van wey",
    // Ambient techno / dub ambient (the chill side of the techno axis).
    g: "ambient",
    s: "drifting",
    m: "chill",
    e: 0.35,
    d: 0.4,
    b: [70, 110],
    l: "ambient techno",
  },
  {
    n: "explosions in the sky|mogwai|sigur ros|this will destroy you",
    // Post-rock — the crescendo guitar school (score's loud sibling).
    g: "postrock",
    s: "crescendo",
    m: "energetic",
    e: 0.6,
    d: 0.5,
    b: [70, 120],
    l: "post-rock",
  },
  {
    n: "godspeed you black emperor|godspeed you! black emperor|gybe",
    g: "postrock",
    s: "orchestral",
    m: "dark",
    e: 0.5,
    d: 0.5,
    b: [60, 100],
    l: "post-rock dark",
  },
  // ── UKG depth wave — the genre had 14 entries and none of its history ────
  // Originators (2-step/speed garage), the bassline/niche north, the deep
  // dark side, the UK funky/afroswing bridge and the speed-garage revival.
  // Styles ride ukg.ukg / ukg.bassline / ukg.deep (all first-class grooves).
  {
    n: "so solid crew|so solid|oxide neutrino|groove chronicles|dem 2|tuff jam|grant nelson",
    // The 1998-2001 UKG golden era: pirate-radio 2-step and speed garage.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [128, 136],
    l: "ukg originators",
  },
  {
    n: "todd edwards|armand van helden|187 lockdown|double 99|ripperman|baffled republic",
    // Speed garage — the 4x4 reese-bass wing (Todd Edwards' garage cuts).
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [130, 138],
    l: "speed garage",
  },
  {
    n: "tina moore|spun|kronz|nu birth",
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [130, 138],
    l: "garage vocal",
  },
  {
    n: "ts7|booda|paleface|witney|trc bassline",
    // Bassline / Niche (the Sheffield-Leeds north sound).
    g: "ukg",
    s: "bassline",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [134, 142],
    l: "niche bassline",
  },
  {
    n: "horsepower productions|benny ill|kode9|loefah",
    // The dark 2-step / proto-dubstep corridor (El-B's lineage).
    g: "ukg",
    s: "deep",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [132, 140],
    l: "dark 2-step",
  },
  {
    // "uk funky" is owned by the house.ukfunky entries — this block owns the
    // dubstep-side spelling only.
    n: "crazy cousins|appleblim",
    // UK funky — the 2008 bridge between garage and house.
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [126, 134],
    l: "uk funky",
  },
  {
    // mostack / nsg already have their afroswing entry — this block owns the
    // remaining names only.
    n: "kojo funds|yungen",
    // Afroswing — the afrobeat/UKG hybrid (rides ukg.ukg).
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [100, 110],
    l: "afroswing",
  },
  {
    n: "main phase|badger|ellie ukg|hamdi",
    // Speed-garage revival (the post-2020 4x4 wave).
    g: "ukg",
    s: "ukg",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [132, 140],
    l: "speed garage now",
  },
  {
    n: "mura masa|joy anonymous|bakongo|north base",
    // The indie-adjacent UKG/bass crossover.
    g: "ukg",
    s: "deep",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [126, 136],
    l: "ukg crossover",
  },
  // ── Boom bap school tree (the full lineage, not just the tempo) ─────────
  // Golden: the 90s production architects who DEFINED the pocket (their
  // artist entries above carry the rappers; these carry the sound itself).
  {
    n: "dj premier|premier|gang starr|guru",
    // The scratch-hook, hard-snare temple — Gang Starr's Daily Operation.
    g: "boombap",
    s: "golden",
    m: "dark",
    e: 0.65,
    d: 0.55,
    b: [88, 96],
    l: "dj premier",
  },
  {
    n: "pete rock|cl smooth|pete rock & cl smooth",
    // The horn-loop warmth — Mecca and the Soul Brother.
    g: "boombap",
    s: "golden",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [88, 98],
    l: "pete rock",
  },
  {
    n: "large professor|main source|breaking atoms",
    g: "boombap",
    s: "golden",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [86, 96],
    l: "large professor",
  },
  {
    n: "marley marl|juice crew|biz markie",
    // The 80s bridge into the golden era — drum-machine + breakbeat.
    g: "boombap",
    s: "golden",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [95, 108],
    l: "marley marl",
  },
  {
    n: "erik b|erik sermon|epmd|hit squad",
    // The funk-loop punch that made the pocket harder.
    g: "boombap",
    s: "golden",
    m: "aggressive",
    e: 0.7,
    d: 0.55,
    b: [90, 100],
    l: "epmd",
  },
  // Jazz rap: the refinement school.
  {
    n: "a tribe called quest|tribe called quest|q-tip|q tip|atcq",
    // The jazz-rap blueprint — Low End Theory's upright-bass float.
    g: "boombap",
    s: "jazz",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [88, 100],
    l: "a tribe called quest",
  },
  {
    n: "de la soul|native tongues|3 feet high",
    g: "boombap",
    s: "jazz",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [90, 104],
    l: "de la soul",
  },
  {
    n: "digable planets|souls of mischief|hieroglyphics|del the funky",
    // The west-coast jazz-rap corner (93 'til Infinity).
    g: "boombap",
    s: "jazz",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [88, 98],
    l: "jazz rap west",
  },
  {
    n: "the pharcyde|pharcyde|bizarre ride",
    g: "boombap",
    s: "jazz",
    m: "energetic",
    e: 0.65,
    d: 0.55,
    b: [90, 100],
    l: "the pharcyde",
  },
  // Lo-fi / Dilla: the off-kilter school.
  {
    n: "j dilla|j-dilla|dilla|jay dee|slum village|donuts",
    // THE off-kilter pocket — the late kick is the signature.
    g: "boombap",
    s: "lofi",
    m: "chill",
    e: 0.5,
    d: 0.45,
    b: [78, 92],
    l: "j dilla",
  },
  {
    n: "madlib|quasimoto|madvillainy|freddie gibbs",
    // The dusty-crate maximalist — Madvillainy / Piñata.
    g: "boombap",
    s: "lofi",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [80, 95],
    l: "madlib",
  },
  {
    n: "knxwledge|mndsgn|ohbliv|dibia$e|devonwho",
    // The LA beat-scene lo-fi generation.
    g: "boombap",
    s: "lofi",
    m: "chill",
    e: 0.45,
    d: 0.45,
    b: [78, 92],
    l: "knxwledge",
  },
  {
    n: "fat jon|substantial|five deez",
    // The jazz-sample lo-fi lane (the Modal Soul side players).
    g: "boombap",
    s: "lofi",
    m: "chill",
    e: 0.45,
    d: 0.45,
    b: [75, 92],
    l: "jazz-sample lofi",
  },
  // Drumless: the Alchemist school.
  {
    n: "the alchemist|alchemist|alc|alfredo",
    // The drumless loop master — the sample IS the rhythm.
    g: "boombap",
    s: "drumless",
    m: "dark",
    e: 0.45,
    d: 0.4,
    b: [78, 92],
    l: "the alchemist",
  },
  {
    n: "billy woods|armand hammer|elucid|backwoodz",
    // The abstract drumless art-rap corner.
    g: "boombap",
    s: "drumless",
    m: "dark",
    e: 0.45,
    d: 0.4,
    b: [72, 88],
    l: "billy woods",
  },
  {
    n: "mach-hommy|mach hommy|gunnlib|pray for haiti",
    // The drumless/lo-fi luxury-rap edge.
    g: "boombap",
    s: "drumless",
    m: "dark",
    e: 0.5,
    d: 0.4,
    b: [76, 90],
    l: "mach-hommy",
  },
  // Modern: the Griselda-era production room.
  {
    n: "conductor williams|craven",
    // The modern Griselda in-house sound — dusty but tight.
    g: "boombap",
    s: "modern",
    m: "dark",
    e: 0.6,
    d: 0.5,
    b: [82, 94],
    l: "conductor williams",
  },
  {
    n: "boldy james|rome streetz|stove god cooks|flee lord|elcamino|sadhugold",
    // The Griselda roster depth beyond Gunn/Conway/Benny.
    g: "boombap",
    s: "modern",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [82, 94],
    l: "griselda depth",
  },
  {
    n: "marcberg|ka type beat 2|navy blue 2",
    // The drumless-adjacent modern lyricist pocket.
    g: "boombap",
    s: "modern",
    m: "dark",
    e: 0.5,
    d: 0.45,
    b: [80, 92],
    l: "marcberg",
  },
  // Trapbap: the modern hybrid.
  {
    n: "jpegmafia type|injury reserve|clipping 2|danny brown",
    // The modern experimental-rap hybrid — boom-bap samples + trap weight.
    g: "boombap",
    s: "trapbap",
    m: "aggressive",
    e: 0.8,
    d: 0.6,
    b: [120, 145],
    l: "trapbap hybrid",
  },
  // ── user request wave (2026-09-26) — the remaining named artists ─────────
  {
    n: "latin mafia|latin mafia~",
    // The Monterrey bedroom-pop/bass trio — bright, romantic, latin rhythm.
    g: "house",
    s: "pop",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [95, 115],
    l: "latin mafia",
  },
  {
    n: "pluko|pluko~",
    // Future-bass / chill-trap producer (Foreign Family) - warm supersaws.
    g: "trap",
    s: "bouncy",
    m: "chill",
    e: 0.6,
    d: 0.55,
    b: [130, 150],
    l: "pluko",
  },
  // ── Amapiano school tree (the Wikipedia-documented sub-genres) ──────────
  // Yanos is the core (already carried by the entries above); these entries
  // cover the schools those generic entries would flatten.
  {
    n: "felo le tee|myztro|mas musiq|vigro deep|dj stokie|sam deep",
    // The yanos hitmakers — the log-drum chart sound.
    g: "amapiano",
    s: "yanos",
    m: "energetic",
    e: 0.7,
    d: 0.55,
    b: [110, 116],
    l: "yanos hitmakers",
  },
  {
    n: "focalistic 2|busta 929|njelic|danko",
    // The vocal-forward yanos side (piano-rap delivery).
    g: "amapiano",
    s: "yanos",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [110, 116],
    l: "yanos vocal",
  },
  {
    n: "sino msolo|boohle|nkosazana daughter|kamo mphela",
    // The soulful vocal school (Kelvin Momo's orbit).
    g: "amapiano",
    s: "soulful",
    m: "chill",
    e: 0.55,
    d: 0.5,
    b: [108, 114],
    l: "soulful vocal",
  },
  {
    n: "s'gija|sgija|mdu s'gija",
    // The stripped S'gija school — fewer elements, harder kick.
    g: "amapiano",
    s: "sgija",
    m: "energetic",
    e: 0.75,
    d: 0.5,
    b: [112, 118],
    l: "sgija",
  },
  {
    n: "mellow & sleazy|mellow and sleazy|trust fund",
    // New-age bacardi — the slowed Pretoria mutation (with Kabza + Focalistic).
    g: "amapiano",
    s: "bacardi",
    m: "aggressive",
    e: 0.8,
    d: 0.55,
    b: [108, 114],
    l: "new age bacardi",
  },
  {
    n: "realshaunmusiq|sizwe nineteen|nandipha808",
    // Quantum Sound — the gqom-2.0 re-edit school.
    g: "amapiano",
    s: "quantum",
    m: "aggressive",
    e: 0.85,
    d: 0.6,
    b: [112, 120],
    l: "quantum sound",
  },
  {
    n: "tyla|popiano",
    // Popiano — the pop-facing variant (Water).
    g: "amapiano",
    s: "popiano",
    m: "chill",
    e: 0.65,
    d: 0.5,
    b: [108, 116],
    l: "popiano",
  },
  {
    n: "kooldrink",
    // The popiano → gqom bridge (Overdue) - DJ Lag keeps his gqom entry above.
    g: "amapiano",
    s: "popiano",
    m: "energetic",
    e: 0.75,
    d: 0.55,
    b: [110, 118],
    l: "popiano bridge",
  },
  // ── Trance school tree (the Wikipedia-documented sub-genres) ────────────
  // Uplifting is the anthem school (already carried by the trance / paul van
  // dyk entries above); these cover the rest of the tree.
  {
    n: "ferry corsten|gareth emery|aly & fila|aly and fila",
    // The uplifting hitmakers — supersaw, breakdown, big anthem.
    g: "trance",
    s: "uplifting",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [136, 142],
    l: "uplifting hitmakers",
  },
  {
    n: "nick warren|hernan cattaneo",
    // The progressive end — deep, patient, long-phrase.
    g: "trance",
    s: "progressive",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [126, 134],
    l: "progressive trance",
  },
  {
    n: "robert miles|children trance|dream trance",
    // The Robert Miles school — soft kick, piano-led euphoria.
    g: "trance",
    s: "dream",
    m: "chill",
    e: 0.6,
    d: 0.5,
    b: [128, 136],
    l: "dream trance",
  },
  {
    n: "simon patterson|john askew|sean tyas|will atkinson",
    // The tech-trance / hard-trance school — warehouse crossover.
    g: "trance",
    s: "tech",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [136, 144],
    l: "tech trance",
  },
  {
    n: "kaskade trance|kai tracid|cosmic baby|art of trance",
    // The acid-trance / early-90s school — 303 lead lines.
    g: "trance",
    s: "acid",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [132, 142],
    l: "acid trance",
  },
  {
    n: "psy producers",
    // The psy / Goa lineage - full-on rolling bass (moved off the old entry).
    g: "trance",
    s: "psy",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [138, 148],
    l: "psytrance producers",
  },
  // ── Detroit school tree (the machine-funk lineage, Wikipedia-documented) ─
  {
    n: "k-hand",
    // The Belleville-era first wave beyond the Three (Metroplex / Music
    // Institute roster) - the dancefloor originators.
    g: "detroit",
    s: "belleville",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [122, 132],
    l: "belleville era",
  },
  {
    n: "underground resistance|mike banks|galaxy 2 galaxy",
    // UR - the militant second wave (Predator / Riot).
    g: "detroit",
    s: "secondwave",
    m: "aggressive",
    e: 0.9,
    d: 0.65,
    b: [130, 140],
    l: "underground resistance",
  },
  {
    n: "detroit booty",
    // The ghettotech school - Detroit booty bass at speed.
    g: "detroit",
    s: "ghettotech",
    m: "aggressive",
    e: 0.9,
    d: 0.7,
    b: [140, 150],
    l: "ghettotech extra",
  },
  {
    n: "dopplereffekt side|drexciya research",
    // The electro-science side - vocoder, machine mystique.
    g: "detroit",
    s: "electro",
    m: "dark",
    e: 0.7,
    d: 0.55,
    b: [118, 132],
    l: "electro science",
  },
  {
    n: "plasticman|plus 8",
    // The +8 school - minimal progressive hardcore (Vortex).
    g: "detroit",
    s: "minimal",
    m: "dark",
    e: 0.75,
    d: 0.55,
    b: [125, 134],
    l: "plus 8",
  },
  {
    n: "kenny larkin|claude young",
    // The second-wave depth - deeper, jazzier machine soul.
    g: "detroit",
    s: "belleville",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [122, 132],
    l: "detroit machine soul",
  },
  // ── Post-rock school tree (Wikipedia-documented waves and scenes) ──────
  {
    n: "slint|talk talk|bark psychosis|tortoise|stereolab",
    // The first wave (Louisville / Bristol / Chicago): texture over melody,
    // irregular tempos, mood over groove, 70-90 BPM.
    g: "postrock",
    s: "textured",
    m: "dark",
    e: 0.55,
    d: 0.5,
    b: [70, 90],
    l: "post-rock first wave",
  },
  {
    n: "mono band|65daysofstatic|balmorhea",
    // The second-wave cinematic build (Montreal/Edinburgh): the dramatic
    // crescendo from quiet to wall of sound, 80-110 BPM.
    g: "postrock",
    s: "crescendo",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [80, 110],
    l: "post-rock crescendo",
  },
  {
    n: "do make say think|fly pan am|set fire to flames",
    // The Montreal orchestral chamber side (Constellation Records).
    g: "postrock",
    s: "orchestral",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [60, 90],
    l: "post-rock orchestral",
  },
  {
    n: "cult of luna|isis band|russian circles|pelican|palms",
    // The heavy fusion: slow doom riffs + wall of sound, 60-90 BPM.
    g: "postrock",
    s: "postmetal",
    m: "aggressive",
    e: 0.8,
    d: 0.55,
    b: [60, 90],
    l: "post-metal",
  },
  {
    n: "don caballero|battles|hella|toe",
    // The math-rock angularity (Slint lineage): displaced kicks, irregular
    // meters, 90-120 BPM.
    g: "postrock",
    s: "math",
    m: "aggressive",
    e: 0.75,
    d: 0.65,
    b: [90, 120],
    l: "post-rock math",
  },
  {
    n: "labradford|windy and carl|bowery electric|cul de sac",
    // The spacey side (Kranky label): droning, sparse, 60-85 BPM.
    g: "postrock",
    s: "ambient",
    m: "chill",
    e: 0.4,
    d: 0.35,
    b: [60, 85],
    l: "post-rock ambient",
  },
  // ── Chiptune (the sound-chip tradition) ──────────────────────────────────
  {
    n: "koji kondo|nobuo uematsu|yuzo koshiro|grant kirkhope|david wise",
    // The NES/SNES era composers — the action-platformer march.
    g: "chiptune",
    s: "nintendo",
    m: "energetic",
    e: 0.75,
    d: 0.6,
    b: [110, 150],
    l: "nintendo era",
  },
  {
    n: "chipzel|4mat|jeroen tel|rob hubbard|tim follin|sabrepulse",
    // The LSDj / Game Boy scene and the C64 composers — clipped pulses,
    // breakbeat-leaning noise drums.
    g: "chiptune",
    s: "gameboy",
    m: "energetic",
    e: 0.85,
    d: 0.7,
    b: [120, 160],
    l: "game boy scene",
  },
  {
    n: "anamanaguchi|dan terminus|disasterpeace|lena raine|c418",
    // The modern chip band / indie game composers — live-ish drums under
    // NES leads.
    g: "chiptune",
    s: "chipband",
    m: "energetic",
    e: 0.8,
    d: 0.65,
    b: [140, 180],
    l: "modern chip",
  },
  {
    n: "boss battle|final boss theme|vgm metal",
    // The boss-battle corner: driving double-kick feel, aggressive noise.
    g: "chiptune",
    s: "boss",
    m: "aggressive",
    e: 0.95,
    d: 0.8,
    b: [150, 185],
    l: "chiptune boss",
  },
  {
    n: "town theme|overworld theme|ending theme|save room",
    // The ballad pocket — the arpeggio IS the arrangement.
    g: "chiptune",
    s: "ballad",
    m: "chill",
    e: 0.25,
    d: 0.25,
    b: [70, 100],
    l: "chip ballad",
  },
  {
    n: "fasttracker|impulse tracker|demoscene chip",
    // The demoscene tracker lineage: dense arpeggio churn over a pulse.
    g: "chiptune",
    s: "tracker",
    m: "energetic",
    e: 0.8,
    d: 0.75,
    b: [130, 170],
    l: "tracker",
  },
  // ── Eurodance (the 90s Euro-NRG tradition) ───────────────────────────────
  {
    n: "snap!|2 unlimited|corona|la bouche|culture beat|real mccoy|hadaway",
    // The classic Euro-NRG core — four-floor under the offbeat open hat.
    g: "eurodance",
    s: "nrg",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [128, 140],
    l: "euro classic",
  },
  {
    n: "vengaboys|sash!|alice deejay|cascada|dj sammy|groove coverage",
    // The happy / euphoric end — supersaw lift, big emotional chorus.
    g: "eurodance",
    s: "happy",
    m: "energetic",
    e: 0.95,
    d: 0.75,
    b: [138, 150],
    l: "happy eurodance",
  },
  {
    n: "scooter|dj bobo|brooklyn bounce|masterboy|cappella",
    // The german hands-up scene — harder kick, pitched-up vocal chops.
    g: "eurodance",
    s: "handsup",
    m: "aggressive",
    e: 0.95,
    d: 0.8,
    b: [140, 155],
    l: "hands up",
  },
  {
    n: "atb|gigi dagostino|molella|prezioso|robert miles",
    // The euro-trance crossover — the melody IS the genre.
    g: "eurodance",
    s: "trancecore",
    m: "energetic",
    e: 0.85,
    d: 0.65,
    b: [135, 148],
    l: "trancecore",
  },
  {
    n: "eiffel 65|bliss team|kim lucas|prezioso italo",
    // The Italo-dance lineage — autotune hooks, warm bass.
    g: "eurodance",
    s: "italo",
    m: "energetic",
    e: 0.8,
    d: 0.6,
    b: [125, 138],
    l: "italo dance",
  },
  {
    n: "hands up revival|festival hands|modern hands up",
    // The modern festival revival — big build-drop, hardstyle-leaning kick.
    g: "eurodance",
    s: "hands",
    m: "aggressive",
    e: 0.98,
    d: 0.82,
    b: [150, 160],
    l: "hands",
  },
  // ── Latin (the Afro-Caribbean + South American tradition) ────────────────
  {
    n: "los angeles azules|la sonora dinamita|el gran combo|kumbia kings|celso pina",
    // The Colombian + Mexican cumbia / sonidera lane — guiro answers the kick.
    g: "latin",
    s: "cumbia",
    m: "energetic",
    e: 0.7,
    d: 0.6,
    b: [85, 105],
    l: "cumbia",
  },
  {
    n: "juan luis guerra|wilfrido vargas|elvis crespo|grupo mania|los hermanos rosario",
    // The Dominican merengue — tambora march under the sax hook.
    g: "latin",
    s: "merengue",
    m: "energetic",
    e: 0.9,
    d: 0.7,
    b: [120, 160],
    l: "merengue",
  },
  {
    n: "romeo santos|avenura|prince royce|grupo extra|monchy and alexandra",
    // The Dominican bachata — bongo-led romance, the derecho pattern.
    g: "latin",
    s: "bachata",
    m: "chill",
    e: 0.65,
    d: 0.55,
    b: [120, 140],
    l: "bachata",
  },
  {
    n: "celia cruz|hector lavoe|marc anthony|grupo niche|ruben blades|willie colon",
    // The salsa dura / NY son — the 3-2 clave on the rim over the tumbao.
    g: "latin",
    s: "salsa",
    m: "energetic",
    e: 0.9,
    d: 0.75,
    b: [160, 200],
    l: "salsa",
  },
  {
    n: "tito puente|perez prado|machito|poncho sanchez",
    // The big-band mambo — cowbell on the offbeat, mambo bell.
    g: "latin",
    s: "mambo",
    m: "energetic",
    e: 0.95,
    d: 0.8,
    b: [170, 210],
    l: "mambo",
  },
  {
    n: "joao gilberto|stan getz|sergio mendes|antonio carlos jobim|astrud gilberto",
    // The Brazilian bossa nova — the two-bar rim pattern, brushed, cool.
    g: "latin",
    s: "bossa",
    m: "chill",
    e: 0.35,
    d: 0.35,
    b: [120, 140],
    l: "bossa nova",
  },
  // ── Drone / neo-classical school tree (Wikipedia-documented) ────────────
  {
    n: "pierre henry|eliane radigue|hafler trio",
    // Musique concrete → the electroacoustic school: the patch IS the piece.
    g: "drone",
    s: "electroacoustic",
    m: "chill",
    e: 0.3,
    d: 0.4,
    b: [55, 95],
    l: "musique concrete",
  },
  {
    n: "john cage|gavin bryars",
    // The minimalism school proper: conceptual, pulsing, patient.
    g: "drone",
    s: "minimalism",
    m: "chill",
    e: 0.3,
    d: 0.45,
    b: [85, 130],
    l: "minimalism proper",
  },
  {
    n: "alexander desplat|jonny greenwood|dario marianelli",
    // The film-score school: the cue structure drives the arrangement.
    g: "drone",
    s: "score",
    m: "chill",
    e: 0.5,
    d: 0.5,
    b: [55, 95],
    l: "film score composers",
  },
  {
    n: "zo keating|hildur guonadottir",
    // Solo-instrument loop school: the cellist's layering (neoclassical).
    g: "drone",
    s: "neoclassical",
    m: "chill",
    e: 0.35,
    d: 0.4,
    b: [55, 90],
    l: "solo-instrument loops",
  },
]);

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
