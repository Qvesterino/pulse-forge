# KYX Intent Engine — inovácie pre osobného AI producenta

**Stav:** návrh produktu a priorít, 2026-09-26  
**Rozsah:** používateľský workflow Intent Engine; nie tvrdenie, že všetky nižšie uvedené schopnosti už fungujú.  
**Primárny cieľ:** zmeniť KYX z „napíš prompt a dostaneš beat“ na lokálneho producenta, ktorý pochopí zámer, navrhne počuteľné možnosti, vie bezpečne meniť iba určené časti a učí sa iba z výslovného feedbacku.

Tento dokument dopĺňa, nenahrádza:

- [`INTENT_ENGINE.md`](../INTENT_ENGINE.md) — živú mapu implementácie Intent Engine;
- [`PRODUCER-DNA-ROADMAP.md`](PRODUCER-DNA-ROADMAP.md) — detailný technický plán párovej pamäte, kreatívnych search lanes, donorov, edit graphu a song-level DNA;
- [`IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`](IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md) — širší end-to-end plán producentovského workflowu a runtime;
- [`IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`](IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md) — samostatný plán MRT2 generatívnych stôp.

## 1. Produktový posun

Bežný prompt-to-music workflow optimalizuje otázku: **„Čo vie model vygenerovať z tohto textu?“** KYX má optimalizovať otázku: **„Aký bezpečný, počuteľný a upraviteľný krok najviac priblíži tento projekt tomu, čo producent chce?“**

```text
Povedz zámer
    ↓
Skontroluj, čo KYX pochopil
    ↓
Vypočuj si niekoľko odlišných, férových návrhov
    ↓
Vyber jeden alebo povedz, čo presne zmeniť
    ↓
Porovnaj iba deklarovaný rozdiel
    ↓
Potvrď → jeden undoable command → normálne editovateľné dáta
    ↓
Voliteľne: zapamätaj si túto voľbu lokálne
```

Inováciou nie je iba vyššia generatívna kvalita. Je ňou **kontrolovateľná spolupráca**: používateľ vie, čo sa zmení, čo zostane nedotknuté, prečo KYX niečo navrhuje a čo sa uloží do jeho vkusu.

## 2. Čo už reálny kód poskytuje

Nasledujúce moduly sú základ, na ktorý majú inovácie nadväzovať. Ich existencia sama osebe ešte nedokazuje kvalitu výslednej hudby.

| Schopnosť                             | Kód dnes                                                                               | Hranica, ktorú treba rešpektovať                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Text → štruktúrovaný zámer            | `src/intent/text-parser.ts`, `normalize.ts`, `brief-contract.ts`                       | Parser má podporované slovníky a vzory; nie je to všeobecné porozumenie každému promptu. Neistota musí zostať viditeľná.                        |
| Plán generovania a reprodukovateľnosť | `src/intent/plan.ts`, `hash.ts`, `src/intent/providers/local.ts`                       | Seed a plán vysvetľujú cestu k výstupu; neurčujú, či sa používateľovi výsledok páči.                                                            |
| Validácia briefu pred výberom         | `src/intent/brief-gate.ts`, candidate evaluation v `providers/local.ts`                | Hard gate vie zamietnuť overiteľné porušenia, nie automaticky posúdiť umeleckú vhodnosť.                                                        |
| Kandidáti, ranking a audition         | `src/intent/pipeline.ts`, `candidate-bank.ts`, `audition.ts`, `src/ui/IntentPanel.tsx` | Ranker vyberá len z vytvorených kandidátov. Ak generátor nevytvorí odlišné hudobné rodiny, viac seedov problém nevyrieši.                       |
| SAFE / PERSONAL / EXPERIMENTAL search | `src/intent/candidate-search.ts`, `personal-ranker.ts`, `candidate-diversity.ts`       | Lanes sú policy nad lokálnym generovaním, nie tri nezávislé foundation modely; ľudský blind test je potrebný na potvrdenie počuteľného prínosu. |
| Lokálny explicitný feedback           | `preference-ledger.ts`, `preference-ledger-core.ts`, `ProducerDnaCompare.tsx`          | Ukladá párové rozhodnutia a hrubý kontext; automatické učenie z každej úpravy by bolo nesprávne.                                                |
| Nadväzujúca revízia a session         | `iteration.ts`, `session-context.ts`, `producer-session.ts`                            | Základ je použiteľný, no nie je to ešte všeobecný, ľubovoľne vetvený a dlhodobo spravovaný edit graph.                                          |
| Audio referencia                      | `audio-reference.ts`, `reference-embedding.ts`, `semantic-conditioning.ts`             | Analýza/conditioning neznamenajú, že každá os referencie je samostatne voliteľným donorom.                                                      |
| Skladba a technický audio review      | `compose.ts`, `song.ts`, `song-audio-review.ts`, `rendering/renderer.ts`               | Technické meranie renderu nie je umelecké hodnotenie dramaturgie; song-level preferencia musí mať vlastný kontext a test.                       |
| MRT2 generative runtime               | `src/generative/`                                                                      | MRT2 má byť voliteľný performer a návrh na audition/freeze, nie povinná závislosť textového intentu ani autor projektu.                         |

