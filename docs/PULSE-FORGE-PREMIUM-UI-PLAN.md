# Pulse Forge Premium UI — implementačný brief

> **Produkt:** KYX  
> **Repo:** Pulse Forge  
> **Stav:** Implementácia prebieha — shell a vybrané panelové vlny sú zapracované; plné/husté stavy aj živá vizuálna kontrola zostávajú otvorené.
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

### Druhý vizuálny prechod — 2026-10-14

- V Mixeri pri 800 px šírke štyri performance makrá presahovali dostupnú šírku
  svojho toolbaru bez toho, aby rozšírili stránku; dokumentový overflow test
  preto tento problém nezachytil. Toolbar teraz reaguje na vlastnú šírku:
  globálne makrá majú kompaktnú mriežku a scénické makrá dostávajú samostatný
  riadok s čitateľnými názvami.
- Na telefóne sa scénické makrá skladajú do dvoch stĺpcov s názvom nad faderom.
  Tým sa zachová dotyková plocha aj čitateľnosť bez dlhého jedného stĺpca.
- Arrangement necháva časovú mriežku pokračovať podľa dĺžky materiálu; prázdny
  priestor za poslednou klipovou udalosťou preto nie je dôvod na dekoratívne
  natiahnutie canvasu. Neskorší prechod má skontrolovať hustotu jeho toolbaru.
- Devices zostáva informačne hustý editor. Jeho malé technické popisky sú
  prevažne metadata; ďalší audit má cielene preveriť hlavné parametre a čitateľnosť
  pri šírke panelu, nie zväčšovať všetky labely naraz.
- INTENT mal slepé porovnanie a viacero generovacích režimov v jednom riadku.
  Nastavenie slepého pilotu má teraz samostatný riadok a aktívne `GENERATE` je
  jediná amber-filled akcia; ostatné režimy zostávajú dostupné ako sekundárne.
- Export ponúkal master, stems, tracky, share a archívne formáty s podobnou
  vizuálnou váhou. Master je teraz hlavná akcia, ostatné exporty používajú
  neutrálny povrch a zvýraznia sa až pri hover/focus.
- MIDI panel pri vypnutom vstupe pôsobil prázdne. Nová stručná karta vysvetlí,
  ktoré ovládanie sa sprístupní po zapnutí MIDI.
- Reference Map dostal vlastnú drop-zónu a vycentrovaný prázdny stav s limitovanou
  šírkou. Mobilný režim používa širšiu kartu, prirodzenú výšku panelu a necháva
  viditeľný dvojriadkový statusbar.

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

### Matica vizuálnych stavov

| Rola / stav       | Pravidlo KYX                                                           |
| ----------------- | ---------------------------------------------------------------------- |
| Primary           | Jeden amber-filled príkaz, ktorý posunie aktuálny workflow             |
| Secondary         | Neutrálny raised control s jasným štítkom                              |
| Tertiary          | Ghost/text action; rámik sa zvýrazní až pri hover/focus                |
| Selected / active | Silver edge alebo sklo + amber underline/trace; samotná farba nestačí  |
| Hover             | Zdvihnúť kontrast okraja a textu bez trvalého glow                     |
| Disabled          | Zachovať názov a kontext; znížiť kontrast, nie skryť význam            |
| Keyboard focus    | 2 px kontrastný outline s viditeľným odstupom                          |
| Playback/record   | Zelená/červená zostáva sémantická; jantár sa pre tieto stavy nepoužíva |

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
  výsledkov Masteringu. Názvy v Mixeri, Devices, Arrangement, MOD a MIDI
  čerpajú z rovnakej typografickej hierarchie; panelová geometria zostáva
  vlastnená pôvodnými style sheets.
- Mixer performance a scénické makrá sa prispôsobujú šírke vlastného panelu cez
  lokálne container queries. Pri 800 px sa faderové názvy neorezávajú a pri
  390 px sa scénické ovládanie prejde na kompaktnú dvojstĺpcovú skladbu.
- Výsledný produkčný Vite build bol otvorený v preview. Pri 800 a 390 px mal
  dokument aj obe mriežky Mixeru nulový horizontálny overflow.
- Dlhé vysvetlenia o doručovacích profiloch a monitorovaní sú v Masteringu
  dostupné cez klávesnicovo ovládateľné rozbalenie; upozornenie „REVIEW DUE“
  zostáva viditeľné aj v zbalenom stave.
