# KYX — AI-first producer implementation roadmap

> Stav: plán; baseline skontrolovaný v pracovnom strome 2026-09-24  
> Produktový cieľ: lokálny AI producent, ktorý rozumie zámeru, tvorí kvalitné a upraviteľné návrhy a nemení používateľovi projekt poza chrbát.  
> Vzťah k ostatným plánom: tento dokument skladá Intent Engine, song production a MRT2 do jedného používateľského workflow. Nenahrádza `INTENT_ENGINE.md`, `docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md` ani `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`.

> **Aktualizácia 2026-10-02:** normatívne správanie produktu definuje `docs/AI-PRODUCER-CONTRACT.md`. Historické fázy 0–8 nižšie zachovávajú pôvodný vývojový záznam; aktuálnu ďalšiu exekučnú sekvenciu, závislosti a brány definuje §6. Staršie výsledky testov ani historické bundle limity nie sú tvrdením o stave dnešného `HEAD`.

## 1. Produktová predstava

KYX má pôsobiť ako producent a zvukár, ktorému poviem, čo chcem dosiahnuť, a ktorý mi pomôže ten výsledok reálne vyrobiť. Nie ako promptové tlačidlo, ktoré vygeneruje hotový súbor bez možnosti rozumieť alebo rozhodovať o tom, čo sa zmenilo.

```text
brief používateľa + kontext projektu
        ↓
interpretácia: čo je povinné, čo je želanie, čo sa nesmie meniť
        ↓
niekoľko kandidátov → kontrola kvality → audition / A-B
        ↓
cieľová úprava alebo aranžmán → nový audition
        ↓
mix / technická kontrola → používateľ potvrdí zmeny
        ↓
undoable KYX command → normálny, editovateľný projekt
        ↓
voliteľne: MRT2 výkon → capture/freeze do normálneho audio klipu
```

Rozdiel oproti „Suno, ale s kontrolou“ má byť konkrétny:

- Tvrdé požiadavky majú prednosť pred štýlovou podobnosťou a skóre modelu. Ak používateľ žiada 142 BPM, bez vokálov a zachovanie bassu, ranker nesmie tieto požiadavky prehlasovať.
- Pred prijatím návrhu je zrejmé, čo sa zmení. Používateľ môže kandidátov počuť, porovnať a odmietnuť.
- Následný pokyn typu „druhý, ale temnejší; bass a akordy nechaj“ upravuje iba určený rozsah a zachováva zvyšok.
- Každé prijatie je projektová zmena cez command systém s undo/redo. Modely nikdy priamo nemenia projekt ani audio callback.
- Základný beatmaker funguje lokálne a offline aj bez voliteľných veľkých modelov. MRT2 je samostatný, voliteľný generatívny performer — nie podmienka fungovania DAW.

### Produktová hranica: KYX a ZYVO sú špecialisti

KYX sa sústreďuje na beatmaking a inštrumentály: groove, bicie, bass, harmóniu, melodické roly, aranžmán a beatový
mix. ZYVO sa sústreďuje na vokálovú produkciu: nahrávanie, správu take-ov, comping, úpravy vokálu a vokálovo
orientovaný mix. Obe aplikácie zdieľajú princíp AI producenta — porozumieť zámeru, rešpektovať chránený materiál,
navrhnúť ohraničenú zmenu a nechať tvorcu výsledok vypočuť a potvrdiť — nie povinnosť zlievať sa do jedného
preplneného DAW.

Pre KYX to znamená, že vokál môže byť vstupným kontextom na vytvorenie priestoru pre spev alebo na prispôsobenie
inštrumentálu, no kompletné vokálové nahrávacie štúdio nie je podmienkou úspechu tejto roadmapy. Prenos medzi
produktmi je samostatná, neskoršia fáza: prenáša sa len používateľom schválený Producer Brief a výslovne vybrané
médiá, nie automaticky celý projekt, vokály ani texty.

**Praktická postupnosť:** najprv spoľahlivo oddeliť príkazový model od kreatívneho briefu; potom preukázať kvalitu
modelu na držaných-out dátach; dodať kompletný KYX beatmaking loop od briefu cez audition po undoable apply; až
následne odstrániť developer-only setup lokálneho modelu, učiť sa výslovné preferencie producenta a stabilizovať
prenos briefu do ZYVO. Podrobné fázy, závislosti a release gates sú v §6.

## 2. Čo už dnešný kód poskytuje

Toto je plán nad existujúcou infraštruktúrou, nie návrh na jej nahradenie.

| Schopnosť dnes                                                                            | Reálne miesto v kóde                                                                                                                    | Dôsledok pre plán                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalizovaný a verzovaný intent, plán generovania, seed-y a role/track targets           | `src/intent/types.ts`, `normalize.ts`, `schema.ts`, `plan.ts`, `hash.ts`                                                                | Rozšíriť kontrakt o požiadavky a rozsah editácie bez toho, aby sa z neho stal voľný prompt blob.                                                                |
| Textový parser s rozpoznávaním vybraných hudobných vlastností                             | `src/intent/text-parser.ts`                                                                                                             | Zlepšovať ho testami na reálne briefy; nepovažovať ho za všeobecné porozumenie ľubovoľnému jazyku.                                                              |
| Deterministický pattern generator, invariant gate, repair a fallback                      | `src/intent/providers/local.ts`, `src/intent/quality.ts`, `src/ai/invariants.ts`                                                        | Zachovať ho ako bezpečný a reprodukovateľný základ.                                                                                                             |
| Candidate bank, ONNX ranking vo Worker-i a voliteľné zvukové prehodnotenie finalistov     | `src/intent/candidate-bank.ts`, `src/ai/ranking/`, `src/intent/audio-feedback.ts`, `src/intent/ranking-v3.ts`, `src/intent/pipeline.ts` | Doplniť rankovanie o splnenie briefu a dôkaz ľudských preferencií; model stále iba vyberá z validných návrhov.                                                  |
| Audition kandidátov a aplikovanie presne vybraného návrhu                                 | `src/ui/IntentPanel.tsx`, `src/intent/pipeline.ts` (`includeBank`, `resultForCandidate`), `src/commands/commands.ts`                    | Rozšíriť existujúcu cestu na súvislý workflow, nie vytvárať paralelný generator UI.                                                                             |
| Jednoduchý session kontext a odkazy na posledných kandidátov                              | `src/intent/session-context.ts`                                                                                                         | Zatiaľ ide najmä o posledné generovanie, ordinals a obmedzenú históriu; nie o všeobecnú dlhodobú konverzáciu.                                                   |
| Skladanie skladby, sekcie, transitions, FX/mix a voliteľná vocal-aware tvorba             | `src/intent/compose.ts`, `song.ts`, `mix.ts`, `production.ts`, `loudness.ts`                                                            | Zjednotiť s tým istým briefom a audition/commit modelom. Súčasná skladba generuje sekcie cez sync `generateLocalResult`, nie cez plný async bank + ranker path. |
| Mix/audio feedback a spoločný offline renderer                                            | `src/intent/audio-feedback.ts`, `src/rendering/renderer.ts`, `src/audio-engine/AudioEngine.ts`                                          | Rozširovať technické merania a počúvateľné A/B; nerobiť z proxy metrík tvrdenie o umeleckej kvalite.                                                            |
| Provider-neutral generative runtime, KYX conditioning, bounded playback a durable capture | `src/generative/`, `src/generative/capture.ts`, `src/generative/providers/mrt2/`                                                        | MRT2 napojiť ako voliteľný performer a jeho výstup zmraziť do štandardného `AudioClip`. Platformové realtime schopnosti treba dokazovať samostatne.             |
| Lokálne/opt-in AI pomocné vrstvy a fallback                                               | `src/ai/semantic/`, `src/ai/symbolic/`, `src/ai/ranking/`                                                                               | Základ nesmie vyžadovať sťahovanie sémantického modelu ani zlyhať, ak model chýba.                                                                              |

### Stav, ktorý treba najprv overiť

Ranker podklady si odporujú: aktuálny `src/ai/ranking/ranker-client.ts` nastavuje default `active`, manifest `public/models/intent-ranker-v1.manifest.json` uvádza `ready-for-active`, no `docs/intent-engine-ai-ranker-goal.md` stále opisuje `shadow` a neplatnú golden evaluáciu. Navyše manifest uvádza `favoriteGroups: 0`, čiže to nie je dôkaz personalizácie podľa vkusu používateľa. Prvá implementačná fáza musí spustiť aktuálne validátory nad aktuálnymi dátami/modelom a zosúladiť tieto tvrdenia; roadmapa sama neoznačuje model za hudobne kvalitný.

Ďalšie dôležité hranice:

- Sémantické embeddingy nie sú samy osebe parserom požiadaviek. Voliteľný multilingual MiniLM sa fetchuje cez `npm run semantic:fetch` a je približne 118 MB; bez neho musí fungovať parser/fallback. Audio embedding model je tiež voliteľný a samostatne sťahovaný.
- Ranker iba zoradí vytvorené kandidáty. Kvalitný natural-language intent compiler, požiadavkové hard gates a cielené úpravy existujúceho aranžmánu sú samostatná práca.
- MRT2 modelové váhy a host runtime nie sú bežná browser dependency. Mac native a Windows companion majú vlastné buildy, distribúciu a hardening; podporu nemožno deklarovať len podľa existencie adaptera alebo mock testu.

## 3. Implementačné fázy

Fázy sú zoradené podľa rizika a závislostí. Začať sa má fázou 0; ďalšie možno rozdeliť do malých PR. Žiadna fáza neoprávňuje meniť pracovné zmeny mimo svojho scope.

### Fáza 0 — pravdivý baseline a testovacia sada briefov

**Cieľ:** vedieť zmerať, či KYX naozaj plní pokyny a či nová vrstva zlepšuje hudbu oproti dnešnému základu.

**Práca:**