## 3. Deväť produktových inovácií

### 3.1 Intent Debugger: prompt sa zmení na opraviteľný produkčný kontrakt

Po zadaní „92 BPM west coast beat, temný, ale svetlý hook; nechaj moje bicie a 808“ nemá KYX okamžite potichu generovať. Má stručne ukázať:

```text
POVINNÉ       92 BPM
PREFERENCIA   West Coast bounce; tmavší verse; svetlejší hook
ZACHOVAŤ      drums, 808
PREDPOKLAD    tónina ostáva podľa projektu
NEISTÉ        „bounce“ môže znamenať swing alebo synkopáciu
```

Používateľ opraví jednu položku kliknutím. KYX sa opýta iba vtedy, ak neistota môže podstatne zmeniť výsledok alebo porušiť požiadavku. Inak označí bezpečný, vratný predpoklad a pokračuje.

**Rozšírenie oproti základu:** kompilovať prompt, session a projektový kontext do kontraktu, kde má každé tvrdenie `origin`, `confidence`, typ (`hard`, `preference`, `prohibition`, `preserve`, `unknown`) a prípadný používateľom opravený stav. Rozpor, napr. „nechaj harmóniu“ a „zmeň tóninu“, musí byť explicitný konflikt — nie tichá voľba parsera.

**Kód:** rozšíriť `brief-contract.ts`, `text-parser.ts`, `normalize.ts` a existujúce summary UI v `IntentPanel.tsx`. Ak kontrakt ostáva transientný, netreba meniť project schema.

**Dôkaz:** verziované SK/EN fixtures overia extrakciu, neistotu, konflikt aj aplikovanie používateľovej opravy. Žiadna nízkoistá interpretácia sa nesmie vykazovať ako potvrdený fakt.

### 3.2 Creative Search: tri hudobné smery, nie tri náhodné seedy

SAFE, PERSONAL a EXPERIMENTAL majú používateľovi ponúknuť odlišné rozhodnutia:

| Smer             | Úloha                                                | Čo smie meniť                                                                  |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| **SAFE**         | Najspoľahlivejšie splniť brief                       | Malé odchýlky; zachovať známe groove/formy                                     |
| **PERSONAL**     | Uprednostniť explicitne naučený vkus                 | Iba relevantné, dostatočne podložené preferencie; cold-start musí byť označený |
| **EXPERIMENTAL** | Ponúknuť odvážnejší, ale stále brief-compliant nápad | Vybrané kreatívne osi; nikdy hard constraints ani zamknuté dáta                |

Rozšíriť kandidátske **rodiny** podľa hudobného účinku, nie podľa samotného seedu:

- groove: rovný/swing, hustejšie/riedkejšie, syncopation, kick placement;
- hook: opakujúci sa motív, jeho variácia, call-and-response, iný contour;
- harmónia: stabilita, napätie, register a voicing pri zachovaní tóniny/progresie;
- aranžmán: vstupy/odchody rolí, fill pred prechodom, kontrast verse/hook;
- produkcia: priestor, transient/punch, šírka a dozvuk, ak existujú bezpečné KYX mapovania.

Každý návrh nesie čitateľný rozdiel, napr. „rovnaké akordy; hook má kratší motív a viac pauz“. Ranker zoradí kandidátov až po hard gates; technické audio features sú dôkazné signály, nie univerzálny umelecký verdikt.

**Kód:** `candidate-search.ts`, `providers/local.ts`, `candidate-bank.ts`, `candidate-diversity.ts`, príslušné generátory v `src/ai/`, UI audition v `IntentPanel.tsx`.

**Dôkaz:** kandidáti prejdú rovnakými brief gates; obsahové hash-e potvrdia diverzitu; blind review zvlášť meria „ktorý lepšie plní brief?“ a „ktorý by som si nechal?“.

### 3.3 Counterfactual Producer: „zmeň iba túto jednu vec“

Používateľ vyberie kandidáta B a povie: „hook nech má viac priestoru; bicie, basu a slohu nechaj.“ KYX vytvorí potomka B a pred audition zobrazí rozsah:

```text
ZMENÍ SA        lead v hooku — menej tónov / viac pauz
ZOSTANE ROVNAKÉ drums, bass a verse
VYCHÁDZA Z      kandidát B · content hash 8f…
```

Rozsah nie je iba popis. Proposal musí obsahovať parent hash, targety, preserve targety a ich obsahové hash-e. Pred audition aj Apply sa overí, že rodič a chránený obsah sa nezmenili. Neplatný alebo zastaraný návrh sa odmietne; schválenie je jeden undoable command.

**Kód:** prehĺbiť `iteration.ts`, `session-context.ts`, `commands/` a existing `resultForCandidate`/preview/apply cestu. Session graph môže najprv žiť iba v pamäti; persistentný DAG si zaslúži samostatný návrh až po stabilnom compare/apply.

**Dôkaz:** test porovná UUID-free hash všetkých chránených častí pred/po; auditionovaný hash sa rovná aplikovanému; stale parent sa nikdy neaplikuje.

