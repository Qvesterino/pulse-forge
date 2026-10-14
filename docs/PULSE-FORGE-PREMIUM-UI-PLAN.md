# Pulse Forge Premium UI — implementačný brief

> **Produkt:** KYX  
> **Repo:** Pulse Forge  
> **Stav:** Implementácia prebieha — responzívny shell a prvý spoločný vizuálny rez sú zapracované; čaká ich vizuálna kontrola a nadväzujúce panely.  
> **Aktualizované:** 2026-10-14

Tento dokument premieňa dizajnový audit pracovnej plochy na konkrétny plán
ďalších iterácií. Je praktickým briefom pre implementáciu; dlhodobý smer a
históriu rozhodnutí naďalej opisuje [`ROADMAP-UI-2027.md`](ROADMAP-UI-2027.md)
a layoutové pravidlá [`ADR 0036`](adr/0036-ui-layout-state.md).

## Cieľ

Posilniť prémiový pocit KYX cez jasnú hierarchiu, disciplinovaný spacing,
čitateľné ovládanie a konzistentné panely. Zachovať schválenú identitu
**Qvester Signal Glass / KYX Pulse**: strieborné šasi, matnú pracovnú plochu,
jantárový pulz výberu, zelené prehrávanie, červené nahrávanie a farby stôp.

Prémium má vzniknúť presnosťou a súdržnosťou rozhrania. Nepridávať lesk ani
dekoráciu na husté pracovné plochy bez funkčného dôvodu.

## Východiská z vizuálnej kontroly

Pozorovania vychádzajú z DAW pri **1440 × 900** a z responzívnej kontroly pri
**800 × 900**. Pred implementačnou vlnou treba rovnaké stavy znovu zachytiť bez
prechodných onboardingových hlášok.

- Kompaktná hlavička (42 px) a dock chrome (40 px spolu, z toho 30 px taby)
  zlepšili pomer pracovnej plochy a chrome. Tieto rozmery sú vhodným základom.
- Hlavné pracovné plochy sú pokojné, no mnohé popisky, pomocné texty a
  ovládacie prvky používajú podobnú drobnú typografiu. Hierarchia je slabšia,
  než by zodpovedalo množstvu funkcií.
- Pattern toolbar združuje veľa príkazov s podobnou vizuálnou váhou. Zoskupenie
  podľa úlohy a jeden jasný primárny príkaz by zlepšili orientáciu.
- Časté tenké orámovania a vnorené plochy vytvárajú miestami dojem technického
  ovládacieho panelu. Povrchy potrebujú menej vrstiev a dôslednejšie odsadenia.
- Mastering panel obsahuje dlhšie vysvetlenia a viacero rovnako zvýraznených
  metrík. Výsledky a ďalší krok sa dajú spraviť ľahšie skenovateľnými.
- Pri šírke 800 px sa časť ovládania hlavičky dostáva mimo viewport. Hlavička
  potrebuje skutočný kompaktný režim, nie iba menšie odsadenia.
- Jantárový a strieborný podpis je už prítomný. Ďalší prínos je v konzistencii
  jeho použití v stavoch, typografii a spoločných komponentoch.

## Zásady vizuálneho systému

1. **Hierarchia pred ozdobou.** Najprv upratať nadpisy, akcie a pracovné
   skupiny; gradient a glow používať len ako jemný materiálový podpis.
2. **Matné dátové plochy.** Sekvencer, aranžmán, mixer a husté editory zostávajú
   pokojné a vysoko kontrastné. Sklo zostáva na chrome a vybraných stavoch.
3. **Farba nesie význam.** Jantár = výber/hlavná akcia; zelená = playback;
   červená = recording; farba stopy zostáva identitou hudobného materiálu.
4. **Jeden spacing a typografický rytmus.** Zjednotiť mierku naprieč panelmi a
   používať malé technické popisky len pre metadata, nie pre hlavné ovládanie.
5. **Denzita podľa kontextu.** Bežné ovládanie má byť čitateľné; husté sekcie
   môžu mať kompaktný variant. Zmenšenie všetkého naraz nie je riešenie.
