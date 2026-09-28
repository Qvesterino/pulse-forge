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
  // Synthwave / outrun / darksynth ride ambient.synthwave (Wave 5 groove).
  // Was routed to techno before the groove existed, which left style
  // "synthwave" with no techno.synthwave id → silent random techno fallback.
  [/\bsynthwave\b|\bretrowave\b|\bdarksynth\b|\boutrun\b/, "ambient"],
  [/\btrance\b|\bpsytrance\b|\bpsy\b|\buplifting trance\b|\bvocal trance\b|\bdream trance\b/, "trance"],
  [/\bacid house\b/, "house"],
  [/\bbass house\b|\bfuture house\b/, "house"],
  [/\bg[- ]house\b|\bghetto ?tech\b/, "house"],
  [/\bafro house\b/, "house"],
  // Piano house - the 90s/2020s piano-led floor (house.pianohouse). Before
  // the generic "house" entry below.
  [/\bpiano house\b|\bpianohouse\b|\bpiano (?:club|groove)\b/, "house"],
  // Breakbeat hardcore is a Eurodance/rave lineage, not generic house breaks.
  [/\bbreakbeat\s+hardcore\b/, "eurodance"],
  // Breakbeat / big beat - the breaks floor (house.breakbeat). "breaks" and
  // "breakbeat" both land here; "broken beat" stays its own house.broken.
  [/\bbreakbeat\b|\bbig ?beat\b|\bbreaks?\b(?!\s*(?:beat|core))/, "house"],
  // Midtempo - the half-time bass-music floor (house.midtempo).
  [/\bmidtempo\b|\bmid[- ]?tempo\b/, "house"],
  // Amapiano — first-class since the promotion: the log-drum genre with its
  // own school tree (yanos / soulful / s'gija / bacardi / quantum / popiano).
  // "private school piano" is the soulful school, "new age bacardi" the
  // Pretoria mutation, "popiano" the pop-facing variant.
  [
    /\bamapiano\b|\byanos\b|\bprivate school piano\b|\bnew age bacardi\b|\bpopiano\b|\bafropiano\b|\bquantum sound\b/,
    "amapiano",
  ],
  [/\bbacardi\b/, "amapiano"],
  // Rock lanes — grunge / alt rock / rapcore / synth punk ride dedicated
  // house-family grooves; "nu metal" is the rapcore family alias. "synth
  // punk" is safe against the post-punk entry (different words entirely).
  [/\bgrunge\b/, "house"],
  [/\balt(?:ernative)? ?rock\b|\baltrock\b/, "house"],
  [/\brapcore\b|\bnu ?metal\b|\brap ?metal\b/, "house"],
  [/\bsynth[- ]?punk\b/, "house"],
  // Metal depth — MUST sit below the rapcore entry so "nu metal" keeps
  // resolving to rapcore, and \bmetal\b never touches "metalcore" (no word
  // boundary inside the compound).
  [/\bmetalcore\b/, "house"],
  [/\bthrash\b/, "house"],
  [/\bdoom(?: metal)?\b/, "house"],
  [/\bheavy metal\b|\bmetal\b/, "house"],
  // Punk specifics — bare "hardcore" reads as punk hardcore (no gabber lane
  // exists); pop punk sits above the generic pop style via the style table.
  // Hardstyle / hardcore-techno / uptempo MUST sit above the punk-hardcore
  // reading — bare "hardcore" stays punk (house.hardcorepunk), but the
  // explicit electronic compounds are the 150-190 hard-dance family.
  // Closest existing pockets: techno.hardstyle / techno.hard; the dedicated
  // gabber lane is a researched P1 addition (docs/VOCABULARY-GAP-RESEARCH.md).
  [/\bhardstyle\b|\bhard style\b/, "techno"],
  [/\bhardcore techno\b|\bhappy hardcore\b|\bfrenchcore\b|\bterrorcore\b|\bspeedcore\b|\buptempo hardcore\b/, "techno"],
  // Crossbreed / darkcore MUST sit above the bare "hardcore" reading below:
  // the dnb-hardcore border is its own lane (dnb.crossbreed), while bare
  // "hardcore" stays punk (house.hardcorepunk).
  [/\bcrossbreed\b|\bdarkcore\b|\bhardcore dnb\b|\bhardcore drum ?n ?bass\b/, "dnb"],
  [/\bhardcore(?: punk)?\b/, "house"],
  [/\bpop[- ]?punk\b/, "house"],
  [/\bindie(?: rock)?\b/, "house"],
  // Organic house — the Anjunadeep / Keinemusik hand-drum wave. Bare
  // "organic" stays unmapped ("organic ambient" must keep reaching ambient).
  [/\borganic house\b|\bafro organic\b/, "house"],
  // Alté — the Lagos alternative lane (deaccented; "alternative" is safe —
  // \balte\b needs a word boundary the long word never provides).
  [/\balte\b/, "house"],
  [/\buk drill\b|\bsample drill\b/, "drill"],
  [/\bgrime\b/, "drill"],
  [/\bdrift phonk\b/, "phonk"],
  // Deep dubstep BEFORE the generic dubstep entry — the 140 Croydon sound is
  // its own lane (halftime, sub-heavy), not the brostep/riddim side.
  [/\bdeep dubstep\b|\buk dubstep\b|\b140 dubstep\b|\bdeep dub\b/, "trap"],
  // Brostep / bass dubstep — the modern US drop-era lane (trap.bassdubstep,
  // P2 wave). MUST sit above the generic dubstep entry.
  [/\bbrostep\b|\bbass ?dubstep\b|\bbass music\b|\btearout dubstep\b/, "trap"],
  [/\bdubstep\b|\briddim\b|\bhybrid trap\b/, "trap"],
  // hip-hop sub-genre sweep — grime is a 140 UK floor (house family)
  [/\bgrime\b|\beski\b/, "house"],
  [/\bchillhop\b|\bstudy beats\b|\blofi hip hop\b/, "ambient"],
  // Explicit ambient compounds win over the standalone drone genre, so
  // "dark ambient drone" and "drone ambient" remain in the ambient family.
  [/\bdark ambient\b|\bambient drone\b|\bdrone ambient\b/, "ambient"],
  // Drone / neo-classical - first-class since the promotion. "new age" and
  // "meditation" stay ambient (they are the relaxed-lifestyle lane).
  [/\bdrone\b|\bdrone music\b/, "drone"],
  [
    /\bneoclassical\b|\bneo[- ]?classical\b|\bmodern classical\b|\bminimalism\b|\bisolationism\b|\belectroacoustic\b/,
    "drone",
  ],
  [/\bfilm score\b|\borchestral score\b|\bmodern score\b/, "drone"],
  [/\bnew age\b|\bmeditation\b/, "ambient"],
  [/\bbreakcore\b/, "dnb"],
  // sub-genre wave (world-roster follow-up) — specifics still BEFORE generics
  [/\bacid trap\b|\bacid rap\b/, "trap"],
  [/\bfuture garage\b/, "ambient"],
  // UKG — first-class genre since the garage promotion (own grooves +
  // form + mix). "garage house" / "NJ garage" keep their house reading via
  // the house entries below (this phrase needs the explicit UK markers).
  [/\bspeed garage\b|\bbassline(?: house)?\b|\b2.?step garage\b|\buk funky\b|\bukg\b|\buk garage\b/, "ukg"],
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
  // Country POP (Shania / Kacey train beat) — bare "country" keeps its
  // legacy no-mapping reading; only the explicit pop compounds route here.
  [/\bcountry pop\b|\bpop country\b|\bcountrypop\b|\bnashville pop\b/, "house"],
  // DnB sub-genre sweep — all roads into dnb (own grooves + kit + song form)
  [/\bjump ?up\b|\bjumpup\b/, "dnb"],
  [/\bdrumfunk\b|\bdrum funk\b|\btechstep\b|\btech step\b|\bdarkstep\b|\bdark step\b/, "dnb"],
  [/\bragga(?: jungle)?\b|\braggajungle\b|\bdancehall dnb\b/, "dnb"],
  // bare "jungle" - the 1994 chopped-breaks lane (dnb.jungle)
  [/\bjungle\b/, "dnb"],
  // Crossbreed / darkcore — the dnb-hardcore border. Genre routing is
  // handled above (before the punk reading of bare "hardcore"); the style
  // entry below picks the groove.
  [/\bhalftime (?:dnb|drum ?n ?bass|jungle)\b|\b(?:dnb|jungle) halftime\b/, "dnb"],
  [/\bsambass\b|\bsamba (?:dnb|bass)\b|\bbrazilian dnb\b/, "dnb"],
  [/\bminimal dnb\b|\bautonomic\b|\bdeep (?:dnb|drum ?n ?bass|drum and bass)\b/, "dnb"],
  [/\bhard groove\b|\bhardgroove\b/, "techno"],
  // Detroit's two faces: "detroit techno" / "detroit electro" must not fall
  // into the hip-hop "detroit rap" entry further down. Promoted to the
  // first-class `detroit` genre (machine-funk lineage + electro school).
  [/\bdetroit (?:techno|electro|house)\b/, "detroit"],
  [/\btechno (?:detroit|electro)\b/, "detroit"],
  // Electronic sub-genre wave — progressive house, classic electro, big beat,
  // moombahton (house × dembow), slap house. Specific guards BEFORE the bare
  // "electro" entry, and "electro pop/swing" must not be stolen by it.
  [/\bprogressive house\b|\bprog house\b/, "house"],
  [/\belectro pop\b|\belectro swing\b/, "house"],
  [/\belectro house\b/, "house"],
  [/\belectro\b(?!\s+(?:pop|swing|house|hip hop))|\belectro funk\b|\bclassic electro\b/, "detroit"],
  [/\bbig beat\b|\bbreakbeat\b|\bnus?kool breaks\b/, "house"],
  [/\bmoombahton\b|\bmoombah(?:core|ton)?\b/, "house"],
  [/\bslap house\b|\bslaphouse\b|\bbrazilian bass\b/, "house"],
  // Gqom — the Durban broken-kick mutation (NO four-on-the-floor)
  [/\bgqom\b/, "house"],
  // Kuduro / batida — the Luanda carnival engine (half-time rap rides on
  // top as melody; "batida" is the Lisbon scene's name for the beat).
  [/\bkuduro\b|\bbatida\b/, "house"],
  // Tropical house — the beach lane (soft four-floor, marimba/steel pan).
  [/\btropical(?: house)?\b/, "house"],
  // Dembow dominicano BEFORE the generic dembow genre word — the rawer,
  // 16th-filled Santo Domingo lane (house.dembowdom).
  [/\bdembow dominicano\b|\bdominican dembow\b/, "house"],
  [/\bneoperreo\b|\bneo[- ]?perreo\b/, "house"],
  [/\bdarkwave\b|\bwitch house\b|\bwave music\b/, "ambient"],
  [/\bbedroom pop\b/, "ambient"],
  [/\blo-?fi house\b/, "house"],
  [/\bpost-?punk\b/, "techno"],
  [/\btrip hop\b|\btriphop\b|\bdowntempo\b|\bdown[- ]?tempo\b/, "ambient"],
  [/\bfuture bass\b/, "trap"],
  [/\bdrone\b/, "drone"],
  [/\bidm\b/, "ambient"],
  [/\bdeconstructed (?:club|music)\b/, "hyperpop"],
  [/\bvaporwave\b/, "ambient"],
  [/\bberlin school\b/, "techno"],
  [/\bkrautrock\b/, "techno"],
  // Shoegaze / dream pop / noise pop — the wall-of-guitars family rides
  // house.shoegaze (dedicated P2 groove). MUST sit above the generic \bpop\b
  // genre entry — "dream pop" contains it.
  [/\bshoegaze\b|\bdream ?pop\b|\bnoise ?pop\b/, "house"],
  // Reggae / ska / roots — the one-drop family (house.reggae groove).
  [/\breggae\b|\bska\b|\broots reggae\b|\bone drop\b/, "house"],
  // Post-rock / math rock - promoted to first-class genre (quiet-loud crescendo form).
  [/\bpost[- ]?rock\b|\bmath rock\b|\bpost-?metal\b|\bpostmetal\b/, "postrock"],
  // Chiptune / VGM - first-class genre (the sound-chip tradition). MUST sit
  // ABOVE the generic "game" absence and any "chip" word use. "tracker" is
  // the demoscene school; "8-bit" / "8 bit" are the colloquial names.
  [
    /\bchiptune\b|\bchip ?tune\b|\b8[- ]?bit\b|\bgame ?boy\b|\bvgm\b|\bnes music\b|\bbitpop\b|\bchip music\b/,
    "chiptune",
  ],
  // Eurodance - first-class genre (the 90s Euro-NRG tradition). "eurodance"
  // and "euro house" sit above the generic house entry; "hands up" is the
  // German school name. "eurobeat" is the Initial D / Avex lineage.
  [
    /\beurodance\b|\beuro ?dance\b|\beuro ?house\b|\beurobeat\b|\bhands ?up\b|\bdancecore\b|\beuro nrg\b|\bitalo dance\b|\btrancecore\b/,
    "eurodance",
  ],
  // Latin - first-class genre (the Afro-Caribbean + South American dance
  // tradition). Every school name is its own genre word; "latin" bare is
  // guarded so "latin pop" / "latin urban" keep their dembow lane.
  [
    /\bcumbia\b|\bmerengue\b|\bbachata\b|\bsalsa\b|\bmambo\b|\bbossa ?nova\b|\bbossanova\b|\bson cubano\b|\bmontuno\b|\btumbao\b|\bchachach[áa]\b|\bcha[- ]?cha[- ]?cha\b/,
    "latin",
  ],
  // Nu jazz / broken beat / boogie / balearic — depth lanes that ride
  // existing house-family grooves (broken / funky / organic).
  [/\bnu ?jazz\b|\bnu[- ]?jazz\b|\bnew jazz\b|\buk jazz\b|\bjazz fusion\b|\bacid jazz\b/, "house"],
  [/\bboogie\b|\bboogie funk\b|\bsynth funk\b/, "house"],
  [/\bbalearic\b|\bchillout\b|\bchill out\b/, "house"],
  // pop wave — specifics BEFORE the generic "pop" entry; all ride existing
  // genres (dance-pop base = house, pop-rap = trap). "bedroom pop" above stays
  // first (more specific). SK "pop" is indeclinable, "popovú" stem covered.
  [/\bpop rap\b|\bpop-rap\b/, "trap"],
  // Hyperpop — first-class genre since the hyperpop promotion: the hyper
  // grooves + drop-first song form + maximalist mix live under "hyperpop".
  // Bare "hyper" stays a style word (hyper drill / hyper beat keep drill/trap).
  [/\bhyper ?pop\b/, "hyperpop"],
  // disco pop wave — before the generic pop entries ("disco pop" contains
  // both words); rides house.disco. SK "disko" deaccented-safe.
  [/\bnu[- ]?disco\b|\bdisco pop\b|\bpop disco\b|\bdisco funk\b|\bitalo disco\b|\bdisco\b|\bdisko\b/, "house"],
  [/\bdance pop\b|\bdance-pop\b|\bpop dance\b/, "house"],
  [/\bsynth pop\b|\bsynth-pop\b|\bsynthpop\b|\belectropop\b|\belectro pop\b/, "house"],
  [/\bpop beat\b|\bpop song\b|\bpop music\b|\bpop\b|\bpopov\w*/, "house"],
  // canonical / generic
  [/\bdeep house\b/, "house"],
  [/\btech house\b/, "house"],
  [/\bfrench house\b/, "house"],
  // House history phrases MUST precede the generic "house" / "garage" entries:
  // "chicago house" and "garage house" would otherwise resolve to the base
  // floor with no era character. (Bare "chicago" stays OUT — it belongs to
  // Chicago rap/drill.)
  [/\bchicago house\b|\bchicago trax\b|\bchitown house\b/, "house"],
  [/\bgarage house\b|\bnew jersey house\b|\bny house\b|\bnew york house\b/, "house"],
  [/\bsoulful house\b|\bvocal house\b/, "house"],
  [/\bfilter house\b|\bfrench touch\b|\bfrench filter\b/, "house"],
  [/\bbig room\b/, "house"],
  [/\bhouse\b/, "house"],
  [/\bdeep\b/, "house"],
  [/\bgarage\b|\bukg\b|\buk garage\b/, "house"],
  [/\bjersey\b/, "jersey"], // first-class since the sound-quality pass (own grooves + kit)
  // Baltimore club — the parent sound, before the bare jersey entry would
  // never catch it ("bmore" has no other anchor).
  [/\bbaltimore(?: club)?\b|\bbmore(?: club)?\b/, "jersey"],
  [/\bafro\b|\bafrobeats?\b|\bafropop\b/, "house"],
  // African-roots wave — the foundational traditions ride house (the
  // afrobeats/kuduro route). Before the generic house entry.
  [/\bhighlife\b|\bsoukous\b|\bzouk\b|\bkizomba\b|\bcoup[ée]?[- ]d[ée]cal[ée]\b|\bcoupe ?decale\b/, "house"],
  // Folk / bluegrass / gospel — the Americana family rides house (the
  // countrypop route).
  [/\bbluegrass\b|\bgospel\b|\bfolk\b|\bfolkov\w*/, "house"],
  // Jazz proper — rides boombap (the jazz-break floor).
  [/\bbebop\b|\bbig ?band\b|\bswing jazz\b|\bjazz proper\b/, "boombap"],
  [/\breggaeton\b|\bdembow\b|\blatin(?:o|a)? pop\b|\bpop latino\b|\blatinsk\w* pop\b/, "house"],
  // Trance school compounds MUST sit above the techno acid/tech entries:
  // "acid trance" / "tech trance" are trance, not techno.
  [/\bacid trance\b|\btech trance\b|\btechtrance\b|\bprogressive trance\b|\bprog trance\b|\bdream trance\b/, "trance"],
  [/\btechno\b/, "techno"],
  [/\btech\b/, "techno"],
  [/\bacid\b/, "techno"],
  [/\bindustrial\b/, "techno"],
  [/\bdub techno\b|\bdubtech\b|\bdub\b/, "techno"],
  [/\bhardcore\b|\bgabber\b/, "techno"],
  // trap bap must sit ABOVE the bare \btrap\b entry — the hybrid carries the
  // boom-bap floor even though the phrase contains "trap".
  [/\btrap ?bap\b|\btrap-?bap\b|\bboombap trap\b/, "boombap"],
  [/\bdrill\b/, "drill"], // first-class since the sound-quality pass (own grooves + kit swap)
  [/\btrap\b/, "trap"],
  [/\bphonk\b|\bmemphis\b|\bmemfis\b/, "phonk"],
  // Boom bap — first-class genre with the full school tree (golden / jazz /
  // lofi / drumless / trapbap / modern). Specific phrases BEFORE the generic
  // hip-hop entry so "jazz rap" / "drumless" / "trap bap" keep their school.
  // "electro hip hop" is the 80s machine-funk lane (trap.oldschool), not
  // boom bap — it must sit ABOVE the boom-bap hip-hop entry.
  [/\belectro hip ?hop\b/, "trap"],
  [/\bjazz rap\b|\bjazz ?hop\b|\bjazzy hip ?hop\b|\bjazzy beat\b/, "boombap"],
  [/\bdrumless\b/, "boombap"],
  [/\bgriselda\b|\bconway\b|\bwestside gunn\b|\broc marciano\b|\bboldy james\b|\badam waun\b/, "boombap"],
  // "electro hip hop" / "lofi hip hop" keep their own legs — the guard keeps
  // bare hip-hop talk on the boom-bap floor.
  [
    /\bboombap\b|\bboom ?bap\b|\bhip ?hop\b(?! (?:soul|rock|experimental))|\b90s rap\b|\bgolden era\b|\beast coast rap\b/,
    "boombap",
  ],
  [/\bambient\b/, "ambient"],
  [/\blofi\b|\blo-?fi\b/, "ambient"],
  // Sad chill / dirty ambient are ambient-family asks with their own style
  // tokens — the genre word must be present or the style has nothing to
  // resolve against (same rule as amapiano / piano house above).
  [/\bsad ?chill\b|\bsadchill\b/, "ambient"],
  [/\bdirty ?ambient\b|\bdirtyambient\b/, "ambient"],
  [/\bscore\b|\bscene\b|\bsoundscape\b|\bcinematic\b/, "ambient"],
  [/\bdnb\b|\bdrum ?n ?bass\b|\bdrum and bass\b|\bjungle\b|\bliquid dnb\b/, "dnb"],
];

