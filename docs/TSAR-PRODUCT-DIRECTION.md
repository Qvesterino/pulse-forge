# TSAR — produktová vízia a ďalšie vlny vývoja

**Stav:** produktový smer a navrhovaný roadmap · **Aktualizované:** 2026-10-08

- **Aktuálna implementácia:** T0–T7 dodané; pozri [TSAR-ROADMAP.md](TSAR-ROADMAP.md) a [CURRENT-STATE.md](CURRENT-STATE.md).
- **Poradie implementácie ďalších fáz:** [TSAR-IMPLEMENTATION-ROADMAP.md](TSAR-IMPLEMENTATION-ROADMAP.md).
- **Architektonické rozhodnutie:** [ADR 0023](adr/0023-tsar-hybrid-engine.md).

## Produkt jednou vetou

**TSAR mení zvuk, sample alebo hudobný nápad na hrateľný nástrojový patch, ktorý možno tvarovať, hrať a exportovať priamo v KYX.**

TSAR má byť charakteristický nástroj KYX: hlboký, ale prístupný hybridný engine na tvorbu zvuku, zabudovaný do workstationu a dostupný v prehliadači. „Plugin“ tu znamená nástroj KYX. TSAR nie je VST3 ani AU plug-in a nezávisí od cloudovej sample služby.

Cieľom je rozpoznateľný nástroj s uceleným workflowom, nie čo najdlhší zoznam ovládačov. Producent má vedieť začať so zvukom, pochopiť, čo s ním TSAR urobil, pretvoriť ho po svojom a použiť výsledok v skladbe bez rozdielu medzi prehrávaním a exportom.

## Skúsenosť, ktorú chceme vytvoriť

1. **Začať rýchlo.** Vybrať hotový hrateľný preset, začať s pripraveným syntetickým zdrojom alebo importovať zvuk cez Sample Forge.
2. **Vytvarovať dva súvisiace zdroje.** Zmiešať Source A a B, vybrať spôsob prehrávania každého zdroja a formovať výsledný patch obálkami, filtrami, ladením, moduláciou, subom a šumom.
3. **Rozumieť zvuku.** Vidieť zdroj a wavetable, skontrolovať merania Forge a vypočuť si zmeny pred ich potvrdením.
4. **Hrať výrazovo.** Hrať cez piano roll alebo MIDI a používať glide, moduláciu, pressure a arpeggiator, aby patch neostal statický.
5. **Dokončiť skladbu.** Používať TSAR v existujúcom workflowe KYX vrátane príkazov, undo, aranžmánu, mixu a exportu. Export má zachovať zvuk počutý pri prehrávaní.

## Čo je hotové dnes

Súčasná implementácia je východiskový stav pre ďalší vývoj, nie celá produktová vízia.

- Vlastný AudioWorklet engine so 16 hlasmi a kradnutím najstaršieho hlasu, zdrojmi A a B, spoločným morphom, subom, seedovaným šumom, obálkami a filtrami pre každý zdroj, velocity, glide, tónovým tilt, drive a stereo šírkou.
- Tri režimy zdroja v každom slote: prehrávanie samplu, wavetable a granulárny režim so skenovaním pozície. Granulárny režim dnes skenuje PCM cez okno; ešte to nie je plný cloud prekrývajúcich sa grainov.
- Štyri sloty modulačnej matice, LFO a arpeggiator bežiaci vo worklete s režimami up, down, up/down, order a deterministickým random.
- Sample Forge importuje zvuk, podľa možností odhadne koreňový tón, klasifikuje zdroj, vyberie režim prehrávania a navrhne obálku. Prizná neistotu a odmietne tichý vstup.
- Editor v docku s ovládaním zdrojov, moduláciou, arpeggiatorom, Forge a filtrovateľnou bankou 48 factory presetov s parametrami.
- TSAR worklet načítavaný len pri potrebe a predvyplnený event queue pre offline render. Realtime a offline používajú rovnaký DSP procesor a interpret udalostí.

Dodaná implementácia a jej merané brány sú zaznamenané v [TSAR-ROADMAP.md](TSAR-ROADMAP.md). Počty v celom produkte patria do [CURRENT-STATE.md](CURRENT-STATE.md).

## Navrhované ďalšie vlny vývoja

Nasledujúce body sú produktové priority na plánovanie. Opisujú zamýšľaný vývoj, nie hotové funkcie ani schválený termín vydania.

### T8 — Spoľahlivý prvý zvuk

Najprv odstrániť medzery medzi editorom, stavom projektu a audio runtimeom.

- Zabezpečiť, aby nová TSAR stopa aj každý factory preset vydali zamýšľaný zvuk bez skrytého nastavovania. Rozhodnúť, či bude predvoleným zdrojom vstavaný oscilátor/wavetable alebo malá knižnica licencovaných samplov.
- Pri zmene samplu Source B počas otvoreného projektu aktualizovať bežiaci runtime rovnako ako pri Source A.
- Skontrolovať viditeľné parametre voči DSP. Ovládače ako Drift a LFO Sync zapojiť, alebo ich dočasne odstrániť. Názvy musia vystihovať, čo procesor skutočne mení.
- Overiť načítanie workletu pri pridaní TSAR do už otvoreného projektu a podľa potreby prepnutie z dočasného fallbacku na plný runtime.
- Pridať browser kontrolu, ktorá porovná zmysluplný TSAR zvuk pri realtime prehrávaní a offline exporte. Samotná kontrola hlasitosti nepotvrdzuje paritu.