### 3.4 Producer DNA: kontextový vkus, nie jedno globálne „štýlové číslo“

Producent nemusí mať jednu univerzálnu preferenciu. Môže chcieť husté bicie v drop-e, ale prázdnu slohu; opakujúci sa hook v jednom žánri a meniacu sa frázu v inom. Vkus preto treba oddeľovať aspoň podľa:

- tasku: `pattern`, `section`, `song`;
- role: drums, bass, chords, lead;
- hrubého kontextu: žáner a produkčný profil;
- výslovného dôvodu: groove, melody, space, energy, novelty a ďalšie podporované osi.

Feedback má minimálne štyri významy: **A**, **B**, **ani jeden**, **obidva**. „Ani jeden“ nie je hlas pre opačnú stranu; môže znamenať, že celý pár minul zadanie. „Obidva“ je pozitívny signál bez preferencie medzi nimi.

**Pravidlo učenia:** implicitná editácia sama osebe nie je negatívny príklad. Po úprave môže KYX ponúknuť jedinú opt-in otázku „Chceš si v tomto kontexte zapamätať viac priestoru v hooku?“; bez potvrdenia sa ledger nemení.

**Kód:** nadviazať na `preference-ledger-core.ts`, `personal-ranker.ts`, `candidate-search.ts` a `style-vector.ts`. Nespojiť pattern/song dáta do jedného tréningového cieľa.

**Dôkaz:** held-out porovnanie podľa používateľa a kontextu; personal ranker sa smie aktivovať iba ak predikuje neskoršie voľby lepšie než globálny ranker a baseline. Ledger má zostať lokálny, exportovateľný, pauznuteľný a vymazateľný.

### 3.5 Taste Probe: jedna informatívna A/B otázka namiesto dotazníka

Ak si KYX nie je istý, či producent chce opakujúci sa hypnotický hook alebo meniacu sa frázu, môže pripraviť pár, ktorý sa líši práve touto osou. Nie päť otázok pri každom otvorení aplikácie, ale jedna otázka v prirodzenom compare momente.

Vyberie sa os s veľkou neistotou a hodnotou pre aktuálnu úlohu; oba návrhy musia prejsť tým istým brief gate. UI pomenuje rozdiel a nechá možnosť preskočiť. Frekvencia je obmedzená. Odpoveď „ani jeden“ vyvolá nový search smer, nie zlé učenie proti jednému kandidátovi.

**Kód:** nový malý policy nad `preference-ledger-core.ts` a `candidate-search.ts`, bez nového ONNX modelu v prvom kroku.

**Dôkaz:** otázka musí byť diagnostická — kontrolovaná os je merateľne odlišná, ostatné zamýšľané osi ostanú v tolerancii — a odpoveď zlepší výber na neskorších nepoužitých pároch.

### 3.6 Project DNA a selektívne donor osi

Projekt, audio referencia aj vybraný track môžu byť donorom, no nie každá ich vlastnosť je automaticky pokyn. Používateľ má vedieť samostatne zvoliť:

```text
POUŽIŤ ako kotvu   tempo, tóninu, zamknuté party
POUŽIŤ ako donor   groove z označených bicích
POUŽIŤ ako donor   textúru zo 4-taktového audia
NEPRENÁŠAŤ         harmóniu / aranžmán / melodický motív
```

Každý conditioning vstup nesie zdroj, confidence, povolené osi a epochu. Vypnutý donor sa nesmie dostať do relevantného conditioning path. Snapshot projektu je dočasný a obsahuje len potrebné features; osobný ledger si nesmie potichu ukladať surové audio ani celý projekt.

**Kód:** `audio-reference.ts`, `reference-embedding.ts`, `semantic-conditioning.ts`, `plan.ts`, `style-vector.ts`.

**Dôkaz:** test „toggle-off“ pre každú donor os preukáže nulový vplyv; zapnutý donor zmení iba určenú os v rozsahu testu.

### 3.7 Song Dramaturgy: vybrať oblúk, nie iba najlepší loop

Celá skladba potrebuje vlastné rozhodnutia. „Hook je dobrý“ neznamená, že skladba funguje. KYX má merať a vysvetľovať napríklad:

- kontrast energie a hustoty medzi verse, build a hook;
- návrat alebo vývoj motívu;
- či prechody pripravujú ďalšiu sekciu;
- či sa hlavná idea objaví dosť skoro a či aranžmán nepôsobí monotónne;
- technické problémy audia samostatne od dramaturgickej diagnózy.

Najprv nech sú to transparentné diagnostiky a konkrétne návrhy na jednu sekciu, ktoré sa vypočujú v susednom kontexte. Neskôr možno trénovať song-level personal selector z osobitných song A/B volieb. Patternové víťazstvo sa nesmie automaticky považovať za víťaznú skladbu.

**Kód:** `compose.ts`, `song.ts`, `song-audio-review.ts`, audition v `IntentPanel.tsx`, spoločný offline `renderProject()`.

**Dôkaz:** whole-song blind test samostatne od pattern testu; pri revízii jednej sekcie ostanú ostatné section hash-e rovnaké a používateľ počuje celý relevantný prechod.

