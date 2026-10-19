# Pulse Forge — implementačná roadmapa KYX v2 pre rok 2027

**Vytvorené:** 2026-10-17 · **Aktualizované:** 2026-10-19

**Stav:** používateľom schválený produktový smer; implementačný plán s otvorenými realizačnými úlohami

**Produkt:** KYX Web a KYX Studio; interný projekt Pulse Forge

**Hlavná téza:** z vlastného zvuku vytvoriť rodinu hrateľných zvukov, použiť ju v beate a zahrať jej premenu.

## 1. Účel a spôsob používania

Tento dokument prevádza schválenú víziu KYX v2 na poradie práce, konkrétne kroky, technické závislosti, odporúčané rozhodnutia a podmienky dokončenia. Je samostatným plánom celého programu pre rok 2027. Podrobné pluginové backlogy zostávajú zdrojom úloh vo svojich oblastiach.

Dokument plánuje budúcu implementáciu. Označenie fázy ani opis cieľového zážitku neznamenajú, že daná funkcia už funguje. Pri začatí každej fázy sa overí aktuálny kód a vytvorí zoznam konkrétnych úloh z jej akceptačnej brány.

- **Stav dodávaného produktu a jeho počty:** [CURRENT-STATE.md](CURRENT-STATE.md).
- **Spoločný zvukový protokol:** [SOUND-QUALITY-ROADMAP.md](SOUND-QUALITY-ROADMAP.md).
- **TSAR:** [implementačná roadmapa](TSAR-IMPLEMENTATION-ROADMAP.md) a [produktový smer](TSAR-PRODUCT-DIRECTION.md).
- **KOPA a KOREŇ:** [V2 backlog](KOPA-KOREN-V2-ROADMAP.md).
- **Obsah a nahrávky:** [inventár a medzery knižnice](SOUND-LIBRARY-INVENTORY-2026-10-17.md).
- **AI:** [AI Producer Contract](AI-PRODUCER-CONTRACT.md) a [Producer DNA roadmapa](PRODUCER-DNA-ROADMAP.md).
- **Desktop a plný DAW:** [ROADMAP-FULL-DAW.md](ROADMAP-FULL-DAW.md).
- **Vizuál a ovládanie:** [ROADMAP-UI-2027.md](ROADMAP-UI-2027.md).

KYX v2 označuje produktové vydanie celého DAW. KOPA/KOREŇ V2 a TSAR R1–R8 sú samostatné vývojové označenia modulov; ich číslovanie nemusí zodpovedať číslu vydania KYX. Tento dokument nemení verziu balíka, schému projektu ani existujúce ADR.

### Rýchla orientácia

| Potrebujem zistiť                                                 | Kde začať                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Čo má KYX v2 priniesť používateľovi a čo patrí do prvého vydania. | Kapitoly 2–4.                                                           |
| V akom poradí implementovať a od čoho jednotlivé časti závisia.   | Prehľad v kapitole 6, kroky F0–F10 v kapitolách 7–17.                   |
| Ako posúdiť kvalitu a kam zmenu zapojiť v kóde.                   | Akceptačná matica, technická mapa a ADR rozhodnutia v kapitolách 18–20. |
| Čím začať teraz a ako evidovať dokončenie.                        | Realizačný rad a záznam dôkazov v kapitolách 23–24.                     |

## 2. Produktový zámer a cieľový zážitok

**Pracovná produktová veta: „Z jedného zvuku si postav vlastný svet.“**

KYX v2 má pomáhať producentovi vytvoriť osobitý materiál, zahrať ho a dokončiť skladbu. Silnou stránkou má byť prepojenie vlastného zdroja, interných nástrojov, výrazového hrania, aranžmánu a editovateľných AI návrhov.

### Referenčná 45-sekundová ukážka

1. Producent vloží krátku vlastnú nahrávku, napríklad kovový úder, drevené klopnutie alebo dych.
2. Sound Seed ponúkne vhodné interpretácie: perkusiu, hrateľný TSAR patch a textúru. Pôvodný zvuk zostane dostupný.
3. Producent pridá KOPA kick a existujúci basový nástroj; KOREŇ podľa potreby zvýši čitateľnosť harmonického pásma basy.
4. Afterimage vytvorí z vybraného zdroja doznievajúcu vrstvu, ktorá v správnom mieste aranžmánu rozvinie priestor.
5. Performance Scene zmení vybrané parametre z pokojnej slohy na otvorený hook. Pohyb sa nahrá do upraviteľnej automatizácie.
6. Producent projekt uloží, znovu otvorí a vyexportuje. Zdroje, nástroje a zaznamenaná premena zostanú zachované.

Táto ukážka je integračný scenár. V prvom prototype používa ručne pripravené noty a existujúce aranžovacie nástroje; automatické komponovanie celej skladby nie je jej predpokladom.

Prototyp F2 overí import, tri zvukové roly, ich použitie v beate a uloženie/export. Afterimage a zaznamenanú Performance Scene doplnia fázy F6 a F7. Celú cieľovú ukážku overí beta vo F10; prvý prototyp tak nezávisí od ešte nepostavených neskorších funkcií.

### Čo má používateľ cítiť

- **Vlastníctvo zvuku:** výsledok má počuteľnú súvislosť s jeho zdrojom a dá sa ďalej pretvárať.
- **Odozvu:** nástroj reaguje na intenzitu a priebeh hrania.
- **Kontrast:** hook, prestávka a drop majú odlišnú energiu, priestor a hustotu.
- **Kontrolu:** návrh sa dá vypočuť, porovnať, odmietnuť a vrátiť cez undo.
- **Dôveru:** uložený projekt a export zachovajú zamýšľaný zvuk.

„Zimomriavky“ sú tvorivá ambícia. Ich technickou náhradou nebude jedno AI skóre. Hudobnú hodnotu budeme overovať posluchom a prácou producentov s výsledkami.

## 3. Východiskový stav a hranice tvrdení

Existujúci kód poskytuje nástroje na realizáciu tejto vízie. Podrobné aktuálne počty patria výhradne do `CURRENT-STATE.md`; táto roadmapa ich nekopíruje.

| Oblasť           | Základ, na ktorý nadviazať                                                    | Čo treba pre v2 dokončiť alebo vybudovať                                                                   |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| TSAR             | Hybridný engine, zdroje A/B, Forge, modulácie, presetový a workletový základ. | Spoľahlivý celý používateľský priechod, knižnica zdrojov, audition, výrazová cesta a riadený grain engine. |
| KOPA             | Samostatný kick-design nástroj s telom, clickom, subom a harmonickou vrstvou. | Úplný MIDI/fallback kontrakt, merania, kurátorované zvuky a prípadná zdrojová click vrstva.                |
| KOREŇ            | Samostatný basový harmonický procesor s odhadom fundamentu.                   | Istota trackingu, gain/mono/alias/CPU dôkazy, vysvetlené ovládanie a porovnanie v mixe.                    |
| Knižnica         | Syntetické factory zdroje, curated WAV-y a voliteľné nástrojové balíky.       | Vlastné nahrávky, prirodzené artikulácie a súvisiace zvukové rodiny.                                       |
| Aranžmán a výraz | Existujúce scény, automatizácia a rozvíjané note-expression schopnosti.       | Spoločné mapovanie performance scén a overenie jednotlivých podporovaných ciest.                           |
| AI               | Intent pipeline, návrhy, preferenčná pamäť a evaluačná infraštruktúra.        | Pluginové adaptéry, vypočuteľné varianty a doklad prínosu pri chránenom obsahu.                            |
| Distribúcia      | Web, desktopové balenie a samostatný smer Qvester Hubu.                       | Testovaná podpora platforiem, verzované balíky, aktualizácie a obnova po zlyhaní.                          |

