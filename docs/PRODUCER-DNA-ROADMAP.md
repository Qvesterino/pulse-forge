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

| Základ                                      | Aktuálny kód                                                                                                                                  | Dôsledok pre ďalšiu prácu                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Brief ako opraviteľná špecifikácia          | `src/intent/brief-contract.ts`, `src/intent/brief-gate.ts`, `src/ui/IntentPanel.tsx`                                                          | Rozšíriť vysvetlenie a opravy, nie obísť hard gate.                                                       |
| Kandidáti, ranking, audition a presný apply | `src/intent/pipeline.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/intent/audition.ts`, `src/ui/IntentPanel.tsx` | Existuje správny audition → výber → apply základ; zlepšiť, čo bank hľadá a ako vysvetlí rozdiely.         |
| Globálny prior z obľúbených rollov          | `src/intent/favorites.ts`, `src/intent/favorites-core.ts`, `src/intent/style-vector.ts`                                                       | Užitočný conditioning prior, ale nie kontextová pamäť párových preferencií.                               |
| Explicitné A/B Producer DNA                 | `src/intent/preference-ledger.ts`, `src/intent/preference-ledger-core.ts`, `src/ui/ProducerDnaCompare.tsx`                                    | V1 už ukladá lokálne A/B/ani jeden/oba dobré, voliteľný dôvod; má pause, export a clear.                  |
| Personalizovaný ranking                     | `src/intent/personal-ranker.ts`, `src/ai/ranking/rank-candidates.ts`                                                                          | Deterministický pairwise model pridáva ohraničený residual až po globálnom rankingu a hard gates.         |
| Diverzita shortlistu                        | `src/intent/candidate-diversity.ts`, `src/ai/ranking/rank-candidates.ts`                                                                      | MMR ponechá aktuálneho víťaza a diverzifikuje top 3 z už existujúcich kandidátov; nevytvára nové smery.   |
| Re-ranking podľa zvuku                      | `src/intent/audio-feedback.ts`, `src/intent/ranking-v3.ts`, `src/intent/rerank-weights.ts`                                                    | Dnešné RMS/crest/ZCR/bass-range skóre je technický proxy signál, nie personalizovaný umelecký úsudok.     |
| Referencia z audia                          | `src/intent/audio-reference.ts`, `src/intent/reference-embedding.ts`, `src/intent/semantic-conditioning.ts`                                   | Referencia dnes ovplyvňuje spoločné conditioning; ďalším krokom je vybrať, ktoré jej vlastnosti preniesť. |
| Nadväzujúce pokyny a kandidátske referencie | `src/intent/session-context.ts`, `src/intent/iteration.ts`, `src/intent/producer-session.ts`                                                  | Existuje session-level základ; dlhodobá, rozvetvená a používateľom spravovaná pamäť je ďalšia vrstva.     |
| Song compose, audition a audio review       | `src/intent/compose.ts`, `src/intent/song.ts`, `src/intent/song-audio-review.ts`, `src/vocal/`, `src/ui/IntentPanel.tsx`                      | Celoskladbový flow už existuje; chýba mu jasný song-level feedback a DNA porovnávanie.                    |

### Presné hranice dnešného základu

- `features.v1` má 54 rozmerov. Osobný logistický pairwise model potrebuje minimálne dve použiteľné, odlišné porovnania; jeho residual je ohraničený na 0,2 a slabý signál ponechá globálne poradie.
- `ani jeden` a `oba dobré` sa uložia, ale zámerne nehovoria, ktorý kandidát má vyhrať. `USE` sa automaticky nepovažuje za vkus.
- Dôvod A/B už obmedzuje reason-specific adapter na merateľné osi pre groove, bicie, melódiu, frázový priestor, energiu aranžmánu a novosť motívu. Basy a harmónia sú zámerne označené ako nepodporované, lebo `features.v1` pre ne nemá samostatné merania.
- Diverzitný MMR mení poradie kandidátov, ktoré už v banku existujú. Bez nových generatívnych rodín nepridá odlišnú harmóniu, groove ani aranžmán.
- Audio reference dnes tvorí spoločné conditioning. Výber donor osí (napr. groove áno, harmónia nie) ešte nie je používateľsky riadený.
- Song composer/preview už existujú, ale compare workflow a preference context treba vedieť explicitne rozlíšiť medzi patternom, sekciou a celou skladbou.
- Aktívny ONNX ranker ani `favoriteGroups` v manifeste nedokazujú, že model predikuje osobný vkus. To dokáže až oddelený, held-out, používateľský blind benchmark.

