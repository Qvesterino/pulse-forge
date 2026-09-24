import type { IntentInput, IntentRole } from "./types";
import type { IntentGenre } from "./types";
import { matchArtistPreset, parseVibeBlend } from "./artists";

/**
 * Natural language → IntentInput parser (goal: "dark rolling techno at 140
 * in F# minor with a lead, 8 bars" / "tmavé rolujúce techno na 140,
 * 8 taktov, bez bubnov").
 *
 * Deterministic phrase matching — no AI, no network, no RNG. v3 is BILINGUAL
 * EN + SK: the input is de-accented once (arrangeWords convention) and both
 * dictionaries match against the same normalized text. Design rules that keep
 * SK support regression-free:
 *
 * 1. EN regexes are untouched — ASCII input passes through deaccent as a
 *    no-op, so EN behavior is byte-compatible (guarded by the original tests).
 * 2. SK only extends DETECTION — canonical values stay EN ("dark",
 *    "rolling", Natural Minor), because mapIntentToOptions and resolveGroove
 *    switch on those.
 * 3. Genres are indeclinable loanwords in Slovak (techno/house/trap/ambient),
 *    so genre detection is shared verbatim.
 * 4. Slovak inflection is handled with curated STEMS ("bubn" covers
 *    bubny/bubnov/bubnoch; "tmav|temn" covers tmavý/tmavé/temný), each pinned
 *    by tests on multiple inflected forms.
 */

/** Strip diacritics + lowercase once — both dictionaries then match ASCII. */
function deaccent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Genre keyword → IntentGenre mapping. More specific genres win by list order. */
const GENRE_PHRASES: ReadonlyArray<readonly [RegExp, IntentGenre]> = [
  // sub-genre specifics FIRST — generic entries below would otherwise win
  [/\bhard techno\b/, "techno"],
  [/\bmelodic techno\b/, "techno"],
  [/\bhypnotic techno\b/, "techno"],
  [/\bpeak time\b|\bafter ?hours\b/, "techno"],
  [/\bwarehouse\b/, "techno"],
  [/\bsynthwave\b|\bretrowave\b|\bdarksynth\b|\boutrun\b/, "techno"],
  [/\btrance\b|\bpsytrance\b|\bpsy\b/, "techno"],
  [/\bacid house\b/, "house"],
  [/\bbass house\b|\bfuture house\b/, "house"],
  [/\bg[- ]house\b|\bghetto ?tech\b/, "house"],
  [/\bafro house\b/, "house"],
  [/\buk drill\b|\bsample drill\b/, "drill"],
  [/\bgrime\b/, "drill"],
  [/\bdrift phonk\b/, "phonk"],
  [/\bdubstep\b|\briddim\b|\bhybrid trap\b/, "trap"],
  [/\bchillhop\b|\bstudy beats\b|\blofi hip hop\b/, "ambient"],
  [/\bdrone\b|\bdark ambient\b|\bnew age\b|\bmeditation\b/, "ambient"],
  [/\bbreakcore\b/, "dnb"],
  // canonical / generic
  [/\bdeep house\b/, "house"],
  [/\btech house\b/, "house"],
  [/\bfrench house\b/, "house"],
  [/\bbig room\b/, "house"],
  [/\bhouse\b/, "house"],
  [/\bdeep\b/, "house"],
  [/\bgarage\b|\bukg\b|\buk garage\b/, "house"],
  [/\bjersey\b/, "jersey"], // first-class since the sound-quality pass (own grooves + kit)
  [/\bafro\b|\bafrobeat\b/, "house"],
  [/\breggaeton\b/, "house"],
  [/\btechno\b/, "techno"],
  [/\btech\b/, "techno"],
  [/\bacid\b/, "techno"],
  [/\bindustrial\b/, "techno"],
  [/\bdub techno\b|\bdubtech\b|\bdub\b/, "techno"],
  [/\bhardcore\b|\bgabber\b/, "techno"],
  [/\bdrill\b/, "drill"], // first-class since the sound-quality pass (own grooves + kit swap)
  [/\btrap\b/, "trap"],
  [/\bphonk\b|\bmemphis\b|\bmemfis\b/, "phonk"],
  [/\bhip ?hop\b|\bboombap\b|\bboom bap\b/, "trap"],
  [/\bambient\b/, "ambient"],
  [/\blofi\b|\blo-?fi\b/, "ambient"],
  [/\bscore\b|\bscene\b|\bsoundscape\b|\bcinematic\b/, "ambient"],
  [/\bdnb\b|\bdrum ?n ?bass\b|\bdrum and bass\b|\bjungle\b|\bliquid dnb\b/, "dnb"],
];

