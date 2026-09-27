# VOCABULARY GAP RESEARCH — missing sub-genres, tempos and iconic names

**Created:** 2026-09-27 (roster-expansion campaign, after the user-request wave:
`house.pianohouse` / `house.midtempo` / `house.breakbeat` / `ambient.sadchill` /
`ambient.dirtyambient` + LATIN MAFIA + pluko).
**Baseline at writing:** 143 grooves · 588 artist presets · 123 style embeddings ·
12 first-class genres (`house, techno, trap, ambient, drill, phonk, jersey, dnb,
hyperpop, ukg, boombap, amapiano`).
**Companion docs:** `docs/GENRE-RESEARCH.md` (provenance for lanes that DO exist),
`docs/CURRENT-STATE.md` (counts), `docs/ROSTER-EXPANSION-ROADMAP.md` (waves 8–12).

> This document is the **gap map**: what the vocabulary is missing, why it
> matters, and in what order to add it. Every claim below is reproducible from
> the working tree — the probe scripts and their outputs are recorded in the
> session that produced this file; re-run them before starting a wave.

---

## 0. How the gaps were measured (not guessed)

Three measurable failure classes, all silent at runtime:

| Class                 | Probe                                       | Result today                                                                                     |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Dangling artist**   | `getGrooveById(genre.style)` for all presets | **9 / 588** presets fall back to a random groove in their genre                                   |
| **Dangling parser**   | every `STYLE_PHRASES` token → groove id      | `future garage` is the only true dangling token (normalization false-positive — see §4)          |
| **Orphan groove**     | every groove id → parser style token         | **33 / 143** grooves are unreachable by name (reachable only via artist preset or random pick)     |
| **Missing embedding** | groove id ↔ `style-embeddings.json`          | **20 / 143** grooves have no style embedding (all recent additions)                               |
| **Missing genre**     | real request with no genre at all            | reggae/ska, hardstyle, gabber/hardcore-techno, shoegaze, dream pop, nu jazz, boogie, balearic, breakcore, trip-hop depth, dubstep family, uptempo, post-rock |

The three layers of certainty follow `GENRE-RESEARCH.md`: **L1 tempo** (researched),
**L2 mapping** (which existing groove carries it), **L3 sliders** (estimate).

---

## 1. P0 — Broken routing (fix first, no new grooves needed)

These are bugs, not missing content: a user types a supported phrase and gets a
random pocket because the parser emits a style token that no groove carries.

### 1a. Dangling artist styles (9 presets)

| Preset label     | genre / style today  | Problem                                        | Fix                                                       |
| ---------------- | -------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| metro boomin     | trap / `dark`        | no `trap.dark` groove ever existed             | → `sparse` (his pocket is dark sparse — L2 interpretation) |
| 21 savage        | trap / `dark`        | same                                           | → `sparse`                                                 |
| southside        | trap / `dark`        | same                                           | → `sparse`                                                 |
| mike will made-it| trap / `dark`        | same                                           | → `rolling` (the 130+ rolling pocket)                      |
| wondagurl        | trap / `dark`        | same                                           | → `sparse`                                                 |
| drill (generic)  | drill / `sparse`     | `drill.sparse` does not exist (trap does)      | → `uk` (the default drill pocket)                          |
| jersey (generic) | jersey / `bouncy`    | `jersey.bouncy` does not exist (`bounce` does) | → `club` (the core jersey pocket)                          |
| billie eilish    | ambient / `sparse`   | `ambient.sparse` does not exist                | → `sadchill` (the quiet-vocal lane added this wave)         |
| lorde            | ambient / `sparse`   | same                                           | → `sadchill`                                               |