Sound Seed, Afterimage a spoločné Performance Scenes sa tu plánujú ako nové integračné schopnosti. Existujúce Forge, scene alebo morph funkcie samy osebe nepotvrdzujú ich dodanie.

Merania z predchádzajúcich auditov sú historický dôkaz na konkrétnom stave kódu. Fáza 0 musí vytvoriť nový baseline s commitom, zariadením a podmienkami. Starý počet zelených testov ani stará veľkosť bundlu sa nepoužijú ako potvrdenie súčasného vydania.

## 4. Rozsah vydania a priority

### Povinný zážitok KYX v2.0

1. Stabilné jadro a overený priechod prehrávanie → uloženie → znovuotvorenie → export.
2. Spoločné zdroje, reprodukovateľné recepty a bezpečný audition/Apply mechanizmus.
3. Sound Seed s malou sadou odlišných a hudobne použiteľných výstupov.
4. Prvá vlastná KYX Originals kolekcia a kurátorované signature patche.
5. TSAR s jasne deklarovanou výrazovou podporou a dokončeným zdrojovým workflowom.
6. Dokončená kvalita KOPA/KOREŇ a spoločné porovnanie kicku s basou.
7. Afterimage v obmedzenom, deterministickom rozsahu.
8. Performance Scenes s uloženou a exportovateľnou automatizáciou.
9. Obmedzený AI producentovský pilot s lokálnym deterministickým základom.
10. Overená beta, dokumentácia a aktualizovateľná distribúcia pre deklarované platformy.

### Rozsah závislý od výsledku prototypu

- Plný grain engine vstúpi do vydania po splnení zvukovej a výkonovej brány; stabilné zdrojové workflowy sa vyvíjajú už pred ním.
- Modelové radenie kandidátov sa aktivuje až po porovnaní s deterministickým základom.
- Zdrojový click v KOPA závisí od spoločného assetového kontraktu a meraní vrstvenia.
- Pokročilé prechody medzi rozdielnymi samplami alebo typmi enginu závisia od rozpočtu súbežne bežiacich vrstiev.

### Samostatné vývojové vetvy

Fyzikálna rezonancia materiálov, rozsiahlejšie modely, úplná externá MPE podpora, natívny audio backend a third-party plugin hosting majú vlastné rozhodnutia a akceptačné brány. Môžu priniesť silné rozšírenia v roku 2027; marketingové tvrdenie sa viaže na konkrétne overené vydanie.

Web v2 a Studio v2 majú spoločnú zvukovú víziu. Natívne I/O a hosting sa vydávajú podľa samostatnej podpory Studio a nezablokujú dokončené webové schopnosti.

## 5. Architektonické pravidlá programu

Základom sú [ARCHITECTURE.md](../ARCHITECTURE.md), [AGENTS.md](../AGENTS.md), [AGENT-MAP.md](AGENT-MAP.md) a relevantné ADR.

1. UI vyjadruje zámer; commands menia serializovateľný projekt; Transport určuje hudobný čas; Scheduler plánuje; AudioEngine vykonáva; DSP spracúva zvuk.
2. Vlastné realtime DSP zostáva v AudioWorklete. Ťažká analýza, príprava zdrojov a modelová inferencia bežia mimo audio callbacku.
3. Live a offline používajú rovnaký engine, význam udalostí a DSP. Offline udalosti sa pripravia pred renderovaním podľa existujúceho workletového kontraktu.
4. Náhodnosť je seedovaná. Recept obsahuje aj verziu algoritmu, parametre a identitu vstupu; samotný seed nestačí na dlhodobú reprodukciu po zmene algoritmu.
5. Nový uložený tvar vyžaduje migráciu schémy. Staré projekty sa otvárajú podľa deklarovaného kompatibilitného kontraktu.
6. Source asset, kandidát, preset, performance mapovanie a modelový balík sú odlišné objekty s vlastným životným cyklom.
7. Náhľad má izolovanú audio cestu cez existujúcu správu kontextu a rovnakú DSP implementáciu. Projekt sa mení až prijatím návrhu.
8. Funkcie, worklety, audio a modely sa načítavajú podľa potreby. Aktuálne bundle limity určuje `scripts/check-bundle-size.mjs`; ich zvýšenie vyžaduje meranie a odôvodnenie.
9. Každá dlhšia operácia má zrušenie, ohraničené zdroje a ochranu pred použitím zastaraného výsledku.
10. Aktívne procesy, workery, náhľady a buffery majú vlastníka. Ich uvoľnenie je súčasťou dokončenia funkcie aj overovacieho behu.
11. Používateľské audio a preferenčná pamäť zostávajú predvolene lokálne. Vzdialené spracovanie vyžaduje vedome zvoleného poskytovateľa a zrozumiteľný rozsah prenášaných dát; projekty sa automaticky nepoužijú na tréning.

### Spoločná cesta nových schopností

```text
Vlastná nahrávka / Originals / existujúci zdroj
  → validácia a lokálny source asset
  → analýza + verzovaný recept + seed
  → malá sada kandidátov
  → audio náhľad cez spoločnú DSP cestu
  → porovnanie v kontexte skladby
  → jeden command na prijatie
  → nástroj / klip / automatizácia v projekte
  → uloženie a offline export
```

AI môže pripraviť alebo zoradiť kandidátov vo vhodnom bode tejto cesty. Priamy zápis modelu do projektu alebo do audio callbacku do nej nepatrí.

## 6. Prehľad fáz a závislostí

| ID  | Fáza                            | Hlavný výsledok                                              | Predpoklady                                                |
| --- | ------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| F0  | Baseline a spoľahlivosť         | Overiteľný stav jadra a pevný merací korpus.                 | Audit aktuálneho HEAD a existujúcich backlogov.            |
| F1  | Zdroje, recepty a audition      | Spoločná vrstva pre uloženie, náhľad a prijatie zvuku.       | F0.                                                        |
| F2  | Sound Seed prototyp             | Prvá úplná cesta od zdroja po rodinu zvukov a beat.          | F1 a spoľahlivý TSAR základ.                               |
| F3  | KYX Originals a signature banka | Vlastný materiál a kurátorované rodiny.                      | Zdrojový kontrakt F1; zvukové poznatky F2.                 |
| F4  | TSAR: výraz a zdrojový engine   | Hrateľné patche, riadené zrná a overený MIDI/event priechod. | F1–F2; zafixovaný výkonový rozpočet.                       |
| F5  | KOPA/KOREŇ a súhra basy         | Dokončené pluginy a porovnateľné low-end návrhy.             | F0–F1; pre zdrojový click aj F2.                           |
| F6  | Afterimage                      | Uložená zvuková pamäť reagujúca na hudobný kontext.          | F1–F2 a stabilné časovanie.                                |
| F7  | Performance Scenes              | Zahraná premena s uloženým mapovaním a automatizáciou.       | Stabilné ciele F4–F6 a existujúce scene/automation vrstvy. |
| F8  | AI producent v kontexte         | Ohraničené návrhy → porovnanie → prijatie.                   | F1–F2 a dokončené adaptéry príslušných pluginov.           |
| F9  | Web, Studio a Qvester Hub       | Podpora platforiem a bezpečne aktualizovateľné balíky.       | Verzionovanie assetov/receptov; príslušné desktopové ADR.  |
| F10 | Beta a vydanie                  | Doložená technická aj hudobná kvalita.                       | Povinné funkcie a ich dôkazy.                              |

Implementáciu viesť sekvenčne po malých uzavretých celkoch. Nahrávaciu prípravu F3 alebo návrh distribučného kontraktu F9 možno pripraviť skôr, ale ich integrácia musí rešpektovať závislosti tabuľky.

## 7. Fáza F0 — baseline a spoľahlivé jadro

**Cieľ:** vytvoriť pevný technický a posluchový základ, na ktorom bude možné nové funkcie porovnávať.

### Kroky

