# Pulse Forge — implementation roadmap pre ďalšieho agenta

> Stav dokumentu: 2026-09-04  
> Scope: plugin UX, A/B workflow, gain-match, makrá, mixer a produkčná stabilita  
> Účel: vykonateľný plán nad aktuálnym kódom Pulse Forge, nie produktová vízia

## Pracovný kontrakt

Tento dokument je pracovný kontrakt pre implementačného agenta. Cieľom nie je naraz pridať čo najviac funkcií, ale dotiahnuť existujúci DAW workflow tak, aby bol konzistentný, vratný, zrozumiteľný a pripravený na ďalšie world-class rozširovanie.

Agent musí:

- najprv prečítať tento dokument a overiť aktuálny worktree;
- zachovať existujúce používateľské zmeny a nerobiť reset, checkout ani široký rewrite;
- postupovať po fázach a po každom checkpoint-e spustiť relevantný typecheck/test;
- pri každej novej persisted vlastnosti doplniť normalizáciu, undo/redo, collab round-trip a regresný test;
- používať existujúce commands/store/model vrstvy, nie obchádzať ich lokálnym React state;
- neukladať editorový stav do `EffectInstance.params`, ak nejde o skutočný audio parameter;
- neupravovať vendored Ultina core priamo bez upstream/re-vendor postupu;
- aktualizovať checkboxy v tomto dokumente až po dôkaze v teste, builde alebo browser smoke teste;
- na konci nahlásiť zmenené súbory, príkazy, výsledky a otvorené riziká.

Ak sa počas práce ukáže, že architektúra v kóde odporuje tomuto plánu, agent má najprv zastaviť danú fázu, zapísať rozhodnutie a až potom pokračovať. Nemá potichu vymýšľať paralelný state model.

## Definition of Done

Roadmap je splnená, keď:

- pluginy FXEQ, Ultina a Ozvena majú jeden čitateľný device workflow a rovnaké základné ovládanie;
- Ultina A/B stav prežije collapse, unmount, prepnutie tracku, reload projektu, undo/redo a collab sync;
- používateľ vie makro namapovať na track gain/pan aj na konkrétny FX/instrument parameter bez nejasnej “sticky” hodnoty;
- mixer je hlavné miesto pre výkonové makrá, výber trackov, batch FX a základné gain/solo/mute rozhodnutia;
- gain-match jasne rozlišuje “nemám signál” od “meriam 0 dB rozdiel”;
- žiadna nová funkcia nerozbije legacy dokumenty, existujúce commands ani lazy loading pluginov;
- prejdú typecheck, relevantné UI/model/engine testy, browser smoke a build s bundle budgetom.

## Aktuálny reálny baseline

Toto už v kóde existuje a agent to nemá implementovať od nuly:

- `src/effects/registry.ts` obsahuje `FLAGSHIP_EFFECT_ORDER` s `fxeq`, `ultina`, `ozvena`;
- `src/ui/EffectRack.tsx` ich ponúka v `+ ADD EFFECT`, lazy-loaduje tri flagship panely a má device header s bypass stavom, preset selectom a collapse/expand;
- `src/ui/UltinaPanel.tsx` má UI A/B slotov, copy A→B, copy B→A, clear, status slotu a gain-match feedback;
- `src/ui/MacroPerformanceBar.tsx` a `src/ui/Mixer.tsx` poskytujú performance makrá nad mixerom;
- `src/ui/ModPanel.tsx` vie editovať názov/hodnotu makra, gain/pan mapping a MIDI Learn CC;
- `src/ui/Sequencer.tsx` má Beat Focus režim;
- existujú commandy pre macro hodnoty/mappingy, effect params, bypass, Ultina params/presets/proposals a batch FX.

Posledný zaznamenaný validačný baseline:

- `npm run typecheck` — prešiel;
- dot-targeted UI testy pre Mixer/EffectRack — prešli;
- `npm run build` — prešiel, entry približne 952 KB z limitu 995 KB, celkový JS približne 1590 KB z limitu 2400 KB;
- full `npm test` — 1608 passed, 88 skipped; jeden timeout v `tests/gallery-server.test.ts` pri remixe/play count flow. Agent ho musí najprv reprodukovať a izolovať, aby bolo jasné, či ide o flaky test alebo regresiu.

