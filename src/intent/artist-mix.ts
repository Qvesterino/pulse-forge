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
  /** Stereo width producer-decision (deep-profile layer; consumer follow-up). */
  width?: "wide" | "narrow";
  /** Sub emphasis producer-decision (deep-profile layer; consumer follow-up). */
  sub?: "prominent" | "subtle";
  /**
   * Artist's mastered integrated loudness in LUFS (Phase 2 slice 3) — e.g. -7
   * for a modern loud-master, -13 for a character-over-loudness release.
   * Emitted as a SIGNAL, not a direct target: planMixProfile derives the
   * actual master.lufsTarget as a bounded offset from
   * SONG_LOUDNESS_TARGET_LUFS, so an artist can lift loudness by at most
   * SONG_LOUDNESS_TRIM_LIMIT_DB — the same guard the song builder already
   * honors (song.ts). An artist quieter than the streaming target therefore
   * leaves the project default alone. Maps from deep profile
   * master.targetLufs.
   */
  lufs?: number;
  /**
   * Master buss-glue producer-decision (Phase 2 slice 3). true engages the
   * SSL-style 2:1 glue (loud-master / heavily-limited artists), false
   * bypasses it (character-over-loudness artists), absent leaves the
   * project's own glueEnabled setting untouched. Maps from deep profile
   * master.dynamicRange: "low" / "limited" -> true, "wide" -> false,
   * "moderate" -> absent.
   */
  glue?: boolean;
}