- [ ] **F0.1:** zapísať aktuálny commit, stav pracovného stromu, platformy, browser verzie, sample rate, buffer a posluchovú zostavu.
- [ ] **F0.2:** pripraviť malé referenčné projekty: KOPA kick, 808 + KOREŇ, harmonicky bohatá basa, TSAR tonal/percussion/texture, celý beat a stresový projekt.
- [ ] **F0.3:** ku vstupom uložiť pôvod, seed, tóninu alebo stav „neurčená“, tempo, eventy a očakávaný účel merania.
- [ ] **F0.4:** prejsť otvorené P0 KOPA/KOREŇ a TSAR R1: parameter route, MIDI, fallback, lazy load, zdroje A/B a priamy live/offline priechod.
- [ ] **F0.5:** zmerať finite samples, peak/true peak podľa použitia, hlasitosť, transient, sub, stereo/mono, aliasing, CPU a pamäť.
- [ ] **F0.6:** zaznamenať existujúce zlyhania globálnych brán oddelene od novej zmeny; čistý baseline merať v izolovanom worktree na HEAD.
- [ ] **F0.7:** zvoliť referenčný slabší aj bežný počítač a vopred stanoviť rozpočty nových procesorov a analýz.
- [ ] **F0.8:** uzavrieť známe chyby, ktoré by znehodnotili následný posluch alebo export. Každú opravu doložiť testom cez skutočnú zlyhávajúcu cestu.

**Výstupy:** baseline report, verzovaný korpus, zoznam otvorených obmedzení, meracie skripty a vyplnené checklisty dotknutých pluginov.

**Brána:** rovnaký vstup a seed dávajú reprodukovateľné výsledky; referenčné projekty sa uložia a znovu otvoria; zamýšľaná DSP cesta funguje pri hraní aj exporte. Nové rozpočty sa určia pred ladením novej funkcie.

**Odporúčanie:** najprv odstrániť neistotu v existujúcich ovládačoch a zdrojoch. Pred pridaním anti-alias techniky alebo ďalších hlasov porovnať jej zvukový prínos a náklady.

F0 rieši existujúce chyby, ktoré blokujú prvý spoľahlivý priechod. Nové DSP schopnosti a úplné rozšírenie pluginov zostávajú vo F4/F5; ich budovanie nie je podmienkou začatia jednoduchého Sound Seed prototypu.

## 8. Fáza F1 — spoločné zdroje, recepty a audition

**Cieľ:** všetky nové funkcie používajú rovnaké pravidlá pre zdroj, reprodukciu, náhľad a prijatie.

### Kroky

- [ ] **F1.1:** v ADR zadefinovať source asset, odvodený asset, recept, kandidáta a preset. Uložený projekt má referencovať stabilné identity médií.
- [ ] **F1.2:** definovať minimálne metadáta: identita a hash vstupu, pôvod, licenčný stav, audio formát, kanály, dĺžka, zistené vlastnosti a ich neistota.
- [ ] **F1.3:** pre recept uložiť verziu algoritmu, seed, parametre, rozsah vstupného audia a rodičovský asset. Pri zmene algoritmu zachovať starý render alebo kompatibilný interpret receptu.
- [ ] **F1.4:** import viesť cez spoločnú audio-import politiku a existujúce kapacitné limity. Analýzu a konverzie vykonávať ohraničene vo worker ceste; zachovať pôvodný zdroj.
- [ ] **F1.5:** navrhnúť izolovaný audition runtime so zrušením, zastavením, návratom k originálu a oddeleným audition gainom. Využiť existujúcu správu AudioContextu a engine implementáciu.
- [ ] **F1.6:** kandidáta viazať na revíziu projektu, zdroje a verzie enginu. Neskorý výsledok po zmene samplu alebo projektu sa nesmie aplikovať.
- [ ] **F1.7:** Apply vykonať ako jednu undoable transakciu. Nedostatok miesta, neúspešný zápis alebo chýbajúci asset nesmú zanechať polovicu rodiny v projekte.
- [ ] **F1.8:** určiť cache, LRU limity, rušenie jobov, odpojenie audio uzlov a uvoľnenie bufferov. Médiá potrebné pre projekt alebo undo históriu sa nevymažú pri zatvorení náhľadu.
- [ ] **F1.9:** overiť prenos projektu so všetkými potrebnými médiami existujúcou export/import cestou a obnovu po páde či storage quota chybe.

**Výstupy:** dátový kontrakt, migrácia pri zmene uloženého tvaru, source repository rozhranie, preview/Apply služba a integračné scenáre.

**Brána:** preview, Cancel, no-op a zastaraný výsledok nemenia projekt; Apply sa dá undo/redo; znovuotvorený aj prenesený projekt nájde rovnaké zdroje; opakované náhľady nehromadia uzly, workery ani pamäť.

**Odporúčanie:** oddeliť spoločnú infraštruktúru od konkrétnej transformácie. Sound Seed, TSAR Forge, Afterimage a AI nemajú vytvoriť štyri samostatné assetové systémy.

## 9. Fáza F2 — KYX Sound Seed a prvý úplný prototyp

**Cieľ:** producent dokáže z vlastnej nahrávky vytvoriť malú rodinu zvukov, ktoré majú spoločný charakter a rozdielne hudobné úlohy.

### Prvý rozsah

Začať tromi výstupnými rolami: **perkusívny one-shot, hrateľný TSAR patch a textúra**. Je to navrhovaný rozsah prototypu, nie nový počet dodávaných presetov. Ďalšie roly pridať po posluchu.

### Kroky

- [ ] **F2.1:** vybrať reprezentatívny tonalný, transientný a šumový vstup z korpusu F0. Dopredu pomenovať, aká časť zdroja má zostať rozpoznateľná.
- [ ] **F2.2:** rozšíriť existujúcu Forge analýzu o vlastnosti potrebné pre výber receptu: transient, periodicita, spektrálny charakter, šum a časový priebeh.
- [ ] **F2.3:** navrhnúť deterministické recepty pre tri roly. Pri neistej výške ponechať neladenú interpretáciu alebo explicitnú voľbu používateľa.
- [ ] **F2.4:** pre TSAR využiť sampler/wavetable a existujúce overené zdrojové cesty. Prvý úplný prototyp nemusí čakať na nový grain engine.
- [ ] **F2.5:** vytvoriť kartu rodiny: pôvodný zdroj, jednotlivé roly, stručný opis zmeny, náhľad, výber a odmietnutie.
- [ ] **F2.6:** pripraviť malý počet odlíšených variantov s uzamknutím zdroja, ladenia alebo obálky; využiť vhodné časti TSAR Mutations.
- [ ] **F2.7:** vybranú rodinu vložiť do projektu s bežnými nástrojmi a klipmi cez jednu transakciu. Výsledné noty a parametre ostávajú editovateľné.
- [ ] **F2.8:** zostaviť referenčný beat a 45-sekundový priechod import → tvorba → hranie → uloženie → export.

**Výstupy:** Sound Seed prototyp, recepty, preview rozhranie, referencia zdroj → rodina a exportovateľný demo projekt.

**Brána:** výstupy sa opakujú z uloženého receptu; producenti rozlíšia ich roly; vybrané rodiny nesú počuteľný charakter zdroja; ticho, poškodený súbor a nepoužiteľný vstup majú jasný výsledok bez mutácie projektu.

**Odporúčanie:** prvé zvukové rozhodnutia robiť deterministickými receptmi. Model pridať až tam, kde kontrolovaný experiment preukáže konkrétne zlepšenie.

## 10. Fáza F3 — KYX Originals a signature banka

**Cieľ:** vytvoriť vlastný materiál, ktorý dá pluginom a zvukovým rodinám rozpoznateľný pôvod a prirodzenú variabilitu.

### Kroky

