# KYX — Producer DNA & Creative Search Roadmap

> Typ dokumentu: implementačný plán, ktorý dopĺňa `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`.
> Produktový cieľ: zmeniť KYX z generátora riadeného promptom na lokálneho producenta, ktorý sa učí z rozhodnutí používateľa a vie navrhovať zaujímavé, ale stále kontrolovateľné hudobné smery.
> Baseline: pracovný strom Pulse Forge, 2026-09-26. Tento plán nie je tvrdením, že všetky navrhnuté schopnosti už existujú.

---

## 1. Produktová téza

KYX nemusí vyhrať tým, že bude mať najväčší model. Má vyhrať tým, že:

1. pochopí, čo používateľ naozaj žiada;
2. rozlíši, čo je povinné, čo je vkus a čo sa nesmie meniť;
3. ponúkne niekoľko hudobne odlišných, ale platných možností;
4. postupne sa naučí, ktorá z nich sedí práve tomuto používateľovi v tomto kontexte;
5. umožní výsledok upravovať po stopách a sekciách bez straty zvyšku projektu.

Pracovný názov tejto schopnosti je **Producer DNA**. Nie je to jeden globálny „štýl používateľa“ ani napodobňovanie konkrétneho interpreta. Je to lokálna, vysvetliteľná pamäť rozhodnutí typu „pri melodickom trappe mám radšej priestranné leady“ alebo „pri West Coast beate chcem suchšie bicie“.

```text
brief + projekt + voliteľná audio referencia
        ↓
opraviteľný kontrakt: POVINNÉ / PREFERENCIE / ZÁKAZY / ZACHOVAŤ / NEISTÉ
        ↓
SAFE smer ─ PERSONAL smer ─ EXPERIMENTAL smer
        ↓ hard gates → vkus používateľa → audio kontrola → rozmanitosť
        ↓ audition / A-B → cielená zmena → apply cez command + undo
        ↓ explicitná voľba používateľa zlepší Producer DNA
```

## 2. Čo už kód poskytuje

Tento plán nadväzuje na existujúce moduly; nezačína druhý generátor ani ďalší paralelný UI flow.

| Základ                                      | Aktuálny kód                                                                                                        | Dôsledok pre ďalšiu prácu                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Brief ako opraviteľná špecifikácia          | `src/intent/brief-contract.ts`, `src/intent/brief-gate.ts`, `src/ui/IntentPanel.tsx`                                | Rozšíriť vysvetlenie a opravy, nie obísť hard gate.                                                       |
| Kandidáti, ranking, audition a presný apply | `src/intent/pipeline.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/ui/IntentPanel.tsx` | Zlepšiť to, čo bank hľadá a ako vysvetlí rozdiely; nepridávať druhú generáciu pri USE.                    |
| Lokálny feedback z obľúbených rollov        | `src/intent/favorites.ts`, `src/intent/favorites-core.ts`, `src/intent/style-vector.ts`                             | Dnešný vektor je užitočný globálny prior, ale nie kontextová pamäť preferencií.                           |
| Re-ranking podľa zvuku                      | `src/intent/audio-feedback.ts`, `src/intent/ranking-v3.ts`, `src/intent/rerank-weights.ts`                          | Dnešné RMS/crest/ZCR/bass-range skóre je technický proxy signál, nie personalizovaný umelecký úsudok.     |
| Referencia z audia                          | `src/intent/audio-reference.ts`, `src/intent/reference-embedding.ts`, `src/intent/semantic-conditioning.ts`         | Referencia dnes ovplyvňuje spoločné conditioning; ďalším krokom je vybrať, ktoré jej vlastnosti preniesť. |
| Nadväzujúce pokyny a kandidátske referencie | `src/intent/session-context.ts`, `src/intent/iteration.ts`, `src/intent/producer-session.ts`                        | Existuje session-level základ; dlhodobá, rozvetvená a používateľom spravovaná pamäť je ďalšia vrstva.     |
| Song flow a vokálny kontext                 | `src/intent/compose.ts`, `src/intent/song.ts`, `src/vocal/`, `src/ui/IntentPanel.tsx`                               | Rozšíriť hodnotenie a editáciu na úroveň celej skladby, nie iba jednotlivého patternu.                    |

### Dôležité caveaty baseline

