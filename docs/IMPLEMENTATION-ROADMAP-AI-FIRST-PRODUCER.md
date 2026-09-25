# KYX — AI-first producer implementation roadmap

> Stav: plán; baseline skontrolovaný v pracovnom strome 2026-09-24  
> Produktový cieľ: lokálny AI producent, ktorý rozumie zámeru, tvorí kvalitné a upraviteľné návrhy a nemení používateľovi projekt poza chrbát.  
> Vzťah k ostatným plánom: tento dokument skladá Intent Engine, song production a MRT2 do jedného používateľského workflow. Nenahrádza `INTENT_ENGINE.md`, `docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md` ani `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`.

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
  kandidátske („žiadne bicie" = drop), length patch = full regen.
- UI: iteration branch pred instant re-apply; návrh ide cez štandardnú banku (audition, USE =
  jeden undo, compliance riadok, stale guard z Fázy 2). Odmietnutý návrh nič nezanechá.
- Session ostáva dočasná a projektom ohraničená (docId); trvalé uloženie neexistuje bez
  vedomia používateľa (roadmap bod 1 ✓ v rozsahu „predvolene dočasná").
- Testy: `tests/iteration.test.ts` (12) — content-hash identita chráneného obsahu, one-undo
  round-trip, determinizmus, reject no-op, provenance warnings.
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

### Fáza 6 — KYX ako zvukár: meranie, odporúčanie, potvrdenie

**Cieľ:** produkčná pomoc je počuteľná aj technicky vysvetliteľná; nič sa automaticky „nemasteruje“ bez kontroly.

**Práca:**

- Auditovať existujúce merania v `audio-feedback.ts`, `ranking-v3.ts`, `loudness.ts` a VLYX/Mix Assist. Doplniť len chýbajúce metriky; oddeliť proxy (napr. RMS/crest/ZCR/bass ratio) od štandardizovaného loudness/true-peak merania.
- Zaviesť report: problém alebo cieľ, dôkaz z renderu, navrhnutý zásah, dotknuté stopy a očakávaný trade-off.
- Každú automatickú zmenu FX/gain/EQ/arrangement ponúknuť ako preview A/B a prijať cez command. Zachovať user settings a chránené stopy.
- Verifikovať výsledok na rovnakom offline renderer-i ako export; ak sa zásah nedá doložiť meraním alebo posluchovým testom, označiť ho ako kreatívny návrh, nie opravu.

**Kód/testy:** `src/intent/audio-feedback.ts`, `ranking-v3.ts`, `mix.ts`, `loudness.ts`, `src/analysis/`, `src/rendering/renderer.ts`; `tests/intent-audio-feedback.test.ts`, `tests/intent-production.test.ts`, mix tests, render golden/parity checks.

**Hotovo, keď:** odporúčanie je reprodukovateľné, vysvetliteľné a voliteľné; live a exportovaný render ostanú zhodné; clipping/loudness claims sú podložené skutočným meraním.

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
