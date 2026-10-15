# Pulse Forge Premium UI — implementačný brief

> **Produkt:** KYX  
> **Repo:** Pulse Forge  
> **Stav:** Implementácia prebieha — shell a vybrané panelové vlny sú zapracované; plné/husté stavy aj živá vizuálna kontrola zostávajú otvorené.
> **Aktualizované:** 2026-10-15

## Aktuálne overenie

- `npm run typecheck` spustený 2026-10-15 skončil jedinou aktuálnou chybou:
  `src/mcp/tools.ts(6,1): TS6192` — nepoužitá import deklarácia. Starší záznam
  o ďalších MCP ripple a scene-pack chybách už nepopisuje dnešný výstup.
  V tomto prechode sa celý `npm run build` nespúšťal.
- Samostatný `npx vite build --logLevel error` a všetky bundle budgety po
  Mixer focus úprave prešli: DAW JS **4975/5186 KB**, optional runtimes
  **647/650 KB**, stem runtime **404/430 KB**, core worklety **150/150 KB** a
  boot path **2181/2200 KB**.
- `npm run format:check`, cielený Prettier pre brief a Mixer stylesheets aj
  `git diff --check` prešli. Automatické testy sa nespúšťali. Staršie záznamy
  nižšie zachovávajú historické brány.
- Automatické testy sa v posledných UI iteráciách nespúšťali.
- Zostávajúce overenie sa týka predovšetkým čerstvých focus/hover a hustých
  split stavov. MIDI/audio capture s fyzickým zariadením je samostatná
  hardvérová kontrola.

### Proporcie sequencera pri otvorenom docku — audit 2026-10-15

- Snímka pri **390 × 844** s otvoreným dock panelom MOD ukazuje sequencer iba
  v približne 30 px vysokom páse; hlavná pracovná plocha tak stráca svoj
  primárny rytmický editor. Dôkaz: `output/playwright/premium-live-mod-automation-selected-focus-mobile-390x844.png`.
- Pri ďalšom layoute má mať sequencer pevné, responzívne minimum a scrollovať
  sa má obsah workspace, nie nechať samotnú mriežku stlačiť na hlavičku. Dock
  zostáva resizeovateľný, no nesmie odobrať sequenceru tento základný priestor.
- Zmenu ešte treba zachytiť po jej zapojení do stylesheet cascade. Akceptačná
  kontrola: 1440 × 900, 1280 × 800, 1024 × 768, 800 × 900 a 390 × 844; v každom
  stave zrušiť onboarding overlay a overiť viditeľnú sekvencerovú mriežku,
  pracovné akcie aj otvorený dock.

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
  natiahnutie canvasu. Capture, edit a produkcia majú oddelené toolbar skupiny;
  mobilný Scene launcher a Scene Strip dostali väčšie ovládanie; zostáva
  vizuálne overiť ich husté stavy a nahrávanie.
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
| Veľký mobilný cieľ   | 44 px cez spoločný `--touch-target-large` token pre hlavné dotykové akcie     |
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

### DICE a split dock — 2026-10-14

- Hustý DICE stav sa skontroloval pri 1440 × 900, 800 × 900 a 390 × 844.
  Automatické otvorenie už nevyhradí 470 px iba panelu: nových 360 px ponechá
  pri 1440 px 400 px workspace a pri 800 px 358 px. DICE obsah zostáva
  doscrollovateľný; ručné zväčšenie docku je naďalej dostupné. Mobilný sheet má
  400 px a dokument zostáva presne 390 px široký.
- Split DICE + MOD pôvodne stratil približne polovicu šírky: `.dock-chrome`
  zaberala prvý flex stĺpec a panelové sloty sa začínali až pri x ≈ 690 px.
  Grid teraz dáva chrome celý horný riadok a slotom celý riadok pod ním. Pri
  1440 px sú sloty 716 px + 8 px grip + 716 px; pri 390 px sa skladajú pod
  seba v scrollovateľnom sheete bez horizontálneho overflow.
- Pomer splitu sa teraz aplikuje z layout store cez `--dock-split-ratio`.
  Kontrola ovládania odhalila, že všeobecný clamp zaokrúhľoval zlomky na celé
  čísla a klik na grip bez ťahania zapisoval nulový počiatočný stav. Clamp
  zachováva zlomkové pomery, no pixelové šírky stále zaokrúhľuje; klik bez
  pohybu nič nemení. Klávesová šípka mení pomer 0,50 → 0,52 a Enter ho vráti
  na 0,50; 32 px ťah zmenil pomer na 0,54.
- Snímky: `output/playwright/premium-live-dice-mod-split-fixed-1440x900.png`,
  `output/playwright/premium-live-dice-mod-split-final-390x844.png` a
  `output/playwright/premium-live-dice-auto-height-{1440x900,800x900,390x844}.png`.
  DICE preview zostal v neaplikovanom stave; tlačidlo APPLY sa nestlačilo.
- Cielený Prettier aj `git diff --check`: **PASS**. `npx vite build`:
  **PASS za 43,05 s**; ostali upozornenia na zmiešané statické/dynamické importy
  a chunky nad 500 KB. `npm run typecheck` má tri existujúce chyby v testoch:
  nepoužitý `ACTION_SCHEMA_VERSION` v
  `tests/intent-action-schema-version.test.ts:6`, nepoužitý
  `DEFAULT_TOLERANCES` v `tests/master-iterate.test.ts:2` a neexistujúca
  vlastnosť `Track.instrument` v `tests/mcp-p2d-ops.test.ts:60`. Repo-wide
  `npm run format:check` zlyhá na `src/intent/model-decoder.ts`,
  `tests/intent-action-schema-version.test.ts` a
  `tests/probe-split-undo.test.ts`; moje dotknuté súbory prešli cielenou
  kontrolou. Automatické testy sa nepridávali ani nespúšťali.

### Devices, Inspector a Reference — 2026-10-14

- V Devices sa pri 390 px názov stopy stlačil na 22 px, keď dve voľby akcií
  obsadili takmer celú hlavičku. Úzka hlavička teraz dáva názvu vlastný riadok
  a voľbám rovnocenné stĺpce. Pri 800 a 1440 px zostáva hlavička v jednom
  38 px riadku. Pri jednom ovládacom prvku sa mriežka roztiahne na celú šírku.
- Screenshoty Device editoru: `output/playwright/premium-live-devices-header-1440x900.png`
  a `output/playwright/premium-live-devices-header-390x844.png`. Projektový
  FX chain sa počas tohto prechodu neupravoval.
- Mixer pri 800 × 900 odhalil dva layoutové problémy. FREEZE/BOUNCE pretŕčali
  z kanálového pásu širokého 190 px; `03-mixer.css` teraz zalamuje akcie do
  samostatného riadka. Jeho `scrollWidth` klesol z 242 na 188 px. Pravidlo
  `.dock-slot > .mixer` teraz nechá Mixer vyplniť slot a scrollovať vertikálne
  vnútri seba: slot má 301 px a nemá druhý vnorený vertikálny scrollbar.
  Horizontálny scroll zostáva pre širokú banku kanálov.
- Snímky Mixera: `output/playwright/premium-mixer-responsive-800x900.png` a
  `output/playwright/premium-mixer-channel-controls-800x900-fixed.png`.
  House Beat má return efekty Reverb/Delay/NY Comp, ale na tracku Drums nebol
  vložený plný insert chain. Ten stav ostáva na samostatné QA; počas kontroly
  sa do projektu žiadny efekt nepridával.
- Na 390 px sa prvý scroll fix najprv zmrštil na 25 px; mobile sheet má
  intrinsic/content výšku namiesto desktopovej flex výšky. `32-dock-panel-finishing.css`
  teraz zachová intrinsic Mixer výšku pod 760 px. Slot má 1 034 px obsahu,
  sheet ho vertikálne posúva a dokument zostáva na 390 px bez overflowu.
  Mobilný screenshot: `output/playwright/premium-mixer-mobile-390x844-fixed.png`.
- Inspector sa otvoril pri 1440 px a zbalil pri 800 px. V užšom režime sa
  pri zbalenom docku rozdelí pracovnú plochu na 421 px editor a 306 px
  Inspector. Pri 390 px má Inspector 253 px, editor zostáva nad ním a stránka
  má presne 390 px. Zbalená lišta Inspectoru má na tablete 32 px.
- V šírke 1024 px sa v Inspectore zobrazili režimy SIMPLE/ADVANCED. ADVANCED
  odhalil, že preset názov mal nulovú šírku a list získal 15 px horizontálneho
  overflow. `34-panel-states.css` teraz rozkladá preset riadok podľa lokálnej
  šírky Inspectoru: názov ostáva čitateľný, tagy sú druhým riadkom a list nemá
  horizontálny overflow. Pri 1024 px názov dostal 97 px; pri 1440/800/390 px
  sa layout prispôsobil skutočnej šírke kontajnera.
- Snímky Inspectoru: `output/playwright/premium-live-inspector-advanced-1024x768-fixed.png`,
  `output/playwright/premium-live-inspector-advanced-1440x900.png`,
  `output/playwright/premium-live-inspector-advanced-800x900.png` a
  `output/playwright/premium-live-inspector-advanced-390x844.png`.
- Súbeh vysokého docku a Inspectoru pri 800 px odhalil kritický kolaps:
  editor mal 24 px. V `25-short-viewport.css` je pre pásmo 761–860 px
  Inspector bočným stĺpcom a grip na jeho šírku je aktívny. Ak je Inspector
  otvorený, dock sa obmedzí na 38 vh; po jeho zbalení sa vráti uložená výška
  docku. Pri 800 × 900 má editor výšku 416 px, Inspector šírku 230 px a dock 342 px;
  Sequencer je viditeľný. Pri 761 × 900 má editor 416 px a dokument nemá
  horizontálny overflow. Pri 760 px sa zachová mobilné stohovanie; editor má
  488 px a Sequencer 149 px, s vertikálnym scrollom workspace.
- Tabletové snímky: `output/playwright/premium-tablet-side-inspector-800x900.png`
  a `output/playwright/premium-tablet-side-inspector-761x900.png`. Zbalenie
  Inspectoru pri 761 px obnovilo celý 508 px dock; jeho uložená výška sa
  nezmenila. Pri 390 px zostáva Inspector stohovaný pod editorom.
- Po zbalení docku pri 390 px zostane 34 px tabuľkový riadok. Jeho obsah má
  678 px a posúva sa horizontálne vnútri riadku; posledný REF tab sa dostal do
  viewportu pri `scrollLeft=288` bez horizontálneho overflow dokumentu.
- Zbalený dock sa overil aj pri 1024 × 768: zostáva 30 px lišta nad
  31 px statusbarom, Inspector rail má 28 px a stránka má presne 1024 px.
  Snímka: `output/playwright/premium-live-dock-collapsed-1024x768.png`.