### Stav roadmapy podľa kódu

| Oblasť                              | Stav dnes                                    | Čo ešte treba dokázať alebo dorobiť                                                           |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Brief contract a hard gates         | Základ implementovaný                        | Robustnejšie confidence, konflikty a oprava toho, čo parser pochopil.                         |
| Explicitné lokálne párové voľby     | V1 implementovaná                            | Overiť kvalitu a reprezentatívnosť feedbacku na held-out voľbách.                             |
| Personal re-ranking                 | V1 + reason-scoped adapters implementované   | Held-out blind dôkaz prínosu oproti globálnemu rankeru; lepšia kontextová/rolová granularita. |
| Top-3 diverzita                     | Prvý MMR krok implementovaný                 | Kandidátske rodiny musia byť rozdielne už pri generovaní.                                     |
| SAFE / PERSONAL / EXPERIMENTAL      | Zatiaľ nie ako skutočné generatívne lane-y   | Verzovaná policy a odlišné kandidátske rodiny cez existujúce generátory.                      |
| Audio referencia s voľbou donor osí | Analýza/conditioning implementované          | Vypínateľné osi a test, že vypnutá os do conditioning vôbec nevstúpi.                         |
| Referenčný session graph            | Posledný generation/follow-up implementovaný | Vetvenie, návrat na ľubovoľný návrh a bezpečný, vysvetliteľný apply.                          |
| Song generation a audition          | Základ implementovaný                        | Sekčné/song-level párové hodnotenie a DNA kontext, nie iba patternové voľby.                  |

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

**Čo je už v kóde:** ledger, lokálne UI, explicitné voľby, privacy-safe feature snapshots a malý pairwise re-ranker existujú. Najbližšia práca nie je napísať ich odznova, ale využiť `reason` bezpečne, rozšíriť evaluáciu a overiť, či osobný residual pomáha na nových kandidátoch.

**Producer DNA v2 — naučiť sa _prečo_, nie iba A/B (plán; prvý adapter slice už implementovaný):**

1. Urobiť z dôvodu (`groove`, `drums`, `bass`, `harmony`, `melody`, `space`, `energy`, `novelty`) skutočnú supervise-label. Každý dôvod sa mapuje na stabilne verzované feature skupiny; napr. `space` nesmie omylom preškálovať kick pattern.
2. Udržiavať konzervatívny celkový adapter aj malé reason-specific reziduá. Bez dostatku dát pre konkrétny dôvod použiť celkový adapter/globálny ranking; nikdy netváriť dve voľby ako spoľahlivý osobný profil.
3. Používateľovi ukázať vysvetliteľné preferencie typu „v trap leadoch si zatiaľ vyberáš menej husté frázy“, spolu s počtom porovnaní a možnosťou opravy/vymazania. Neprezentovať koreláciu ako istotu.
4. `ani jeden` využiť iba ako signál nízkej spokojnosti s rodinou, nie ako A/B smer. Najprv ho použiť na diagnostiku: či zlyhal brief, kandidátska rodina alebo zvuk. `oba dobré` je pozitívna neistá voľba, nie dôkaz, že A=B.
5. Výber `USE` a manuálna editácia môžu navrhnúť otázku „chceš si toto zapamätať?“, ale bez explicitného potvrdenia nemenia preference ledger. Tak ostane čistý význam tréningových dát.

**Dôkaz:** benchmark porovná globálny ranker, existujúci všeobecný personal residual a reason-aware variant na nevidených dvojiciach toho istého používateľa/kontekstu. Reportovať win-rate, vzorku a interval neistoty; aktivácia je oprávnená iba vtedy, keď výsledok prekoná náhodu aj baseline. **Neriešiť to pridaním ONNX modelu, kým lacný feature adapter nepreukáže limit.**

**Implementované (2026-09-26):** neoznačené A/B voľby trénujú iba všeobecný adapter; voľby s dôvodom trénujú iba príslušnú maskovanú feature skupinu. Súčet personal residualov je ohraničený. `bass`/`harmony` nemajú adapter a compare UI ich deaktivuje s vysvetlením. UI tiež nesľubuje zmenu rankingu po prvej voľbe — treba aspoň dve relevantné porovnania. Toto je behaviorálna safety slice, nie dôkaz, že ranking už hudobne lepší.

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

