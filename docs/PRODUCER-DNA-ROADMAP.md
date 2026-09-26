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

### 1.1 Produktové inovácie, ktoré z KYX spravia osobného producenta

Najväčšia príležitosť nie je pridať ďalšie tlačidlo „Generate“, ale spojiť interpretáciu, vyhľadávanie, počúvanie a učenie do jedného producentovho pracovného cyklu. Nasledujúce schopnosti sú produktové návrhy; pri každej odlišujem existujúci základ od práce, ktorú ešte treba urobiť.

#### A. Intent compiler: prompt sa zmení na opraviteľný produkčný kontrakt

Voľný brief sa pred generovaním rozloží na **POVINNÉ**, **PREFERENCIE**, **ZÁKAZY**, **ZACHOVAŤ** a **NEISTÉ**. Používateľ môže opraviť jednotlivý bod bez prepisovania promptu. KYX sa opýta iba vtedy, ak nejednoznačnosť môže zmeniť cieľ alebo ohroziť chránený obsah; inak pokračuje s viditeľným, vratným predpokladom.

**Základ v kóde:** `brief-contract.ts`, `brief-gate.ts`, `text-parser.ts` a `IntentPanel.tsx` už poskytujú kostru. Ďalej treba zlepšiť confidence, konflikty a slovenskú/anglickú golden brief sadu. Parser ani ONNX model nesmú potichu povýšiť odhad na tvrdý fakt.

Pri ochrane už parser normalizuje bežné názvy častí (`kick`, `snare`, `hi-hat`, `808`) na ich bezpečnú celú rolu (`drums`/`bass`). To ešte nie je nezávislé pad-level riadenie: napríklad „kick nechaj, snare zmeň“ sa dnes nesmie prezentovať ako presne vykonateľné, kým intent contract a generator nevedia oddeliť tieto podčasti.

**Akceptácia:** na verziovanej brief sade meriame zvlášť správnosť extrakcie, pravdivé zobrazenie neistoty a nulové porušenia hard constraints; používateľ vie interpretáciu opraviť pred generation.

#### B. Riadené kreatívne hľadanie namiesto „seed ruletky“

Pri jednom brief-e KYX hľadá niekoľko skutočne odlišných riešení, nie tri takmer rovnaké náhody. **SAFE** drží brief a projekt, **PERSONAL** používa dostatočný explicitný DNA signál (inak prizná cold-start) a **EXPERIMENTAL** skúša kontrolovaný kontrast. Rozdiel musí vzniknúť pri generovaní — napríklad alternatívnym groove alebo melodickou rodinou — nie iba premenovaním kandidáta po rankingu.

Všetky smery používajú rovnaký kontrakt, invariant repair a brief gate. Ak platnú alternatívu nemožno vytvoriť, KYX vysvetlí dôvod namiesto toho, aby kozmetickú zmenu vydával za nový smer.

**Základ v kóde:** `candidate-search.ts`, `candidate-bank.ts`, `providers/local.ts` a `providers/symbolic.ts` spájajú lane policy s generation/audition cestou. Aktuálny slice zahŕňa experimental alternate-groove + `evolving-hook`, a PERSONAL groove/repeating-hook odvodené z explicitného A/B vkusu. Evolving hook drží prvotaktový motív, no v striedavých taktoch skráti kadenciu o jednu 16-tinovú pozíciu (alebo vynechá posledný tón, ak jeho dĺžku nemožno skrátiť čisto na 16-tinovej mriežke); nemení výšky tónov. Ak sa reálna zmena nedá vytvoriť, family sa odstráni z candidate metadata. Osobná groove rodina sa najprv vyberá podľa syncopation v knižničných templates, no výsledný pattern sa meria cez `drums.syncopation`: lokálny generátor skúsi najviac 16 deterministických seedov a kandidáta ponechá iba vtedy, keď sa po hard gates posunie aspoň o 0,01 v naučenom smere. Inak sa kandidát vynechá. Symbolic prior kandidát používa rovnakú výstupnú kontrolu, zatiaľ bez retry. Toto dokazuje deterministickú štrukturálnu zmenu, nie jej subjektívnu kvalitu ani počuteľnosť; stále treba blind posluch. Ďalej: nezávislá rodina meniacich sa melodických kontúr a kontrolované aranžérske kontrasty.

**Akceptácia:** rozdiel kandidátov je počuteľný aj blind poslucháčom; každý kandidát prejde rovnakými hard gates; seed a verzia policy reprodukujú rovnaký obsah; novota neznižuje brief compliance.

#### C. Producer DNA ako kontextový vkus, nie globálny embedding

Pamäť má zachytiť napríklad „v tomto žánri chcem pri leade viac priestoru“, nie vytvoriť nerozlíšené „mám rád temné beaty“. Dôležitý je žáner/produkčný profil, úloha (pattern, sekcia, song) aj rola. Zhoda s briefom a osobná obľuba sú samostatné signály: používateľ môže vybrať prakticky správny návrh, hoci zvukovo preferuje iný.

Rozšírením je **aktívne zisťovanie vkusu**: keď to neohrozuje brief, systém ponúkne informatívny A/B kontrast na osi, o ktorej si nie je istý (napr. redší vs. hustejší lead). Jedno rozhodnutie tak môže byť užitočnejšie než porovnanie dvoch takmer rovnakých variantov. KYX sa však nepýta po každom kliknutí; ponuka má zmysel iba pri relevantnej neistote.