**Alternative considered:** add `trap.dark` / `drill.sparse` / `jersey.bouncy` /
`ambient.sparse` grooves. Rejected for P0 — the four target pockets already carry
those records; a new groove needs a full research row, not a rename. Revisit only
if a real dark-trap lane (Metro's dark 2018 era, `trap.dark`-distinct from sparse)
gets researched.

### 1b. Real phrases that route nowhere useful

| User types          | Today                          | Should be                            | Layer |
| ------------------- | ------------------------------ | ------------------------------------ | ----- |
| `reggae`            | **nothing** (no genre, no style) | dub/reggae lane — `techno.dub` today, see P1b | L1 ✅ |
| `ska`               | **nothing**                    | same family as reggae               | L2 ◐ |
| `hardstyle`         | **nothing**                    | `techno.hardstyle` groove exists — phrase missing | L1 ✅ |
| `gabber` / `hardcore techno` | `house` / `hardcorepunk` (wrong family) | the uptempo/gabber lane — **no groove yet** (P1b) | L1 ✅ |
| `happy hardcore`    | `house` / `hardcorepunk` (wrong-ish) | same uptempo family, happy variant   | L1 ◐ |
| `breakcore`         | dnb / nothing                  | `dnb.amen` exists — phrase should carry `amen` style | L2 ✅ |
| `shoegaze`, `dream pop` | nothing / `house.pop`      | **no groove** (P1b) or map to `house.indie` short-term | L2 ◐ |
| `post rock`         | **nothing**                    | `house.altrock` / doom-adjacent (P1b) | L2 ◐ |
| `nu jazz`           | nothing (style `broken` via broken beat) | `house.broken` exists — map it, add artists | L2 ✅ |
| `boogie`            | nothing (style `funky`)        | `house.disco` / `house.funky` — map + artists | L2 ✅ |
| `balearic`          | nothing                        | `house.organic` / `house.tropical` — map + artists | L2 ◐ |
| `synthwave` / `outrun` / `darksynth` | techno / **nothing** | `ambient.synthwave` **groove exists, phrase missing** | L1 ✅ |
| `chillhop`          | ambient / nothing              | `hybrid.lofimap` or `boombap.lofi` — map | L2 ✅ |
| `trip hop`          | ambient / organic              | dedicated lane (P1b); `trap.bedroom`-adjacent today | L1 ✅ |
| `downtempo`         | ambient / organic              | same family as trip-hop              | L1 ✅ |
| `dubstep` (as a genre) | trap / dubstep             | acceptable mapping (trap family) — document it, do not fork a genre | L2 ✅ |
| `reggae dub`, `dub` | techno / dub                   | acceptable — `techno.dub` is the dub-techno lane; real dub is P1b | L1 ◐ |
| `dancehall`         | trap / `trap.dancehall`        | correct already ✅                   | —     |
| `hardcore` bare     | house / hardcorepunk           | deliberate (punk reading); `gabber` must NOT be stolen — see test | L2 ✅ |

---

## 2. P1 — Missing lanes (new grooves; highest musical value)

Priority order inside P1 = `(request likelihood) × (1 / effort)`. All tempos are
L1 research targets; the anchors listed are the evidence to verify at
implementation time (2–3 named tracks each, per `GENRE-RESEARCH.md`).

### P1a — Big rooms the engine cannot express today (top 6)

| Lane id (proposed)   | BPM (research target) | Iconic names to add                                                                     | Why it matters                                                        |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `techno.gabber`      | 150–190 (hardcore 160–180 core) | Angerfist, Miss K8, Sefa, Dr. Peacock, Rotterdam Terror Corps, Nosferatu, Tha Playah | Gabber/uptempo is a top-5 European club genre and **completely absent** |
| `ambient.triphop`    | 80–100 (halftime)     | Bonobo, DJ Shadow, Tricky, UNKLE, Nightmares on Wax, Emancipator, RJD2, DJ Krush     | Trip-hop/downtempo is the most-requested "chill" family after lofi    |
| `house.dubstep` (bass) | 140–150 (halftime)  | Skrillex, Excision, Zomboy, Rusko, Caspa, Zeds Dead, Marauda, Space Laces, Subtronics | Bass dubstep is a first-class US genre with **zero dedicated groove** (rides `trap.dubstep`) |
| `ambient.shoegaze`   | 90–130 (wall of sound)| My Bloody Valentine, Slowdive, Cocteau Twins, Beach House, Alvvays, DIIV, Lush     | Shoegaze/dream-pop is a **rock family** the engine cannot reach at all |
| `house.breakcore`    | 160–200               | Venetian Snares, Squarepusher, Sevish-adjacent, Igorrr, Machine Girl, sewerslvt       | Breakcore/glitch breaks is absent; `dnb.amen` is the closest lie today |
| `house.reggae`       | 60–90 (one drop)      | Bob Marley, Peter Tosh, Burning Spear, Steel Pulse, Lee Perry, King Tubby, Scientist   | Reggae/dub/roots is a whole **world family** with no lane             |

### P1b — Depth lanes (medium effort, reuse existing grooves where honest)

| Lane id (proposed)    | BPM              | Iconic names                                                        | Mapping note                          |
| --------------------- | ---------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `techno.trance` depth | 136–142 (exists)  | Ferry Corsten, Aly & Fila, Gareth Emery, Cosmic Gate, Markus Schulz | Groove exists — only artists missing  |
| `techno.psytrance` depth | 138–145 (exists) | Ace Ventura, Ajja, Blastoyz, Astrix                                | Groove exists — artists missing       |
| `house.shoegaze` (alt) | 100–130         | Ride, Mazzy Star, Galaxie 500, Cigarettes After Sex                 | Could ride `house.altrock` short-term |
| `house.nujazz`        | 110–140 (broken)  | Yussef Kamaal, Ezra Collective, Kokoroko, Alfa Mist, Yussef Dayes, Nubya Garcia, 4hero, Bugz in the Attic, Kaidi Tatham, Makaya McCraven, Robert Glasper, Kamasi Washington | `house.broken` exists — artists + phrase missing |
| `house.funk` (boogie) | 100–120          | Vulfpeck, Cory Wong, Lettuce, The Meters, Zapp, Cameo, Gap Band, Parliament, Funkadelic, Herbie Hancock, Stevie Wonder | `house.funky` / `house.disco` exist — artists missing |
| `house.balearic`      | 95–115 (sunset)  | José Padilla, Phil Meehan, Chris Coco, DJ Koze, Christian Löffler, Nils Frahm | `house.organic` exists — artists + phrase missing |
| `house.dancehall` (world) | 90–110        | (trap.dancehall covers riddim; add dancehall legends if forking)    | Low priority                          |
| `hybrid.lofimap`      | 70–95            | chillhop/study-beats names (generic only — see policy §3)           | Groove exists, phrase routes to `hybrid.lofimap` after fix |

### P1c — Depth lanes (only if a genre is later promoted)

`techno.ebm` (Nitzer Ebb, Front 242, DAF, Front Line Assembly), `house.kpop`
depth (BTS, BLACKPINK, NewJeans, TWICE), `house.baile` depth (Anitta, MC Kevin,
DJ Rennan — Anitta present), `house.citypop` depth (Tomoko Aran, Yellow Magic
Orchestra, Haruomi Hosono, Jun Fukamachi), `ambient.citypop` / `ambient.synthwave`
phrases, `house.afrobeats` depth (Fireboy, Omah Lay, CKay, Tekno, Patoranking),
`trap.corridos` (already has Peso Pluma / Natanael Cano / Junior H — add Eslabón,
Fuerza Regida ✅ present).

---

## 3. Naming policy (non-negotiable when adding names)

Derived from the shadowing rules already in the codebase:

1. **Generic single words need a qualifier** — `reese`, `plug`, `coil`, `justice`,
   `marsh`, `break`, `serum`, `big beat`, `chic`, `zip`. Never add bare.
2. **Aliases must be ASCII-deaccented** — matching runs on deaccented text, so
   `shlomo` (not `shlømo`), `koze` qualifies but `dj koze` must be the alias key.
3. **First match wins** — a phrase that is a substring of an earlier artist name
   will be shadowed. Grep before adding.
4. **Style token must equal a real groove id** — `getGrooveById(genre.style)`;
   a mismatch is a silent random fallback (this document's §1a).
5. **Names are facts, not decoration** — no fictional artists, no dead-name
   variants without an alias, no label names presented as artists.

---

## 4. False positives (verified, do not "fix")

| Suspicion                       | Verdict                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| parser token `future garage`    | **Not dangling.** The token contains a space; `resolveGroove` normalizes spaces away → `ambient.futuregarage` resolves. The audit script that compares raw tokens reports it as a false positive. |
| `reggaeton` → `house`           | Correct — `house.dembow` is the lane; genre is the family, style is the pocket. |
| `dubstep` → `trap`              | Correct today — the trap family carries `.dubstep`. A dedicated bass genre is P1a scope. |
| `uk drill` / `grime` → `drill`  | Correct — `drill.uk` and `drill.grime` both exist.                       |
| `hardcore` bare → `house`       | Deliberate — punk reading; `gabber` must stay its own lane (P1a).        |
| `baile funk` → `phonk/bounce`   | Pre-existing decision; revisit with `house.baile` depth in P1c.          |

---

## 5. Orphan + embedding backlog (mechanical, low risk)

**33 orphan grooves** (no parser phrase yet) — the fix is a phrase per groove,
not new data. Full list reproduced by the audit: `house.synthpop / basshouse /
footwork / amapiano / baile / futurebass / kpop / reggaeton / afrobeats,
techno.hard / hardstyle / ebm, trap.corridos / bedroom / trapsoul / dancehall,
ambient.futuregarage / citypop / synthwave, hybrid.techhouse / ambienttechno /
lofimap, drill.uk / dark, phonk.memphis / drift, jersey.club / flip, dnb.twostep,
hyperpop.rage / decon, ukg.bassline, boombap.modern`.
Many are reachable through a *different* phrase in the same genre (e.g. `drift
phonk` → phonk.drift) — each still deserves its own documented phrase + test.

**20 missing style embeddings** — all added after the last regeneration:
`house.melodic, house.baile, house.futurebass, house.kpop, house.reggaeton,
house.afrobeats, techno.ebm, trap.corridos, trap.bedroom, trap.trapsoul,
trap.dancehall, ambient.citypop, ambient.synthwave, hyperpop.decon,
amapiano.{yanos,soulful,sgija,bacardi,quantum,popiano}`.
Regenerate with `scripts/generate-style-embeddings.mts`; the symbolic prior
dataset (`symbolic-prior-ds.v3`) trains over the whole library automatically.

---

## 6. Recommended wave order

| Wave | Scope                                                                 | Status |
| ---- | --------------------------------------------------------------------- | ------ |
| **0** | §1a fixes (9 presets) + §1b phrase fixes (synthwave/hardstyle/breakcore/trip-hop/nu-jazz/boogie/chillhop/reggae/ska) | **Shipped.** All 9 presets remapped (`trap/dark → sparse`, `drill/sparse → uk`, `jersey/bouncy → club`, `ambient/sparse → sadchill`); every §1b phrase now resolves to a real groove. Gate: "no artist preset may dangle" block in `tests/intent-artists.test.ts`. |
| **1** | P1a top 6 lanes — new grooves (+ parser + descriptions + semantic + artists) | **Shipped (wave 6).** Five grooves landed: `techno.gabber`, `ambient.triphop`, `house.reggae`, `trap.bassdubstep`, `house.shoegaze`. Breakcore rides `dnb.amen` (the honest pocket); dubstep-bass got `trap.bassdubstep`. Locked by `tests/grooves-wave-6.test.ts` (8 tests incl. lane signatures). |
| **2** | P1b depth lanes (trance/psytrance/nu-jazz/funk-boogie/balearic artists + phrases) | **Shipped.** Nu jazz → `broken`, boogie → `funky`, balearic → `organic`; trance artist depth landed via the parallel first-class trance promotion. |
| **3** | §5 mechanical backlog (orphan phrases + embeddings)                    | **Shipped.** Style embeddings regenerated to full library coverage (`164 / 164`), zero orphans. |
| **4** | P1c only after a genre promotion ADR/decision                          | Open — see P1c list. |

**Hard rule carried from `GENRE-RESEARCH.md`:** batch the research, land the anchors in the same commit as the data, and never describe a lane as shipped before its probe passes.

> **Post-wave-6 additions (same session, after this map was written):** the
> parallel waves promoted `trance` and `detroit` to first-class genres and
> added a DnB depth tree (`dnb.techstep / ragga / sambass / halftime /
> crossbreed / minimal`). This document's P1b trance rows are therefore
> historical — the genre now carries its own `trance.uplifting / progressive /
> psy / tech / acid / dream` school. Remaining P1c candidates: k-pop depth,
> baile depth, city-pop depth, afrobeats artist depth, uptempo/gabber artist
> depth (the groove exists now, add Angerfist / Miss K8 / Sefa / Dr. Peacock
> artist presets on it).

---

## 7. Verification commands

```bash
# Zero dangling artist presets (the §1a gate)
npx vite-node scripts/zz-audit2.mts        # expect: total dangling 0 / 588+

# Every parser style token resolves for at least one genre
npx vite-node scripts/zz-audit.mts         # expect: dangling 1/94 (future garage false positive)

# Embedding coverage
npx vite-node scripts/zz-inv3.mts          # expect: GROOVES WITHOUT STYLE EMBEDDING: 0

# Intent suites
npx vitest run tests/intent-artists.test.ts tests/intent-text-parser.test.ts \
  tests/intent-semantic.test.ts tests/intent-descriptions.test.ts tests/intent-artist-profiles.test.ts
```

The audit scripts live in `scripts/` during a campaign and are removed before the
PR lands; this document records what they proved.