- Pri zúženom okne sa otvorená záložka docku automaticky posunie do viditeľnej
  oblasti. Kontrola pri piatich rozmeroch potvrdila, že shell nevyvoláva
  horizontálny overflow dokumentu; interný scroll hustých editorov zostáva
  funkčný.
- `GEN` je jediná zvýraznená hlavná akcia v Pattern toolbar skupine; ostatné
  príkazy zostávajú dostupné a nemenia svoje správanie.
- Pridaný je test úzkeho TopBaru vrátane prístupu k odloženému count-in.
- Vizuálne snímky sú v `output/playwright/premium-{1440x900,1280x800,1024x768,800x900,390x844}.png`.
- Detailné snímky Mixer, Devices a Arrangement sú v
  `output/playwright/premium-{mixer-panel,devices-panel,arrangement-panel}.png`;
  Mixer pri 800 a 390 px je v `output/playwright/premium-mixer-panel-{800x900,390x844}.png`.
- Export a Intent akcie sú zachytené v
  `output/playwright/premium-{export-panel-hierarchy,intent-panel-hierarchy}.png`.
- Reference Map prázdny stav je skontrolovaný pri 1440, 800 a 390 px v
  `output/playwright/premium-reference-panel-{final-1440x900,800x900,390x844}.png`;
  karta sa zmestí do panelu a na mobile neprekrýva statusbar.

### Quality gates

- `npx prettier --write` pre zmenené UI/CSS/dokumentačné súbory: bez ďalších
  zmien po formátovaní; `git diff --check` čistý.
- `npm run test -- tests/layout-responsive.test.ts tests/ui/TopBar.test.tsx tests/ui/DockChrome.test.tsx`:
  **PASS**, 43 testov.
- `npx vite build`: **PASS**, 35,35 s; build vypísal upozornenia na existujúce
  spoločné statické/dynamické importy a chunky väčšie než 500 KB. Táto kontrola
  neobsahuje TypeScript ani bundle-budget bránu z `npm run build`.
- `npm run typecheck`: blokuje existujúca chyba v
  `tests/e2e/20-audio-edit-render.spec.ts:490` (`project` má typ `unknown`) a
  ďalšie typové chyby v rozpracovanom `src/intent/param-intent.ts` (`EffectType`
  import a indexovanie metadát); tento nesúvisiaci Intent rez sa nemení.
- `npm run format:check`: blokuje už existujúci formátovací rozdiel v
  `tests/probe-split-undo.test.ts`; všetky súbory tohto UI rezu sú formátované.
- `npm run build` zostáva blokovaný TSC: chybné `EffectType` importy/indexovanie v
  `src/intent/param-intent.ts` a `tests/e2e/20-audio-edit-render.spec.ts:490`.
  Samostatný Vite bundler je úspešný; zdrojové súbory Intentu sa nemenia.

### Kontrola druhej vlny — 2026-10-14

- Finálny Reference prázdny stav bol vizuálne skontrolovaný pri 1440 × 900,
  800 × 900 a 390 × 844. Dokumentový horizontálny overflow je pri všetkých
  troch rozmeroch nulový; karta sa zmestí do dock slotu a mobilný statusbar
  zostáva dostupný.
- `npx vite build`: **PASS**, 36,34 s; rovnaké existujúce upozornenia na
  statické/dynamické importy a chunky väčšie než 500 KB.
- `npm run typecheck`: **FAIL** na aktuálnych chybách mimo tejto vizuálnej vlny:
  nepoužitý `instrumentTracks` v `src/midi/midiProject.ts:274`, neznámy typ
  `project` v `tests/e2e/20-audio-edit-render.spec.ts:490` a prístup k
  `Track.instrument` v `tests/mcp-p2d-ops.test.ts:60`.
- `npx prettier --check` pre brief, IntentPanel a nami upravené theme sheets:
  **PASS**. Širšia kontrola dvoch zdieľane upravených súborov označila
  `src/ui/ExportPanel.tsx` a `src/styles/04-arrangement.css`; ich rozdiely
  obsahujú aj Song MIDI export a MIDI lane štýly mimo tejto vlny, preto sa
  nevykonal plošný zápis Prettierom.