- [ ] **F3.1:** pripraviť nahrávací brief približne pre 12–18 starostlivo vybraných zdrojov: kov, drevo, ručné perkusie, mäkké šuchoty, dych a niekoľko priestorov. Ide o pracovný rozsah prvej session.
- [ ] **F3.2:** pri vhodných zdrojoch nahrať viac intenzít a alternatívnych úderov; zaznamenať artikuláciu a spôsob hry.
- [ ] **F3.3:** blízke a priestorové záznamy zachytiť na skutočne podporovanej vstupnej konfigurácii. Pri párovaných stopách overiť časový a fázový vzťah.
- [ ] **F3.4:** ku každému zdroju viesť pôvod, práva, súhlasy pri hlasovom materiáli a rozsah povolenej distribúcie. Používateľské importy majú vlastný lokálny režim.
- [ ] **F3.5:** editovať reálne chyby nahrávky, kontrolovať DC, clipping, konce, šum a mono fold-down; hudobné nástupy a intentional swelly ponechať podľa roly.
- [ ] **F3.6:** z materiálu vytvoriť súvisiace Sound Seed rodiny a malú kurátorovanú signature banku s performance mapovaním.
- [ ] **F3.7:** hodnotiť patche pri porovnateľnej hlasitosti v samostatnom zvuku aj v beate. Pri blízkych variantoch pomenovať rozdielnu hudobnú úlohu.
- [ ] **F3.8:** pripraviť suché aj pretvorené príklady a neskôr niekoľko reálnych performance fráz pre odlišné rytmické použitia.

**Výstupy:** zdokumentované master nahrávky, distribuovateľné assety, metadáta a kurátorované patche s ukážkovými projektmi.

**Brána:** každý publikovaný asset má práva, technickú QA a jasný účel; patch sa načíta aj po prenose projektu; blízke zvuky prešli posluchovým rozhodnutím; voliteľný obsah sa nesťahuje pri bežnom boote.

**Odporúčanie:** prvú session objednať alebo nahrať podľa medzier z prototypu. Zachovať alternatívne performance, ktoré prinášajú prirodzený rozdiel; rast banky viazať na nové použiteľné roly.

## 11. Fáza F4 — TSAR ako výrazový nástroj

**Cieľ:** hrateľný patch reaguje na notu, intenzitu a priebeh hry a zachová túto odozvu v exporte.

### Kroky

- [ ] **F4.1:** dokončiť source library, Forge návrhy a preset audition podľa TSAR R2–R5 na vrstve F1.
- [ ] **F4.2:** definovať malý stabilný súbor performance makier a ich význam. Zmeny velocity law alebo predvoleného timbru porovnať so starými patchmi.
- [ ] **F4.3:** prejsť expression cestu od skutočného vstupu alebo piano roll eventu cez model a scheduler až po práve hrajúci hlas a offline render.
- [ ] **F4.4:** publikovať capability mapu pre pitch, pan, pressure a dostupné timbre ciele. Externé MIDI/MPE obmedzenia uviesť podľa overeného transportu.
- [ ] **F4.5:** prototypovať grain engine s pevnou hornou hranicou grainov, deterministickým plánovaním a seedmi odvodenými od udalostí/hlasov. Rozmer grainov, density, pozícia a jitter musia mať hudobne čitateľný význam.
- [ ] **F4.6:** overiť ladený, transientný a šumový materiál, voice-steal, retrigger, seek, zmenu sample rate a opakovateľný reset. Ovládanie gainu a prechodov nesmie vytvárať neúmyselné kliky.
- [ ] **F4.7:** zmerať najdrahšiu podporovanú polyfóniu, deadline workletu, pamäť a aliasing. Zahrnúť zatvorený aj otvorený panel.
- [ ] **F4.8:** zvoliť kompatibilitu starých patchov pri náhrade dnešného skenovania novým granulárnym režimom. Význam uloženého patcha nesmie zmeniť samotný update bez deklarovaného kontraktu.
- [ ] **F4.9:** po samostatnom návrhu preveriť materiálovú rezonanciu nad existujúcim REZONANS: kov/sklo/drevo/membrána. Výsledok viesť ako výskumný prototyp do ukončenia posluchu a CPU merania.

**Výstupy:** source workflow, uložené makrá, expression capability matrix, meraný grain engine alebo presne popísaný stav jeho prototypu, aktualizované patche.

**Brána:** každý podporovaný výraz má preukázateľný účinok na správny hlas; neutrálna hodnota zachová baseline; živé hranie, nahratá expresia a export zodpovedajú rovnakému kontraktu; engine drží vopred určený rozpočet.

**Odporúčanie:** nové matice a parametre pridávať podľa konkrétneho hudobného scenára. Výskum materiálov viesť oddelene od dokončovania základného nástroja.

## 12. Fáza F5 — KOPA, KOREŇ a súhra kicku s basou

**Cieľ:** samostatne použiteľné pluginy a spoločné pracovisko, na ktorom producent počuje ich súhru v konkrétnom patterne.

### Kroky

- [ ] **F5.1:** uzavrieť detailné P0/P1 brány v KOPA/KOREŇ backloge: velocity, MIDI, fallback, tracking, odomknutie, aliasing, gain, mono a CPU.
- [ ] **F5.2:** pre KOPA zmerať click/body/sub/tail pomery pri viacerých velocity, ladenie a transient aj tail na oboch podporovaných runtime cestách.
- [ ] **F5.3:** otestovať krátke MIDI noty, oba trigger režimy, matching note-off, retrigger a voice-steal vrátane sample-level prechodov.
- [ ] **F5.4:** pre KOREŇ rozšíriť korpus o harmonicky bohaté basy, glissando, kick nad basou a nejednoznačný vstup. Zmerať chybu, lock/unlock a ústup syntézy pri strate istoty.
- [ ] **F5.5:** v spoločnom view vybrať konkrétne kick a bass tracky, slučku a cieľ: punch, zachovanie subu, priestor pri nástupe alebo telefónna čitateľnosť.
- [ ] **F5.6:** pripraviť ohraničené návrhy existujúcimi ovládačmi: dĺžka tela kicku, obálka basy, cielené ducking nastavenie a harmonický charakter KOREŇA.
- [ ] **F5.7:** všetky varianty porovnať pri zrovnanej hlasitosti v patterne aj mono fold-down. PHONE CHECK zostáva iba monitorovací filter.
- [ ] **F5.8:** po F1/F2 preveriť použitie vlastného transientu ako KOPA click vrstvy: asset referencia, obálka, ladenie podľa zmyslu zdroja a kompatibilita presetov.
- [ ] **F5.9:** vybraný návrh použiť ako jeden command; zmeny časovania alebo samotných nôt musia byť viditeľnou súčasťou návrhu.

**Výstupy:** dokončené samostatné pluginy, spoločný low-end náhľad, meracie reporty a malé série odlišných kick/bass nastavení.

**Brána:** KOPA a KOREŇ fungujú nezávisle; neistý tracker nevytvorí neodôvodnený tón; mono a sub zostávajú v deklarovaných hraniciach; porovnanie aj prijatie sa dajú zopakovať a vrátiť.

**Odporúčanie:** fázu a prekryv hodnotiť v čase nad konkrétnymi notami a obálkami. Jediný globálny posun nemôže reprezentovať všetky výšky a glissandá. KOREŇ spracúva basový vstup; generovanie základnej basovej linky zostáva úlohou nástroja.

## 13. Fáza F6 — Afterimage

**Cieľ:** zvolený zvuk zanechá kontrolovanú hudobnú stopu, ktorá sa vhodne rozvinie v aranžmáne.

### Prvý rozsah

Začať dvoma receptmi: **harmonický dozvuk z konkrétneho zachyteného úseku** a **rytmicky pretvorená ozvena**. Použiť existujúce priestorové a rezonančné nástroje tam, kde plnia požadovanú úlohu.

### Kroky