- `public/models/intent-ranker-v1.manifest.json` uvádza `favoriteGroups: 0`. Ranker teda môže byť aktívny a technicky validný, ale tento údaj nedokazuje, že sa naučil osobné hudobné preferencie.
- `src/intent/style-vector.ts` už pri dostupnom sémantickom modeli mieša prompt s priemerom obľúbených rollov. Je to globálny vektor z pozitívnych výberov; nerozlišuje kontexty a nemá explicitné „toto sa mi nepáči“ ani porovnanie A proti B.
- `src/intent/rerank-weights.ts` kalibruje jeden scalar medzi prvým rankingom a generickým audio-fit skóre. Nie je to samostatný osobný ranker.
- `candidate-bank.ts` stabilne deduplikuje a zoradí kandidátov, ale samostatná garancia hudobnej rozmanitosti medzi top voľbami je budúca práca.
- `src/intent/session-context.ts` drží poslednú generáciu a obmedzenú históriu promptov. Nie je to trvalý projektový version graph.

Pred zmenou rankera treba zosúladiť živé validátory, modelový manifest a staršie stavové tvrdenia v `INTENT_ENGINE.md` a `docs/intent-engine-ai-ranker-goal.md`. Žiadny model nedostane označenie „personalizovaný“ len preto, že načíta ONNX súbor alebo dosiahne zhodu s heuristikou.

## 3. Cieľový používateľský moment

Používateľ napíše:

> „Temný melodický trap, veľa priestoru, hook nech je väčší, 808 a bicie nechaj.“

KYX najprv ukáže kontrakt:

- **POVINNÉ:** zachovať bicie a 808;
- **PREFERENCIE:** temný, melodický, priestranný;
- **ZÁMER ARANŽMÁNU:** hook má narásť oproti slohe;
- **NEISTÉ:** tónina — môže zostať z projektu alebo ju môže používateľ zvoliť.

Následne vytvorí tri charakterovo odlišné smery. Každý prejde rovnakými hard gates. Používateľ si ich vypočuje, vyberie B a dopíše: „B, ale lead nechaj priestrannejší.“ KYX ukáže, že mení iba lead; bicie a 808 zostávajú obsahovo nezmenené. Presne vypočutý návrh sa aplikuje jedným undoable commandom. Voľba zlepší lokálnu preferenčnú pamäť pre príslušný hudobný kontext.

## 4. Zásady návrhu

1. **Hard constraints nie sú preferencia.** „Nechaj 808“ je gate a hash kontrola, nie záporný bod v skóre.
2. **Model vyberá alebo navrhuje; nemení projekt priamo.** Mutácia ide cez existujúce commands.
3. **Osobný vkus je kontextový.** Globálny vektor je prior; žáner, produkčný profil, rola a typ úlohy môžu meniť preferenciu.
4. **Žiadne učenie z nejednoznačného signálu.** „USE“ nemusí znamenať „milujem zvuk“ — môže znamenať iba „toto je najbližšie briefu“. Rozlišovať výber, obľúbenie, odmietnutie a explicitné A/B.
5. **Rozmanitosť pred skóre.** Top 3 rovnaké beaty nie sú tri užitočné možnosti. Zároveň sa nesmie vyberať „divný“ kandidát iba preto, že je odlišný.
6. **Lokálne a spravovateľné.** Bez skrytého odosielania projektov či audia. Používateľ môže pamäť zobraziť, exportovať, pozastaviť a vymazať.
7. **Žiadne technické percento ako umelecká známka.** Modelové skóre môže zostať v diagnostike; používateľovi ukazovať dôvod, rozdiel a splnenie briefu.
8. **Deterministická reprodukcia.** Uložený brief, seed, modelová verzia a preference snapshot musia stačiť na reprodukovateľné poradie.

## 5. Implementačné fázy

### Fáza 0 — Pravdivý baseline a testovacia sada

**Cieľ:** zmerať rozdiel medzi existujúcim generátorom, globálnym rankerom a budúcim osobným výberom.

**Práca:**

1. Spustiť aktuálne ranker/semantic/audio validátory a zachytiť model hash, režimy, fallbacky, veľkosť assetov a cold/warm latenciu.
2. Zosúladiť `INTENT_ENGINE.md`, `docs/intent-engine-ai-ranker-goal.md` a AI-first roadmap s tým, čo naozaj potvrdzujú validátory.
3. Vytvoriť malú, verziovanú sadu briefov SK/EN: hard constraints, zachované roly, štýl, požiadavky na kontrast, audio reference a nejednoznačné pokyny.
4. Pre vybrané briefy vygenerovať anonymizované páry a urobiť blind listening. Oddeliť otázky „ktorý plní brief?“ a „ktorý by som si vybral?“.
5. Uložiť baseline párovú presnosť globálneho rankera, brief compliance, top-3 rozmanitosť, cold-start čas a veľkosť modelov.