- Reference Map dostal skúšobný súbor `public/samples/factory.fx.vinyl.wav`.
  Výsledky (83.36 BPM, A# minor, nízka istota a clipping varovania) aj husté
  ovládanie sa skontrolovali pri 1440, 800 a 390 px. Panel sa zvislo posúva,
  vnútorný horizontálny overflow sa nenašiel a šírka dokumentu sa zhodovala s
  viewportom. `Apply to project`, export a Build Project sa nespúšťali.
- Snímky analyzovaného Reference Mapu: `output/playwright/premium-live-reference-analysis-1440x900.png`,
  `output/playwright/premium-live-reference-analysis-800x900.png` a
  `output/playwright/premium-live-reference-analysis-390x844.png`.
- Cielený Prettier aj `git diff --check`: **PASS**. `npx vite build`:
  **PASS za 39,70 s**; zostali štandardné upozornenia na zmiešané statické /
  dynamické importy a chunky nad 500 KB. Automatické testy sa nespúšťali.

### Arrangement — plný stav a Capture Setup — 2026-10-14

- House Beat ukazuje scénu Groove, Pattern A, MIDI lanes pre 808 a Chords a
  hustý toolbar aranžmánu. Pri 1440, 800 a 390 px sa kontroloval aktívny panel;
  horizontálny overflow dokumentu ani panelových ovládacích prvkov sa nenašiel.
- Capture Setup sa rozbalil bez nahrávania. Pri 1440 px má šírku 753 px a
  výšku 109 px; pri 800 px 732 × 109 px; na mobile sa skladá do 307 × 245 px
  a zvyšok konfigurácie zostáva pod vertikálnym scrollom dock sheetu.
- Časová os si zachováva vlastný horizontálny posun (`.arr-lane-scroll`, 621 px
  obsahu v 319 px mobilnom viewport-e); šírka stránky zostáva presne 390 px.
  V projekte nebol spustený záznam ani upravená audio/MIDI udalosť.
- Screenshoty: `output/playwright/premium-live-arrangement-1440x900.png`,
  `output/playwright/premium-live-arrangement-800x900.png`,
  `output/playwright/premium-live-arrangement-390x844.png` a Capture Setup pri
  `1440x900`, `800x900` a `390x844` v rovnomennom `premium-live-arrangement-capture-open-*`.

### MASTER, INTENT a EXP — responzívne disclosure a pripravený stav — 2026-10-14

- Mastering DELIVERY & MONITORING NOTES sa otvorili bez spustenia analýzy. Pri
  1440/800/390 px mali šírku 1377/737/342 px a výšku 124/152/268 px; dlhé
  poznámky sa zalomia a sheet sa na mobile zvislo posúva. Dokument pri každej
  šírke zachoval presnú šírku viewportu.
- Snímky poznámok: `output/playwright/premium-mastering-notes-1440x900.png`,
  `output/playwright/premium-mastering-notes-800x900.png` a
  `output/playwright/premium-mastering-notes-390x844.png`.
- INTENT sa kontroloval s predvyplneným promptom bez odoslania. Pri 390 px sa
  jeho obsah zmestí do 380 px sheetu a ďalšie akcie sú dostupné zvislým
  scrollom; nebola spustená generácia. Snímky pri `1440x900`, `800x900` a
  `390x844` sú v `premium-intent-empty-*`.
- EXP sa otvoril v pripravenom stave bez exportu. Pri 800 a 1440 px má panel
  462 px výšku; pri 390 px má 721 px obsahu pod 464 px sheetom. Obe časti sú
  zvislo rolovateľné a dokument nemá horizontálny overflow.
  Snímka: `output/playwright/premium-export-default-390x844.png`.

### Sequencer — P-lock layout a 128-krokový pattern — 2026-10-14

- P-lock editor má teraz oddelenú hlavičku, skupinu výkonových ovládačov a
  maticu zámkov. Na širokom paneli sa šesť lockov skladá do troch stĺpcov;
  do 860 px sa matica zmení na dva stĺpce a výkonové ovládače sa zalamujú podľa
  šírky. Pred úpravou mal editor pri 800 px 880 px obsahu v 735 px paneli a
  horizontálne skrýval približne 145 px ovládania.
- Po úprave: pri 1440 px má P-lock editor 1107 × 110 px a matica 3 × 2;
  pri 800 px 739 × 233 px a matica 2 × 3; pri 390 px 329 × 275 px a matica
  2 × 3. Vo všetkých troch šírkach sa šírka editora zhoduje s jeho klientskou
  šírkou, dokument nemá horizontálny overflow. Pri mobile s otvoreným MOD
  dock sheet zakrýva časť pracovnej plochy; po jeho zbalení sa editor zmestí
  do šírky a jeho spodná časť zostáva dostupná zvislým scrollom Sequenceru.
- Dôkaz: `output/playwright/premium-live-sequencer-plock-open-1440x900-after.png`,
  `output/playwright/premium-live-sequencer-plock-open-800x900-after.png` a
  `output/playwright/premium-live-sequencer-plock-open-390x844-dock-closed.png`.
- Na dočasnej kópii projektu sa nastavil 128-krokový pattern bez prehrávania
  alebo zmeny krokov. Windowing renderuje stredné okno `1–41` (41 stĺpcov)
  a pri horizontálnom konci `81–128` (48 stĺpcov) z celkových 128 krokov;
  vodorovný posun zostáva v Sequenceri a šírka dokumentu sa nemení.
  Koncová pozícia je `scrollLeft=2414`; ruler na konci ukazuje takty/beaty
  21–32. Snímky: `output/playwright/premium-live-sequencer-128-1440x900.png`,
  `output/playwright/premium-live-sequencer-128-1440x900-end.png` a
  `output/playwright/premium-live-sequencer-128-1440x900-workspace-scrolled.png`.
- Kontextové otvorenie P-locku na kroku 1 nemenilo locky; dokladá len vizuálny
  stav. Projektová kópia zostáva oddelená od House Beat počas zvyšnej panelovej
  QA. Automatické testy sa nespúšťali.

### INTENT, EXP, Arrangement a MASTER — aktívne stavy — 2026-10-14

- INTENT dostal mobilné zalamovanie kandidátskej hlavičky a iterácie v
  `src/styles/29-premium-hierarchy.css`. Pri 390 px majú metadáta 256 px,
  audition 28 px a `USE` 38 px; iterácia a audio nástroj sa presunú do druhého
  riadka. Otvorený iterátor sa zmení na plnošírkový blok 334 px pri x=23, takže
  jeho voľby ostanú v dock sheete a dajú sa zvislo posúvať. Pri 800 px zostáva
  kandidátsky riadok v paneli. Šírka dokumentu ostáva na oboch šírkach rovná
  viewportu. Následná úprava dáva audition, `USE`, iterátoru aj audio akcii na
  telefóne minimálnu 44 px výšku; audition a `USE` majú aj 44 px minimálnu
  šírku. Po tejto úprave treba znovu zmerať riadok s práve pripojeným
  kandidátskym bankom.
- Lokálna INTENT generácia vytvorila päť návrhov. `USE` sa nespustilo a návrhy
  nemenili obsah QA projektu. Dôkaz: `output/playwright/premium-live-intent-candidates-390x844-after.png`,
  `output/playwright/premium-live-intent-iteration-open-390x844-scrolled.png` a
  `output/playwright/premium-live-intent-candidates-800x900.png`.
- Kontrola uloženej vetvy odhalila zamietnutú iteráciu, ktorá ukazovala interný
  brief-gate kód a track UUID. `src/ui/IntentPanel.tsx` teraz pri tomto známom
  brief-gate stave vysvetlí, že take obsahuje noty mimo rozsahu, a ponúkne
  bezpečný ďalší krok.
  Pri 390 px sa text zalomí v paneli bez horizontálneho overflow. Snímky pred a
  po: `output/playwright/premium-live-intent-iteration-error-390x844-before.png`
  a `output/playwright/premium-live-intent-iteration-error-390x844-after.png`.
- EXP sa preveril pri 390, 800 a 1440 px. Na mobile má približne 720 px obsahu
  pod kratším dock sheetom a obe časti zostávajú dostupné zvislým scrollom.
  Master export sa spustil iba po zobrazenie neurčitého stavu „Rendering
  master…“ a zrušil pred kódovaním alebo sťahovaním. Zrušenie ukázalo zrozumiteľný
  výsledkový status; determinate priebeh ani dokončený súbor sa netestovali.
  Snímky: `output/playwright/premium-live-export-cancelled-390x844.png` a
  `output/playwright/premium-live-export-cancelled-1440x900.png`.
- Arrangement sa v QA kópii vytvoril audio klipom cez `BOUNCE ZONE` z
  vybraného osembarového úseku. Vznikol približne 7,97-barový klip na Drums;
  pri 390 px sa zachováva vlastný scroll timeline a dokument má šírku presne
  390 px. MIDI klipy na 808 a Chords zostali viditeľné. Take lanes sa bez
  pripojeného a armed audio vstupu nespúšťali. Snímky:
  `output/playwright/premium-live-arrangement-audio-bounce-1440x900.png` a
  `output/playwright/premium-live-arrangement-audio-bounce-390x844.png`.
- MASTER vykonal lokálnu analýzu 20,1 s programu pri 44,1 kHz / Studio HQ.
  Report uviedol -9,6 LUFS-I, -1,3 dBTP, stereo correlation 1.00 a štyri
  nálezy; stav bol `NEEDS ATTENTION`, nie úspešný masteringový cieľ. Po zmene
  tempa z 124 na 125 BPM sa report označil ako `STALE · ANALYZE AGAIN` a
  vysvetlil, že výsledky patria skoršiemu projektu. Pri 800 aj 390 px sa
  zachovala presná šírka dokumentu; pri 800 sa metriky skladajú do mriežky 3+2.
  Snímky: `output/playwright/premium-live-mastering-report-800x900.png`,
  `output/playwright/premium-live-mastering-stale-800x900.png` a
  `output/playwright/premium-live-mastering-stale-390x844.png` a
  `output/playwright/premium-live-mastering-stale-1440x900.png`.
- Mixer a Devices sa v tej istej QA vlne skontrolovali aj s prázdnym chainom a
  piatimi vloženými efektmi pri 1440, 800 a 390 px. Snímky sú v
  `premium-live-devices-chain-5-*` a `premium-live-devices-800x900-empty-chain.png`;
  panelový horizontal overflow sa nenašiel. Teraz sú doplnené aj 2 px selected
  zvýraznenie stripu, 2 px focus device-chain tlačidiel, čitateľnejšie disabled
  ovládače aj 44 px mobilné ciele pre výber efektu; ich nový živý stav ešte treba
  odfotiť.

### Zostáva

- Implementované selected/focus/disabled stavy, touch targets a responzívne
  rozloženia treba ešte uzavrieť živými dôkazmi podľa panelovej matice nižšie.
  Konkrétne zostáva kontrast a orezanie focus ringov v hustých a split stavoch,
  naplnené LFO/automation stavy v MOD/DICE a selected/focus rozloženie
  Arrangement pri plnej časovej osi.
- V INTENT/EXP zostáva živá kontrola busy/disabled kombinácií a determinate
  exportného progressu. V MASTER treba skontrolovať overlay/state kombinácie v
  split docku a nové mobilné rozmery.
- Reference stale guard je teraz živým testom potvrdený pri 1440×900 aj
  390×844: starý report zostal čitateľný a APPLY ostal vypnutý. Empty-file
  `role=alert` je tiež odfotený pri 1440/390. Reálny armed audio capture a MIDI
  vstupné správanie s fyzickým zariadením nemožno potvrdiť bez funkčného audio
  vstupu a externého MIDI zariadenia. Mobilný MIDI panel už má samostatne
  overený INPUT OFF/ON bez zariadenia aj CREATIVITY pri 390 × 844.
- Responzívny dock cap je teraz overený pri 1440×900, 1280×800 a 1024×768;
  shell/focus dôkazy pri zbalenom a split docku a mobilný transport zostávajú
  otvorené. Ďalšie breakpointové a stavové snímky sú evidované v matici.
- Motion tokeny pokrývajú spoločné ovládacie prechody a `prefers-reduced-motion`
  ruší animácie aj transitions. Zostáva auditovať ďalšie lokálne CSS prechody;
  priame drag hodnoty a audio/measurement meter fill sa majú aktualizovať bez
  oneskorenia a zachovať si krátky signálový timing.
- Cielený Prettier a `git diff --check` prechádzajú. Aktuálny
  `npm run typecheck` prešiel po odstránení nepoužitého importu `beforeEach` z
  `tests/mcp-headless-acceptance.test.ts`; správanie testu sa nemenilo.
- Repo-wide `npm run format:check` teraz prechádza. Opravilo sa iba
  formátovanie `src/intent/model-decoder.ts` a `tests/probe-split-undo.test.ts`;
  logika ani správanie testu sa nemenili.
- Aktuálny `npm run build` a všetky bundle gates prechádzajú: DAW JS
  **4964/5186 KB**, opt-in stem runtime **404/430 KB**, core worklety
  **150/150 KB**, generative player worklet **3/4 KB** a boot path
  **2176/2200 KB**. Samostatný fyzický súčet JS je **7467 KB**.

### Panelová matica dokončenia

| Plocha                | Zapracované                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Zostávajúci dôkaz pred uzavretím                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Shell / TopBar / dock | Kompaktný layout, tab hierarchia a 2 px rail/grip focus; split grid + pomer; viewport dock cap od 34–38 vh živý pri 1440/1280/1024; 44 px collapse/expand Inspector targety do 860 px a pre coarse pointer; Browser Strip 44 px coarse-pointer target + 2 px focus ring; mobilný play/record/stop majú 44 px ciele                                                                                                                                                      | Čerstvé screenshoty mobilného transportu, collapsed states a focusu v split docku                  |
| Shared controls       | 2 px amber `:focus-visible` pre tlačidlá, chipy, segmented, role=slider, kroky/pady a natívne fields; zdieľaný matný disabled treatment pokrýva aj custom Arrangement, Landing, Brief, Theme, Reference a menu akcie; selected disabled stavy si zachovávajú tlmenú amber stopu; range/checkbox/radio ostávajú tlmené; system `prefers-reduced-motion` overený live                                                                                                     | Živá kontrola outline clippingu, kontrastu disabled prvkov a selected variantov                    |
| Sequencer / Inspector | Typografia, 24 px ruler, amber select/focus; selected trace track tabov; mobile scrollable track tabs s aktívnou stopou; SIMPLE/ADVANCED selected state; 808 pri 4 šírkach; responzívny P-lock; 128-step windowing pri 3 šírkach; step-amount drag aktualizuje šírku bez animačného oneskorenia                                                                                                                                                                         | Ďalšie track varianty a živá kontrola keyboard kontrastu/select focusu                             |
| Mixer / Devices       | Hierarchia, responzívne makrá, source/kit voľby; 2 px selected strip a chain focus; amber selected underline device-chain modulu; názvy chain prvkov majú na desktope 10 px, na mobile 12 px; disabled button/select labels s plnou opacitou; range/checkbox/radio ostávajú tlmené; päťefektový chain pri 1440/800/390; GROW/REZONANS vnútorné mriežky; zdieľaný mobilný Scene Strip; selected Tape Sat chain pri 390 px; 5-FX Reverb selected + amber focus pri 390 px | Živý hover a selected/focus kontrast v split docku a pri 800/1440 px                               |
| Arrangement           | Groove scene, MIDI lanes, audio bounce clip, Capture Setup a toolbar pri 1440/800/390; amber trace pre edit/loop/capture/take selection; 44 px mobile ciele pre capture/edit/zoom/SNAP/GEN/take-lane, Scene launcher/strip a MIDI lane `+`; selected MIDI clip s focus ringom pri 1440/800/390; armed UI bez spustenia nahrávania pri 390                                                                                                                               | Reálny audio capture s fyzickým vstupom; zariadenie nie je v tomto workspace dostupné              |
| MOD / DICE            | Sekčné karty, DICE 3-roll history a locky pri 1440/800/390; MOD 4-section auto-fit; groove/intensity/scene subheadings používajú spoločnú 12 px úroveň; vybrané/fokusované stavy a DICE aria-pressed                                                                                                                                                                                                                                                                    | Naplnené LFO/automation; živá kontrola nového MOD gridu a MOD/DICE selected/disabled v split docku |
| INTENT / EXP          | Prompt, 5 návrhov, responzívny iterátor, 44 px tlačidlá pri 390 px; spoločný busy signál a čitateľné disabled akcie INTENT; EXP cancel/progress pri 3 šírkach a dokončený WAV + report pri 1440/390                                                                                                                                                                                                                                                                     | Live kontrola INTENT busy/disabled a EXP determinate progress, vrátane ďalších úzkych šírok        |
| MASTER                | Report/nálezy, notes disclosure, busy/completed/stale, 5 kariet a 3+2 mriežka pri 390/800/1440; mastering controls adaptujú aj podľa šírky split dock slotu; mobilné report selecty, Analyze, delivery voľby aj Export Master majú 44 px ciele; custom disabled stavy používajú matný povrch, offset akcie majú 10 px text, meracie štítky 10 px, verdict korelácie 9 px a programatické jump focus ciele zdieľajú kontrastný amber ring                                | —                                                                                                  |
| MIDI / Reference      | MIDI-off a responsive routing; INPUT OFF/ON bez externého zariadenia pri 390 px; 44 px mobilné INPUT/CREATIVITY akcie, MIDI selecty aj P.BEND, vrátane 64 × 44 px textovej editácie; 42 CREATIVITY ovládacích prvkov pri 390 px; CC/Drum titles a scroll slot; Reference empty/analyzed pri 3 šírkach; empty-file alert; MATCH stale guard a scrollovateľný report                                                                                                      | MIDI s fyzicky pripojeným zariadením; armed MIDI/audio capture a viac-kanálové zariadenie          |

Tabuľka oddeľuje implementované zmeny od dôkazu, ktorý ešte treba získať.
Starší screenshot ani úspešný bundler nenahrádza kontrolu aktívneho panelového
stavu.

### Mastering — matný disabled stav custom tlačidiel — 2026-10-14

- A/B compare, Master Assistant a korekcia offsetu používali vlastné tlačidlá
  mimo zdieľaných `.btn` štýlov. Pri disabled stave si preto ponechávali aktívny
  povrch; samotné zníženie opacity nedávalo konzistentný ani jasný stav. Akcie
  `−10 ms` / `+10 ms` mali navyše iba 8 px text.
- Tieto tri skupiny teraz používajú nepriehľadný matný povrch, jemný okraj,
  sekundárny text a `not-allowed` kurzor. Lokálne opacity pravidlá boli
  odstránené, aby spoločný stav zostal jediným zdrojom vzhľadu. Offsetové akcie
  majú 10 px text a ich existujúce flex zalomenie si poradí s miernym nárastom
  šírky.
- Upravené: `src/styles/22-mastering-workspace.css` a
  `src/styles/45-shared-disabled-controls.css`. Vizuálne treba ešte overiť
  busy/stale kombinácie v plnom aj split mastering paneli.
- `npm run build`: **PASS**, DAW JS **4964/5186 KB**, opt-in stem runtime
  **404/430 KB**, core worklety **150/150 KB**, generative player **3/4 KB** a
  boot path **2176/2200 KB**. Cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali.

### Master meter — čitateľnejší stereo kontext — 2026-10-14

- L/R, ×CORR a HEAD označenia mali 8 px text, rovnako ako stavový verdict
  korelačného metra. Toto sú kontextové menovky dôležitých výstupných meraní,
  nie doplnková dekorácia.
- Kontextové menovky majú 10 px a verdict 9 px. Korelačný verdict stráca časť
  tracking-u, aby zostal čitateľný bez zbytočného rozšírenia úzkeho metra.
- Upravené: `src/styles/08-master-meter.css`. V split docku ešte treba
  vizuálne skontrolovať, že HEAD a MONO+OK nepretekajú pri najužšom master
  strip-e.
- `npm run build`: **PASS**, DAW JS **4964/5186 KB**, opt-in stem runtime
  **404/430 KB**, core worklety **150/150 KB**, generative player **3/4 KB** a
  boot path **2176/2200 KB**. Cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali.

### Motion — spoločné trvanie a systém reduced motion — 2026-10-14

- Základné tlačidlá, dock tabs/LED a Inspector rail používali ručne zadané
  hodnoty 100–120 ms; prechod selected okraja padov nebol definovaný.
- Zavedené sú `--motion-fast` (120 ms), `--motion-state` (160 ms) a spoločná
  easing krivka. Pady teraz animujú aj okraj selected stavu; krátky press
  transform zostáva 80 ms.
- `src/styles/50-motion-accessibility.css` pridáva poslednú globálnu OS
  reduced-motion vrstvu pre CSS animácie, transitions a smooth scrolling.
  Používateľský Calm Motion toggle zostáva zachovaný.
- Čerstvá browser QA nebola dostupná: aktuálna Browser služba poskytla iba
  prázdny Codex Apps backend bez tabov a bez možnosti vytvoriť/navigovať tab.
  Pred uzavretím treba skontrolovať pohyb pri bežnom systéme aj reduced-motion
  a klávesnicový/pointer stav v živej aplikácii.
- `npm run build`: **PASS**, DAW JS **4964/5186 KB**, opt-in stem runtime
  **404/430 KB**, core worklety **150/150 KB**, generative player **3/4 KB** a
  boot path **2176/2200 KB**. Cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali.

### INTENT candidate bank — 2026-10-14

- Z čerstvo vygenerovaného banku piatich kandidátov sa pri 390 × 844 px zmerali
  reálne produkčné prvky: audition aj USE majú 44 × 44 px, iterátor 120 × 44 px
  a Audiotool 85,5 × 44 px. Každý riadok má 342 × 99 px; bank nemá vnútorný
  horizontálny overflow a dokument ostáva široký 390 px.
- Otvorený iterátor sa skladá do šírky 334 px a jeho desať tlačidiel má minimálne
  44 px výšku. Ani otvorený stav nevytvára horizontálny scroll. Päť návrhov sa
  počas QA nevložilo do projektu tlačidlom USE.
- Kontrola odkryla chybu disclosure: `.intent-iteration-panel` mal `display:flex`
  aj pod zatvoreným `<details>`, takže jeho akcie zostávali vykreslené mimo karty.
  Pravidlo v `src/styles/15-command-palette-2.css` teraz panel pri zatvorenom
  stave skryje; mobilné pravidlo nastavuje 44 px aj pre všetky akcie otvoreného
  iterátora v `src/styles/29-premium-hierarchy.css`.
- Aktuálne snímky:
  `output/playwright/premium-live-intent-candidates-390x844-hitareas.png` a
  `output/playwright/premium-live-intent-iteration-open-390x844-hitareas.png`.
  Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali.

### Zdieľané stavy tlačidiel — 2026-10-14

- Spoločný `.btn:focus-visible` vykresľuje 2 px jantárový outline. Audit živého
  shellu našiel `REDO` pri 35 % opacity; všeobecné disabled tlačidlá teraz
  používajú 58 % opacity a `not-allowed` kurzor. Disabled primárne tlačidlo sa
  prepne na neutrálny raised povrch, text `--text-muted` a bez tieňa/glow, aby
  vyzeralo nedostupne a zostalo čitateľné.
- Po HMR mali reálne disabled `REDO` aj `PASTE` computed opacity 0.58. Dočasný
  DOM fixture pre disabled `.btn-primary` potvrdil opacity 1, neutrálny povrch a
  `box-shadow: none`; fixture bol hneď odstránený. Snímka reálneho shellu:
  `output/playwright/premium-live-disabled-hierarchy-1440x900.png`.
- Klávesnicový fokus na aktívnom MOD dock tabe skutočne zodpovedá
  `:focus-visible`: computed outline je 2 px solid amber s 1 px offsetom a
  selected amber tab state ostáva čitateľný súčasne. Snímka:
  `output/playwright/premium-live-dock-focus-visible-1440x900.png`.
- Zmena je spoločný základ. Fokus/disabled kontrast natívnych selectov,
  sliderov, špecializovaných toggle prvkov a per-panel selected stavov zostáva
  samostatnou QA položkou.

### DICE hustá história a mobilné ovládanie — 2026-10-14

- Dva neaplikované VARY návrhy rozšírili živú históriu na `3/3`. Pri 1440 × 900
  a 800 × 900 sa obsah zmestil bez horizontálneho presahu; dock-slot mal 790 px
  vnútornú šírku pri 800 px. Pri 390 × 844 sa panel čisto vertikálne scrolluje,
  pričom celý dokument zostal široký 390 px.
- Na mobile už DICE názov ani návod nezostávajú skrátené. FULL/VARY, locky,
  mode switch, Fav/export, seed, preview/apply, history body a rozsahy sliderov
  majú 44 px dotykovú výšku/šírku. Deväť lockov sa zobrazí ako 3 × 3 mriežka;
  tri history body a ich akcie sú oddelené do riadkov bez prekrytia.
- Snímky: `output/playwright/premium-live-dice-history-3-800x900.png`,
  `output/playwright/premium-live-dice-mobile-controls-390x844-top.png` a
  `output/playwright/premium-live-dice-mobile-controls-390x844-bottom.png`.
  Zmeny sú v `src/styles/37-dice-panel-layout.css`; žiadny preview sa
  tlačidlom APPLY nevložil do projektu.

### EXP dokončený lokálny WAV a mobilný report — 2026-10-14

- Z QA projektu sa stiahol 20,0 s WAV export: 44,1 kHz, 16-bit. Dokončená
  správa potvrdila dekódovaný súbor a zobrazila delivery merania; výsledok
  úprimne označil mix ako `TOO LOUD (Δ 2.9 dB)` a upozornil na low-end dominance.
- Report pri 390 px používal štyri úzke stĺpce a lámal verdict/odporúčanie do
  4 riadkov. `src/styles/34-panel-states.css` teraz dáva `.export-panel` vlastný
  inline-size container a skladá summary do dvoch stĺpcov pod 560 px. Po úprave
  report je 352 px široký, má dve 158 px kolóny a dokument nepresahuje 390 px.
- Snímky: `output/playwright/premium-live-export-complete-1440x900.png` a
  `output/playwright/premium-live-export-complete-390x844-status.png`.
  Uskutočnený export bol z QA projektu; project pattern sa exportom nemení.

### Build po DICE a EXP mobile layout — 2026-10-14

- `npx vite build --logLevel error`: **PASS** po zmenách disabled/focus CSS,
  mobilného DICE layoutu a responzívneho EXP reportu. Bundle-size skript nad
  novým `dist/` hlási DAW JS 5359/5186 KB a core worklets 153/150 KB; štúdio
  boot path je 2175/2200 KB. Čistý HEAD baseline je 5357/5186 KB a 153/150 KB
  workletov, takže oba prekročené limity sú staršie než tieto CSS úpravy.
  Žiadny limit sa nemenil.

### Build po Inspector úprave — 2026-10-14

- `npx vite build`: **PASS za 32,96 s** po zmene lokálneho layoutu preset riadka v Inspectore.
- Zostali upozornenia na moduly so statickým aj dynamickým importom a chunky
  väčšie ako 500 KB; build budgety prešli. Automatické testy sa nespúšťali.

### Build po tabletovom a Mixer layoute — 2026-10-14

- `npx vite build`: **PASS za 23,67 s** po tabletovom Inspector layoute,
  Mixer akciách a desktopovej/mobilnej scroll výnimke. Zostali štandardné
  upozornenia na zmiešané statické/dynamické importy a chunky nad 500 KB;
  build budgety prešli. Automatické testy sa nespúšťali.
- Cielený Prettier a `git diff --check`: **PASS** po všetkých uvedených
  CSS a dokumentačných úpravách.

### Najnovšia kontrola — 2026-10-14

- `npx prettier --write` pre plán a `src/styles/29-premium-hierarchy.css`:
  **PASS**. `git diff --check`: **PASS**. Cielený Prettier pre tieto súbory:
  **PASS**. `npm run typecheck`: **PASS**. Repo-wide `npm run format:check`:
  **FAIL** iba na nedotknutých `src/intent/model-decoder.ts` a
  `tests/probe-split-undo.test.ts`.
- `npm run build` dokončil TypeScript aj Vite kompiláciu, no záverečný size gate
  vrátil **FAIL**: DAW JS 5358/5186 KB a core worklets 153/150 KB. Studio boot
  path 2174/2200 KB a ostatné samostatné kategórie prešli. Vite ponechal
  upozornenia na zdieľané statické/dynamické importy a chunky nad 500 KB.
  Automatické testy sa nespúšťali a bundle budgety sa nemenili.

### Overenie bundle baseline na čistom HEAD — 2026-10-14

- Čistý worktree na `5b551d53f11d1e7697fa7d421cce92463ab3f415` hlási DAW JS
  **5357/5186 KB** a core worklets **153/150 KB**. Working tree po UI zmenách
  pri prvom meraní hlásil 5358/5186 KB; následný build hlási 5359/5186 KB.
  Boot path bol 2174/2200 KB a neskôr 2175/2200 KB. Tieto dve budget
  prekročenia teda existovali pred zmenami tohto plánu a následný rozdiel sa
  pohybuje o 1–2 KB; limity ostávajú nezmenené.
- `npm run build` v čistom HEAD sa zastavil ešte v TSC na troch existujúcich
  chybách v `tests/intent-action-schema-version.test.ts`,
  `tests/master-iterate.test.ts` a `tests/mcp-p2d-ops.test.ts`; samostatný
  `npx vite build` prešiel. Bundle baseline bol preto porovnaný priamo cez
  `scripts/check-bundle-size.mjs`, ktorý v čistom HEAD potvrdil rovnaké dve
  prekročenia. Automatické testy sa nespúšťali.

### Build po INTENT disclosure úprave — 2026-10-14

- `npm run build`: TSC a Vite **PASS**; Vite dokončil za 20,25 s. Záverečný
  bundle gate ostáva **FAIL** na DAW JS 5358/5186 KB a core worklets 153/150 KB;
  studio boot path je 2174/2200 KB a ostatné kategórie prešli. Čistý HEAD
  preukázal 5357/5186 KB a rovnakých 153/150 KB workletov, takže tieto budget
  prekročenia nie sú regresia premium UI. Bundle limity sa nemenili a automatické
  testy sa nespúšťali.

### Spoločný fokus a disabled stavy ovládačov — 2026-10-14

- `.chip` a `.seg-item` majú 2 px jantárový `:focus-visible` outline;
  vybraný segmented stav dostáva tenký spodný jantárový indikátor. Disabled
  chip/segmented prvky ukazujú `not-allowed` a zníženú opacity. Zdieľaný základ
  01-base dáva 2 px fokus aj custom `.slider-track`, sekvenčným krokom a padom.
- Hlavné dock panely teraz dávajú 2 px outline sliderom, checkboxom a rádiám,
  používajú jantárový native accent a tlmia disabled select/range/checkbox/radio
  prvky jednotným spôsobom. Disabled custom slider má čitateľnejších 58 % opacity
  a `not-allowed` kurzor. Existujúci input/select fokus zostáva zachovaný.
- Zmena je zatiaľ overená zdrojovo; Browser karta nevrátila otvorenú lokálnu
  stránku, preto outline clipping, konkrétne disabled ovládače a selected
  varianty ešte potrebujú živú kontrolu pri 1440/800/390 px.
- Súbory: `src/styles/01-base.css`, `src/styles/02-sequencer.css`,
  `src/styles/20-control-kit.css` a `src/styles/32-dock-panel-finishing.css`.
  Automatické testy sa nespúšťali.

### Mixer a Devices — focus, selected a disabled výnimky — 2026-10-14

- Vybraný mixer strip používa 2 px jantárovú vnútornú stopu. FX device-chain
  tlačidlá majú vlastný 2 px `:focus-visible` outline, aj keď nie sú `.btn`.
- FX device akcie a fader-menu disabled tlačidlá zjednotili opacity na 0.58 a
  kurzor `not-allowed`; predtým používali 0.3/0.4 a prepisovali spoločný stav.
- Zmena je zdrojovo skontrolovaná. Aktívny selected strip, keyboard focus
  device chain a disabled menu prvky ešte nemajú novú živú screenshot kontrolu.
- Upravené: `src/styles/03-mixer.css` a `src/styles/21-device-panel.css`.

### Build po zjednotení fokusu natívnych ovládačov — 2026-10-14

- `npx vite build --logLevel error`: **PASS**. Cielený Prettier a
  `git diff --check`: **PASS**; `npm run typecheck`: **PASS**.
  Automatické testy sa nespúšťali.
- Bundle-size gate hlási DAW JS **5364/5186 KB**, core worklets **153/150 KB**
  a štúdio boot path **2176/2200 KB**. Čistý HEAD baseline je 5357/5186 KB
  a 153/150 KB; aktuálny pracovný strom je teda o 7 KB vyššie v DAW súčte.
  Rozdiel treba vyhodnotiť spolu so súčasne zmenenými zdrojovými súbormi mimo
  tejto CSS vlny; žiadny bundle limit sa nemenil.

### Inspector — viditeľný selected režim — 2026-10-14

- Tlačidlá SIMPLE/ADVANCED mali správne `aria-pressed` aj `active` triedu, no
  chýbal im selected vizuálny stav. Aktívna voľba teraz používa tlmený amber
  povrch, jasný text a 2 px spodnú stopu; ostatné amber akcie tým nemenia farbu.
- Upravené: `src/styles/31-workspace-finishing.css`. Nový selected stav ešte
  treba overiť pri prepnutí oboch režimov na 1440/800/390 px.

### Aktuálne overenie — 2026-10-14

- `npx vite build --logLevel error`: **PASS**; cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate: DAW JS **5364/5186 KB**, core worklets **153/150 KB**,
  studio boot path **2176/2200 KB**. Limity sa nemenili.
- Posledný `npm run typecheck`: **FAIL** na `src/intent/conversation.ts:538`
  (`setReturnGain` nie je definované) a `tests/param-readback.test.ts:164`
  (`doc` nie je použité). Obe chyby sú mimo vizuálnych súborov tejto vlny;
  nepripisujem ich CSS zmenám.

### Reference Map — rozlíšiteľný disabled selected stav — 2026-10-14

- Disabled tlačidlá v Reference Map používajú 58 % opacity; vybraná, ale
  disabled reading voľba používa 78 %, takže si zachová selected identitu a
  zároveň pôsobí nedostupne. Kurzor pre oba prípady ukazuje `not-allowed`.
- `ReferenceMapPanel` renderuje chyby cez `role="alert"`. Scoped karta teraz
  používa tlmenú plochu so stop-color ľavým okrajom, prirodzenou typografiou a
  zalamovaním dlhých názvov/detailov; jej reálny error aj stale výsledkový stav
  ešte zostávajú na živú kontrolu.
- Upravené: `src/styles/30-reference-map.css`. Automatické testy sa nespúšťali.

### Konzistentná disabled čitateľnosť naprieč panelmi — 2026-10-14

- Odstránené boli staršie disabled výnimky s 30–50 % opacity v history/dock
  ovládačoch, Arrangement, Theme, landing, context menu, chord editor,
  Beatmangler a Mastering A/B/Assistant. Tieto prvky teraz používajú 58 %
  opacity a `not-allowed`; dočasne čakajúci energy slider si ponecháva `wait`
  kurzor. Vybraná disabled voľba Reference čítania zostáva na 78 % a informatívna
  Mastering metrika na 100 % opacity.
- Zdrojový audit po úprave nenašiel disabled opacity pod 58 % okrem zámerných
  selected/informačných variantov. Nový vizuálny dôkaz busy/disabled kombinácií
  ešte treba získať na živej stránke.
- Neskoršia kontrola empty-state snímok ukázala, že 58 % stále príliš tlmí text
  spoločných tlačidiel a chipov. Vrstva 45 teraz nastavuje plnú typografickú
  opacitu pre `.btn`, chipy, segmented controls aj vlastné panelové button
  triedy; matný povrch a tlmený okraj zachovávajú čitateľný disabled signál.
  Natívne selecty teraz zachovávajú čitateľnú hodnotu na matnom povrchu;
  range/checkbox/radio polia si naďalej ponechávajú tlmený disabled signál.
- Upravené: `01-base.css`, `04-arrangement.css`, `05-drop-zone.css`,
  `09-scale-panel-popover.css`, `10-scale-panel-popover-2.css`,
  `15-command-palette-2.css`, `16-landing-prompt.css`, `19-dock-chrome.css` a
  `22-mastering-workspace.css`. Automatické testy sa nespúšťali.

### Aktuálne overenie disabled hierarchie — 2026-10-14

- `npx vite build --logLevel error`: **PASS**; cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate zostáva **FAIL** na DAW JS **5364/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Bundle limity sa nemenili.
- Aktuálny `npm run typecheck` stále hlási chyby v
  `src/intent/conversation.ts:538` (`setReturnGain`) a
  `tests/param-readback.test.ts:164` (nepoužitý `doc`).

### Aktuálne overenie Reference error surface — 2026-10-14

- `npx vite build --logLevel error`: **PASS**; cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle-size gate: DAW JS **5365/5186 KB**, core worklets **153/150 KB**,
  studio boot path **2176/2200 KB**. Čistý HEAD DAW baseline je 5357 KB; limity
  zostali nezmenené.
- Browser tab-list ostáva prázdny aj po zaradení lokálnej KYX stránky do panelu,
  preto nový error card a ostatné nedávne states ešte potrebujú screenshot QA.

### MOD vybraná automation a kontext úprav — 2026-10-14

- Vybraná automation lane teraz nesie tlmený amber povrch a vnútornú pulznú
  stopu, takže výber nespolieha iba na farbu textu a okraja. Nefokusované lane
  dostávajú jemný hover; klávesnicový fokus je samostatný 2 px outline.
  `aria-current="true"` na vybranej lane poháňa aj jej štýl, aby vizuálny a
  prístupnostný selected stav zostali zviazané.
- LFO a macro karty jemne zvýraznia okraj pri hover a pri editovaní ovládania
  pomocou `:focus-within`. Prechody sú krátke a pri reduced motion vypnuté.
- Upravené: `src/styles/38-mod-panel-finishing.css` a import na konci
  `src/styles/index.css`; `src/ui/ModPanel.tsx` oznamuje selected lane cez
  `aria-current`. Starší split screenshot potvrdzuje geometriu kariet,
  nie nové stavy; browser tab-list je prázdny, takže vizuálna kontrola nového
  výberu/fokusu ešte zostáva. Automatické testy sa nespúšťali.

### DICE selected režim — jemnejší pulz — 2026-10-14

- FULL/VARY, locky a favorite si zachovávajú amber selected povrch, no teraz
  majú aj tenkú vnútornú spodnú stopu. Aktívny veľký roll button si zachová
  strieborný horný odlesk a zreteľný amber gradient, ale trvalý vonkajší glow
  nahrádza vnútorný amber edge trace. Výber je tak čitateľný bez toho, aby
  aktívny DICE prvok neustále súťažil s preview a ostatným obsahom.
- Upravené v `src/styles/38-mod-panel-finishing.css`. Stav je potvrdený iba
  zdrojovo; živá kontrola DICE FULL/VARY/lock/favorite pri split docku ostáva
  otvorená. Automatické testy sa nespúšťali.

### DICE sémantický toggle stav — 2026-10-14

- Prepínače FULL/VARY, všetkých deväť lockov a aktuálny favorite teraz
  vystavujú `aria-pressed` podľa rovnakého stavu, ktorý určuje selected štýl.
  Veľké FULL/VARY generovacie akcie zostávajú akciami a netvária sa ako toggle.
- Upravené: `src/ui/DiceTray.tsx`. Potrebuje ešte živú kontrolu v a11y strome;
  automatické testy sa nespúšťali.

### Build po MOD/DICE stavovej vrstve — 2026-10-14

- `npx vite build --logLevel error`: **PASS**; cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate ostáva **FAIL** na DAW JS 5365/5186 KB a core worklets 153/150 KB;
  studio boot path je 2176/2200 KB. Tieto hodnoty zodpovedajú predchádzajúcej
  kontrole a CSS úprava veľkosť JavaScriptu nemení.
- `npm run typecheck`: **FAIL** na `src/intent/conversation.ts:538`
  (`setReturnGain` nie je definované) a `tests/param-readback.test.ts:164`
  (nepoužitý `doc`); obe chyby sú mimo tejto vizuálnej vrstvy.
- Aktuálny Browser tab-list je prázdny, preto nový MOD focus/selected stav ani
  utlmený DICE glow zatiaľ nemajú čerstvý screenshot dôkaz.

### Najnovšie overenie po DICE toggle sémantike — 2026-10-14

- `npx vite build --logLevel error`: **PASS**; cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- `npm run typecheck`: **FAIL** iba na existujúcom nepoužitom `doc` v
  `tests/param-readback.test.ts:164`; predchádzajúca chyba v
  `src/intent/conversation.ts` sa v tejto kontrole už neobjavila.
- Bundle gate: DAW JS **5366/5186 KB**, core worklets **153/150 KB**,
  studio boot path **2176/2200 KB**. Obe prekročenia zostávajú otvorené;
  limity sa nemenili. Čerstvá živá kontrola nových MOD/DICE stavov ešte chýba.

### MOD grid — všetky štyri sekcie v pracovnom riadku — 2026-10-14

- Screenshot `output/playwright/premium-live-mod-panel-1440x900-review.png`
  ukazuje, že pri 1440 px mal MOD iba tri explicitné stĺpce, a preto sa MACROS
  presunuli pod AUTOMATION, MODULATORS a SCENES. Krátke prázdne karty sa navyše
  natiahli na výšku SCENES.
- `.mod-panel` teraz používa auto-fit mriežku s minimálnou šírkou 300 px pre
  sekciu a zarovnáva karty od horného okraja. Pri dostatočne širokom dock slote
  sa zmestia štyri sekcie do jedného riadka; split a úzke režimy znižujú počet
  stĺpcov podľa skutočnej šírky slotu.
- Upravené v `src/styles/38-mod-panel-finishing.css`. Je to zatiaľ zdrojová
  zmena; nové rozloženie potrebuje screenshot kontrolu pri 1440/1280, split
  docku a 390 px.

### Build a quality gates po MOD grid — 2026-10-14

- `npx vite build --logLevel error`: **PASS**. Cielený Prettier a
  `git diff --check`: **PASS**; automatické testy sa nespúšťali.
- `npm run format:check`: **FAIL** na šiestich súboroch mimo tejto vizuálnej
  iterácie. `npm run typecheck`: **FAIL** iba na nepoužitom `doc` v
  `tests/param-readback.test.ts:164`.
- Bundle-size gate ostáva **FAIL**: DAW JS 5366/5186 KB, core worklets 153/150 KB;
  studio boot path 2176/2200 KB. Limity sa nemenili.
- Snímka pred úpravou je
  `output/playwright/premium-live-mod-panel-1440x900-review.png`; po zmene
  treba získať nové 1440/1280, split a mobilné zábery.

### Obnovený strict typecheck — 2026-10-14

- Odstránená bola nepoužitá lokálna `doc` deklarácia v
  `tests/param-readback.test.ts`; lokálny objekt sa v tomto parse-only teste
  nepoužíval. Správanie testov ani produkčný kód sa tým nemení.
- `npm run typecheck`: **PASS**. Cielený Prettier pre test súbor: **PASS**;
  automatické testy sa nespúšťali.
- Repo-wide `npm run format:check` stále zlyháva na šiestich iných súboroch
  súčasne upravovaných mimo tejto UI práce. Bundle gate ostáva na 5367/5186 KB
  DAW JS a 153/150 KB core workletov; limity sa nemenili.

### Plný build po obnovení typechecku — 2026-10-14

- `npm run build` úspešne dokončil AudioWorklet prebuildy, `tsc --noEmit`, Vite
  aj generovanie PWA. Zlyhal až záverečný bundle-size gate: DAW JS
  **5367/5186 KB**, core worklets **153/150 KB**. Studio boot path je
  **2176/2200 KB**. Žiadny limit sa nemenil.
- `npm run typecheck`: **PASS**. Repo-wide `npm run format:check` ostáva
  **FAIL** na šiestich súboroch mimo tejto UI iterácie. Automatické testy sa
  nespúšťali.

### Reference MATCH — stale guard a výsledková hierarchia — 2026-10-14

- MATCH výsledok si pamätá identitu projektu a verziu referenčnej analýzy, z
  ktorých vznikol. Pri zmene ktoréhokoľvek z nich zostáva report čitateľný,
  zobrazí status správu a zablokuje APPLY MATCH aj per-track rezonančné rezy;
  starý snapshot projektu sa po označení stale uvoľní. Počas merania je APPLY
  vypnutý, takže sa nedá použiť čiastočne dokončený report bez stem atribúcie.
- Výsledková tabuľka má vlastný klávesnicovo dostupný horizontálny scroll.
  Summary, meracie metadáta, vlastníctvo pásiem, návrhy GROW a rezonancie majú
  oddelenú typografickú a povrchovú hierarchiu, ktorá sa skladá pri úzkom paneli.
- Upravené: `src/ui/ReferenceMapPanel.tsx` a `src/styles/30-reference-map.css`.
  `npm run typecheck`, `npx vite build --logLevel error`, cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali. Posledný plný
  bundle gate zostáva otvorený na 5367/5186 KB DAW JS a 153/150 KB core
  workletov; boot path bol 2176/2200 KB. Posledný repo-wide `format:check`
  zlyhal na dvoch nesúvisiacich súboroch mimo tejto UI vlny. Browser tab-list
  je prázdny, takže čerstvá živá kontrola stale guardu a úzkeho reportu ešte
  chýba.

### Arrangement — zjednotené selected a keyboard focus stavy — 2026-10-14

- RIPPLE, CUT, GEN a LOOP pre vybraný clip už nepoužívajú izolovaný modrý
  selected stav. Aktívny prepínač má tlmený jantárový povrch a 2 px vnútornú
  stopu; hover zvýši kontrast bez trvalého glow. Recording toolbar používa
  rovnakú stopu pre aktívne LOOP/PUNCH/monitor ovládanie a ripple preview pri
  posúvaní klipov používa jantárový dashed overlay.
- Capture Setup selecty už pri klávesnicovom fokuse nestrácajú obrys: 2 px
  amber outline sa zobrazuje nad ich pôvodným focus-border pravidlom. Gain
  slider aj samostatné Arrangement toggles majú rovnakú viditeľnú focus
  treatment; disabled prepínače zostávajú čitateľné a ukazujú `not-allowed`.
- Audio take lane má selected povrch s vnútornou amber stopou, samostatný
  `:focus-visible` pre výber take aj klipové segmenty a 28–36 px ovládacie
  ciele. Hlavička take lanes sa v úzkom arrangement kontajneri skladá do
  viacerých riadkov; farby comp waveform segmentov zostávajú zachované.
- Upravené: `src/styles/39-arrangement-interaction-finishing.css` a import v
  `src/styles/index.css`. Zmena je zatiaľ potvrdená zdrojovo; live screenshot a
  overenie kontrastu po theme prepnutí ešte chýbajú. Automatické testy sa
  nespúšťali.

### Track rack a Inspector — selected/focus dokončenie — 2026-10-14

- Vybraný track teraz používa rovnakú tenkú amber stopu ako ostatné vybrané
  ovládanie; názov aj farebná bodka stopy zostávajú čitateľné. Hover na
  nevybraných track tabs mení iba kontrast okraja.
- Inspector select pri klávesnicovom fokuse znovu získava 2 px focus ring,
  ktorý predtým rušilo všeobecné `outline: none`. Disabled select zachová názov
  pri 58 % opacity a ukazuje `not-allowed`; selected SIMPLE/ADVANCED stav už
  predtým používal spodnú amber stopu.
- Upravené: `src/styles/40-track-inspector-finishing.css` a import v
  `src/styles/index.css`. Toto je zdrojová kontrola bez čerstvého live
  screenshotu. Automatické testy sa nespúšťali.

### Natívne polia — focus ring mimo dock plôch — 2026-10-14

- Audit všetkých legacy `:focus { outline: none; }` pravidiel potvrdil, že polia
  v pracovných dock paneloch už pokrýva spoločná focus vrstva 32. Projektové,
  browser, scale/generate, plugin, gallery, help a command-palette polia túto
  vrstvu nepoužívajú, preto dostali vlastný 2 px amber `:focus-visible` ring.
  Dodatočná kontrola odhalila aj globálny číselný input DragNumber používaný
  v TopBare a value popoveroch, `+ TRACK` select mimo dock scope a selecty
  plávajúceho instrument pluginu. Rozšírený audit doplnil aj track rename,
  Generate range, Gallery publish input, landing prompt a TSAR select/toggle.
  Všetky získali zodpovedajúci amber focus ring.
- Cielená vrstva nemení mouse focus ani vzhľad polí bez fokusu. Rozsah sleduje
  pôvodné resetované triedy, aby sa nemenili ostatné native controls.
- Druhý úplný scan `outline: none` v `src/styles` priradil všetky nálezy k
  existujúcej spoločnej vrstve 32, Arrangement vrstve 39 alebo tejto vrstve 41;
  nezostal neklasifikovaný reset.
- Upravené: `src/styles/41-native-field-focus.css` a import v
  `src/styles/index.css`. Čerstvá vizuálna kontrola nových ringov ešte chýba.

### Overenie po natívnom focus a posledných finishing vrstvách — 2026-10-14

- `npm run build` dokončil AudioWorklet prebuildy, typecheck, Vite aj PWA a
  zlyhal len na záverečnom bundle-budget gate: DAW JS **5367/5186 KB**, core
  worklets **153/150 KB**; studio boot path **2176/2200 KB**. Limity sa
  nemenili. Ostatné budgety prešli.
- Priamy `npx vite build --logLevel error` prešiel aj po take-lane a kompletnom
  audite legacy focus resetov pre DragNumber, track rename, `+ TRACK`, plugin,
  Generate, Gallery, landing a TSAR;
  cielený Prettier, `git diff --check`, nový `npm run typecheck` aj repo-wide
  `npm run format:check` tiež prešli. Automatické testy sa nespúšťali.
- Následný `node scripts/check-bundle-size.mjs` potvrdil na aktuálnom `dist`:
  DAW JS **5367/5186 KB**, core worklets **153/150 KB**, studio boot path
  **2176/2200 KB**. Obe prekročenia sú potvrdené; limity sa nezmenili.
- Živý browser context stále nemá otvorenú kartu, takže čerstvá screenshot QA
  týchto nových stavov zostáva otvorená.

### Mastering — responzívne správanie split docku — 2026-10-14

- `.mastering-panel` teraz vystavuje vlastnú inline-size container query.
  Intro, mastering flow, processing controls, meter a úzke A/B/assistant
  skupiny sa skladajú podľa šírky panelového slotu aj na širokom okne so
  split dockom; existujúce breakpointy podľa viewportu zostávajú zachované.
- Summary cards si ponechávajú vlastné 3+2 vyváženie pri šírke 578–765 px;
  nové panelové query neprepisujú ich lokálnu geometriu.
- Upravené: `src/styles/36-mastering-overview-layout.css`. Zmena potrebuje
  ešte live screenshot kontrolu v otvorenom split docku a pri 390 px.
- `npx vite build --logLevel error`, repo-wide `npm run format:check` a
  `git diff --check` prešli; automatické testy sa nespúšťali.

### Devices — úzke GROW/REZONANS sloty — 2026-10-14

- GROW readout a akcie sa pri úzkom dock slote zalomia podľa dostupnej šírky;
  scene chip môže prejsť do ďalšieho riadka bez horizontálneho pretečenia.
- REZONANS readout a hint sa skladajú podľa slotu. Pod 420 px prejde každá
  voice karta z pevnej päťstĺpcovej rady na šírkovo vhodnú mriežku, aby selecty
  nestratili použiteľnú šírku v split docku.
- Upravené: `src/styles/42-device-slot-finishing.css` a import v
  `src/styles/index.css`. Potrebuje live kontrolu pri 560, 420 a 390 px.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`
  prešli; automatické testy sa nespúšťali.
- `npm run typecheck` teraz hlási iba nepoužitý import `beforeEach` v
  `tests/mcp-headless-acceptance.test.ts`; tento nový súbor nesúvisí s UI briefom.
  Bundle gate aktuálne hlási DAW JS **5368/5186 KB**, core worklets
  **153/150 KB** a studio boot path **2176/2200 KB**. Limity sa nemenili.

### INTENT — spoločný busy signál — 2026-10-14

- Hlavný status riadok teraz dostane jemnú amber stopu počas generovania,
  smart routingu, SESSION THEATRE a MUTATE. Indikátor je zámerne neurčitý;
  SONG zostáva pri existujúcom determinate počítadle sekcií.
- Indikátor je dekoratívny pre accessibility tree a rešpektuje
  `prefers-reduced-motion`; textový `role=status` ostáva jediným zdrojom
  oznámenia aktivity.
- Upravené: `src/ui/intent/StatusLine.tsx`, `src/ui/IntentPanel.tsx`,
  `src/styles/43-intent-busy-finishing.css` a import v `src/styles/index.css`.
  Potrebuje live kontrolu generovania, smart routingu, split docku a reduced
  motion. `npm run typecheck`, `npx vite build --logLevel error`, cielený
  Prettier aj `git diff --check` prešli; automatické testy sa nespúšťali.
- Aktuálny bundle gate stále hlási DAW JS **5367/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Ostatné kategórie
  prešli a limity sa nemenili. Dve prekročenia ostávajú otvorené.

### INTENT — čitateľné vypnuté akcie — 2026-10-14

- Snímka prázdneho stavu ukázala, že spoločné `opacity: 0.58` robilo popisy
  vypnutých akcií príliš nevýrazné. Spoločné tlačidlá, chipy a segmented
  ovládanie si teraz ponechávajú plnú opacitu textu a používajú tmavší matný
  povrch, tlmený okraj a žiadny tieň; zvolený disabled prvok zachová jemnú
  amber stopu. Aktívny stav GENERATE sa nemení. V predvolenom Signal Glass
  theme má text `--text-dim` na `--surface-0` kontrast 6,41:1.
- Keď chýba textový aj projektový brief, pod poľom sa zobrazí stručný pokyn,
  ktorý vysvetlí, ako odomknúť generovanie. Rovnaký text je naviazaný na
  textarea cez `aria-describedby`; pri dostupnom uloženom brief-e pokyn zmizne.
- Upravené: `src/styles/44-intent-empty-prompt.css`,
  `src/styles/45-shared-disabled-controls.css`, `src/styles/index.css` a
  `src/ui/IntentPanel.tsx`. Na potvrdenie
  disabled/active kontrastu a orezania focus ringu ešte treba čerstvú živú
  snímku na desktope aj mobile.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`
  prešli. `npm run typecheck` hlási jedinú chybu: nepoužitý `beforeEach` v
  novom `tests/mcp-headless-acceptance.test.ts`; UI zmeny testy nemenili.
- `node scripts/check-bundle-size.mjs` stále zlyháva na DAW JS **5368/5186 KB**
  a core worklets **153/150 KB**; studio boot path je **2176/2200 KB**.
  Limity sa nemenili. Automatické testy sa nespúšťali.

### Disabled selecty — čitateľné aktuálne hodnoty — 2026-10-14

- Disabled selecty v pracovných paneloch teraz zachovávajú čitateľný text a
  používajú matný povrch s tlmeným okrajom. Hodnota zostáva užitočným kontextom,
  aj keď ovládanie práve nemožno zmeniť. Range, checkbox a radio si ponechávajú
  tichší disabled signál.
- Upravené: `src/styles/46-disabled-select-readability.css` a import v
  `src/styles/index.css`. Interakcia ani projektové dáta sa nemenia.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`
  prešli; automatické testy sa nespúšťali. `npm run typecheck` stále blokuje
  nepoužitý `beforeEach` v `tests/mcp-headless-acceptance.test.ts`.
- Bundle gate aktuálne zlyháva pri DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.
  Čerstvá živá snímka disabled selectov ešte chýba.

### Strict typecheck — posledný beh — 2026-10-14

- Odstránený nepoužitý import `beforeEach` z
  `tests/mcp-headless-acceptance.test.ts`; žiadna testovacia logika sa nemenila.
- `npm run typecheck`: **PASS**. Cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali.
- Produkčný Vite build prešiel; size gate aktuálne prekračuje limity o 182 KB
  pre DAW JS a o 3 KB pre core worklets. Čistý HEAD baseline z predošlej
  kontroly už bol nad oboma limitmi.

### Panelové nadpisy — typografická kotva — 2026-10-14

- Hlavné `h2.panel-title` nadpisy sa zjednotili na 15 px, čo je dolná hranica
  definovaného rozsahu 15–17 px pre názov panelu. Lokálne `h3` a metadata
  zostávajú kompaktné, takže sa nezväčšuje typografia hustých ovládacích plôch.
- Upravené: `src/styles/29-premium-hierarchy.css`. Toto je zdrojová zmena;
  screenshot pri 1440/800/390 px ešte treba vizuálne skontrolovať.
- `npm run typecheck`, `npm run format:check`, `npx vite build --logLevel error`,
  cielený Prettier pre plán a `git diff --check`: **PASS**. Automatické testy
  sa nespúšťali.
- Bundle gate: DAW JS **5368/5186 KB**, core worklets **153/150 KB**;
  studio boot path **2176/2200 KB**. Dve prekročenia sú potvrdené na aktuálnom
  builde; žiadny budget sa nemenil.

### Zjednotenie spoločného spacingu — 2026-10-14

- Opakované medzery v panelovej navigácii a hlavných ovládacích plochách teraz
  používajú existujúce tokeny 4/8/12 px: riadky Pattern toolbaru, dock tabs,
  track tabs, pattern chips, Mixer channel strips a Mastering metriky.
- Pri dock taboch zostáva mobilná výška 34 px; zmenili sa iba vnútorné
  medzery, aby aktívna záložka a názvy sledovali rovnaký rytmus ako desktop.
- Upravené: `src/styles/29-premium-hierarchy.css`. Zmena zachováva hustý
  control sizing; nový screenshot pri všetkých šírkach ešte chýba.
- Cielený Prettier, `git diff --check` a `npx vite build --logLevel error`:
  **PASS**. `scripts/check-bundle-size.mjs` potvrdil DAW JS **5368/5186 KB**,
  core worklets **153/150 KB** a studio boot path **2176/2200 KB**; limity sa
  nemenili. Automatické testy sa nespúšťali.

### Reference Map — mobilné hlavné ovládanie — 2026-10-14

- Tempo reading, apply akcie a MATCH rezonančné tlačidlá teraz používajú
  12 px text namiesto 10 px metadata veľkosti. Pri šírke vlastného panelu do
  420 px dosahujú inputs, selecty a hlavné akcie minimálne 44 px výšky; pravidlo
  vychádza z inline šírky dock slotu, nie z viewportu.
- Upravené: `src/styles/30-reference-map.css`. Panel si zachováva vlastný scroll,
  takže väčšia touch výška rozširuje pracovný obsah, nie okno aplikácie.
- Čerstvá mobilná screenshot kontrola nových rozmerov ešte chýba.
- `npm run typecheck`, `npx vite build --logLevel error`, cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate zostáva **FAIL** na DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Arrangement — mobilné dotykové ciele — 2026-10-14

- V úzkom Arrangement dock slote majú teraz hlavné capture, edit, zoom,
  production, SNAP/GEN a take-lane ovládače minimálne 44 px výšky a 12 px text.
  Ripple/SNAP riadky sa pri nedostatku šírky zalomia, aby väčšie ciele nepretiekli
  cez panel.
- Upravené: `src/styles/39-arrangement-interaction-finishing.css`. Pravidlo sa
  viaže na šírku Arrangement timeline kontajnera do 420 px; desktopová hustota
  zostáva nezmenená.
- Čerstvá mobilná screenshot kontrola zalomenia aj plného take-lane stavu ešte
  chýba.
- `npm run typecheck`, `npx vite build --logLevel error`, cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate stále hlási DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Track rack — mobile čitateľnosť a selected trace — 2026-10-14

- Selected/hover finishing bol zacielený na `.rack-wrap`, hoci tento wrapper
  v UI neexistuje; odstránil som aj jeho neúčinný základný layout. CSS teraz
  používa skutočný `.track-tabs` tablist, takže selected amber trace, hover a
  reduced-motion prechod zasiahnu vykreslené taby.
- Pri viewportoch do 520 px sa názvy stôp už nestláčajú do úzkych zalomených
  stĺpcov. Tablist sa vodorovne posúva, ponechá taby v ich prirodzenej šírke
  a pri zmene track selection posunie aktívnu stopu do viditeľnej oblasti.
  Dlhé vlastné názvy sa môžu skrátiť v rámci 70vw; ich plný názov zostáva v
  aria-label a title.
- Upravené: `src/styles/01-base.css`,
  `src/styles/40-track-inspector-finishing.css` a `src/ui/TrackTabs.tsx`.
  Čerstvý mobilný screenshot aj kontrola klávesnicového scrollu ešte chýbajú.
- `npm run typecheck`, `npx vite build --logLevel error`, cielený Prettier a
  `git diff --check`: **PASS**; automatické testy sa nespúšťali. `rg` už v
  `src` nenachádza nepoužitý `.rack-wrap` selektor.
- Bundle gate aktuálne hlási DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Devices — mobilné dotykové ciele reťazca — 2026-10-14

- FX reťazec mal na 390 × 844 px približne 30 px vysoké tlačidlá. V úzkom
  bottom-dock slote majú teraz výber nástroja a efektov 44 px výšku a 12 px text;
  existujúce zalamovanie zachováva šírku panelu.
- Pravidlo v `src/styles/42-device-slot-finishing.css` sa aktivuje podľa šírky
  dock slotu do 420 px, takže rozdelený dock správa rovnako ako mobilný viewport.
- Východiskový screenshot `output/playwright/premium-live-devices-chain-5-390x844.png`
  potvrdzuje problém s malou výškou tlačidiel. Čerstvá snímka po zmene ešte chýba;
  treba preveriť aj vybraný efekt a focus outline.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; CSS-only zmena nemení TypeScript.
- Bundle gate zostáva **FAIL** na DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### TopBar — mobilné transportné ciele — 2026-10-14

- Play, Record a Stop boli v mobile obmedzené na 32 px výšku, čo je citeľne
  menej než 44 px ciele v INTENT, Arrangement a Devices. Pri viewportoch do
  520 px majú teraz tieto tri hlavné transportné tlačidlá 44 × 44 px; ostatné
  utility ovládače zostávajú kompaktné.
- Pravidlo je v novej aditívnej vrstve
  `src/styles/47-shell-touch-targets.css`, importovanej po finishing CSS.
  Rozširuje iba mobilný transportný riadok; desktopový TopBar nemení.
- Predchádzajúci screenshot `output/playwright/premium-390x844.png` dokladá
  32 px východiskové ovládače. Čerstvá snímka po zmene ešte chýba; treba
  potvrdiť, že transportný riadok nemá horizontálny overflow.
- `npm run typecheck`, `npm run format:check`,
  `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; ide o CSS-only zmenu.
- Bundle gate zostáva **FAIL** na DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Dock — desktopový selected/focus dôkaz — 2026-10-14

- Existujúci záber `output/playwright/premium-live-dock-focus-visible-1440x900.png`
  zobrazuje MOD tab súčasne ako otvorený panel a klávesnicovo fokusovaný tab.
  Jantárový selected stav a svetlý focus obrys sa rozlišujú a na 1440 × 900 px
  nie sú viditeľne orezané.
- Táto kontrola uzatvára iba desktopový dock-tab prípad. Mobilný transport,
  split dock a ostatné focus ringy na viacerých paneloch stále potrebujú čerstvé
  screenshoty pri šírkach z QA matice.

### MIDI — úzky slot a dotykové ciele — 2026-10-14

- Východiskový záber `output/playwright/premium-live-midi-390x844.png` ukazuje
  24 px vysoké MIDI ON/OFF, latency a tabuľkové ovládače. Pri slote do 420 px
  majú INPUT/CREATIVITY, MIDI ON/OFF, CALIBRATE LATENCY aj DEVICE/DRUM CH/INST
  CH selecty minimálne 44 px a 12 px text.
- Do 560 px MIDI panel prestáva vytvárať vnorený pevný scroll; obsah posúva
  nadradený dock slot, ktorý už ovláda mobilný sheet. Širšie sloty si ponechajú
  hustotu desktopového editora.
- Upravené: `src/styles/48-midi-mobile-layout.css` a import v
  `src/styles/index.css`. Čerstvý mobile screenshot po zmene aj kontrola MIDI
  ON stavu ešte chýbajú; externý hardware nie je v tomto workspace dostupný.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; TypeScript sa nemenil.
- Bundle gate stále zlyháva na DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Arrangement — mobilné ovládanie Capture Setup — 2026-10-14

- Záber `output/playwright/premium-live-arrangement-capture-open-390x844.png`
  ukázal približne 28 px výšku selectov pre armed track, CH 2 a režim take,
  hoci disclosure tlačidlo Capture Setup už malo dotykový cieľ 44 px.
- Armed track, Capture Setup channel/take/device selecty aj vnorený Input
  Routing disclosure majú teraz v úzkom timeline slote minimálne
  `--touch-target-large` (44 px); vstupné routovanie dostalo čitateľný matný
  disclosure povrch. Desktopové rozmery sa nemenia.
- Upravené: `src/styles/39-arrangement-interaction-finishing.css`. Nové ciele
  treba ešte vizuálne skontrolovať pri fyzickom zariadení s viac než dvomi
  vstupnými kanálmi.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Arrangement — dotykové MIDI lanes — 2026-10-14

- MIDI lane `+` bolo 20 × 20 px a lane/clip plocha mala len 32/24 px výšku.
- Pri šírke timeline do 620 px má teraz lane `+` tlačidlo 44 × 44 px a MIDI klip 44 px výšku
  v 50 px lane riadku. Šírka klipu ďalej vyjadruje jeho hudobné trvanie.
- Pridaný je vnútorný 2 px amber `:focus-visible` ring pre MIDI klipy aj lane
  `+` tlačidlo; fokus tak ostáva čitateľný v horizontálne scrollovateľnej mriežke.
- Focus ring klipu ponecháva jeho absolútne časové umiestnenie nedotknuté; pri
  kontrole zdroja sa odstránilo `position: relative`, ktoré by ho vyradilo z
  časovej pozície.
- Upravené: `src/styles/39-arrangement-interaction-finishing.css`. Čerstvý
  screenshot potrebuje dlhý aj krátky klip, disabled `+` a fokus na oboch typoch
  ovládania pri 390 px.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Zjednotenie mobilného hit-area tokenu — 2026-10-14

- Opakované 44 px výšky a šírky pre hlavné dotykové akcie teraz používajú
  spoločný `--touch-target-large: 44px` z `src/styles/01-base.css`. Token
  používajú track pads, INTENT, DICE, Arrangement, Reference, Devices, MIDI,
  transport, scene drag gripy a instrument history; husté desktopové rozmery
  zostávajú bez zmeny.
- Opravil som zároveň oba compact-density pad varianty na ten istý token, aby
  density theme neoddelila dotykovú geometriu od štandardného racku.
- Upravené CSS súbory: `01-base`, `05-drop-zone`, `06-help-overlay`,
  `10-scale-panel-popover-2`, `29-premium-hierarchy`, `30-reference-map`,
  `37-dice-panel-layout`, `39-arrangement-interaction-finishing`,
  `42-device-slot-finishing`, `47-shell-touch-targets` a
  `48-midi-mobile-layout`. Rozmery 44 px v waveform/curve vizualizáciách
  zostávajú layoutovou geometriou a nie sú týmto tokenom nahradené.
- Čerstvý vizuálny screenshot kontrolný beh po tokenizácii ešte chýba.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; TypeScript sa nemenil.
- Bundle gate potvrdzuje DAW JS **5368/5186 KB** a core worklets **153/150 KB**
  (**FAIL**); studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Export — čitateľný MIX CHECK report — 2026-10-14

- Východiskový mobilný záber `output/playwright/premium-live-export-complete-390x844-status.png`
  ukázal, že MIX CHECK, metriky a upozornenia boli zliate do jedného 9 px sivého
  riadka. Report teraz oddeľuje verdikt, merania a odporúčania; verdict state
  dostáva jemnú amber, red alebo warning stopu podľa jeho stavu.
- Úprava mení iba prezentačnú štruktúru `MixHealthLine`; výpočty, textové údaje,
  `role=status` a exportný tok zostávajú zachované. Prístupný názov oznamuje
  celý report aj po vizuálnom rozdelení na riadky. CSS je v novej aditívnej
  vrstve `src/styles/49-export-mix-health-finishing.css`.
- Čerstvý screenshot po zmene ešte treba skontrolovať pri 390 px a v širšom
  dock slote.
- `npm run typecheck`, `npx vite build --logLevel error`, cielený Prettier a
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali.
- Bundle gate zostáva **FAIL** na DAW JS **5368/5186 KB** a core worklets
  **153/150 KB**; studio boot path je **2176/2200 KB**. Limity sa nemenili.

### Dock — mobilný focus ring — 2026-10-14

- CSS audit zistil, že do 760 px majú `.dock-tabs` aj taby 34 px výšku,
  `overflow-y: hidden` a focus outline je offsetovaný o +1 px. Riadok preto
  môže orezať horný a spodný okraj klávesnicového fokusu.
- Mobilný focus ring má teraz `outline-offset: -3px`, takže zostáva vnútri
  tab buttonu a scroll viewportu. Desktopový outline sa nemení.
- Upravené: `src/styles/47-shell-touch-targets.css`. Mobilný screenshot
  fokusovaného dock tabu ešte treba skontrolovať.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### DICE — mobilné vstupné polia — 2026-10-14

- Záber `output/playwright/premium-live-dice-mobile-controls-390x844-top.png`
  ukázal približne 28 px vysoké selecty pre žáner, štýl, kit, cieľ a dĺžku.
- V DICE kontajneri do 560 px majú teraz selecty aj textové seed pole minimálne
  `--touch-target-large` (44 px) a 12 px text. Dvojstĺpcové rozloženie sa nemení.
- Seed copy tlačidlo má 44 px šírku aj výšku; jeho grid stĺpec sa teraz zväčší
  z 32 na rovnaký token, aby šírka stĺpca a dotykový cieľ zostali v súlade.
- Upravené: `src/styles/37-dice-panel-layout.css`. Nová výška polí potrebuje
  čerstvý mobilný screenshot a kontrolu v úzkom split docku.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Mastering — mobilné report nastavenia — 2026-10-14

- Východiskový záber `output/playwright/premium-live-mastering-top-390x844.png`
  ukázal približne 24 px výšku SCOPE, RATE a QUALITY selectov.
- Do 420 px Mastering kontajnera majú tieto tri report nastavenia a hlavné
  ANALYZE FULL SONG tlačidlo minimálne `--touch-target-large` (44 px) a 12 px
  text. Hlavná akcia sa roztiahne cez celý riadok; širšie sloty sa nemenia.
- Upravené: `src/styles/36-mastering-overview-layout.css`. Nový mobilný záber
  vrátane stale a analyzing stavov ešte treba skontrolovať.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Sequencer — čitateľný drum rack na mobile — 2026-10-14

- Záber `output/playwright/premium-live-sequencer-plock-open-390x844-after.png`
  ukazuje 16 padov v ôsmich stĺpcoch; viacero názvov sa skracuje už na prvé
  dve písmená, napríklad „Kick Deep“ na „Ki…“.
- Pri šírke do 520 px a výške nad 820 px rack používa mriežku 4×4 a 56 px
  vysoké pady. Názvy sa môžu zalomiť do dvoch riadkov, takže ostáva zachovaná
  plocha na hranie aj čitateľná identita zvuku. Nízke viewporty si ponechávajú
  jednoradové správanie z ADR 0036; desktopový 8-stĺpcový layout sa nemení.
- Upravené: `src/styles/47-shell-touch-targets.css`. Čerstvý screenshot treba
  skontrolovať pri 390 × 844 px, aj v otvorenom 16 LEVELS stave; rast výšky
  racku môže posunúť Pattern toolbar a editor nižšie. Krátky viewport potrebuje
  samostatnú kontrolu, že ostáva jednoradový.

### MIDI Creativity — úzky split dock — 2026-10-14

- Source audit našiel rozdiel medzi dvoma MIDI režimami: INPUT mal 44 px
  dotykové ciele, no CREATIVITY si ponechával 22 px selecty a malé tlačidlá.
  Jeho štyri stĺpce sa zároveň skladali podľa viewportu, nie šírky dock slotu.
- CREATIVITY mriežka teraz reaguje na šírku vlastného panelu; v úzkom mobilnom
  slote sa riadky môžu zalomiť a akcie, selecty aj DragNumber majú 44 px
  minimálnu výšku. Aj textové pole DragNumber po aktivovaní Enterom a MIDI CC
  add-row selecty dostali rovnakú výšku.
- Upravené: `src/styles/34-panel-states.css` a
  `src/styles/48-midi-mobile-layout.css`. Nový mobilný screenshot treba
  skontrolovať pri INPUT aj CREATIVITY v 390 px a úzkom split docku.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Reference Map — mobilná navigácia — 2026-10-14

- Source audit našiel, že vnútorné hlavné akcie a MATCH ovládanie mali mobilné
  44 px ciele, ale päť referenčných záložiek zostávalo na 28 px.
- Pri šírke panelu do 420 px majú teraz MAP, RHYTHM, HARMONY, DIAG a MATCH
  minimálne 44 px výšky. Desktopová hustota ani stavová logika sa nemenia.
- Upravené: `src/styles/30-reference-map.css`. Nový mobilný záber treba
  skontrolovať aj pri zalomení na 320 px.

### Pattern toolbar — mobilné hlavné ovládanie — 2026-10-14

- Mobilný záber sekvencera ukazuje amber GEN približne 26 px vysoký a oba
  selecty Pattern length/grid približne 24 px vysoké.
- Do 520 px majú Pattern taby, groove DragNumber, hlavná GEN akcia a oba
  pracovné selecty 44 px výšku a minimálnu výšku. Ostatné Pattern príkazy
  zostávajú kompaktné, aby sa zachovalo ich úlohové zoskupenie aj priestor pre
  editor.
- Upravené: `src/styles/47-shell-touch-targets.css`. Nový záber treba
  skontrolovať pri 390 px aj s rozšíreným pad rackom 4×4.

### Devices — mobilné pridávacie akcie — 2026-10-14

- Devices už ukladá názov stopy a akcie do dvoch riadkov pri šírke kontajnera
  do 420 px; obe pridávacie voľby však zostali na predvolenej kompaktnej výške.
- `+ FX` a `+ CHAIN` majú teraz 44 px výšku a 12 px text, rovnako ako ostatné
  hlavné mobilné ovládania. Rozdelenie hlavičky a šírka oboch tlačidiel sa nemenia.
- Upravené: `src/styles/35-device-control-hierarchy.css`. Čerstvý screenshot
  ešte treba skontrolovať pri 390 px a v úzkom split docku.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Arrangement — mobilný Scene launcher — 2026-10-14

- Source audit našiel, že výber scény a LAUNCH/VARY/EDIT/DELETE zostávali
  približne 26 px vysoké; DUP PATTERN, VARIATION a role voľba mali podobnú
  kompaktnú geometriu.
- Pri šírke Scene panelu do 420 px sa launcher skladá na samostatný riadok
  výberu a riadok akcií. Hlavné scény akcie, role select a karty launcheru majú
  minimálne 44 px dotykovú výšku. Vybrané scény, launch akcie a drag grip majú
  viditeľný vnútorný amber focus ring; počet akcií ani ich správanie sa nemenia.
- Fokus drag gripu zachováva jeho absolútne umiestnenie na karte; ring mení len
  viditeľný stav a stacking order.
- Upravené: `src/styles/39-arrangement-interaction-finishing.css`. Čerstvý
  screenshot treba skontrolovať pri 390 px, pri dlhej scene name a so stavom
  PLAYING/QUEUED. Rozbalený Scene Strip so scene pairmi a makrami aj nested
  scroll pri viacerých scénach zostávajú na čerstvú vizuálnu kontrolu.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Mixer / Arrangement — mobilný Scene Strip — 2026-10-14

- Scene Strip používal 16–22 px tracky sliderov a úzke inline pair selecty aj
  v mobilnom Scene paneli. Zbalenie panelu a výber tracku boli tiež len textové
  tlačidlá bez samostatnej plochy.
- Pri šírke do 420 px sa Scene Strip skladá rovnako v Mixeri aj Arrangement
  paneli: pair selecty sú vedľa seba pod názvom tracku; scéna, makrá a CC
  prepínače majú vlastné riadky. Pair selecty, track výber, zbalenie, macro
  clear aj CC labely majú 44 px cieľ.
- Scene intensity a macro slider si ponechávajú jemnú 4 px vizuálnu dráhu, no
  ich ovládacia plocha je 44 px vysoká. Amber focus ringy označia klávesnicový
  fokus bez ďalšej dekorácie pracovnej plochy.
- Upravené: `src/styles/03-mixer.css` a
  `src/styles/39-arrangement-interaction-finishing.css`. Čerstvý mobilný záber
  Scene Stripu s TWIST/GROW riadkami, makrami a CC remapmi ešte treba
  skontrolovať vrátane vertikálneho scrollu.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Bundle / PWA — voliteľný stem-model runtime — 2026-10-14

- Sourcemap aktuálneho buildu potvrdil, že `ort.bundle.min` je jediný modul
  `onnxruntime-web/dist/ort.bundle.min.mjs` (404,41 KB). Používa ho dynamický
  import v stem-model klientovi po výbere dostupného modelového oddelenia; do
  statického boot grafu nepatrí.
- Pred úpravou ho Workbox zahrnul do install-time precache napriek dynamickému
  importu. Produkčný výstup ho teraz vynecháva z precache a pridáva CacheFirst
  runtime pravidlo pre prvé použitie.
- Budget checker ho teraz meria samostatne s limitom 430 KB, kontroluje jeho
  neprítomnosť v boot grafe aj PWA precache a stále ho zahrňuje do fyzického
  súčtu dodaných JS súborov. Pôvodný limit DAW JS 5186 KB sa nemení.
- Dostupnosť modelu a jeho manifest gate zostávajú nezmenené.
- `npm run build` prešiel TypeScriptom, Vite a PWA generovaním. Budget checker
  potvrdil DAW JS **4964/5186 KB**, stem runtime **404/430 KB**, fyzický súčet
  **7466 KB** a boot path **2176/2200 KB**. Cielený Prettier, `node --check`
  a `git diff --check`: **PASS**. Automatické testy sa nespúšťali.

### Generative tracks — on-demand PCM player worklet — 2026-10-14

- Metafile meranie ukázalo, že `generative-player-processor.js` tvoril 3,14 KB
  v core worklete, hoci sa vytvára iba po štarte provider-backed generative
  tracku. Core loader ho už neregistruje; `GenerativeRuntime` ho po vyžiadaní
  načíta samostatným per-context loaderom pred vytvorením PCM sinku.
- Samotný bounded PCM processor sa nemenil. Core worklet klesol na
  **148,53 KiB + 1,00 KiB bitcrusher** (spolu 149,53 KiB, limit 150 KiB);
  oddelený generative player je **3,16 KiB**, s vlastným 4 KiB limitom.
- `tests/audio-worklets.test.ts` aktualizuje existujúci loader kontrakt a
  readiness očakávania. Automatické testy sa v tejto vlne nespúšťali.
- `npm run build` prešiel vrátane TypeScriptu, Worklet/PWA generovania a size
  budget checku (`[size-budget] OK`). Cielený Prettier, `node --check` a
  `git diff --check`: **PASS**.

### Export — hierarchia MIX CHECK metrík — 2026-10-14

- Source audit potvrdil, že primárne hodnoty low/crest/peak a odporúčania mali
  rovnakú 10 px veľkosť ako kompaktný verdikt. Metriky sú teraz 11 px mono a
  odporúčania 11 px s 1.4 line-height; technický nadpis si zachováva svoju
  pomocnú 10 px hierarchiu.
- Úprava je obmedzená na `.export-mix-health-stats` v
  `src/styles/49-export-mix-health-finishing.css`. Texty, zalomenie, report
  stavy aj `role=status` nemenia správanie.
- Čerstvá screenshot kontrola pri 390 px a v širšom dock slote zostáva otvorená.
- Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali; zmena je CSS-only.

### Dock — výška mobilného chrome tokenu — 2026-10-14

- Source audit našiel, že mobilná lišta tabov má 34 px, no
  `--dock-chrome-h` ostával 40 px (10 px grip + pôvodná 30 px lišta). Výpočet
  otvoreného docku tak odpočítal 4 px z nakonfigurovanej výšky panelu.
- Do 760 px sa token nastavuje na 44 px. Tým zodpovedá reálnemu gripu a tab
  lište a ponecháva panelu jeho deklarovanú výšku; desktopových 40 px zostáva.
- Upravené: `src/styles/28-compact-studio-shell.css`. Čerstvý mobilný záber
  otvoreného/zbaleného docku a split stavu ešte treba skontrolovať.
- Aktuálny `npm run build`: **PASS** (TypeScript, Vite, PWA a všetky bundle
  gates). DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**,
  core worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Voliteľné runtime balíky majú iba 3 KB rezervu.
- Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali; zmena je CSS-only.

### INTENT / FX INTENT — klávesnicový fokus promptov — 2026-10-14

- Cascade audit našiel, že `.intent-textarea:focus` aj
  `.effect-intent-form input:focus` nastavovali 1 px outline. Ich špecificita
  prebíjala spoločný 2 px `:focus-visible` štýl z vrstvy 32, takže hlavný
  INTENT prompt aj FX intent pole boli pri klávesnicovom fokuse vizuálne slabšie
  než ostatné pracovné ovládače.
- Vrstva `src/styles/41-native-field-focus.css` teraz výslovne nastavuje
  2 px amber ring a 2 px offset pre oba `:focus-visible` stavy. Pointer-focus
  správanie sa nemení.
- Čerstvá screenshot kontrola oboch polí s klávesnicovým fokusom zostáva
  otvorená.
- Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali; zmena je CSS-only.
- Následný `npm run build` po tejto vrstve opäť prešiel TypeScriptom aj všetkými
  bundle gates. Úplné aktuálne merania sú v Dock — výška mobilného chrome
  tokenu.

### Inspector — focus ring tlačidiel Preset Browsera — 2026-10-14

- `PREVIEW` aj `APPLY` v Inspectore mali lokálny 1 px focus ring, ktorý bol
  slabší než spoločný 2 px ring pre hlavné pracovné tlačidlá.
- Obe tlačidlá teraz používajú spoločné pravidlo v
  `src/styles/29-premium-hierarchy.css`. Ich 6 px vnútorný odstup v riadku
  necháva 2 px ring vo vnútri scroll viewportu.
- Čerstvá vizuálna kontrola Preset Browsera s klávesnicovým fokusom zostáva
  otvorená.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; zmena je CSS-only.

### Inspector — dotykové ciele zbalenia — 2026-10-14

- Zdrojový audit odhalil, že tlačidlo zbalenia Inspectora malo 24 × 24 px a
  mobilný collapsed rail iba 32 px výšku. Na úzkom dotykovom layoute tak bolo
  ťažšie použiť dôležité rozšírenie pracovnej plochy.
- Do 860 px majú collapse/expand ovládače 44 px výšku. Pri širšom zariadení s
  primárnym coarse pointerom sa zbalený rail rozšíri z 28 na 44 px; desktopová
  myš si ponecháva úzky rail. Mobilný selektor collapse tlačidla cieli aj
  `.btn.btn-icon` specificity, aby ho neprebil compact control token.
- Upravené: `src/styles/47-shell-touch-targets.css`. Vizuálna kontrola
  rozbaleného/zbaleného stavu pri 390, 800 a 1024 px ešte zostáva.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; CSS-only layoutová zmena.

### INTENT — tempo SONG progress a reduced motion — 2026-10-14

- Source audit našiel 240 ms prechod šírky v determinate SONG progress bare;
  plánovací rozsah krátkych prechodov je 120–180 ms. Táto animácia navyše
  nemala samostatný OS `prefers-reduced-motion` override.
- Prechod teraz trvá 160 ms a pri `prefers-reduced-motion: reduce` sa vypne.
  Aplikačný Calm Motion override zostáva zachovaný; percentá, phase state ani
  completion logika sa nemenia.
- Upravené: `src/styles/14-command-palette.css` a
  `src/styles/43-intent-busy-finishing.css`. Čerstvý screenshot busy/stage
  stavu stále treba skontrolovať.
- Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali; CSS-only zmena.

### Dock — focus ring v scrollovanej lište — 2026-10-14

- `.dock-tabs` skrýva vertikálny overflow pri každej šírke, no vnútorný
  `outline-offset` pre taby bol nastavený iba do 760 px. Desktopové 2 px ringy
  sa tak mohli orezať na hornom a spodnom okraji scroll viewportu.
- Focus ring tabov má teraz `-3px` offset vo všetkých šírkach. Ostatné stavy,
  vrátane amber selected podčiarknutia, zostávajú nedotknuté.
- Upravené: `src/styles/47-shell-touch-targets.css`. Živú kontrolu klávesnicového
  fokusu treba doplniť pri desktopovom docku aj pri split/mobilnej lište.
- Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali; CSS-only zmena.

### Browser Strip — dotykové ciele zbalenia — 2026-10-14

- Source audit našiel 20 px otvorené tlačidlo collapse a 24 px šírku
  collapsed railu; oba stavy patria k trvalo dostupnému Sounds browseru na
  širokej pracovnej ploche.
- Pri primárnom coarse pointere a viewportoch od 1250 px sa collapse tlačidlo
  zväčší na 44 × 44 px a zbalený rail na 44 px. Bežný desktop zostáva na
  kompaktnej šírke a strip sa na užších oknách naďalej skrýva podľa layoutovej
  hranice 1250 px.
- Upravené: `src/styles/47-shell-touch-targets.css`. Screenshot s touch
  pointerom pri širokom layoute a zbaleným/otvoreným Browser Stripom ešte chýba.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; CSS-only zmena.

### Browser Strip — focus collapse controls — 2026-10-14

- Kaskádový audit potvrdil, že `.browser-strip-collapse` ani
  `.browser-strip-rail` nie sú `.btn` komponenty, takže zdieľaný 2 px amber
  `:focus-visible` ring ich nepokrýval.
- Otvorené collapse tlačidlo aj zbalený rail teraz dostávajú 2 px amber ring
  s vnútorným offsetom, aby zostal celý viditeľný aj v úzkom 24 px raili.
- Upravené: `src/styles/47-shell-touch-targets.css`. Čerstvá vizuálna kontrola
  keyboard focusu v oboch stavoch zostáva otvorená.
- `npx vite build --logLevel error`, cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali; CSS-only zmena.

### MOD / MIDI — čitateľná hierarchia sekčných nadpisov — 2026-10-14

- Source audit našiel inline veľkosti 9 px pre Groove Pool, Intensity Curve a
  Scene Automation a 10 px pre CC Mappings a Drum Note Map. Išlo o názvy
  pracovných sekcií, nie o technické metadata; inline štýly obchádzali spoločnú
  `h3.panel-title` typografiu.
- Odstránené sú iba tieto inline `fontSize` výnimky. Nadpisy teraz používajú
  spoločnú 12 px h3 úroveň; rozostup 6 px pri MOD kartách a všetok obsah zostal
  zachovaný.
- Upravené: `src/ui/ModPanel.tsx` a `src/ui/MidiPanel.tsx`. Čerstvá vizuálna
  kontrola pri plných a split dock stavoch zostáva otvorená.
- `npm run build`: **PASS** (TypeScript, Vite, PWA aj všetky bundle gates).
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**,
  core worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Shared controls — custom disabled stavy — 2026-10-14

- Source audit našiel skupiny, ktorým skoršia spoločná vrstva iba vrátila
  `opacity: 1`: napríklad disabled Landing GENERATE, MIDI/automation `+`,
  Reference MATCH/APPLY a položky kontextových menu vyzerali stále aktívne.
- Custom ovládanie teraz používa matný povrch, jemný okraj a sekundárny text.
  Kontextové menu si ponechávajú transparentný riadok; zvolený tempo reading a
  zablokovaná Brief rola si zachovávajú tlmenú amber stopu.
- Odstránené sú duplicitné lokálne opacity pravidlá. Upravené: shared disabled
  sheet a príslušné Arrangement, Mixer menu, Theme, command palette, Landing,
  Dock a Reference štýly.
- Zostáva živé vizuálne overenie pri Reference stale/busy, Landing busy a v
  hustých arrangement MIDI/automation lanes.
- `npm run build`: **PASS**, DAW JS **4964/5186 KB**, opt-in stem runtime
  **404/430 KB**, core worklety **150/150 KB**, generative player **3/4 KB** a
  boot path **2176/2200 KB**. Cielený Prettier a `git diff --check`:
  **PASS**. Automatické testy sa nespúšťali.

### Devices — hlavné voľby nad 10 px — 2026-10-14

- Devices audit našiel SKRUTKA WET/OUT DELAY view tlačidlá pri 8 px a Essential
  Kit varianty pri šírke slotu od 1000 px pri 9 px. Sú to priame voľby, nie
  technické metadata.
- Obe skupiny teraz používajú 10 px. SKRUTKA tlačidlá ponechávajú 24 px hustú
  výšku a nízky letter-spacing; Essential Kit si ponecháva 25 px výšku v
  širokom slote.
- Upravené: `src/styles/21-device-panel.css` a
  `src/styles/35-device-control-hierarchy.css`. Plný a split Devices panel ešte
  potrebuje čerstvý vizuálny screenshot.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Mixer — čitateľnejšie FREEZE/BOUNCE akcie — 2026-10-14

- Zdrojový audit potvrdil, že trackové `FREEZE` / `UNFREEZE` a `BOUNCE`
  tlačidlá majú vlastný 8 px font-size, hoci ide o priame produkčné akcie,
  nie o metadáta.
- Text má teraz 10 px. Pôvodné vnútorné odsadenie, flex-wrap aj výška
  kompaktných tlačidiel zostávajú nezmenené.
- Upravené: `src/styles/03-mixer.css`. Čerstvá vizuálna kontrola týchto akcií
  v úzkom channel stripe ešte zostáva.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Arrangement — čitateľnejšie take audition akcie — 2026-10-14

- Source audit ukázal, že priame `AUDITION` / `LIVE SOLO` tlačidlo take lane
  malo 8 px text, hoci už má väčšiu výšku vo všetkých responzívnych režimoch.
- Názov akcie má teraz 10 px; breakpointové výšky 28/32/44 px a štruktúra
  lane headeru zostávajú nezmenené.
- Upravené: `src/styles/04-arrangement.css`. Hustý aj mobilný take lane ešte
  potrebuje čerstvú vizuálnu kontrolu.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Arrangement — hierarchia MIDI lane hlavičky — 2026-10-14

- `MIDI TRACKS` a dlhý ovládací hint zdieľali 8 px text a rovnakú farbu,
  takže sekcia nemala jasný názov oproti pomocnej inštrukcii.
- Názov dostal 10 px, silnejší weight a textový kontrast; hint si ponecháva
  kompaktnú metadata úroveň. Geometria timeline a šírka scroll obsahu nemenia.
- Upravené: `src/styles/04-arrangement.css`. Husté MIDI lane stavy pri úzkych
  šírkach ešte potrebujú čerstvú vizuálnu kontrolu.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Mastering — čitateľnejšie delivery ciele a akcie — 2026-10-14

- Source audit potvrdil 8 px vlastné LUFS/true-peak labely, 9 px delivery
  profile label aj 9 px text na `RESET INTEGRATED` / `AUTO -6dB` akciách.
- Všetky labely aj tlačidlá používajú 10 px. Vlastné ciele sa podľa dostupnej šírky
  zalomia namiesto pretlačenia vedľa seba; 48 px číselné polia zostávajú.
- Upravené: `src/styles/08-master-meter.css`. Custom profile a verdict actions
  treba čerstvo skontrolovať v plnom a split dock stave.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Mastering — konzistentný klávesnicový fokus — 2026-10-14

- Source audit našiel tri focus ringy s iba 35–60 % transparentnou amber farbou,
  slabšou než spoločný 82 % mix pre hlavné ovládanie.
- Scope/select/analyze, workflow jump aj flow-stage action teraz používajú
  spoločný kontrastný 2 px ring. `mastering-flow-jump` oddeľuje hover okraj od
  keyboard fokusu, takže pointer hover nedostáva focus ring.
- Upravené: `src/styles/22-mastering-workspace.css`. Čerstvá kontrola kontrastu
  a orezania zostáva otvorená v plnom aj split paneli.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Settings — klávesnicový fokus hex tokenov — 2026-10-14

- Source audit odlíšil jediný neprebitý 1 px focus rule od selekčných obrysov
  a starších pravidiel, ktoré už prepisuje spoločný 2 px ring.
- Hex inputy teraz zachovávajú amber border pri focus a používajú 2 px
  `:focus-visible` ring; záporný offset necháva obrys vo vnútri 18 px poľa.
- Upravené: `src/styles/24-layout-tokens.css`. Live kontrola hustého token
  riadku pri klávesnicovom fokuse ešte zostáva otvorená.
- `npm run build`: **PASS**, vrátane TypeScriptu, PWA a všetkých bundle gates.
  DAW JS **4964/5186 KB**, optional on-demand runtimes **647/650 KB**, core
  worklety **150/150 KB**, generative player **3/4 KB** a boot path
  **2176/2200 KB**. Cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Mastering — zjednotený programatický focus ring — 2026-10-14

- Source audit našiel posledné dva mastering focus ciele pre navigáciu na
  insert controls a render meranie, ktoré stále používali surový accent.
- Oba teraz používajú rovnaký kontrastný amber/white mix ako ostatné focus
  raily; offsety ostali 2/3 px, aby sa nezmenila geometria ani scroll pozícia.
- Upravené: `src/styles/22-mastering-workspace.css`. Čerstvé screenshoty
  navigácie v plnom a split dock stave zostávajú v otvorenej vizuálnej QA.

### DICE — zjednotený hustý spacing — 2026-10-14

- Source audit našiel v DICE mobilnej mriežke rozostupy 5, 6 a 7 px vedľa
  štandardných 8 px; vytvárali vlastný mikro-rytmus bez funkčného dôvodu.
- Intent, roll, lock a history skupiny teraz používajú `--space-1`/`--space-2`
  (4/8 px). Dvojstĺpcový titulok si ponecháva jeho zámerný 2/8 px vnútorný
  rhythm; 10 px okraj panela ostáva kvôli čitateľnému odsatiu.
- Následná mobilná QA pri 390 × 844 po tejto úprave vizuálne potvrdila 3 × 3
  lock mriežku, tri history stavy a zmestenie FAV/rating/seed ovládania bez
  horizontálneho orezania. Zamknuté Drums aj aktívny history bod používajú
  čitateľnú amber stopu.
- Snímky: `output/playwright/premium-live-dice-locks-history-390x844.png` a
  `output/playwright/premium-live-dice-history-3-rolls-390x844.png`.
  Upravené: `src/styles/37-dice-panel-layout.css`. Čerstvý 800 px split-dock
  stav zostáva v otvorenej vizuálnej QA.

### Devices — čitateľnejšie názvy signal chainu — 2026-10-14

- Source audit potvrdil, že priamo vyberateľné chain tlačidlá mali 9 px text
  aj pri širokom desktope. Zväčšil som ich na 10 px; mobile override ostáva
  12 px a wrapping v chain flexe naďalej rieši dlhšie názvy.
- Upravené: `src/styles/21-device-panel.css`. Hustý päťefektový chain ešte
  potrebuje živú kontrolu pri desktopovej aj úzkej šírke panelu.

### Devices — samostatná amber stopa pre vybraný chain prvok — 2026-10-15

- Aktívny modul používal iba farbu efektovej kategórie na okraji, pozadí a
  indikátore. Nová tenká amber spodná stopa označuje výber podľa stavovej
  matice KYX, zatiaľ čo ľavá kategóriová koľajnica a bodka zachovávajú svoju
  identifikačnú úlohu.
- Stopa nepreberá hover stav, neblokuje drag/click a vypína svoj prechod pri
  `prefers-reduced-motion`.
- Upravené: `src/styles/21-device-panel.css`. Živý split/desktop screenshot
  selected + focus stavu zostáva otvorený.
- `npx vite build --logLevel error` a bundle kontrola: **PASS** (DAW JS
  **4972/5186 KB**, studio boot path **2179/2200 KB**). `git diff --check`:
  **PASS**. Cielený Prettier: **PASS**; celorepo `npm run format:check`
  momentálne hlási dva nesúvisiace súbory. Plný `npm run build` zostáva
  blokovaný `tests/master-iterate.test.ts`; automatické testy sa nespúšťajú.

### Sequencer — spoločný rytmus interakčných prechodov — 2026-10-14

- Source audit našiel na step bunke 80 ms hover prechod vedľa 120 ms stavu
  ostatných core ovládacích prvkov. Row pady, kroky, velocity bary a piano
  klávesy teraz zdieľajú `--motion-fast` + `--motion-ease`.
- Meter fill, peak hold a ostatné signálové vizualizácie zostávajú mimo tohto
  zjednotenia, pretože ich timing predstavuje audio údaj, nie UI hover stav.
- Upravené: `src/styles/02-sequencer.css`. Živú kontrolu pri rýchlom step
  editovaní a `prefers-reduced-motion` ešte treba doplniť.
- Validácia tejto štýlovej vlny: `npm run build` **PASS** cez `tsc --noEmit`,
  Vite a všetky bundle gates; DAW JS **4964/5186 KB**, optional runtimes
  **647/650 KB**, boot path **2176/2200 KB**. `git diff --check`: **PASS**;
  automatické testy sa nespúšťali.

### Support dock — výškový limit podľa viewportu — 2026-10-14

- Živý stav s uloženým 560 px dockom pri 1440 × 900 odhalil, že panelová
  plocha môže odobrať sequenceru väčšinu výšky. `App` preto používa spoločný
  výpočet limitu: od 34 vh na kratších oknách po 38 vh pri 900 px, mínus 44 px
  na dock chrome, s existujúcim 560 px pevným stropom.
- Pri 1440 × 900 sa dock obmedzil na 298 px obsahu + 40 px chrome. Pracovná
  plocha má 462 px a sequencer končí na y=493 pred jej spodkom y=505.
  Snímka: `output/playwright/premium-live-dock-cap-1440x900.png`.
- Pri 1280 × 800 má pracovná plocha 432 px a sequencer 172 px; pri 1024 × 768
  má pracovná plocha 369 px a sequencer 150 px. V oboch stavoch sa shell
  zmestil do viewportu bez horizontálneho overflow. Existujúce správanie pri
  zmenšení okna uloží nižšiu výšku docku; pri zväčšení ho používateľ môže znovu
  potiahnuť.
- Upravené: `src/ui/dockLayout.ts` a `src/ui/App.tsx`. `npm run build` **PASS**
  cez TypeScript, Vite, PWA a bundle gates; DAW JS **4964/5186 KB**, optional
  runtimes **647/650 KB**, worklety **150/150 KB** a boot path **2176/2200 KB**.
  `git diff --check`: **PASS**. Automatické testy sa nespúšťali. Konzola pri QA
  hlásila iba nedostupný lokálny `/api/intake` endpoint na porte 1234.

### Motion — zjednotenie posledných ovládacích prechodov — 2026-10-14

- Ovládacie hover/focus povrchy teraz používajú spoločné motion tokeny aj v
  Scale preview, Landing promte, Agents copy tlačidle a resize grip/držadle
  docku. Zachováva sa 120 ms fast a 160 ms state rytmus s jednotným easingom.
- Step amount fill dostal okamžitú aktualizáciu šírky. Jeho hodnota sleduje
  pointer počas priameho ťahania; animácia by za pointerom viditeľne zaostávala.
  Pad, Ultina, arrangement microphone a SKRUTKA meter fills si ponechávajú
  krátky 40–80 ms timing, pretože zobrazujú živý audio signál. Export a SONG
  progress si ponechávajú vlastné determinate prechody.
- Live CSS kontrola na 1440 × 900 potvrdila, že pri `prefers-reduced-motion`
  majú aktívny dock tab, step amount aj pad meter `transition: none` a
  `animation: none`. Pri bežnom režime má dock tab 120/160 ms tokeny, step
  amount nemá interpoláciu a pad meter si ponecháva 80 ms.
- Upravené: `src/styles/06-help-overlay.css`,
  `src/styles/09-scale-panel-popover.css`,
  `src/styles/11-floating-instrument-plugin.css`,
  `src/styles/12-floating-instrument-plugin-2.css`,
  `src/styles/16-landing-prompt.css` a `src/styles/24-layout-tokens.css`.
  `npm run build` **PASS**; DAW JS **4964/5186 KB**, optional runtimes
  **647/650 KB**, core worklety **150/150 KB**, boot path **2176/2200 KB**.
  Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali.

### Reference Map — živý dôkaz stale Match reportu — 2026-10-14

- Načítal som lokálny factory WAV do Reference Mapu, zmeral existujúci QA
  projekt pri 125 BPM a spustil MATCH. Report sa zobrazil s pásmovými rozdielmi,
  loudness, stereo a track attribution; `APPLY MATCH` bolo aktívne.
- Dočasná zmena projektu na 126 BPM označila zachovaný report ako stale.
  Hláška vysvetľuje, že výsledok patrí predošlému projektu; `APPLY MATCH` sa
  deaktivovalo. Pri 390 × 844 zostala hláška aj disabled akcia čitateľná v
  scrollovanom dock sheete a dokument nemal horizontálny overflow.
- Snímky: `output/playwright/premium-live-reference-match-1440x900.png`,
  `output/playwright/premium-live-reference-stale-1440x900.png` a
  `output/playwright/premium-live-reference-stale-390x844-report.png`,
  `output/playwright/premium-live-reference-error-empty-1440x900.png` a
  `output/playwright/premium-live-reference-error-empty-390x844.png`.
  Testovacie BPM som vrátil cez Undo na 125 a report znovu premeral; QA projekt
  aj dock preference 298 px sú obnovené.
- Reference kód nepotreboval zmenu. Empty-file error surface má live QA pri
  1440/390 px. Zostáva MIDI/audio capture kontrola s pripojeným externým
  hardvérom.

### MIDI — mobilný INPUT a CREATIVITY — 2026-10-14

- Pri 390 × 844 som skontroloval INPUT v stave OFF aj ON bez pripojeného
  zariadenia. Device, drum channel a instrument channel selecty sa zmestia do
  342 px routovacieho riadku; MIDI akcie aj ovládacie prvky vo všetkých štyroch
  routovacích riadkoch majú 44 px výšku. Dokument nemá horizontálny overflow.
- Source audit pri live QA našiel, že P.BEND `RANGE` mal iba 34 px. Mobilné
  routovanie ho teraz zväčšuje na 44 px a textová editácia po Entere používa
  64 × 44 px pole. Riadok zostáva v šírke 342 px; Escape neuloží zmenu.
- CREATIVITY má pri 390 px 42 ovládacích prvkov s minimálnou výškou 44 px;
  všetky štyri sekcie sa zmestia do šírky slotu a posledná akcia
  `APPLY BASSLINE` je dosiahnuteľná scrollovaním dock sheetu.
- Snímky INPUT ON: `output/playwright/premium-live-midi-input-enabled-fixed-390x844.png`
  a `output/playwright/premium-live-midi-input-routing-bottom-390x844.png`;
  CREATIVITY: `output/playwright/premium-live-midi-creativity-390x844.png` a
  `output/playwright/premium-live-midi-creativity-390x844-bottom.png`. Po QA je
  MIDI opäť vypnuté a QA projekt má BPM 125.
- Upravené: `src/styles/48-midi-mobile-layout.css`. Reálne správanie s
  pripojeným MIDI zariadením a jeho kanálmi zostáva otvorené; zariadenie v tomto
  workspace nie je dostupné.
- `npm run build`: **PASS**, DAW JS **4964/5186 KB**, optional runtimes
  **647/650 KB**, opt-in stem runtime **404/430 KB**, core worklety
  **150/150 KB**, generative player **3/4 KB** a boot path **2176/2200 KB**.
  Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali.

### Devices — mobilný selected chain — 2026-10-14

- Na 808 som dočasne vložil `808 HARMONICS` a skontroloval vybraný Tape Sat
  effect pri 390 × 844. Instrument, Tape Sat aj EQ chain tlačidlá majú 44 px
  výšku; zvolený modul má amber selected stopu. Panel má 380 px, jeho chain aj
  riadky sa zmestia do šírky a dokument zostáva presne 390 px.
- Záber pri 1440 × 900 potvrdzuje selected state v desktopovom signal chaine;
  mobilný záber zobrazuje vybraný Tape Sat v kompaktnej hlavičke. Efektový chain
  som po kontrole vrátil cez Undo. QA projekt má späť iba 808 Synth, BPM 125 a
  MIDI zostáva vypnuté.
- Snímky: `output/playwright/premium-live-devices-selected-1440x900.png` a
  `output/playwright/premium-live-devices-selected-390x844.png`. `LOAD KIT`
  doplnil päť efektov naraz; Reverb sa pri 390 px zalomil do tretieho riadku a
  dostal viditeľný 2 px amber keyboard focus ring. Po snímke som kit vrátil
  jedným Undo krokom.
- Snímky 5-FX stavu: `output/playwright/premium-live-devices-five-effects-selected-390x844.png`
  a `output/playwright/premium-live-devices-five-effects-selected-focus-390x844.png`.
  Živý hover a selected/focus kontrast v split docku a pri 800/1440 px zostáva
  otvorený.

### MOD — mobilné LFO ovládanie v split docku — 2026-10-14

- Živý audit MOD pri 390 × 844 našiel 22 px vysoké LFO selecty. V kompaktnom
  dock slote teraz LFO selecty, automation voľby, pridanie modulátora a jeho
  odstránenie používajú minimálne 44 px cieľ. Desktopová hustota sa nemení.
- Pri 390 px má MOD slot 380 px, LFO karta 311 px a jej ovládací grid 293 px;
  selecty sa zalomia do troch stĺpcov bez horizontálneho pretečenia dokumentu.
  Na 800 px majú split sloty 396 px a dokument zostáva presne 800 px široký.
- Fokusovaný LFO TYPE select má 2 px amber ring s 2 px offsetom; karta pri
  úprave dostáva jemný amber edge. Snímky:
  `output/playwright/premium-live-mod-lfo-mobile-44px-390x844.png`,
  `output/playwright/premium-live-mod-lfo-focus-mobile-390x844.png` a
  `output/playwright/premium-live-mod-lfo-split-tablet-800x900.png`.
- Testovací LFO som odstránil po QA. Projekt ostáva na 808 Synth, BPM 125 a
  MIDI OFF; DICE preview nebol aplikovaný.
- Upravené: `src/styles/38-mod-panel-finishing.css`. Automatické testy sa
  nespúšťali. `npm run build`: **PASS** cez TypeScript, Vite, PWA a všetky
  bundle gates; DAW JS **4964/5186 KB**, optional runtimes **647/650 KB**, core
  worklety **150/150 KB** a boot path **2176/2200 KB**. Cielený Prettier a
  `git diff --check`: **PASS**.

### Arrangement — selected/focus a armed capture UI — 2026-10-14

- Pri 1440 × 900 má vybraný MIDI klip 237 × 24 px a 2 px amber keyboard focus
  ring s vnútorným 2 px offsetom; pri 800 × 900 sa celý projekt zmestí do šírky
  a timeline sa dá dosiahnuť scrollovaním dock slotu (984 px obsahu v 252 px
  slote). Klip zostáva selected/focused a jeho ring nie je odrezaný.
- Pri 390 × 844 je MIDI klip 237 × 44 px, timeline má vlastný horizontálny
  scroll (621 px obsahu v 319 px viewport-e), panel sa scrolluje zvisle a
  dokument zostáva presne 390 px široký. Scene, edit, zoom, capture aj MIDI
  lane akcie majú 44 px dotykové ciele.
- Dočasne som zvolil 808 v `Arm track for recording`. REC sa aktivoval; nahrávanie
  sa nespúšťalo a následne som track rozarmoval. UI je overené, no skutočný
  zvukový vstup vyžaduje fyzické zariadenie.
- Snímky: `output/playwright/premium-live-arrangement-selected-focus-1440x900.png`,
  `output/playwright/premium-live-arrangement-selected-focus-800x900.png`,
  `output/playwright/premium-live-arrangement-timeline-800x900-bottom.png`,
  `output/playwright/premium-live-arrangement-selected-focus-390x844.png`,
  `output/playwright/premium-live-arrangement-timeline-focus-mobile-390x844.png`
  a `output/playwright/premium-live-arrangement-capture-armed-ui-390x844.png`.
- Arrangement CSS nevyžadoval zmenu. Automatické testy sa nespúšťali.

### MASTER — split state a mobilné delivery ciele — 2026-10-14

- Split dock pri 800 × 900 potvrdil sloty široké 396 px. Master busy stav
  zamkne `ANALYZE FULL SONG` počas offline práce; po dokončení sa zobrazí aktuálny
  report a aktívne findings. Pri 390 × 844 zostáva split dokument široký presne
  390 px.
- Dočasné BPM 126 označilo report ako `STALE · ANALYZE AGAIN` aj v mobilnom
  split docku. Undo vrátil BPM na 125; report zostal správne stale, preto som ho
  znovu analyzoval. Finálny report pri 125 BPM je dokončený a aktuálny.
- Source audit zistil, že skôr definované 44 px pravidlo Analyze prepisoval
  neskorší stavový selector s 32 px minimum. Mobilný split slot teraz dáva
  44 px aj Analyze v enabled/disabled stave, delivery profile, export formátom,
  bit depth, názvu verzie, profilu nastavení a export akciám. Na desktope sa
  hustota nemení.
- Pri 390 px sú Master a DICE sloty široké 380 px a stránka nemá horizontálny
  overflow. Pri 800 px majú oba sloty 396 px a šírka dokumentu je 800 px.
- Snímky: `output/playwright/premium-live-master-dice-split-800x900.png`,
  `output/playwright/premium-live-master-analysis-split-busy-800x900.png`,
  `output/playwright/premium-live-master-analysis-split-complete-800x900.png`,
  `output/playwright/premium-live-master-mobile-report-390x844.png`,
  `output/playwright/premium-live-master-analysis-complete-split-390x844.png`,
  `output/playwright/premium-live-master-analysis-mobile-busy-390x844.png`,
  `output/playwright/premium-live-master-analysis-mobile-complete-390x844.png`,
  `output/playwright/premium-live-master-stale-split-390x844.png` a
  `output/playwright/premium-live-master-export-44px-split-390x844.png`.
- Upravené: `src/styles/49-export-mix-health-finishing.css`. Automatické testy
  sa nespúšťali.

### MOD — selected automation lane a mobilný focus — 2026-10-14

- Pri 390 × 844 má vybraný automation riadok 44 px; názov, `ARR` aj odstránenie
  majú 44 px výšku a obe akcie 52 px šírku. Panel nevyvoláva horizontálny
  overflow.
- Focusovaný názov má viditeľný 2 px amber ring s 2 px offsetom. Vnútorné 4 px
  odsadenie scrollovateľného zoznamu zachováva obrys celý; zoznam meria
  326 × 52 px a label 206 × 44 px.
- Snímka: `output/playwright/premium-live-mod-automation-selected-focus-mobile-390x844.png`.
  Testovaciu lane som odstránil cez Undo; v projekte nezostali automation rows.
- Upravené: `src/styles/38-mod-panel-finishing.css`. Automatické testy sa
  nespúšťali. `npm run build`: **PASS** cez TypeScript, Vite, PWA a bundle
  gates; DAW JS **4964/5186 KB**, optional runtimes **647/650 KB**, stem runtime
  **404/430 KB**, core worklety **150/150 KB** a boot path **2176/2200 KB**.
  Zostali iba známe Vite import/chunk upozornenia. Cielený Prettier a
  `git diff --check`: **PASS**.

### Mixer — čitateľnejšie Master processor prepínače — 2026-10-15

- Source audit našiel, že všetky tlačidlá Master procesora v 150 px channel
  stripe klesali na 9 px, aby sa vedľa seba zmestil aj dlhý názov `GR LISTEN`.
- Banka teraz používa trojstĺpcovú mriežku. Bežné prepínače majú 10 px text;
  `GR LISTEN` zaberá dve bunky. Šírka stripu ani stavové správanie sa nemenia.
- Upravené: `src/styles/03-mixer.css` a
  `src/ui/MasterProcessingControls.tsx`. Čerstvá vizuálna kontrola v Mixeri
  ešte čaká na dostupný preview tab.
- `npm run build`: **PASS** cez TypeScript, Vite, PWA a všetky bundle gates;
  DAW JS **4964/5186 KB**, optional runtimes **647/650 KB**, stem runtime
  **404/430 KB**, core worklety **150/150 KB** a boot path **2176/2200 KB**.
  Cielený Prettier a `git diff --check`: **PASS**. Automatické testy sa
  nespúšťali.

### Mixer — FX category filtre a keyboard focus — 2026-10-15

- FX kategórie v Add Effect popoveri boli samostatné tlačidlá mimo `.btn`,
  preto nedostávali spoločný keyboard focus ring a mali iba 9 px text / 22 px
  výšku.
- Filter tiles teraz používajú 10 px text, 24 px kompaktnú výšku, inset amber
  focus ring a amber spodnú stopu vo vybranom stave. Všetky vlastné FX popover
  tlačidlá majú jednotný 2 px inset focus ring; `aria-pressed` oznamuje aktívnu
  kategóriu.
- Pri rack slote do 560 px má CLOSE tlačidlo, intent návrh a effect cards
  minimálne 44 px výšku. Efektový výber a jeho logika sa nemenia.
- Upravené: `src/styles/03-mixer.css` a `src/ui/FxAddPopover.tsx`. Vizuálny
  screenshot focusu a aktívneho filtra zostáva otvorený.
- `npm run build`: **PASS** cez TypeScript, Vite, PWA a všetky bundle gates;
  DAW JS **4964/5186 KB**, optional runtimes **647/650 KB**, stem runtime
  **404/430 KB**, core worklety **150/150 KB** a boot path **2176/2200 KB**.
  `npm run format:check`, cielený Prettier a `git diff --check`: **PASS**.
  Automatické testy sa nespúšťali.

### Mixer — track color picker target a keyboard focus — 2026-10-15

- Track color input mal 18 × 18 px bez vlastného hover ani `:focus-visible`
  stavu. Teraz má 24 × 24 px na desktopoch a 28 × 28 px pri coarse pointeri,
  tichý raised okraj a amber focus ring.
- Track farba aj existujúci double-click reset zostávajú bez zmeny. Čerstvý
  screenshot channel headera v úzkom stripe ešte treba skontrolovať.
- `npx vite build --logLevel error`, bundle budgety a `npm run format:check`:
  **PASS** (DAW JS **4975/5186 KB**, boot path **2181/2200 KB**).
  Cielený Prettier a `git diff --check`: **PASS**. Plný build zostáva
  blokovaný paralelnými MCP ripple compile chybami; automatické testy sa
  nespúšťajú.

### Mixer — klávesnicový fokus názvu tracku — 2026-10-15

- Názov tracku rušil predvolený outline pri `:focus` a nechával iba 1 px
  accent border. Pri keyboard navigácii teraz používa spoločný 2 px amber
  `:focus-visible` ring; colored strip border zostáva identitou tracku.
- Upravené: `src/styles/41-native-field-focus.css`. Vizuálna kontrola názvu
  v selected stripe ešte zostáva otvorená.
- `npx vite build --logLevel error`, bundle budgety, `npm run format:check`,
  cielený Prettier a `git diff --check`: **PASS** (DAW JS **4975/5186 KB**,
  boot path **2181/2200 KB**). Plný build je blokovaný nesúvisiacimi MCP
  ripple typovými chybami; automatické testy sa nespúšťajú.

### Mixer / Arrangement — Scene Strip armed a focus stavy — 2026-10-15

- Source audit ukázal, že povolené MIDI CC remapy mali oproti vypnutým iba
  tlmenie opacity, takže armed stav nebol v hustej lište dostatočne čitateľný.
  Dostal jemné amber pozadie a okraj, ktoré nadväzujú na aktívny stav KYX bez
  zmeny správania checkboxov.
- Oba pair selecty a CC remap položka teraz majú viditeľný 2 px amber focus
  ring. Pri CC položke ring obopína celý label, nie len malý natívny checkbox.
- Názov tracku v riadku Scene Stripu teraz odráža globálny výber tracku cez
  `aria-pressed` a jemnú amber ľavú stopu. Akcia už preto neskončí v tichom
  stave bez vizuálnej spätnej väzby.
- Upravené: `src/styles/03-mixer.css` a
  `src/styles/39-arrangement-interaction-finishing.css` a
  `src/ui/SceneStrip.tsx`. Čerstvý screenshot
  armed/focus stavu Scene Stripu ešte treba skontrolovať v Mixeri aj Arrangement.
- `npx vite build` a samostatná bundle kontrola: **PASS** (DAW JS **4970/5186
  KB**, studio boot path **2178/2200 KB**). `npm run format:check`, cielený
  Prettier a `git diff --check`: **PASS**. `npm run build` zostáva blokovaný
  TypeScript chybami v `tests/master-iterate.test.ts`; automatické
  testy sa nespúšťają.