export const ARTIST_MIX_PROFILES: Readonly<Record<string, ArtistMixProfile>> = {
  drake: { tone: "dark", reverb: "more" },
  "kendrick lamar": { tone: "warm", punch: "more" },
  "dr. dre": { tone: "warm", punch: "more" },
  "snoop dogg": { tone: "warm", reverb: "more" },
  "warren g & nate dogg": { tone: "warm", reverb: "more" },
  "ty dolla $ign": { tone: "warm" },
  "travis scott": { tone: "dark", punch: "more", reverb: "huge" },
  "rage (carti)": { tone: "dark", punch: "more", reverb: "less" },
  "opium rage": { tone: "dark", punch: "more", reverb: "less" },
  "new rage": { tone: "dark", punch: "more", reverb: "less" },
  "yung lean / drain gang": { tone: "cold", reverb: "huge" },
  "a$ap rocky": { tone: "dark", reverb: "more" },
  "dj screw / chopped and screwed": { tone: "warm", reverb: "huge" },
  "juice wrld": { tone: "dark", reverb: "more" },
  "lil peep": { tone: "cold", reverb: "more" },
  "a boogie": { tone: "dark", reverb: "more" },
  "rod wave": { tone: "warm", reverb: "more" },
  xxxtentacion: { tone: "dark", punch: "more", reverb: "less" },
  "kid cudi": { tone: "dark", reverb: "more" },
  "metro boomin": { tone: "dark", punch: "more" },
  "21 savage": { tone: "dark", reverb: "less" },
  yeat: { tone: "bright", punch: "more" },
  "hyper-rage": { tone: "dark", punch: "more", reverb: "less" },
  future: { tone: "dark" },
  "gunna / lil baby": { tone: "warm" },
  "young thug": { tone: "bright", reverb: "more" },
  "don toliver": { tone: "dark", reverb: "more" },
  "lil uzi": { tone: "bright", punch: "more" },
  "trippie redd": { tone: "dark", reverb: "more" },
  "pi'erre bourne": { tone: "bright" },
  zaytoven: { tone: "dark", punch: "more" },
  "tay keith": { tone: "dark", punch: "more", reverb: "less" },
  "lex luger": { tone: "dark", punch: "more", reverb: "less" },
  "chief keef": { tone: "dark", punch: "more", reverb: "less" },
  "tyler, the creator": { tone: "warm" },
  "mac miller": { tone: "warm" },
  jpegmafia: { tone: "dark", punch: "more" },
  "denzel curry": { tone: "dark", punch: "more" },
  "megan thee stallion": { tone: "bright", punch: "more" },
  "lil jon / crunk": { tone: "dark", punch: "more", reverb: "less" },
  "mf doom": { tone: "warm", reverb: "less" },
  drill: { tone: "dark", punch: "more", reverb: "less" },
  "headie one": { tone: "dark", punch: "more", reverb: "less" },
  "digga d": { tone: "dark", punch: "more", reverb: "less" },
  "kay flock": { tone: "dark", punch: "more", reverb: "less" },
  "unknown t": { tone: "dark", punch: "more", reverb: "less" },
  "22gz": { tone: "dark", punch: "more", reverb: "less" },
  "fivio foreign": { tone: "bright", punch: "more", reverb: "less" },
  ofb: { tone: "dark", punch: "more", reverb: "less" },
  loski: { tone: "dark", punch: "more", reverb: "less" },
  digdat: { tone: "dark", punch: "more", reverb: "less" },
  "808melo": { tone: "dark", punch: "more", reverb: "less" },
  "axl beats": { tone: "dark", punch: "more", reverb: "less" },
  ghosty: { tone: "dark", punch: "more", reverb: "less" },
  "king von": { tone: "dark", punch: "more", reverb: "less" },
  "g herbo": { tone: "dark", punch: "more", reverb: "less" },
  "lil durk": { tone: "dark", punch: "more" },
  "nba youngboy": { tone: "dark", punch: "more", reverb: "less" },
  "polo g": { tone: "dark", reverb: "more" },
  dave: { tone: "warm" },
  stormzy: { tone: "dark", punch: "more" },
  "wiley / jme": { tone: "cold", punch: "more", reverb: "less" },
  "skepta / grime": { tone: "cold", punch: "more", reverb: "less" },
  griselda: { tone: "dark", reverb: "less" },
  "memphis phonk": { tone: "dark", punch: "more", reverb: "less" },
  "drift phonk": { tone: "dark", punch: "more", reverb: "less" },
  "drift phonk (tiktok)": { tone: "dark", punch: "more", reverb: "less" },
  "aggressive drift": { tone: "dark", punch: "more", reverb: "less" },
  "phonk bounce": { tone: "dark", punch: "more" },
  "phonk horror": { tone: "dark", punch: "more", reverb: "huge" },
  suicideboys: { tone: "dark", punch: "more", reverb: "less" },
  "three 6 mafia": { tone: "dark", punch: "more", reverb: "less" },
  "dj squeeky": { tone: "dark", punch: "more", reverb: "less" },
  "dj spanish fly": { tone: "dark", punch: "more", reverb: "less" },
  "kingpin skinny pimp": { tone: "dark", punch: "more" },
  "playa fly": { tone: "dark" },
  "tommy wright iii": { tone: "dark", punch: "more", reverb: "less" },
  "xavier wulf": { tone: "dark", reverb: "more" },
  bones: { tone: "dark", reverb: "more" },
  "night lovell": { tone: "dark", reverb: "huge" },
  "cloud rap": { tone: "cold", reverb: "huge" },
  "veeze / detroit": { tone: "warm", punch: "more" },
  babytron: { tone: "dark", punch: "more" },
  "detroit now": { tone: "warm", punch: "more" },
  drakeo: { tone: "dark", reverb: "less" },
  blxst: { tone: "warm", reverb: "more" },
  "b-lovee": { tone: "dark", punch: "more", reverb: "less" },
  "e-40 / hyphy": { tone: "warm", punch: "more" },
  "mac dre": { tone: "warm" },
  "2pac": { tone: "warm", punch: "more" },
  biggie: { tone: "dark" },
  "wu-tang": { tone: "dark", reverb: "less" },
  "jay-z": { tone: "warm", punch: "more" },
  "mobb deep": { tone: "dark", reverb: "less" },
  outkast: { tone: "warm", punch: "more" },
  ugk: { tone: "warm" },
  "scarface / geto boys": { tone: "dark" },
  "t.i.": { tone: "dark", punch: "more" },
  jeezy: { tone: "dark", punch: "more" },
  "gucci mane": { tone: "dark", punch: "more" },
  "mannie fresh": { tone: "bright", punch: "more" },
  eminem: { tone: "dark", punch: "more", reverb: "less" },
  "50 cent": { tone: "dark", reverb: "less" },
  "lil wayne": { tone: "dark" },
  "rick ross": { tone: "dark", reverb: "more" },
  dmx: { tone: "dark", punch: "more", reverb: "less" },
  "busta rhymes": { tone: "dark", punch: "more" },
  "missy / timbaland": { tone: "dark", punch: "more" },
  "too $hort": { tone: "warm" },
  "dj quik": { tone: "warm" },
  kurupt: { tone: "warm", punch: "more" },
  "yg / mustard": { tone: "dark", punch: "more", reverb: "less" },
  "nipsey hussle": { tone: "warm", reverb: "more" },
  blueface: { tone: "dark", punch: "more", reverb: "less" },
  "old school / electro": { tone: "warm", reverb: "less" },
  jersey: { tone: "bright", punch: "more", reverb: "less" },
  "jersey club": { tone: "bright", punch: "more", reverb: "less" },
  uniiqu3: { tone: "bright", punch: "more", reverb: "less" },
  "dj tameil": { tone: "bright", punch: "more", reverb: "less" },
  "dj sliink": { tone: "bright", punch: "more", reverb: "less" },
  mcvertt: { tone: "bright", punch: "more", reverb: "less" },
  "dj jayhood": { tone: "bright", punch: "more", reverb: "less" },
  nadus: { tone: "bright", punch: "more", reverb: "less" },
  r3ll: { tone: "bright", punch: "more", reverb: "less" },
  "2rare": { tone: "bright", punch: "more" },
  "cash cobain": { tone: "bright", punch: "more" },
  "nola bounce": { tone: "bright", punch: "more", reverb: "less" },
  "2 live crew": { tone: "bright", punch: "more", reverb: "less" },
  "soulja boy": { tone: "bright", punch: "more", reverb: "less" },
  "snap era": { tone: "bright", reverb: "less" },
  "footwork / juke": { tone: "bright", punch: "more", reverb: "less" },
  "baile funk": { tone: "bright", punch: "more", reverb: "less" },
  "bad bunny": { tone: "bright", punch: "more", pump: true },
  "myke towers": { tone: "bright", punch: "more", pump: true },
  duki: { tone: "bright", punch: "more", reverb: "less" },
  pnl: { tone: "dark", reverb: "huge" },
  dancehall: { tone: "warm", punch: "more", pump: true },
  afrobeats: { tone: "warm", reverb: "less", pump: true },
  "fred again (ukg)": { tone: "bright", reverb: "more", pump: true },
  "fred again": { tone: "warm", reverb: "more", pump: true },
  sophie: { tone: "bright", punch: "more", reverb: "less" },
  hyperpop: { tone: "bright", punch: "more", reverb: "less" },
  "hyperpop wave": { tone: "bright", punch: "more", reverb: "less" },
  anyma: { tone: "dark", reverb: "huge", pump: true },
  "tale of us": { tone: "dark", reverb: "huge", pump: true },
  artbat: { tone: "dark", reverb: "huge", pump: true },
  camelphat: { tone: "dark", reverb: "more", pump: true },
  "seven lions": { tone: "bright", punch: "more", reverb: "huge" },
  excision: { tone: "dark", punch: "more", reverb: "less" },
  illenium: { tone: "bright", reverb: "huge" },
  subtronics: { tone: "dark", punch: "more", reverb: "less" },
  skrillex: { tone: "bright", punch: "more", reverb: "less", pump: true },
  "black coffee": { tone: "warm", reverb: "more", pump: true },
  pinkpantheress: { tone: "bright", punch: "more" },
  "burial / future garage": { tone: "dark", reverb: "huge" },
  "duskus (future garage)": { tone: "cold", reverb: "huge" },
  overmono: { tone: "dark", punch: "more", reverb: "less", pump: true },
  flume: { tone: "bright", reverb: "huge" },
  "tech house": { tone: "bright", punch: "more", reverb: "less", pump: true },
  "peak-time techno": { tone: "dark", punch: "more", reverb: "less", pump: true },
  "berlin techno": { tone: "dark", reverb: "less", pump: true },
  "hard techno": { tone: "dark", punch: "more", reverb: "less", pump: true },
  "high-tech minimal": { tone: "dark", reverb: "less", pump: true },
  "industrial techno": { tone: "dark", punch: "more", reverb: "less", pump: true },
  trance: { tone: "bright", punch: "more", reverb: "huge", pump: true },
  "big room": { tone: "bright", punch: "more", pump: true },
  hardstyle: { tone: "dark", punch: "more", reverb: "less", pump: true },
  psytrance: { tone: "bright", punch: "more", pump: true },
  "afro house": { tone: "warm", reverb: "more", pump: true },
  amapiano: { tone: "warm", reverb: "less" },
  ukg: { tone: "bright", punch: "more", pump: true },
  "melodic house": { tone: "warm", reverb: "huge", pump: true },
  "bass house": { tone: "dark", punch: "more", reverb: "less", pump: true },
  "g-house": { tone: "dark", punch: "more", reverb: "less", pump: true },
  "future bass": { tone: "bright", reverb: "huge", pump: true },
  "four tet": { tone: "warm", reverb: "more" },
  bicep: { tone: "warm", reverb: "huge", pump: true },
  "jamie xx": { tone: "bright", reverb: "more", pump: true },
  "ben bohmer": { tone: "warm", reverb: "huge", pump: true },
  "dj seinfeld": { tone: "warm", reverb: "more", pump: true },
  "ross from friends": { tone: "warm", reverb: "more" },
  "mall grab": { tone: "bright", punch: "more", reverb: "less", pump: true },
  conducta: { tone: "bright", punch: "more", pump: true },
  "interplanetary criminal": { tone: "bright", punch: "more", pump: true },
  "sammy virji": { tone: "bright", punch: "more", reverb: "less", pump: true },
  piri: { tone: "bright", reverb: "more", pump: true },
  vaporwave: { tone: "warm", reverb: "huge" },
  synthwave: { tone: "cold", reverb: "more", pump: true },
  "city pop": { tone: "bright", reverb: "more" },
  "88rising": { tone: "bright", reverb: "more" },
  "k-pop": { tone: "bright", punch: "more", reverb: "less", pump: true },
  "corridos tumbados": { tone: "warm" },
  dnb: { tone: "dark", punch: "more", reverb: "less" },
  "dancefloor dnb": { tone: "bright", punch: "more" },
  "jump up": { tone: "dark", punch: "more", reverb: "less" },
  "macky gee": { tone: "bright", punch: "more", reverb: "less" },
  bou: { tone: "dark", punch: "more", reverb: "less" },
  "1991": { tone: "bright", reverb: "huge" },
  "chase & status": { tone: "bright", punch: "more" },
  calibre: { tone: "warm", reverb: "huge" },
  netsky: { tone: "bright", reverb: "huge" },
  "hybrid minds": { tone: "bright", reverb: "huge" },
  "high contrast": { tone: "bright", reverb: "huge" },
  "ltj bukem": { tone: "warm", reverb: "huge" },
  "dj marky": { tone: "bright", punch: "more" },
  turno: { tone: "dark", punch: "more", reverb: "less" },
  kanine: { tone: "dark", punch: "more", reverb: "less" },
  upgrade: { tone: "dark", punch: "more", reverb: "less" },
  "a.m.c": { tone: "dark", punch: "more", reverb: "less" },
  "serum (dnb)": { tone: "dark", punch: "more", reverb: "less" },
  "andy c": { tone: "bright", punch: "more" },
  dimension: { tone: "bright", reverb: "huge" },
  "culture shock": { tone: "bright", reverb: "huge" },
  metrik: { tone: "bright", reverb: "huge" },
  grafix: { tone: "bright", punch: "more" },
  noisia: { tone: "dark", punch: "more", reverb: "less" },
  "black sun empire": { tone: "dark", punch: "more", reverb: "less" },
  phace: { tone: "dark", punch: "more", reverb: "less" },
  misanthrop: { tone: "dark", punch: "more", reverb: "less" },
  "ed rush & optical": { tone: "dark", punch: "more", reverb: "less" },
  "dom & roland": { tone: "dark", punch: "more", reverb: "less" },
  "break (dnb)": { tone: "dark", punch: "more", reverb: "less" },
  skeptical: { tone: "dark", reverb: "less" },
  "alix perez": { tone: "dark" },
  dillinja: { tone: "dark", punch: "more", reverb: "less" },
  "congo natty": { tone: "dark", punch: "more", reverb: "less" },
  "shy fx": { tone: "bright", punch: "more" },
  "general levy": { tone: "bright", punch: "more" },
  "roni size": { tone: "bright", punch: "more" },
  moondeity: { tone: "dark", punch: "more", reverb: "less" },
  dvrst: { tone: "bright", punch: "more", reverb: "less" },
  interworld: { tone: "dark", punch: "more", reverb: "less" },
  dxrk: { tone: "dark", punch: "more", reverb: "less" },
  "ambient pioneer": { tone: "warm", reverb: "huge" },
  "aphex twin": { tone: "cold", reverb: "huge" },
  "nostalgic ambient": { tone: "warm", reverb: "huge" },
  "stars of the lid": { tone: "warm", reverb: "huge" },
  "tim hecker": { tone: "cold", reverb: "huge" },
  basinski: { tone: "warm", reverb: "huge" },
  grouper: { tone: "cold", reverb: "huge" },
  "thomas koner": { tone: "cold", reverb: "less" },
  autechre: { tone: "cold", punch: "more", reverb: "less" },
  arca: { tone: "bright", punch: "more" },
  opn: { tone: "cold" },
  fennesz: { tone: "warm", reverb: "huge" },
  "tangerine dream": { tone: "cold", reverb: "huge" },
  "klaus schulze": { tone: "cold", reverb: "huge" },
  "gotttsching e2-e4": { tone: "warm", reverb: "huge" },
  "lofi (nujabes lane)": { tone: "warm", reverb: "more" },
  downtempo: { tone: "warm", reverb: "huge" },
  "plugg newer wave": { tone: "bright", punch: "more" },
  plugg: { tone: "bright", punch: "more" },
  "trap soul": { tone: "dark", reverb: "more" },
  portishead: { tone: "dark", reverb: "huge" },
  "massive attack": { tone: "dark", reverb: "huge" },
  "joy division": { tone: "cold", reverb: "less" },
  interpol: { tone: "cold", reverb: "more" },
  "the cure": { tone: "dark", reverb: "huge" },
  idles: { tone: "dark", punch: "more", reverb: "less" },
  "fontaines dc": { tone: "dark", punch: "more", reverb: "less" },
  turnstile: { tone: "dark", punch: "more" },
  clairo: { tone: "warm", reverb: "more" },
  "rex orange county": { tone: "warm" },
  beabadoobee: { tone: "warm", reverb: "more" },
  "death grips": { tone: "dark", punch: "more", reverb: "less" },
  "clipping.": { tone: "dark", punch: "more" },
  "dua lipa": { tone: "bright", punch: "more", reverb: "less", pump: true },
  "the weeknd": { tone: "dark", reverb: "huge" },
  "billie eilish": { tone: "dark", reverb: "more" },
  "ariana grande": { tone: "bright", reverb: "more" },
  "bruno mars": { tone: "bright", punch: "more" },
  "olivia rodrigo": { tone: "dark", reverb: "more" },
  "charli xcx": { tone: "bright", punch: "more", reverb: "less", pump: true },
  "taylor swift": { tone: "bright", reverb: "more" },
  lorde: { tone: "cold", reverb: "huge" },
  "tate mcrae": { tone: "bright", punch: "more", reverb: "less", pump: true },
  "lady gaga": { tone: "bright", punch: "more", pump: true },
  rihanna: { tone: "warm", reverb: "more" },
  sia: { tone: "bright", reverb: "huge" },
  "katy perry": { tone: "bright", punch: "more", pump: true },
  "ava max": { tone: "bright", punch: "more", reverb: "less", pump: true },
  zedd: { tone: "bright", punch: "more", pump: true },
  "calvin harris": { tone: "bright", punch: "more", reverb: "less", pump: true },
  kesha: { tone: "bright", punch: "more", reverb: "less" },
  "post malone": { tone: "warm", reverb: "more" },
  "doja cat": { tone: "bright", punch: "more" },
  "the kid laroi": { tone: "dark", reverb: "more" },
  "justin bieber": { tone: "bright", reverb: "more" },
  "miley cyrus": { tone: "warm", punch: "more" },
  "sabrina carpenter": { tone: "bright", reverb: "less" },
  "chappell roan": { tone: "bright", punch: "more", reverb: "more" },
  "harry styles": { tone: "warm", reverb: "more" },
  "troye sivan": { tone: "cold", reverb: "more", pump: true },
  halsey: { tone: "dark", reverb: "huge" },
  adele: { tone: "warm", reverb: "more" },
  "sam smith": { tone: "cold", reverb: "huge" },
  wheezy: { tone: "dark", punch: "more" },
  southside: { tone: "dark", punch: "more", reverb: "less" },
  tm88: { tone: "dark", punch: "more" },
  "murda beatz": { tone: "dark", punch: "more" },
  "mike will made-it": { tone: "dark", punch: "more", reverb: "less" },
  "hit-boy": { tone: "warm", punch: "more" },
  "london on da track": { tone: "warm" },
  wondagurl: { tone: "dark", punch: "more", reverb: "less" },
  "sonny digital": { tone: "bright", punch: "more" },
};

/** Artist signature lookup; unknown/absent labels yield the genre default path.
 *  Lookup chain: the deep-profile derive layer (artist-profiles) supplies the
 *  baseline, then the curated ARTIST_MIX_PROFILES table OVERLAYS it
 *  field-by-field. Per-field merge (not "curated or deep") so an artist in
 *  both layers keeps its hand-curated tone/punch/reverb while still picking up
 *  the deep layer's lufs/glue signals — the curated table predates those
 *  fields and would otherwise mask them entirely. Curited wins on any field it
 *  declares; the deep layer fills the rest.
 *
 *  The back edge from artist-profiles to this module is `import type` only, so
 *  the runtime graph stays acyclic. */
export function artistMixProfileOf(intent: IntentSpec): ArtistMixProfile | null {
  if (!intent.artist) return null;
  const deep = artistMixProfileFromDeep(intent.artist);
  const curated = ARTIST_MIX_PROFILES[intent.artist];
  if (!deep) return curated ?? null;
  if (!curated) return deep;
  // Curated fields win; deep fills the gaps (lufs / glue / width / sub).
  const merged: ArtistMixProfile = { ...deep };
  for (const [key, value] of Object.entries(curated)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