6. **Stavy sú rovnako dôležité ako vzhľad.** Hover, selected, disabled,
   focus-visible, playback, recording a reduced-motion musia mať konzistentné
   a rozlíšiteľné správanie.

## Návrhové hodnoty na overenie

Tieto hodnoty sú východiskové návrhy. Pred rozsiahlym použitím ich treba
porovnať s existujúcimi tokenmi a theme systémom, aby nevznikla druhá paralelná
sústava.

| Oblasť               | Návrh                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| Spacing              | 4 / 8 / 12 / 16 / 24 px; 32 px iba pre veľké oddelenie sekcií                 |
| Bežný text ovládania | cieľovo 12–13 px                                                              |
| Sekundárne popisky   | 10–11 px; menšie iba pre nepodstatné metadata                                 |
| Nadpis panelu        | približne 15–17 px, konzistentne naprieč panelmi                              |
| Dense control        | zachovať kompaktný variant okolo 24 px                                        |
| Štandardná akcia     | približne 28–32 px podľa roly a hustoty                                       |
| Rohy                 | malý 4 px, základný 6–8 px, veľký 10–12 px                                    |
| Povrchy              | pracovná plocha, panel a zvýraznený povrch; vyhnúť sa ďalším náhodným vrstvám |

## Priority a pracovné vlny

### P0 — Opraviť responzívny shell

- Pri úzkych šírkach preskupiť TopBar tak, aby transport a názov projektu
  zostali použiteľné a vedľajšie akcie prešli do existujúceho overflow menu.
- Zachovať desktopovú kompaktnosť 42 px a bezpečné zväčšenie pre dotykové
  ovládanie a safe-area insety.
- Skontrolovať správanie zbaleného Browser a Inspector panelov pri každom
  breakpointe.

**Hotovo, keď:** pri 1440, 1280, 1024, 800 a 390 px nie je horizontálny
overflow, odrezaná hlavná akcia ani nedostupný transport.

### P1 — Upevniť základy systému

- Zmapovať existujúce CSS/theme tokeny a rozhodnúť, čo sa rozšíri namiesto
  vytvorenia duplicitných tokenov.
- Zjednotiť spacing, textové úrovne, výšky controls, rohy a úrovne povrchov.
- Spísať stavovú maticu pre primary/secondary/tertiary, selected, hover,
  disabled a keyboard focus.
- Pri čitateľnosti najprv upraviť sekundárne a pomocné texty; nepoužívať
  univerzálne zväčšenie hustých editorov.

### P1 — Usporiadať shell a hlavné akcie

- Zjednotiť panelové hlavičky: názov, kontext a akcie majú stabilné miesto.
- Zoskupiť toolbar akcie podľa úlohy; určiť primárnu akciu pre každú plochu.
- Zachovať hustotu DAW, no znížiť počet rovnako výrazných tlačidiel a vnorených
  rámikov.
- Dock tabs ponechať kompaktné; vylepšiť čitateľnosť názvov a jednoznačnosť
  aktívnej záložky.

### P2 — Aplikovať panel po paneli

Poradie vychádza z frekvencie a vizuálnej dôležitosti:

1. TopBar, dock tabs, track tabs a Pattern toolbar.
2. Sequencer a Inspector.
3. Mixer a Devices.
4. Arrangement, MOD, DICE, INTENT, EXP, MASTER, MIDI a Reference.

Každý panel prejsť samostatne cez jeho bežný aj hustý stav. Spoločné CSS a
komponenty zaviesť postupne, bez hromadného prepisu všetkých panelov naraz.

### P2 — Dotiahnuť obsah a interakcie

- V Masteringu zviditeľniť výsledky a odporúčaný ďalší krok; dlhší vysvetľujúci
  text presunúť do menej dominantnej alebo rozbaľovacej vrstvy.
- Zjednotiť krátke prechody približne v rozsahu 120–180 ms pre hover a zmenu
  výberu; rešpektovať `prefers-reduced-motion`.
- Urobiť focus, disabled a selected stav zreteľný aj bez samotnej farby.
- Overiť kontrast popisov, čitateľnosť čísel a dostupnosť ikonových tlačidiel.