/**
 * Style phrases → canonical groove style names (resolveGroove expects these).
 * SK stems share the entry with EN where the meaning is identical.
 */
const STYLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  // ── Chiptune school tree — BEFORE every generic entry (a chip ask must
  // not be stolen by "pop" / "game" / "hard"). ─────────────────────────────
  [/\bnintendo\b|\bnes era\b|\boverworld\b|\bplatformer\b/, "nintendo"],
  [/\blsdj\b|\bgame ?boy pocket\b|\bhandheld chip\b/, "gameboy"],
  [/\bchip ?band\b|\bmodern chip\b|\blive chip\b/, "chipband"],
  [/\btown theme\b|\bending theme\b|\bsad chip\b|\bchip ballad\b|\bcity theme\b/, "ballad"],
  [/\bboss (?:battle|theme|fight)\b|\bvgm metal\b|\bfinal boss\b/, "boss"],
  [/\btracker\b|\bdemoscene\b|\bfasttracker\b|\bimpulse tracker\b/, "tracker"],
  // Bare genre words get the genre's default school (chiptune → nintendo,
  // matching the SONG_FORMS default and the artist lane).
  [
    /\bchiptune\b|\bchip ?tune\b|\b8[- ]?bit\b|\bvgm\b|\bnes music\b|\bbitpop\b|\bchip music\b|\bgame ?boy\b/,
    "nintendo",
  ],
  // ── Eurodance school tree (specific schools BEFORE the bare genre words) ─
  [/\bhappy eurodance\b|\beuphoric dance\b|\beuro happy\b|\bsupersaw dance\b/, "happy"],
  [/\bpitched[- ]?up vocal\b|\bgerman dance\b|\bhard hands\b|\bdancecore\b|\bhands ?up\b/, "handsup"],
  [/\btrancecore\b|\bdance melody\b|\b90s trance hit\b/, "trancecore"],
  [/\beuro ?nrg\b|\b90s (?:euro|dance)\b|\beuro classic\b|\bradio dance\b|\beurodance classic\b/, "nrg"],
  [/\beurodance\b|\beuro ?dance\b|\beuro ?house\b/, "nrg"],
  [/\bitalo dance\b|\bitalian floor\b|\bautotune hook\b|\bitalo[- ]?dance\b/, "italo"],
  [/\bfestival revival\b|\bmodern hands\b|\bbig room hands\b/, "hands"],
  // ── Latin school tree ───────────────────────────────────────────────────
  [/\bsonidera\b|\bcolombian cumbia\b|\bguiro\b|\bcumbia sonidera\b|\bcumbia\b/, "cumbia"],
  [
    /\btambora\b|\bdominican two[- ]?feel\b|\bpambiche\b|\bmerengue tipico\b|\bperico ripiao\b|\bmerengue\b/,
    "merengue",
  ],
  [/\bderecho\b|\bbongo[- ]?led\b|\bdominican romance\b|\bbachata romantica\b|\bbachata\b/, "bachata"],
  [/\bson clave\b|\btumbao\b|\bmontuno\b|\bcuban son\b|\bsalsa dura\b|\btimba\b|\bsalsa\b/, "salsa"],
  [/\bbig[- ]?band latin\b|\bcowbell latin\b|\bdescarga\b|\bprado\b|\bmambo\b/, "mambo"],
  [/\bbrazilian cool\b|\btwo[- ]?bar rim\b|\bbrushed latin\b|\bbossa cool\b|\bbossa ?nova\b|\bbossanova\b/, "bossa"],
  // ── Depth-lane guards: most-specific-first, before every generic entry ──
  // Synthwave family — BEFORE "driving" ("synthwave night drive" would
  // otherwise be stolen by \bdrive\b). ambient.synthwave is the real pocket.
  [/\bsynthwave\b|\bretrowave\b|\bdarksynth\b|\boutrun\b|\bnight drive\b/, "synthwave"],
  // "lofi hip hop" is the ambient study-beats lane (genre entry above pins
  // ambient) — its style must be drifting, not the boom-bap lofi token.
  [/\blofi hip ?hop\b/, "drifting"],
  // Shoegaze / dream pop — BEFORE \bpop\b ("dream pop" contains "pop").
  // house.shoegaze is the dedicated wall-of-guitars groove (P2 wave).
  [/\bshoegaze\b|\bdream ?pop\b|\bnoise ?pop\b/, "shoegaze"],
  // Post-rock school tree - specific school phrases BEFORE the generic post-rock style entry.
  [/\bcrescendo\b|\bcinematic post[- ]?rock\b/, "crescendo"],
  [/\borchestral post[- ]?rock\b|\bchamber post[- ]?rock\b/, "orchestral"],
  [/\bpost-?metal\b|\bpostmetal\b/, "postmetal"],
  [/\bmath rock\b/, "math"],
  [/\bambient post[- ]?rock\b/, "ambient"],
  [/\bpost[- ]?rock\b/, "textured"],
  // Reggae / ska / one-drop — BEFORE the generic \bdub\b entry. house.reggae
  // is the dedicated one-drop groove (kick+snare on 3, empty beat 1).
  [/\breggae\b|\bska\b|\broots reggae\b|\bone drop\b|\breggae dub\b/, "reggae"],
  // Nu jazz / broken beat — the West London school (house.broken groove).
  [/\bnu ?jazz\b|\bnu[- ]?jazz\b|\bnew jazz\b|\buk jazz\b|\bjazz fusion\b|\bacid jazz\b/, "broken"],
  // Balearic / chillout — the sunset lane (house.organic groove).
  [/\bbalearic\b|\bchillout\b|\bchill out\b/, "organic"],
  // Chillhop / study beats — BEFORE the boom-bap lo-fi entry ("chillhop" and
  // "study beats" ride the ambient drifting pocket, matching the Nujabes
  // artist lane). "lofi hip hop" keeps its boombap.lofi reading below.
  [/\bchill ?hop\b|\bstudy beats?\b/, "drifting"],
  [/\bdriving\b|\bdrive\b/, "driving"],
  [/\bminimal(?:ny)?\b|\bminimalistick/, "minimal"],
  [/\bbaile\b|\bmandel\w*\b/, "bounce"],
  // Piano house MUST sit before the generic "piano" handling — the style
  // token is what resolveGroove looks up ("house.pianohouse").
  [/\bpiano house\b|\bpianohouse\b/, "pianohouse"],
  // Breakbeat / big beat before \bbreaks\b-adjacent entries.
  // Breakbeat hardcore is its own Eurodance lane, not generic breakbeat.
  [/\bbreakbeat\s+hardcore\b/, "bhc"],
  [/\bbreakbeat\b|\bbig ?beat\b/, "breakbeat"],
  [/\bmidtempo\b|\bmid[- ]?tempo\b/, "midtempo"],
  // Sad chill / dirty ambient — the ambient-family style tokens.
  [/\bsad ?chill\b|\bsadchill\b|\bemotional chill\b/, "sadchill"],
  [/\bdirty ?ambient\b|\bdirtyambient\b|\bcorroded ambient\b/, "dirtyambient"],
  // Disco BEFORE the g-funk/funky entries — "disco funk" must resolve to the
  // disco groove, not be stolen by \bfunk\b.
  [/\bnu[- ]?disco\b|\bdisco\b|\bdisko\b/, "disco"],
  // Electronic depth wave — these MUST sit above the generic \bfunk\b /
  // \bdeep\b word matches ("electro funk", "deep dubstep"): psytrance above
  // trance (more specific groove), trance above progressive (so "progressive
  // trance" rides the trance groove), and "electro swing / house / pop /
  // hip hop" keep their own lanes before bare "electro" (Detroit machine
  // funk, NOT electro house).
  // Trance school tree — specific school phrases BEFORE the generic entries.
  // "acid trance" / "tech trance" / "progressive trance" must not be stolen
  // by the techno/house acid/tech/progressive lanes.
  [/\bacid trance\b/, "acid"],
  [/\btech trance\b|\btechtrance\b/, "tech"],
  [/\bprogressive trance\b|\bprog trance\b/, "progressive"],
  [/\bdream trance\b/, "dream"],
  [/\bpsytrance\b|\bpsy trance\b|\bgoa\b|\bfull[- ]?on\b/, "psy"],
  [/\buplifting trance\b|\bvocal trance\b|\banthem trance\b|\btrance\b/, "uplifting"],
  [/\bprogressive\b|\bprog\b/, "progressive"],
  // UK funky BEFORE \bfunky\b — "uk funky" is the soca-bounce lane, not the
  // funky house groove ("uk funky" itself genre-routes to the ukg lane).
  [/\buk ?funky\b|\bukfunky\b/, "ukfunky"],
  // Amapiano school tree — specific school words BEFORE the generic amapiano
  // style entry. "yanos" is the core sound; "s'gija" the stripped pocket.
  [/\bprivate school piano\b|\bsoulful amapiano\b/, "soulful"],
  // Drone / neo-classical school tree - specific school words BEFORE the
  // generic drone style entry. "neoclassical" is the piano-and-strings school.
  [/\bneoclassical\b|\bneo[- ]?classical\b|\bmodern classical\b/, "neoclassical"],
  [/\bminimalism\b|\bsteve reich\b/, "minimalism"],
  [/\bisolationism\b|\bisolationist\b/, "isolationism"],
  [/\belectroacoustic\b|\bmodular drone\b/, "electroacoustic"],
  [/\bfilm score\b|\borchestral score\b|\bmodern score\b|\bmain title\b/, "score"],
  [/\bdrone\b/, "drone"],
  [/\bs'?gija\b/, "sgija"],
  [/\bnew age bacardi\b/, "bacardi"],
  [/\bquantum sound\b/, "quantum"],
  [/\bpopiano\b/, "popiano"],
  [/\bamapiano\b|\byanos\b|\bafropiano\b/, "yanos"],
  // Jungle BEFORE the generic "jungle → dnb style" entry — the chopped-breaks
  // groove, not a random dnb pocket. Bare "ragga" (no "jungle" word) routes to
  // dnb.ragga below, so the two lanes stay distinct.
  [/\bjungle\b|\bragga jungle\b|\braggajungle\b/, "jungle"],
  // DnB depth wave (2026-09-27): the sub-genres the genre sweep only routed
  // to "dnb" now have their own grooves. Specifics BEFORE the generic family
  // entries below (neurofunk/jumpup/dancefloor/roller/amen/twostep).
  [/\btechstep\b|\btech step\b|\bdarkstep\b|\bdark step\b|\bmetalheadz\b|\bno u-?turn\b/, "techstep"],
  [/\bragga\b|\bdancehall (?:dnb|drum ?n ?bass)\b|\bjunglist\b|\bsoundsystem\b/, "ragga"],
  [/\bsambass\b|\bsamba (?:dnb|bass)\b|\bbrazilian dnb\b/, "sambass"],
  [/\bhalf[- ]time\b/, "halftime"],
  [/\bcrossbreed\b|\bdarkcore\b|\bdark core\b|\bhardcore dnb\b/, "crossbreed"],
  [/\bminimal dnb\b|\bautonomic\b|\bdeep dnb\b|\bliquid roller\b/, "minimal"],
  // Baltimore — the "Think"-break stomp (jersey.baltimore), above the club
  // family's generic readings.
  [/\bbaltimore(?: club)?\b|\bbmore(?: club)?\b/, "baltimore"],
  [/\belectro swing\b/, "funky"],
  [/\belectro house\b/, "dancefloor"],
  [/\belectro\b(?!\s+(?:pop|swing|house|hip hop))|\belectro funk\b/, "electro"],
  [/\bdeep dubstep\b|\buk dubstep\b|\b140 dubstep\b|\bdeep dub\b/, "deepdubstep"],
  // Brostep / bass dubstep — the drop-era lane (trap.bassdubstep, P2 wave).
  [/\bbrostep\b|\bbass ?dubstep\b|\bbass music\b|\btearout dubstep\b/, "bassdubstep"],
  // West Coast / G-funk (MUST sit above the generic "funk" entry — \bfunk\b
  // matches inside "g-funk" because '-' is a non-word char). SK stems
  // deaccented.
  [/\bg[ -]?funk\b|\bgfunk\b|\blow ?rider\b/, "gfunk"],
  // Boogie funk BEFORE the generic \bfunk\b — the early-80s synth-funk lane
  // rides house.funky; "funk" bare stays the funky-house reading.
  [/\bboogie\b|\bboogie funk\b|\bsynth funk\b/, "funky"],
  [/\bfuture ?funk\b/, "futurefunk"],
  [/\bfunky\b|\bfunk\b/, "funky"],
  [/\bdeep\b|\bhlbok/, "deep"],
  // Afroswing BEFORE the generic afro entry — "afro swing" contains the
  // word "afro" and would otherwise be stolen by it.
  [/\bafro ?swing\b/, "afroswing"],
  // Afropop BEFORE the generic afro entry — "afro pop" / "afrobeats" ride the
  // Wizkid/Burna pop pocket (house.afropop), not the afro-house groove.
  [/\bafro ?pop\b|\bafropop\b|\bafrobeats?\b/, "afropop"],
  // Afro tech BEFORE the generic afro entry — the harder club end of the
  // modern afro house range, riding the organic groove.
  [/\bafro ?tech\b|\bafrotech\b/, "organic"],
  // G-house — the groove existed (house.ghouse) but the style phrase never
  // did; bare "g-house" used to fall into a random house pocket.
  [/\bg[- ]house\b|\bghouse\b|\bghetto house\b/, "ghouse"],
  [/\bfuture garage\b/, "future garage"],
  // Overmono school (house.broken groove) — before generic matches that
  // would steal the word
  [/\bbroken(?: beat)?\b/, "broken"],
  [/\bukg\b|\buk garage\b|\bgarage\b/, "ukg"],
  [/\bafro\b/, "afro"],
  // Dembow / latin pop — the reggaeton chop (house.dembow). SK "latinský".
  // Dembow dominicano / neoperreo sit ABOVE it: the rawer 16th-filled Santo
  // Domingo lane, and the DIY deconstructed alias (same chop, harder attitude).
  [/\bdembow dominicano\b|\bdominican dembow\b/, "dembowdom"],
  [/\bneoperreo\b|\bneo[- ]?perreo\b/, "dembow"],
  [/\bdembow\b|\breggaeton\b|\blatin(?:o|a)? pop\b|\bpop latino\b|\blatinsk\w* pop\b/, "dembow"],
  // Country pop — the train-beat lane (house.countrypop); "country rap /
  // trap / tune" keep their trap.countrytune routing below.
  [/\bcountry pop\b|\bpop country\b|\bcountrypop\b|\bnashville pop\b/, "countrypop"],
  // Big beat / moombahton / slap house — unique words, no generic collisions.
  [/\bbig beat\b|\bbreakbeat\b|\bnus?kool breaks\b/, "bigbeat"],
  [/\bmoombahton\b/, "moombahton"],
  [/\bgqom\b/, "gqom"],
  [/\bslap house\b|\bslaphouse\b|\bbrazilian bass\b/, "slaphouse"],
  // Kuduro / batida + tropical — unique words, no generic collisions.
  [/\bkuduro\b|\bbatida\b/, "kuduro"],
  [/\btropical(?: house)?\b/, "tropical"],
  // African-roots wave lanes (ride house).
  [/\bhighlife\b/, "highlife"],
  [/\bsoukous\b|\bcongolese rumba\b/, "soukous"],
  [/\bzouk\b|\bzouk ?love\b/, "zouk"],
  [/\bkizomba\b|\btarraxinha\b/, "kizomba"],
  [/\bcoup[ée]?[- ]d[ée]cal[ée]\b|\bcoupe ?decale\b/, "coupledecale"],
  // Folk family lanes (ride house).
  [/\bbluegrass\b|\bnewgrass\b/, "bluegrass"],
  [/\bgospel\b|\bworship\b/, "gospel"],
  [/\bfolk\b|\bfolkov\w*/, "folk"],
  // Jazz proper + turntablism lanes (ride boombap). "swing" as a BARE word
  // stays the swing-feel style modifier — only compounds claim the lane.
  [/\bbebop\b/, "bebop"],
  [/\bbig ?band\b/, "bigband"],
  [/\bswing jazz\b/, "swing"],
  [/\bturntablism\b|\bturntablist\b/, "turntablism"],
  // Bass-exotics lanes.
  [/\bcomplextro\b/, "complextro"],
  [/\bmelbourne bounce\b|\bmelbourne\\?b[ou]unce\b|\bbounce house\b/, "melbournebounce"],
  [/\bglitch ?hop\b/, "glitchhop"],
  // Balkan lanes (ride eurodance).
  [/\bturbo ?folk\b/, "turbofolk"],
  [/\bchalga\b|\bchalgov\w*/, "chalga"],
  [/\bmanele\b|\bmanea\w*/, "manele"],
  // Emo / digicore lanes.
  [/\bdigicore\b/, "digicore"],
  [/\bdariacore\b/, "dariacore"],
  [/\bemo ?rap\b|\bsadcore ?rap\b/, "emorap"],
  // Niche lanes.
  [/\bdungeon ?synth\b/, "dungeonsynth"],
  [/\bsingeli\b|\bsengele\b/, "singeli"],
  [/\bmahragan\w*/, "mahraganat"],
  [/\bmakina\b/, "makina"],
  [/\bhard ?wave\b/, "hardwave"],
  [/\bslowcore\b|\bsadcore\b/, "slowcore"],
  // Eurodance family completion.
  [/\beurobeat\b/, "eurobeat"],
  [/\bold ?skool rave\b|\boldschool rave\b|\brave breaks?\b/, "rave"],
  // Rock styles — the verse/pre-chorus/chorus form rides via
  // ROCK_FORM_STYLES in the song builder.
  [/\bgrunge\b/, "grunge"],
  [/\balt(?:ernative)? ?rock\b|\baltrock\b/, "altrock"],
  [/\brapcore\b|\bnu ?metal\b|\brap ?metal\b/, "rapcore"],
  [/\bsynth[- ]?punk\b/, "synthpunk"],
  // Metal + punk + indie depth — metalcore/thrash/doom before the generic
  // \bmetal\b match (the compound words have no boundary so plain \bmetal\b
  // never splits them; order keeps it that way deliberately).
  [/\bmetalcore\b/, "metalcore"],
  [/\bthrash\b/, "thrash"],
  [/\bdoom(?: metal)?\b/, "doom"],
  [/\bheavy metal\b|\bmetal\b/, "metal"],
  // Hard-dance family BEFORE the punk-hardcore entry — "hardcore techno"
  // contains "hardcore" and would otherwise be stolen by hardcorepunk.
  // Bare "hardcore" keeps the punk reading (deliberate; see genre table).
  [/\bhardstyle\b|\bhard style\b/, "hardstyle"],
  // Gabber family BEFORE the punk-hardcore entry. "hardcore techno" and
  // friends ride techno.gabber (the dedicated 160-180 stomp, P2 wave);
  // bare "hardcore" below keeps the punk reading (deliberate).
  [/\bhardcore techno\b|\bhappy hardcore\b|\bfrenchcore\b|\bterrorcore\b|\bspeedcore\b|\bhardcore rave\b/, "gabber"],
  [/\bgabber\b|\buptempo\b/, "gabber"],
  [/\bhardcore(?: punk)?\b/, "hardcorepunk"],
  [/\bpop[- ]?punk\b/, "poppunk"],
  [/\bindie(?: rock)?\b/, "indie"],
  // Ghettotech — Detroit's banging 808 bounce (house.ghettotech); the genre
  // word already routes to house via the g-house entry above.
  // Detroit school tree — specific school phrases BEFORE the generic
  // electro/genre entries. "detroit techno" / "detroit electro" genre-route
  // ABOVE; these carry the style token.
  [/\bghetto ?tech\b|\bghettotech\b/, "ghettotech"],
  // Detroit school tree.
  [/\bbelleville\b|\bbelleville three\b/, "belleville"],
  [/\bunderground resistance\b|\bur second wave\b/, "secondwave"],
  [/\btechno ?bass\b/, "technobass"],
  [/\bdetroit electro\b|\bcybotron\b/, "electro"],
  [/\bminimal nation\b/, "minimal"],
  // Alté — the Lagos alternative lane (R&B/soul-tinged afrobeats) on the
  // afropop pocket.
  [/\balte\b/, "afropop"],
  [/\bindustrial(?:ny)?\b|\bpriemysel/, "industrial"],
  [/\bdub\b/, "dub"],
  [/\bacid\b/, "acid"],
  [/\bclassic\b|\btraditional\b|\bklasick|\bretro\b|\bvintage\b|\bnostalgick|\bstaromodn/, "classic"],
  // Boom bap school tree — specific school words BEFORE the generic
  // classic/match entries. "golden" is bare-qualified ("golden era") so it
  // never hijacks "golden" as a colour word.
  [/\bgolden era\b|\bgolden age\b|\bpremier type\b|\bpreemo\b/, "golden"],
  [/\bdrumless\b|\balchemist type\b/, "drumless"],
  [/\btrap ?bap\b|\btrap-?bap\b/, "trapbap"],
  [/\blo-?fi (?:boom ?bap|rap|hip ?hop)\b|\bdilla\b|\bmadlib style\b|\boff-?kilter\b/, "lofi"],
  [/\bjazz rap\b|\bjazz ?hop\b|\bjazzy\b/, "jazz"],
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
  // ── Dedicated lanes from the P2 wave (docs/VOCABULARY-GAP-RESEARCH.md) ──
  // Trip-hop / downtempo: ambient.triphop — the dusty halftime pocket.
  [/\btrip[- ]?hop\b|\bdowntempo\b|\bdown[- ]?tempo\b/, "triphop"],
  // Breakcore: chopped amens at DnB tempo (dnb.amen is the real pocket).
  [/\bbreakcore\b|\bbreak ?core\b|\bglitch ?core\b|\bdigital hardcore\b/, "amen"],
];

