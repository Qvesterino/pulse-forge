# INTENT ENGINE — Campaign Plan (fázovaný)

> Plán kampane „pozrieme sa poriadne na Intent Engine".
> Vznikol z mapy povrchu 2026-10-11 (relácia: zmapovanie `src/intent/` +
> `src/ai/` + `src/generative/`, ~73 400 riadkov). Status sa trackuje
> checkboxmi v §5 — update priamo v commite danej fázy.
>
> Súvisiace dokumenty: `INTENT_ENGINE.md` (živá mapa engine), `docs/KYX_PRODUCTION_INTENT_ENGINE_MASTER.md`
> (master špecifikácia produkčnej vrstvy), `docs/LOCAL-INTENT-MODEL.md`,
> `docs/INTENT-VERIFICATION-2026-09-30.md`, `docs/INTENT-MINING-2026-09-30.md`,
> `docs/intent-engine-roadmap.md`.

---

## 0. Diagnóza — prečo táto kampaň

Mapa 2026-10-11 našla štyri veci, ktoré stoja za systémovú prácu (nie ad-hoc fixy):

1. **Dokumentácia zaostáva za realitou.** `INTENT_ENGINE.md` má plnú revíziu
   2026-09-23; nevie o `intent-model-v1` (6.75 MB multi-head ONNX, gate
   PASSED, loader default ON), brief contract/gate, exact intentoch,
   explózii routeru (37 druhov route) ani melodic priore v3. IntentPanel
   popisuje so 119 riadkami — dnes ich má 6 276.
2. **`src/ui/IntentPanel.tsx` je druhý monolit projektu** (po `commands.ts`).
   Audition, bank UI, voice idea, audio referencia, producer session,
   conversation HUD — všetko v jednom súbore.
3. **Generatívne modely sú dátovo hladné.** Melodic prior v3: čestné
   valDegree 0.57 / valDuration 0.50 (manifest hlási `midiCorpusSamples: 0` —
   ingest cesta existuje, nikdy nebola použitá). Drum prior je zdravý
   (valAUC 0.920).
4. **Feedback loop je postavená, ale nikdy nedostala reálny signál.** Ranker
   artifact má `favoriteGroups: 0` — nikdy nebol retrénovaný z reálnych ★.

## 1. Pravidlá kampane (platia pre každú fázu)

- **Invarianty sa nedotýkame**: deterministic fallback pri každom zlyhaní
  modelu, žiadna inferencia v audio callbacku, proposal-only cez command
  systém (1 undo), rovnaký seed + intent + verzie = rovnaký obsah.
- **Golden baselines sú sväté** — default intent musí ísť fast-pathou
  (nezmenené options); ak zmena mappingu posunie rendery, jasně to povedať
  a ísť cez `npm run drift:bless` + review, nie ticho.
- **Každé číslo v dokumentácii musí zvládnuť grep** proti working tree
  (`docs/CURRENT-STATE.md` disciplína).
- **Vedecká integrita pri retraintoch**: honest (unseen) splity s group-key
  leak-guardom, validácia väčšia ako šum (lekcia z melodic auditu: n=28 má
  95 % CI ±18 p.b.), aktivačné pravidlo **predregistrované pred tréningom**.
  ⚠ Numpy retrain nie je bit-deterministický → manifest vždy regenerovať,
  nikdy ho neskrývať.
- **Vlásenie v zdieľanom worktree**: commitovať skoro, stageovať len vlastné
  cesty, falsifikácia cez `git worktree` (nie stash-pop). Súbežný commit
  kolegu, ktorý pohltí moje súbory, nie je incident.
- **Jedna fáza naraz, GO bod pred každou ďalšou.** Fázy sú navrhnuté tak,
  aby každá samostatne niečo zlepšila aj keby kampaň skončila po nej.

---

## 2. Fázy

### F0 — Dokumentová pravda (≈ 0.5 dňa, nízke riziko, read+docs only)