## Čo je dnes najslabšie — technický audit

### P0: A/B je zatiaľ host-local UI state

`EffectInstance` v `src/project-model/types.ts` dnes obsahuje iba `id`, `type`, `bypassed`, `params`, voliteľné `steps` a `sidechainTrackId`. `Device` v `src/ui/EffectRack.tsx` drží `ultinaAbState` cez React `useState`.

To znamená, že collapse zachová A/B stav iba preto, že komponent zostáva mountnutý. Stav sa však nemôže spoľahlivo preniesť cez unmount, reload, undo/redo ani collab. Ultina core už má `ABSnapshot` a `UltinaState.abSnapshots` v `src/effects/ultina-core/contracts/state.ts`, ale host projektový model tento stav zatiaľ neperzistuje.

### P0: generic macro target existuje v modeli, ale nie v celom flow

`MacroMapping` už má `source`, `target`, `min`, `max` a `AutomationTarget` podporuje `trackGain`, `trackPan`, `fxParam` a `instParam`. `src/audio-engine/AudioEngine.ts` však v `syncMacros` spracúva generic FX/instrument target iba pre `source === "intensity"`; bežné `source === "macro"` stále ide cez legacy gain/pan akumuláciu.

`src/ui/ModPanel.tsx` tiež ponúka používateľovi iba gain/pan mapping a MIDI Learn. Treba doplniť celý reťazec: picker/learn → command → schema/collab → engine resolution → UI feedback → test.

### P1: plugin shell je dobrý základ, ale nie spoločný UX kontrakt

Collapse, bypass, fallback warning a preset header už sú v `EffectRack.tsx`. Flagship panely však majú odlišné interné ovládanie a A/B/gain-match existuje iba v Ultine. Pred ďalším rastom treba zjednotiť shell, focus/keyboard správanie, stav loadingu a pravidlá pre heavy runtime.

### P1: mixer potrebuje dokončiť rozhodovacie workflow

`src/ui/Mixer.tsx` už obsahuje track gain/pan/sends, M/S, duplicate/delete/freeze, group drag/drop, batch FX toolbar a performance macro bar. Ďalšia hodnota je v explicitnej spätnej väzbe: čo je vybrané, čo sa zmení jedným commandom, kde klipuje signál a ako sa používateľ vráti späť.

### P0: test suite musí byť dôveryhodný release gate

Kým full suite obsahuje timeout, agent nesmie označiť roadmapu za release-ready iba na základe zelených targeted testov. Najprv treba rozhodnúť, či timeout opraviť, stabilizovať test alebo zdokumentovať preukázaný infra problém.

## Fázy implementácie

### Fáza 0 — preflight a ochrana baseline

**Výstup:** agent vie presne, na akom stave začína, a nevytvorí konflikt s rozpracovanými zmenami.

- [ ] spustiť `git status --short` a prečítať existujúce zmeny pred editáciou;
- [ ] prečítať `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/commands/commands.ts`, `src/collab/YDocAdapter.ts`, `src/audio-engine/AudioEngine.ts`, `src/ui/EffectRack.tsx`, `src/ui/UltinaPanel.tsx`, `src/ui/ModPanel.tsx`, `src/ui/Mixer.tsx`;
- [ ] prečítať relevantné testy: `tests/ui/EffectRack.test.tsx`, `tests/ui/Mixer.test.tsx`, `tests/ui/ModPanel.test.tsx`, `tests/commands.test.ts`, `tests/doc-delta.test.ts`, collab/store testy a `tests/ultina-meters.test.ts`;
- [ ] spustiť `npm run typecheck`;
- [ ] spustiť timeoutujúci test samostatne a potom `npm test -- --reporter=dot`;
- [ ] zapísať baseline výsledok do agent reportu; do roadmapy odškrtnúť iba overené položky.