**Základ v kóde:** `preference-ledger-core.ts`, `preference-ledger.ts`, `personal-ranker.ts` a `rank-candidates.ts` ukladajú explicitné A/B voľby a počítajú ohraničený kontextový residual. Nové porovnania navyše zachytávajú skóre a verziu nepersonalizovaného selektora ešte pred Producer DNA re-rankingom; `preference-evaluation.ts` a `npm run producer-dna:evaluate -- <export.json>` ich vedia porovnať na neskorších voľbách s dosiaľ nevideným candidate obsahom. Reportuje aj konzervatívny Hoeffdingov interval neistoty, no predpoklad nezávislých riadkov nemožno overiť bez session grouping; preto je to technický diagnostický gate, nie dôkaz z reálneho posluchu ani populačná štatistika. Ďalej treba nazbierať lokálne explicitné voľby, vyhodnotiť dostatočnú held-out vzorku a vylepšiť granularitu kontextu/roly aj generatívne rodiny. „Ani jeden“ diagnostikuje neúspešný brief alebo rodinu; neurčuje víťaza A/B.

**Akceptácia:** na nových kandidátoch model predikuje voľbu používateľa lepšie než globálny selector; pri nedostatku dôkazov sa PERSONAL správa ako cold-start a UI to prizná.

#### D. Cielená revízia ako bezpečný hudobný patch

Pokyn „hook väčší, ale nechaj bicie a 808“ nesmie pregenerovať celý beat. KYX vytvorí potomka vybraného návrhu, ukáže **čo sa zmení** a **čo ostane rovnaké**, dovolí A/B a až potom aplikuje presne vypočutý obsah. Každý návrh nesie rodičovský/content hash, rozsah stôp či sekcií a hash chráneného obsahu. Vetvenie zachová A, aj keď vzniknú B a C.

**Základ v kóde:** candidate audition, `resultForCandidate`, `applyGenerationResultCommand` a stale-project guard už chránia presný výber. `session-context.ts` a `iteration.ts` poskytujú nadväzovanie; plný session graph a všeobecné role/section patch-y sú ďalšia fáza.

**Akceptácia:** before/after diff je pravdivý; chránený obsah má rovnaký UUID-free hash; zmena sa aplikuje jedným undoable commandom; zastaraný návrh sa odmietne a vyžiada nové preview.

#### E. Audio referencia ako sada donorov, nie „skopíruj tento zvuk“

Používateľ si vyberie, čo si má KYX z referencie požičať: groove, energiu, timbre/textúru, harmóniu alebo formu. Každá podporovaná os nesie confidence a pôvod; vypnutá os sa do conditioning nedostane. Textový brief a `ZACHOVAŤ` majú prednosť. Praktický pokyn môže znieť: „vezmi bounce, ale nechaj moju harmóniu aj štruktúru“.

**Základ v kóde:** `audio-reference.ts`, `reference-embedding.ts` a `semantic-conditioning.ts` už tvoria conditioning cestu. Používateľské masky donor osí a test nulového vplyvu vypnutej osi sú plánované; surové referenčné audio sa do DNA ledgeru neukladá.

**Akceptácia:** test pre každú os potvrdí, že zapnutá ovplyvní a vypnutá neovplyvní generation; chýbajúci model ponechá funkčný textový/offline fallback.

#### F. Celoskladbový producent s dôkazmi, nie neurčitým „AI score“

Pri prechode od loopu k skladbe KYX hodnotí vývoj energie, kontrast sekcií, návrat motívu, hustotu a prechody v čase. Namiesto „skladba má 82/100“ povie napríklad: „hook má rovnakú hustotu ako sloha; môžem navrhnúť väčší lift iba pre hook?“ Návrh ostane počuteľný, cielený a potvrdený používateľom.

**Základ v kóde:** `compose.ts`, `song.ts`, `song-audio-review.ts` a spoločný offline renderer tvoria východiskový song flow. Chýba oddelené pattern/section/song feedback učenie, song-level features a blind hodnotenie celých výsledkov.

**Akceptácia:** návrhy zlepšujú blind preferenciu nad baseline; sekčná revízia nemení ostatné sekcie a auditionovaný offline mix zodpovedá aplikovanému obsahu.

#### G. Malý lokálny základ; modely sú voliteľné a mimo audio callbacku

Užitočný beatmaker nemá vyžadovať nový mnohogigabajtový model ani cloud účet. Deterministický parser, generátory, gates a lokálna DNA pamäť tvoria základ. ONNX/sémantické modely sú voliteľná lazy pomoc v Worker-i s timeoutom a fallbackom. MRT2 je samostatný performer; jeho výstup možno zachytiť a zmeniť na bežný editovateľný KYX audio klip. Žiadny model nebeží v audio callbacku ani priamo nemení projekt.

**Akceptácia:** čistá inštalácia bez voliteľných modelov zvládne hlavný workflow offline; veľkosť a latencia modelov sú zmerané; zlyhanie modelu neporuší constraints, deterministický fallback ani audio thread.

## 2. Čo už kód poskytuje

Tento plán nadväzuje na existujúce moduly; nezačína druhý generátor ani ďalší paralelný UI flow.

