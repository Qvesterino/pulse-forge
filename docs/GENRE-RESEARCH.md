# Genre Research Catalog

> Provenance for every sub-genre lane in the intent engine: where the tempo
> claims come from, what defines the groove rhythmically, and — just as
> important — which parts are **researched** and which are **estimates**.
> Consumed by anyone adding lanes: future waves start here, not from memory.
>
> Companion to `docs/CURRENT-STATE.md` (counts) and `INTENT_ENGINE.md`
> (engine mechanics). Grooves live in `src/ai/grooves/`, parser phrases in
> `src/intent/text-parser.ts`, artist lanes in `src/intent/artists.ts`.

## The three confidence layers

Every lane is built from three layers of certainty. The catalog marks which
layer each claim comes from:

| Layer            | Meaning                                     | Source quality                                                                                      |
| ---------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **L1 — tempo**   | BPM pocket + real-track anchors             | Researched (Wikipedia, SongBPM, MixGraph, Tunebat, Beatport, RBMA, artist guides). Strongest layer. |
| **L2 — mapping** | Which existing groove/kit carries the style | Interpretation — the closest honest fit inside the groove engine.                                   |
| **L3 — sliders** | energy / density / mood / swing             | Estimate. Weakest layer — the preset is a BASE and explicit user words always win.                  |

Rules the catalog enforces:

- **Track anchors beat ranges.** A lane entry lists 2–3 real tracks with
  (approximate) BPMs. Ranges without anchors are marked as estimates.
- **Numbers and descriptions only.** We never ingest audio, riffs or
  copyrighted material — grooves are original patterns informed by
  _described_ rhythmic features.
- **Batch research, store immediately.** The search budget is limited
  (weekly quota); findings land in this file the same session so they are
  never searched twice.
- **Anchors marked `~` are approximate** (common community values, not
  verified against a specific source in this repo).

---

## Pop lanes