**Checkpoint:** žiadna zmena produkčného kódu, iba reprodukovaný baseline a jasný zoznam konfliktov.

### Fáza 1 — P0: dôveryhodný test a browser smoke loop

**Súvisiace súbory:** `tests/gallery-server.test.ts`, `scripts/verify-browser.mjs`, `src/browser-checks.ts`, relevantné test setup súbory.

- [ ] izolovať timeout v gallery/remix teste: či je príčinou časový limit, server lifecycle, nedeterministický stav alebo skutočná regresia;
- [ ] opraviť iba koreň problému; nezvyšovať timeout bez vysvetlenia, prečo je to správne;
- [ ] overiť, že `npm run test:browser` pokrýva aspoň otvorenie projektu, výber tracku, add effect, collapse pluginu, zmenu makra a základný play/stop;
- [ ] ak browser smoke niečo z baseline nepokrýva, doplniť malý stabilný check, nie veľký end-to-end framework;
- [ ] pri každej ďalšej fáze zopakovať targeted UI test + `npm run test:browser`.

**Akceptácia:** full suite nemá neobjasnený timeout; browser smoke má dôkaz pre hlavný happy path.

### Fáza 2 — P0: perzistentný Ultina A/B state

**Súvisiace súbory:**

- `src/project-model/types.ts` — persisted tvar `EffectInstance`/Ultina editor state;
- `src/project-model/schema.ts` — sanitize, defaults, migration a backward compatibility;
- `src/commands/commands.ts` — store/copy/clear/activate A/B cez undoable commandy;
- `src/collab/YDocAdapter.ts` — entity serialization a remote update round-trip;
- `src/ui/EffectRack.tsx`, `src/ui/UltinaPanel.tsx` — controlled state namiesto host-local-only state;
- `src/effects/ultina-core/contracts/state.ts` — iba ako kontrakt; vendored súbor neupravovať priamo;
- `tests/doc-delta.test.ts`, `tests/project-store.test.ts`, collab testy, `tests/ui/EffectRack.test.tsx`, prípadne nový focused test.

Navrhovaný postup:

- [ ] rozhodnúť persisted shape, napríklad voliteľný `ultinaState`/`editorState` na `EffectInstance`, oddelený od numeric audio `params`;
- [ ] do shape zahrnúť iba to, čo potrebuje projekt: A/B snapshoty, active slot, prípadne validated module order/enabled stav a `capturedLufs`;
- [ ] nevkladať React-only veci ako `collapsed`, DOM refs alebo loading stav do dokumentu;
- [ ] pridať sanitize/default pre staré dokumenty bez tohto poľa a ošetriť poškodené/neúplné snapshoty;
- [ ] zachovať kompatibilitu s `UltinaState`, `ABSnapshot`, `snapshotFromState` a `applySnapshot`; ak treba zmeniť core kontrakt, nájsť upstream zdroj a dodržať re-vendor postup;
- [ ] pridať commandy: store active slot, activate slot, copy A→B, copy B→A, clear slot;
- [ ] zabezpečiť, že každý command je jeden undo krok a že prepnutie slotu aplikuje snapshot do skutočných `params`/module state;
- [ ] zmeniť `Device`/`UltinaPanel` na controlled persisted state cez `doc` + commands; React state môže zostať iba ako transient draft pred commitom;
- [ ] rozšíriť YDoc adapter a delta round-trip test tak, aby remote peer dostal snapshot bez straty `undefined`/`null` slotov;
- [ ] pridať test pre unmount/re-render/track switch/reload-equivalent, nie iba collapse;
- [ ] otestovať, že A/B store neprepíše captured meter, pokiaľ to nie je explicitná súčasť snapshotu.

**Akceptácia:** vytvorím A, zmením plugin, vytvorím B, prepínam A/B, reloadnem projekt a výsledok je rovnaký; undo/redo a collab zachovajú obidva sloty.

### Fáza 3 — P1: jednotný flagship plugin shell