**Kód a dôkazy:** `scripts/validate-intent-ranker*.mjs`, `scripts/ai-performance.mts`, `tests/intent-brief-suite.test.ts`, `tests/intent-ranker-golden.test.ts`, `public/models/*.manifest.json`.

**Hotovo, keď:** vieme zopakovať benchmark a odlíšiť modelovú validitu od hudobnej preferencie. Ak ľudské preferencie nie sú nazbierané, dokument to povie priamo.

### Fáza 1 — Lokálna párová pamäť vkusu

**Cieľ:** naučiť ranker z explicitných rozhodnutí, nielen z hviezdičky alebo heuristického teacher signálu.

**Používateľské akcie:**

- `A je bližšie`, `B je bližšie`, `ani jeden`, prípadne `obidva dobré`;
- voliteľný dôvod: groove, bicie, 808/bass, harmónia, lead, priestor, energia, originalita;
- samostatne zaznamenať `USE` (praktická voľba) a `★` (silná preferencia).

**Dátový kontrakt (návrh):**

```ts
interface PreferenceObservationV1 {
  version: 1;
  context: {
    genre: string;
    productionProfile?: string;
    task: "pattern" | "section" | "song";
    roleScope: string[];
    intentFeatureHash: string;
  };
  candidateA: { contentHash: string; featureVersion: string; features: number[] };
  candidateB: { contentHash: string; featureVersion: string; features: number[] };
  choice: "a" | "b" | "neither" | "both";
  reason?: "groove" | "drums" | "bass" | "harmony" | "melody" | "space" | "energy" | "novelty";
  createdAt: number;
}
```

**Implementácia:**

1. Pridať verziovaný, ohraničený lokálny ledger pre párové voľby. Neukladať raw audio ani celý projekt; raw prompt neukladať bez výslovného súhlasu.
2. Zvoliť používateľom kontrolovaný storage a nástroje `export`, `clear`, `pause learning`. Pri poškodených alebo starých dátach bezpečne štartovať bez personalizácie.
3. Pridať čistú funkciu, ktorá z páru feature vektorov aktualizuje malý osobný preference adapter. Začať konzervatívnym regularizovaným párovým modelom, nie okamžitým retréningom veľkého ONNX modelu.
4. Osobný signál aplikovať iba po hard gates: `global score + confidence-weighted personal residual`. Cold start používa dnešný global ranking; váha osobného modelu rastie až s dostatočným množstvom relevantných rozhodnutí.
5. Držať hierarchiu kontextov: najprv žáner/profil/rola, potom globálny osobný prior. Príliš malá skupina dát sa nesmie tváriť ako spoľahlivá preferencia.
6. Do provenance uložiť verziu preference snapshotu a zdroj výberu, nie osobné surové dáta.

**Pravdepodobné súbory:** nový `src/intent/preference-ledger.ts`, nový čistý `src/intent/personal-ranker.ts`, `src/intent/ranking-v3.ts`, prípadne existujúce `favorites-core.ts` a UI v `src/ui/IntentPanel.tsx`.

**Testy:** `tests/intent-preference-ledger.test.ts`, `tests/personal-ranker.test.ts`, testy export/clear/corrupt storage, deterministický replay a test, že osobné skóre nikdy neprebije hard gate.

**Hotovo, keď:** po voľbe A/B sa používateľský ranker zmení iba v príslušnom kontexte; ten istý preference snapshot dá rovnaké poradie; vypnutie/vymazanie vráti presne globálne cold-start správanie.

### Fáza 2 — Tri odlišné kreatívne smery

**Cieľ:** candidate bank ponúkne rozmanité producentské možnosti, nie iba viac seedu-variácií jedného patternu.

**Smery:**

- **SAFE:** čo najvernejšie briefu a súčasnému projektu;
- **PERSONAL:** rovnaký brief, zoradený s lokálnym Producer DNA;
- **EXPERIMENTAL:** väčšia tolerancia novosti, stále v rámci hard constraints.

**Implementácia:**

1. Pridať verzovaný `searchMode`/search policy do generation plánu a provenance. Nepersistovať ho do projektovej schémy, ak ho netreba na obnovenie výsledku.
2. Vytvárať smermi kontrolované kandidátske rodiny: napr. melodický contour, hustota, syncopation budget, role density a phrase contrast — nie iba iný random seed.
3. Kandidát najprv prejde invariant repair a `brief-gate`; až potom sa hodnotí.
4. Výber vykonať v poradí: hard constraints → zhoda s briefom → osobný ranker → minimálna rozmanitosť top výsledkov. Diverzitu počítať z normalizovaných hudobných features/content, nie UUID.
5. Zaviesť diversity-aware výber (napr. MMR alebo prah vzdialenosti), ale nikdy neobetovať brief compliance len kvôli novosti.
6. V UI ukázať krátky rozdiel: „B má prázdnejší lead a viac priestoru; bicie sú rovnaké.“ Netváriť sa, že ide o objektívny AI score.