| Základ                                      | Aktuálny kód                                                                                                                                  | Dôsledok pre ďalšiu prácu                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief ako opraviteľná špecifikácia          | `src/intent/brief-contract.ts`, `src/intent/brief-gate.ts`, `src/ui/IntentPanel.tsx`                                                          | Rozšíriť vysvetlenie a opravy, nie obísť hard gate.                                                                                                                          |
| Kandidáti, ranking, audition a presný apply | `src/intent/pipeline.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/intent/audition.ts`, `src/ui/IntentPanel.tsx` | Existuje správny audition → výber → apply základ; zlepšiť, čo bank hľadá a ako vysvetlí rozdiely.                                                                            |
| Globálny prior z obľúbených rollov          | `src/intent/favorites.ts`, `src/intent/favorites-core.ts`, `src/intent/style-vector.ts`                                                       | Užitočný conditioning prior, ale nie kontextová pamäť párových preferencií.                                                                                                  |
| Explicitné A/B Producer DNA                 | `src/intent/preference-ledger.ts`, `src/intent/preference-ledger-core.ts`, `src/ui/ProducerDnaCompare.tsx`                                    | V1 už ukladá lokálne A/B/ani jeden/oba dobré, voliteľný dôvod; má pause, export a clear.                                                                                     |
| Personalizovaný ranking                     | `src/intent/personal-ranker.ts`, `src/ai/ranking/rank-candidates.ts`, `src/intent/preference-evaluation.ts`                                   | Deterministický pairwise model pridáva ohraničený residual až po globálnom rankingu a hard gates; budúce A/B záznamy nesú global score/version pre chronologické porovnanie. |
| Diverzita shortlistu                        | `src/intent/candidate-diversity.ts`, `src/ai/ranking/rank-candidates.ts`                                                                      | MMR ponechá aktuálneho víťaza a diverzifikuje top 3 z už existujúcich kandidátov; nevytvára nové smery.                                                                      |
| Re-ranking podľa zvuku                      | `src/intent/audio-feedback.ts`, `src/intent/ranking-v3.ts`, `src/intent/rerank-weights.ts`                                                    | Dnešné RMS/crest/ZCR/bass-range skóre je technický proxy signál, nie personalizovaný umelecký úsudok.                                                                        |
| Referencia z audia                          | `src/intent/audio-reference.ts`, `src/intent/reference-embedding.ts`, `src/intent/semantic-conditioning.ts`                                   | Referencia dnes ovplyvňuje spoločné conditioning; ďalším krokom je vybrať, ktoré jej vlastnosti preniesť.                                                                    |
| Nadväzujúce pokyny a kandidátske referencie | `src/intent/session-context.ts`, `src/intent/iteration.ts`, `src/intent/producer-session.ts`                                                  | Existuje session-level základ; dlhodobá, rozvetvená a používateľom spravovaná pamäť je ďalšia vrstva.                                                                        |
| Song compose, audition a audio review       | `src/intent/compose.ts`, `src/intent/song.ts`, `src/intent/song-audio-review.ts`, `src/vocal/`, `src/ui/IntentPanel.tsx`                      | Celoskladbový flow už existuje; chýba mu jasný song-level feedback a DNA porovnávanie.                                                                                       |

### Presné hranice dnešného základu

- `features.v1` má 54 rozmerov. Osobný logistický pairwise model potrebuje minimálne dve použiteľné, odlišné porovnania; jeho residual je ohraničený na 0,2 a slabý signál ponechá globálne poradie.
- `ani jeden` a `oba dobré` sa uložia, ale zámerne nehovoria, ktorý kandidát má vyhrať. `USE` sa automaticky nepovažuje za vkus.
- Dôvod A/B už obmedzuje reason-specific adapter na merateľné osi pre groove, bicie, melódiu, frázový priestor, energiu aranžmánu a novosť motívu. Basy a harmónia sú zámerne označené ako nepodporované, lebo `features.v1` pre ne nemá samostatné merania.
- Diverzitný MMR mení poradie kandidátov, ktoré už v banku existujú. Bez nových generatívnych rodín nepridá odlišnú harmóniu, groove ani aranžmán.
- Audio reference dnes tvorí spoločné conditioning. Výber donor osí (napr. groove áno, harmónia nie) ešte nie je používateľsky riadený.
- Song composer/preview už existujú, ale compare workflow a preference context treba vedieť explicitne rozlíšiť medzi patternom, sekciou a celou skladbou.
- Aktívny ONNX ranker ani `favoriteGroups` v manifeste nedokazujú, že model predikuje osobný vkus. To dokáže až oddelený, held-out, používateľský blind benchmark.

### Stav roadmapy podľa kódu