1. Znovu prejsť ranker režim, model manifest/hash, golden dáta a aktivačný validator. Zosúladiť `docs/intent-engine-ai-ranker-goal.md`, `INTENT_ENGINE.md` a `docs/CURRENT-STATE.md` s tým, čo testy a runtime skutočne potvrdia.
2. Založiť verziovanú sadu promptov (začať SK aj EN) s očakávanými extrahovanými požiadavkami. Pokryť napr. BPM/key/dĺžku, „bez vokálov“, „nechaj 808“, „menej husté“, konkrétnu rolu, žáner/mood a nejednoznačný brief.
3. Pri každom teste rozlíšiť: správnosť interpretácie, splnenie hard constraints, deterministickosť, hudobnú validitu, latenciu a ľudský vkus. Tieto skóre nezlievať do jediného „AI quality“ čísla.
4. Zachytiť aktuálny benchmark pre parser, candidate bank, song generation a model fallback. Vytvoriť krátky blind listening review pre ľudské preferencie; syntetické dáta vytvorené dnešnou heuristikou nie sú náhradou za ľudské hodnotenie.

**Kód a dôkazy:** `scripts/validate-intent-ranker-golden.mjs`, `scripts/validate-intent-ranker.mjs`, `scripts/ai-performance.mts`, `scripts/data/intent-ranker-*`, `tests/intent-ranker-golden.test.ts`, `tests/rank-candidates.test.ts`, `tests/intent-text-parser.test.ts`.

**Hotovo, keď:** ranker status je jednoznačne zdokumentovaný a zopakovateľne validovaný; existuje baseline a prompt suite, ktorá oddeľuje presné požiadavky od subjektívnych preferencií. Ak gate zlyhá, ranker sa nesmie potichu vydávať za overeného selektora.

**Stav (2026-09-24): Fáza 0 DOKONČENÁ.**

- Ranker: `DEFAULT_RANKER_MODE = "active"` (`src/ai/ranking/ranker-client.ts`), oba validátory
  passujú — `validate-intent-ranker.mjs` (SHA-256 sedí) a `validate-intent-ranker-golden.mjs`
  (8 groups / 24 pairwise / 4 žánre, spĺňa ≥12-pairwise bránu). Goal doc zosúladený, starý
  nevalidný golden archivovaný. Ponechaný pravdivý caveat: model učí z heuristic teacher
  signálu (`favoriteGroups: 0`), nie z ľudských preferencií.
- Brief suite: `tests/intent-brief-suite.test.ts` — SK/EN interpretácia (BPM, key, žáner),
  determinizmus (rovnaký brief + seed → identický `intentHash` aj pattern rows), seed variácia;
  očakávania testujú extrahované požiadavky (`normalizeIntent`), nie subjektívnu kvalitu.
- Blind listening scaffold: `listening/room/room.html?blind=1` — maskuje názvy/kategórie
  („Variant N“), mieša poradie variantov, tlačidlo REVEAL odhalí identity; verdikty sa
  ukladajú so skutočnými id + `blind` flagom (ingest kontrakt nezmenený). Pri tom vyriešený
  latentný bug: morph/scenes labely v room json boli doteraz `undefined` (factory presets
  majú pole `name`, render skripty čítali `label`).
- **Otvorené (ľudská práca, nie kód):** reálne blind posedenie — verdikty cez room UI →
  `listening/verdicts.json` → `npm run listening:ingest`; to je vstup pre Fázu 4 (retrain).

### Fáza 1 — používateľský brief ako explicitná špecifikácia

**Cieľ:** z voľného textu zostaviť krátke, opraviteľné „toto som pochopil“ ešte pred generovaním.

**Navrhovaný tok:**

```text
„142 bpm, temný trap, bez ďalších bicích; nechaj môj bass a akordy.“
        ↓
POVINNÉ: 142 BPM; nevytvárať/nenahrádzať bicie
PREFERENCIE: temný trap
ZACHOVAŤ: bass + chords v projekte
NEISTÉ: tónina nebola zadaná
        ↓ používateľ potvrdí alebo opraví
```

**Práca:**

- Rozšíriť intent contract tak, aby oddelil hard constraints, soft preferences, negatívne pokyny a explicitne chránené tracky/roly/sekcie. Pridať pôvod a confidence/unknown stav parsovaných tvrdení; nízka istota nesmie byť prezentovaná ako fakt.
- Zadefinovať kompiláciu textu + projektového kontextu na tento kontrakt. Keyword parser ostáva lacný deterministic path; sémantický model je voliteľná pomoc, nie skrytá autorita.
- Rozšíriť `normalizeIntent`, `schema`, `hash` a `plan` tak, aby sa každý nový parameter validoval, serializoval a reproducibilne vstupoval do seedu/content provenance.
- Pridať UI súhrn interpretácie do existujúceho `src/ui/IntentPanel.tsx`; používateľ môže jednotlivé body opraviť bez prepisovania promptu.
- Ak zmena mení uložený project model/provenance, spraviť migration cez `SCHEMA_VERSION` a `migrateProject`. Ak je kontrakt iba transientný, zbytočne nemeníme project schema.

**Kód/testy:** `src/intent/{types,normalize,schema,hash,plan,text-parser,semantic-conditioning}.ts`, `src/ui/IntentPanel.tsx`; rozšíriť `tests/intent-text-parser.test.ts`, `tests/intent-pipeline.test.ts`, `tests/intent-semantic*.test.ts` a pridať golden brief fixtures.

**Hotovo, keď:** golden sada spoľahlivo rozpozná tvrdé požiadavky a zákazy; neznáme/nejednoznačné veci sú viditeľné; chýbajúci model nemení bezpečnostné pravidlá ani nezablokuje generation.

**Stav (2026-09-24): FÁZA 1 DODANÁ.**

- Kontrakt: `src/intent/brief-contract.ts` kompiluje parsed brief + producer session + projekt do
  POVINNÉ / PREFERENCIE / ZÁKAZY / ZACHOVAŤ / NEISTÉ; každý statement nesie `origin` a
  `confidence` — neistoty sú prvotriedne a nepredávajú sa ako fakty.
- Nové `preserve` pole v `IntentSpec` (explicitne chránené roly): parser SK/EN („nechaj bass a
  akordy", „keep my drums"), sanitizácia + validácia + deterministický hash, enforcement v pláne
  aj options — chránený obsah sa pri generovaní neprepíše. Kontrakt je transientný: project
  schema zostáva nedotknutá.
- UI: `BriefContractSummary` v IntentPaneli pod promptom — oprava jednotlivých bodov bez
  prepisovania promptu (one-click návrhy zo session, inplace BPM/takty edit, × un-protect).
- Testy: `tests/brief-contract.test.ts` (22) + `tests/ui/BriefContractSummary.test.tsx` (6);
  regresia intent rodina 218/218; `tsc --noEmit` 0.
- Otvorené: keyword parser ostáva jediným deterministic path; sémantický model je stále len
  voliteľná pomôcka (Fáza 2+); golden fixtures rastú s `tests/intent-brief-suite.test.ts`.

### Fáza 2 — návrh, kandidáti a používateľské rozhodnutie

**Cieľ:** každý beat návrh je počuteľný, porovnateľný a jeho aplikovanie použije presne ten kandidát, ktorý si človek vybral.

**Práca:**

- Zjednotiť preview plochy na `generateAsyncResult(..., { includeBank: true })`, kde je pre danú úlohu relevantný bank a ranker. Zachovať odôvodnené sync fast paths pre okamžité preview a offline tooling.
- Všetky kandidáty najprv prehnať hard gate-ami a deterministickou opravou; až potom ich zoradiť. Candidate bank nesmie obsahovať výsledok, ktorý porušuje tvrdý brief.
- Zobraziť pri návrhu splnené/nesplnené požiadavky, zdroj kandidáta, prípadné opravy a stav modelového/fallback výberu. Technické skóre neprezentovať ako objektívnu umeleckú známku.
- Zachovať existujúci `resultForCandidate` → `applyGenerationResultCommand`: vybraný preview sa nesmie pri tlačidle Apply v tichosti pregenerovať.
- Pred aplikovaním overiť, že projekt/targety sa od preview nezmenili; zrušená alebo zastaraná generation nesmie zapísať výsledok.

**Kód/testy:** `src/intent/pipeline.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/ai/ranking/`, `src/ui/IntentPanel.tsx`, `src/commands/commands.ts`; `tests/candidate-audition.test.ts`, `tests/intent-async-pipeline.test.ts`, `tests/intent-ranker-active.test.ts`, UI race tests a E2E generation flow.

**Hotovo, keď:** presne ten vypočutý kandidát sa aplikuje cez jeden undoable command; všetky hard constraints sú gate-ované pred rankingom; timeout, chýbajúci model aj offline režim dávajú deterministic fallback alebo jasnú chybu bez pádu UI.

**Stav (2026-09-25): FÁZA 2 DODANÁ.**

- Hard brief gate PRED rankingom: `src/intent/brief-gate.ts` → `briefGateViolations(pattern, plan)`
  beží v `evaluateCandidate` (accepted aj repaired path) — zlý stepCount, úplne tichý kandidát
  (invarianty ho pustia!) a prohibovaný bicí obsah (ZÁKAZY/ZACHOVAŤ na úrovni obsahu) dropnú
  kandidáta ešte pred bankou; dôvody v diagnostike (`candidate-N:brief-gate:<id>`).
- Compliance report: `evaluateBriefCompliance(result)` — pravdivé ✓/✗/· per hard fakt; `·` =
  plan-enforced alebo neoverovateľné; žiadne technické skóre sa neprezentuje ako umelecká známka.
- UI: compliance riadok nad kandidátnou bankou; stale guard — USE zablokuje s jasnou chybou,
  keď sa projekt zmenil od vypočúvania (žiadne tiché prepísanie starým návrhom).
- Overené existujúce: `resultForCandidate` → `applyGenerationResultCommand` (presne vypočutý
  kandidát, jeden undo); model timeout/absencia/offline → deterministický fallback
  (circuit breaker, `tests/intent-async-fallback.test.ts`).
- Testy: `tests/brief-gate.test.ts` (12); regresia intent+candidate rodina 222/222 (19 súborov).

### Fáza 3 — konverzačný beatmaker a cielené zmeny

**Cieľ:** používateľ môže iterovať: „druhý je lepší, ale temnejší; nechaj bass a akordy“ — bez resetu celej session.

**Práca:**