**Pravdepodobné súbory:** `src/intent/plan.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/ai/features/pattern-features.ts`, `src/ui/IntentPanel.tsx`.

**Hotovo, keď:** top návrhy sa hudobne odlišujú, každý spĺňa hard brief, ranking zostáva deterministický a používateľ dokáže jedným klikom vypočuť/apply presne zvolený kandidát.

### Fáza 3 — Reference ako selektívny donor

**Cieľ:** používateľ určí, čo si má KYX z referenčného audia požičať.

**Masky referencie:** groove/timing, energia, spektrálna textúra, harmónia/tónina, hustota a forma. Začať len vlastnosťami, ktoré sú merateľné a validované; neoverené vlastnosti označiť ako experimentálne.

**Implementácia:**

1. Zmeniť výsledok audio analýzy z jedného spoločného patchu na pomenované feature skupiny s confidence a pôvodom.
2. Pridať jednoduché ovládanie `použi groove / mood / harmóniu / formu` a možnosť každú skupinu odmietnuť.
3. Zostaviť conditioning iba z povolených skupín; textový brief a hard constraints majú prednosť.
4. Uložiť iba kompaktne odvodené údaje/hashes do session, nie surový referenčný WAV.
5. Porovnať „všetky vlastnosti“ proti „iba groove“ v syntetickom teste aj blind listeningu.

**Pravdepodobné súbory:** `src/intent/audio-reference.ts`, `src/intent/reference-embedding.ts`, `src/intent/semantic-conditioning.ts`, `src/ui/IntentPanel.tsx`.

**Hotovo, keď:** vypnutá conditioning skupina merateľne neovplyvní daný generation path; chýbajúci audio/semantic model zanechá funkčný textový fallback.

### Fáza 4 — Rozvetvený producentovský session graph

**Cieľ:** umožniť prirodzené iterácie bez straty dobrých nápadov alebo nečakaných zmien.

Príklad:

```text
A — pôvodný brief
├─ B — viac priestoru v leade (bicie/808 zachované)
│  └─ C — B, ale hook má väčší lift
└─ D — odvážnejšia harmónia
```

**Implementácia:**

1. Každý proposal nesie `parentContentHash`, intent patch, dotknuté role/sekcie, zachované content hashes a stav audition/apply/reject.
2. Referencie ako „druhý“, „vráť sa na A“ a „tento, ale menej hustý“ riešiť voči session graphu, nie iba poslednej banke.
3. Edit proposal zobraziť ako before/after diff a krátke „čo sa zmení / čo ostane“.
4. Prijatie = jeden undoable command; odmietnutie alebo zrušenie = nulová zmena projektu.
5. Najprv session-only. Dlhodobé uloženie a sync musia byť explicitné a nesmú ukladať sample audio do preference ledgeru.

**Pravdepodobné súbory:** `src/intent/session-context.ts`, `src/intent/iteration.ts`, `src/commands/commands.ts`, `src/ui/IntentPanel.tsx`.

**Hotovo, keď:** „B, ale X“ vždy cieli správnu vetvu; nedotknuté roly majú rovnaký content hash; zastaraný proposal ani collaboration update neprepíšu novší projekt.

### Fáza 5 — Producer DNA a výber celej skladby

**Cieľ:** hodnotiť, či funguje celá forma, nie iba to, či samostatný pattern vyzerá dobre.

**Implementácia:**

1. Definovať song-level features: kontrast sekcií, energia v čase, opakovanie motívov, hustota, dĺžka prechodov a kompatibilita sekcia→sekcia.
2. Vyberať alternatívy najprv na úrovni sekcií, potom zostaviť malé množstvo celých song kandidátov s reprodukovateľnými seedmi.
3. Renderovať iba top finalistov a používať rovnaký offline renderer ako export.
4. Používateľovi ponúknuť „hook väčší“, „drop prichádza priskoro“ ako dôkazom podložený proposal, nie automatickú zmenu.
5. Umožniť cielené A/B jednej sekcie oproti celej skladbe; apply zmení len potvrdený rozsah.