/**
 * Style phrases → canonical groove style names (resolveGroove expects these).
 * SK stems share the entry with EN where the meaning is identical.
 */
const STYLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdriving\b|\bdrive\b/, "driving"],
  [/\bminimal(?:ny)?\b|\bminimalistick/, "minimal"],
  [/\bfunky\b|\bfunk\b/, "funky"],
  [/\bdeep\b|\bhlbok/, "deep"],
  [/\bukg\b|\buk garage\b|\bgarage\b/, "ukg"],
  [/\bafro\b/, "afro"],
  [/\bindustrial(?:ny)?\b|\bpriemysel/, "industrial"],
  [/\bdub\b/, "dub"],
  [/\bacid\b/, "acid"],
  [/\bclassic\b|\btraditional\b|\bklasick|\bretro\b|\bvintage\b|\bnostalgick|\bstaromodn/, "classic"],
  [/\brolling\b|\broll\b|\broluj/, "rolling"],
  [/\bsparse\b/, "sparse"],
  [/\bbouncy\b|\bbounce\b/, "bouncy"],
  [/\bdrifting\b|\bdrift\b|\bplavu?j/, "drifting"],
  [/\bglitch(?:y)?\b|\bchybn|\bchybov|\bsekan/, "glitch"],
  [/\borganic\b|\borganick|\bprirodzen|\bzivy/, "organic"],
];

/** Character phrase → canonical mood (mapping.ts applies mood tweaks). */
const MOOD_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bdark\b|\bmoody\b|\bmenacing\b|\beerie\b|\bsinister\b|\bevil\b|\bgrim\b|\bbrooding\b|\bominous\b|\btmav|\btemn|\bnocn|\bstrasideln|\bdesiv|\bznepokoj/,
    "dark",
  ],
  [
    /\baggressive\b|\bhard\b|\bharsh\b|\bbrutal\b|\bviolent\b|\bangry\b|\bwild\b|\bhostile\b|\bfuriou|\btvrd|\bagresiv|\bzuriv|\bdivok|\bdravy/,
    "aggressive",
  ],
  [
    /\bchill\b|\bsoft\b|\bmellow\b|\brelaxed\b|\blaid back\b|\blaid-?back\b|\bcalm\b|\bpeaceful\b|\bcozy\b|\blazy\b|\bdream(?:y)?\b|\bserene\b|\bpoko|\bjemn|\bmakk|\btlm|\bsnov|\bleniv|\bpohodov|\bmierov|\bkludn|\btichy/,
    "chill",
  ],
  [
    /\benergetic\b|\bbright\b|\buplifting\b|\beuphoric\b|\bhappy\b|\bjoyful\b|\bvibrant\b|\bfestive\b|\bcelebrator|\belated\b|\bsvetl|\bvesel|\bradostn|\boslavn|\bsviatocn|\bstastn/,
    "energetic",
  ],
];

/** Additional character phrases that only shape sliders (no mood tweaks). */
interface CharacterTrait {
  energy?: number;
  density?: number;
  complexity?: number;
  variation?: number;
}