- `git diff --check`: **PASS**.
- Plné testy sa v tejto panelovej vlne nespúšťali; predchádzajúca prvá vlna
  má zaznamenaný cielený výsledok 43/43.

### Panelový prechod — Sequencer / Inspector — 2026-10-14

- Nová aditívna vrstva `src/styles/31-workspace-finishing.css` doladí názov a
  sticky ruler Sequenceru, zväčší ovládanie FOCUS a gestovej pomôcky na 24 px,
  zjednotí výber kroku s jantárovou stopou KYX a pridá viditeľný klávesnicový
  focus na kroky a názvy padov/stôp.
- Prepínač SIMPLE/ADVANCED v Inspectore má teraz segmentovaný, menej vrstvený
  povrch; hlavné sekčné popisky sú čitateľnejšie a zdieľajú typografiu KYX.
- Zmeny sú iba prezentačné; nemenia projektový model ani audio/command flow.
- Živá vizuálna QA tejto vrstvy zostáva otvorená: Browser runtime sa v tomto
  prostredí nepodarilo inicializovať, preto staršie screenshoty slúžia iba ako
  referenčný stav a nie ako dôkaz výsledku tejto zmeny.
- `npx prettier --check` pre brief a nové UI stylesheety: **PASS**.
- `git diff --check`: **PASS**.
- `npx vite build`: **PASS**, 42,35 s; výpis obsahuje existujúce upozornenia na
  spoločné statické/dynamické importy a chunky väčšie než 500 KB.
- `npm run typecheck`: **FAIL** iba na aktuálnych chybách mimo tejto CSS vlny:
  `tests/e2e/20-audio-edit-render.spec.ts:490` (`project` je `unknown`) a
  `tests/mcp-p2d-ops.test.ts:60` (`Track.instrument` nie je dostupný pre všetky
  varianty `Track`).
- Testy sa v tejto vlne nespúšťali.

### Panelový prechod — DICE / Mastering / focus — 2026-10-14

- `src/styles/32-dock-panel-finishing.css` zjednocuje viditeľný keyboard focus
  pre textové polia a selecty v hlavných pracovných paneloch cez 2 px KYX ring.
- DICE dôležité ovládacie popisky držia 10 px a vyšší kontrast oproti
  pomocným metadátam.
- Mastering jemne uprednostňuje integrovanú hlasitosť a true peak/margin pred
  doplnkovými metrikami; dostupná analýza je jediná amber-filled hlavná akcia.
- `npx prettier --check` pre dokument a obe nové UI vrstvy: **PASS**.
- `git diff --check`: **PASS**.
- `npx vite build`: **PASS**, 37,41 s; zostávajú existujúce upozornenia na
  statické/dynamické importy a chunky väčšie než 500 KB.
- Strict TypeScript sa od predchádzajúceho behu nezmenil: stále blokuje
  `tests/e2e/20-audio-edit-render.spec.ts:490` a
  `tests/mcp-p2d-ops.test.ts:60`.
- Živá vizuálna kontrola novej vrstvy a testy zostávajú otvorené.

### Panelový prechod — Arrangement capture toolbar — 2026-10-14

- Nahrávanie už nemieša všetky konfigurácie so song-editing akciami v jednom
  riadku. Výber ARM stopy, monitoring, gain, meter a REC/STOP zostávajú stále
  dostupné; druhý kanál, viac-kanálové routovanie, take mode, loop/punch,
  počet vstupov a zariadenie sú v rozbaliteľnom `CAPTURE SETUP`.
- Súhrn disclosure ukazuje, či je aktívny loop, punch, alternate take alebo
  automatický/požadovaný počet kanálov. Nastavenia zostávajú v tom istom
  paneli a ich command/recording callbacky sa nemenili.
- Rozbalenie používa natívny `<details>/<summary>`, má keyboard focus ring a
  vnútorné nastavenia skladajú selecty do šírky dostupnej panelu.
- `npx prettier --check --range-start/--range-end` pre presunutý JSX blok:
  **PASS**; kontrola briefu, indexu a nových CSS vrstiev: **PASS**.
- `git diff --check`: **PASS**.
- `npx vite build`: **PASS**, 1 min 49 s; existujúce import/chunk upozornenia
  zostávajú.
- `npm run typecheck`: **FAIL** na nezmenených externých chybách
  `tests/e2e/20-audio-edit-render.spec.ts:490` a
  `tests/mcp-p2d-ops.test.ts:60`.
