# INTENT AUDIT 2026-10 — porozumenie a router (Fáza 2 kampane)

> F2 kampane `docs/INTENT-ENGINE-CAMPAIGN-PLAN.md` — audit toho, ako engine
> CHÁPE zámer: router sémantika, brief-gate compliance, generované stopy
> z F1 baselineu. **Metóda:** falsifikácia v čistom worktree (bisect +
> štruktúrované proby) + adversariálny korpus 106 promptov SK+EN commitnutý
> ako `tests/intent-router-corpus.test.ts`. Read-heavy, defekty s repro,
> opravy sú F3.
>
> **Anti-duplikácia:** audity 1–3 (`tests/intent-e2e-audit{,2,3}.test.ts`)
> kryjú fadery/compounds/exact/bpm-descriptive/transpose/production-targets/
> tempo-window/master-domain; `docs/INTENT-VERIFICATION-2026-09-30.md` kryje
> AI bridge (recipe→command); `docs/INTENT-MINING-2026-09-30.md` kryje ONNX
> model tréning. Tento audit sa nimi neduplikuje — plocha je router korpus,
> brief-gate end-to-end, song build stopy a model route proba.

---

## 1. Súhrn

| ID  | Titul                                                                           | Závažnosť   | Owner vlny                   | Stav                               |
| --- | ------------------------------------------------------------------------------- | ----------- | ---------------------------- | ---------------------------------- |
| D1  | Fill recept seedovaný náhodným `pattern.id` → buildSong nedeterminizmus         | **P1**      | `61607f31` (fill vocabulary) | ✅ FIX (F3, `a0917742`)            |
| D2  | Lead-only generácia dáva všetkých kandidátov prázdnych (harmony-first regresia) | **P1**      | `3971f0c1` (multi-voice)     | ✅ FIX (F3, `8866dceb`)            |
| D3  | Rejected výsledok nesie definovaný prázdny proposal → UI môže inštalovať ticho  | **P1**      | kontrakt (pipeline/UI)       | ✅ FIX (F3, `9eb9df47`)            |
| D5  | SK exact slovná zásoba: „soluj" neexistuje                                      | P2          | parser vlny                  | ✅ FIX (F3, `42f21c66`/`cf8ad5af`) |
| D6  | SK diakritika/slovná zásoba nekonzistentná naprieč vrstvami (mix, loudness)     | P2          | parser vlny                  | ✅ FIX (F3, `42f21c66`)            |
| D7  | Preset intent nedosiahnuteľný z plain textu; `presetUnknown` never fires        | P2          | preset-intent v1             | ✅ FIX (F3, `42f21c66`)            |
| D8  | Komparatívy hijackujú žánrové prompty („darker techno at 130" → mix)            | P3 (dizajn) | documented §5.7              | ⏳ rozhodnutie ownera              |
| D9  | SK arrange duplicitné synonymá chýbajú úplne                                    | P2          | arrangeWords vlny            | ✅ FIX (F3, `cf8ad5af`)            |

Číslovanie D1–D9 rezervované; D4 bolo v priebehu auditu zlúčené do D2
(„with lead" scope sémantika je PINUTÁ v `tests/intent-text-parser.test.ts:95`,
teda nie je defekt — defekt je čo sa stane potom, D2/D3).

---

## 2. P1 defekty (root-caused, s repro)

### D1 — buildSong nedeterminizmus: fill seedovaný náhodným id

- **Symptom:** `tests/intent-sections-fx.test.ts > is deterministic for a
fixed seed` červený od F1 baselineu. Dva buildy z rovnakého dokumentu a
  seedu sa líšia v obsahu posledného baru sekcií (velocity rampy 0.3→0.9
  vs iný recept/ticho).
- **Root cause (dokázaný):** `src/intent/song.ts:2499` seeduje výber fill
  receptu cez `` fillSeed: `${outgoing.pattern.id}|${section.label}` `` —
  ale `pattern.id` je **náhodné uid nové v každom builde**. `pickFillRecipe`
  (`src/intent/transitions.ts:193`) forkuje `forkRandom(poolKey, "song.fill")`,
  takže iný seed = iný recept z poolu 6 receptov × 2 tierá. Komentár v kóde
  („same boundary, same fill") predpokladá stabilitu id naprieč buildmi —
  nesprávny predpoklad.
- **Falsifikácia:** bisect → PASS do `c246c24a`, FAIL od `61607f31`
  („ale tak uspešne zatial", 10-10 21:08 — fill vocabulary). Proby: čisté
  `structuredClone` buildy sa líšia aj medzi procesmi (H1); build **nemutuje**
  dokument (H2 ✓); harmony plán je deterministický (H3 ✓); reset modulového
  id počítadla nepomáha (H6) — teda nie je to zdieľaný state, ale čisto seed.
- **Fix direction (F3):** seedovať plánovo-odvoditeľným kľúčom hranice —
  napr. `` `${baseSeed}|song:${index}:transition` `` alebo content hash
  odchádzajúceho patternu. Nikdy id/random uid.

### D2 — lead-only generácia: všetci kandidáti prázdni

- **Symptom:** `tests/release-gate-ai-producer.test.ts > GATE brief fidelity
"explicit BPM + genre"` červený: `hardFactViolations(proposal) = ["empty"]`.
- **Reťaz:** „dark rolling techno at 140 **with lead**" → parser dá
  `roles: ["lead"]` (scope-replacement sémantika — **pinutá ako zámerná**,
  `tests/intent-text-parser.test.ts:95`) → generácia s touto rolou vyprodukuje
  **3/3 štruktúrálne validné, ale obsahovo prázdne** kandidáty → engine
  brief-gate ich **správne** odmietne (diagnostics: `candidate-N:brief-gate:empty`)
  → fallback zlyhá (`fallback-failed-invariant-or-preserve-gate`) → status
  `rejected`.
- **Root cause:** `3971f0c1` („harmony-first generation — the multi-voice
  engine drives every melodic path", 10-11) — bisect: PASS na `698848f7`,
  FAIL od `3971f0c1`. Multi-voice cesta nevie vygenerovať lead-only sadu
  a degraduje na prázdny pattern namiesto hlasného zlyhania.
- **Kvadrát:** `tests/intent-brief-suite.test.ts` (determinizmus nad týmto
  istým textom) prechádza **vakuovo** — porovnáva dva prázdne proposaly.
  Skrytá planeta: suite zelená, feature mŕtva.
- **Fix direction (F3):** multi-voice cesta musí pre každu požadovanú rolu
  buď vygenerovať obsah, alebo hlasno zlyhať ešte pred bankom („lead-only
  intent produced no notes" ako špecifická chyba), nie tichý prázdny
  kandidát.

### D3 — rejected výsledok s definovaným prázdnym proposalom

- **Symptom:** `generateLocalResult`/`generateAsyncResult` vracajú pri
  `status: "rejected"` stále `proposal` (pipeline `resultFromProposal` —
  `src/intent/pipeline.ts:19` nastavuje proposal bezpodmienečne).
- **Dôsledok (živá cesta):** IntentPanel generuje s guardom iba
  `if (!result.proposal)` (`src/ui/IntentPanel.tsx:1067`) a
  `applyGenerationResultCommand` hádže len pri `!proposal`
  (`src/commands/aiPattern.ts:43`). Rejected výsledok s prázdnym proposalom
  prejde oboma bránami → **prázdny pattern sa nainštaluje cez aktívny
  pattern používateľa** (undoabilné, ale tiché). D2 je spúšťač, D3 je
  zosilňovač — aj keď sa D2 opraví, kontrakt zostáva mínou.
- **Fix direction (F3):** kontrakt: rejected ⇒ `proposal: undefined` +
  UI/apply guard na `status !== "accepted" | "repaired"` (alebo content
  check). Zmena kontraktu = preveriť všetkých konzumentov
  (`applyGenerationResultCommand`, Dice, AI Flip, panel, MCP).

---

## 3. P2/P3 nálezy z adversariálneho korpusu

Korpus: `tests/intent-router-corpus.test.ts` — 98 očakávaní + 8 pinutých
defektov (`it.fails`, každý s ID z tohto dokumentu). Zelený beh = 106/106.

- **D5 (P2):** „soluj basu" → `pattern` (malo by `exact`). `exact.ts` má
  solo op („Mute / unmute / solo", riadok ~195), SK verb „soluj" chýba.
  Kontrola: „solo the bass" → `exact` ✓.
- **D6 (P2):** SK nekonzistentnosť: mix komparatív regex pozná ASCII
  `tmavsi` (`src/intent/route.ts:75,108`), ale **vstup sa nikdy nedeaccentuje**
  → dokumentovaný príklad „tmavší zvuk" (INTENT_ENGINE §5.7) padá do
  generovania. Súčasne loudness pozná „hlasitejši" (so š!) ale nie „potichu".
  Každá vrstva rieši diakritiku po svojom — chýba jeden deaccent pre-pass
  (preset názvy ho už majú) alebo explicitné akcentované alternatívy.
- **D7 (P2):** preset intent: gramatika vyžaduje „on <track>" aj resolvovateľný
  názov; dobre formullený „load the trance preset on the lead" aj tak padá do
  `pattern`, `presetUnknown` sa never fire-ne. Target-less „load preset X"
  sa poticho stane NOVÝM BEATOM — v rozpore s duchom least-destructive
  (user chcel načítať, dostal generáciu).
- **D8 (P3, dizajnové rozhodnutie):** „darker techno at 130" → `mix` podľa
  dokumentovanej sémantiky (§5.7: komparatívy = mix). UX otázka: celý žánrový
  prompt s bpm pravdepodobne chce BEAT s tým prívlastkom (audit2 fix 1
  urobil tento posun pre bpm). Necháme na ownera; korpus to pinuje ako
  shipped správanie s odkazom sem.
- **D9 (P2):** „zdvojnásob refren", „duplikuj refren" → `pattern` (malo by
  `arrange`); EN „duplicate the chorus" ✓. Arrangement duplicitná rodina
  nemá žiadne SK synonymá.

---

## 4. Čisté oblasti (defekty nenájdené)

- **Model route (`tryModelRoute`)** — proba s scripted providerom:
  creative-brief prompt → model **0 volaní**, null (guard ✓); action prompt
  → adaptovaná route adoptovaná (deterministická vrstva povedala `pattern`,
  model `transport` — presne to, na čom má model pomôcť) ✓; garbage výstup →
  `null` → deterministický fallback ✓.
- **Prioritná reťaz:** fader nad loudness („make the drums quieter" → fader),
  effectIntent nad mix („more reverb on the drop" → effectIntent), compound
  detekcia, arrange len so scénami, tempo/exact rozdelenie („set tempo to X"
  → exact; „zrýchli to" → tempo), „142 bpm" → exact vs „dark techno at 142
  bpm" → pattern (audit2 fix drží).
- **Transport/save/export/record/undo/query/select** — všetky zelené.
- **Brief-gate engine-side:** prázdnych kandidátov odmieta (D2 diagnostics),
  3/4 release-gate briefov compliance-čistých; štvrtý je D2.
- **buildSong purita:** build nemutuje dokument (H2), harmony plán
  deterministický (H3).

## 5. Pokrytie a medze korpusu

Selection-dependent route druhy (`selectedStepAssist`, `selectedClipArrange`,
`selectedRangeArrange`) a session-scoped exekutory (producer session,
iteration, checkpoint nad živou session) nie sú v statickom korpuse — kryje
ich `intent-checkpoint`, `element-intents-audit`, brief-suite a audit 1–3.
`grooveIntent`/`sectionFlow`/`sectionProduction`/`markerIntent`/`soundSwap`/
`send`/`bypass`/`complaintIntent` ostávajúči čiastočne neprobené (nižšia
frekvencia v UI) — follow-up pre ďalšiu korpusovú vlnu.

## 6. Odporúčané poradie F3

1. D3 (kontrakt, malý diff, odstraňuje data-loss mínu) → 2. D1 (fill seed,
   jeden riadok + test) → 3. D2 (multi-voice lead-only, najťažšie) →
2. D5/D6/D9 (SK vocab vlna, mechanické) → 5. D7 (preset router grammar) →
3. D8 (owner rozhodnutie, potom pin flip).

## 7. F3 rozuzlenie (2026-10-11) — 7/8 defektov FIX, D8 čaká na ownera

- **D3 `9eb9df47`** — `GenerationRanked.proposal` je pri totálnom rejekte
  `null` (+ nové `diagnostics` pole); `resultFromProposal` mapuje na
  `status: "rejected"` s `proposal: undefined`, takže panel guard aj
  `applyGenerationResultCommand` (hádzanie na `!proposal`) konečne chránia
  aktívny pattern. Regress: `tests/intent-rejected-contract.test.ts` (sync/
  async/apply-refusal nad drum-only dokumentom — trigger ostáva rejektný
  aj po D2 fixe).
- **D1 `a0917742`** — fill seed = `contentHash(canonicalizePattern(...))`
  odchádzajúceho patternu + label; **druhá vrstva**: determinizmus test
  serializoval aj náhodné note id-čka (jeho vlastný komentár vraví „ids are
  random uids") — id-stripping doplnený, obsah (rows + note pitch/start/
  duration/velocity) je bit-identický medzi buildmi.
- **D2 `8866dceb`** — skutočný koreň hlbšie než bisect naznačil: parserové
  „dark" nastaví energy 0.3 a `generateMultiVoice` hodil lead voice PRÍSNE
  von pod energy 0.4 (`if (energy > 0.4)`). Nový `leadRequired` parameter:
  explicitná rolová žiadosť (roles obsahuje „lead") nechá lead vyznieť
  riedko, ale nikdy nie na nulu; implicitný full-band ostáva pri legacy
  bráne → goldens nedotknuté (ai-baseline zlyháva identicky aj na F1
  baseline commite — owned ledger red, nie regresia).
- **D5/D6/D9 `42f21c66` + `cf8ad5af` (pohltené kolegom)** — soluj/zosoluj,
  `isMixIntentText` deaccentuje rovnako ako parseMixIntent (guard nikdy
  nie je prísnejší než parser), potichu/ticho, zdvojnásob/duplikuj.
- **D7 `42f21c66`** — studená factory banka hádzala výnimku (router padol
  do patternu); teraz try/catch → clarify „banka sa načítava", target-less
  ask → clarify cieľovej rodiny. Warm-bank cesty (preset/presetUnknown) sú
  nezmenené.
- **D8** ostáva otvorené ako dizajnové rozhodnutie (komparatívy vs. žánrový
  prompt); korpus pinuje shipped správanie s odkazom sem.
- **Korpus** po F3: všetkých 8 `it.fails` defekt pinov premenených na
  bežné očakávania, 106/106 zelených.
- **Follow-up `c71486b9` + `d287f974` (D3 v prirodzenom prostredí):** chord-track a
  intent-song suity padli PO D3 — buildSong hádzal „section Break failed
  generation: brief-gate:empty" na EMPTY template (žiadne inštrumentové
  tracky). Pre-D3 sa takáto melodic-only sekcia (break/bridge) ticho
  inštalovala ako prázdny pattern — presne ten hazard, ktorý D3 zaviera.
  Fix: buildSong toleruje melodic-only sekciu, keď dokument nemá cieľové
  tracky (čestné prázdne telo; applySongCommand kreslí harmonickú planu na
  chord track, ktorý sám vytvára); s bicími alebo resolvovateľnými trackami
  ostáva tvrdá chyba. Plus: `GenerationProvider.generate` teraz kontraktovo
  môže resolve-núť `null` (D3 je interface, nie len lokálny provider).