- [ ] **F6.1:** v ADR zvoliť prvú reprezentáciu: ohraničený zachytený zdroj s receptom a bežná editovateľná vrstva/klip v projekte. Náhľad môže byť dočasný, prijatý výsledok musí mať uložené podklady.
- [ ] **F6.2:** používateľ vyberie zdroj, úsek, dĺžku pamäte a umiestnenie. Živý capture používa ohraničený buffer; pri prijatí sa potrebné PCM zachová.
- [ ] **F6.3:** navrhnúť jednoduché ciele ako pamäť, vzdialenosť, hustota, farba a miera rytmického pohybu.
- [ ] **F6.4:** kontext čerpať prednostne z nôt, markerov a aranžmánu. Audio odhad harmónie používať len s vyjadrenou neistotou a možnosťou ručného nastavenia.
- [ ] **F6.5:** pripraviť deterministické obálky: ustúpenie pri hustej pasáži, rozvinutie po fráze a zmena na hranici sekcie. Výsledná automatizácia má byť viditeľná a editovateľná.
- [ ] **F6.6:** ochrániť rozsah gainu, feedback, tail a nízke pásmo; predvolené správanie overiť s kickom a basou.
- [ ] **F6.7:** definovať seek, loop, preroll, stop a export tail. Ľubovoľná predchádzajúca live história nesmie byť skrytým predpokladom offline výsledku.
- [ ] **F6.8:** porovnať celú sekciu s vrstvou aj bez nej pri zrovnanej hlasitosti a uložiť použiteľné recepty z Originals zdrojov.

**Výstupy:** Afterimage vrstva, recepty, ovládanie, uložené zdroje a časové obálky, ukážkové frázy a sekcie.

**Brána:** vrstva prežije uloženie a prenos; start zo stredu skladby má deklarované a testované správanie; export pozná všetky potrebné podklady; spätná väzba a pamäť sú ohraničené; posluch potvrdí hudobný účel v sekcii.

**Odporúčanie:** prvý výsledok spraviť priamo inspectovateľný ako vrstvu a automatizáciu. Zložitejšiu adaptáciu pridať po overení jednoduchých receptov.

## 14. Fáza F7 — Performance Scenes

**Cieľ:** producent zahrá premenu zvuku a priestoru a môže ju ďalej editovať.

### Kroky

- [ ] **F7.1:** využiť existujúce scene a automation dátové modely. Rozlíšiť TSAR ORBIT pre jeden patch od Performance Scene nad vybranými trackmi projektu.
- [ ] **F7.2:** navrhnúť prvú plochu so štyrmi uloženými stavmi. Každé mapovanie obsahuje presné target ID, rozsah, krivku, prioritu a správanie pri chýbajúcom cieli.
- [ ] **F7.3:** začať stabilnými spojitými cieľmi: morph, cutoff, hustota alebo množstvo efektu. Rešpektovať význam logaritmických a normalizovaných rozsahov.
- [ ] **F7.4:** diskrétne voľby a prepínanie routingu riešiť explicitným prechodovým pravidlom. Nákladné zmeny enginu alebo zdroja vyžadujú meraný crossfade dvoch vrstiev, prípadne zostanú v ďalšom vydaní.
- [ ] **F7.5:** definovať vzťah scény k existujúcej track automatizácii a lokálnym moduláciám, aby tie isté parametre nemali nejasných súperiacich vlastníkov.
- [ ] **F7.6:** gesto previesť na časované udalosti; používateľské rozhranie iba zobrazuje ich priebeh. Nahraný take uložiť ako bežnú editovateľnú automatizáciu cez command.
- [ ] **F7.7:** pokryť myš, dotyk a klávesnicu; MIDI learn pridať s uloženým mapovaním a podporovanými zariadeniami.
- [ ] **F7.8:** otestovať klik bez pohybu, cancel, reset, stale pointerup, zmenu projektu počas gesta, odstránený target, undo/redo a offline prehratie.

**Výstupy:** performance plocha, mapovania, nahrávanie a editácia pohybu, predvolené scény pre referenčné projekty.

**Brána:** uložený výkon sa prehrá a vyrenderuje; no-op a cancel nemenia projekt; zmena cieľa má kontrolovanú odozvu bez klikov; pri odstránenom parametri projekt zostane čitateľný.

**Odporúčanie:** začať jedným dobre pripraveným beatovým projektom so zmysluplnými mapovaniami. Ukladať zrozumiteľné ciele ako intenzita alebo priestor s viditeľným rozpisom konkrétnych parametrov.

## 15. Fáza F8 — AI producent, ktorý navrhuje a porovnáva

**Cieľ:** existujúci intent a Producer DNA systém pomáha vyberať a upravovať konkrétne zvuky v kontexte skladby.

### Prvé podporované zámery

| Nástroj / oblasť    | Prvý brief                                             | Čo musí zostať chránené                             |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| KOPA                | „Kratší kick, viac punch, zachovaj ladenie.“           | Tónový cieľ a explicitne uzamknuté vrstvy.          |
| KOREŇ               | „808 čitateľnejšia na telefóne, zachovaj sub.“         | Basové noty a deklarovaná sub charakteristika.      |
| TSAR / Sound Seed   | „Vzdušný pad z tohto zdroja, zachovaj jeho charakter.“ | Pôvodný asset a uzamknuté zdrojové skupiny.         |
| Afterimage / sekcia | „Hook nech sa otvorí, bicie a 808 nechaj.“             | Obsah a povolený zvukový rozsah chránených trackov. |

### Kroky

- [ ] **F8.1:** brief preložiť na viditeľný kontrakt: cieľ, povinné zachovanie, povolené zmeny a neistoty. Použiť pravidlá existujúceho AI Producer Contractu.
- [ ] **F8.2:** vytvoriť pluginové adaptéry s whitelistom parametrov, limitmi, validáciou a deterministickými receptmi.
- [ ] **F8.3:** pripraviť malú sadu skutočne odlišných smerov, napríklad blízka úprava, odvážnejšia interpretácia a alternatívna farba. Počet variantov obmedziť podľa ceny náhľadu.
- [ ] **F8.4:** kandidáta vyrenderovať cez spoločný engine; naviazať plán, vypočuté audio, revíziu projektu a verzie modelov/algoritmov na jednu identitu.
- [ ] **F8.5:** kontrolovať chránený obsah aj kauzálny audio kontext. Zmena spoločnej group/master cesty môže ovplyvniť uzamknuté bicie aj bez zmeny ich nôt; musí byť súčasťou povoleného rozsahu.
- [ ] **F8.6:** A/B robiť na rovnakom úseku a pri porovnateľnej hlasitosti. Zobraziť konkrétny rozdiel a podporiť „ani jeden“.
- [ ] **F8.7:** Apply vykoná presne vypočutý a stále platný návrh jedným command krokom. Zmena projektu počas renderu kandidáta zneplatní alebo vyžiada nový náhľad.
- [ ] **F8.8:** Producer DNA viesť ako voliteľnú spravovateľnú pamäť. Rozlíšiť použitie návrhu, obľúbenie a explicitnú preferenciu; odmietnutie všetkých kandidátov neurčuje víťaza.
- [ ] **F8.9:** modely porovnať s deterministickým základom na oddelených session a kandidátoch. Zaznamenať plnenie briefu, preferenciu, neistotu, latenciu, veľkosť a zlyhania.
- [ ] **F8.10:** otestovať chýbajúci model, timeout, poškodený balík a cancel. Zachovať použiteľnú lokálnu cestu bez modelu.

**Výstupy:** obmedzené adaptéry, render/preview integrácia, evaluačný korpus, report porovnania a verzované modelové balíky pre schválené použitia.

**Brána:** povinné obmedzenia release sady majú úplné pokrytie; negatívne prípady nemenia projekt; prijatý návrh zodpovedá náhľadu; modelová aktivácia má doložený prínos oproti baseline. Modelová chyba neprenikne do audio callbacku.

