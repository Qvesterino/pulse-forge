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

| Riziko | Mitigácia |
| --- | --- |
| Súbežné session v jednom worktree | commit skoro, len vlastné cesty, worktree pre falsifikáciu |
| Zlomené golden rendery tichou zmenou | fast-path pravidlo, `drift:bless` + review, žiadne tiché regenerácie |
| Self-deprivácia metrík (malé validácie) | predfixované aktivačné pravidlá, CI ľúbivosť, leak-guard na grupách |
| Numpy retrain nedeterminizmus | manifest regen vždy, hash v commite, validátor proti manifestu |
| Bundle budget (F4) | boot-path riadok (static closure App chunku) pred/po, nie celkový total |
| Rozbehnutá kampaň bez konca | GO bod po každej fáze, každá fáza samostatne cenná |

## 5. Stav / tracking

| Fáza | Stav | Commit / dôkaz |
| --- | --- | --- |
| F0 dokumentová pravda | ⏳ čaká na GO | — |
| F1 zelený baseline | ⏳ čaká na GO | — |
| F2 audit porozumenia + routeru | ⏳ | — |
| F3 opravy z auditu | ⏳ | — |
| F4 IntentPanel dekompozícia | ⏳ | — |
| F5 dáta a retrainty | ⏳ | — |
| F6 uzavretie slučky | ⏳ | — |

_Celkový odhad: ~8–14 dní fokusnej práce pri plnom prechode; F0+F1 spolu
jeden dlhší večer. F2/F4/F5 sú navzájom nezávislé — poradie F2→F3→F4→F5
je odporúčané (najprv pravda a defekty, potom štruktúra, potom kvalita),
ale dá sa swapnúť podľa priority._