**Cieľ:** mapa znova zodpovedá stroju, kým sa do neho púšťame.

- Plná revízia `INTENT_ENGINE.md`: intent-model-v1 + loader/gate tok,
  brief contract/gate, exact intenty, producer session/iteration,
  personal ranker + producer DNA, 37 route druhov s prioritou,
  melodic v3, reálna veľkosť IntentPanelu, SUNO MODE reťaz.
- Vysvetliť vzťah dvoch „master" dokumentov (`INTENT_ENGINE.md` vs
  `docs/KYX_PRODUCTION_INTENT_ENGINE_MASTER.md`) a crosslinkovať ich.
- `docs/CURRENT-STATE.md`: ak intent čísla nie sú grepovateľné, doplniť.

**Gate:** každé číslo v dokumente zvládne grep; `npm run format:check` zelený.

### F1 — Zelený baseline (≈ 0.5 dňa, read-only)

**Cieľ:** vedieť, na čom stojíme, kým čokoľvek meníme.

- `npm run typecheck`, `npm run format:check`, `npm run drift:check`.
- Cielene prebehnúť intent rodinu testov (~120 súborov: pipeline, parser,
  router, song, mix, priory, ranker, ledger, brief, conversation,
  e2e audity 1–3, golden baselines).
- Červené triážnuť do troch košov: reálny bug / stale pin (očakávaná zmena,
  chýba bless) / flaky. Výstup do `suite-expectations.json` len s ownerom
  a dôvodom.

**Gate:** nulový nevysvetlený červený; inventár klasifikovaný v reporte.

### F2 — Audit porozumenia + routeru (1–2 dni, prevažne read-only)

**Cieľ:** nájsť defekty v tom, ako engine CHÁPE zámer — kde hádže, kde
tresne do zlej route, kde má ticho spadol fallback.

- Najprv prečítať, čo už audity 1–3 + mining 09-30 pokrývajú, aby sme
  **neduplovali** (kultúra projektu). Tento audit cielene smerovať na
  najnovší, ešte neauditovaný povrch: brief contract/gate, exact intenty,
  producer session follow-upy, conversation fadery, iteration,
  intent-model-v1 route (model vs. deterministický parser vs. abstain).
- **Adversariálny prompt korpus** (~200 promptov SK+EN) ako test fixture:
  matica prompt × očakávaná route cez `routeIntentText` — overiť, že
  menej deštruktívna interpretácia vyhráva a `clarify` sa spustí, kde má.
- Overiť brief-gate compliance end-to-end: kandidát, ktorý poruší brief,
  musí skončiť repaired/rejected, nie aceptovaný.
- Falsifikácia nálezov v čistom worktree pred tým, ako sa ohlásia.

**Gate:** defect list s P0–P3, každý nález má repro (test alebo skript).
Deliverable: `docs/INTENT-AUDIT-2026-10.md`.

### F3 — Opravy z auditu (0.5–2 dni, podľa nálezov)

**Cieľ:** každý P0/P1 z F2 opravený s testom, žiadne drive-by refaktory.

- Fix-by-fix, každý so svojím commitom a regress testom.
- Ak fix posunie golden rendery, expliticitne cez `drift:bless` + dôvod.

**Gate:** nové testy zelené + celá intent rodina zelená + typecheck.

### F4 — IntentPanel dekompozícia (2–3 dni, architektonická)

**Cieľ:** 6 276 riadkov → panel shell + collaborator moduly, fasáda
nezmenená (precedent: AudioEngine 6 140 → 2 497 cez 9 collaboratorov).

- Extrahovať do `src/ui/intent/` (alebo hooks/): audition playback + bank
  UI stav, audio referencia, voice idea (YIN/IDEA flow), producer session
  HUD, conversation status, song draft flow. Panel ostáva len renderer.
- **Nezmeniť žiadne správanie** — toto je refactor, nie feature wave.