- Browser runtime sa znovu nepodarilo inicializovať; screenshot disclosure
  zostáva otvorený. Testy v tejto vlne neboli spustené.

### Shell interaction finishing — collapsed controls — 2026-10-14

- `src/styles/32-dock-panel-finishing.css` dáva 2 px focus ring aj zbalenému
  Inspector railu a Inspector/dock resize gripom. Ich mouse/touch rozloženie,
  collapse logika a uloženie layoutu zostávajú bez zmeny.
- `npx vite build`: **PASS**, 2 min 2 s; zobrazil len existujúce upozornenia
  na zdieľané importy a chunky nad 500 KB. Prettier pre brief a nové theme
  vrstvy aj `git diff --check`: **PASS**.
- Živá kontrola otvoreného/zbaleného Inspectoru pri desktopovej a úzkej šírke
  stále chýba; browser runtime opäť zlyhal pri inicializácii pred otvorením
  stránky.

### Panelový prechod — MIDI routing / export progress — 2026-10-14

- Zapnutá MIDI konfigurácia už nezobrazuje zariadenie, kanály a bend ako dlhý
  vertikálny zoznam. Routovanie má vlastnú dvojstĺpcovú mriežku a CC/drum
  mapovania sú samostatné karty; pod 620 px šírky panelu sa skladajú do jedného
  stĺpca. Command callbacky a MIDI model sa nemenili.
- Busy stav Exportu dostal prístupný progressbar. Ak status nesie percento,
  ukazuje jeho hodnotu; prípravné/overovacie kroky bez percenta používajú
  neurčitý indikátor. Cancel zostáva dostupný vedľa statusu a pri
  `prefers-reduced-motion` indikátor neanimuje.
- Následná vizuálna QA má skontrolovať MIDI s pripojeným zariadením a naplnenými
  mapovaniami pri širokom aj úzkom docku, plus determinate/indeterminate Export
  vrátane CANCEL. Zdroj tejto zmeny sa ešte neoveroval v live browseri.
- Prettier pre brief, oba UI panely a nové CSS: **PASS**; `git diff --check`:
  **PASS**. `npx vite build`: **PASS**, 41,11 s; zostávajú existujúce upozornenia
  na zdieľané importy a chunky nad 500 KB.
- `npm run typecheck`: **FAIL** iba na existujúcich chybách mimo upravených
  súborov: `tests/e2e/20-audio-edit-render.spec.ts:490` (`project` je `unknown`)
  a `tests/mcp-p2d-ops.test.ts:60` (`Track.instrument` nie je dostupný pre
  všetky varianty `Track`). Testy sa v tejto vlne nespúšťali.

### Panelový prechod — Devices selector readability — 2026-10-14

- Rýchle SOURCE voľby beat štýlu boli v priestrannom Devices paneli len 8 px
  pri výške 23 px, hoci ide o hlavné prepínacie ovládanie. Dostali 10 px
  typografiu a 27 px výšku pre lepšiu čitateľnosť a zásahovú plochu.
- Varianty Essential Kitu narastú z 8/21 px na 9/25 px iba pri docku od 1000 px;
  na užšom paneli sa ponechá kompaktný režim, aby sa názvy neorezávali.
- SOURCE a Essential Kit prepínače majú jednotný 2 px keyboard focus ring;
  SOURCE zmena má 120 ms prechod, vypnutý pri `prefers-reduced-motion`.
- `npx vite build`: **PASS**, 49,65 s; zostali upozornenia na existujúce
  statické/dynamické importy a chunky nad 500 KB. Prettier a `git diff --check`:
  **PASS**.
- Široký aj úzky panel treba ešte pozrieť v živom stave; pripojenie browsera sa
  opäť nepodarilo ešte pred otvorením stránky, preto screenshot k tejto zmene
  zatiaľ chýba.

### Panelový prechod — Mastering overview — 2026-10-14

- Mastering summary sa teraz skladá podľa šírky samotného dock slotu, nie iba
  podľa okna. Karty sa plynulo skladajú podľa minimálnej šírky 180 px; počet
  stĺpcov preto prirodzene prejde z jedného až na päť podľa skutočného priestoru.
  Predchádzajúce pevné breakpoints vedeli nevyužiť dostupnú šírku alebo stlačiť
  kartu pod pohodlnú čitateľnosť.