**Stav implementácie (2026-09-26):** prvý diversity-aware krok je zapojený do async candidate banku: prvý návrh ostáva víťazom predchádzajúceho rankingu, ďalšie miesta v top 3 vyberá MMR nad štrukturálnymi drum/melodic feature-mi; prompt-fit a batch-relative rozmery sa za novotu nevydávajú. Kandidáti sa neodstraňujú a chýbajúce/neplatné feature vektory vrátia pôvodné deterministické poradie. UI už nezobrazuje interné heuristic/ONNX percentá ako používateľskú známku.

Toto **ešte nie sú tri generatívne lane-y**. SAFE/PERSONAL/EXPERIMENTAL zatiaľ nemajú oddelené candidate families ani explicitné ovládanie v používateľskom flow; MMR iba zvyšuje kontrast medzi platnými návrhmi, ktoré dnešný generátor vytvoril. Ďalším krokom je lane policy s kontrolovaným experimental variation budgetom a rovnakou brief/preserve bránou.

**Kontrakt lane policy (návrh, nie existujúci typ):**

```ts
type SearchLane = "safe" | "personal" | "experimental";

interface SearchPolicyV1 {
  version: 1;
  lane: SearchLane;
  seed: string;
  axes: {
    grooveVariation: number;
    rhythmicDensity: number;
    syncopation: number;
    motifNovelty: number;
    harmonicDistance: number;
  };
  lockedRoles: IntentRole[];
}
```

Policy je **generation-time** vstup, nie UI dekorácia ani iba re-ranking label. Hodnoty osí sú návrhové; rozsahy a účinok sa najprv musia zmerať na existujúcich template/symbolic-prior generátoroch. Rovnaký brief-gate a preserve test platí pre každú lane.

| Lane             | Generačná politika                                                                                                   | Čomu používateľ môže veriť                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **SAFE**         | Najmenšia odchýlka od briefu/projektu; nízka novelty; preferuje stabilné groove/formy.                               | Najistejšie splnenie zadania, nie automaticky najzaujímavejší výsledok.                          |
| **PERSONAL**     | Rovnaké hard constraints; seedované varianty okolo kontextového Producer DNA a výslovne vybraných vlastností.        | Najbližšie doterajším explicitným voľbám, iba ak je signál dostatočný; inak označený cold-start. |
| **EXPERIMENTAL** | Väčší budget pre syncopáciu, contour, hustotu, harmony/motif distance; nesmie porušiť brief ani meniť zamknuté roly. | Odvážnejší návrh v rámci zadania, nie náhodná „weirdness“ odmena.                                |

Generovanie má byť deterministické: odvodiť seed z `rootSeed + lane + variantIndex + generatorVersion`; provenance uloží lane, policy verziu a seed. Najprv vytvoriť malý ohraničený počet kandidátov na lane, vyradiť hard-gate porušenia, až potom skórovať brief fit, personal residual a rozmanitosť **vnútri lane**. Diverzita nikdy nesmie vytlačiť neplatný alebo briefu odporujúci návrh.

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

### End-to-end vertical slice — „sprav mi beat, ale počúvaj ma“

Toto je prvý ucelený release cieľ. Nesmie vyžadovať, aby sa používateľ učil rozdiel medzi embeddingom, ONNX score a generation seedmi.