**Odporúčanie:** prvý pilot zúžiť na jeden overený zámer pre každý dokončený nástroj. Rozširovať slovník a zásahy podľa skutočne zlyhávajúcich briefov a hodnotení producentov.

## 16. Fáza F9 — Web, Studio a Qvester Hub

**Cieľ:** používateľ vie nainštalovať podporovaný produkt, získať potrebný obsah a bezpečne ho aktualizovať.

### KYX Web

- [ ] **F9.1:** zachovať lokálny projektový workflow, odložené načítanie workletov a voliteľných assetov/modelov.
- [ ] **F9.2:** overiť cache, storage quota, offline otvorenie a zmenu verzie aplikácie s existujúcim projektom. Veľké voliteľné balíky nesmú automaticky zahltiť precache.
- [ ] **F9.3:** uvádzať skutočne overený browser/device profil a pravdivé obmedzenia vstupného audia.

### KYX Studio

- [ ] **F9.4:** desktopové zvukové a projektové scenáre overiť na konkrétnom balíku, nie iba v dev browseri.
- [ ] **F9.5:** natívne I/O viesť podľa Full DAW roadmapy a príslušných ADR: reálne vstupy/výstupy, sample rate, buffer, monitoring, latencia, odpojenie zariadenia a zotavenie.
- [ ] **F9.6:** third-party hosting rozvíjať samostatne s izolovaným scanom, uložením stavu, automatizáciou, latenciou/PDC, freeze a offline správaním.
- [ ] **F9.7:** každý podporovaný natívny formát a driver profil viazať na aktuálne technické a licenčné rozhodnutie. Samotné Electron balenie nepotvrdzuje natívny audio backend.

### Qvester Studio Audio Hub

- [ ] **F9.8:** implementovať Hub v samostatnom projekte `qvester-studio-audio-hub`; v Pulse Forge definovať a overovať iba potrebný integračný kontrakt.
- [ ] **F9.9:** v katalógu zobraziť KYX a ZYVO s popisom, podporou platformy, changelogom a dokumentáciou nástrojov. Ich dátové a audio kontrakty zostávajú explicitne pomenované.
- [ ] **F9.10:** základné interné KYX pluginy distribuovať v podporovanom základnom balíku; veľké zvukové a natrénované modelové balíky ponúknuť ako samostatné verzované položky s veľkosťou a účelom.
- [ ] **F9.11:** manifest obsahuje verziu, cieľovú platformu, kompatibilitu enginu/receptov/modelových features, veľkosť, hash, pôvod a integritný/podpisový kontrakt.
- [ ] **F9.12:** overiť prerušený download, nedostatok miesta, poškodené dáta a neúspešnú aktiváciu. Nový balík aktivovať až po overení; zachovať poslednú funkčnú verziu.
- [ ] **F9.13:** oddeliť rollback aplikácie od migrácie projektu. Staršia aplikácia nesmie prepísať projekt s nepodporovanou novšou schémou; pôvodná záloha zostane dostupná.

**Výstupy:** aktualizovaná support matrix, release manifesty, integračný kontrakt Hubu, overené inštalačné a aktualizačné scenáre, dokumentácia pluginov a balíkov.

**Brána:** inštalácia, update, zlyhaný update a návrat k funkčnej verzii prejdú na deklarovanej platforme; pôvodné projekty a médiá zostanú obnoviteľné; chýbajúci voliteľný model nezablokuje bežnú tvorbu.

**Odporúčanie:** prvé vydanie Hubu držať pri katalógu, správe balíkov, dokumentácii a spoľahlivých aktualizáciách. Komerčné licencovanie a prípadné offline aktivácie potrebujú vlastný produktový kontrakt.

## 17. Fáza F10 — beta, posluch a vydanie KYX v2

**Cieľ:** technické dôkazy aj práca reálnych producentov potvrdia, že nový celok je spoľahlivý a hudobne hodnotný.

### Kroky

- [ ] **F10.1:** zopakovať referenčné scenáre F0 na release kandidátovi a porovnať zvuk, CPU, pamäť a prvé načítanie.
- [ ] **F10.2:** pripraviť anonymizované hlasitostne zrovnané ukážky: originál, jednoduchý existujúci postup a nový postup. Hodnotiť konkrétnu úlohu každého zvuku.
- [ ] **F10.3:** prvé použiteľnostné kolo navrhnúť s malou skupinou približne 5–8 producentov rôznej skúsenosti. Jeho účelom je nájsť problémy; veľkosť následnej zvukovej evaluácie určiť podľa variability výsledkov.
- [ ] **F10.4:** sledovať čas k prvému použiteľnému výsledku, počet ponechaných rodín, úspešné dokončenie beatu, vratky a miesta, kde sa používateľ stratí.
- [ ] **F10.5:** zverejniť aj neúspešné briefy, odmietnuté patche a hranice podpory. Používateľské skóre neprezentovať ako všeobecný dôkaz pri malej alebo zaujatej vzorke.
- [ ] **F10.6:** uzavrieť relevantné testové, drift, seam, bundle, audio, recovery a bezpečnostné brány. Opravené aj nové zlyhania riadne zohľadniť v suite expectations.
- [ ] **F10.7:** prejsť reálnu inštaláciu, import, nový projekt, uloženie, update, znovuotvorenie, export a podporovaný prenos medzi zariadeniami.
- [ ] **F10.8:** doplniť vstupný návod, tri krátke ukážkové workflowy, popisy pluginov, podporu modelov a zrozumiteľné obmedzenia.
- [ ] **F10.9:** aktualizovať CURRENT-STATE podľa skutočne dodaného povrchu a pripraviť release notes s odkazmi na dôkazy.

**Výstupy:** release kandidát, beta a audio report, support matrix, dokumentácia, ukážkové projekty a verzované distribuované balíky.

**Brána:** povinný zážitok funguje od importu po export, známe release blokery sú uzavreté a verejné tvrdenia zodpovedajú otestovanej podpore. Produktové vydanie sa označí ako v2 až po tomto rozhodnutí.

## 18. Spoločná akceptačná matica

Číselné ciele výkonu a odozvy nových funkcií sa zafixujú vo F0 pred ladením. Existujúce povinné limity z `AGENTS.md` a build skriptov zostávajú v platnosti.

| Oblasť              | Povinný dôkaz                                                                            | Negatívny alebo hraničný prípad                                            |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Používateľský vstup | Test vstúpi cez reálny import, gesto alebo dispatch a overí výsledok.                    | Klik bez pohybu, cancel, stale výsledok, odstránený target.                |
| Zdroj a recept      | Uloženie, opakovanie a prenos vrátia správne médium a interpretáciu.                     | Chýbajúci asset, nesediaci hash, starý algoritmus, quota chyba.            |
| DSP                 | Zvolený parameter mení určenú metriku a podporuje automatizáciu.                         | Extrémy, neplatné dáta, ticho, nejednoznačná výška, zmena sample rate.     |
| Live/offline        | Rovnaký patch, eventy a seed sa porovnajú po zohľadnení deklarovaného začiatku/latencie. | Seek, loop, preroll, tail a reset workletu.                                |
| Zvuková kvalita     | Posluch pri zrovnanej hlasitosti, v mixe aj mono, s konkrétnou otázkou.                  | Prínos zmizne po dorovnaní hlasitosti alebo zhorší chránený sub/transient. |
| Výkon               | Cena najdrahšieho podporovaného nastavenia, percentily, dropouty, heap a uzly.           | Dlhý soak, opakovaný load/unload, viac preview, zatvorený panel.           |
| AI                  | Kontrakt, platný kandidát, audio náhľad, chránené cesty a jedno Apply.                   | Timeout, bez modelu, žiadny vhodný kandidát, zmena projektu počas renderu. |
| Distribúcia         | Overená platforma, integrita balíka a funkčný update/rollback postup.                    | Prerušenie, poškodenie, nedostatok miesta a novšia projektová schéma.      |