## Vizuálna QA matica

Používať stabilné projekty/stavy a rovnaké rozmery pri porovnaní pred/po.
Odstrániť onboarding toast a iné prechodné overlaye zo screenshotov.

| Viewport   | Čo skontrolovať                                                 |
| ---------- | --------------------------------------------------------------- |
| 1440 × 900 | primárny desktop: proporcie, hierarchia, hustý sequencer + dock |
| 1280 × 800 | pracovná plocha, čitateľnosť a dostupnosť hlavičky              |
| 1024 × 768 | kompaktný shell, zbalenie panelov a dostupné akcie              |
| 800 × 900  | tabletový layout, dock taby a horizontálny overflow             |
| 390 × 844  | úzky shell, touch targety a zbalené bočné panely                |

## Kritériá dokončenia

- Hlavné ovládanie a texty sa dajú rýchlo nájsť a prečítať pri bežnom
  pracovnom zoome; drobný text je vyhradený metadata.
- TopBar, panelové hlavičky, dock tabs a toolbary používajú rovnakú logiku
  typografie, odsadenia a stavov.
- Každý panel má rozpoznateľnú primárnu akciu; sekundárne príkazy sú
  zoskupené a neprekrikujú obsah.
- Canvas zostáva matný. Silver/amber akcenty označujú chrome a interakciu;
  playback, recording a track colors si zachovávajú svoj význam.
- Pri všetkých rozmeroch v QA matici nie je horizontálne orezanie ani
  nefunkčné rozloženie ovládania.
- Screenshoty kľúčových stavov sú vizuálne skontrolované a zmeny rešpektujú
  existujúce theme, layout, accessibility a repo invariants.
- Pred dokončením implementácie prejdú príslušné repo quality gates z
  `AGENTS.md`; testy sa vyberajú podľa zmenených plôch.

## Implementačné hranice

- Tento brief nemení audio engine, project model, command flow ani správanie
  prehrávania.
- Neodstraňovať existujúce možnosti ani neprenášať funkcie bez samostatného
  UX rozhodnutia.
- Zachovať používateľské accent témy a význam farieb.
- Dodržať CSS import poradie a layoutové pravidlá z ADR 0036; nový štýl musí
  byť aditívny a nesmie potichu prebiť responzívne vlastníctvo breakpoints.

## Odporúčaný prvý implementačný rez

Začať P0 responzívnym TopBarom a P1 základmi typografie/spacingu. V tom istom
vizuálnom reze zjednotiť iba TopBar, dock tabs, panelové hlavičky a Pattern
toolbar. Po overení na QA matici rozšíriť spoločné riešenie na ďalšie panely.

## Priebežný stav implementácie

### Zapracované 2026-10-14

- TopBar pri šírke do 1100 px prechádza na dva riadky; úzky režim ponecháva
  nahrávanie, prehrávanie, stop a BPM priamo dostupné a druhotné transportné
  akcie presúva do existujúceho overflow menu.
- Projekty majú v úzkom režime kompaktné tlačidlo návratu, zmenšený status
  ukladania a transport dostáva bezpečnú horizontálnu rezervu pre locatory.
- Pribudla aditívna vrstva `29-premium-hierarchy.css`, ktorá používa existujúce
  tokeny: posilňuje názvy panelov, zjednocuje dock/track/pattern záložky,
  zjednodušuje vizuálne skupiny Pattern toolbaru a zlepšuje čitateľnosť
  výsledkov Masteringu.
- `GEN` je jediná zvýraznená hlavná akcia v Pattern toolbar skupine; ostatné
  príkazy zostávajú dostupné a nemenia svoje správanie.
- Pridaný je test úzkeho TopBaru vrátane prístupu k odloženému count-in.

### Zostáva

- Vizuálne prejsť všetkých päť veľkostí z QA matice vrátane zbalených bočných
  panelov a bežných overlayov.
- Podľa screenshotov doladiť spacing a panelové hlavičky bez hromadného
  prepisu obsahu Sequencera, Mixera, Arrangementu a ďalších pracovných plôch.
- Spustiť príslušné typové, formátovacie a UI quality gates a zapísať výsledok.