/** Rap flow grid phrases → IntentSpec.flow (multi-voice lead reshaper).
 *  Separate from STYLE_PHRASES — a flow ask rides on top of any genre. */
const FLOW_PHRASES: ReadonlyArray<readonly [RegExp, "triplet" | "offbeat" | "straight"]> = [
  [/\btriplet(?:y|ový|ovy)? flow\b|\btriplety\b/, "triplet"],
  [/\boff(?:-)?beat flow\b|\boffbeatový flow\b|\boffbeatovy flow\b/, "offbeat"],
  [/\bstraight flow\b/, "straight"],
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
    /\b(?:no|without)\s+(?:(?:the|my|a|an)\s+)?(?:drums?|kick|snare|hi[\s-]?hats?|hats?|cymbals?|claps?|percussion)\b|\b(?:drum|kick|snare|hat)-?less\b|\bbez (?:dalsich\s+)?(?:bubn\w*|bic\w*|kopak\w*|snare|hi[\s-]?hat\w*|hat\w*|cymbal\w*|clap\w*|percussion|rytmu)\b|\b(?:ziaden|ziadny|ziadna|ziadne)\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)\b|\bnula\s+(?:bicie|beat|bubn|bicia|rytmu|rytm)/,
    "nodrums",
  ],
  [
    /\b(?:no|without)\s+(?:(?:the|my|a|an)\s+)?(?:bass(?:line)?|808s?|sub(?:bass)?)\b|\b(?:bass|sub|808)-?less\b|\bbez (?:bas\w*|808|sub\w*)/,
    "nobass",
  ],
  [
    /\b(?:no|without)\s+(?:(?:the|my|any|a|an)\s+)?(?:chords?|pads?|stabs?|keys?)\b|\bchordless\b|\bbez (?:akord\w*|pad\w*|klaves\w*)/,
    "nochords",
  ],
  [
    /\b(?:no|without)\s+(?:(?:the|my|any|a|an)\s+)?(?:lead|melody|synths?|arps?|arpeggios?|topline|top line)\b|\b(?:lead|melody|synth)-?less\b|\bbez (?:lead\w*|melodi\w*|synth\w*|arp\w*)/,
    "nolead",
  ],
  [/\bdrums only\b|\bbeat only\b|\bpercussion only\b|\b(?:len|iba) (?:bubn|bic)/, "drumsonly"],
  [/\bmelody only\b|\bno drums just melody\b|\b(?:len|iba) melodi/, "melodyonly"],
  [/\bfull beat\b|\beverything\b|\bfull arrangement\b|\bcely (?:beat|bit)\b|\bvsetko/, "all"],
  [/\bdrums\b|\bthe beat\b|\bpercussion\b|\bkick\b|\bbubn|\bbic|\bbicia\b/, "drums"],
  [/\bbass\b|\b808\b|\bsub\b|\bbas(?:a|u|y|ou|ov)?\b/, "bass"],
  [/\bchords\b|\bpads\b|\bstabs\b|\bkeys\b|\bakord/, "chords"],
  [/\blead(?:om|u|a)?\b|\bmelody\b|\barp\b|\barpeggio\b|\btopline\b|\btop line\b|\bsynth\b|\bmelodi/, "lead"],
];