1. Rozšíriť `session-context.ts` z referencie na posledný bank na explicitný, projektom ohraničený generation session: brief, kandidáti, aktuálny výber a nadväzujúce pokyny. Predvolene je session dočasná; dlhodobé uloženie musí byť vedomé a lokálne.
2. Kompilovať následnú požiadavku na edit proposal: `targets` (napr. drums), `preserve` (bass/chords), požadovaná zmena a dotknuté pattern/section IDs. Rozsah zmeny je súčasť návrhu, nie implicitná side effect.
3. Pridávať cielenú regeneráciu existujúcich rolí/sekcií cez existujúce intent `roles`, `targetTracks`, `sourcePatternId` a command systém. Nedotknuté dáta sa znovu nepíšu a musia mať test na rovnaký content hash.
4. Ponúknuť A/B: predchádzajúci stav verzus návrh; používateľ môže auditionovať a až potom prijať. Jedna prijatá iterácia = jedna zrozumiteľná undo jednotka.
5. Zaviesť revízne ID/optimistic validation pre prípad, keď projekt počas generovania zmení používateľ alebo collab peer.

**Kód/testy:** `src/intent/session-context.ts`, `conversation.ts`, `route.ts`, `pipeline.ts`, `src/commands/`; `tests/session-context-audit.test.ts`, `tests/conversation-intents.test.ts`, targeted command undo/redo a collaboration tests.

**Hotovo, keď:** konkrétny referenčný pokyn mení len deklarované targety, protected content ostáva bitovo/obsahovo rovnaký a odmietnutý proposal nezanechá zmenu v projekte.

**Stav (2026-09-25): FÁZA 3 DODANÁ (jadro).**

- `src/intent/iteration.ts`: `compileIteration(text, session, doc)` — session reference + reziduál
  → cieľovaný návrh: `{reference, patch, preserve, targets, summary, 1-kandidátový result, before}`.
  Rozsah zmeny je vyjadrený v summári; deterministický.
- Splice pravdovravnosť: drums-only target splicne rows/stepMeta (notes content-identické —
  hash test); melodika zdieľa tracky, takže sa regeneruje ako blok alebo sa ponechá pri
  chránenej melodicej role — summary to vypovedá. Reziduálne role direktívy prepisujú
  kandidátske; explicitné „žiadne bicie" fyzicky odstráni rows aj step metadata a finálny
  zložený pattern znovu prejde brief gate. Pri zmene dĺžky sa chránené rows/notes bezpečne
  orežú alebo doplnia; summary túto zmenu rozsahu prizná.
- UI: iteration branch pred instant re-apply; návrh ide cez štandardnú banku (audition, USE =
  jeden undo, compliance riadok, stale guard z Fázy 2). Zamietnutý alebo bez cieľa návrh už
  nespadne do okamžitého re-apply; session referencie sú kontrolované proti project ID.
- Provenance sa počíta pre finálny splice; zvolený kandidát poskytuje seed aj source content,
  výsledná banka má skutočný content hash a opätovné použitie ID nevytvorí duplicitné pattern/note IDs.