| Oblasť                              | Stav dnes                                                                                                  | Čo ešte treba dokázať alebo dorobiť                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Brief contract a hard gates         | Základ implementovaný                                                                                      | Robustnejšie confidence, konflikty a oprava toho, čo parser pochopil.                                                            |
| Explicitné lokálne párové voľby     | V1 implementovaná                                                                                          | Overiť kvalitu a reprezentatívnosť feedbacku na held-out voľbách.                                                                |
| Personal re-ranking                 | V1 + reason-scoped adapters; globálne score provenance a lokálny held-out evaluátor implementované         | Reálne nové A/B dáta a dostatočná candidate-disjoint held-out vzorka; blind dôkaz prínosu; lepšia kontextová/rolová granularita. |
| Top-3 diverzita                     | Prvý MMR krok implementovaný                                                                               | Kandidátske rodiny musia byť rozdielne už pri generovaní.                                                                        |
| SAFE / PERSONAL / EXPERIMENTAL      | Soft-axis + experimental groove/evolving-hook; PERSONAL groove/repeating-hook s výstupným syncopation gate | Blind-test prínosu; melodická kontúra a aranžérske rodiny.                                                                       |
| Audio referencia s voľbou donor osí | Analýza/conditioning implementované                                                                        | Vypínateľné osi a test, že vypnutá os do conditioning vôbec nevstúpi.                                                            |
| Referenčný session graph            | Posledný generation/follow-up implementovaný                                                               | Vetvenie, návrat na ľubovoľný návrh a bezpečný, vysvetliteľný apply.                                                             |
| Song generation a audition          | Základ implementovaný                                                                                      | Sekčné/song-level párové hodnotenie a DNA kontext, nie iba patternové voľby.                                                     |

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

**Blind groove posluch (nástroj pripravený, ľudský výsledok zatiaľ chýba):** `npm run listening:producer-dna -- --genre=trap --seed=my-seed` vytvorí štyri SAFE/PERSONAL dvojice — dve s cieľom viac syncopovaný a dve rovnejší groove. Každý pattern prejde bežnými hard gates; PERSONAL kandidát navyše musí splniť meraný smer `drums.syncopation`. WAV-y sa renderujú cez `renderProject()` a pre posluch sa RMS-zrovnajú. Balík obsahuje anonymné `index.html`, `LISTENING.md` a `answer-key.json`; najprv treba zahlasovať v HTML a až potom otvoriť kľúč. Stiahnutý `verdicts.json` sa zosumarizuje príkazom `npm run listening:producer-dna -- --score <cesta-k-verdicts.json>`. Páry používajú syntetické feature preferencie — nečítajú ani nemenia osobný ledger a výsledok sa nikdy neimportuje do tréningu. Úspešný beh dokazuje iba, že nástroj a smerová metriku pipeline fungujú; bez reálneho posluchu nedokazuje, že človek preferuje PERSONAL kandidáta.

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

1. Pridať deterministickú search policy do async audition candidate banku; zapísať lane/policy verziu do kandidátskych metadát a verziu + soft hodnoty do seed-u. Nevytvárať projektovú schema migráciu.
2. Začať s malým, bezpečným soft-axis slice-om, potom rozšíriť na kontrolované rytmické, melodické a aranžérske kandidátske rodiny — nie iba iný random seed.
3. Kandidát najprv prejde invariant repair a `brief-gate`; až potom sa hodnotí.
4. Výber vykonať v poradí: hard constraints → zhoda s briefom → osobný ranker → minimálna rozmanitosť top výsledkov. Diverzitu počítať z normalizovaných hudobných features/content, nie UUID.
5. Zaviesť diversity-aware výber (napr. MMR alebo prah vzdialenosti), ale nikdy neobetovať brief compliance len kvôli novosti.
6. V UI ukázať krátky rozdiel: „B má prázdnejší lead a viac priestoru; bicie sú rovnaké.“ Netváriť sa, že ide o objektívny AI score.

**Pravdepodobné súbory:** `src/intent/plan.ts`, `src/intent/providers/local.ts`, `src/intent/candidate-bank.ts`, `src/ai/features/pattern-features.ts`, `src/ui/IntentPanel.tsx`.

**Hotovo, keď:** top návrhy sa hudobne odlišujú, každý spĺňa hard brief, ranking zostáva deterministický a používateľ dokáže jedným klikom vypočuť/apply presne zvolený kandidát.

**Stav implementácie (2026-09-26):** audition candidate bank má prvú end-to-end lane policy. Index 0 ostáva nedotknutý SAFE baseline; ďalšie indexy sa deterministicky striedajú SAFE / PERSONAL / EXPERIMENTAL. PERSONAL premieňa explicitné, kontextovo relevantné A/B učenie na malé, ohraničené nudges energie, hustoty, komplexity a variácie. Samostatný groove-syncopation signál vyberá rovnakého žánru groove template v preferovanom smere, potom lokálny generátor skúša deterministické varianty, kým finálny pattern po hard gates nedosiahne merateľný posun `drums.syncopation`; bez takého výsledku sa candidate nezobrazí ako úspešná PERSONAL groove voľba. Symbolic prior kandidát sa ponechá iba po rovnakej výstupnej kontrole. Explicitný style, chránené/nepoužívané bicie, slabý signál alebo chýbajúca platná alternatíva osobnú groove zmenu vypnú. Motif-repetition signál môže nezávisle vybrať repeating-hook rodinu pre generovaný lead. Bez použiteľného osobného signálu je lane jasne označený cold-start. EXPERIMENTAL používa malú pevnú sadu seedovaných nudges a — ak používateľ neurčil konkrétny groove a bicie sa generujú — vyberie inú pomenovanú groove rodinu z toho istého žánru; na vhodnom lead-e vytvorí `evolving-hook`: prvý takt použije ako kotvu a v striedavých odpovediach mení iba dĺžku/odstránenie posledného tónu. Používateľ vidí lane a `GROOVE`, `HOOK` alebo `HOOK VARIATION` označenie; tooltip vysvetľuje osobný groove aj kadenciu. MMR zachová prvého rankovaného víťaza a pred opakovaním lane-u sa pokúsi zastúpiť dostupné smery.