### 3.8 Producer modes: používateľ riadi mieru autonómie

Jeden engine môže obslúžiť rôzne tvorivé režimy bez predstierania, že každý chce to isté:

1. **Nápad:** rýchlo vygenerovať kandidátov, nič automaticky necommitovať.
2. **Surgical edit:** zmeniť iba vybrané roly/sekcie, ostatné zamknúť.
3. **Co-producer:** vysvetliť najväčší problém a ponúknuť 1–3 konkrétne opravy.
4. **Full arrangement:** navrhnúť celú formu, ale ponechať section-level audition/apply.
5. **MRT2 performer:** nechať voliteľný model zahrať ohraničenú časť a výsledok po audition zmraziť do editovateľného klipu.

Autonómia sa nemení podľa toho, koľko modelov je nainštalovaných; je zvolená používateľom a každý zásah ostáva viditeľný, vratný a projektovo bezpečný.

### 3.9 Proposal receipt: každý návrh nesie krátky „doklad“, nie AI skóre

Pri každom proposal zobrazovať iba overiteľné veci:

- ktoré explicitné požiadavky prešli / neprešli / nebolo ich možné zmerať;
- čo sa mení a čo je chránené;
- z ktorého kandidáta/sekcie/projektovej verzie proposal vychádza;
- aké opravy alebo fallbacky nastali;
- či bol výber rankera, personal rankera alebo deterministic fallback;
- technické audio upozornenia, ak boli zistené.

Nevyrábať jedno „AI quality 93 %“ číslo z neporovnateľných metrík. Posudok má umožniť informované rozhodnutie; nemá sa tváriť ako záruka umeleckého úspechu.

## 4. Odporúčané poradie dodania

| Poradie | Vertikálny výsledok                                        | Hlavné moduly                                                                     | Brána na pokračovanie                                                                                                 |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **0**   | Pravdivý baseline a blind listening pre pattern aj skladbu | tests, `scripts/`, `listening/`, ranker/model manifests                           | Známe, čo je testované synteticky a čo počul človek; žiadne nesúladné tvrdenie o modeloch                             |
| **1**   | Brief Debugger: opraviteľný kontrakt pred tvorbou          | `brief-contract.ts`, `text-parser.ts`, `IntentPanel.tsx`                          | Golden SK/EN briefy; konflikty a neistota viditeľné; hard constraints 100 % v test suite                              |
| **2**   | Zmysluplné SAFE/PERSONAL/EXPERIMENTAL shortlisty           | `candidate-search.ts`, `providers/local.ts`, generátory, `candidate-diversity.ts` | Kandidáti sú brief-compliant a počuteľne odlišní v blind review; lane label zodpovedá skutočnej politike              |
| **3**   | Counterfactual edit z vybraného kandidáta                  | `iteration.ts`, `session-context.ts`, commands, compare UI                        | Nedotknuté hash-e identické; preview = apply; stale návrh blokovaný; undo vráti presný stav                           |
| **4**   | Kontextový Producer DNA a informatívny Taste Probe         | preference ledger, personal ranker, candidate search                              | Held-out ľudské voľby prekonajú globálny baseline; bez explicitného signálu nič nové neukladať                        |
| **5**   | Selektívni projektoví/audio donori                         | reference/conditioning moduly, plan                                               | Každá os má provenance; vypnutý donor nemá účinok; lokálny fallback ostáva plnohodnotný                               |
| **6**   | Whole-song dramaturgia a osobné song selection             | `compose.ts`, `song.ts`, audition/review                                          | Celá skladba testovaná nezávisle; section edits majú presný rozsah a whole-song A/B                                   |
| **7**   | MRT2 ako voliteľný performer v tom istom workflowe         | `src/generative/`, capture/freeze, UI                                             | Native/browser host support matrix, latency a pamäť merané; výstup sa auditionuje a stáva bežným editovateľným klipom |

Poradie je **dátové a používateľské, nie modelové**. Nový ONNX model nie je automaticky ďalšia fáza. Ak baseline ukáže, že limitom je generátor alebo brief parser, pridanie rerankera ho neopraví.

## 5. Najlepší prvý end-to-end slice

Najsilnejší ďalší malý produktový krok je **„Vyber → povedz jednu zmenu → bezpečne A/B → Apply“**. Je dostatočne úzky na kvalitnú implementáciu a používateľ okamžite cíti rozdiel oproti promptovej ruletke.

### Scenár

1. Používateľ zadá: „sprav temný west coast beat, nechaj moje bicie a 808“.
2. Brief karta ukáže žáner/mood a zachované roly; používateľ opraví prípadný predpoklad.
3. KYX vygeneruje a prehrá SAFE/PERSONAL/EXPERIMENTAL návrhy.
4. Používateľ zvolí B a povie: „hook nech má viac priestoru; verse a bicie nechaj“.
5. KYX označí parent B, target `lead/hook`, preserve `verse/drums/808`, pripraví proposal a vysvetlí nejednoznačné slovo „priestor“ ako konkrétnu podporovanú zmenu.
6. Vypočuje sa before/after v kontexte susedných sekcií; nič sa ešte neprepíše.
7. Apply nainštaluje presne vypočutý proposal jedným commandom. Undo vráti pôvodný projekt.
8. Až po výslovnej voľbe „zapamätať“ sa pridá lokálne párové preference observation s vhodným kontextom.