**Gate:** fasádne props API nezmenené; boot-path budget (App chunk static
closure) bez zhoršenia; intent rodina testov zelená; `npm run build` v rámci
budgetov. Perf porovnanie preview ≤ 250 ms (`npm run ai:performance`).

### F5 — Generatívna kvalita: dáta a retrainty (2–4 dni, data-driven)

**Cieľ:** posunúť najhladnejší model reálnymi dátami, nie architektúrou.

- **Melodic korpus**: napojiť `src/ai/midi-corpus-ingest.ts` na public-domain
  MIDI (manifest hlási `midiCorpusSamples: 0`) → ds.v4 → retrain v3 →
  predfixovaná aktivačná brána (aktivovať len pri zlepšení nad šum na
  honest splite s dostatočným počtom grup).
- **Ranker z reálnych ★**: ak ledger obsahuje signál, `favorites:retrain`
  (všetky tri modely) + validácia. Ak ledger prázdny → nie je čo učiť,
  označiť za owner akciu (★ počas dogfoodingu), NESÍNTETIZOVAŤ signál.
- Po každom retrain regenerovať manifesty (numpy nedeterminizmus) a
  prebehnúť golden baselines.

**Gate:** validácie čestné (unseen grupy), predregistrované pravidlá
zapísané PRED tréningom, artifacts + manifesty v jednom commite s reportom.

### F6 — Uzavretie slučky + owner gates (0.5–1 deň + owner položky)

**Cieľ:** overiť, že to, čo je „default ON", aj reálne funguje userovi.

- Real-browser verifikácia intent-model-v1 route (Chromium: model route
  pri zapnutom gate, fallback pri `pf:intent-model=off`, abstain → parser).
- `scripts/verify-browser.mjs` offline generation flow + Playwright smoke.
- Návrh implicitného signálu (USE bez audition) ako design note — len
  návrh, implementácia až po GO.

**Owner gates (čaká na teba):** LFM2.5/Ollama path vyžaduje lokálny Ollama
server; ★ signál pre ranker retrain potrebuje reálne používanie; event.
deployed smoke URL.

---

## 3. Čo je zámerne mimo scope tejto kampane

- Vocals / neurálna audio syntéza (T5 horizont) — sám beží iný vlak
  (REZONANS vokálny formant harmonizer).
- Nové DSP/worklety, remote/cloud providery, nové ONNX architektúry
  (embedding conditioning roadmap je samostatný dokument).
- SK preklad kompletnej parser slovnej zásoby ako feature — SK pokrytie
  riešime v F2 len ako audit reality, expanzia je až follow-up.

## 4. Riziká a guardrails

| Riziko                                  | Mitigácia                                                               |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Súbežné session v jednom worktree       | commit skoro, len vlastné cesty, worktree pre falsifikáciu              |
| Zlomené golden rendery tichou zmenou    | fast-path pravidlo, `drift:bless` + review, žiadne tiché regenerácie    |
| Self-deprivácia metrík (malé validácie) | predfixované aktivačné pravidlá, CI ľúbivosť, leak-guard na grupách     |
| Numpy retrain nedeterminizmus           | manifest regen vždy, hash v commite, validátor proti manifestu          |
| Bundle budget (F4)                      | boot-path riadok (static closure App chunku) pred/po, nie celkový total |
| Rozbehnutá kampaň bez konca             | GO bod po každej fáze, každá fáza samostatne cenná                      |

## 5. Stav / tracking

