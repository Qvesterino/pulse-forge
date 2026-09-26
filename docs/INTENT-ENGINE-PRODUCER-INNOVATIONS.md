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