Každý lane používa nezmenený brief/role/key/length/constraint plan na hard gates a provenance. Soft plan slúži iba generátorovi; candidate seed nesie `search:v1` a konkrétne osové hodnoty pre deterministický replay. Jednoklikový non-audition flow si zatiaľ ponecháva legacy generáciu; policy sa aktivuje pri explicitnom async audition banku. Kandidáti ostávajú v jednej shared banke a nededuplikujú sa podľa lane — identický hudobný obsah nie je umelo udržiavaný ako „odlišná“ voľba.

Toto je **prvý generatívny search slice, nie hotový Producer/SUNO engine**. EXPERIMENTAL vie vytvoriť odlišnú rytmickú rodinu cez iný groove rovnakého žánru a pri generovanom lead-e vytvorí opakujúci sa motív s obmenenou dĺžkou kadencie v striedavých taktoch. PERSONAL vyberá počiatočný groove podľa priemeru template patterns, ale teraz kontroluje aj reálne `drums.syncopation` finálneho patternu oproti SAFE; pri lokálnom providerovi deterministicky skúsi najviac 16 seedov a pri neúspechu kandidatúru zruší. Tento feature gate nepreukazuje, že človek počuje alebo preferuje rozdiel — blind listening je stále otvorený. PERSONAL tiež vyberie repeating-hook iba pri explicitnom, dostatočne silnom signále preferencie opakovania; pri signále pre novosť ho nevnúti. Ešte chýbajú samostatné rodiny pre zmenu pitch contouru, call-and-response, harmóniu a aranžérske/section kontrasty. Štyri všeobecné soft osi ostávajú coarse proxy a MMR môže zastúpiť iba kandidátov, ktorých generátory skutočne vytvorili a hard gates prepustili. Ďalší krok: zaslepený posluch groove/hook, zmerať počuteľnosť cadential variation a doplniť kontrolované melodické/section kontrasty.

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

**Implementovaný prvý koherentný song-search slice (2026-09-26):** pri multi-candidate compose sa z candidate banku zostaví alternatíva len vtedy, keď rovnaký search lane prešiel všetkými sekciami. Každá úplná alternatíva dostane tie isté transition treatments; obsahovo duplicitné alebo neúplné celé skladby sa skryjú. `composeFullTrack()` prenesie hummovaný hook do predvoleného songu aj do všetkých lane alternatív a po tom znovu odstráni alternatívy, ktoré sa tým stali identické. `IntentPanel` dovolí vybrať `SAFE` / `PERSONAL` / `EXPERIMENTAL` celú formu alebo predvolený výber po sekciách, vyrenderuje zvolenú formu cez song audition a pre zvolený lane drží `USE SONG` vypnuté až do úspešného renderu. `useSongDraft()` aplikuje presne ten `SongBuild`, ktorý sa previewoval. Targeted song/voice/UI testy pokrývajú úplnosť lane, zachovanie hum hooku, render gate a identitu preview→apply.

**Čo tento slice ešte netvrdí:** default stále vyberá najlepšie sekcie nezávisle; full-song lane nie je song-level ONNX/DNA ranking. Nie je dokázané, že používateľ subjektívne preferuje PERSONAL alebo EXPERIMENTAL, ani že tieto smery vyhrávajú blind porovnanie celej skladby. Song-level features, celoskladbové pairwise učenie a blind user evaluation ostávajú otvorené.

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

## 10. Ďalšie produktové inovácie — čo môže KYX odlíšiť

Predchádzajúce fázy definujú základ Producer DNA. Nasledujúce nápady sú ďalšia vrstva produktu: nie nové veľké modely, ale producentovské interakcie, ktoré premieňajú existujúci parser, search, preview a command systém na súdržný tvorivý workflow. Stav pri každom bode je úmyselne rozlíšený od vízie.

### 10.1 Intent Debugger — používateľ vidí a opraví, čo KYX pochopil

**Moment:** používateľ napíše „sprav to viac west coast, ale nechaj moje bicie“ a pred generovaním uvidí krátku kartu:

```text
ZACHOVAŤ       bicie
PREFERENCIA    West Coast bounce, melodický hook
POŽIADAVKA     približne 92 BPM
PREDPOKLAD     tónina ostane podľa projektu
NEISTÉ         „viac bounce“ — groove alebo swing?
```

Kliknutím na riadok používateľ zmení jeho význam alebo ho odstráni; nemusí celý prompt formulovať nanovo. Ak nejasnosť nemôže zmeniť výsledok podstatne, KYX ju označí ako vratný predpoklad a pokračuje. Ak môže spôsobiť porušenie požiadavky alebo zmeniť hudobný cieľ, položí jednu konkrétnu otázku.

**Základ:** `brief-contract.ts`, `text-parser.ts`, `brief-gate.ts`, `IntentPanel.tsx`.

**Nová práca:** ku každej položke kontraktu pridať bezpečný pôvod (`prompt`, `session`, `project`, `default`), stav istoty a opravu používateľa; zobraziť konflikty ako „zachovať harmóniu“ verzus „zmeniť tóninu“. Tieto údaje sú vysvetlením plánu, nie oprávnením modelu oslabiť hard gate.