### Technické akceptačné podmienky

- Hard constraints sa kontrolujú pred rankingom aj pred commitom.
- Zachované roly/sekcie sa porovnávajú cez UUID-free content hash.
- Project revision, parent hash a targety sa kontrolujú pred audition aj Apply.
- Apply používa presný auditionovaný content hash — nesmie dôjsť k tichej regenerácii.
- Každá prijatá iterácia je jeden undo krok; odmietnutá alebo zrušená iterácia nemení projekt.
- Model timeout, chýbajúci ONNX alebo offline režim nezablokuje lokálny fallback.
- Učenie vkusu je opt-in a uloženie sa dá exportovať, pauznúť a vymazať.
- Testy merajú compliance, zachovanie obsahu, determinizmus, race/cancel scenáre a skutočný blind listening zvlášť.

## 6. Evaluačný scorecard

Tieto osi sa reportujú oddelene; jedna nesmie maskovať zlyhanie inej.

| Os                 | Meranie                                                        | Gate                                                                          |
| ------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Porozumenie        | extrakcia parsera na verziovaných SK/EN brief fixtures         | žiadny neznámy/konfliktný údaj sa nevykazuje ako potvrdený                    |
| Brief compliance   | hard constraint testy + runtime gate                           | nula porušení v golden/synthetic suite; neoveriteľné podmienky označené       |
| Preserve integrity | UUID-free hash chránených rolí/sekcií                          | 100 % identita tam, kde je preserve sľúbený                                   |
| Determinizmus      | rovnaký vstup, seed, model/engine verzia a preference snapshot | rovnaký obsah a stabilné poradie kandidátov                                   |
| Diverzita          | musical feature distance + blind počuteľnosť                   | nie iba odlišný hash; musí byť počuteľný zmysluplný rozdiel                   |
| Osobná preferencia | párový win-rate na held-out výberoch                           | porovnanie s globálnym rankerom a náhodou; reportovať veľkosť vzorky/neistotu |
| Skladba            | song A/B, kontrast/oblúk a section preservation                | samostatná evaluácia od pattern úloh                                          |
| Latencia a budget  | cold/warm render, model load, pamäť, download                  | samostatne browser, desktop a MRT2 host; zachovať fallback pri prekročení     |
| Dôvera             | správne vysvetlený diff/provenance/fallback                    | používateľ vie pred Apply pomenovať, čo sa zmení a čo ostane                  |

Prahové hodnoty pre subjektívnu preferenciu sa majú stanoviť až po nameraní baseline a veľkosti dostupnej vzorky. Nesmú sa spätne vybrať tak, aby ospravedlnili už aktivovaný model.

## 7. Čomu sa vyhnúť

- Nepridávať väčší model len preto, aby produkt pôsobil viac „AI“.
- Netrénovať preferencie na syntetických labeloch a nevydávať výsledok za osobný vkus.
- Nepovažovať počet kandidátov za diverzitu, ak vychádzajú z tej istej hudobnej rodiny.
- Neučiť sa potichu z každého kliknutia, undo alebo ručnej opravy.
- Neprehlasovať hard constraints rankerom, embeddingom ani MRT2.
- Neaplikovať modelový návrh bez audition, diffu alebo undoable commandu.
- Nepoužívať technický loudness/spektrálny proxy ako všeobecné skóre umeleckej kvality.
- Nevyžadovať sieť, účet alebo veľký model na základné lokálne generovanie.
- Nezlievať pattern, section a song preference do jednej anonymnej „DNA“.

## 8. Vízia úspechu

KYX si môže hovoriť osobný AI producent až vtedy, keď v opakovaných, reprezentatívnych testoch:

1. správne pochopí a dodrží podstatné požiadavky;
2. ponúkne reálne počuteľné možnosti, nielen nové seedy;
3. dovolí pokračovať z konkrétneho kandidáta chirurgickou revíziou;
4. zachová to, čo používateľ zamkol, a presne použije to, čo si vypočul;
5. predikuje výslovne vyjadrený vkus lepšie než nepersonalizovaný baseline;
6. funguje aj bez voliteľného AI modelu a bez cloudu;
7. nechá používateľovi projektové dáta, editovateľnosť, undo a finálne rozhodnutie.

Najväčšia konkurenčná výhoda preto nemusí byť „vlastný Suno model“. Môže ňou byť **hudobne schopný, lokálny a vysvetliteľný workflow**, v ktorom generovanie, výber, revízia, učenie vkusu a DAW editácia tvoria jeden bezpečný cyklus.

## 9. Implementačná špecifikácia: prvý producentovský workflow

Táto časť prekladá produktové nápady do konkrétnych hraníc v dnešnom kóde. Ukážkové dátové typy nižšie sú **návrhové kontrakty**, nie tvrdenie, že už existujú pod týmito názvami. Najprv treba rozšíriť aktuálne čisté funkcie a až potom rozhodnúť, či nový typ naozaj zjednoduší implementáciu.