| Groove             | BPM                      | Track anchors                                                                                                                                 | Signature rhythm                                                                                   | Sources                           | Layers           |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------- |
| `house.disco`      | 112–124, swung           | (Good Times) Chic ~120, (Le Freak) Chic ~122                                                                                                  | octave-bass walk, offbeat open hats, layered snare+clap, shaker pulse                              | Wikipedia, Beatportal             | L1 ✅ L2 ✅ L3 ◐ |
| `house.dembow`     | 88–100                   | (Despacito) Fonsi ~96, (Hips Don't Lie) Shakira ~99                                                                                           | the chop: rim-snare on the "and" of 1 and 3, half-time kick                                        | heuron dembow guide, Billboard    | L1 ✅ L2 ✅ L3 ◐ |
| `house.dembowdom`  | 100–112                  | dembow dominicano runs 90–110 but _feels_ faster — every 16th filled; club/DJ convention often renders El Alfa-type beats at ~128 double-time | dense chop + kick pickups, perreo frenético                                                        | heuron, dj-pool.org               | L1 ✅ L2 ✅ L3 ◐ |
| `house.countrypop` | 96–126, swung            | (Man! I Feel Like a Woman) Shania ~108, (Love Story) Swift ~119                                                                               | train-beat boom-chicka: kick 1/3, backbeat 2/4, shaker 16ths, rim chicka                           | SongBPM-type values               | L1 ◐ L2 ✅ L3 ○  |
| `house.afropop`    | 98–112, swung 0.16       | (Essence) Wizkid ~102, (Last Last) Burna ~99, (Calm Down) Rema ~100                                                                           | 3+3+2 kick cross-rhythm, rim melody, sparse snare on 3                                             | Afroplug, genre guides            | L1 ◐ L2 ✅ L3 ◐  |
| `house.kuduro`     | 130–140                  | researched: half-time raps against an upbeat 130–140 floor                                                                                    | upbeat driving kick + frantic syncopated percussion; the rap rides half-time as melody (not drums) | Norient, journals.openedition.org | L1 ✅ L2 ✅ L3 ◐ |
| `house.tropical`   | 100–110, soft kick ≤0.75 | genre coined as a joke by Thomas Jack (~2014); Kygo crossover era                                                                             | soft four-floor, light claps, steel-pan pings, marimba/flute melodies float on top                 | Wikipedia, 6AM Group              | L1 ✅ L2 ✅ L3 ◐ |

## Electronic lanes

| Groove                       | BPM            | Track anchors                                                                        | Signature rhythm                                                                     | Sources                                 | Layers                          |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------- |
| `house.progressive`          | 124–128        | (Opus) Prydz ~126 — approximate                                                      | soft four-floor + 16th shaker bed, NO big backbeat — tension from percussion density | Beatport genre pages                    | L1 ◐ L2 ✅ L3 ○                 |
| `techno.trance`              | 136–142        | (For an Angel) van Dyk ~138 — approximate                                            | the offbeat open hat IS the genre; light clap 2+4, driving 16th hats                 | Beatport, genre guides                  | L1 ◐ L2 ✅ L3 ◐                 |
| `techno.electro`             | 126–134        | (Egypt, Egypt) Egyptian Lover ~127 — approximate                                     | Detroit machine funk: syncopated 808 kick, tight snare, tom talk                     | RA history pieces                       | L1 ◐ L2 ✅ L3 ◐                 |
| `house.breakbeat` / big beat | 104–128        | (Block Rockin' Beats) Chemical Brothers ~108 — approximate                           | syncopated breakbeat kick + heavy 2/4 snare                                          | genre guides                            | L1 ◐ L2 ✅ L3 ◐                 |
| `house.moombahton`           | 105–112, swung | moombahton = four-floor at reggaeton tempo by definition (Dillon Francis/Diplo era)  | house kick + the dembow chop underneath                                              | genre histories                         | L1 ◐ L2 ✅ L3 ◐                 |
| `house.slaphouse`            | 118–124        | (In My Mind) Imanbek/Alok ~120 — approximate                                         | punch-kick doubles, sparse minimal club                                              | genre guides                            | L1 ◐ L2 ✅ L3 ○                 |
| `trap.deepdubstep`           | 138–142        | Croydon 140 canon (Skream/Benga era)                                                 | halftime snare on beat 3, sub-heavy space — NOT brostep                              | genre histories                         | L1 ◐ L2 ✅ L3 ◐                 |
| `house.gqom`                 | 115–128        | researched: Durban, fast but the defining trait is structural — NO four-on-the-floor | broken syncopated kick answered by pounding log toms, sparse eerie chants            | Wikipedia, RBMA, Orphiq, Afroplug       | L1 ✅ (structure ✅) L2 ✅ L3 ◐ |
| `house.ukfunky`              | 125–130, swung | researched: heavily soca-influenced, ~130 BPM (Wikipedia); the "One Dance" sound     | broken kick punch, rim chatter, shaker bed                                           | Wikipedia, Beatportal                   | L1 ✅ L2 ✅ L3 ◐                |
| `jersey.baltimore`           | 125–135        | researched: the parent club sound — NOT the folk-96 myth; "Think"/"Sing Sing" breaks | hard breakbeat stomp, big 2/4 snare, chopped-vocal blips                             | RBMA, melodigging                       | L1 ✅ L2 ✅ L3 ◐                |
| `dnb.jungle`                 | 155–170        | researched: hardware-era sample collage, 155–170                                     | chopped/time-stretched breaks, ghost-snare chops, reggae sub, ragga pressure         | genre guides, amen-break archives       | L1 ✅ L2 ✅ L3 ◐                |
| `house.ghettotech`           | 130–140        | researched: Detroit, 130–140, 808 architecture + torqued-up Miami bass               | banging kick with syncopated booty-bounce pickups, hard claps, short hooks           | OhioLink thesis, RA                     | L1 ✅ L2 ✅ L3 ◐                |
| `house.amapiano`             | 110–116        | researched: 110–115, early sets played 125-found tracks at ~115                      | quiet four-floor (never loud), semiquaver shaker, THE LOG DRUM answering on the toms | Wikipedia, Splice, Ru.ac kwaito journal | L1 ✅ (structure ✅) L2 ✅ L3 ◐ |
| `house.organic`              | 118–124        | researched: Beatport "Organic House / Downtempo" category; 120 sweet spot            | soft floor under conga-rim chatter, shaker, tom accents — hand-drum hypnotia         | Anjunadeep, transition.studio           | L1 ✅ L2 ✅ L3 ◐                |
| `house.afro`                 | 118–126        | classic afro-house pocket (four-floor + rim/shaker)                                  | four-on-floor, swung shaker, rim melody                                              | existing engine lane                    | L1 ◐ L2 ✅ L3 ◐                 |

## Rock lanes (all ride the rock-radio song form via `ROCK_FORM_STYLES`)

| Groove               | BPM     | Track anchors                                                                                                                            | Signature rhythm                                                                                 | Sources                             | Layers                          |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------- |
| `house.grunge`       | 95–125  | (Smells Like Teen Spirit) Nirvana ~117, (Lithium) ~108; ballads like (Heart-Shaped Box) ~74 fall outside the groove's range deliberately | garage stomp: heavy 2/4 snare, driving 8ths, tom accents                                         | SongBPM-type values                 | L1 ✅ L2 ✅ L3 ○                |
| `house.altrock`      | 85–125  | (Creep) Radiohead ~92, (Buddy Holly) Weezer ~120                                                                                         | tighter radio backbeat, syncopated kick                                                          | SongBPM-type values                 | L1 ✅ L2 ✅ L3 ○                |
| `house.rapcore`      | 90–120  | (Killing in the Name) RATM ~92, (One Step Closer) Linkin Park ~104                                                                       | rap-syncopated kick under the rock backbeat, driving 16th hats                                   | RYM nu-metal guide, genre histories | L1 ✅ L2 ✅ L3 ◐                |
| `house.synthpunk`    | 140–168 | researched: punk tempo (Sex Pistols ~150 baseline) on drum machines/synths; The Units pioneers                                           | driving kick 8ths, tight and unswinging                                                          | daysofpunk, genre dictionaries      | L1 ✅ L2 ✅ L3 ◐                |
| `house.metal`        | 100–140 | gallop feel across the classic era                                                                                                       | gallop kick pickups (0/3/6/11/14), crash accents                                                 | Suno-metal tempo tables             | L1 ◐ L2 ✅ L3 ◐                 |
| `house.thrash`       | 140–180 | researched: thrash 140–200, mid ~160                                                                                                     | THE driving 8th-kick beat — every eighth has a kick under the backbeat snare (asserted in tests) | Suno-metal tables, BizMuse          | L1 ✅ L2 ✅ L3 ◐                |
| `house.metalcore`    | 140–170 | researched: ~160 with breakdowns at the SAME tempo, half the pulse                                                                       | driving verses + half-time breakdown (snare on beat 3, asserted in tests)                        | BizMuse, Suno tables                | L1 ✅ (structure ✅) L2 ✅ L3 ◐ |
| `house.doom`         | 50–80   | researched: doom 40–85, ~60 cited                                                                                                        | half-time crawl, at most 2 kicks per bar — the void is the point                                 | Suno tables, BizMuse                | L1 ✅ L2 ✅ L3 ◐                |
| `house.hardcorepunk` | 150–190 | researched: hardcore 150–200+ (Black Flag / Minor Threat)                                                                                | fast tight kick/snare trade + d-beat displacement variation                                      | genre-ai.app                        | L1 ✅ L2 ✅ L3 ◐                |
| `house.poppunk`      | 148–175 | researched: 148–174 "sweet spot"; (Good Riddance) Green Day sheet music 172                                                              | kick 1 + and-of-2 push under the snare backbeat, tight 8th hats                                  | etzcorn, MixGraph blink-182, Drumeo | L1 ✅ L2 ✅ L3 ◐                |
| `house.indie`        | 100–130 | (Last Nite) Strokes ~115, (I Bet You Look Good) Monkeys ~105                                                                             | garage-groove backbeat, syncopated kick, offbeat open hats (dance lean)                          | SongBPM-type values                 | L1 ◐ L2 ✅ L3 ○                 |

## World lanes

| Groove            | BPM     | Track anchors                                                     | Signature rhythm                                                     | Sources           | Layers           |
| ----------------- | ------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------- | ---------------- |
| `house.baltimore` | 125–135 | researched: 125–135 club canon (Rod Lee, K-Swift, Debonair Samir) | "Think"/"Sing Sing" break stomp, hard 2/4 snare, chopped-vocal blips | RBMA, melodigging | L1 ✅ L2 ✅ L3 ◐ |

## Legacy lanes (backfilled from the groove source — anchors accumulate)

BPMs below are read **directly from `src/ai/grooves/*.ts`** (what the engine
actually plays). Track anchors marked `~` are common community values not
verified against a specific source this session; `—` = anchor backlog. All
legacy rows are L1 ◐ / L2 ✅ / L3 ○–◐ until individually upgraded.

### House family

| Groove             | BPM     | Track anchors                                               | Signature                                       |
| ------------------ | ------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `house.driving`    | 122–128 | (Losing It) FISHER ~125                                     | the mainroom four-floor engine                  |
| `house.minimal`    | 120–126 | —                                                           | sparse four-floor, click percussion             |
| `house.funky`      | 118–124 | —                                                           | disco-house bounce, filtered loops              |
| `house.deep`       | 118–124 | (Deep Inside) Hardrive ~122 — approx                        | shuffled deep pocket                            |
| `house.ukg`        | 126–132 | (Flowers) Sweet Female Attitude ~127 — approx               | 2-step shuffle, swung hats                      |
| `house.dancefloor` | 124–128 | (Losing It) FISHER ~125, John Summit era                    | peak-time four-floor + bass stab                |
| `house.soulful`    | 120–126 | Defected school                                             | soulful chords over four-floor                  |
| `house.heartbeat`  | 126–134 | Fred again.. school (FRED_FORM)                             | emotional UKG crossover                         |
| `house.broken`     | 128–138 | Overmono school                                             | broken beat, off-grid kick                      |
| `house.pop`        | 118–124 | dance-pop canon                                             | four-floor + pop clap, hats leave room to sing  |
| `house.synthpop`   | 100–118 | 80s synth-pop era                                           | gated snare, driving 16th hats                  |
| `house.afroswing`  | 100–108 | (J Hus era) ~104 — approx                                   | swung shaker 16ths, late snare answers          |
| `house.basshouse`  | 124–130 | bass house era                                              | wobble stab over four-floor                     |
| `house.ghouse`     | 120–126 | g-house era                                                 | gangster vocal stabs, 808-ish slide             |
| `house.footwork`   | 155–165 | researched: juke/footwork canon 155–165, RP Boo / DJ Rashad | polyrhythmic battle breaks, dead-grid precision |
| `house.pianohouse` | 122–130 | piano house revival                                         | piano riff hook over four-floor                 |
| `house.midtempo`   | 90–110  | midtempo era                                                | half-time-leaning club groove                   |
| `house.melodic`    | 120–128 | melodic house school                                        | emotive pads over soft four-floor               |
| `house.baile`      | 130–150 | researched: baile funk canon                                | tamborzão-style syncopation                     |

### Techno / trance / ukg families

| Groove               | BPM                 | Track anchors                       | Signature                           |
| -------------------- | ------------------- | ----------------------------------- | ----------------------------------- |
| `techno.driving`     | 130–138             | warehouse canon                     | relentless four-floor, ride sparkle |
| `techno.minimal`     | 126–132             | —                                   | sparse click minimal                |
| `techno.industrial`  | 132–140             | industrial era                      | hammered kicks, rim/perc menace     |
| `techno.dub`         | 124–130, swung 0.10 | dub techno canon                    | deep chords, swung shuffle          |
| `techno.acid`        | 130–138             | (Acid Tracks) Phuture ~128 — approx | 303 squelch over four-floor         |
| `techno.hard`        | 145–155             | researched wave: fast warehouse     | hard kicked four-floor              |
| `techno.melodic`     | 122–132             | researched wave: melodic school     | emotive arcs over soft floor        |
| `techno.psytrance`   | 138–145             | researched wave: psy 138–148        | rolling 16th bass, offbeat stabs    |
| `techno.hardstyle`   | 150–155             | researched wave: hardstyle ~150     | gated reverse-bass kick             |
| `techno.ebm`         | 130–140             | EBM canon (Nitzer Ebb school)       | punchy sequenced bass, four-floor   |
| `trance.uplifting`   | 136–142             | uplifting canon (~137–138)          | supersaw arps, offbeat open hat     |
| `trance.progressive` | 126–134             | progressive trance                  | long builds, softer floor           |
| `trance.psy`         | 138–148             | psytrance full-on                   | rolling 16th bassline               |
| `trance.tech`        | 134–142             | tech trance                         | techno floor + trance hats          |
| `trance.acid`        | 132–142             | acid trance                         | 303 lines over trance floor         |
| `trance.dream`       | 128–136             | dream trance                        | airy pads, softer pulse             |
| `ukg.ukg`            | 130–138             | UKG revival (Conducta school)       | 2-step shuffle, sub bass            |
| `ukg.bassline`       | 132–140             | bassline/Niche school               | 4x4-ish bassline wobble             |
| `ukg.deep`           | 130–136             | deep UKG                            | muted 2-step, deep chords           |

### Trap / drill / phonk / jersey families

| Groove                                           | BPM     | Track anchors                                    | Signature                                                              |
| ------------------------------------------------ | ------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `trap.classic`                                   | 135–145 | trap canon (16th hats at tempo)                  | rolling 808 + hat rolls                                                |
| `trap.rolling`                                   | 138–148 | rolling hi-hat era                               | walking 808, triplet hats                                              |
| `trap.sparse`                                    | 130–140 | sparse trap                                      | wide space, sub patience                                               |
| `trap.bouncy`                                    | 140–150 | rage era                                         | bouncy distort-808                                                     |
| `trap.lux`                                       | 118–128 | researched wave: Don Toliver school              | slow lux pocket, warm 808                                              |
| `trap.hyper`                                     | 140–160 | hyper trap                                       | fastest 808 ladder                                                     |
| `trap.dubstep`                                   | 140–152 | brostep/riddim                                   | half-time wobble floor                                                 |
| `trap.screwed`                                   | 66–78   | chopped-and-screwed canon (June 27 ~68 — approx) | slowed + throwed swing                                                 |
| `trap.plugg`                                     | 140–160 | plugg school                                     | plugg bell, airy 808                                                   |
| `trap.detroit`                                   | 135–148 | Detroit trap                                     | off-grid boom, sparse menace                                           |
| `trap.hyphy`                                     | 96–106  | hyphy era                                        | bouncy Bay shuffle                                                     |
| `trap.crunk`                                     | 98–108  | crunk era                                        | chant four-floor stomp                                                 |
| `trap.oldschool`                                 | 98–110  | 80s electro-rap                                  | 808 electro grid                                                       |
| `trap.bounce`                                    | 98–104  | NOLA triggerman (researched wave)                | triggerman call pattern                                                |
| `trap.miamibass`                                 | 115–125 | Miami bass canon                                 | torqued 808 stomp                                                      |
| `trap.snap`                                      | 80–95   | snap era                                         | finger snaps, minimal                                                  |
| `trap.countrytune`                               | 75–90   | researched wave: country rap                     | country triplet bounce                                                 |
| `trap.headnod`                                   | 90–96   | 90s boom-bap canon (~93)                         | head-nod swing backbeat                                                |
| `trap.corridos`                                  | 90–130  | corridos tumbados era                            | requinto-feel over trap floor                                          |
| `trap.bedroom`                                   | 80–110  | bedroom-R&B school                               | lo-fi soft pocket                                                      |
| `trap.trapsoul`                                  | 78–95   | trap-soul school                                 | molten half-time soul                                                  |
| `trap.dancehall`                                 | 88–105  | dancehall riddim                                 | one-drop-ish shuffle                                                   |
| `drill.uk`                                       | 140–148 | researched: UK drill canon                       | sliding 808, half-time snare 3                                         |
| `drill.dark / bounce / sample / hyper / melodic` | 138–162 | drill sub-lanes                                  | dark sparse / bounce hats / sample flips / hyper speed / melodic slide |
| `drill.grime`                                    | 138–144 | grime 140 canon (Skepta/Wiley ~140)              | eski stabs, 140 floor                                                  |
| `phonk.memphis`                                  | 130–140 | modern memphis phonk convention                  | cowbell hook, tape chops                                               |
| `phonk.drift`                                    | 132–142 | drift phonk era                                  | distorted slide cowbell                                                |
| `phonk.horror`                                   | 132–150 | horrorcore phonk                                 | half-time snare 8, eerie                                               |
| `jersey.club`                                    | 134–142 | researched: triple-kick club canon               | kick 1 / and-of-2 / and-of-3                                           |
| `jersey.bounce / flip`                           | 134–144 | jersey variants                                  | bounce shuffle / edit flip                                             |

### Ambient / hybrid / dnb / boombap / hyperpop / amapiano families

| Groove                                                           | BPM     | Track anchors                     | Signature                                                                                                    |
| ---------------------------------------------------------------- | ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ambient.drifting`                                               | 70–85   | drone/ambient canon               | long swells, no pulse                                                                                        |
| `ambient.futuregarage`                                           | 130–140 | (Archangel) Burial ~134 — approx  | detuned 2-step, vinyl crackle                                                                                |
| `ambient.glitch`                                                 | 80–95   | IDM glitch                        | cut noise, micro-edit                                                                                        |
| `ambient.citypop`                                                | 100–125 | city pop era                      | smooth funk changes                                                                                          |
| `ambient.synthwave`                                              | 95–115  | synthwave canon                   | gated drum machine, arp drive                                                                                |
| `hybrid.techhouse`                                               | 124–130 | tech house canon                  | wobbly bass four-floor                                                                                       |
| `hybrid.ambienttechno`                                           | 118–126 | ambient techno                    | pulse under pads                                                                                             |
| `hybrid.lofimap`                                                 | 80–95   | lo-fi trap map                    | dusty half-time                                                                                              |
| `dnb.twostep`                                                    | 172–178 | two-step dnb canon                | snap 2-step break                                                                                            |
| `dnb.liquid`                                                     | 170–176 | (Netsky school) ~172 — approx     | rolling soft break, warm bass                                                                                |
| `dnb.jumpup`                                                     | 174–180 | jump-up canon                     | wobble bass, bouncy break                                                                                    |
| `dnb.roller`                                                     | 172–178 | roller canon                      | smooth rolling break                                                                                         |
| `dnb.amen`                                                       | 170–178 | amen chop canon                   | chopped amen                                                                                                 |
| `dnb.neuro`                                                      | 172–178 | neuro canon (Noisia school)       | reese bass, edited break                                                                                     |
| `boombap.golden`                                                 | 86–96   | golden-era boom bap (~93)         | dusty swing backbeat                                                                                         |
| `boombap.jazz`                                                   | 88–98   | jazz-rap school                   | swung jazz loop pocket                                                                                       |
| `boombap.lofi`                                                   | 78–92   | lo-fi rap                         | soft swung dust                                                                                              |
| `boombap.drumless`                                               | 80–92   | drumless style                    | sparse accent-only bed                                                                                       |
| `boombap.trapbap`                                                | 120–145 | trap-bap fusion                   | boom bap swing at trap tempo                                                                                 |
| `boombap.modern`                                                 | 82–94   | modern boom bap (Griselda school) | dark lo-fi swing                                                                                             |
| `hyperpop.hyper / glitch / rage / decon`                         | 140–170 | hyperpop school                   | chipmunk shifts, glitch fills, rage dist, deconstructed cuts                                                 |
| `amapiano.yanos / soulful / sgija / bacardi / quantum / popiano` | 108–120 | amapiano sub-schools              | log drum dialects (yanos core, soulful mellow, sgija raw, bacardi log bounce, quantum dark, popiano melodic) |

---

## Artist BPM anchor workflow

For artist presets, prefer **2–3 named-track BPMs** over a bare range
(MixGraph, SongBPM, Tunebat, getsongbpm). The range in `artists.ts` is the
groove-clamp window; the anchors are the _evidence_. Example of the target
format (already used in code comments):

```
// researched: Kylie 115-128 (Padam 128, Can't Get You Out of My Head 123)
```

When a source corrects a claim (Baltimore 96 → 125–135 is the canonical
example), fix the groove AND note the correction here.

## Research session protocol

1. Batch all searches for a wave up front (weekly quota — do not dribble).
2. Land findings in this file **in the same commit** as the groove/parser
   changes they justify.
3. Mark every new row's layers honestly — an ○ estimate written down is
   worth more than an ✅ implied.
4. When two sources disagree, record the disagreement and pick the value the
   stronger source supports (Wikipedia/academic > genre blogs > forums).