const PROHIBITION_FLAGS: Readonly<Record<string, IntentRole>> = {
  nodrums: "drums",
  nobass: "bass",
  nochords: "chords",
  nolead: "lead",
};

const PROHIBITION_DETECTED_LABEL: Readonly<Record<IntentRole, string>> = {
  drums: "no drums",
  bass: "no bass",
  chords: "no chords",
  lead: "no lead",
};

const ALL_INTENT_ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];

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
  [/^(?:bubn|bic|bicia|drums?|beat|kick|kopak|snare|hihat|hats?|cymbal|clap|percussion)/, "drums"],
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
  const clause = lower
    .slice(trigger.index + trigger[0].length)
    // Treat the common compound as one role alias before punctuation-based
    // tokenization splits "hi-hat" into an unrecognized "hi" + "hat".
    .replace(/\bhi[\s-]?hats?\b/g, " hihat ");
  for (const word of clause.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (PRESERVE_NEGATIONS.has(word)) return [];
    if (PRESERVE_DETERMINERS.has(word)) continue;
    if (PRESERVE_CONJUNCTIONS.has(word)) {
      conjunction = true;
      continue;
    }
    const role = /^808s?$/.test(word) ? "bass" : PRESERVE_ROLE_STEMS.find(([re]) => re.test(word))?.[1];
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

export type ParsedIntentConflictKind =
  "prohibition-vs-addition" | "preserve-vs-addition" | "prohibition-vs-preserve" | "prohibition-vs-scope";

export interface ParsedIntentConflict {
  /** Stable key for diagnostics and UI rendering; not persisted to projects. */
  id: string;
  role: IntentRole;
  kind: ParsedIntentConflictKind;
}

const ROLE_ADD_ACTION = /\b(?:add|generate|create|include|bring\s+in|pridaj|pridat|vygeneruj|vytvor|dopln)\b/g;
const ROLE_MENTION_PATTERNS: ReadonlyArray<readonly [RegExp, IntentRole]> = [
  [/\b(?:drums?|kick|snare|hi[\s-]?hats?|hats?|cymbals?|claps?|percussion|kopak|bubn\w*|bic\w*|bicia)\b/g, "drums"],
  [/\b(?:bass|808s?|sub(?:bass)?|basa|basu|basy|basou|basov)\b/g, "bass"],
  [/\b(?:chords?|pads?|stabs?|keys?|akord\w*)\b/g, "chords"],
  [/\b(?:leads?|melody|melodi\w*|synths?|arps?|topline|top\s+line)\b/g, "lead"],
];

/**
 * Find role mentions that are explicitly being added/generated. This is
 * deliberately narrower than the general role parser: a fader/mix request
 * such as "make the bass deeper" must not be mistaken for a generation ask.
 */
function explicitlyAddedRoles(text: string): Set<IntentRole> {
  const actionText = ` ${deaccent(text).toLowerCase().replace(/\s+/g, " ")} `;
  const roles = new Set<IntentRole>();
  for (const action of actionText.matchAll(ROLE_ADD_ACTION)) {
    const tail = actionText.slice((action.index ?? 0) + action[0].length);
    const boundary =
      /[;.!?]|\b(?:but|however|while|except|ale|len|iba|keep|leave|nechaj|ponechaj|without|no|bez)\b/.exec(tail);
    const clause = tail.slice(0, boundary?.index ?? Math.min(tail.length, 96));
    for (const [pattern, role] of ROLE_MENTION_PATTERNS) {
      if (pattern.test(clause)) roles.add(role);
      pattern.lastIndex = 0;
    }
  }
  return roles;
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
  /** Roles explicitly excluded by the brief; independent from generation defaults. */
  prohibitedRoles: IntentRole[];
  /** Explicit role-level contradictions that need user clarification. */
  conflicts: ParsedIntentConflict[];
}

/** Find the first phrase (by list order = specificity) present in the text. */
function firstPhrase(phrases: ReadonlyArray<readonly [RegExp, string]>, text: string): string | null {
  for (const [re, value] of phrases) {
    if (re.test(text)) return value;
  }
  return null;
}

/** Typed variant for phrase tables with a narrow value union (FLOW_PHRASES). */
function firstFlowPhrase(text: string): "triplet" | "offbeat" | "straight" | null {
  for (const [re, value] of FLOW_PHRASES) {
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

  // The RAW text is the input to the semantic (embedding-conditioned) prior:
  // `normalizeIntent` caps it at MAX_TEXT_LENGTH. Without it here,
  // `semanticConditioning(intent.text)` is null for every UI request, the v2/v3
  // priors are skipped, and `supportsDrumPrior` falls back to the v1 one-hot —
  // which only covers a small slice of the groove library. That is why the
  // multi-vibe blend above keeps both artist names in the text: the blend has
  // to reach MiniLM for the conditioning to see it.
  const input: IntentInput = { text };

  // Prime the semantic embedding channel now (fix C) rather than waiting for
  // the provider to ask. Between parse and generate the groove is resolved and
  // the whole candidate bank is built, so the ~118 MB model would still be
  // loading when the one call that needs it arrives — and 88% of grooves are
  // outside PRIOR_STYLE_VOCAB, so the v3 channel is the only thing keeping
  // those runs off the template fallback. Fire-and-forget; the provider still
  // calls semanticConditioningForIntent on the normal path, so this is purely
  // a head start, never a correctness dependency.
  // Lazy: a static import would pull the semantic client into the landing
  // route's static closure, which the client itself is built to avoid.
  void import("./semantic-conditioning").then((module) => module.primeSemanticForText(text)).catch(() => undefined);

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
    if (blend.patch.artist) input.artist = blend.patch.artist;
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
      // The label keys the artist mix-signature table (artist-mix.ts) —
      // "drake type beat" carries the drake mix/master character.
      input.artist = preset.label;
      // Artist flow default (flow density) — the FLOW_PHRASES pass below
      // runs later and overwrites when the user typed a flow word.
      if (preset.flow) input.flow = preset.flow;
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
  // Rap flow grid (flowDensity): "triplet flow" / "offbeat flow" reshapes
  // the lead/hook rhythm in multi-voice generation. Separate from style —
  // a flow ask rides on top of any genre.
  const flow = firstFlowPhrase(masked);
  if (flow) {
    input.flow = flow;
    detected.push(`${flow} flow`);
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
  let scopeOrNegation = false;
  const roles = new Set<IntentRole>();
  const prohibited = new Set<IntentRole>();
  const explicitlyScopedRoles = new Set<IntentRole>();
  for (const [re, flag] of ROLE_PHRASES) {
    if (!re.test(lower)) continue;
    const prohibitedRole = PROHIBITION_FLAGS[flag];
    if (prohibitedRole) {
      scopeOrNegation = true;
      prohibited.add(prohibitedRole);
      roles.delete(prohibitedRole);
    } else if (flag === "drumsonly") {
      scopeOrNegation = true;
      roles.clear();
      roles.add("drums");
      explicitlyScopedRoles.add("drums");
    } else if (flag === "melodyonly") {
      scopeOrNegation = true;
      roles.clear();
      roles.add("lead");
      explicitlyScopedRoles.add("lead");
    } else if (flag === "all") {
      scopeOrNegation = true;
      roles.add("drums");
      roles.add("bass");
      roles.add("chords");
      roles.add("lead");
      ALL_INTENT_ROLES.forEach((role) => explicitlyScopedRoles.add(role));
    } else {
      const role = flag as IntentRole;
      if (prohibited.has(role) || preserved.has(role)) continue;
      roles.add(role);
    }
  }
  // A mention that only NAMESED a protected role ("keep my drums but darker")
  // is not a generation directive — the default generation set still applies
  // (minus the protected roles, via input.preserve).
  if (scopeOrNegation || roles.size > 0) {
    const resolved = [...roles].filter((role) => !prohibited.has(role));
    // A prohibition with no explicit positive scope defaults to every
    // remaining role. Never let the fallback re-introduce an excluded role.
    input.roles =
      resolved.length > 0
        ? (resolved as IntentRole[])
        : scopeOrNegation
          ? ALL_INTENT_ROLES.filter((role) => !prohibited.has(role))
          : (["drums", "bass"] as IntentRole[]);
  }
  for (const role of prohibited) detected.push(PROHIBITION_DETECTED_LABEL[role]);
  if (preserved.size > 0) {
    input.preserve = [...preserved];
    for (const role of preserved) detected.push(`preserve ${role}`);
  }

  const conflicts: ParsedIntentConflict[] = [];
  const conflictIds = new Set<string>();
  const addConflict = (role: IntentRole, kind: ParsedIntentConflictKind) => {
    const id = `${kind}:${role}`;
    if (conflictIds.has(id)) return;
    conflictIds.add(id);
    conflicts.push({ id, role, kind });
  };
  for (const role of explicitlyAddedRoles(text)) {
    if (prohibited.has(role)) addConflict(role, "prohibition-vs-addition");
    if (preserved.has(role)) addConflict(role, "preserve-vs-addition");
  }
  for (const role of explicitlyScopedRoles) {
    if (prohibited.has(role)) addConflict(role, "prohibition-vs-scope");
  }
  for (const role of preserved) {
    if (prohibited.has(role)) addConflict(role, "prohibition-vs-preserve");
  }

  // Current production profiles contain trap-family melodic arrangements;
  // an explicit genre override should not accidentally carry one into a
  // different genre.
  if (input.genre !== undefined && input.genre !== "trap") delete input.productionProfile;

  return { input, detected, prohibitedRoles: [...prohibited], conflicts };
}

/**
 * AMBIGUITY CANDIDATES (lane chips) — every style lane the prompt touches,
 * in parser-priority order (the first one IS what the engine picked; the
 * rest are the honest alternatives a chip can offer). Mirrors the parse
 * pipeline exactly: deaccent → artist masking → the style table. Genre is
 * not resolved here on purpose — the chips ride the parsed genre.
 */
export function styleCandidatesForPrompt(text: string): string[] {
  const lower = ` ${deaccent(text)
    .replace(/[\s,.]+/g, " ")
    .trim()} `;
  const maskNames = matchAllArtistPresets(lower)
    .slice(0, 2)
    .map((m) => m.matched)
    .filter((name) => !isDescriptorName(name));
  const masked = maskNames.length > 0 ? maskArtistNames(lower, maskNames) : lower;
  const candidates: string[] = [];
  for (const [re, style] of STYLE_PHRASES) {
    if (re.test(masked) && !candidates.includes(style)) candidates.push(style);
  }
  return candidates;
}
