import type { IntentInput, IntentRole } from "./types";
import type { IntentGenre } from "./types";
import { matchAllArtistPresets, matchArtistPreset, parseVibeBlend } from "./artists";

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
  // hip-hop sub-genre sweep — grime is a 140 UK floor (house family)
  [/\bgrime\b|\beski\b/, "house"],
  [/\bchillhop\b|\bstudy beats\b|\blofi hip hop\b/, "ambient"],
  [/\bdrone\b|\bdark ambient\b|\bnew age\b|\bmeditation\b/, "ambient"],
  [/\bbreakcore\b/, "dnb"],
  // sub-genre wave (world-roster follow-up) — specifics still BEFORE generics
  [/\bacid trap\b|\bacid rap\b/, "trap"],
  [/\bfuture garage\b/, "ambient"],
  [/\bspeed garage\b|\bbassline(?: house)?\b|\b2.?step garage\b|\buk funky\b/, "house"],
  [/\bbaile funk\b|\bfunk mandel\w*|\bbrazilian phonk\b|\bbr phonk\b/, "phonk"],
  [/\bneurofunk\b|\bneuro\b/, "dnb"],
  // Southern specialties (bounce / miami / snap) + afroswing + countrytune.
  // "bounce" routes by genre (trap/phonk/drill/jersey each carry .bounce);
  // bare "country" keeps its legacy reading (no mapping).
  [/\bnew orleans\b|\bnola\b|\btriggerman\b|\bbounce rap\b|\bbounce\b/, "trap"],
  [/\bmiami\b|\bbooty bass\b/, "trap"],
  [/\bsnap (?:beat|rap|music)\b|\bfinger snap\b|\bring ?tone\b/, "trap"],
  [/\bafro ?swing\b/, "house"],
  [/\bcountry (?:rap|trap|tune)\b|\bcountrytune\b/, "trap"],
  // DnB sub-genre sweep — all roads into dnb (own grooves + kit + song form)
  [/\bjump ?up\b|\bjumpup\b/, "dnb"],
  [/\bdrumfunk\b|\bdrum funk\b|\btechstep\b|\btech step\b|\bdarkstep\b|\bdark step\b/, "dnb"],
  [/\bragga(?: jungle)?\b|\braggajungle\b|\bdancehall dnb\b/, "dnb"],
  [/\bhalftime (?:dnb|drum ?n ?bass|jungle)\b|\b(?:dnb|jungle) halftime\b/, "dnb"],
  [/\bminimal dnb\b|\bdeep (?:dnb|drum ?n ?bass|drum and bass)\b/, "dnb"],
  [/\bhard groove\b/, "techno"],
  [/\bdarkwave\b|\bwitch house\b|\bwave music\b/, "ambient"],
  [/\bbedroom pop\b/, "ambient"],
  [/\blo-?fi house\b/, "house"],
  [/\bpost-?punk\b/, "techno"],
  [/\btrip hop\b|\btriphop\b/, "ambient"],
  [/\bfuture bass\b/, "trap"],
  [/\bdrone\b/, "ambient"],
  [/\bidm\b/, "ambient"],
  [/\bdeconstructed (?:club|music)\b/, "trap"],
  [/\bvaporwave\b/, "ambient"],
  [/\bberlin school\b/, "techno"],
  [/\bkrautrock\b/, "techno"],
  // pop wave — specifics BEFORE the generic "pop" entry; all ride existing
  // genres (dance-pop base = house, pop-rap = trap). "bedroom pop" above stays
  // first (more specific). SK "pop" is indeclinable, "popovú" stem covered.
  [/\bpop rap\b|\bpop-rap\b/, "trap"],
  [/\bhyperpop\b/, "trap"],
  [/\bdance pop\b|\bdance-pop\b|\bpop dance\b/, "house"],
  [/\bsynth pop\b|\bsynth-pop\b|\bsynthpop\b|\belectropop\b|\belectro pop\b/, "house"],
  [/\bpop beat\b|\bpop song\b|\bpop music\b|\bpop\b|\bpopov\w*/, "house"],
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
  [/\bbaile\b|\bmandel\w*\b/, "bounce"],
  // West Coast / G-funk (MUST sit above the generic "funk" entry — \bfunk\b
  // matches inside "g-funk" because '-' is a non-word char). SK stems
  // deaccented.
  [/\bg[ -]?funk\b|\bgfunk\b|\blow ?rider\b/, "gfunk"],
  [/\bfunky\b|\bfunk\b/, "funky"],
  [/\bdeep\b|\bhlbok/, "deep"],
  // Afroswing BEFORE the generic afro entry — "afro swing" contains the
  // word "afro" and would otherwise be stolen by it.
  [/\bafro ?swing\b/, "afroswing"],
  [/\bfuture garage\b/, "future garage"],
  // Overmono school (house.broken groove) — before generic matches that
  // would steal the word
  [/\bbroken(?: beat)?\b/, "broken"],
  [/\bukg\b|\buk garage\b|\bgarage\b/, "ukg"],
  [/\bafro\b/, "afro"],
  [/\bindustrial(?:ny)?\b|\bpriemysel/, "industrial"],
  [/\bdub\b/, "dub"],
  [/\bacid\b/, "acid"],
  [/\bclassic\b|\btraditional\b|\bklasick|\bretro\b|\bvintage\b|\bnostalgick|\bstaromodn/, "classic"],
  [/\brolling\b|\broll\b|\broluj/, "rolling"],
  [/\bsparse\b/, "sparse"],
  [/\bsample drill\b|\bsample\b/, "sample"],
  [/\bhyper ?pop\b|\bhyper (?:drill|beat)\b|\bhyper\b/, "hyper"],
  // Pop style (Wave 2 adds the house.pop groove; until more pop grooves land,
  // unmatched styles fall back deterministically inside the genre).
  [/\bpop\b|\bpopov\w*/, "pop"],
  [/\bdubstep\b|\briddim\b/, "dubstep"],
  // hip-hop sub-genre sweep
  [/\bchopped and screwed\b|\bscrewed\b|\bslowed(?: and throwed)?\b/, "screwed"],
  [/\bplugg(?:nb)?\b/, "plugg"],
  [/\bdetroit rap\b|\bmichigan (?:rap|beat)\b|\bbabytron\b/, "detroit"],
  [/\bgrime\b|\beski beat\b/, "grime"],
  [/\bhyphy\b|\bthizz\b/, "hyphy"],
  [/\bcrunk\b/, "crunk"],
  // NOLA bounce BEFORE the generic bouncy entry — "bounce" is now the
  // regional bounce family (genre-dispatched: trap/phonk/drill/jersey all
  // carry a .bounce groove); "bouncy" keeps the rage-era trap bounce.
  [/\bnew orleans\b|\bnola\b|\btriggerman\b|\bbounce rap\b|\bbounce\b/, "bounce"],
  [/\bmiami( bass)?\b|\bbooty bass\b/, "miamibass"],
  [/\bsnap (?:beat|rap|music)\b|\bfinger snap\b|\bring ?tone\b/, "snap"],
  [/\bcountry (?:rap|trap|tune)\b|\bcountrytune\b/, "countrytune"],
  [/\bold school rap\b|\b80s rap\b|\belectro hip hop\b/, "oldschool"],
  [/\bcloud rap\b/, "sparse"],
  [/\bmelodic drill\b/, "melodic"],
  [/\bmelodic(?:ke|a)?\b/, "melodic"],
  [/\blux\b|\blush\b/, "lux"],
  [/\bbouncy\b/, "bouncy"],
  [/\bdrifting\b|\bdrift\b|\bplavu?j/, "drifting"],
  [/\bliquid\b|\blikvid\b/, "liquid"],
  // DnB two-step MUST precede the generic UKG 2-step below — "two step dnb"
  // is dnb.twostep, plain "two step" stays UK garage.
  [
    /\b(?:two step|2.?step|dvojkrok|dvojtakt)(?: dnb| drum ?n ?bass| jungle)\b|\b(?:dnb|jungle) (?:two step|2.?step)\b/,
    "twostep",
  ],
  [/\bjump ?up\b|\bjumpup\b/, "jumpup"],
  [/\b2.?step\b|\btwo step\b|\bdvoj(?:krok|taktn)/, "ukg"],
  [/\bhard groove\b/, "driving"],
  [/\bneurofunk\b|\bneuro\b/, "neuro"],
  [/\bdancefloor\b|\bfestival\b/, "dancefloor"],
  [/\bsoulful\b|\bwarm house\b/, "soulful"],
  [/\broller(?:i|y)?\b|\broluj(?:u|e|ec)?\b/, "roller"],
  [/\bamen\b|\bchop\b/, "amen"],
  [/\bhorror(?:core)?\b|\bhoror\b/, "horror"],
  [/\bglitch(?:y)?\b|\bchybn|\bchybov|\bsekan/, "glitch"],
  [/\borganic\b|\borganick|\bprirodzen|\bzivy/, "organic"],
  [/\bmotorik\b/, "industrial"],
  [/\bwest ?coast\b|\bzapadn\w* pobre[zz]i\w*/, "headnod"],
  [/\bhead ?nod\b|\bheadnod\b/, "headnod"],
  // Fred-style emotional UKG (house.heartbeat groove + FRED_FORM)
  [/\bheartbeat\b|\bsrdcov(?:y|ý) tep\b/, "heartbeat"],
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
    /\bno drums\b|\bwithout drums\b|\bdrumless\b|\bdrum-?less\b|\bbez (?:dalsich\s+)?(?:bubn|bic|rytmu)|\b(?:ziaden|ziadny|ziadna|ziadne)\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)\b|\bnula\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)/,
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
 * Protected-role clauses (Fáza 1): "keep my bass", "nechaj bass a akordy" —
 * these name EXISTING content the generation must not rewrite. The clause
 * starts at a preserve trigger and may list several roles ("bass a akordy");
 * scanning stops at the first word outside the clause grammar
 * (determiners/conjunctions), so "keep drums but darker" or
 * "nechaj 808, pridaj lead" do not over-protect, and a negated clause
 * ("keep bass out", "nechaj basu von") protects nothing. Scanned BEFORE the
 * positive role loop so a protected mention does not add the role to the
 * generation set. Deaccented text throughout.
 */