- Názvy metrík aj ich vysvetľujúce riadky majú 10 px; prvé dve hodnoty si
  zachovávajú prioritu z predchádzajúcej vlny. Dáta, stale/busy status aj
  správanie Analyze zostávajú bez zmeny.
- `npx vite build`: **PASS**, 52,46 s; zostali štandardné upozornenia na
  zdieľané importy a chunky nad 500 KB. Prettier a `git diff --check`: **PASS**.
- Grid používa `auto-fit` a minimálnu lokálnu šírku karty namiesto pevných
  container breakpointov; prázdne stĺpce sa zrušia, takže päť kariet vyplní
  široký panel a pri splite sa zlomí až vtedy, keď by karta klesla pod 180 px.
- Vizuálne treba overiť plný report, stale/busy status a plynulé skladanie kariet pri
  širokom, strednom a split docku. Browser screenshot pre túto vlnu ešte chýba.

### Panelový prechod — Arrangement toolbar — 2026-10-14

- Jediný zalamujúci sa rad miešal nahrávanie, úpravu klipov, zoom a tvorbu
  skladby. Ovládanie je teraz rozdelené na tri pomenované skupiny: audio capture,
  editáciu Arrangementu a tvorbu skladby. Nahrávanie má jemný povrchový rám;
  produkčné akcie oddeľuje tenká deliaca čiara.
- Capture setup disclosure ostáva v skupine nahrávania. Rozbalené nastavenia a
  prípadné stavové/varovné správy sa môžu prirodzene rozvinúť na celú jej šírku.
- Layout reaguje na šírku samotného timeline panelu: pod 760 px sa skupiny
  skladajú zvislo bez závislosti od šírky celého okna. Akcie, selection a audio
  správanie sa nemenili; skupiny majú pomenované accessibility role.
- Vizuálne treba ešte overiť zachytenie/setup otvorené, stav počas nahrávania,
  zvolený klip s take controls a úzky dock. Browser runtime pri predchádzajúcej
  inicializácii zlyhal pred otvorením stránky; nový screenshot po tejto zmene
  zatiaľ chýba.
- Prettier a `git diff --check`: **PASS**. Samostatný `npx vite build`:
  **PASS**, 1 min 1 s; zostali existujúce upozornenia na zdieľané importy a
  chunky nad 500 KB. `npm run build` sa zastavil v typechecku pre chyby v
  rozpracovaných testoch mimo Arrangement: `tests/e2e/20-audio-edit-render.spec.ts:490`,
  `tests/intent-action-schema-version.test.ts:6`, `tests/master-iterate.test.ts:2`
  a `tests/mcp-p2d-ops.test.ts:60`. Pri samostatnej bundle kontrole vyšiel
  aktuálny DAW JS 5 333 KB (limit 5 186 KB), core worklets 153 KB (limit
  150 KB) a kontrolný skript následne nenašiel `dist/sw.js`; tieto blokery
  nesúvisia s toolbar CSS a zostávajú na samostatné preverenie.

### Panelový prechod — DICE density — 2026-10-14

- Genre/style/kit/target/length/seed a intent slidery už pri zmenšení docku
  nespoliehajú na prirodzené zalamovanie flex položiek. Každá sada používa
  adaptívnu mriežku podľa šírky samotného DICE panelu; seed a copy tlačidlo
  zostávajú v jednej riadnej skupine.
- Locky sa pod 560 px skladajú do rovnakých tlačidlových stĺpcov namiesto
  nepravidelného zalomenia a ostávajú vysoké aspoň 28 px. Jitter slider sa môže
  zmenšovať s riadkom, preview si zachováva vlastný horizontálny scroll pri
  úzkom paneli; JITTER používa jantár rovnako ako ostatné DICE hodnoty, nie
  predvolenú modrú.
- Generovanie, seed, history ani lock stav sa nemenia. Po úprave treba
  vizuálne preveriť husté locky/history a oba dice režimy v plnom a split docku;
  živé spojenie browsera sa nepodarilo inicializovať, takže nový screenshot
  ešte nie je.