**Súvisiace súbory:** `src/ui/EffectRack.tsx`, `src/ui/FxEqPanel.tsx`, `src/ui/UltinaPanel.tsx`, `src/ui/OzvenaPanel.tsx`, `src/styles.css`, `tests/ui/EffectRack.test.tsx`.

- [ ] definovať spoločný header contract: collapse, bypass, názov, fallback/degraded stav, preset, keyboard focus a dostupné akcie;
- [ ] zachovať existujúci lazy `Suspense` boundary; collapsed device nemá mountovať heavy editor/meters, ak to nie je potrebné pre audio runtime;
- [ ] zjednotiť loading, empty, fallback a error presentation všetkých troch panelov;
- [ ] zjednotiť textové označenia `ACTIVE`/`BYPASSED`, tooltipy, `aria-expanded`, `aria-controls`, focus ring a klávesové ovládanie;
- [ ] oddeliť UI shell od plugin-specific panelu tak, aby ďalší flagship plugin nepotreboval kopírovať header logiku;
- [ ] zachovať existujúce effect-specific commands: FXEQ cez `setFxEqParam`, Ultina cez `setUltinaParam`, Ozvena cez `setEffectParam`/`applyOzvenaStatePatch`;
- [ ] doplniť regression test pre všetky tri pluginy: add → open → collapse → expand → bypass → preset;
- [ ] preveriť mobile/narrow rack a scroll/focus správanie v browseri.

**Akceptácia:** používateľ rozpozná rovnaký device pattern pri FXEQ, Ultina aj Ozvena; collapse nevymaže stav a nevyrobí zbytočný runtime churn.

### Fáza 4 — P0/P1: generic macro routing a Macro Learn

**Súvisiace súbory:** `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/commands/commands.ts`, `src/audio-engine/AudioEngine.ts`, `src/ui/ModPanel.tsx`, `src/ui/MacroPerformanceBar.tsx`, `src/ui/Mixer.tsx`, `src/collab/YDocAdapter.ts`, testy commands/model/UI/engine.

Najprv vyriešiť semantiku, až potom UI:

- [ ] definovať, či `macro.value` ostáva normalizované `0..1` a mapovanie sa interpretuje bipolarne `-1..1`; zachovať toto pravidlo z `AudioEngine.syncMacros`;
- [ ] pre direct `source === "macro"` implementovať `AutomationTarget` pre `trackGain`, `trackPan`, `fxParam`, `instParam`;
- [ ] zachovať legacy `trackId` + `param` mapping bez migrácie, ak je target prázdny;
- [ ] jasne definovať base-value: macro nesmie pri každom syncu kumulovať vlastný výsledok do ďalšieho výsledku; vždy čítať persisted/base parameter a vypočítať deterministic resolved value;
- [ ] pre FX target validovať `fxId` a `paramId` voči `EFFECT_DEFS`; pre instrument target voči `INSTRUMENT_DEFS`;
- [ ] definovať rozsah `amount`, `min`, `max`, invert a prípadnú curve tak, aby schema aj engine používali rovnaké clampovanie;
- [ ] pridať commandy pre generic mapping, editáciu targetu, amount/range a remove; každý command musí byť undoable a collab serializable;
- [ ] rozšíriť `ModPanel` o zrozumiteľný target picker: track → FX/instrument → parameter; pri FX zobraziť názov device, nie iba ID;
- [ ] pridať “Map/ Learn” flow z konkrétneho parameter controlu, vrátane odstránenia mappingu a indikácie, že parameter je namapovaný;
- [ ] performance bar má zostať rýchly: prvé štyri makrá, bipolar hodnoty, count/status mappingov; nepridávať doň celý editor mappingov;
- [ ] doplniť engine testy pre zero, min, max, bipolar midpoint, clamp a zmenu base parametra počas aktívneho macro mappingu;
- [ ] doplniť model/delta/collab testy pre generic target a starý legacy mapping.

**Akceptácia:** makro vie plynule a deterministicky riadiť track gain/pan, Ultina/FXEQ/Ozvena parameter a instrument parameter; po reloade a collab sync sa target nemení ani nekumuluje.

### Fáza 5 — P1: mixer ako výkonové a mixing centrum