### 9.1 Tok dát a zodpovednosti

```text
Prompt + explicitné opravy používateľa + povolený kontext projektu
  │
  ├─ parse / normalize ──> IntentInput / IntentSpec
  ├─ compile ────────────> BriefContract (čo vieme, čo nevieme, čo chrániť)
  ├─ plan ───────────────> GenerationPlan + seed + provenance
  ├─ generate ───────────> lokálni provideri / generatívne rodiny
  ├─ repair + gates ─────> iba platní kandidáti
  ├─ rank + diversify ───> shortlist s vysvetleným lane
  ├─ audition ───────────> presné audio/hash návrhu
  └─ explicitný Apply ──> jeden KYX command + undo
```

Pravidlá vlastníctva:

- `text-parser.ts`, `normalize.ts` a `brief-contract.ts` prekladajú používateľov zámer. Ranker nesmie spätne „opraviť“ interpretáciu promptu.
- `plan.ts` a candidate plans nesú reprodukovateľný seed a provenance. Variant plánu určený na tvorbu nesmie nahradiť pôvodný plán používaný na kontrolu hard briefu.
- Provider smie navrhnúť obsah, nie meniť `ProjectDocument` ani obchádzať command systém.
- `brief-gate.ts` a invarianty odmietnu neplatný obsah **pred** rankingom. Skóre, ONNX ani osobná preferencia nemôžu zmeniť zamietnutie na prijatie.
- Audition pracuje s dočasným/ghost obsahom. Až potvrdený návrh sa aplikuje cez existujúci command systém.
- Preference ledger prijíma iba explicitný feedback. Parser, generátor, ranker a automatická oprava projektu ho nesmú zapisovať.

### 9.2 Návrhový kontrakt návrhu a bezpečný Apply

Dnešný `BriefContract` už nesie `section`, `origin`, `confidence`, voliteľný `patch` a chránenú rolu; `IterationProposal` už rozlišuje `targets`, `preserve`, `before` a generovaný `result`. Ďalším zmysluplným krokom nie je nový všeobecný „AI response“ objekt, ale doplniť kontrolovateľnú identitu vstupu a výstupu tam, kde sa návrh auditionuje a aplikuje.

Konceptuálne minimum:

```ts
// Návrhový pseudotyp — nenahrádza dnešné GenerationResult / IterationProposal.
interface ProposalReceipt {
  parentContentHash: string | null;
  baseProjectContentHash: string;
  targetScope: Array<{ sectionId?: string; role: IntentRole }>;
  preserve: Array<{ scope: string; contentHash: string }>;
  resultContentHash: string;
  brief: Array<{ statementId: string; status: "passed" | "failed" | "unknown" }>;
  provenance: {
    provider: string;
    seed: string;
    lane: "safe" | "personal" | "experimental";
    ranker: "global" | "personal" | "fallback";
  };
}
```

Nie všetky polia treba serializovať ani vystaviť v UI. Ich účelom je, aby aplikácia vedela zodpovedať: „Z čoho návrh vznikol?“, „Čo presne mení?“, „Čo sa musí zachovať?“ a „Je to stále ten istý návrh, ktorý som počul?“

**Navrhovaný priebeh:**

1. Pri vytvorení návrhu odfotiť content hash parent kandidáta, relevantnej projektovej oblasti a každej chránenej oblasti.
2. Po renderi priradiť auditionovanému výsledku hash obsahu (nie iba poradové číslo kandidáta).
3. Pred Apply znovu vypočítať base/parent/preserve hash-e. Ak sa projekt medzitým zmenil, označiť návrh za zastaraný a vyžiadať nové audition; nikdy ho potichu neregenerovať.
4. Apply vloží presný auditionovaný výsledok do jedného undoable commandu. `Undo` vráti presný stav pred Apply.
5. Pri targeted iteration hash-e všetkých nedotknutých rolí/sekcií musia zostať identické. Ak reprezentácia projektu neumožňuje bezpečne oddeliť požadovanú rolu, návrh sa odmietne alebo sa rozsah otvorene rozšíri ešte pred audition.

**Testovacie príklady:** stale parent; zmenený chránený track; zrušené audition; kliknutie Apply počas renderu; dve rýchle Apply akcie; zmena dokumentu medzi audition a Apply; generátor vráti rovnaký pattern s novými UUID; undo/redo; offline renderer zlyhá. Každý scenár musí buď bezpečne odmietnuť, alebo aplikovať presne vypočutý obsah — nie vytvoriť tichú tretiu verziu.

### 9.3 Kontrakt pre Producer DNA a Taste Probe

Aktuálny `preference-ledger-core.ts` už definuje verzovaný explicitný párový záznam (`pattern` / `section` / `song`, voľby A/B/ani jeden/obidva, kontext, feature snapshots) a validuje ho pred použitím. Prvá inovácia preto nie je ďalší model: je ňou správne rozhodnúť **kedy** sa pýtať, **ktoré** voľby patria do rovnakého kontextu a **ako** overiť, že učenie pomáha na dosiaľ nevidených pároch.