1. **Napíše brief.** Napr. „West Coast, pomalší bounce, veľký melodický hook; nechaj môj kick a 808.“
2. **KYX ukáže krátky opraviteľný kontrakt.** Oddelí požiadavky, preferencie a `ZACHOVAŤ`; nejasné slovo sa označí ako neisté. Otázku položí iba vtedy, keď neistota mení cieľ alebo môže porušiť zachovaný obsah.
3. **Používateľ môže zvoliť referenciu selektívne.** Jedným klikom povie „požičaj groove/energiu/timbre“, pričom harmónia a forma ostanú z textu/projektu. Default nesmie potichu kopírovať každú odhadnutú vlastnosť.
4. **KYX vyhľadá tri skutočne iné smery.** SAFE/PERSONAL/EXPERIMENTAL používajú odlišné, seedované generator policies; všetky kandidáty prejdú rovnakými hard gates. Ak DNA nemá signál, PERSONAL čestne používa cold-start ranking.
5. **Počúvanie je prvotriedne.** A/B sa prepína bez mutácie projektu; návrhy sú hlasitosťou primerane zrovnané iba v preview. Zobrazené „prečo“ vychádza z merateľných rozdielov a contractu, napr. „B má redšiu melodickú frázu; kick/808 ostali rovnaké“, nie z vymysleného 93 %.
6. **Používateľ dá malý, špecifický signál.** „B; kvôli priestoru“ alebo „ani jeden — groove je správny, ale lead nie.“ Len explicitná voľba sa učí. Dôvod zvolí feature skupinu, ktorú má systém uprednostniť.
7. **Iteruje bez straty take-u.** „B, ale hook väčší“ vytvorí potomka B v session graph-e. Diff povie, ktoré roly/sekcie sa zmenia a ktoré budú identické. A/B predchádzajúceho a nového návrhu ostáva dostupné.
8. **Apply je presný a vratný.** Použije sa presne auditionovaný proposal cez existujúci command/undo. Ak sa projekt medzitým zmenil alebo hash chránenej stopy nesedí, apply sa zastaví a vyžiada nové preview.
9. **Celá skladba ostáva v rukách producenta.** Po prijatí beatu možno rozšíriť song, porovnať sekcie, následne „freeze“ návrh do bežného KYX obsahu. Generovanie nikdy samo neprepíše finálny projekt.

#### Čo bude používateľ cítiť ako inováciu

- **Nie prompt-to-audio ruleta, ale search session.** Každý návrh má rodiča, dôvod existencie a rovnaké kritériá briefu.
- **DNA je podmienená rolou a kontextom.** Vkus na West Coast hi-hat groove sa neprenesie automaticky na ambientný pad alebo vokál.
- **Feedback opravuje generátor.** „Viac priestoru“ sa učí o priestorových/rolových vlastnostiach, nie ako všeobecná preferencia vyššieho BPM.
- **Záporné voľby sú diagnostika.** „Ani jeden“ spustí cielenú opravu smeru (brief, groove, melodická rodina), nie náhodné prelosovanie všetkého.
- **Audio reference je sada donor osí.** Možno si požičať swing a dynamiku bez prevzatia harmónie, aranžmánu alebo produkčnej textúry.
- **Take memory je editovateľná história.** Používateľ vie vetviť, pomenovať, porovnať a vrátiť sa; systém nie je čierna skrinka s jediným „undo“.

#### Stavové hranice vertical slice

| Akcia                            | Zodpovedná vrstva                                                               | Povinná záruka                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Parsovanie a oprava briefu       | `brief-contract.ts`, `text-parser.ts`, `brief-gate.ts`, UI                      | Neistota a konflikt sú viditeľné; zákazy/zachovanie sú hard constraints.                                             |
| Search lane a candidate families | `plan.ts`, `providers/local.ts`, `candidate-bank.ts`, generator-specific moduly | Rovnaký vstup a policy/seed/verzie → rovnaké kandidáty; tri názvy bez troch odlišných rodín sa nepovažujú za hotové. |
| Vkus a výber                     | `personal-ranker.ts`, `rank-candidates.ts`, `candidate-diversity.ts`            | Personal score je post-gate, confidence-weighted, vysvetliteľný a nikdy neprebije hard constraints.                  |
| Donor audio                      | `audio-reference.ts`, `reference-embedding.ts`, `semantic-conditioning.ts`      | Vypnutá os neovplyvní conditioning; fallback bez modelu zachová textové generovanie.                                 |
| Compare/audition                 | `ProducerDnaCompare.tsx`, `audition.ts`, `IntentPanel.tsx`                      | Žiadna zmena projektu počas audition; A/B voľba aj dôvod patria presným content hash-om.                             |
| História a apply                 | `session-context.ts`, `iteration.ts`, commands                                  | Parent hash, scope, preserve hashes a audition hash sa validujú pred jediným undoable apply.                         |
| Song flow                        | `compose.ts`, `song.ts`, `song-audio-review.ts`                                 | Pattern, section a song preference sú samostatné task contexts; auditionovaný mix je ten, ktorý sa použije.          |

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

### Benchmark protokol a rozhodnutie o aktivácii