**Pravdepodobné súbory:** `src/intent/song.ts`, `src/intent/compose.ts`, `src/intent/song-audio-review.ts`, `src/intent/ranking-v3.ts`, `src/ui/IntentPanel.tsx`.

**Hotovo, keď:** top song kandidát vyhrá blind porovnanie nad súčasným baseline pre rovnaký brief; ľubovoľná cielená revízia nemení chránené sekcie a preview zodpovedá commitnutému výsledku.

## 6. Evaluácia a release gates

Žiadne jedno „AI quality“ číslo. Reportovať samostatne:

| Metrika                      | Čo dokazuje                               | Gate                                                                                          |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Hard-brief compliance        | Tvrdé požiadavky a zákazy                 | Žiadny neplatný kandidát sa nesmie dať USE; ak je bank prázdny, UI vysvetlí dôvod.            |
| Preserve integrity           | Nedotknutý projektový obsah               | Chránené roly/sekcie majú pred/po rovnaký UUID-free content hash.                             |
| Pairwise preference win rate | Či osobný selector lepšie predikuje voľbu | Porovnávať s globálnym rankerom na held-out brief/session pároch, nie na tréningových dátach. |
| Candidate diversity          | Či top kandidáti ponúkajú reálnu voľbu    | Reportovať feature distance aj blind vnímanie; samotná odlišnosť nie je kvalita.              |
| Determinizmus                | Či sa výber dá reprodukovať               | Rovnaké vstupy + preference snapshot + verzie → rovnaký obsah aj poradie.                     |
| Odolnosť a súkromie          | Či lokálna cesta zostáva bezpečná         | Bez modelu/offline funguje fallback; ledger sa dá vypnúť, exportovať a vymazať.               |
| Latencia a veľkosť           | Či feature ostáva použiteľná              | Cold/warm latency a shipped/downloaded model size sa merajú samostatne.                       |

Párové ľudské hodnotenie má skryť identitu a poradie kandidátov. „Používateľ zvolil A“ je trénovací signál, nie automatický dôkaz, že A je objektívne lepšie pre všetkých.

## 7. Súkromie, kontrola a bezpečnostné hranice

- Všetko personalizačné učenie je lokálne a opt-in; žiadna telemetria ani tichý cloud fallback.
- Preference ledger neobsahuje surové PCM/WAV, názvy súkromných súborov ani celý projektový JSON.
- Používateľ má `pause`, `export`, `clear all` a zobrazenie toho, ktoré vlastnosti sa naučili.
- Osobný ranker nikdy neprebije hard constraints, scale/invariant gates, `preserve` ani stale guard.
- Pri slabom počte dát používať globálny ranker a označiť personalizáciu ako „zatiaľ málo signálu“, nie tvrdiť istotu.
- Generovanie, ranking aj audit zostávajú mimo AudioWorklet callbacku; projekty sa menia iba cez commands.
- Pri prenose interpreta/trackovej referencie používať všeobecné hudobné vlastnosti a používateľom kontrolované osi, nie sľub presnej kópie nahrávky.

## 8. Odporúčané poradie doručenia

1. **Najprv Fáza 0:** overiť aktuálny model a benchmark; zjednotiť protirečivé dokumentačné tvrdenia.
2. **Potom Fáza 1 MVP:** párová voľba A/B + lokálny ledger + jednoduchý, confidence-weighted osobný residual; bez novej generatívnej dependency.
3. **Fáza 2:** tri search lanes a diversity-aware candidate bank.
4. **Fáza 3 a 4:** selektívna audio referencia a rozvetvená editácia.
5. **Fáza 5:** song-level hodnotenie po potvrdení, že candidate workflow na úrovni beatu skutočne zlepšuje používateľské voľby.

Najdôležitejší produktový experiment je Fáza 1: **po niekoľkých vedomých A/B voľbách má KYX lepšie trafiť ďalší brief tohto používateľa než rovnaký globálny selector — bez porušenia jedinej tvrdej požiadavky.** Ak sa to blind testom nepotvrdí, nepridávať ďalší model; zlepšiť feedback signál, kontexty alebo candidate diversity.

## 9. Vzťah k ostatným plánom

- Širší AI-first workflow, song generation, zvukárske odporúčania a MRT2: `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`.
- Intent modely/ranking a ich validácia: `INTENT_ENGINE.md`, `docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md`.
- Generative tracks/MRT2: `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`.

Tento dokument sa sústreďuje iba na osobný feedback loop, kreatívnu rozmanitosť a vysvetliteľnú iteráciu. Nevyhlasuje navrhované fázy za implementované.