const PRESERVE_TRIGGER = /\b(?:nechaj|ponechaj|keep|leave)\b/;
const PRESERVE_DETERMINERS = new Set(["my", "moj", "moje", "moju", "mom", "the"]);
const PRESERVE_CONJUNCTIONS = new Set(["a", "and", "i", "aj", "plus", "s", "with"]);
const PRESERVE_NEGATIONS = new Set(["out", "von", "mimo", "prec", "away"]);
const PRESERVE_ROLE_STEMS: ReadonlyArray<readonly [RegExp, IntentRole]> = [
  [/^(?:bubn|bic|bicia|drums?|beat)/, "drums"],
  [/^(?:bas|bass|sub)/, "bass"],
  [/^(?:akord|chords?|pads?|keys?)/, "chords"],
  [/^(?:melodi|leads?|synth|arp|topline)/, "lead"],
];

/**
 * Scan a preserve clause into the protected role set (pure). The parser's
 * `lower` has punctuation already collapsed to spaces, so clause structure
 * is word-grammar only: after the first protected role, another role joins
 * the list ONLY through a conjunction ("bass a akordy") — a bare role word
 * ("keep my bass drums only") ends the clause, never over-protects.
 */
function preservedRolesOf(lower: string): IntentRole[] {
  const trigger = PRESERVE_TRIGGER.exec(lower);
  if (!trigger) return [];
  const preserved = new Set<IntentRole>();
  let conjunction = false;
  for (const word of lower.slice(trigger.index + trigger[0].length).split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (PRESERVE_NEGATIONS.has(word)) return [];
    if (PRESERVE_DETERMINERS.has(word)) continue;
    if (PRESERVE_CONJUNCTIONS.has(word)) {
      conjunction = true;
      continue;
    }
    const role = word === "808" ? "bass" : PRESERVE_ROLE_STEMS.find(([re]) => re.test(word))?.[1];
    if (role) {
      if (preserved.size > 0 && !conjunction) break;
      preserved.add(role);
      conjunction = false;
      continue;
    }
    break; // first word outside the clause grammar ends the preserve list
  }
  return [...preserved];
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blank out artist-name occurrences so the NAME itself never doubles as an
 * explicit descriptor ("mobb deep" is not the "deep" style, "dark man x" is
 * not the "dark" mood, "big poppa" is not "pop"). Explicit words OUTSIDE the
 * name still override the preset as before.
 */
function maskArtistNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    // A name that IS itself the descriptor ("neurofunk", "grime", "crunk",
    // "boom bap", "hyperpop") keeps the legacy reading — the descriptor
    // contract (explicit words win, pinned by tests) outranks the masking.
    // Only a PARTIAL overlap ("deep" in "mobb deep", "dark" in "dark man x",
    // "dirty" in "ridin dirty") is blanked.
    if (isDescriptorName(name)) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), " ");
  }
  return out;
}