**Kritériá prijatia:** čistá TSAR stopa aj všetky factory presety sú počuteľné; zmena ktoréhokoľvek zdroja sa prejaví v realtime; každý viditeľný ovládač má merateľný účinok alebo je jasne nedostupný; prehrávanie aj export používajú zamýšľanú TSAR cestu.

### T9 — Plnohodnotný granulárny zdroj

Nahradiť dnešné skenovanie riadeným grain enginom pre textúry aj ladený materiál.

- Navrhnúť veľkosť a hustotu grainov, pozíciu, ladenie, jitter a tvar okna zrozumiteľne pre hudobnú tvorbu.
- Seedovať náhodné rozhodnutia pre každý hlas, aby projekt aj export zostali reprodukovateľné.
- Ohraničiť alokácie, cenu hlasu a prácu v každom audio kvante; pred rozšírením funkcie zmerať cieľový polyfónny a CPU limit.
- Zachovať praktickú hodnotu samplu a wavetable; granular má byť ďalším spôsobom práce so zdrojom.

**Kritériá prijatia:** golden audio vectors pokryjú ladený, šumový aj transientný materiál; worklet zostane konečný a ohraničený pri podporovanom počte hlasov; realtime a offline budú rešpektovať rovnaké udalosti a seedy.

### T10 — Modulácia a výrazové ovládanie

Dosiahnuť, aby TSAR reagoval na hranie, automatizáciu a MIDI kontroléry.

- Rozhodnúť, či sa modulačná matica rozšíri zo štyroch na osem slotov, a udržať schému, UI a DSP v súlade.
- Dokončiť synchronizáciu LFO na tempo, Drift a pressure-to-timbre, alebo odstrániť ovládače, ktoré do finálneho návrhu nepatria.
- Zabezpečiť, aby pan zdrojov a ciele modulácie robili to, čo naznačujú ich názvy.
- Preveriť MIDI pressure a MPE od vstupu až po nahrávanie, prehrávanie a export.

**Kritériá prijatia:** každý routing sa dá otestovať známym vstupom a cieľom; MIDI aj automatizácia menia práve hrajúce hlasy; rovnaký výkon sa správne vyrenderuje offline.

### T11 — Vizuálne pracovisko na tvorbu zvuku

Ukázať materiál, s ktorým TSAR pracuje, a uľahčiť vypočutie aj vrátenie dôležitých zmien.

- Pridať zobrazenie waveformu a wavetable a jasne označiť chýbajúci alebo nenačítateľný zdroj.
- Pridať editáciu obálky a odozvy filtra cez rovnaké príkazy a undo ako ostatné ovládače.
- Umožniť vypočuť plán Forge a porovnať A/B alebo preset ešte pred potvrdením.
- Zachovať použiteľnosť panela pri úzkej šírke, s klávesnicou aj dotykovým ovládaním.

**Kritériá prijatia:** vizualizácia zodpovedá načítanému zdroju a parametrom projektu; preview nemení projekt; Apply vykoná jeden undoable príkaz.

### T12 — Koherentná a hrateľná knižnica

Rozšíriť 48 presetov až po stabilizovaní zdrojov a správania presetov.

- Kurátorovať zvuky podľa hudobnej roly: bass, lead, pad, keys/pluck, textúry a efekty.
- Každý patch urobiť samostatne použiteľným alebo jasne uviesť potrebný zdroj. Factory preset, ktorý funguje až po skrytom ručnom nastavení, nie je dokončený preset.
- Pri pribalenom audiu zaznamenať pôvod a licenciu. Používateľské importy ponechať v lokálnom workflowe.
- Uprednostniť menšiu banku s odlišnými a užitočnými zvukmi pred blízkymi variáciami. Cieľ 100+ presetov zvážiť po definovaní audition a loudness brán.

**Kritériá prijatia:** každý ponúkaný preset prejde kontrolou počuteľnosti, hlasitosti, metadát a schémy parametrov; posluchová kontrola potvrdí, že susedné presety majú odlišný dôvod na použitie.

## Pravidlá produktu

- **Realtime DSP patrí do AudioWorkletu.** Hlasový engine nepresúvať do Reactu ani časovača na hlavnom threade.
- **Jedna zvuková cesta pre prehrávanie aj export.** Offline riešenie musí zachovať TSAR procesor a význam audio udalostí.
- **Pravdou je stav projektu.** Zmeny v UI idú cez príkazy a podporujú undo/redo.
- **Analýza priznáva neistotu.** Forge môže povedať, že koreň nevie určiť; nesmie si ho vymyslieť.
- **Každý zobrazený ovládač musí fungovať.** Každý parameter testovať signálom, ktorý umožní jeho účinok zmerať aj počuť.
- **Boot cost zostáva ohraničený.** Projekty bez TSAR nemajú sťahovať jeho worklet ani voliteľné zvukové assety.
- **Licencie kontrolovať pred pribalením samplov.** Používateľské sample zostávajú lokálne; obsah factory banky musí mať zdokumentované práva.

## Rozhodnutia pred príslušnou vlnou

- Majú factory presety používať syntetické wavetable, pribalené licencované sample alebo ich kombináciu?
- Čo presne znamená „plný granular“ v TSAR a aký CPU limit platí pre 16 hlasov pri 48 kHz?
- Oplatí sa osem slotov modulačnej matice vzhľadom na zložitosť panela a presetov?
- Má TSAR dostať malú vlastnú efektovú sekciu, alebo majú všetky dokončovacie efekty zostať v track racku KYX?
- Ktoré MIDI kontroléry a zdroje pressure patria do prvej verzie výrazového ovládania?

Tieto rozhodnutia vyriešiť v príslušnom implementačnom pláne alebo ADR pred zmenou projektovej schémy či DSP kontraktu.