**Súvisiace súbory:** `src/ui/Mixer.tsx`, `src/ui/MacroPerformanceBar.tsx`, `src/ui/ModPanel.tsx`, `src/commands/commands.ts`, `src/styles.css`, `tests/ui/Mixer.test.tsx`.

- [ ] zachovať explicitný batch scope: toolbar musí hovoriť, koľko trackov je vybraných a kam sa effect pridá;
- [ ] batch add/remove/bypass držať ako jeden undoable command; pri partial failure nesmie vzniknúť tichý polovičný stav;
- [ ] doplniť jasné `clear solo`, `clear mute` a bezpečné feedback stavy pre group/bus workflow;
- [ ] pridať per-channel peak/clip indikáciu napojenú na existujúce meter dáta, bez druhej paralelnej meter implementácie;
- [ ] zachovať RMB fader macro linking, ale po generic mapping fáze ho napojiť na explicitný target a zobraziť current mapping;
- [ ] keyboard/focus flow: selected track, focused fader, macro slider, undo; žiadne ovládanie nesmie byť iba color-coded;
- [ ] testovať 0, 1, viac vybraných trackov, send track a group/bus;
- [ ] browser smoke: vybrať tracky → batch FX → zmeniť macro → undo → overiť, že rack aj mixer ukazujú rovnaký stav.

**Akceptácia:** mixer dá používateľovi okamžitú odpoveď na “čo ovládam, koľko vecí mením a ako to vrátim”.

### Fáza 6 — P1: gain-match a A/B workflow ako jeden produktový príbeh

**Súvisiace súbory:** `src/ui/UltinaPanel.tsx`, `src/ui/FxEqPanel.tsx`, `src/ui/OzvenaPanel.tsx`, `src/audio-engine/AudioEngine.ts`, `src/effects/ultina-core/contracts/meters.ts`, `src/styles.css`, meter/UI testy.

- [ ] reuse existujúce meter pipeline (`GlobalMeters`, `getFxMeters`, `autoGainCorrectionDb`, `autoGainErrorDb`, `autoGainActive`); nevytvárať paralelný polling len pre UI;
- [ ] zachovať pravdivé stavy: `WAITING FOR SIGNAL`, aktívny lock, target LUFS a delta; “0.0 dB” nesmie vyzerať ako validný lock bez signálu;
- [ ] otestovať gain-match pri play/stop, bez signálu, po bypass a pri zmene target LUFS;
- [ ] po perzistencii Ultina A/B rozhodnúť, či FXEQ/Ozvena dostanú host-level A/B rovnakým contractom alebo ostanú plugin-specific; rozhodnutie zapísať do ADR/roadmap reportu;
- [ ] A/B compare musí mať jasnú active state, copy, store, clear, undo a klávesový/focus flow;
- [ ] pri porovnaní nesmie gain-match meniť uložené audio parametre; trim musí byť explicitne runtime/output correction.

**Akceptácia:** A/B rozhodnutie je počuteľné, vratné a používateľ vie, či porovnáva reálnu zmenu alebo iba hlasnejší výstup.

### Fáza 7 — P2: Beat Focus a sequencer polish

Beat Focus už existuje v `src/ui/Sequencer.tsx`; táto fáza je iba follow-up, nie nový rewrite.

- [ ] preveriť persistence/session semantics režimu a či je správne transient vs. project state;
- [ ] preveriť shortcut, resize, keyboard focus a návrat do normálneho layoutu;
- [ ] overiť, že Beat Focus neblokuje mixer/plugin keyboard actions a nezvyšuje entry bundle;
- [ ] doplniť iba konkrétne regresie odhalené browser smoke testom.

**Akceptácia:** sequencer focus zrýchľuje beatmaking bez toho, aby odrezal mixing/plugin workflow.

### Fáza 8 — release hardening