**Prečo je to inovatívne:** prompt-to-audio systémy často skrývajú interpretáciu. KYX môže urobiť zadanie editovateľným objektom ešte predtým, než sa minie čas na generovanie alebo sa zmení projekt.

**Hotovo, keď:** verziovaná SK/EN brief sada prejde extrakčnými testami; konflikt ani neistý odhad sa nikdy potichu nezmení na tvrdý fakt; používateľ vie opraviť každú zobrazenú položku a následný výsledok zodpovedá opravenému kontraktu.

### 10.2 Counterfactual Producer — „zmeň iba túto jednu vec“

**Moment:** po vypočutí B používateľ nežiada nový beat. Povie „B, ale hook nech má viac priestoru; bicie, 808 a sloha nechaj“. KYX ukáže pred/po rozdiel a pred prehratím oznámi rozsah:

```text
ZMENÍ SA       lead v hooku — menej tónov, dlhšie dozvuky
ZOSTANE ROVNAKÉ bicie, 808, harmónia a verse
ZÁKLAD          kandidát B, hash 8f…
```

Vytvorí sa potomok konkrétneho kandidáta, nie nové generovanie od prázdneho promptu. „Viac priestoru“ je najprv používateľsky zrozumiteľná požiadavka; až potom sa preloží na podporované feature osi, napríklad hustotu, dĺžku tónov alebo pauzy. Ak engine nevie tento význam bezpečne realizovať, musí ponúknuť užšiu voľbu alebo priznať, že návrh sa nedá spoľahlivo zostaviť.

**Základ:** `iteration.ts` už rozlišuje referenciu na posledného kandidáta, patch intent, cielené roly a `preserve`; `session-context.ts` drží poslednú generation session; `commands.ts` poskytuje undoable apply. Tieto moduly nie sú ešte plnohodnotný graf ľubovoľných, trvalo dostupných vetiev.

**Nová práca:** proposal má niesť parent content hash, zoznam target roly/sekcie, zoznam zachovaných oblastí a ich UUID-free hash-e. Pred audition aj apply sa overí, že projekt stále zodpovedá rodičovi a že zamknutý obsah zostal totožný. Porovnanie „pred“ musí používať presný parent, nie momentálny náhodne aktívny pattern.

**Hotovo, keď:** cielená revízia zmení iba deklarovaný rozsah; chránené hash-e sú identické; auditionovaný proposal a aplikovaný proposal majú zhodný content hash; stale proposal sa odmietne; prijatie je jeden undoable command.

### 10.3 Edit-to-Learn — vkus sa učí z práce producenta, nie z hádania

**Moment:** používateľ vyberie generovaný hook a ručne vymaže každú druhú notu. KYX si z toho nič potichu nevyvodí. Až po dokončení editácie môže ponúknuť nenápadné potvrdenie: „Chceš si zapamätať, že v tomto type hooku preferuješ viac priestoru?“

**Návrh mechaniky:**

1. Porovnať východiskový a upravený obsah cez verzované hudobné features, nie cez audio nahrávku ani celý project JSON.
2. Určiť rozsah zmeny — napríklad lead v hooku — a navrhnúť nanajvýš jeden vysvetliteľný dôvod.
3. Zobraziť konkrétny pár „pred / po“ a kontext, ktorý sa uloží: žáner/profil, rola a task (`pattern`, `section`, `song`).
4. Do preference ledgeru zapísať iba po výslovnom potvrdení. „Undo“, náhodné kliknutie alebo technická oprava projektu nie sú feedback.
5. Ponúknuť spätné odvolanie posledného naučeného príkladu spolu s existujúcimi `pause`, `export` a `clear` nástrojmi.

**Základ:** `preference-ledger.ts`, `preference-ledger-core.ts`, `personal-ranker.ts`, `commands.ts`. Ledger už vie niesť explicitné porovnania; bezpečný derivátor hudobných rozdielov z ľubovoľných ručných úprav je samostatná práca.

**Ochrana pred zlým učením:** nepoužiť všeobecný „edit = dislike“ signál. Zmena mohla byť oprava chyby, mix rozhodnutie, kompenzácia iného nástroja alebo len jednorazový experiment. Kým používateľ nepotvrdí význam, nič sa nenaučí.

**Hotovo, keď:** bez opt-inu sa ledger nezmení; po potvrdení sa uloží len podporovaný feature snapshot a kontext; osobný ranker sa zmení len v príslušnom kontexte; zrušenie príkladu vráti osobné správanie na stav pred ním.

### 10.4 Taste Probe — jedna užitočná A/B otázka namiesto dotazníka

**Moment:** keď KYX nevie, či používateľ pri melodickom trappe chce opakujúci sa hypnotický hook alebo meniacu sa frázu, nemusí sa pýtať na „celkový štýl“. Vytvorí jeden platný, brief-compliant pár, ktorý sa líši práve v tejto osi. Používateľ ho vypočuje a voliteľne povie, čo rozhodlo.

**Pravidlá výberu otázky:**