Pri nových používateľských seams aktualizovať [seam manifest](../tests/seam-manifest.json). Podľa pravidiel repozitára musí test vstúpiť cez skutočný entry point, overiť no-op a prejsť mutačným overením citlivosti v izolovanom prostredí. Označenie `OPEN` je prípustné pri otvorenej práci; deklarácia `COVERED` musí mať doložené správanie.

### Overovacie príkazy pri implementácii

- Cielené testy dotknutých DSP, commands, persistence a UI seams podľa zmeny.
- `npm run typecheck`, `npm run format:check`, `npm run test`, `npm run test:expectations` a `npm run drift:check` podľa merge gate-u repozitára.
- Príslušný worklet build, `npm run test:browser`, factory preset QA a `npm run build` pri zvukovej integrácii.
- Engine graph a arrangement DOM census podľa dotknutého výkonového rozhrania; zachovať existujúce rozpočty.
- Release a vulnerability gate-y podľa [release readiness reportu](../RELEASE_READINESS_REPORT.md) a aktuálnej support matrix.

Dokumentačná zmena sama osebe nevyžaduje audio ani plný testový beh. Implementačné overovanie sa spúšťa podľa skutočne zmenenej cesty a známeho rizika.

### Životný cyklus procesov pri každej kontrole

Spustiť konečný beh → zaznamenať vlastný proces/session → zachytiť výsledok → ukončiť vlastné dočasné procesy → overiť ich skončenie. Platí to aj pri chybe a timeoute. Používateľské, cudzie a neznáme procesy zostávajú nedotknuté. Použiť pravidlá a schválený `node-gc` nástroj podľa aktuálneho `AGENTS.md`; nevytvárať projektový kill skript ani duplicitný kill zoznam.

## 19. Technická mapa a body rozšírenia

Nasledujúce cesty sú orientačné integračné body overené pri písaní plánu. Zmena ich hranice vyžaduje najprv posúdenie príslušného ADR.

| Oblasť          | Existujúce body                                                                                                                                        | Odporúčaný spôsob rozšírenia                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| TSAR            | `src/tsar/forge.ts`, `params.ts`, `mutations.ts`, `dsp/tsarProcessor.ts`, `src/instruments/tsarNode.ts`, `src/commands/tsar.ts`.                       | Zachovať spoločný interpret udalostí; analýzu a rodiny oddeliť od realtime hlasov.                                  |
| KOPA            | `src/kopa/dsp/kopaProcessor.ts`, `src/instruments/kopaNode.ts`, `src/presets/kopa-factory.ts`.                                                         | Najprv dokončiť kontrakt a merania; nový zdrojový click pripojiť cez F1 assety.                                     |
| KOREŇ           | `src/audio-worklets/bass-harmonic-processor.js`, `bass-harmonic-node.ts`, `src/commands/korenScene.ts`.                                                | Udržať tracker a syntézu vo worklete, plán porovnania mimo callbacku.                                               |
| Rodiny a obsah  | `src/sample-library/`, `src/presets/`, `src/persistence/`.                                                                                             | Nový Sound Seed modul navrhnúť nad existujúcimi médiami a receptami; navrhovaný nový priestor je `src/sound-seed/`. |
| Afterimage      | Existujúce efekty, `src/rendering/`, source kontrakt a automatizácia.                                                                                  | Najprv uložená vrstva s receptom; vlastný procesor iba pre chýbajúcu merateľnú schopnosť.                           |
| Performance     | `src/project-model/scene-performance.ts`, `scene-time.ts`, `automation.ts`, `src/commands/sceneAutomation.ts`, `src/audio-engine/automationBridge.ts`. | Rozšíriť existujúce časovanie a commands; rAF slúži iba na vizuálny priebeh.                                        |
| Note expression | `src/instruments/noteExpressionCapabilities.ts`, scheduler, trigger engine, projektové eventy.                                                         | Podporu deklarovať po konkrétnych nástrojoch a transportoch.                                                        |
| AI              | `src/intent/`, `src/ai/`, `src/intent/audition.ts`, existujúce preference/evaluation moduly.                                                           | Adaptéry produkujú validované plány a kandidátov, prijatie používa command cestu.                                   |
| Platformy       | `desktop/`, release skripty, support matrix a samostatný Hub projekt.                                                                                  | Oddeliť distribučný kontrakt od schopností konkrétneho audio backendu.                                              |

## 20. Rozhodnutia a ADR pred implementáciou

| Rozhodnutie                       | Odporúčané východisko                                                            | Rozhodnúť pred               |
| --------------------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| Source/recept/asset kompatibilita | Zachovať originál, stabilnú identitu, verziu receptu a dostupný odvodený render. | F1 persistence a migrácia.   |
| Audition a Apply                  | Izolovaná cesta, platnosť na revíziu projektu, jedna undoable transakcia.        | F1 preview integrácia.       |
| Afterimage reprezentácia          | Uložený capture/recept a bežná editovateľná vrstva ako prvý rozsah.              | F6 runtime.                  |
| Performance automatizácia         | Existujúca hudobná časová os s explicitnou prioritou voči ostatnej modulácii.    | F7 nahrávanie.               |
| Granular kompatibilita a výkon    | Ohraničené hlasy/grainy, eventové seedy, zmerané staré aj nové patche.           | F4 výmena zdrojového režimu. |
| AI zásahy do chráneného obsahu    | Kontrakt zahŕňa obsah aj povolený audio routing a spoločné processing cesty.     | F8 adaptér.                  |
| Modelové a obsahové balíky        | Hash, verzia, kompatibilita, zrušiteľný download a overená aktivácia.            | F9 Hub integrácia.           |
| Natívne audio a hosting           | Rozhodnutie podľa nameraného backendu, licencie a support matrix.                | Konkrétny Studio míľnik.     |

Nové ADR sa čísluje podľa aktuálneho stavu repozitára až pri otvorení konkrétneho rozhodnutia. Tento plán nerezervuje čísla ani nepredstiera schválenú technológiu natívneho backendu.

## 21. Pracovné časovanie pre rok 2027

Nasledujúce obdobia určujú zámerné poradie. Kapacitný odhad sa spresní po F0 a úplnom prototype F2; dokončenie technických a posluchových brán rozhoduje o vydaní.

| Obdobie     | Hlavné sústredenie                                                              | Výsledok pre rozhodnutie                                                        |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Zvyšok 2026 | F0, kontrakty F1 a malý F2 prototyp.                                            | Dôkaz, že zdroj → rodina → beat → export stojí za hlavný smer v2.               |
| Q1 2027     | Dokončenie source/audition vrstvy, Sound Seed a prvá Originals session.         | Použiteľný vlastný materiál a opakovateľné zvukové rodiny.                      |
| Q2 2027     | TSAR výrazový engine, KOPA/KOREŇ a prvý Afterimage rozsah.                      | Nástroje fungujú samostatne aj v hudobnom kontexte.                             |
| Q3 2027     | Performance Scenes, obmedzený AI pilot a uzavretá beta.                         | Zahraná premena, meraný prínos návrhov a spätná väzba producentov.              |
| Q4 2027     | Hardening, dokumentácia, podporované distribučné profily a release rozhodnutie. | Vydanie iba toho rozsahu, ktorý prešiel technickými aj používateľskými bránami. |

Natívne I/O a hosting sledujú vlastnú kapacitu a hardware gate-y v súlade s Full DAW roadmapou. Výskum materiálov môže pokračovať po základnom vydaní. Pri sklze najprv zúžiť experimentálny rozsah a ponechať celý základný používateľský priechod dokončiteľný.

## 22. Riziká a odporúčané reakcie