- [ ] `npm run typecheck`;
- [ ] `npm test -- --reporter=dot`;
- [ ] `npm run test:browser`;
- [ ] `npm run build` vrátane `build:fxeq`, `build:ultina`, `build:ozvena` a `scripts/check-bundle-size.mjs`;
- [ ] `npm run format:check` alebo ekvivalentná kontrola zmenených súborov;
- [ ] skontrolovať, že entry bundle ostáva pod 995 KB a total JS pod 2400 KB;
- [ ] skontrolovať nový dokument, migrácie a collab testy na čistom reload-equivalent flow;
- [ ] urobiť krátky manual browser pass: nový projekt → add flagship → collapse → A/B → macro map → mixer batch → undo → reload;
- [ ] zapísať zostávajúce known issues a rozhodnúť, či blokujú release.

## Odporúčané poradie commitov

Ak agent pracuje v jednom worktree, robiť malé logické commity v tomto poradí:

1. `test: stabilize gallery/browser baseline`
2. `feat: persist ultina ab snapshots`
3. `refactor: share flagship device shell`
4. `feat: route generic macro targets`
5. `feat: finish mixer performance workflow`
6. `feat: harden gain-match and ab compare`
7. `test: release smoke and regression coverage`

Každý commit má mať vlastný relevantný test. Ak projektová konvencia nepoužíva tieto prefixy, zachovať lokálny convention.

## Súbory a ownership pri paralelnej práci

Primárne je roadmapa písaná pre jedného agenta. Ak sa úlohy predsa len rozdelia, nesmú dvaja agenti naraz upravovať rovnaké centrálne súbory bez dohody.

- **State/audio agent:** `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/commands/commands.ts`, `src/collab/YDocAdapter.ts`, `src/audio-engine/AudioEngine.ts` a model/engine testy.
- **Plugin UX agent:** `src/ui/EffectRack.tsx`, `src/ui/FxEqPanel.tsx`, `src/ui/UltinaPanel.tsx`, `src/ui/OzvenaPanel.tsx`, plugin CSS a `tests/ui/EffectRack.test.tsx`.
- **Macro/mixer agent:** `src/ui/ModPanel.tsx`, `src/ui/MacroPerformanceBar.tsx`, `src/ui/Mixer.tsx`, mixer CSS a UI testy; na engine/commands siahnuť až po ustálení state contractu.
- **QA agent:** `tests/`, `scripts/verify-browser.mjs`, smoke/regression matrix; produkčný kód meniť iba pri potvrdenom test/infra probléme.

Najväčšie konfliktné súbory sú `src/commands/commands.ts`, `src/project-model/types.ts`, `src/audio-engine/AudioEngine.ts` a `src/styles.css`. Tie majú mať jedného ownera na jednu fázu.

## Non-goals — čo teraz nerobiť

- nepridávať ďalší veľký flagship plugin, kým nie je stabilný shell, A/B a macro contract;
- neprepísať celý mixer ani sequencer kvôli vizuálnemu polishu;
- nevytvárať nový state management framework;
- neukladať collapsed/UI/loading stav do audio dokumentu;
- nezvyšovať bundle budget iba preto, aby sa obišiel lazy-loading/performance problém;
- neupravovať `src/effects/ultina-core/**` ručne bez dohľadateľného upstream/re-vendor dôvodu;
- nerozširovať scope na cloud collaboration/server redesign, ak to nie je nutné pre existujúci YDoc round-trip;
- neoznačiť feature za hotovú iba na základe “vyzerá dobre v browseri”.

## Finálny report pre ownera

Na konci agent odovzdá:

- krátke zhrnutie používateľskej hodnoty;
- zoznam zmenených súborov s dôvodom;
- stav jednotlivých fáz a odkazy na testy;
- presné výsledky `typecheck`, targeted tests, full tests, browser smoke, build a bundle budget;
- známe limity/flaky testy a odporúčanie pre ďalší krok;
- informáciu, či dokumentácia/ADR alebo migration notes potrebujú doplnenie.

Ak niektorý checkpoint neprejde, agent má uviesť konkrétny blocker a zastaviť iba danú fázu. Nemá maskovať zlyhanie vypnutím testu, zvýšením timeoutu bez dôvodu alebo obídením command/store vrstvy.