- Použiť uncertainty/rozptyl existujúcich lokálnych preference modelov iba vtedy, keď obidve alternatívy prejdú rovnakým brief gate.
- Pár musí reprezentovať jednu vysvetliteľnú os. Ak sa súčasne mení groove, harmónia aj hustota, odpoveď nie je diagnostická.
- Pýtať sa iba pri prirodzenej compare session a s obmedzenou frekvenciou; tvorba sa nesmie zmeniť na onboardingový test.
- `ani jeden` znamená problém s párom/briefom, nie hlas pre jednu stranu. Pri takej odpovedi zmeniť generatívnu rodinu, nie učiť nesprávny smer.
- Používateľ môže otázku preskočiť. Personalizácia pri nedostatku dát ostáva cold-start.

**Základ:** `personal-ranker.ts` a `preference-ledger-core.ts` pracujú s explicitnými párovými voľbami; `candidate-search.ts` vytvára lane varianty. Chýba rozhodovač, ktorý cielene zvolí informatívnu dvojicu a preukáže, že sa odlišuje iba v jednej osi.

**Hotovo, keď:** vybraná os je v kandidátoch merateľne odlišná, ostatné zamýšľané vlastnosti ostanú v tolerancii; otázka sa objaví len pri relevantnej neistote; odpoveď zlepší predikciu na neskorších, nepoužitých pároch oproti tomu istému modelu bez Taste Probe.

### 10.5 Project DNA — referenciou je aj vlastná rozpracovaná skladba

**Moment:** používateľ povie „urob hook, ktorý sedí k tomuto beatu“. KYX môže ako lokálny kontext využiť vybrané časti aktuálneho projektu: tempo, tóninu, groove, ktoré role už existujú a aký register/hustota v nich zaberajú. Nemá automaticky považovať všetko v projekte za želanie; používateľ zvolí, čo sa má zachovať a čo môže byť donor.

**Rozlíšenie donorov:**

```text
PROJEKTOVÁ KOTVA   tempo, tónina, zamknuté stopy
VZOR NA BOUNCE     časovanie/groove z vybranej stopy
VZOR NA TEXTÚRU   spektrálne črty vybraného audia
NEPRENÁŠAŤ         harmónia alebo forma, ktorú používateľ označil „nebrať“
```

**Základ:** `plan.ts`, `session-context.ts`, `audio-reference.ts`, `reference-embedding.ts`, `semantic-conditioning.ts`, `style-vector.ts` a `favorites.ts`. Audio referencia dnes môže podmieňovať generovanie; granularita donor masiek a projektový snapshot s nulovým vplyvom vypnutých osí zostáva samostatným cieľom. Projektové tracky alebo user samples sa nesmú automaticky uložiť do dlhodobej DNA.

**Hotovo, keď:** každý conditioning zdroj má viditeľný pôvod; zamknuté projektové vlastnosti zostanú nedotknuté; vypnutý donor nemá vplyv na zodpovedajúcu cestu; snapshot projektu je session-only a neobsahuje audio dáta.

### 10.6 Song Dramaturgy — hodnotiť oblúk, nie iba najlepší loop

**Moment:** KYX nepovie iba „hook je silný“. Ukáže: „hook sa od slohy líši iba hlasitosťou; navrhujem pridať širší lead alebo zmeniť rytmickú hustotu“ a prehrá pred/po v kontexte celej skladby.

**Vývoj:** z existujúcich section/song objektov vytvoriť časové črty energie, hustoty, návratu motívu, kontrastu a prechodov. Najprv deterministické pravidlá a merateľné diagnostiky; neskôr, až keď sú k dispozícii ľudské song-level porovnania, učiť osobnú preferenciu celých oblúkov. Pattern A/B a song A/B sa nesmú miešať do jedného tréningového kontextu.

**Základ:** `compose.ts`, `song.ts`, `song-audio-review.ts`, `audition.ts` a offline `renderProject()` už podporujú vytvorenie a vypočutie skladby. `reviewSongAudio()` kontroluje technické vlastnosti renderu; nie je to umelecký song-quality model.

**Hotovo, keď:** revízia iba jednej sekcie nemení ostatné section hash-e; preview počuje skutočné susedné sekcie aj prechody; používateľ vie A/B celú skladbu; blind hodnotenie ukáže prínos oproti baseline bez porušenia briefu.

### 10.7 MRT2 ako hosťujúci hudobník, nie náhrada intent enginu

MRT2 môže byť neskôr voliteľný performer pre akordický pad, odpoveď na vokálny motív alebo textúru. Intent Engine mu dodá jasne ohraničené podmienky a zodpovednosť; neurčuje celý výsledok z promptu a nemení projekt sám.

```text
Intent contract + vybraná sekcia + povolené conditioning zdroje
                        ↓
             MRT2 proposal / performer
                        ↓
          bezpečné renderovanie a audition
                        ↓
       používateľ vyberie → capture/freeze → editácia
```

**Hranice:** MRT2 adapter patrí do `src/generative/`; intent nesmie predstierať, že `Energy`/`Density` sú natívne MRT2 parametre, ak sú to KYX makrá. Každé mapovanie makra musí byť pomenované, verzované a testované. Ak model/host nie je dostupný, intent generovanie a editovanie funguje ďalej. Generovaný výsledok sa pred použitím počuje a jeho capture sa stáva obyčajným KYX editovateľným materiálom.

**Prečo až neskôr:** najprv potrebujeme spoľahlivý intent, selektívny donor kontext, bezpečný audition/apply a jasné meranie. Pripojiť ďalší generatívny model skôr by zväčšilo počet pohyblivých častí bez dôkazu, že používateľ dostáva lepšiu kontrolu.