const TRAIT_PHRASES: ReadonlyArray<readonly [RegExp, CharacterTrait]> = [
  [/\bwarm\b|\btepl/, { energy: 0.5 }],
  [/\bcold\b|\bicy\b|\bstuden|\bchladn/, { energy: 0.35 }],
  [/\bsparse\b|\bminimal(?:ny)?\b|\bminimalistick/, { density: 0.25, complexity: 0.25 }],
  [/\bbusy\b|\bdense\b|\bhust|\bvrstv/, { density: 0.8 }],
  [/\bsimple\b|\bstraightforward\b|\bjednoduch/, { complexity: 0.2 }],
  [/\bcomplex\b|\bintricate\b|\bdetailed\b|\bzlozit|\bkomplex|\bkomplikov/, { complexity: 0.8 }],
  [/\bhypnot(?:ic|ick)/, { variation: 0.2, complexity: 0.3 }],
  [/\bevolving\b|\bdynamic\b/, { variation: 0.8 }],
  [/\bpunchy\b|\bpriebojn/, { energy: 0.75, density: 0.6 }],
  [/\bsmooth\b|\bsilky\b|\bhladk/, { energy: 0.4, complexity: 0.35 }],
  [/\bheavy\b|\bweighty\b|\btazk|\bsiln|\brobustn/, { energy: 0.85, density: 0.7 }],
  [/\blight\b|\bairy\b|\blehky|\bjemn/, { energy: 0.35, density: 0.4 }],
  [/\btight\b|\btesn/, { complexity: 0.4 }],
  [/\bwide\b|\bbig\b|\bsirok|\bvelk|\bpriestorn/, { complexity: 0.6 }],
  [/\bgroovy\b/, { variation: 0.6, energy: 0.7 }],
  [/\bfast\b|\brychl/, { energy: 0.85 }],
  [/\bslow\b|\bpomal/, { energy: 0.3 }],
  // moods also nudge sliders so "dark" both tweaks mood AND lowers energy
  [
    /\bdark\b|\bmoody\b|\bmenacing\b|\beerie\b|\bsinister\b|\bevil\b|\bgrim\b|\bbrooding\b|\bominous\b|\btmav|\btemn|\bnocn|\bstrasideln|\bdesiv|\bznepokoj/,
    { energy: 0.3 },
  ],
  [
    /\bchill\b|\brelaxed\b|\blaid back\b|\blaid-?back\b|\bcalm\b|\bpeaceful\b|\bcozy\b|\blazy\b|\bdream(?:y)?\b|\bpoko|\btichy|\bmierov|\bkludn/,
    { energy: 0.3, density: 0.4 },
  ],
  [
    /\baggressive\b|\bhard\b|\btvrd|\bviolent\b|\bangry\b|\bwild\b|\bzuriv|\bdivok|\bdravy/,
    { energy: 0.9, density: 0.7 },
  ],
  [
    /\benergetic\b|\beuphoric\b|\buplifting\b|\bbright\b|\bhappy\b|\bjoyful\b|\bvibrant\b|\bsvetl|\bvesel|\bradostn|\bstastn/,
    { energy: 0.95, density: 0.7 },
  ],
  [/\bdriving\b/, { energy: 0.8, density: 0.7 }],
  [/\brolling\b|\broluj/, { variation: 0.6 }],
  [/\bmelancholic\b|\bemotional\b|\bsmutn|\bemocion/, { energy: 0.35, complexity: 0.5 }],
  // vocabulary-wave traits
  [/\bgritty\b|\braw\b|\bsurov/, { energy: 0.8, density: 0.6 }],
  [/\bclean\b|\bcrisp\b|\bcist/, { complexity: 0.3 }],
  [/\blush\b|\bbohat/, { density: 0.65, complexity: 0.6 }],
  [/\batmospheric\b|\batmosferick/, { complexity: 0.55, variation: 0.6 }],
  [/\bepic\b|\bepick/, { energy: 0.85, density: 0.75 }],
  [/\btextured\b|\btextur/, { complexity: 0.6 }],
  [/\bsteady\b|\bpevn/, { variation: 0.25 }],
  [/\bdirty\b|\bcrunchy\b|\bspinav/, { energy: 0.75, complexity: 0.5 }],
  [/\bfloat(?:ing)?\b|\bplavaj/, { energy: 0.35, density: 0.35 }],
  [/\bhaunting\b|\bdesiv/, { energy: 0.35, complexity: 0.55 }],
  [/\bfestival\b|\bfestiv|\bpeak time\b/, { energy: 0.95, density: 0.8 }],
  // SK vocabulary wave: more adjective variants — each pinned by tests on
  // multiple inflected forms (krehký/krehká/krehké → stem "krehky").
  [/\bfragile\b|\bdelicate\b|\bkrehk/, { complexity: 0.4 }],
  [/\bold[- ]?school\b|\bretro\b|\bvintage\b|\bstaromodn|\bnostalgick/, { variation: 0.3 }],
  [/\bedgy\b|\bcutting\b|\bostry\b|\bstiplav|\brezav/, { complexity: 0.65 }],
  [/\bshallow\b|\bflat\b|\bplytk/, { density: 0.3 }],
];