/** True when a genre/style/mood/trait phrase matches the WHOLE name. */
function isDescriptorName(name: string): boolean {
  const probe = ` ${name.trim()} `;
  const expected = name.trim().length;
  if (expected === 0) return false;
  const tables: ReadonlyArray<ReadonlyArray<readonly [RegExp, unknown]>> = [
    GENRE_PHRASES,
    STYLE_PHRASES,
    MOOD_PHRASES,
    TRAIT_PHRASES,
  ];
  return tables.some((phrases) =>
    phrases.some(([re]) => {
      const match = re.exec(probe);
      return match !== null && match[0].length === expected;
    }),
  );
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
  // Names blanked from genre/style/mood/trait detection (declared up front —
  // both branches below push their matched phrase).
  const maskNames: string[] = [];
  if (blend) {
    input.genre = blend.patch.genre;
    if (blend.patch.style) input.style = blend.patch.style;
    if (blend.patch.productionProfile) input.productionProfile = blend.patch.productionProfile;
    if (blend.patch.mood) input.mood = blend.patch.mood;
    if (blend.patch.energy !== undefined) input.energy = blend.patch.energy;
    if (blend.patch.density !== undefined) input.density = blend.patch.density;
    if (blend.patch.bpmRange) input.bpmRange = [...blend.patch.bpmRange] as IntentInput["bpmRange"];
    detected.push(`♪ ${blend.label}`);
    for (const m of matchAllArtistPresets(lower).slice(0, 2)) maskNames.push(m.matched);
  } else {
    const single = matchArtistPreset(lower);
    if (single) {
      const preset = single.preset;
      input.genre = preset.genre;
      if (preset.style) input.style = preset.style;
      if (preset.productionProfile) input.productionProfile = preset.productionProfile;
      if (preset.mood) input.mood = preset.mood;
      if (preset.energy !== undefined) input.energy = preset.energy;
      if (preset.density !== undefined) input.density = preset.density;
      if (preset.bpmRange) input.bpmRange = [...preset.bpmRange] as IntentInput["bpmRange"];
      detected.push(`♪ ${preset.label}`);
      maskNames.push(single.matched);
    }
  }

  // Genre/style/mood/trait detection runs on the MASKED text: the matched
  // artist name(s) are blanked so they never double as explicit descriptors.
  // Structural parsing below (BPM/key/length/roles) keeps the full text.
  const masked = maskNames.length > 0 ? maskArtistNames(lower, maskNames) : lower;

  // Genre detection (list order = specificity; first hit wins).
  // Skipped when an artist preset already set the genre AND the text carries
  // no genre word of its own is handled naturally: firstPhrase only fires on
  // an actual genre word, which then (intentionally) overrides the preset.
  const genre = firstPhrase(GENRE_PHRASES, masked);
  if (genre) {
    if (input.genre !== undefined && input.genre !== genre) {
      delete input.style;
      delete input.productionProfile;
    }
    input.genre = genre as IntentGenre;
    detected.push(genre);
  }

  // Style detection — v1 rule preserved: an explicit style phrase wins, even
  // if the same word fed genre detection (e.g. "acid techno" → techno + acid).
  const style = firstPhrase(STYLE_PHRASES, masked);
  if (style) {
    input.style = style;
    detected.push(style);
  }

  // Mood — canonical value consumed by mapIntentToOptions tweaks.
  const mood = firstPhrase(MOOD_PHRASES, masked);
  if (mood) {
    input.mood = mood;
    detected.push(mood);
  }

  // Character traits — later matches overwrite earlier ones, list order is
  // therefore part of the contract. Masked like genre/style/mood: "ol dirty"
  // (the Outlaw) must not fire the "dirty" trait.
  const trait: CharacterTrait = {};
  for (const [re, t] of TRAIT_PHRASES) {
    if (re.test(masked)) {
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

  // Candidate count: "give me 5 variations" / "sprav mi päť variantov".
  // The UI's candidate bank supports at most eight local candidates; clamp
  // larger requests explicitly and expose that limit in the detected chips.
  const variationRequest =
    /\b([1-9]\d?|one|two|three|four|five|six|seven|eight|jeden|jedna|jedno|dva|dve|tri|styri|pat|sest|sedem|osem)\s+(?:(?:different|alternate|rozdielne|alternativne)\s+)?(?:variations?|variants?(?:y|ov|u)?|options?|versions?|alternatives?|verzi(?:a|e|i|u)|alternativ(?:y|ov|u|e))\b/.exec(
      lower,
    );
  if (variationRequest) {
    const countWords: Readonly<Record<string, number>> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      jeden: 1,
      jedna: 1,
      jedno: 1,
      dva: 2,
      dve: 2,
      tri: 3,
      styri: 4,
      pat: 5,
      sest: 6,
      sedem: 7,
      osem: 8,
    };
    const requested = countWords[variationRequest[1]] ?? Number(variationRequest[1]);
    const count = Math.max(1, Math.min(8, requested));
    input.candidateCount = count;
    detected.push(`${count} variations${requested > 8 ? " (max 8)" : ""}`);
  }

  // Protected roles — scanned BEFORE the positive loop so "nechaj bass"
  // names existing content instead of adding bass to the generation set.
  const preserved = new Set<IntentRole>(preservedRolesOf(lower));

  // Roles. Negation phrases precede positive ones in ROLE_PHRASES, so an
  // exclusion seen earlier also suppresses the later positive match.
  let noDrums = false;
  let noBass = false;
  let scopeOrNegation = false;
  const roles = new Set<IntentRole>();
  for (const [re, flag] of ROLE_PHRASES) {
    if (!re.test(lower)) continue;
    if (flag === "nodrums") {
      scopeOrNegation = true;
      noDrums = true;
      roles.delete("drums");
    } else if (flag === "nobass") {
      noBass = true;
      roles.delete("bass");
    } else if (flag === "drumsonly") {
      scopeOrNegation = true;
      roles.clear();
      roles.add("drums");
    } else if (flag === "melodyonly") {
      scopeOrNegation = true;
      roles.clear();
      roles.add("lead");
    } else if (flag === "all") {
      scopeOrNegation = true;
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
  // A mention that only NAMESED a protected role ("keep my drums but darker")
  // is not a generation directive — the default generation set still applies
  // (minus the protected roles, via input.preserve).
  if (scopeOrNegation || roles.size > 0) {
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

  // Current production profiles contain trap-family melodic arrangements;
  // an explicit genre override should not accidentally carry one into a
  // different genre.
  if (input.genre !== undefined && input.genre !== "trap") delete input.productionProfile;

  return { input, detected };
}