| Riziko                                       | Skorý signál                                                     | Reakcia                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Veľa nových funkcií bez použiteľného celku   | Každý modul má demo, ale 45-sekundový projekt sa nedá dokončiť.  | Uprednostniť integračný scenár a dokončiť jednu celú cestu.                       |
| Rodina znie ako generický preset             | Posluch nerozpozná súvislosť so zdrojom.                         | Upraviť recept alebo vhodnosť zdroja; pomenovať zachovávanú vlastnosť.            |
| Dojem kvality spôsobuje hlasitosť            | Preferencia zmizne po dorovnaní levelu.                          | Použiť kontrolovaný A/B a oddelený audition gain.                                 |
| Granular alebo scény prekročia CPU           | Dropouty pri plnej polyfónii alebo prechode vrstiev.             | Ohraničiť aktívne hlasy/grainy, zjednodušiť prechod a zmerať freeze/render cestu. |
| Nestabilná basová syntéza                    | Oktávové skoky, pumping, strata mono subu.                       | Zlepšiť istotu a release trackera, obmedziť syntézu a overiť vhodnosť vstupu.     |
| Zvuk sa po update zmení                      | Starý projekt používa nový význam receptu alebo engine režimu.   | Verzionovať kontrakt, zachovať render/interpret a pokryť staré fixture projekty.  |
| AI poruší zachovanie skladby                 | Zmení sa chránený obsah alebo jeho spoločná processing cesta.    | Kontrolovať celý povolený rozsah a zneplatniť kandidáta pred Apply.               |
| Preview poškodí prácu                        | Výber, cancel alebo neskorý worker zapíše do projektu.           | Izolovať náhľad, revízie a transakčné prijatie; vstúpiť testom cez skutočný seam. |
| Nové audio sa nedá distribuovať              | Chýbajú práva alebo dohľadateľný pôvod.                          | Viesť asset manifest od nahrávania a publikovať iba vyriešené položky.            |
| Hub/update poškodí kompatibilitu             | Starý runtime otvorí novšiu schému alebo načíta nesprávny model. | Overiť kompatibilitu pred aktiváciou a zachovať obnoviteľné zálohy.               |
| Overovanie zaberie zariadenie aj po skončení | Zostanú test runnery, workery alebo preview runtimy.             | Vlastníctvo, konečné behy a povinné overené ukončenie podľa AGENTS.md.            |

## 23. Najbližší realizačný rad

Nasledujúci zoznam je vstupná fronta na začatie programu. Každá položka má vytvoriť malý reviewovateľný celok a aktualizovať príslušnú fázu.

1. **V2-001 / F0:** zafixovať aktuálny baseline, referenčné projekty a oddeliť historické výsledky od nového merania.
2. **V2-002 / F0:** uzavrieť existujúce P0, ktoré bránia spoľahlivému TSAR/KOPA/KOREŇ náhľadu a exportu.
3. **V2-003 / F1:** napísať source/recept/asset a kompatibilitný ADR.
4. **V2-004 / F1:** dodať uloženie zdroja, zrušiteľnú prípravu a prenos so všetkými potrebnými médiami.
5. **V2-005 / F1:** dodať spoločný náhľad s Cancel/no-op/stale ochranou a jedným Apply/Undo krokom.
6. **V2-006 / F2:** vytvoriť prvé tri deterministické interpretácie jedného vhodného zdroja a porovnať ich v beate.
7. **V2-007 / F2:** zopakovať prototyp na ďalších zdrojových triedach a dokončiť 45-sekundový uložený/exportovaný scenár.
8. **V2-008 / F3:** z poznatkov prototypu vytvoriť konkrétny nahrávací brief a prvú Originals rodinu.
9. **V2-009 / F4–F5:** rozšíriť expression/grain a kick/bass workflow podľa zafixovaných rozpočtov a meraných medzier.
10. **V2-010 / F6:** dodať prvý uložený Afterimage recept; následne nad stabilnými cieľmi otvoriť Performance Scenes a AI adaptéry.

## 24. Evidencia postupu a definícia dokončenia

**Počiatočný stav pri vytvorení dokumentu:** produktový smer schválený; nové fázy a checklisty v tejto roadmape sú otvorené. Existujúce dodávky zostávajú zdokumentované vo svojich backlogoch a `CURRENT-STATE.md`.

Pri každom uzavretom celku doplniť pod príslušnú fázu alebo do odkazovaného auditu tento záznam:

```text
ID úlohy / fázy:
Stav: otvorené | implementované | overené | experiment ukončený
Commit / build / dátum:
Konkrétny používateľský priechod:
Zmenené rozhranie, uložený tvar alebo DSP kontrakt:
Automatické dôkazy vrátane negatívnych prípadov:
Audio a používateľské dôkazy:
Platformy, zariadenia a známe obmedzenia:
Stav procesov po overovaní:
Odkaz na audit / fixture projekt / report:
Nasledujúca závislá úloha:
```

Fáza je dokončená, keď jej výstup funguje cez skutočné vstupné rozhranie, prežije uloženie a znovuotvorenie, zachová deklarovaný export, rešpektuje undo/cancel a má zachytené relevantné technické aj posluchové dôkazy. Výskumný prototyp môže byť úspešne ukončený aj rozhodnutím nezaradiť ho do vydania, ak prínos nevyváži jeho cenu.

## 25. Podklady a súvisiace rozhodnutia

### Interné záväzné podklady

- [ADR 0014 — full DAW scope](adr/0014-full-daw-scope.md): spoločná vízia Web/Studio a samostatné brány natívnych schopností.
- [ADR 0023 — TSAR hybrid engine](adr/0023-tsar-hybrid-engine.md): lazy worklet a spoločný live/offline interpret udalostí.
- [ADR 0034 — KOREŇ](adr/0034-koren-bass-harmonic-exciter.md), [ADR 0035 — KOPA](adr/0035-kopa-kick-designer.md) a [ADR 0036 — KOPA harmonics](adr/0036-kopa-bass-harmonic-layer.md): samostatné úlohy nástrojov.
- [ADR 0048 — náklady audio grafu](adr/0048-scale-per-track-graph-cost.md) a [ADR 0049 — note-event editor](adr/0049-piano-roll-note-event-editor.md): výkonové a výrazové integračné hranice.
- [ADR 0011 — desktop update](adr/0011-desktop-auto-update.md): existujúci základ aktualizácie desktopu.
- [NEW-EFFECT-CHECKLIST.md](NEW-EFFECT-CHECKLIST.md): parameter route a DSP QA.
- [WEB-STUDIO-SUPPORT-MATRIX.md](WEB-STUDIO-SUPPORT-MATRIX.md): overený rozsah platforiem.
- [MULTI-AGENT-GUARDRAILS.md](MULTI-AGENT-GUARDRAILS.md): bezpečná práca na zdieľanom strome a čisté overovanie.

### Externé produktové referencie

Overené pri príprave vízie 2026-10-17. Slúžia na posúdenie existujúcich prístupov; nepreukazujú jedinečnosť budúceho KYX.

- [Sonic Charge Synplant / Genopatch](https://soniccharge.com/synplant): už existuje prevod audio predlohy na synth patche; KYX má preto overovať hodnotu celej editovateľnej rodiny a jej použitia v skladbe.
- [Bitwig The Grid](https://www.bitwig.com/the-grid/): modulárne nástroje, efekty a notové spracovanie sú zavedený smer; KYX potrebuje vlastný prístup k zdroju a hrateľnému výsledku.
- [Ableton Sound Similarity Search](https://help.ableton.com/hc/en-us/articles/11386675465628-Sound-Similarity-Search-FAQ): vyhľadanie podobného materiálu je užitočný základ; KYX v2 má pridať počuteľnú tvorbu a kontrolované porovnanie v kontexte projektu.

Nosnou prioritou programu je dokončený priechod **vlastný zdroj → osobitá rodina → výrazové hranie → aranžmán → spoľahlivý export**. Každá ďalšia funkcia má mať v tomto priechode doloženú hudobnú úlohu.