1. Zmraziť verzie parsera, generatora, feature contractu, rankera a search policy; ukladať seed a content hash každého kandidáta.
2. Rozdeliť páry **podľa promptu/sessionu používateľa**, nie náhodne podľa riadkov. Kandidáty z toho istého generation batchu nesmú uniknúť zároveň do train aj test.
3. Pre každý pár náhodne prehodiť A/B a skryť názov lane/modelu. Oddelene sa spýtať: „Ktorý lepšie plní zadanie?“, „Ktorý by si si nechal?“ a pri iterácii „Zmenilo sa iba to, čo si žiadal?“
4. Reporting: počet používateľov, párov a kontextov; párová presnosť + interval neistoty; hard-gate porušenia; preserve hash zlyhania; diversity feature distance; cold/warm latency; model/data size.
5. Osobný selector povoliť iba tam, kde má dostatok signálu a held-out výsledok prekonáva globálny baseline. Inde zobrazovať cold-start. Nový ONNX ranker trénovať až po preukázaní, že jednoduchý lokálny model nestíha.
6. Ak sa zlepší iba „odlišnosť“ a nie brief-fit alebo používateľská voľba, neaktivovať to ako quality improvement. Vysoká novota nie je cieľ sama o sebe.

## 7. Súkromie, kontrola a bezpečnostné hranice

- Všetko personalizačné učenie je lokálne a opt-in; žiadna telemetria ani tichý cloud fallback.
- Preference ledger neobsahuje surové PCM/WAV, názvy súkromných súborov ani celý projektový JSON.
- Používateľ má `pause`, `export`, `clear all` a zobrazenie toho, ktoré vlastnosti sa naučili.
- Osobný ranker nikdy neprebije hard constraints, scale/invariant gates, `preserve` ani stale guard.
- Pri slabom počte dát používať globálny ranker a označiť personalizáciu ako „zatiaľ málo signálu“, nie tvrdiť istotu.
- Generovanie, ranking aj audit zostávajú mimo AudioWorklet callbacku; projekty sa menia iba cez commands.
- Pri prenose interpreta/trackovej referencie používať všeobecné hudobné vlastnosti a používateľom kontrolované osi, nie sľub presnej kópie nahrávky.

## 8. Odporúčané poradie doručenia

1. **Fáza 0 — pravdivý baseline.** Spustiť relevantné ranker/brief/audio evaluácie na aktuálnom worktree; zosúladiť živé manifesty a stavové dokumenty. Zaznamenať, čo je kód a čo iba roadmap.
2. **Uzavrieť Fázu 1 — dokázať a spresniť existujúce DNA v1.** Blind held-out benchmark pre všeobecný aj reason-aware adapter; až výsledky určia, či treba lepšie kontexty/rolové skupiny. Nepridávať model/dependency.
3. **Dokončiť Fázu 2 — generovať skutočne rozdielne smery.** SearchPolicyV1, lane-specific candidates, derivácia seedov/provenance, gates a audition. MMR ostáva shortlist mechanika, nie náhrada generovania.
4. **Fáza 3 — ovládateľná referencia.** Pridať masky donor osí s confidence/provenance a testom nulového vplyvu vypnutej osi.
5. **Fáza 4 — edit graph.** Session-only vetvenie a robustné hash guardy; až po stabilnom compare/apply flow riešiť dlhodobú perzistenciu.
6. **Fáza 5 — Producer DNA pre skladbu.** Použiť existujúci song compose/audition, ale oddeliť pattern/section/song feedback a vyhodnotiť celú formu na blind posluchu.

Najdôležitejší experiment zostáva: **po explicitných rozhodnutiach má KYX na ďalších, nevidených kandidátoch lepšie predikovať používateľovu voľbu než globálny selector — pri nulovom porušení tvrdých požiadaviek a zachovania.** Ak test nevyjde, najprv opraviť candidate families, feedback alebo kontext; ďalší model je posledná, nie prvá páka.

## 9. Vzťah k ostatným plánom

- Širší AI-first workflow, song generation, zvukárske odporúčania a MRT2: `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`.
- Intent modely/ranking a ich validácia: `INTENT_ENGINE.md`, `docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md`.
- Generative tracks/MRT2: `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`.

Tento dokument sa sústreďuje iba na osobný feedback loop, kreatívnu rozmanitosť a vysvetliteľnú iteráciu. Nevyhlasuje navrhované fázy za implementované.