/**
 * Role phrase → role flag. Negation phrases PRECEDE positives in list order
 * and suppress later positive matches ("no drums" contains "drums",
 * "bez bubnov" contains "bubn").
 */
const ROLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bno drums\b|\bwithout drums\b|\bdrumless\b|\bdrum-?less\b|\bbez (?:bubn|bic|rytmu)|\b(?:ziaden|ziadny|ziadna|ziadne)\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)\b|\bnula\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)/,
    "nodrums",
  ],
  [/\bno bass\b|\bwithout bass\b|\bbassless\b|\bbez bas/, "nobass"],
  [/\bdrums only\b|\bbeat only\b|\bpercussion only\b|\b(?:len|iba) (?:bubn|bic)/, "drumsonly"],
  [/\bmelody only\b|\bno drums just melody\b|\b(?:len|iba) melodi/, "melodyonly"],
  [/\bfull beat\b|\beverything\b|\bfull arrangement\b|\bcely (?:beat|bit)\b|\bvsetko/, "all"],
  [/\bdrums\b|\bthe beat\b|\bpercussion\b|\bkick\b|\bbubn|\bbic|\bbicia\b/, "drums"],
  [/\bbass\b|\b808\b|\bsub\b|\bbas(?:a|u|y|ou|ov)?\b/, "bass"],
  [/\bchords\b|\bpads\b|\bstabs\b|\bkeys\b|\bakord/, "chords"],
  [/\blead(?:om|u|a)?\b|\bmelody\b|\barp\b|\barpeggio\b|\btopline\b|\btop line\b|\bsynth\b|\bmelodi/, "lead"],
];

/**
 * Protected-role phrases (Fáza 1): "keep my bass", "nechaj akordy" — these
 * name EXISTING content the generation must not rewrite. They are scanned
 * BEFORE the positive role loop so a protected mention does not add the
 * role to the generation set; the role lands in `input.preserve` instead.
 * Deaccented text, so SK stems match without diacritics.
 */
const PRESERVE_PHRASES: ReadonlyArray<readonly [RegExp, IntentRole]> = [
  [
    /(?:\bnechaj|\bponechaj|\bzostav|\bkeep|\bleave)\s+(?:(?:my|moj|moje|moju|mom|the)\s+)?(?:bubn|bic|bicia|drums)/,
    "drums",
  ],
  [/(?:\bnechaj|\bponechaj|\bzostav|\bkeep|\bleave)\s+(?:(?:my|moj|moje|moju|mom|the)\s+)?(?:bas|808|sub|bass)/, "bass"],
  [
    /(?:\bnechaj|\bponechaj|\bzostav|\bkeep|\bleave)\s+(?:(?:my|moj|moje|moju|mom|the)\s+)?(?:akord|chords|pads|keys)/,
    "chords",
  ],
  [
    /(?:\bnechaj|\bponechaj|\bzostav|\bkeep|\bleave)\s+(?:(?:my|moj|moje|moju|mom|the)\s+)?(?:melodi|lead|synth|arp|topline|top line)/,
    "lead",
  ],
];