| Fáza                           | Stav                 | Commit / dôkaz                                                                                                                                                                                |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0 dokumentová pravda          | ✅ HOTOVÉ 2026-10-11 | `INTENT_ENGINE.md` revízia ⟦10-11⟧ (§3 vlny 09/10, §5.20, §7.2 update, T0 8 modelov, crosslink na master doc) + `CURRENT-STATE.md` melodic v3 riadok                                          |
| F1 zelený baseline             | ✅ HOTOVÉ 2026-10-11 | čistý worktree `D:\pulse-forge-f1` @ 3beef964; detaily nižšie                                                                                                                                 |
| F2 audit porozumenia + routeru | ✅ HOTOVÉ 2026-10-11 | `4368577a` — korpus 106 promptov + `docs/INTENT-AUDIT-2026-10.md`; 3× P1 root-caused (D1/D2/D3), detaily nižšie                                                                               |
| F3 opravy z auditu             | ✅ HOTOVÉ 2026-10-11 | D3 `9eb9df47`, D1 `a0917742`, D2 `8866dceb`, D5/D6/D7/D9 `42f21c66` (+ časť pohltila kolegova vlna `cf8ad5af`); D8 `821e8396` (owner: „genre wins"); detail `docs/INTENT-AUDIT-2026-10.md` §7 |
| F4 IntentPanel dekompozícia    | ✅ HOTOVÉ 2026-10-12 | 6 collaboratorov `f4f6b260`→`5d14cc51`; 6 296 → 5 666 riadkov; boot path 2 114 → 2 116 KB; nulová nová červená; detaily nižšie                                                                |
| F5 dáta a retrainty            | ✅ HOTOVÉ 2026-10-11 | M1 **FAIL** podľa predfixovaného pravidla (degree 0.546 < 0.590) — shipped artefakty nedotknuté; ranker ★ 1/3 pod floorom → owner akcia; detaily nižšie                                       |
| F6 uzavretie slučky            | ⏳                   | —                                                                                                                                                                                             |

### F4 výsledky (2026-10-12, čisté worktree `D:\pulse-forge-f4` @ 5d14cc51)

**Panel: 6 296 → 5 666 riadkov (−630).** Fasáda `export function IntentPanel()` je
nezmenená (žiadne props ani ďalší export); rozdiel je výhradne v extraktovaných
teleš a v hlavičkách modulov.

**Collaboratori (`src/ui/intent/`)**

| Súbor                    | Riadkov | Čo nesie                                                                                                                                                                                                                                                                    |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SongDraftPanel.tsx`     | 646     | ♪ SONG draft: preview, full-song lanes, per-section A/B učenie, loudness odporúčanie, technický audio review, revise. Aj typy `SongDraft`/`SongPreferenceTake`/`SectionPreferenceTake`/`SongPreferenceRank` a helpery `sectionPreferenceOptions`/`sectionCompareSelection`. |
| `CandidateBank.tsx`      | 124     | ▶/■ audition, PRIOR/TPL badge, search lane, ★ best, USE, iterate, AUDIOTOOL, legenda, blind-pilot guard.                                                                                                                                                                    |
| `VoiceIdeaControls.tsx`  | 57      | 🎶 harmonize + 🔊 mic monitor + 🎤 IDEA nahrávanie.                                                                                                                                                                                                                         |
| `ProducerSessionHud.tsx` | 51      | 🎛 session chip, B/C varianty, reset.                                                                                                                                                                                                                                        |
| `StatusLine.tsx`         | 24      | 🤖/⚡ router status + osobný status (jeden komponent, dva call site-y).                                                                                                                                                                                                     |
| `AudioRefChip.tsx`       | 46      | 🎧 ref chip, match EQ, clear.                                                                                                                                                                                                                                               |

**Nula zmien správania.** Vyextrahované komponenty sú čisté renderery: žiadne
hooky, žiadne audio uzly, žiadne mutácie. Shell si ponecháva stav aj všetky
commandy. Dva body si to vyslúžili presun do shellu, nie do workarounds:

- **A/B default.** Pôvodný `onChange` spreadoval `selection` (s _defaultovanými_
  hodnotami z `options[0]/options[1]`), nie `current[key]`. Prvá verzia props
  签名 to zmenila — B dropdown by dostal prázdnu hodnotu. Prop preto nesie celé
  `{ a, b }` a shell robí ten istý spread.
- **AUDIOTOOL.** `onClick` telo (stale-preview guard cez `previewDocRef` vs živý
  doc v `services.store`) sa stal shell verb-om; desktop check zostal v rendereri,
  lebo on rozhoduje či sa tlačidlo vôbec vykreslí.

**Gates (čistý worktree, baseline porovnaný voči `2c2329fc`)**

| Brána                            | Pred                                         | Po                                                            |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| studio boot path                 | 2 114 KB / 2 200                             | **2 116 KB / 2 200** (+2 KB)                                  |
| DAW JS chunks                    | 5 150 KB / 5 160                             | 5 155 KB / 5 160                                              |
| shipped JS total                 | 7 240 KB                                     | 7 246 KB                                                      |
| `typecheck`                      | ✅                                           | ✅ exit 0 (0 chýb)                                            |
| `format:check`                   | ✅                                           | ✅ (jediný warning `tests/probe-split-undo.test.ts` je cudzí) |
| `ai:performance` (budget 250 ms) | mediany 2.56 / 2.49 / 4.41 ms                | mediany 2.70 / 3.08 / 4.27 ms                                 |
| build                            | ❌ REZONANS worklet 74 > 64 KB (cudzia vlna) | ✅ OK — cudziu vlnu medzitým opravila iná session             |

**Testy.** Cielená 9-súborová brána drží **496/496** po každom z šiestich
commitov. Celá intent rodina (142 súborov / 1 973 testov) v čistom worktree:
**17 červených** — a `2c2329fc` baseline na tých istich 10 súboroch dáva
**tých istých 17 zlyhaní, identických podľa názvu**. Nulová nová červená, žiadna
vyliečená. Sú to cudzie vlny: model pin/dataset schema, symbolic + melodic priory,
preset loudness, master decisions, preference evaluation.

**Pozor na `suite-expectations.json`.** Ledger pokrýva 9 z tých 10 súborov, ale
`intent-model-artifact.test.ts` má v ledgeri _iný_ testovací názov
(`model + vocab artifacts match the manifest pins`) než tie, ktoré padajú
(`pins validation metrics...`, `labels overlapping golden prompts...`), a
`intent-model-schema.test.ts` v ledgeri chýba vôbec. Tieto červené sú pre-existing,
`drift:bless` sa neriešil — patrí do ownershipu model/data vlny.

### F1 výsledky (2026-10-11, čistý worktree @ 3beef964 + junction node_modules)

- **Gates:** `typecheck` ✅ exit 0; `format:check` ✅ (čerstvý LF checkout);
  intent test rodina: **125 súborov / 1 757 testov → 1 741 zelených,
  16 červených v 11 súboroch** (dva behy: 17↔16 — flap vysvetlený nižšie).
- **Klasifikácia 16 červených:**
  - **10× už owned** v `suite-expectations.json` (ownery „intent-model wave",
    „concurrent symbolic/grooves retrain wave") — známe, očakávané.
  - **4× NOVÉ stale pins → zapísané do ledgeru** (tento commit): `preset-loudness-audit`
    (pin 74 vs regenerovaných 70 clamp-hitov), `intent-master-decisions` ×2
    (loudness kalibrácia −5 → −7/−6), `preference-evaluation` (rewordovaný
    caveat text). Všetky s ownerom vlny, ktorá dáta posunula (GROW 892801b2,
    Producer DNA ADR 0026–0032).
  - **2× NESCLASSIFIKOVANÉ — zámerne NEblessnuté, idú do F2:**
    1. `tests/intent-sections-fx.test.ts > is deterministic for a fixed seed` —
       `buildSong` dvakrát z rovnakého docu dáva rozdielny obsah sekcií →
       **možná reálna nedeterminizmus (F2 P1)**.
    2. `tests/release-gate-ai-producer.test.ts > brief fidelity "explicit BPM
       - genre"`— proposal nesie violation`"empty"`, test očakáva žiadnu →
         **možný reálny defekt brief gateu (F2 P2)**.
- **Flap 17↔16:** `intent-model-artifact` (flaky: true v ledgeri, mimo môjho
  filtra rodiny) — potvrdené ako flaky machine-state, nie nový nález.
- **`drift:check` @ 8c25f081:** mcp-mirrors ✅, CURRENT-STATE counts ✅;
  **domain-goldens `param-math.json` stale — zaviedol ju `cd5e8603`**
  (melodic table coverage, 18:18) zmenou `definitions.ts` PO poslednom
  blese zlatého (c6680cbf, 17:52). Neblessujem — owner je vlna cd5e8603;
  `npm run drift:bless` + review na nej.
- **Worktree nechávam stáť** (`D:\pulse-forge-f1`, junction na node_modules)
  — F2 ho reuseduje na falsifikáciu.

### F2 výsledky (2026-10-11, full doc: `docs/INTENT-AUDIT-2026-10.md`)

- **Deliverable:** adversariálny korpus `tests/intent-router-corpus.test.ts`
  (98 očakávaní + 8 pinutých defektov cez `it.fails`, zelený) + audit dokument
  s P0–P3, každý nález s repro.
- **Obe F1 stopy root-caused bisectom:**
  - **D1 (P1):** buildSong fill recept seedovaný náhodným `pattern.id`
    (`61607f31`) — porušuje determinizmus invariant; build inak dokument
    nemutuje a harmony plán je čistý.
  - **D2 (P1):** harmony-first vlna (`3971f0c1`) rozbila lead-only generáciu
    — 3/3 prázdnych kandidátov, engine gate ich (správne) odmietne,
    `brief-suite` prechádza vakuovo nad dvoma prázdnymi proposalmi.
  - **D3 (P1):** rejected výsledok nesie definovaný prázzny proposal — UI
    aj apply command guardujú len `!proposal` → tichá inštalácia prázdneho
    patternu je živá cesta. Odporúčané F3 poradie: D3 → D1 → D2.
- **Router korpus nášiel** D5/D6/D7/D9 (SK slovná zásoba + diakritika +
  preset router nedosiahnuteľný) a **D8** (dizajnové napätie: komparatívy
  hijackujú žánrové prompty — dokumentované, čaká owner rozhodnutie).
- **Čisté:** model route (creative-brief guard 0 volaní, adoptácia, garbage
  fallback), prioritná reťaz, transport/save/export/record/undo/query/select,
  brief-gate engine-side enforcement, buildSong purita.

### F3 výsledky (2026-10-11, detail: `docs/INTENT-AUDIT-2026-10.md` §7)

- **7/8 defektov FIX, každý vlastným commitom s regress testom:**
  D3 `9eb9df47` (rejected ⇒ žiadny applyable proposal — dátová mína
  odstránená), D1 `a0917742` (fill seed = content hash; determinizmus test
  navyše prestal serializovať náhodné note id-čka), D2 `8866dceb`
  (leadRequired — koreň bol `energy > 0.4` brána v multi-voice; parserovo
  „dark" = energy 0.3 = lead-only intent bez jedinej noty), D5/D6/D7/D9
  `42f21c66` (SK slová + deaccent guardu + preset ask nikdy nový beat).
- **D8 RESOLVED `821e8396`** — owner rozhodnutie „genre wins": tone
  komparatív + žánrový signál = popisný prívlastok → generácia; holý
  komparatív → mix; mix podstatné mená (reverb/punch/pump) ostávajú mix
  aj so žánrom; revise len bez žánru. §5.7 superseded, korpus 108/108.
- **Korpus:** 8 `it.fails` pinov → bežné očakávania, 106/106 zelených.
- **Lekcia:** worktree checkout blokujú untracked súbory (vývoj korpusu
  priamo vo worktree) a `--detach main` abortuje — overovať `git log -1`
  worktree PO každom checkoute; jedno F3 overenie bežalo omylom na F1
  baseline.

### F5 predfixované pravidlá (ZAPÍSANÉ 2026-10-11, PRED tréningom)

**Experiment M1 — melodic prior v3 + MIDI korpus.** Shipped
`symbolic-melodic-v3` trénoval výhradne na knižnici (manifest:
`midiCorpusSamples: 0`, valDegreeAcc 0.5699 / valDurationAcc 0.5) — v3
dataset generator odmietol dva nikdy-necommitnuté subset súbory ticho.
F5 posiela do tréningu PLNÝ W2 korpus (`midi-melodic-dataset.json`,
29 730 v1-riadkov / 645 grup classical.* rodín, Public Domain, license
manifest) re-embeddovaný cez chord ladders, TRAIN-only; validácia ostáva
knižnične čistá.

- **Aktivačné pravidlo (predregistrované):** SHIP corpus-trained v3 iba ak
  `valDegreeAcc ≥ 0.5899` (+0.02 nad shipped) **a** `valDurationAcc ≥ 0.49`
  (v šume shipped). Inak **FAIL** → shipped artefakty sa nedotknú, čísla sa
  dokumentujú. Zdôvodnenie prahu: val ~1.4k riadkov → binomické 95 % CI
  ±2.6 pp — jednosplitové delty pod 2 pp sú šum (lekcia z melodic auditu).
- **Čestnosť:** numpy retrain nie je bit-deterministický → pri SHIPe sa
  manifest regeneruje vždy; report sa ukladá. Porovnanie je výhradne proti
  shipped manifestu na rovnakom protokole (knižnične čistá validácia);
  žiadne miešanie s v1/v2 číslami z iných splitov.
- **Ranker z reálnych ★:** ak neexistuje exportovaný favorites pack
  (ledger žije v prehliadači), signál NEexistuje → NESÍNTETIZOVAŤ; owner
  akcia = ★ počas dogfoodingu + `favorites:retrain`.

### F5 výsledky (2026-10-11)

- **M1 (v3 + MIDI korpus): HONEST FAIL.** Korpus (29 730 v1-riadkov / 645
  classical.* grup) prešiel cez chord ladders do v3 datasetu
  (30 428 vzoriek / 934 grup) a tréning (report-only, artifacts nedotknuté)
  dal **valDegreeAcc 0.5461 / valDurationAcc 0.5597** — degree prah
  0.5899 nesplnený → **neposlané**, shipped `symbolic-melodic-v3` ostáva.
  W2 záver sa potvrdil aj pre chord-aware architektúru: klasický kontrapunkt
  trénovaný spolu s elektronickou knižnicou degree hlave nepomáha.
  **Kvalifikácia čestnosti:** val kompozícia sa proti shipped manifestu
  líši (knižnica narástla o rock/jazz/drill; val 293 riadkov) — porovnanie
  je protokolovo anchored na shipped manifest čísla podľa predfixovaného
  pravidla; delta nie je čisto atribuovateľná korpusu.
- **Follow-up (ak sa niekto vráti k corpu):** per-fold gate nad v3 receptom
  (gate skript dnes podporuje len v1/v2), alebo corpus ako per-žáner mixture
  component s vlastnou váhou — nie merge 1:1 do trénu.
- **Ranker ★:** pack `listening/favorites-pack.json` existuje, ale **1
  entry** < confidence floor 3 → retrain by pretrénoval na jednej rolke.
  Owner akcia: ★ nazbierať aspoň 3 (ideálne 10+) počas dogfoodingu, potom
  `npm run favorites:retrain -- listening/favorites-pack.json`.
- **Tooling:** v3 dataset generator má `--out <file>` (experimenty píšu do
  separátneho súboru; shipped tréningové dáta ostávajú na disku) a
  MIDI_SOURCES ukazuje na reálny plný korpus (tiché skipy phantom subsetov
  boli príčinou `midiCorpusSamples: 0`).

_Celkový odhad: ~8–14 dní fokusnej práce pri plnom prechode; F0+F1 spolu
jeden dlhší večer. F2/F4/F5 sú navzájom nezávislé — poradie F2→F3→F4→F5
je odporúčané (najprv pravda a defekty, potom štruktúra, potom kvalita),
ale dá sa swapnúť podľa priority._