- Prettier pre dotknuté UI/CSS/brief a `git diff --check`: **PASS**. `npx vite
build`: **PASS**, 50,25 s; produkčné CSS obsahuje jantárový JITTER slider a
  PWA vytvorilo `dist/sw.js` aj `dist/workbox-271d3e69.js`.
  Zostali upozornenia na zdieľané importy a chunky nad 500 KB. `node
scripts/check-bundle-size.mjs` zlyhal na širšom aktuálnom výstupe: DAW JS
  5 333/5 186 KB, core worklets 153/150 KB; studio boot path je 2 167/2 200 KB.

### Panelový prechod — Reference tempo selection — 2026-10-14

- Half / As detected / Double používali rovnaký textový vzhľad, hoci prepínajú
  významnú interpretáciu BPM. Majú teraz `aria-pressed` podľa uloženej voľby,
  spoločný raised control a pri výbere jantárovú spodnú stopu.
- Aktívne „As detected“ môže zostať disabled, aby sa neponúkala no-op akcia;
  jeho selected vzhľad má prednosť pred disabled fade. Tempo výpočet, detekcia a
  Apply operácie sa nemenili.
- `npx vite build`: **PASS**, 48,54 s; Reference Map chunk aj produkčné CSS sa
  vytvorili. Cielený Prettier a `git diff --check`: **PASS**. Živú kontrolu
  aktívneho polovičného/dvojnásobného čítania treba ešte spraviť v analyzovanom
  stave pri širokom a úzkom docku.

### Živá vizuálna QA shellu a Masteringu — 2026-10-14

- Aktuálny UI sa podarilo znovu otvoriť v browseri na House Beat; staršie
  poznámky o nedostupnom browser runtime už neplatia. Pri 1440 × 900 je
  hlavička 43 px a pri 1280 × 800 je shell bez horizontálneho overflow.
- Pri 1024 × 768 sa po oprave breakpointu editor a Inspector skladajú do
  správnych dvoch stĺpcov; zbalený Inspector má 28 px rail. Rozbalený stav
  používa 230 px Inspector a resize grip sedí na jeho hrane.
- Pri 800 × 900 má workspace 248 px, z toho workspace-main 216 px; jeho obsah
  má 355 px a je doscrollovateľný nad dockom. Inspector rail tvorí samostatný
  riadok. Pri 390 × 844 má TopBar dva riadky a mobilný dock je zámerne pevný
  swipe sheet: začína na y=297, končí presne nad statusbarom na y=761, scrolluje
  interne a nemení šírku dokumentu. Predchádzajúce podozrenie na chybný grid
  bolo týmto vyvrátené; prekrytie pracovnej plochy je mobilný sheet režim.
- Kontrola zbaleného docku pri 390 px odhalila starý selektor, ktorý skryl aj
  samotnú tabuľkovú lištu. Neskoršia shell vrstva teraz explicitne obnovuje
  zobrazenie lišty; po zatvorení docku zostane 34 px riadok viditeľný a záložka
  z neho dock znovu otvorí. Zároveň statusbar pôvodne meral 401 px pri 390 px
  viewportu. Min-width: 0 teraz dovolí jeho hintu ustúpiť a statusbar má presne
  390 px bez horizontálneho overflow. Plávajúci QMR ovládací prvok prekrýval
  pravý performance readout; statusbar teraz rezervuje jeho spodný pravý roh
  a mobilný status hint sa skráti do jedného riadka namiesto zvislého rastu.
- Úzky MOD panel mal skrytý overflow vo vnorenom makro gride: dve 1fr stopy
  rešpektovali min-content šírku kariet a rozšírili panel na 752 px. Nahradenie
  stôp za minmax(0, 1fr) odstránilo overflow bez zmeny počtu alebo poradia
  kariet. Pri 390 px majú obe makro karty v riadku 159 px a panel zostáva
  široký 380 px. Screenshoty sú
  output/playwright/premium-mobile-dock-collapsed-390x844.png,
  output/playwright/premium-live-mod-390x844.png a
  output/playwright/premium-live-mod-390x844-macros-scrolled.png.
- Všetkých jedenásť dock panelov sa prešlo pri 390 px. Dokument nepresahuje
  viewport; Mixer si zachováva vlastný horizontálny posun kanálov, ostatné
  panely sa zmestia do svojej šírky alebo používajú vertikálny scroll.