## 11. Konkrétny cieľový workflow a poradie realizácie

### Čo má používateľ zažiť

1. **Napíše ľudský brief.** „Sprav 92 BPM west coast beat, temný, ale hook nech je svetlý; moje bicie a 808 nemen.“
2. **Skontroluje krátky kontrakt.** KYX rozdelí požiadavky, preferencie, zákazy, zachované časti a neistoty. Opravy kontraktu nemusia meniť pôvodný text.
3. **Dostane tri odlišné, férové smery.** SAFE, PERSONAL a EXPERIMENTAL používajú rovnaké hard constraints. UI vysvetlí, ak je PERSONAL cold-start alebo lane nebolo možné vytvoriť.
4. **Porovná ich v kontexte.** A/B/X prehratie je hlasitosťou vyrovnané; pri kandidáte vidí krátky, faktický rozdiel. Pri patterni môže počuť izolovaný ghost aj celý projektový kontext.
5. **Zvolí a spresní.** „B, ale hook s väčším priestorom.“ Návrh je potomok B a mení deklarovaný target; A ostáva dostupný.
6. **Rozhodne, či sa to zapamätá.** A/B dôvod alebo explicitné „zapamätaj si“ vytvorí lokálny tréningový príklad. Základné použitie bez personalizácie ostáva plnohodnotné.
7. **Rozšíri nápad na skladbu.** Verse/hook/build/drop majú odlišnú dramaturgickú rolu; KYX ponúka konkrétne sekčné alternatívy a používateľ si vypočuje celú formu.
8. **Zachytí, upraví, exportuje.** Modelový alebo symbolický výstup sa stane bežným editovateľným obsahom; finálny projekt sa mení len potvrdeným commandom.

### Priorita a rozhodovacie brány

| Priorita | Dodávka                                                                                           | Prečo teraz                                                           | Brána pred posunom                                                                             |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **P0**   | Zosúladiť pravdivý baseline; uzavrieť blind groove posluch; prejsť brief → compare → presný apply | Bez toho nevieme, či ranking a nové lane pomáhajú                     | Ľudské páry sú blind a oddelené od heuristického teacher signálu; výsledky sú reprodukovateľné |
| **P1**   | Intent Debugger + kontraktové opravy + explicitné dôvody A/B                                      | Zlepšuje splnenie požiadaviek bez ďalšieho modelu                     | Golden brief compliance a nulové hard-gate obídenia                                            |
| **P1**   | Counterfactual revízia s preserve hashmi a compare pred/po                                        | Mení generovanie na kontrolovaný producentský workflow                | Chránené hash-e a audition/apply hash sa zhodujú                                               |
| **P2**   | Generatívne rodiny pre hook/motif, groove a aranžérsky kontrast; Taste Probe                      | Osobné učenie nemá zmysel bez alternatív, ktoré vkus vedia realizovať | Blind preference plus minimálna, počuteľná odlišnosť bez zhoršenia briefu                      |
| **P2**   | Project DNA/donor masks + Edit-to-Learn po potvrdení                                              | Využije projekt a ručné rozhodnutia pri zachovaní súkromia            | Vypnuté zdroje nemajú vplyv; bez potvrdenia sa nič neučí                                       |
| **P3**   | Song Dramaturgy a osobné whole-song preference                                                    | Je to najbližšie k osobnému „Suno, ale s kontrolou“                   | Celoskladbové blind porovnanie a správne sekčné preserve                                       |
| **P3**   | MRT2 guest performer v intent workflow                                                            | Rozšíri paletu po tom, čo sú porovnávanie a zachytenie spoľahlivé     | Optional model/host, funkčný fallback, presné capture/apply a lokálny performance budget       |

Toto poradie je zámerne **data-first, nie model-first**. Najprv treba potvrdiť, že kandidáti sú počuteľne odlišní a že používatelia vedia spoľahlivo pomenovať, ktorý lepšie plní zadanie a ktorý si chcú nechať. Až potom treba rozhodovať, či je limitom ranker, generatívna rodina, parser alebo mix.

### Čo nepovažovať za inováciu samo osebe

- Viac candidate seeds bez odlišných generatívnych rodín.
- Ďalší ONNX model trénovaný na vlastných heuristikách bez ľudského held-out dôkazu.
- Jedno percentuálne „AI quality“ skóre bez vysvetliteľných dôkazov.
- Učenie zo všetkých klikov/editácií bez opt-inu a bez určenia kontextu.
- Tiché preberanie všetkých vlastností z referenčného tracku alebo audia.
- Celá skladba v jednom nepriehľadnom audio súbore bez možnosti vypočuť, upraviť a ponechať jednotlivé časti.
- Povinný cloud účet alebo veľký model na to, aby základný text-to-beat workflow fungoval.

### Definition of success pre „naše osobné SUNO“

KYX môže používať toto označenie až vtedy, keď používateľ v reprezentatívnom slepom teste opakovane dostáva výsledky, ktoré lepšie plnia jeho brief aj jeho výslovne vyjadrený vkus než súčasný baseline; vie povedať, čo sa zmení; dokáže zachovať a zamknúť podstatné časti; a môže presne vypočutý výsledok aplikovať alebo odmietnuť. Model-size, počet features ani samotný fakt, že ONNX inference funguje, nie sú dôkazom tohto úspechu.