```text
Nie je istota v jednej relevantnej osi
  → vytvor kontrolovaný A/B pár, ak oba návrhy prejdú rovnakým briefom
  → pomenuj jediný zamýšľaný rozdiel (napr. opakujúci sa vs. meniaci sa hook)
  → používateľ vyberie A / B / ani jeden / obidva / preskočiť
  → iba explicitná voľba zapíše observation
  → ďalšie nepoužité páry zmerajú, či personal ranker predikuje výber lepšie
```

**Výber otázky (v1, deterministická policy):**

1. Vylúčiť osi, ktoré prompt zamkol, ktoré nemajú implementovanú generatívnu rodinu alebo ktorých rozdiel nemožno zmerať.
2. Vylúčiť každý pár, v ktorom jedna strana neprešla rovnakým brief gate.
3. Uprednostniť os s najväčšou neistotou v relevantnom kontexte, ale rešpektovať limit frekvencie; používateľ ju môže vždy preskočiť.
4. Označenie „kontrolovaný A/B“ použiť iba ak sa zamýšľaná os merateľne líši a ostatné deklarované osi ostali v tolerancii. Inak je to obyčajný kreatívny compare.
5. „Ani jeden“ uzavrie pár bez hlasu pre A/B; môže spustiť zmenu briefu alebo generatívnej rodiny. „Obidva“ zaznamená prijateľnosť, nie preferenciu poradia.

**Vyhodnotenie:** rozdeliť dáta chronologicky alebo podľa session na train/held-out. Reportovať počet ľudí/používateľov, počet párov, kontexty, win-rate aj interval neistoty proti globálnemu rankeru a jednoduchému baseline. Rovnaké páry, ktoré vytvorili osobný adapter, nesmú slúžiť ako dôkaz jeho generalizácie. Ak je vzorka malá, výsledok je „nedostatok dôkazov“, nie „personalizácia funguje“.

### 9.4 Generatívne rodiny: od promptovej osi k počuteľnej zmene

Každá nová kreatívna voľba potrebuje tri vrstvy; samotný slider alebo štítok lane nič negarantuje:

| Vrstva               | Príklad hook variantu                                                     | Povinný dôkaz                                                                 |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Zámer**            | `repeating-hook` alebo `evolving-hook`                                    | Parser/brief ho rozlíši a vie označiť konflikt či neistotu.                   |
| **Kandidát**         | Seedovaná rodina vytvorí iný contour/rytmus hooku                         | Deterministický test, feature delta a obsahový hash; zachované roly ostávajú. |
| **Výber a audition** | Kandidát prejde hard gates, zobrazí sa s poctivým popisom a dá sa vypočuť | Blind ľudská evaluácia potvrdí, že rozdiel je počuteľný a relevantný.         |

Poradie odporúčaných rodín: (1) groove s merateľnou syncopation/placement zmenou, (2) opakovanie vs. vývoj existujúceho motívu, (3) call-and-response a melodický contour, (4) kontrast sekcií a vstupy/odchody rolí, (5) selektívne harmonické voicing. Každú rodinu treba pridať za samostatný feature flag alebo lane policy, aby bolo možné odlíšiť zlyhanie generátora od zlyhania rankera. Ak rodina nevytvorí platný a zmysluplne odlišný výsledok, lane sa skryje — nesmie sa preznačiť seedový variant.

### 9.5 Evaluačný balík pred ONNX rozšírením

ONNX má zmysel až po oddelenom zmeraní, kde vzniká chyba. Všetky nasledujúce reporty nech sú samostatné:

| Vrstva              | Test / metrika                                                                                    | Zlyhanie znamená                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Interpretácia       | Golden briefy SK/EN: extrahované hard facts, preferencie, preserve, zákazy, unknown/conflict      | Vylepšiť parser/kontrakt; ranker to nevyrieši.                           |
| Compliance          | Candidate gate + invariant suite na všetkých generovaných kandidátoch                             | Opraviť planner/generátor/gate; kandidát sa nesmie dostať do rankingu.   |
| Hudobná validita    | Žánrovo a rolovo stratifikované checks; manuálne audity falošne pozitívnych/negatívnych výsledkov | Spresniť hudobné features/rodiny, nie zvyšovať váhu jedného proxy skóre. |
| Počuteľná diverzita | Feature distance + zaslepená otázka „počujem zmysluplný rozdiel?“                                 | Zmeniť generatívnu rodinu alebo shortlist; viac seedov nestačí.          |
| Brief fit vs. vkus  | Dve oddelené blind otázky                                                                         | Oddeliť compliance/ranking od preference learningu.                      |
| Personalizácia      | Held-out voľby proti globálnemu a náhodnému baseline                                              | Ak niet prínosu, ranker vypnúť alebo rozšíriť dáta.                      |
| Bezpečné editovanie | Preserve/base/result hash-e, stale proposal, undo/redo, race/cancel                               | Zastaviť Apply; neobetovať integritu kvôli plynulosti UI.                |
| Náklady             | Cold/warm latency, render čas, pamäť, model download a fallback                                   | Zúžiť kandidátov/lazy-load; browser bez modelu ostáva použiteľný.        |