- Snímky týchto stavov sú output/playwright/premium-current-{1440x900,1280x800,1024x768,800x900}.png,
  output/playwright/premium-mobile-390-current.png a
  output/playwright/premium-workspace-dock-collapsed-1440x900.png.
- V Masteringu sa spustila plná analýza House Beat a skontroloval sa výsledný
  report s metrikami, štyrmi nálezmi, busy stavom a otvorenými delivery notes.
  Pri 1440 px sa všetkých päť kariet zmestí do jedného radu; pri 800 px sa
  posledná dvojica vycentruje. Nový container-query layout v
  src/styles/36-mastering-overview-layout.css používa šesť pomocných stĺpcov,
  aby si karty zachovali rovnakú šírku aj pri vycentrovaní. Screenshoty sú
  output/playwright/premium-mastering-report-{1440x900,800x900}.png a
  output/playwright/premium-mastering-report-notes-800x900.png.
- Stale report ani MIDI s pripojeným zariadením sa v tomto browser profile
  neoverili. Analýza sa spustila iba na QA projekte; projektové/audio dáta sa
  touto kontrolou nemenili.
- Prettier pre plán a nový mastering stylesheet: PASS; git diff --check: PASS.
  Samostatný npx vite build: PASS za 46,77 s; zostávajú štandardné upozornenia
  na zdieľané statické/dynamické importy a chunky nad 500 KB. Typecheck a testy
  sa v tejto vizuálnej QA iterácii nespúšťali.

### Zostáva

- Dokončiť panelový prechod v plných a hustých stavoch: Sequencer/Inspector,
  Mixer/Devices, Arrangement, MOD, DICE, INTENT, EXP, MASTER, zapnuté MIDI a
  Reference po načítaní analyzovanej stopy. Sekvenčná vlna teraz zasahuje aj
  DICE a Mastering, ale zmenené stavy ešte treba skontrolovať naživo; ostatné
  panely potrebujú vlastnú plnú/hustú kontrolu. Prázdne stavy INTENT, MIDI a
  Reference už majú zachytenú hierarchiu.
- Preveriť collapsed Inspector/dock, Mastering notes disclosure a ostatné
  overlaye pri desktopovej aj úzkej šírke.
- Overiť selected/hover/focus a disabled kontrast na reálnych ovládacích
  prvkoch; vizuálne zjednotiť iba tie panely, kde chýba stav alebo rytmus.
- Po oprave aktuálnych TypeScript a formátovacích blockerov zopakovať celý typecheck, format check,
  produkčný build a cielené panelové testy.

### Panelová matica dokončenia

| Plocha                | Zapracované                                                                            | Zostávajúci dôkaz pred uzavretím                                                     |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Shell / TopBar / dock | Kompaktný layout, tab hierarchia a 2 px rail/grip focus                                | Zbalený Inspector/dock pri 1024/800/390 px a live screenshot                         |
| Sequencer / Inspector | Typografia, 24 px ruler ovládanie, amber select/focus                                  | Hustý pattern, SIMPLE/ADVANCED, collapse rail a live screenshot                      |
| Mixer / Devices       | Hierarchia, responzívne makrá, čitateľnejšie source/kit voľby                          | Plný FX chain, scroll, hover/focus a mobilný panel                                   |
| Arrangement           | Statusy, capture setup disclosure a tri toolbar skupiny                                | Hustý song/MIDI/audio stav, otvorený setup, zvolené take controls a výška timeline   |
| MOD / DICE            | Základné sekčné karty; DICE popisky a responzívne gridy                                | Naplnené automation/LFO, DICE histórie/locky v split docku                           |
| INTENT / EXP          | Prompt a hlavné akcie, master hierarchia, export progress                              | Kandidáti, chyby, determinate/indeterminate export, disabled a úzke šírky            |
| MASTER                | Report/nálezy, notes disclosure, busy/completed, 5 kariet a vycentrovaný 3-col layout  | Stale stav, split dock a ďalšie breakpoint/state kombinácie                          |
| MIDI / Reference      | MIDI-off a responsive routing; Reference empty state, controls a pressed tempo reading | MIDI zapnuté s pripojeným zariadením pri úzkom docku; Reference dense analysis state |

Tabuľka oddeľuje implementované zmeny od dôkazu, ktorý ešte treba získať.
Starší screenshot ani úspešný bundler nenahrádza kontrolu aktívneho panelového
stavu.