/** Note-name normalization for key parsing (flats → sharps). */
const NOTE_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/c#/, "C#"],
  [/db/, "C#"],
  [/d#/, "D#"],
  [/eb/, "D#"],
  [/e/, "E"],
  [/f#/, "F#"],
  [/gb/, "F#"],
  [/g#/, "G#"],
  [/ab/, "G#"],
  [/a#/, "A#"],
  [/bb/, "A#"],
  [/a/, "A"],
  [/b/, "B"],
  [/c/, "C"],
  [/d/, "D"],
  [/f/, "F"],
  [/g/, "G"],
];

const SCALE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bharmonic minor\b/, "Harmonic Minor"],
  [/\bharmonicka mol\b/, "Harmonic Minor"],
  [/\bmelodic minor\b/, "Melodic Minor"],
  [/\bmelodicka mol\b/, "Melodic Minor"],
  [/\bnatural minor\b|\bminor\b|\baeolian\b|\bmol\b/, "Natural Minor"],
  [/\bmajor\b|\bionian\b|\bdur\b/, "Major"],
  [/\bdorian\b|\bdorsky/, "Dorian"],
  [/\bphrygian\b|\bfrygicky/, "Phrygian"],
  [/\bmixolydian\b|\bmixolydicky/, "Mixolydian"],
  [/\bpentatonic major\b/, "Pentatonic Major"],
  [/\bpentatonic minor\b|\bpentatonic\b/, "Pentatonic Minor"],
];

export interface ParsedIntent {
  input: IntentInput;
  /** Keywords/phrases recognised by the parser (for diagnostics/UI feedback). */
  detected: string[];
}

/** Find the first phrase (by list order = specificity) present in the text. */
function firstPhrase(phrases: ReadonlyArray<readonly [RegExp, string]>, text: string): string | null {
  for (const [re, value] of phrases) {
    if (re.test(text)) return value;
  }
  return null;
}

/** Key-root matchers: EN ("in f# minor", "g major") and SK ("v f# mol", "g dur"). */
const KEY_IN_EN = /\bin ([a-g](?:#|b)?)\s*([a-z ]+?)?\b(?=(?:\bwith\b|\bat\b|\bplus\b|\band\b|\b\d)|$)/;
const KEY_IN_SK = /\bv ([a-g](?:#|b)?)\s*([a-z ]+?)?\b(?=(?:\bs\b|\bplus\b|\ba\b|\b\d)|$)/;
const KEY_BARE_EN =
  /\b([a-g](?:#|b)?)\s+(harmonic minor|melodic minor|natural minor|dorian|phrygian|mixolydian|major|minor|pentatonic)\b/;
const KEY_BARE_SK = /\b([a-g](?:#|b)?)\s+(harmonicka mol|melodicka mol|mol|dur)\b/;

/** Parse "in f# minor" / "g major" / "v f# mol" / "db phrygian" into a key. */
export function parseKeyPhrase(text: string): string | null {
  const match = KEY_IN_EN.exec(text) ?? KEY_IN_SK.exec(text);
  const bare = KEY_BARE_EN.exec(text) ?? KEY_BARE_SK.exec(text);
  const rootRaw = (match?.[1] ?? bare?.[1] ?? "").toLowerCase();
  if (!rootRaw) return null;
  let root: string | null = null;
  for (const [re, name] of NOTE_NAMES) {
    if (re.test(rootRaw)) {
      root = name;
      break;
    }
  }
  if (!root) return null;
  const scaleText = bare?.[2] ?? match?.[2] ?? "";
  const scale = firstPhrase(SCALE_PHRASES, scaleText.length > 0 ? ` ${scaleText} ` : " minor ");
  // No scale word → minor default: the overwhelmingly dominant mode for beats.
  return `${root} ${scale ?? "Natural Minor"}`;
}

/**
 * Parse natural language text (EN or SK) into an IntentInput.
 * Pure function — same text → same result.
 */
export function parseIntentText(text: string): ParsedIntent {
  const lower = ` ${deaccent(text)
    .replace(/[\s,.]+/g, " ")
    .trim()} `;
  const detected: string[] = [];

  const input: IntentInput = {};

  // ARTIST "type beat" preset (C1) — applied FIRST as the base: it sets
  // genre/style/mood/sliders/BPM, and the explicit-word steps below still
  // override it ("travis scott type beat bright" → energetic wins over the
  // preset's dark). No artist match ⇒ everything behaves exactly as before.
  // MULTI-VIBE BLEND (vibe-code wave): "travis scott meets metro boomin" —
  // two distinct artist presets in one sentence blend instead of
  // first-hit-wins. The blend is the BASE; explicit words below still
  // override it. The text keeps both names, so the MiniLM conditioning
  // embeds the blend naturally.
  const blend = parseVibeBlend(lower);
  if (blend) {
    input.genre = blend.patch.genre;
    if (blend.patch.style) input.style = blend.patch.style;
    if (blend.patch.mood) input.mood = blend.patch.mood;
    if (blend.patch.energy !== undefined) input.energy = blend.patch.energy;
    if (blend.patch.density !== undefined) input.density = blend.patch.density;
    if (blend.patch.bpmRange) input.bpmRange = [...blend.patch.bpmRange] as IntentInput["bpmRange"];
    detected.push(`♪ ${blend.label}`);
  } else {
    const artist = matchArtistPreset(lower);
    if (artist) {
      const preset = artist.preset;
      input.genre = preset.genre;
      if (preset.style) input.style = preset.style;
      if (preset.mood) input.mood = preset.mood;
      if (preset.energy !== undefined) input.energy = preset.energy;
      if (preset.density !== undefined) input.density = preset.density;
      if (preset.bpmRange) input.bpmRange = [...preset.bpmRange] as IntentInput["bpmRange"];
      detected.push(`♪ ${preset.label}`);
    }
  }

  // Genre detection (list order = specificity; first hit wins).
  // Skipped when an artist preset already set the genre AND the text carries
  // no genre word of its own is handled naturally: firstPhrase only fires on
  // an actual genre word, which then (intentionally) overrides the preset.
  const genre = firstPhrase(GENRE_PHRASES, lower);
  if (genre) {
    input.genre = genre as IntentGenre;
    detected.push(genre);
  }

  // Style detection — v1 rule preserved: an explicit style phrase wins, even
  // if the same word fed genre detection (e.g. "acid techno" → techno + acid).
  const style = firstPhrase(STYLE_PHRASES, lower);
  if (style) {
    input.style = style;
    detected.push(style);
  }

  // Mood — canonical value consumed by mapIntentToOptions tweaks.
  const mood = firstPhrase(MOOD_PHRASES, lower);
  if (mood) {
    input.mood = mood;
    detected.push(mood);
  }

  // Character traits — later matches overwrite earlier ones, list order is
  // therefore part of the contract.
  const trait: CharacterTrait = {};
  for (const [re, t] of TRAIT_PHRASES) {
    if (re.test(lower)) {
      if (t.energy !== undefined) trait.energy = t.energy;
      if (t.density !== undefined) trait.density = t.density;
      if (t.complexity !== undefined) trait.complexity = t.complexity;
      if (t.variation !== undefined) trait.variation = t.variation;
    }
  }
  if (trait.energy !== undefined) input.energy = trait.energy;
  if (trait.density !== undefined) input.density = trait.density;
  if (trait.complexity !== undefined) input.complexity = trait.complexity;
  if (trait.variation !== undefined) input.variation = trait.variation;

  // BPM: "at 140", "140 bpm", "140-150 bpm", "between 138 and 145",
  // SK: "na 140", "pri 140", "okolo 140", "medzi 138 a 145"
  const rangeMatch =
    /\b(\d{2,3})\s*(?:-|–|to|and)\s*(\d{2,3})\s*(?:bpm\b)?/.exec(lower) ??
    /\bbetween (\d{2,3}) and (\d{2,3})\b/.exec(lower) ??
    /\bmedzi (\d{2,3}) a (\d{2,3})\b/.exec(lower);
  const singleMatch = /\b(?:at|around|about|na|pri|okolo)\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/.exec(lower);
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (lo >= 40 && hi <= 240 && lo <= hi) {
      input.bpmRange = [lo, hi];
      detected.push(`${lo}-${hi}bpm`);
    }
  } else {
    const bpm = Number(singleMatch?.[1] ?? singleMatch?.[2]);
    if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 240) {
      input.bpmRange = [bpm, bpm];
      detected.push(`${bpm}bpm`);
    }
  }

  // Musical key — "in f# minor", "g major", "v f# mol", "g dur"
  const key = parseKeyPhrase(lower);
  if (key) {
    input.key = key as IntentInput["key"];
    detected.push(key.toLowerCase());
  }

  // Length: "8 bars" / "16 bar" / "8 taktov" / "4 takty" → steps (16/bar)
  const bars = /\b(\d{1,3})\s*(?:bars?|takty|taktov|takt)\b/.exec(lower);
  if (bars) {
    const steps = Number(bars[1]) * 16;
    if (steps >= 16 && steps <= 256) {
      input.length = steps;
      detected.push(`${bars[1]}bars`);
    }
  }

  // Protected roles — scanned BEFORE the positive loop so "nechaj bass"
  // names existing content instead of adding bass to the generation set.
  const preserved = new Set<IntentRole>();
  for (const [re, role] of PRESERVE_PHRASES) {
    if (re.test(lower)) preserved.add(role);
  }

  // Roles. Negation phrases precede positive ones in ROLE_PHRASES, so an
  // exclusion seen earlier also suppresses the later positive match.
  let noDrums = false;
  let noBass = false;
  const roles = new Set<IntentRole>();
  let hasRoleKeyword = false;
  for (const [re, flag] of ROLE_PHRASES) {
    if (!re.test(lower)) continue;
    hasRoleKeyword = true;
    if (flag === "nodrums") {
      noDrums = true;
      roles.delete("drums");
    } else if (flag === "nobass") {
      noBass = true;
      roles.delete("bass");
    } else if (flag === "drumsonly") {
      roles.clear();
      roles.add("drums");
    } else if (flag === "melodyonly") {
      roles.clear();
      roles.add("lead");
    } else if (flag === "all") {
      roles.add("drums");
      roles.add("bass");
      roles.add("chords");
      roles.add("lead");
    } else {
      if (flag === "drums" && noDrums) continue;
      if (flag === "bass" && noBass) continue;
      if (preserved.has(flag as IntentRole)) continue;
      roles.add(flag as IntentRole);
    }
  }
  if (hasRoleKeyword) {
    const resolved = noDrums ? [...roles].filter((role) => role !== "drums") : [...roles];
    // "no drums" with nothing else named still means the remaining roles.
    input.roles =
      resolved.length > 0
        ? (resolved as IntentRole[])
        : noDrums
          ? (["bass", "chords", "lead"] as IntentRole[])
          : (["drums", "bass"] as IntentRole[]);
    if (noDrums) detected.push("no drums");
  }
  if (noBass) detected.push("no bass");
  if (preserved.size > 0) {
    input.preserve = [...preserved];
    for (const role of preserved) detected.push(`preserve ${role}`);
  }

  return { input, detected };
}
