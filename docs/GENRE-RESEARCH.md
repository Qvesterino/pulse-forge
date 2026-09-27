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

## Legacy lanes (pre-catalog; anchors to be backfilled opportunistically)

`house.driving / minimal / funky / deep / ukg / dancefloor / soulful /
heartbeat / broken / pop / synthpop / afroswing / basshouse / ghouse /
footwork / disco-era lanes`, `techno.driving / minimal / industrial / dub /
acid / hard / melodic / hardstyle / psytrance`, `trap.*`, `drill.*`,
`phonk.*`, `jersey.club / bounce / flip`, `dnb.twostep / liquid / jumpup /
roller / amen / dancefloor / neuro`, `ambient.*`, `hybrid.*`.
These predate the research pass — when touching one, add its anchors here.

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