- Session ostáva dočasná a projektom ohraničená (docId); trvalé uloženie neexistuje bez
  vedomia používateľa (roadmap bod 1 ✓ v rozsahu „predvolene dočasná").
- Testy: `tests/iteration.test.ts` (19) — content-hash identita chráneného obsahu, hard gate po
  splice, no-drums removal, resize + preservation, cross-project odmietnutie, one-undo
  round-trip, determinizmus, odmietnutie bez cieľa a provenance/identity integrity.
- Otvorené: A/B audition pôvodného stavu ide cez ghost time-machine (existujúce), nie ako
  druhé ▶ tlačidlo v návrhu; revízne ID proti collab peer zmenám pokrýva stale guard
  (referenčná identita doc objektu) — plnohodnotný revision ledger je Fáza 5 priestor.

### Fáza 4 — ranker, ktorý sa zlepšuje podľa reálnych preferencií

**Cieľ:** ONNX pomáha vyberať hudobne lepší a briefu vernejší výsledok, nie iba napodobňuje dnešnú heuristiku.

**Práca:**

- Rozšíriť feature contract až po uzamknutí evaluácie: skóre splnenia briefu, pattern/motif kvalita a prípadne merania z offline renderu. Hard constraints zostávajú mimo modelu ako gate.
- Použiť lokálny favorites ledger iba ako zdroj dobrovoľného, používateľom kontrolovaného učenia/exportu. Bez tichého telemetrického odosielania a bez učenia na pozadí v browseri.
- V tréningovom toolingu oddeliť synthetic heuristic teacher od ručných pairwise volieb. Dataset, split, manifest, feature version a SHA-256 modelu musia byť reprodukovateľné.
- Držať shadow/fallback možnosť. Režim `active` zapnúť alebo zmeniť iba po held-out evaluácii, ľudskom blind review a porovnaní s aktuálnym heuristic baseline.
- Neskôr otestovať, či rankovanie po sekciách stačí aj pre celé skladby. Kandidátom na song-level výber môže byť celá zostava, nie len samostatný pattern; rozhodnúť podľa latencie a kvality meranej na benchmarku.

**Kód/testy:** `src/ai/features/`, `src/ai/ranking/`, `src/intent/candidate-bank.ts`, `audio-feedback.ts`, `favorites.ts`, `favorites-core.ts`; `scripts/generate-intent-ranker-dataset.mts`, `scripts/generate-intent-ranker-favorites.mts`, `scripts/train-intent-ranker.py`, validators a golden tests.

**Hotovo, keď:** model porazí baseline na vopred definovanej, held-out ľudskej evaluácii bez zhoršenia splnenia briefu, determinismu a výkonu. Konkrétne prahy sa stanovia až po baseline; metrika „zhoda s heuristikou“ sama osebe nestačí.

### Fáza 5 — celý aranžmán v tom istom workflow

**Cieľ:** z jednej špecifikácie vyrobiť preview celej skladby, a potom ju iterovať po sekciách podobne ako producent.

**Práca:**

- Zjednotiť existujúce `GENERATE`/`DO IT`/song flows cez spoločný brief → proposal → audition → apply lifecycle. Nepoužívať viacero podobných tlačidiel s odlišnými pravidlami mutácie.
- Z `composeFullTrack()` a `buildSong()` zachovať existujúce song form, transitions, scoped FX, mix profile a vocal-aware vstupy; pridať im ten istý požiadavkový report a edit scope.
- Preskúmať celoskladbové varianty a async rankovanie. Súčasný `buildSong()` používa pri sekciách sync `generateLocalResult`; návrh pipeline musí explicitne riešiť candidate count, čas/render náklady, stabilné section seed-y a možnosť zmeniť len VERSE alebo DROP.
- Preview musí predstavovať presne to, čo sa aplikuje. Song, mix a prípadná loudness úprava majú byť buď jedným bezpečným transakčným commandom, alebo jasne oddelenými a samostatne previewovateľnými undo krokmi — nie skrytým vedľajším efektom.
- Zachovať vokál ako voliteľný kontext pre formu a mix. Zmeny v prebiehajúcej vocal-aware implementácii sa integrujú až po jej review; roadmapa nevyžaduje jej prepis.

**Kód/testy:** `src/intent/{compose,song,mix,production,loudness}.ts`, `src/ui/IntentPanel.tsx`, `src/commands/commands.ts`; `tests/suno-mode.test.ts`, `tests/song-auto-produce.test.ts`, `tests/intent-song.test.ts`, `tests/intent-production.test.ts`, `tests/vocal-produce.test.ts`, E2E a live/offline render parity.

**Hotovo, keď:** používateľ počuje aranžmán ešte pred commitom, môže meniť konkrétnu sekciu bez zmeny chránenej časti a aplikovanie/undo zodpovedá tomu, čo UI sľúbilo.

**Stav (2026-09-25): prvý AI-producer vertical slice dodaný; fáza pokračuje.**

- SUNO compose v `IntentPanel` posiela tri alternatívy na sekciu do async candidate/ranker pipeline. Pri dostupnej sample banke sa najlepšie dve alternatívy preveria offline audio-fit rankingom; bežné `buildSong()` volania si zachovávajú jednokandidátový rýchly režim. Výber ostáva deterministický a prechádza existujúcimi hard gate-mi/fallbackom.
- Po vytvorení finálneho song audition bufferu `reviewSongAudio()` použije ten istý buffer na technickú kontrolu peak/RMS/crest/bass proxy a neplatných vzoriek. UI upozorní na near-full-scale peak, takmer ticho alebo non-finite PCM; nemení projekt a neopakuje render.
- **Otvorené:** toto je technická spätná väzba, nie umelecký kritik ani automatická oprava. Ďalej treba pridať cieľené návrhy zmien na základe dôkazu, ich A/B audition na úrovni celej skladby/sekcie a kontrolovaný apply/undo.

**Doplnok (2026-09-26): audition-first sekčné návrhy.**

- C3 cielená revízia („drop energeticejší") už nepíše ticho: outcome z `reviseSection` sa stane
  preview návrhom — auto-audition, `✓ POTVRDIŤ` aplikuje ten istý one-undo in-place swap
  (`replacePatternInPlaceCommand`, id/seed zachované → scény aj klipy ostanú naviazané),
  `✗` nezanechá nič. Stale guard medzi náhľadom a potvrdením.
- Záruka rozsahu testovaná: revízia zmení IBA deklarovanú sekciu — všetky ostatné patterny sú
  content-hash identické a scene bindingy prežijú; nepotvrdený návrh nechá projekt bitovo rovnaký
  (`tests/section-iteration.test.ts`).
- **Otvorené ďalej:** celoskladbové A/B (nová sekcia v kontexte celého song audition buffera)
  a širšia zmenová slovná zásoba (mood/rola) nad rámec energy/density.

**Doplnok 2 (2026-09-26): dôvodové návrhy z meraní.**

- `analyzeSongSections(buffer, sections, bpm)` segmentuje song audition buffer podľa hraníc
  formy → per-sekčné RMS/peak metre; `suggestSectionRevivals` navrhne energy oživenie pre
  loud-carrying sekciu ≥8 dB pod vlastným mediánom skladby. Break/intro/outro majú dýchať —
  tichota tam nenavrhuje nič; vyvážený song taktiež nie.
- SUNO preview feedne metre → suggestion čipy; klik vedie do audition-first sekčného návrhu
  (▶ náhľad → ✓/✗). Nikdy sa neaplikuje automaticky — dôkaz, návrh a rozhodnutie sú oddelené.

**Doplnok 3 (2026-09-27): zachovanie conditioning naprieč song sekciami.**

- `buildSong()` predtým skladal intent každej sekcie z ručne vybraných polí, takže sa z briefu
  vytratil artist, mood, flow, pôvodný text a ďalšie provider/protection polia. Nový čistý
  `createSongSectionIntent()` dedí celý normalizovaný brief a prepisuje iba seed, dĺžku,
  section energy/density/complexity, kandidátsky počet a role scope. Chránené roly a track
  targets tak prežijú aj async song candidate path.
- `semanticConditioningForIntent()` preloží `IntentSpec.artist` na dostupný deep artist profile
  a odovzdá jeho signature spolu s používateľovým textom do existujúceho semantic prior blendu;
  neznámy/neprofilovaný artist bezpečne zostáva na pôvodnej textovej/heuristickej ceste.
- Overené: song integrácia + artist conditioning **40/40**, samostatný strict TS check nového
  mappera/conditionera/testov PASS. Celý `npm run typecheck` je v aktuálnom zdieľanom strome
  stále červený: `TS6133` v súbežne menenom `AudioEngine.ts` a `TS2741`, pretože paralelné
  rozšírenie `Genre` o `trance` ešte nemá zodpovedajúci `SONG_FORMS` entry. Vite produkčný build
  a bundle gates PASS; tieto typové chyby však bránia zelenému `npm run build`.

### Fáza 6 — KYX ako zvukár: meranie, odporúčanie, potvrdenie

**Cieľ:** produkčná pomoc je počuteľná aj technicky vysvetliteľná; nič sa automaticky „nemasteruje“ bez kontroly.

**Práca:**

- Auditovať existujúce merania v `audio-feedback.ts`, `ranking-v3.ts`, `loudness.ts` a VLYX/Mix Assist. Doplniť len chýbajúce metriky; oddeliť proxy (napr. RMS/crest/ZCR/bass ratio) od štandardizovaného loudness/true-peak merania.
- Zaviesť report: problém alebo cieľ, dôkaz z renderu, navrhnutý zásah, dotknuté stopy a očakávaný trade-off.
- Každú automatickú zmenu FX/gain/EQ/arrangement ponúknuť ako preview A/B a prijať cez command. Zachovať user settings a chránené stopy.
- Verifikovať výsledok na rovnakom offline renderer-i ako export; ak sa zásah nedá doložiť meraním alebo posluchovým testom, označiť ho ako kreatívny návrh, nie opravu.

**Kód/testy:** `src/intent/audio-feedback.ts`, `ranking-v3.ts`, `mix.ts`, `loudness.ts`, `src/analysis/`, `src/rendering/renderer.ts`; `tests/intent-audio-feedback.test.ts`, `tests/intent-production.test.ts`, mix tests, render golden/parity checks.

**Hotovo, keď:** odporúčanie je reprodukovateľné, vysvetliteľné a voliteľné; live a exportovaný render ostanú zhodné; clipping/loudness claims sú podložené skutočným meraním.

**Stav (2026-09-26): jadro Fázy 6 dodané.**

- Audit meraní: proxy metriky (RMS/crest/ZCR/lowBandRatio, `song-audio-review.ts`) boli už
  oddelené od štandardizovaného loudness merania (BS.1770-4 K-weighting, `kweighting.ts`).
  Doplnené **clipping-runs** (≥3 po sebe idúce full-scale samples, per-kanálovo) ako samostatný
  dôkaz — „near-full-scale“ (jedna vzorka, môže byť transcient) ≠ „clipping“ (deštrukcia).
- Štruktúrovaný report: `recommendLoudnessTrim()` — cieľ, dôkaz z renderu (ten istý offline
  renderer ako export), navrhnutý zásah (trim na `master.loudnessTrimDb`, clampnutý ±6, nikdy
  user tracky), poctivý trade-off oboch smerov, `withinTarget` ±1 LU = žiadny zásah. Pure →
  reprodukovateľné a vysvetliteľné.
- **Nič sa automaticky nemasteruje:** SUNO preview teraz meria cez `measurePreviewLoudness`
  (vstupný doc je testom pinovaný ako nemutovaný) a trim ponúka ako návrh — ▶ počuješ
  netrimnutý render, `✓` aplikuje trim cez `setMasterConfig` na preview doc + pre-renderuje
  náhľad (preview == USE ostáva pravda), `✗`/ticho inštaluje nič. Auto-aplikujúca
  `applyPreviewLoudness` zostáva ako testovaná referencia, panel ju už nepoužíva.
- Testy: `tests/loudness-recommendation.test.ts` (8) + clipping (3); regresia loudness/review/
  song rodina 123/123.
- **VLYX Mix Assist + Reference Match:** oba nástroje najprv vyrenderujú pôvodný track aj presný
  návrh offline a zobrazia dôkaz, cieľ, dotknutý track, zmenu a trade-off. Streamové BS.1770 LUFS
  meranie beží vo workeri; A/B prehratie iba stíši hlasnejšiu verziu a nemení projektový gain.
  Zastaraný návrh po zmene projektu sa zahodí; Apply použije presne auditionovaný proposal cez jeden
  undoable command, Discard nemení projekt. Regresie pokrývajú oba panely, worker meranie, gain a stale
  invalidation.
- **Otvorené:** true-peak (4× oversampling podľa BS.1770) namiesto sample-peak proxy pre exportné odporúčania;
  rozšírenie reportu na sekčné revízie (spojenie s per-sekčnými metrami z Fázy 5).

### Fáza 7 — MRT2 ako voliteľný hráč a sampling nástroj

**Cieľ:** MRT2 dopĺňa KYX beat, ale nenahrádza jeho patterny, projektový model ani lokálny fallback.

**Práca:**

- Najprv dokončiť provider-neutral lifecycle, capability checks, capture, durable sample a undoable `AudioClip` cestu z `src/generative/`. Projekt musí fungovať aj po odpojení/absencii providera.
- V prvej používateľskej verzii uprednostniť capture/freeze: prompt/style + overené note/chord conditioning → vyrenderovaný úsek → posluch → uloženie do sample library/timeline → bežné strihanie a FX. Ukladať provider/model/version a provenance, nie surový runtime stav do project documentu.
- KYX makrá ako Density/Energy/Texture mapovať až po overení ich významu pre konkrétny MRT2 checkpoint. UI ich označí ako KYX controls, nie natívne MRT2 parametre.
- Zachovať platformové hranice: browser cez explicitný localhost companion; macOS native helper a Windows JAX companion sú oddelené implementácie. Žiadne tvrdenie „live/realtime podporované“ bez buildu, skutočných model váh, dlhého soak testu, underrun/latency a pamäťových dôkazov na cieľovom hardvéri.
- Modelové váhy sťahovať a aktualizovať oddelene od bežného DAW balíka; overovať hash/licenciu a jasne ukazovať miesto na disku. Žiadny skrytý cloud fallback.

**Kód/testy:** `src/generative/`, `src/generative/providers/mrt2/`, `src/persistence/`, `src/commands/`; pre presné platformové úlohy a aktuálne gate-y pozri `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md` a ADR 0012. Testovať capture/freeze, missing provider/model, invalid PCM, stop/resume, offline export a platformové balíky oddelene.

**Hotovo, keď:** zachytené audio je normálny editovateľný KYX audio klip a používateľ vie, kde model beží, koľko zaberá a čo platforma reálne podporuje. Realtime režim sa povoľuje len pre platformu, ktorá prešla samostatnými acceptance testami.

### Fáza 8 — release gate pre AI-first producer workflow

Pred označením workflow za hotové musí prejsť:

- **Brief fidelity:** všetky hard constraints v kurátorovanej testovacej sade sa buď splnia, alebo UI pred commitom výslovne oznámi, že návrh neprešiel. Modelové skóre ich nesmie prekryť.
- **Presnosť zmien:** chránené stopy a časti aranžmánu sa nemenia; canceled/stale návrh nemení projekt.
- **Hudobná kvalita:** blind listening porovnáva novú cestu s aktuálnym baseline; výsledky sa reportujú aj pri negatívnom výsledku.
- **Determinism a mutácie:** rovnaký symbolic seed/intent/version dá rovnaký obsah; prijatie je undoable, odmietnutie je bez mutácie; auditionovaný variant je aplikovaný bez pregenerovania.
- **Modelová odolnosť:** absentný model, cold start, timeout, worker error, poškodený manifest/hash a offline režim majú testovaný fallback.
- **Audio:** live/offline parity a finálny export sa kontrolujú rovnakým `AudioEngine`; generované PCM je bounded a finite.
- **Release quality:** `npm run typecheck`, relevantné Vitest suite, `npm run test:e2e:smoke`, `npm run test:browser` podľa zmenených plôch, `npm run build` a bundle budget. Všetky nesúvisiace zlyhania sa uvádzajú, nie započítavajú ako PASS.

**Stav (2026-09-26): executable gate suite dodaná; prvé plné prepnutie brány vykonané.**

- `tests/release-gate-ai-producer.test.ts` (11 testov): kód-overiteľné brány bežia nad reálnymi
  modulmi — brief fidelity (4 kurátorované briefy: návrh čistý + banka bez porušení → modelové
  skóre nemôžu prekryť tvrdé fakty), presnosť zmien (chránený obsah hash identický, odmietnutie
  bez mutácie), determinizmus (hash + rows), vypočutý kandidát sa aplikuje as-is jedným
  undoable commandom, modelová odolnosť (ranker off / bogus mode → validný fallback výsledok),
  generované PCM bounded + finite.
- **Výsledky prvého plného prepnutia** (2026-09-26):
  - Vitest celý suite: 5909 testov — jediná perzistentná chyba bola v iteration length+preserve
    splice (source pattern sa do generátora doručoval nereziznutý → preserve-length gate ju
    korektne odmietol; fixed pri koreni), ostatné prechodné počas paralelných vlnie, na re-run
    všetky zelené.
  - Typecheck: 2 chyby zostávajúce v paralelnej organ vlne (ich in-flight, reportované, nie
    skórované ako PASS).
  - Build: kompiluje; **bundle budgety FAIL** — DAW JS 3021/2750 KB, landing 727/600 KB (rast
    +416 KB od auditu 15 = paralelné feature vlny). **Skutočný release bloker na povrchu.**
  - E2e smoke: 3/6 — štúdiové scenáre idú; landing specy majú zastarané lokátory voči novej
    landing copy („open in studio" → „Open the studio") — paralelný redesign, treba update
    lokátorov.
  - Blind listening vs baseline: **OWED** — čaká na ľudské posedenie, nezapočítané.
- **Záver brány:** workflow samotný prešiel kódovými bránami; release blokujú (a) bundle budgety,
  (b) e2e landing lokátory, (c) ľudské blind hodnotenie — všetky tri zvýraznené, neskrývané.

**Doplnok k bráne (2026-09-26, neskoro): triáž blokerov.**

- **(b) e2e landing:** forge funguje (generateLandingBeat overené v viteste — 2 patterny);
  lokátor v špecu je už správny („Open in studio →" existuje v LandingPrompt). Zlyhania sú
  forge/boot hangy v headless na ich novo-redesignnutej landing surface (nová navigácia
  „Open the studio", KX logo) — reconciliácia patrí redesign session.
- **(a) bundle budgety — meraný rozpad:** najväčšie chunky: transformers.web 572 KB (LAZY AI
  runtime, 640/650 v rámci vlastného budgetu ✓), App 452 KB, commands 368 KB, curated 292 KB,
  index 244 KB. Prírastok +271 KB nad cap 2750 neschádza na mojich prídavkoch (~15 KB za celé
  fázy 1-6) ale na paralelných feature vlnách (organ inštrument, vocal/*, country/afro/latin
  pop, bottom dock, take-lane). Skript sám dokumentuje 2705→2750 inkrementy s poznámkou
  „ďalší rast musí byť offset alebo split" — **rozhodnutie (split commands chunk vs. merané
  zvýšenie capu) patrí ownerovi**, rozpad je tu zapísaný ako podklad.
- **(c) blind listening:** nezmenené — owed, tooling stojí (`npm run listening:serve`).

### Rozhodnutie ownera — bundle budget, 2026-09-27

Owner zvolil zachovať aktuálne funkcie a nastaviť meraný limit DAW JS na **3 170 KB**.
Čerstvý produkčný build (2026-09-27) prešiel s týmto rozdelením raw JS:

- DAW JS graf: **3 006/3 170 KB**;
- voliteľné AI runtime chunky: **640/650 KB**;
- on-demand MP3 codec: **166/170 KB**;
- spolu fyzicky shipped JS: **3 812 KB** — tento súčet zahŕňa aj dva voliteľné okruhy vyššie.

Rozdelenie je zámerné: DAW cap meria aplikačný graf bez AI runtime a MP3 codec; tieto
voliteľné chunky majú vlastné, nezávislé stropy, takže ich veľkosť sa nestráca ani
neskrýva v jednom súhrnnom čísle. Výsledok zachováva aktuálne funkcie a dáva DAW grafu
164 KB rezervu, ale AI runtime a codec majú iba 10 KB a 4 KB rezervy. Ďalší rast ktorejkoľvek
skupiny preto treba kompenzovať alebo rozdeliť skôr, než sa uvoľní ďalší limit.

Landing beat/song composer má on-demand graf **157/600 KB**. Entry je **245/1 070 KB**
a core worklets **125/150 KB**. Všetky tieto brány prešli v tom istom `npm run build`;
výsledok je reprodukovateľný na aktuálnom pracovnom strome, nie iba historické meranie.

## 4. Prvý konkrétny míľnik

Prvý shipping slice nemusí čakať na MRT2 ani na celý song composer. Mal by vedieť:

1. Prijať prompt na beat a načítať existujúci projektový kontext.
2. Ukázať používateľovi interpretáciu vrátane hard constraints, želaní a chránených stôp.
3. Vytvoriť niekoľko validných kandidátov, zoradiť ich cez aktuálne overený ranker/fallback a umožniť audition.
4. Prijať presne zvolený kandidát cez jednu undoable zmenu.
5. Spracovať aspoň jeden bezpečný následný pokyn („druhý, ale temnejší; nechaj bass“) ako cielený proposal a znovu ho dať na audition.
6. Fungovať bez sémantického modelu, bez internetu a bez MRT2.

Tento míľnik preverí najdôležitejšiu produktovú hypotézu: či KYX vie počúvať požiadavku a spolupracovať pri jej realizácii. Song-level varianty, zvukárske odporúčania a MRT2 sa potom doplnia nad tým istým brief/proposal/command kontraktom.

## 5. Zásady, ktoré sa počas implementácie nemenia

1. **Hard constraints pred rankingom.** Ranker je selektor, nie parser pravidiel ani bezpečnostná brána.
2. **AI vráti návrh, nie mutáciu.** Zápis do projektu ide cez commands a undo/redo.
3. **Auditionovaný obsah je commitnutý obsah.** Medzi preview a apply sa nesmie generovať znovu.
4. **Nedotknutý obsah sa negeneruje ani neprepisuje.** „Keep“ je testovateľný kontrakt.
5. **Lokálny fallback je produktová cesta, nie núdzová výnimka.** Cloud sa nespúšťa potichu.
6. **ONNX zlepšenie sa dokazuje ľudskými preferenciami a splnením briefu.** Zhoda s vlastnou heuristikou nestačí.
7. **MRT2 capability je platformovo špecifická.** Samotný provider adapter nie je dôkaz realtime podpory.
8. **Každá release claim musí mať test alebo reprodukovateľný listening/benchmark dôkaz.**

## 6. AI Producer Contract — aktuálna exekučná roadmapa (2026-10-02)

Táto sekcia prevádza `docs/AI-PRODUCER-CONTRACT.md` na poradie implementácie. Jej fázy začínajú tam, kde je aktuálne repo, nie od nuly. `KYX Web` si zachová deterministický, lokálny beatmaking ako plnohodnotnú cestu; cieľom nie je vložiť LFM do browserového bundle. LFM2.5 má byť voliteľná lokálna schopnosť downloadable `KYX Studio`, nie podmienka otvorenia alebo prehratia projektu.

### 6.1 Východiskový stav — čo už existuje a čo to ešte nedokazuje

| Oblasť                     | Overiteľný základ v repozitári                                                                                                      | Hranica, ktorú roadmapa rešpektuje                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministické smerovanie | `src/intent/route.ts`, parsery, `brief-contract.ts`, `IntentSpec`, `plan.ts`, `providers/local.ts`                                  | Zostáva primárnou cestou pre browser aj fallback; presné príkazy sa nesmú zhoršiť kvôli LLM.                                                                                                                                                                                                               |
| Bezpečný beatmaking        | `brief-gate.ts`, `preserved-content.ts`, `candidate-bank.ts`, `audition.ts`, `commands/`                                            | Hard požiadavky a chránený obsah sa overujú pred rankingom a pri apply; model ich nemôže prehlasovať.                                                                                                                                                                                                      |
| Konverzačný základ         | `session-context.ts`, `producer-session.ts`, `conversation.ts`, `iteration.ts`                                                      | Existujú follow-upy a krátky kontext, nie ešte plný, dlhodobý multi-project producentov graf.                                                                                                                                                                                                              |
| Pamäť projektu             | `src/project-model/{types,schema}.ts`, `src/intent/brief-contract.ts`, `src/intent/session-context.ts`, `src/collab/YDocAdapter.ts` | Session kontext je dočasný; projektový, štruktúrovaný Producer Brief je samostatná persistencia, nie archív promptov. Treba ho verziovať, sanitizovať, explicitne ukladať a pokryť migráciou/undo/collab roundtripom.                                                                                      |
| Modelové príkazy           | `model-schema.ts`, `model-resolver.ts`, `model-decoder.ts`                                                                          | Ide o uzavretý action/slot kontrakt pre príkazy a ohraničené produkčné zásahy. Nie je to generátor audia ani plnohodnotný parser voľného kreatívneho briefu.                                                                                                                                               |
| Browserový malý model      | `model-loader.ts` + `public/models/intent-model-v1.*`                                                                               | Približne 6,75 MB multi-head ONNX slot-filler, oddelený od LFM2.5. Jeho action gate ani `valHeadAccuracyMean` nie sú skóre celého AI producenta alebo hudobnej kvality. `scripts/data/intent-model-validation-report.json` teraz viaže namerané výsledky na presné modelové, datasetové a evaluator hashe. |
| Lokálny LFM                | `model-ollama.ts`, `scripts/train-intent-sft.py`, `scripts/eval-ollama-intent.mts`                                                  | Ollama provider existuje. Vyžaduje dostupný lokálny server/model; to samo osebe ešte nie je bezproblémová self-contained AI inštalácia KYX Studio.                                                                                                                                                         |
| Hudobné výstupy            | `src/ai/generator.ts`, `src/intent/pipeline.ts`, `compose.ts`, `song.ts`, `candidate-bank.ts`, `rendering/`                         | Hudbu vytvára existujúci generátor a audio engine. LFM môže preložiť zámer na validný plán; nesmie byť opisovaný ako audio/MIDI generátor.                                                                                                                                                                 |
| Referencie a posluch       | `audio-reference.ts`, `reference/`, `audio-feedback.ts`, `listening/`                                                               | Merania sú konkrétny dôkaz, nie automatická umelecká známka. Hudobné tvrdenia vyžadujú posluchovú evaluáciu.                                                                                                                                                                                               |
| Personalizácia             | `preference-ledger.ts`, `personal-ranker.ts`, `preference-evaluation.ts`, `docs/PRODUCER-DNA-ROADMAP.md`                            | Základ pre explicitné voľby existuje; nemožno tvrdiť, že vkus je naučený len na základe aktívneho rankera alebo počtu generácií.                                                                                                                                                                           |

**Modelové reporty sa najprv musia zosúladiť.** Manifest ONNX stále odkazuje na tréningový report 1 761 train / 294 val / 74 golden a priemernú head accuracy 0,9943; pinned evaluátor teraz meria aktuálny corpus 1 790 / 298 / 74, takže manifest nepotvrdzuje presnú tréningovú sadu a jej obsahový hash zatiaľ chýba. Tréner a manifest writer sa teraz upravujú tak, aby ďalší ONNX artefakt niesol SHA-256 datasetu aj tréningového kódu a aby sa publikovanie odmietlo pri zmene vstupov alebo zastaranom reporte; existujúci artefakt tým spätne nepreznačujeme. Reálny action-level beh dosiahol val 249/259 attempted-exact (96,1 %), 0 wrong-kind, 39/298 abstain (13,1 %), golden-regression 62/62 attempted-exact a deterministický výstup na val subsete. Tento run **nepreukazuje generalizáciu**: pri NFKC + whitespace normalization + case-folding sa `golden.jsonl` prekrýva s train o 64 a s val o 10 promptov; report preto klasifikuje golden iba ako regresnú sadu, nie independent holdout. Samostatný candidate/family-disjoint holdout ešte chýba.

`docs/LOCAL-INTENT-MODEL.md` zároveň opisuje Ollama `kyx-intent-v30-q8` s výsledkom 95,6 % attempted-exact, 0 wrong-kind a 1 abstain z 272; aktuálne uložený `scripts/data/intent-sft/sft-report.json` zachytáva ďalší beh s 773 train príkladmi a 34/60 exact pri 60/60 kindOK. Tieto záznamy môžu patriť odlišným verziám a evaluátorom — **nesmú sa zlúčiť do jedného tvrdenia o aktuálnom LFM**.

Rovnako treba zachovať hranicu medzi dvoma úlohami modelu:

1. **Command/action intent:** „stíš basu“, „presuň klip“, „pridaj fill“ → existujúci uzavretý action schema → validátor/adaptér → existujúci executor/command.
2. **Creative Producer Brief:** „temný, ale nie smutný beat; hook nech rastie; 808 nechaj“ → hard požiadavky, preferencie, zákazy, preserve, target a neistota → existujúci `IntentSpec`/composition pipeline → kandidáti a audition.

Prvý tok má modelový resolver už dnes. Druhý vyžaduje kvalitnú a testovanú kompiláciu kreatívneho zámeru do composer pipeline. Ani jeden tok neposiela model priamo do project modelu alebo audio callbacku.

### 6.2 Fáza 9 — jeden pravdivý modelový a eval baseline

**Cieľ:** vedieť presne, ktorý model, dataset, prompt, runtime a evaluator stoja za každým číslom; zamedziť omylu medzi malým ONNX slot-fillerom a LFM2.5.

**Práca:**

1. Vygenerovať jeden release report pre každý artefakt: provider, model/base revision, quantization, runtime, model hash, tokenizer/vocabulary hash, grammar/schema hash, dataset manifest/hash, split, evaluator commit, hardvér a presné metriky.
2. Znovu spustiť `npm run intent-model:validate` pre browserový ONNX model a `npm run intent-model:sft-eval -- --model <presný-tag>` pre presný LFM Ollama tag; výstup zaviazať ku konkrétnemu artefaktu, nie k pohyblivému aliasu.
3. Oddeliť `head accuracy`, exact action accuracy, wrong-kind, schema-invalid, abstain, per-kind/SK-EN výsledky, latenciu a používateľský úspech. Head accuracy ani zhoda s učiteľom nie sú skóre hudobnej kvality.
4. Zosúladiť `docs/LOCAL-INTENT-MODEL.md`, runbook, `sft-report.json`, manifesty a tvrdenia v tejto roadmap-e. Každý starý report označiť ako historický, ak mu nemožno reprodukovať zdrojový model a split.
5. Založiť oddelený candidate-disjoint holdout pre paraprázy, zložené požiadavky, explicitné preserve/avoid, nejednoznačné a out-of-scope prompty; zahrnúť slovenčinu aj angličtinu.

**Kód/nástroje:** `scripts/validate-intent-model.mts`, `scripts/eval-ollama-intent.mts`, `scripts/data/intent-sft/`, `scripts/train-intent-sft.py`, `docs/LOCAL-INTENT-MODEL-SFT-RUNBOOK.md`, model manifest writers a príslušné golden testy.

**Hotovo, keď:** z čistého checkoutu je možné zopakovať čísla z jedného pinned reportu na konkrétnom artefakte; reporty LFM a ONNX si neprotirečia; baseline a limity sú uložené pred ďalším tréningom.

### 6.3 Fáza 10 — oddeliť príkazový model od kreatívneho briefu

**Cieľ:** LFM pomáha pochopiť požiadavku, ale hudbu vytvára a mení overená KYX pipeline.

**Práca:**

- Zachovať existujúci `model-schema.ts` action contract ako samostatný, verzovaný príkazový slovník. Zmena jeho enumov/grammar invaliduje pinned grammar hash a vyžaduje zodpovedajúcu validáciu/model refresh.
- Nad existujúcim `brief-contract.ts` a `IntentSpec` zadefinovať a otestovať creative task request: brief, projektový kontext, selection/target, hard constraints, preferencie, preserve/avoid, evidence origin, confidence a unknown/clarify stav.
- Zadefinovať explicitné routing pravidlá: jednoznačné deterministické príkazy sa vykonajú existujúcou cestou; creative request smeruje do brief compileru; nebezpečná nejednoznačnosť sa opýta alebo abstainuje. Žiadny „pattern default“ nesmie potichu premeniť príkaz typu mute/delete na generovanie alebo naopak.
- Prijať iba validovaný modelový JSON. Resolver dopĺňa project ID/track ID a jednotky; model nemôže sám vyrábať interné ID, odvodené readback údaje ani command zápisy.
- Brief nesmie načítať celý projekt do promptu bez potreby. Kontext sa skladá selektívne z aktívnej sekcie, relevantných trackov/rolí, tempa/tóniny, existujúcich ochranných pravidiel a dôkazov z dostupnej analýzy.
- Pri rozpore „sprav nové bicie, ale bicie nemeň“ musí UI ukázať konflikt a neaplikovať tichý kompromis.

**Kód:** `src/intent/{model-schema,model-resolver,brief-contract,types,normalize,schema,plan,route}.ts`, `src/ui/IntentPanel.tsx`, `src/commands/`.

**Hotovo, keď:** command intent a creative Producer Brief majú odlišné golden suites, ale zdieľajú tú istú validáciu, context snapshot, proposal/audition a command/undo hranicu. Všetky hard constraints prejdú gate-om pred kandidátmi.

**Stav (2026-10-02): prvá bezpečnostná hranica dodaná; fáza pokračuje.** `model-fallback-policy.ts` drží rozpoznaný
pattern brief a vocalist-led zadanie mimo action-only LFM routy. `IntentPanel` posiela kreatívny brief priamo do
existujúceho generation workflow bez Ollama probe; `tryModelRoute` opakuje ochranu pre ďalších callerov; MCP preskočí
action model pri kreatívnom brief-e aj pri už deterministicky rozpoznanom revise. Akčné parafrázy, ktoré parser
nepozná, ostávajú kandidátom na modelový fallback a prechádzajú pôvodným schema/adapter/executor reťazcom. Overené UI,
resolver a MCP regresiami. Toto **ešte nie je creative LFM compiler**: hoci bezpečnostná hranica, v1 task contract
a syntetický eval scaffold už vznikli, provider/model tréning, reprezentatívny human-reviewed holdout, modelový
uncertainty/clarify eval a UI integrácia sú stále otvorené.

**Stav (2026-10-02): creative-task kontrakt v1 a opt-in provider implementované; UI/model rollout ostáva otvorený.**
`src/intent/creative-task-contract.ts` skladá dočasný request z hard požiadaviek, preferencií, preserve/avoid,
unknown/conflict a proveniencie; projektový kontext znižuje na tempo, tóninu, dostupné roly a existenciu aktívneho
patternu bez interných ID či názvov trackov. Modelový JSON má samostatnú verziu, allowlist polí a limity
hodnôt/veľkosti. Výstup je len návrh: čistý resolver aplikuje iba používateľom schválené polia, nemení už určené fakty
a atomicky odmieta konfliktný rozsah. Pokryté je SK briefové vstupné mapovanie, malformed/oversized výstup, schema
drift, role konflikty a approve-only správanie.
**Aktualizácia (2026-10-02):** samostatný local Ollama creative provider/prompt aj opt-in eval runner sú implementované
v `src/intent/creative-task-ollama.ts` a `scripts/evaluate-creative-task-ollama.mts`. Provider je oddelený od action
resolvera, vyžaduje explicitný model tag, je pripnutý na loopback, má timeout/cancel/circuit breaker a výstup prejde
iba creative schema validátorom; nič neregistruje ani nemení v UI/projekte. Prvý pinned zero-shot snapshot presného
`kyx-intent-v30-q8:latest` artefaktu (digest v report JSON) dokončil iba 2 inferencie: prvá bola
`invalid-suggestion`, druhá `invalid-shape`; breaker bezpečne preskočil zvyšných 19 prípadov. Z týchto dvoch nebol
ani jeden použiteľný návrh. Je to negatívny kompatibilitný smoke test action-SFT modelu, nie kompletný benchmark,
úspech creative modelu ani hodnotenie hudobnej kvality.
**Otvorené:** samostatné creative-task SFT dáta/model, opakovateľná eval po platných odpovediach na celom holdoute,
consented human-reviewed holdout, rubric/blind listening, UI pre clarify/approve a až po release gates napojenie
trénovaného creative modelu. Action-only LFM sa nesmie považovať za hotový creative compiler.

### 6.4 Fáza 11 — LFM tréning, ktorý generalizuje bez nebezpečných zámen

**Cieľ:** preukázať, že fine-tuned LFM2.5 prináša merateľné zlepšenie nad deterministickým parserom na presne tej úlohe, na ktorú sa má používať.

**Práca:**

1. Nezmiešať action slot-filling a creative brief compilation do jednej neoznačenej accuracy metriky. Každý task má svoj split, golden set a chyby podľa triedy.
2. Udržať teacher-verification: command targety generuje a kontroluje deterministický executor; creative briefy majú kurátorované očakávania extrahovaných faktov, nie vymyslené „správne beaty“ vytvorené druhým LLM.
3. Rozšíriť dáta o prirodzené SK/EN formulácie, hovorený štýl, vokalistické briefy, follow-upy („druhý, ale…“), viac-klauzulové pokyny, negácie, preserve, conflicts a adversarial/injection text. Splitovať podľa rodiny/template/parafrázovej skupiny, nie náhodne po takmer identických riadkoch.
4. Porovnať deterministic baseline, súčasný SFT artifact a nový LoRA run na rovnakom holdoute. Testovať aspoň aktuálny LFM2.5 Instruct model a quantization určenú pre cieľové zariadenia; meniť jeden faktor naraz.
5. Zachovať constrained output, validátor, abstain/clarify cestu a post-decode enforcement. Grammar legality nie je sémantická správnosť.
6. Pri zlyhaní logovať anonymizovateľný, lokálny failure record až po súhlase; korekcie používateľa sa nestanú tréningovým štítkom bez jasného signálu.

**Pracovné release gates:** najmenej 95 % exact na predregistrovanom holdoute pre podporované triedy, 100 % correct-kind na akceptovaných akciách a nula nebezpečných/destruktívnych zámen. Creative brief eval osobitne reportuje správnosť hard/preserve polí, neistotu a human-rated užitočnosť. Chýbajúci model musí abstainovať/fallbackovať, nie hádať.

**Aktuálny LFM runtime výsledok (2026-10-02):** `scripts/data/intent-sft/lfm-runtime-evaluation-2026-10-02.json` pinne tag aj Ollama digest/blob, celý validation split a relevantné source hashe. Na všetkých 298 riadkoch dosiahol 274/295 exact (92,9 % attempted), 6 wrong-kind, 15 wrong-slot, 3 abstencie a 0 schema-invalid. Release gate zatiaľ **neprešiel**: exact je pod pracovnými 95 % a correct-kind nie je 100 %. Najslabšie malé triedy sú `preset` 0/4 a `loudness` 1/8; `effectIntent` má 6 wrong-kind. Je to iba akčná/slotová zhoda, nie hodnotenie beatov. Evaluator navyše robí priamy aj routovaný inference call, preto z tohto behu nemožno vyvodzovať single-call latenciu. Tréningový corpus starého artefaktu stále nemá úplnú hashovanú provenienciu; report preto dokladá eval vstupy a presný lokálny model, nie reprodukovateľnosť jeho tréningu.

**Creative-brief eval scaffold (2026-10-02):** `scripts/data/creative-task-v1-golden.jsonl` obsahuje 21 ručne kurátorovaných syntetických SK/EN prípadov v oddelenom `held-out` súbore; action goldens sa nekopírujú. `src/intent/creative-task-evaluation.ts` reportuje osobitne hard polia, preserve/avoid/target safety, preferences, kritické unknowns/clarify, validitu schémy a výsledky podľa jazyka; `scripts/evaluate-creative-task.mts` pinne SHA-256 golden a prediction súborov. Samotný scaffold neurčuje release threshold; prvý lokálny provider smoke je zdokumentovaný nižšie. Táto syntetická sada netvrdí, že model rozumie reálnym producentom, a nehodnotí hudobnú kvalitu; pred release treba consented/human-reviewed holdout a blind listening.

**Prvý lokálny creative-provider smoke (2026-10-02):** `scripts/data/creative-task-v1-report.json` pinne modelový digest, provider prompt, golden/evaluator/parser/compiler zdroje a výstupný JSONL hash. Z `kyx-intent-v30-q8:latest` boli vykonané 2 completions; obe odmietla schema (`invalid-suggestion`, `invalid-shape`), preto sa circuit breaker otvoril a 19 zvyšných promptov nebolo odoslaných. Evaluator ich vedie ako 2 invalidné a 19 missing, nie ako platné predikcie; presné odpovede sa kvôli ochrane dát nelogujú. Výsledok potvrdzuje, že súčasný action model zatiaľ nemožno routovať na voľné creative briefy. Je to iba diagnostický smoke, nie plný 21-prompt score ani hudobná kvalita.

**Kód/nástroje:** `scripts/train-intent-sft.py`, `scripts/eval-ollama-intent.mts`, `scripts/data/intent-sft/`, `docs/INTENT-DATASET-TEMPLATES.md`, `tests/intent-model-*`, `src/intent/model-ollama.ts`.

**Prvá oddelená creative-SFT fáza (2026-10-02):** `scripts/data/creative-task-sft/` je samostatný
synthetic-bootstrap corpus; action goldens ani creative held-out golden sa nepoužívajú ako tréningové riadky.
`scripts/generate-creative-task-sft.mts` volá presný runtime brief parser/request builder, pripína inference system
prompt, kontroluje teacher hard-fakty, chránené roly, hash-e zdrojov, train/validation family-disjoint split a presný
leakage check proti 21 held-out prípadom. Aktuálne ide o 32 train + 32 validation promptov, 8 rodín na split,
SK/EN a proposal/clarify/abstain príklady. Je to výhradne syntetický format/extraction bootstrap, **nie** consented ani
human-reviewed dataset a **nie** dôkaz producentovho porozumenia. Oddelený `scripts/train-creative-task-sft.py`
vyžaduje explicitný model aj pinned revision, explicitné potvrdenie syntetických dát, CUDA a minimálne voľné VRAM;
meria creative-schema validity, exact/status accuracy a role-safety, ukladá len adapter a nevie nič registrovať ani
promovať. Tréning zatiaľ nebol spustený: bootstrap nie je tréningovo reprezentatívny, modelové weighty LFM2.5 nie sú
v lokálnej cache (je tam iba config/tokenizer) a na spoločnej GPU bežal iný verify job. Chýbajúce modelové súbory sa
nestiahnu bez explicitného `--allow-model-download`. Zostáva rozšíriť corpus consented/human-reviewed podľa rubricy,
evalovať akčný baseline vs.
nový samostatný creative model na golden holdoute, vykonať blind listening a splniť release gates.

**Hotovo, keď:** jeden kandidátny model prejde rovnaký pinned evaluator opakovateľne, porazí relevantný baseline na držaných-out parafrázach a neporuší safety gates; report je oddelený od hudobnej blind-evaluácie.

### 6.5 Fáza 12 — prvý skutočný AI Producer vertical slice

**Cieľ:** zrozumiteľne ukázať rozdiel medzi AI, ktorá len vykoná príkaz, a producentom, ktorý pomôže vytvoriť a iterovať beat.

**Scenár:** „Sprav mi 16-taktový temný trap, nech nie je smutný; môj kick a 808 nechaj. Hook má mať viac energie.“ KYX zobrazí interpretáciu, odlíši isté fakty od odhadov, vyrobí niekoľko hudobne odlišných kandidátov cez existujúci generator, uplatní hard gates, prehrá ich v kontexte projektu, nechá vybrať presný variant a umožní follow-up typu „druhý, ale vzdušnejší lead“. Prijatie je jedna zrozumiteľná undo jednotka; discard nemení projekt.

**Práca:**

- Napájať creative brief výhradne do existujúceho `planGeneration` / `generateAsyncResult` / `candidate-bank` a song/section toolingu; model neskladá priamo MIDI, PCM ani projektový strom.
- Preniesť brief dôsledne aj cez `buildSong` a sekčné generovanie; zachovať targety, preserve, seed/provenance a kontext naprieč všetkými sekciami.
- Pred apply porovnať source project/selection revision. Stale návrh sa zahodí a vyžiada nové preview.
- Zobraziť candidate differences, hard-constraint compliance, fallback/repair a metriky, ktoré sú skutočne zmerané.
- Pokryť prázdny projekt, existujúci beat, iba vocal reference, chránený bass/kick, konfliktný prompt, model off/timeout, cancel, undo/redo a re-open/export.

**Kód/testy:** `src/intent/{pipeline,candidate-bank,audition,compose,song,section-production,brief-gate}.ts`, `src/ui/IntentPanel.tsx`, `src/commands/`; golden brief suite + Vitest, E2E end-to-end a render parity.

**Hotovo, keď:** používateľ bez znalosti hudobnej teórie vie úspešne vytvoriť, vypočuť, spresniť a exportovať beat; presne vypočutý variant sa aplikuje, preserve hashe ostanú rovnaké a celý workflow funguje aj bez LFM.

### 6.5.1 Míľnik 12a — bezpečný Producer Brief uložený v projekte

Toto je prvá trvalá pamäť AI producenta a súčasť vertical slice-u; nesmie sa zamieňať so session historiou ani s osobným Producer DNA.

**Rozsah v1:** ukladať len malé, štruktúrované a allowlistované hudobné fakty, ktoré používateľ výslovne potvrdil alebo opravil (napr. žáner/mood, rozsah BPM, tóninu, dĺžku, roly, energiu/hustotu/komplexitu/variáciu, zachovať a nevytvárať). Každý fakt nesie pôvod a confidence. Neistý odhad sa nestáva uloženým faktom bez potvrdenia.

**Implementačné poradie:**

1. Zafixovať model `ProjectProducerBriefV1` nezávislý od LFM/ONNX outputu; sanitizovať pri načítaní/importovaní, zahadzovať neznáme polia, limitovať počet a dĺžku hodnôt.
2. Pridať schema migration a serializačný roundtrip; synchronizovať len tento explicitný JSON field cez existujúcu Y.Doc hranicu.
3. Uložiť/zmazať brief cez command systém s undo/redo. Žiadny autosave skrytého promptu ani priama mutácia project modelu z React/modelu.
4. V UI ukázať, kedy sa projektový brief používa; používateľ ho môže vypnúť pre jednu session, prezrieť, doplniť, vymazať a vrátiť cez Undo.
5. Kompilovať uložené fakty ako predvolené projektové preferencie; aktuálny explicitný pokyn ich môže prepísať, ale rozpor s uloženým preserve/hard constraintom vyžaduje viditeľné potvrdenie.
6. Nikdy neukladať raw prompt, konverzačný transcript, skrytý chain-of-thought, audio, vokály ani lyrics. Uložený brief sa neprenáša do iného projektu ani ZYVO mimo explicitného exportu projektu/briefu.

**Testovacia brána:** legacy project migration; malformed/unknown import sanitization; save/load a persistence roundtrip; Y.Doc drift/roundtrip; undo/redo save aj clear; project switch bez úniku; aktuálny prompt má prioritu nad mäkkými saved preferences; hard-conflict je viditeľný; vypnutý brief nemení generation; test, že prompt/transcript polia v schéme neexistujú.

**Hotovo, keď:** používateľ znovu otvorí projekt a KYX si pamätá len potvrdené projektové fakty, nie jeho surové formulácie; správanie je reprodukovateľné, undoable a funguje bez LFM. Implementačné zmeny v pracovnom strome samy osebe nie sú release dôkazom — všetky brány vyššie musia prejsť.

### 6.6 Fáza 13 — AI priamo v práci, nie iba v chate

**Cieľ:** producent vie reagovať na aktuálnu hudobnú selection, nie len na voľný prompt v jednom paneli.

**Práca:**

- Kontextové vstupy nad označenými taktmi, patternom, trackom, clipom, arrangement sekciou a referenčným audio. Každá požiadavka zdedí iba relevantný context snapshot.
- Rýchle úlohy („fill sem“, „redšie hats“, „otvor priestor pre vokál“) aj plný brief editor so sekciami POVINNÉ/PREFERENCIE/ZÁKAZY/ZACHOVAŤ/NEISTÉ.
- Zobraziť before/after a presný target diff; prompt nie je jediný spôsob ovládania a AI nie je jediná cesta k funkcii.
- Oddeliť rýchle deterministic preview od dlhšieho lokálneho modelu. Zrušenie a pokračujúci playback musia byť bezpečné; React ani inference nevlastnia audio clock.
- Rozšíriť session graph: kandidáti, vybraná vetva, predchádzajúci brief, follow-up a project revision. Táto session vrstva ostáva bounded a dočasná; trvalé projektové fakty patria výhradne do míľnika 12a a dlhodobý vkus do fázy 15.

**Kód:** `src/ui/IntentPanel.tsx`, `AssistPanel.tsx`, `ArrangementPanel.tsx`, `Sequencer.tsx`, selection stores, `session-context.ts`, `producer-session.ts`, `iteration.ts`.

**Hotovo, keď:** tie isté golden úlohy sú ovládateľné promptom aj contextual action; výber targetu a jeho ochrana sú viditeľné; chat nikdy neobíde priamy piano-roll/sequencer/arrangement workflow.

### 6.7 Fáza 14 — downloadable lokálny runtime bez skrytého setupu

**Cieľ:** AI v KYX Studio je použiteľná pre bežného producenta, nie iba pre developera, ktorý už má ručne nakonfigurovaný Ollama server.

**Práca:**

1. Rozhodnúť runtime po benchmarku: spravovaný Ollama/sidecar alebo vlastný lokálny runtime. Kritériá sú čistá inštalácia, update/rollback, Windows support, procesová izolácia, cold/warm latency, RAM/VRAM a licenčná/distribučná kompatibilita.
2. Model weights ponúknuť ako samostatný opt-in download s jasnou veľkosťou, SHA-256, verziou, storage umiestnením, progress/cancel/retry/remove a validáciou po stiahnutí. Neskrývať model v installer-i ani v browser bundle.
3. Podporovať explicitný OFF/fallback stav, chýbajúci model, poškodený cache, timeout, runtime crash, update bez poškodenia pracovného projektu a bezpečné vypnutie background procesu.
4. Dokumentovať referenčný hardvér a reálne cold-start, prvý prompt, warm p50/p95, RAM/VRAM a thermal/soak výsledky pre podporované stroje. Neodvodzovať latenciu z počtu parametrov alebo GPU modelu.
5. Pred redistribúciou overiť presnú LFM license verziu, model checkpoint, quantization/conversion a distribučný model KYX. Technicky stiahnuteľné neznamená automaticky redistribuovateľné.

**Hotovo, keď:** používateľ stiahne/odstráni AI bez ručného terminálového setupu; offline inference zostane lokálna; KYX bez modelu naďalej bootuje, tvorí deterministicky a exportuje.

### 6.8 Fáza 15 — producentov vkus a hudobný feedback loop

**Cieľ:** zvyšovať užitočnosť a hudobnú kvalitu bez zamieňania popularity, model score a skutočného posluchu.

**Práca:**

- Rozlíšiť „najlepšie splnil brief“ od „toto sa mi páči“. Zbierať explicitné A/B/favorite/reject + dôvod ako samostatné signály; samotné použitie návrhu nie je automaticky preference label.
- Integrácia Producer DNA musí byť lokálna, opt-in, prehliadnuteľná, opraviteľná, resetovateľná a context-aware podľa žánru, úlohy a hudobnej roly. Používateľ môže pokračovať bez pamäte.
- Kandidáti SAFE/PERSONAL/EXPERIMENTAL musia byť počuteľne rozdielni už pri generovaní; všetky prechádzajú rovnakým brief gate. PERSONAL bez dôkazu prizná cold-start.
- Porovnávať audio cez rovnaký `AudioEngine`/offline renderer a controlled loudness A/B. Listening sets musia pokryť beatmakerov, spevákov, viac žánrov a aj negatívne výsledky.
- Pri reference audio používateľ volí donor osi (groove/timbre/harmónia/forma); vypnutá os nesmie ovplyvniť conditioning a raw reference sa bez súhlasu neukladá do vkusového profilu.
- MRT2 ostáva voliteľným performerom/resampling zdrojom. Nie je podmienkou tohto vertical slice a jeho realtime capability sa dokazuje pre každú platformu samostatne.

**Kód:** `preference-ledger*.ts`, `personal-ranker.ts`, `candidate-diversity.ts`, `candidate-search.ts`, `audio-reference.ts`, `reference/`, `audio-feedback.ts`, `listening/`, `src/generative/`.

**Oddelenie od ostatných pamätí:** Producer DNA je globálny soft preference profil, nie uložený project brief. Do ledgeru idú len explicitné signály (favorite, porovnanie A/B, reject s dôvodom); `apply`/preview/generate nie sú štítky samy osebe. Jeho vypnutie alebo reset nesmie meniť project briefy ani transient session context.

**Hotovo, keď:** vopred registrovaná blind evaluácia ukáže, v ktorých úlohách AI oproti deterministickej baseline pomáha, neškodí alebo ešte nie je pripravená; výsledok sa reportuje per úloha/žáner a nie iba jediným súhrnným score.

### 6.9 Fáza 16 — prenosný Producer Brief KYX ↔ ZYVO

**Cieľ:** dve špecializované DAW-y zdieľajú producentov jazyk, ale nestanú sa jedným preplneným produktom.

**Práca:**

- Najprv zafixovať `Producer Brief v1` ako versionovaný modelovo neutrálny interchange: intent, tempo/key iba s pôvodom/confidence, sekčná mapa, track-role labels, hard constraints, preferences, preserve/avoid, uncertainty a provenance.
- Oddeliť metadata od audio assets. Prenášať iba používateľom vybrané stems/clipy s integrity info; žiadne raw vocals, lyrics ani celé projekty automaticky.
- V KYX spraviť export/import preview, schema/version validation, unknown-field policy, permission prompts, file-size caps a no-write-until-confirmed cestu.
- Otestovať doprednú aj spätnú kompatibilitu cez fixture ZYVO contract. Pri absencii ZYVO source repo implementovať iba KYX adapter a spoločnú špecifikáciu; žiadne tvrdenie o hotovej integrácii druhej DAW.

**Kód (po rozhodnutí o umiestnení kontraktu):** `src/intent/` + `src/export/`/import layer a tests; produktová špecifikácia v `docs/AI-PRODUCER-CONTRACT.md`. Konkrétny shared package sa zvolí až po kontrole oboch repo hraníc.

**Hotovo, keď:** brief prejde medzi aplikáciami bez väzby na LFM alebo project schema; používateľ vidí a schváli presne prenášaný obsah; obe DAW-y vedia ďalej samostatne upraviť svoje projekty.

### 6.10 Fáza 17 — release bar: AI producent aj konkurenčná beatmaking DAW

Release tvrdenie sa povolí až keď súčasne platí:

- **Model:** presný downloadable artifact prejde pinned action a creative-brief evalmi, manifest/hash/license/runtime sedí a model vie bezpečne abstainovať.
- **Hudba:** hard constraints 100 % v release golden suite; human blind listening preukáže vopred definovaný prínos pre podporované beatmaking úlohy oproti baseline.
- **Workflow:** prvý beat od nového používateľa, iterácia „ten druhý, ale…“, vocal-space prompt, targeted section edit, preview/apply/undo/redo, save/reopen/export — všetko end-to-end.
- **DAW:** step sequencer, piano roll, samples, instruments, arrangement, mixer, automation, recording/export a project recovery zostávajú priamo dostupné a regresne testované. AI nemaskuje chýbajúcu alebo nestabilnú základnú funkciu.
- **Platforma:** web bez LFM zostáva plnohodnotne použiteľný; Studio model absent/offline/crash fallback prejde; browser/downloadable support claims zodpovedajú ich test matrix.
- **Reliability:** typecheck, relevant Vitest + E2E/browser audio tests, production build/bundle limits, live/offline parity, privacy/license/security review a release checklist sú zelené. Nesúvisiace chyby sa reportujú, nikdy nepreznačia na PASS.

FL Studio je latka pre úplnosť a rýchlosť beatmaking workflow, nie marketingové tvrdenie o parity. Benchmarkovať treba dokončenie reprezentatívnych úloh, čas k prvému použiteľnému a následne upraviteľnému beatu, spoľahlivosť a posluchové hodnotenie.

### 6.11 Kritická cesta a najbližší míľnik

```text
9. pravdivý baseline
        ↓
10. command intent ≠ creative Producer Brief
        ↓
11. LFM held-out kvalita
        ↓
12. beatmaker vertical slice
        ↓
12a. project-local Producer Brief memory
        ↓
13. inline UX + bounded session context
        ↓
14. downloadable runtime
        ↓
15. opt-in Producer DNA + blind hudobná evaluácia
        ↓
16. prenosný brief do ZYVO (po stabilizácii v1 contractu)
        ↓
17. release bar
```

**Fáza 9 je čiastočne hotová:** ONNX action-model baseline má reprodukovateľný report, ktorý pinne model/vocab/grammar, eval corpus a hashe evaluátora; experimentálne decoder margins nesmú nastaviť release `gatePassed`. Aktuálny LFM má samostatný runtime report pre presný lokálny model a 298-riadkový validation split, ale meria iba action routing a release gates nespĺňa. Ešte treba (a) doplniť overiteľnú provenienciu tréningového corpusu pri ďalšom tréningu — existujúci artefakt nesmie dostať spätne vymyslené hashe, (b) vytvoriť candidate/family-disjoint holdout, (c) zjednotiť budúce porovnanie ONNX/LFM/baseline na rovnakých taskoch bez zamieňania ich úloh a (d) oddeliť single-call latenciu od kvalitatívneho eval-u. Najbližší krok je odstrániť chyby podľa triedy a uzavrieť tieto dôkazy, nie spúšťať ďalšie epochy naslepo. Potom pokračovať v kontrakte fázy 10 a napojiť LFM na creative brief compiler; UI sa môže stavať paralelne bez zmeny output schema.