Syntetické fixtures a teacher labels sú užitočné na regresie, deterministickosť a plumbing. V scorecarde však musia zostať označené ako syntetické; nesmú sa zlúčiť s používateľským blind posluchom.

### 9.6 Rozdelenie na implementačné rezy

Každý rez má byť samostatne reviewovateľný a nesmie naraz meniť parser, generátor, ONNX model, project schema aj UI.

| Rez                                 | Konkrétny výsledok                                                                               | Pravdepodobné miesto                                                                 | Exit gate                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **A — Baseline**                    | Verziované brief fixtures + anonymný pattern/song compare a pravdivý report o lane availability  | `tests/intent/`, `scripts/`, `listening/`                                            | Reprodukovateľný baseline; ľudské hlasy oddelené od synthetic tests.         |
| **B — Brief Debugger**              | Používateľ opraví konkrétny statement pred generovaním; konflikt/unknown nie je vydávaný za fakt | `brief-contract.ts`, `text-parser.ts`, `IntentPanel.tsx`                             | Golden SK/EN testy; 100 % hard fixtures správne alebo explicitne unresolved. |
| **C — Candidate families**          | Každý SAFE/PERSONAL/EXPERIMENTAL výsledok má pravú policy, hudobnú rodinu a truthful fallback    | `candidate-search.ts`, `providers/local.ts`, melody/groove generátory                | Všetci kandidáti gate-valid; rodiny reproducible; blind počuteľný rozdiel.   |
| **D — Receipt + surgical revision** | Rozdiel, parent, preserve hash-e a presný auditioned výstup; bezpečný stale odmiet               | `iteration.ts`, `audition.ts`, `IntentPanel.tsx`, `commands/`                        | Protected content 100 % identický; audition hash = Apply hash; jeden Undo.   |
| **E — DNA questions**               | Kontextový Taste Probe a explicitné A/B/ani jeden/obidva                                         | `preference-ledger-core.ts`, `personal-ranker.ts`, `candidate-search.ts`, compare UI | Held-out predikcia; export/pause/clear; žiadne implicitné zápisy.            |
| **F — Project/donor masks**         | Používateľ zapína jednotlivé project/audio osi a vidí ich zdroj                                  | `audio-reference.ts`, `reference-embedding.ts`, `semantic-conditioning.ts`           | Donor OFF = nulový conditioning vplyv; žiadne surové audio v ledgeri.        |
| **G — Song producer**               | Celoskladbový compare, section-only revision a samostatný song preference context                | `compose.ts`, `song.ts`, `song-audio-review.ts`, `IntentPanel.tsx`                   | Whole-song blind evidence; ostatné sekcie sa pri lokálnej revízii nemenia.   |
| **H — MRT2 performer**              | Voliteľný audition/freeze performer po stabilizácii kontraktu a song flow                        | `src/generative/`, capture, desktop host                                             | Runtime optional; podpora a resource budget otestované; výstup editovateľný. |

**Rozhodnutie o poradí:** rezy A–D prinášajú kontrolu a dôveryhodné dáta; rez E je užitočný až keď D vytvára kvalitné páry a C vie preferovanú vlastnosť realizovať. Donori, song-level DNA a MRT2 sú naviazané na rovnaký receipt/audition/apply cyklus, preto ich nepripájať cez paralelný workflow.

### 9.7 Produktové akceptačné scenáre

1. **Jednoduché zadanie:** „Sprav 92 BPM West Coast beat.“ Používateľ dostane krátky kontrakt, validné kandidáty a počuje ich pred Apply.
2. **Zachovanie:** „Pridaj lead, bicie a 808 nechaj.“ Výstup nemení chránený drum/bass content; hash test to dokazuje.
3. **Oprava interpretácie:** „Myslel som bounce ako swing, nie viac kickov.“ Opravený contract ide do nového plánu; starý návrh sa omylom nepoužije.
4. **Pokračovanie:** „Druhý, ale hook priestrannejší.“ Základom je kandidát dva; UI vypíše target/preserve rozsah; po audition Apply použije práve vypočutý výsledok.
5. **Nedobrý pár:** používateľ zvolí „ani jeden“. Žiadna strana nedostane preferenčný hlas; brief/rodina sa upraví a hľadá sa nový pár.
6. **Cold start:** personalizácia nemá dosť relevantných volieb. UI hovorí cold-start a ponúkne SAFE/EXPERIMENTAL; nevymýšľa si osobný vkus.
7. **Zmena projektu počas audition:** projektový hash už nesedí. Apply sa zablokuje s možnosťou znovu auditionovať.
8. **Bez modelu alebo offline:** lokálny deterministický workflow zostáva funkčný; UI pravdivo označí použitý fallback.

Toto je „hotové“ iba keď produktový scenár, čisté unit testy, browser/audio testy a aspoň jedno ľudské blind hodnotenie potvrdia príslušnú vrstvu. Zelený typecheck ani úspešný ONNX `session.run()` sám osebe nie je akceptačný dôkaz.
