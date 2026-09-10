# KYX — pre-release implementation roadmap

**Status:** agent-ready roadmap + live execution snapshot (not a release approval)  
**Dátum:** 2026-09-10  
**Produkt:** KYX browser-first beatmaking DAW  
**Cieľ:** dostať KYX do stavu, v ktorom nový používateľ vytvorí beat, vyberie zvuk, spracuje ho cez pluginy, zrozumiteľne ho zmixuje a bezpečne exportuje bez straty práce, nečakaných level skokov alebo nejasného workflow.

Tento dokument je implementačný plán pre ďalšieho agenta. Každá úloha má byť riešená proti existujúcemu kódu v repozitári, nie ako samostatný redesign produktu.

## 0. Aktuálny execution snapshot

Nasledujúce časti roadmapy už boli v tomto pracovnom strome implementované a overené:

- ne-deštruktívny preset audition pre nástroje, stop pri play/stop a Escape cancel,
- Simple/Advanced Inspector pre nástroje bez zmeny project schema,
- spoločný plugin reset cez jednu undoable command operáciu vrátane hidden parametrov,
- PRISM/VLYX/VØID shell feedback: modified state, bypass-aware gain-match a konzistentný meter clip hold,
- raw track/return metering a true-peak-aware master clip policy,
- collab room/connection/message limity, pending-upgrade reservations, CORS allowlist, health metrics a bounded REST payload response,
- video sub-second export policy a soft-knee float WAV sanitizácia pre 24/32-bit export,
- KYX/PRISM/VLYX/VØID user-facing branding pass s ponechanými internými compatibility IDs,
- explicitný host seed pre PRISM/FXEQ s rovnakou hodnotou v live/offline chain,
- VLYX upstream hardening: Sculptor sparse-spectrum guard, stereo T/S isolation,
  crossover re-prepare invalidation a Phase Time Shift dry/delta capacity,
- zjednotený A/B controller pre PRISM/VLYX/VØID shell s undo-preserving recall,
- gallery report/delete moderation flow s rate-limitom, admin auth a privacy policy,
- regression tests pre každý z vyššie uvedených kontraktov.

Overené príkazy a výsledky:

| Gate                                                       | Výsledok                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `npm run typecheck:clean`                                  | PASS                                                     |
| `npm run build` + worklet buildy + bundle budget           | PASS — entry 873 KB / 995 KB, total JS 1668 KB / 2400 KB |
| `npm run build:ultina`                                     | PASS — rebuilt `public/ultina-worklet.js`                |
| `npm run test:browser`                                     | PASS — 197/197 checks                                    |
| PRISM/FXEQ + VLYX targeted Vitest suite                    | PASS — 124/124 tests                                     |
| upstream Ultina affected suite                             | PASS — 104/104 tests                                     |
| affected post-fix suites (`services-close-race`, `TopBar`) | PASS — 20/20 tests                                       |
| scoped Prettier + `git diff --check`                       | PASS                                                     |

Historický kompletný Vitest beh pred poslednými mikro-opravami mal 2 zlyhané súbory; príčinou boli close-race mocky bez audition hooku a stale branding assertion. Obe príčiny majú opravy a zasiahnuté testy sú zelené. Po poslednom upstream VLYX syncu je pre release vhodné zopakovať full Vitest beh, ak CI časový budget dovolí; aktuálne je pokrytý cieleným KYX + upstream suite.

`npm run format:check` na celom historickom strome je stále červený kvôli 188 existujúcim formatting deviations mimo tohto passu. Pred release treba buď vykonať samostatný formatting-only cleanup, alebo tento presný zoznam explicitne akceptovať v CI gate; nesmie sa to maskovať zmenou scope checku.

Ešte povinné pred verejným deployom: manuálny Firefox/Safari/iOS smoke, reálne audio zariadenia, produkčný CORS origin, deploy/server health check a end-to-end refresh/tab-close recovery na produkčnom hoste.

## 1. Verejná terminológia

Používateľské názvy sú:

| Verejný názov | Interný typ / ID                       | Poznámka                                            |
| ------------- | -------------------------------------- | --------------------------------------------------- |
| KYX           | Pulse Forge / existujúce interné názvy | Interné ID, priečinky a persistence kľúče nemeníme. |
| PRISM         | `fxeq`                                 | EQ / spectral processor.                            |
| VLYX          | `ultina`                               | Intelligent mix processor.                          |
| VØID          | `ozvena`                               | Reverb / spatial processor.                         |

Pri implementácii sa používajú verejné názvy v UI, titulkoch, exportovaných marketingových textoch a release copy. Interné ID, worklet názvy, existujúce schema kľúče a upstream adresáre zostávajú kompatibilné.

## 2. Aktuálny technický základ

Pred začiatkom práce si agent overí stav priamo v kóde. Relevantné source-of-truth miesta:

- projektový model a migrácie: `src/project-model/types.ts`, `src/project-model/schema.ts`, súvisiace command/mutation moduly,
- efekty: `src/effects/registry.ts`, `src/ui/EffectRack.tsx`, `src/ui/FxEqPanel.tsx`, `src/ui/UltinaPanel.tsx`, `src/ui/OzvenaPanel.tsx`,
- spoločné plugin ovládanie: `src/ui/EffectAbControls.tsx`, `src/ui/ModPanel.tsx`, `src/ui/MacroPerformanceBar.tsx`,
- nástroje a mixer: `src/ui/Mixer.tsx`, `src/ui/Sequencer.tsx`, `src/ui/DiceTray.tsx`, `src/ui/AssistPanel.tsx`, `src/ui/ArrangementPanel.tsx`,
- audio runtime: `src/audio-engine/AudioEngine.ts`, `src/services.ts`, `src/rendering/bounce.ts`, `src/rendering/wav.ts`,
- persistence a recovery: `src/persistence/`, `src/export/project-io.ts`, `src/export/scorepack.ts`,
- collaboration/backend: `src/collab/`, `server/collab-server.mjs`,
- testy: `tests/` a browser smoke testy v konfigurácii projektu.

V repozitári už existuje:

- 13 nástrojov vrátane sampleru, synthov, wavetable, granular, keys, pluck, log drum, spectral pad, vocal chop a drum synth,
- tri flagship efekty PRISM, VLYX a VØID plus širší FX registry,
- preset browser s vyhľadávaním, filtrami, favorites, recent a user presetmi,
- sample preview cez `services.engine.previewAsset`,
- preview infraštruktúra v `AudioEngine` / `GhostPreviewPlayer`,
- plugin A/B ovládanie cez `EffectAbControls` aspoň pre PRISM a VØID,
- VLYX vlastný A/B, gain-match, delta, reference match, EQ learn a mix assist,
- Beat Focus režim v `Sequencer.tsx`,
- DICE, Assist a Arrangement workflow,
- autosave/snapshot infrastructure a lokálna collaboration vrstva.

To znamená, že najbližšia práca má spevniť konzistenciu, audio správnosť, recovery a release QA. Prioritou nie je pridávať ďalšie nástroje alebo štvrtý flagship plugin.

## 3. Nezmeniteľné implementačné pravidlá

Každý agent ich musí dodržať:

1. Kanonický stav projektu sa mení cez existujúce command/mutation API. UI komponent nesmie potichu obchádzať undo, autosave alebo collaboration.
2. Preview je dočasný runtime stav. Preview presetu, plugin parametra alebo sample nesmie meniť projekt, históriu ani export, kým používateľ nepotvrdí `Apply`.
3. UI transient state sa neukladá do project file, pokiaľ nejde o zámernú session preference s jasným migration plánom.
4. Live playback a offline render musia používať rovnaké DSP pravidlá, seed a parameter semantics. Náhodné LFO, variation alebo generative eventy musia mať deterministický seed.
5. A/B, gain-match a delta nesmú zapisovať runtime trim do používateľských audio parametrov. Level compensation musí byť oddelená od sound-design parametrov.
6. Nebudeme priamo editovať vendored `src/effects/ultina-core/**`. Opravy VLYX patria do upstream `D:/VocalForge_DAW/plugins/ultina` a následne sa synchronizujú existujúcim vendor/build procesom.
7. Zachovať lazy loading a existujúce bundle budgety. Nová feature nemá byť dôvod na globálny state framework ani na zmenu build pipeline.
8. Nemeníme interné ID `fxeq`, `ultina`, `ozvena` ani formát existujúcich projektov len kvôli brandingu.
9. Každá zmena centralizovaných súborov ako `commands.ts`, `AudioEngine.ts`, spoločné CSS alebo registry musí mať jedného ownera a následný full test.
10. Pri neistej audio zmene sa najprv pridá reprodukčný test alebo testovací fixture, až potom sa mení DSP.

## 4. Poradie práce

### P0 — release correctness a audio dôvera

Tieto body majú prednosť pred polishom. Ak niektorý P0 zlyháva, release sa nepovažuje za bezpečný.

- [ ] deterministický PRISM/FXEQ export,
- [ ] odstránenie potvrdených VLYX DSP regresií,
- [ ] hardening VØID IR/pre-delay runtime allocations,
- [ ] export clipping/tempo/marker policy,
- [ ] ne-deštruktívny preset audition pre nástroje,
- [ ] konzistentný A/B a gain-match kontrakt,
- [ ] recovery, reload a export/import smoke.

### P1 — najväčší UX dopad

- [ ] Simple/Advanced instrument workflow,
- [ ] jednotný plugin shell a focus/keyboard správanie,
- [ ] mixer metering, clip feedback a batch operácie,
- [ ] DICE → preview → lock → vary → arrange flow,
- [ ] Beat Focus session/shortcut polish,
- [ ] verejná branding konzistencia a release documentation.

### P2 — po release alebo iba ak neohrozuje P0/P1

- [ ] ďalšie sound packs a preset curation,
- [ ] pokročilejšie routing templates,
- [ ] cloud účty, serverová persistentná databáza alebo komplexná moderácia,
- [ ] nový flagship plugin alebo veľký instrument expansion.

## 5. Fáza 0 — evidence baseline

**Owner:** QA/release agent  
**Závislosti:** žiadne  
**Dotknuté súbory:** iba report alebo test fixtures, ak je potrebná reprodukcia

### Úloha

Spustiť a zaznamenať aktuálny stav pred ďalšími zmenami:

```text
npm run typecheck:clean
npm test -- --reporter=dot
npm run test:browser
npm run build
npm run format:check
npm audit --omit=dev --audit-level=high
```

Ak sa script názvom alebo argumentom líši od aktuálneho `package.json`, agent použije skutočný dostupný script a uvedie odchýlku v reporte. Žiadny existujúci fail sa nesmie označiť ako „baseline“ bez presného názvu testu a reprodukcie.

### Manuálny release flow

Overiť v Chromium/Edge a následne manuálne vo Firefox, Safari a iOS Safari:

1. nový projekt,
2. vytvorenie tracku a výber presetu,
3. preview zvuku bez aplikovania,
4. apply presetu, undo a redo,
5. aranžovanie patternu/scény,
6. pridanie PRISM, VLYX a VØID cez `+ ADD EFFECT`,
7. bypass, collapse, preset, A/B, gain-match a macro,
8. mixer level/pan/mute/solo a export,
9. reload alebo reopen projektu,
10. export/import projektu a opakovaný audio bounce.

### Akceptácia

- baseline report obsahuje presné počty pass/fail/skip,
- console errors, unhandled promise rejections a audio worklet load chyby sú nulové,
- všetky známe residuals sú buď opravené, alebo explicitne blokujú release,
- ďalší agent dostane konkrétny reprodukčný krok, nie iba screenshot alebo všeobecný opis.

## 6. Fáza 1 — P0 audio correctness

### 6.1 Deterministický PRISM export

**Owner:** DSP/audio agent  
**Súbory:** `src/effects/fxeq-core/dsp/lfo.ts`, súvisiace FXEQ runtime/build súbory, `public/fxeq-worklet.js`, testy `tests/fxeq-*.test.ts`

#### Implementácia

- identifikovať všetky PRISM/FXEQ random sources v live aj offline ceste,
- zaviesť explicitný seed odvodený stabilne z projektu, tracku, efektu a render contextu,
- oddeliť seed renderu od UI preview randomness,
- zachovať kompatibilitu existujúcich projektov bez seed fieldov cez deterministický default,
- overiť, že dva exporty rovnakého projektu majú rovnaký výsledok v rámci definovanej numerickej tolerancie,
- rebuildnúť worklet cez existujúci build script; ručne neupravovať generovaný bundle.

#### Akceptačné kritériá

- rovnaký projekt + rovnaký seed = rovnaký offline bounce,
- live preview a offline render majú rovnakú LFO phase/parameter semantics,
- změna seed je zámerná, viditeľná v debug/test API alebo serializovaná podľa modelu,
- test pokrýva reload, export a viacero súčasných PRISM inštancií,
- bundle budget sa nezvýši mimo existujúceho limitu.

### 6.2 VLYX upstream kvalita

**Owner:** VLYX/DSP agent  
**Súbory:** upstream `D:/VocalForge_DAW/plugins/ultina`, potom vendor/build output; host testy v `tests/`

#### Potvrdené prípady — stav

- [x] Sculptor pri sparse/silent band nesťahuje všetky aktívne pásma,
- [x] Transient/Sustain neprepúšťa stereo L do R,
- [x] reprepare existujúcej inštancie neresetuje LR4 crossover do identity,
- [x] Phase Time Shift nad približne 4 ms správne kompenzuje dry/wet a delta,
- [ ] mix assist/reference match analýza stále nesmie blokovať main thread pri dlhšom materiáli.

#### Akceptačné kritériá

- štyri vyriešené DSP regresie majú upstream test, host regression test a nový
  vendored/worklet artefact,
- live/offline parity je overená na krátkom aj dlhšom fixture,
- analysis progress/cancel/failure stav je viditeľný v UI a neblokuje editor,
- pri nedostupnom upstream repozitári agent nahlási blocker; nesmie patchovať vendored core ako skratku.

### 6.3 VØID runtime hardening

**Owner:** VØID/audio agent  
**Súbory:** upstream/vendor VØID core, `src/ui/OzvenaPanel.tsx`, `src/ui/EffectRack.tsx`, príslušné testy

#### Implementácia

- zmerať IR loading a pre-delay resize na reálnych browser zariadeniach,
- odstrániť alebo obmedziť audio-thread partition FFT allocation/copy,
- pre-delay buffer zväčšovať mimo kritickej audio callback cesty alebo bezpečne pred pripravením playbacku,
- pridať loading/ready/error stav pre IR bez falošného dojmu, že efekt je aktívny,
- overiť bypass, reload, viac VØID inštancií a offline render.

#### Akceptácia

- pri načítaní IR nevznikajú počuteľné dropouts ani worklet exception,
- VØID má rovnaký výsledok po reload a v offline bounce,
- zlyhanie assetu je recoverable a nepoškodí celý projekt.

### 6.4 Export residuals

**Owner:** render/export agent  
**Súbory:** `src/rendering/bounce.ts`, `src/rendering/wav.ts`, `src/export/video.ts`, súvisiace export testy

Vyriešiť alebo explicitne uzavrieť:

- head-trim v tempo mape a `stretchRate`,
- 32-bit float WAV soft-knee/overflow policy namiesto nečakaného hard clipu,
- marker cue one-shot policy v master WAV (buď podporiť, alebo jasne dokumentovať v export UI),
- zrušenie offline stage renderu bez zamrznutia UI,
- video export kratší ako jedna sekunda.

Akceptácia: export zložitého projektu má stabilný duration, sample rate, tempo boundary, peak policy a reprodukovateľný výsledok. Každá zámerná strata informácie je viditeľná používateľovi pred exportom.

## 7. Fáza 2 — P0/P1 instrument UX

### 7.1 Ne-deštruktívny preset audition

**Owner:** instrument UX agent  
**Súbory:** `src/ui/PresetBrowser.tsx`, `src/ui/Inspector.tsx`, `src/services.ts`, `src/audio-engine/AudioEngine.ts`, nové/rozšírené `tests/ui/PresetBrowser*.test.tsx`

#### Cieľ

Používateľ musí vedieť porovnať preset bez toho, aby prišiel o aktuálny sound.

#### Implementácia

- využiť existujúci `GhostPreviewPlayer` alebo preview service; nevytvárať paralelný audio engine,
- pridať jasné akcie `Preview`, `Apply`, `Cancel/Revert`,
- počas preview nemeníť projektový model, undo stack, collaboration broadcast ani recent/applied metadata,
- pri `Apply` vykonať jednu kanonickú mutation/command operáciu,
- preview zastaviť pri `Escape`, zmene tracku, zatvorení browsera a play/stop policy podľa existujúceho audio kontraktu,
- zobraziť active/applied/preview stav a zabrániť double-click race,
- ak je to možné, použiť gain-match alebo aspoň konzistentnú preview level policy.

#### Akceptácia

- preview → cancel ponechá pôvodný sound a históriu bez zmeny,
- preview → apply vytvorí presne jednu undo položku,
- reload počas/po preview neuloží do projektu dočasný preset,
- funguje keyboard focus a screen-reader label,
- test pokrýva play, stop, cancel, apply, rýchle prepínanie presetov a chýbajúci asset.

### 7.2 Simple/Advanced Inspector

**Owner:** instrument UX agent  
**Súbory:** `src/ui/Inspector.tsx`, instrument metadata/registry, existujúce instrument panel komponenty, CSS a UI testy

#### Implementácia

- Simple view má iba najdôležitejšie tvorivé parametre pomenované hudobne, nie iba technickým názvom,
- Advanced view zachová úplný parameter access pre power usera,
- stav Simple/Advanced je UI/session preference, nie nekompatibilná zmena project schema,
- ovládania majú jednotné reset, value display, keyboard step, min/max a tooltip správanie,
- neodstraňovať existujúce parametre ani nemeníť interné názvy bez migration plánu,
- pri nástrojoch s odlišným charakterom použiť metadata namiesto veľkého `if/else` stromu v `Inspector.tsx`.

#### Akceptácia

- prvá obrazovka je pochopiteľná pre nového používateľa,
- Advanced režim nestráca žiadnu existujúcu funkcionalitu,
- všetkých 13 nástrojov má validný default, preset a reset path,
- žiadny parameter nesmie byť nedostupný kvôli viewportu alebo focus trapu.

### 7.3 Preset curation

**Owner:** sound/content agent  
**Súbory:** `src/presets/factory.ts`, preset types/registry, test fixtures, docs

- pred ďalším pridávaním presetov odstrániť duplicity a zlé defaulty,
- doplniť metadata pre use case, mood, energy, key/BPM suitability a source/license status,
- skontrolovať clipping, ticho, extrémny output gain a užitočný prvý preview hit,
- testovať deterministic factory output a validitu všetkých registry presetov.

Definition of done nie je „viac presetov“, ale rýchlejšie nájdenie správneho zvuku.

## 8. Fáza 3 — P0/P1 plugin UX

### 8.1 Spoločný plugin shell

**Owner:** plugin UX agent  
**Súbory:** `src/ui/EffectRack.tsx`, `src/ui/FxEqPanel.tsx`, `src/ui/UltinaPanel.tsx`, `src/ui/OzvenaPanel.tsx`, `src/ui/EffectAbControls.tsx`, `src/ui/styles.css`, UI testy

Zjednotiť bez prepisu panelov:

- header s názvom, bypass, collapse/expand a fallback stavom,
- preset affordance, reset a dirty/modified indikáciu,
- focus order, keyboard shortcuty a `aria-*` popisy,
- disabled/loading/error states,
- správanie pri malom viewport, zoomovaní a resize,
- vizuálnu hierarchiu tak, aby hlavný sound-shaping surface nebol utopený v detailoch.

Akceptácia: PRISM, VLYX a VØID používateľsky pôsobia ako jeden produkt, ale každý si zachová svoj charakteristický hlavný control.

### 8.2 Univerzálny A/B kontrakt

**Owner:** plugin state agent  
**Súbory:** `src/ui/EffectAbControls.tsx`, `src/ui/EffectRack.tsx`, `src/ui/UltinaPanel.tsx`, `DeviceState`/project runtime typy, command/collab moduly, testy A/B

#### Kontrakt

- A = uložený snapshot pluginových sound parametrov,
- B = druhý snapshot rovnakého pluginu,
- `STORE` uloží aktuálny stav do zvoleného slotu,
- `COPY` skopíruje A → B alebo B → A podľa explicitnej akcie,
- `CLEAR` vráti slot do prázdneho stavu,
- `A/B` prepína iba snapshot parametre, nie project routing alebo host runtime trim,
- apply/recall je jedna undoable operácia,
- snapshot je serializovateľný a má jasnú verziu.

#### Implementácia

- rozšíriť existujúce `EffectAbControls` namiesto troch samostatných implementácií,
- rozhodnúť a zdokumentovať, či sa snapshot ukladá do projectu alebo iba session; pre release musí byť správanie konzistentné po reload/collab,
- zladiť VLYX interný A/B s host contractom alebo ho jasne oddeliť ako interný compare mode,
- testovať store/copy/clear/recall, bypass, missing slot, undo, reload, collaboration a focus.

### 8.3 Univerzálny gain-match

**Owner:** audio UX agent  
**Súbory:** existujúca meter pipeline v `src/audio-engine/AudioEngine.ts`, plugin host/rack, `src/ui/UltinaPanel.tsx`, `EffectAbControls`, testy

- použiť existujúci meter/analysis pipeline; nevytvárať per-plugin duplicity,
- explicitne modelovať stavy `WAITING`, `LOCKED`, `NO SIGNAL`, `BYPASSED`, `STALE/RECALCULATE`,
- target loudness, measurement window, tolerance a compensation max musia byť definované,
- gain-match musí byť opt-in alebo mať jasný default podľa súčasného UX kontraktu,
- target change, stop/play, bypass, no signal, A/B recall a reset musia mať predvídateľné správanie,
- na obrazovke ukázať, keď kompenzácia nie je dôveryhodná alebo ešte nemá dáta.

Akceptácia: používateľ vie rozlíšiť „lepší zvuk“ od „hlasnejší zvuk“ bez level jumpu a bez trvalého prepísania pluginových parametrov.

### 8.4 Plugin-specific polish

**PRISM:** čitateľná spectral mapa, jasné active band state, zrozumiteľné preset/learn správanie a bezpečné defaulty.  
**VLYX:** progress/cancel pre analýzy, jasný delta/reference state, žiadny main-thread freeze.  
**VØID:** Blend Pad musí mať zrozumiteľný dry/wet priestor, IR loading stav, bezpečný reset a konzistentný pre-delay feedback.

Najprv sa opravuje navigácia, feedback a failure state; nové DSP tlačidlá sú až neskôr.

## 9. Fáza 4 — P1 mixer a macro performance

**Owner:** mixer agent  
**Súbory:** `src/ui/Mixer.tsx`, `src/ui/MacroPerformanceBar.tsx`, `src/ui/ModPanel.tsx`, command/mutation moduly, mixer CSS a testy

### Implementácia

- per-channel peak meter a clip indication napojiť na jednu existujúcu meter source,
- master zobrazuje peak/true-peak policy podľa reálneho audio merania; nemaľovať syntetický meter iba z gain hodnoty,
- mute/solo/bypass batch operácie musia byť atomické z pohľadu undo a collaboration,
- `+ ADD EFFECT` batch add/remove/bypass má mať jasný scope, potvrdenie iba ak je operácia deštruktívna a focus zostáva na novom prvku,
- keyboard flow: tab order, focused channel, delete/backspace safety, escape pre zatvorenie menu,
- macro target metadata musí definovať range, curve, polarity, default, label a či je target safe pre live performance,
- macro performance bar nesmie pri dragovaní preťažovať command stream; používať existujúci throttling/commit pattern.

### Akceptácia

- clip je vizuálne a zvukovo reprodukovateľný,
- batch operácia sa dá jedným undo vrátiť,
- macro drag je plynulý a po reload má očakávaný výsledok,
- žiadny náhodný solo/mute stav po preview, A/B recall alebo otvorení menu,
- testy pokrývajú single channel, multi-select, group/bus, master, keyboard a empty project.

## 10. Fáza 5 — P1 tvorivý workflow

### 10.1 Beat Focus

**Owner:** sequencer UX agent  
**Súbory:** `src/ui/Sequencer.tsx`, session/UI preference store, CSS a testy

Beat Focus už existuje. Nerobiť nový sequencer; overiť a dokončiť:

- persistenciu iba na správnej session/UI vrstve,
- shortcut, `aria-pressed`, focus return a escape/resize správanie,
- či overlay nezakrýva playhead, selection, p-lock alebo dôležité transport ovládanie,
- či pri otvorení pluginu/mixera nevzniká focus trap,
- či pri compact viewport nevzniká horizontálny overflow,
- či režim nezvyšuje bundle alebo neblokuje audio processing.

### 10.2 Zjednotený ideation flow

Existujúce DICE, Assist a Arrangement sa majú správať ako jeden mentálny model:

```text
DICE idea → Preview → Lock what works → Vary locally → Arrange into scene → Bounce/export
```

**Súbory:** `src/ui/DiceTray.tsx`, `src/ui/AssistPanel.tsx`, `src/ui/ArrangementPanel.tsx`, `src/intent/`, related commands/tests

- preview operácie pred potvrdením nesmú meniť projekt,
- `Vary`, `Fill`, `Replace` a `Build` musia mať jasný rozsah a jednu undo hranicu,
- locks pre drums/kick/snare/hats/bass musia byť viditeľné a rešpektované,
- seed musí byť reprodukovateľný pri rovnakom vstupe,
- preview diff musí používateľovi povedať, čo sa zmení,
- scene intensity a role flow musia rešpektovať export duration a tempo boundary.

Akceptácia: používateľ vie generovať nápady bez strachu, že stratí dobrú verziu, a vie sa z preview dostať k aranžmánu bez manuálneho kopírovania dát.

## 11. Fáza 6 — P1 persistence, recovery a backend

**Owner:** platform/collab agent  
**Súbory:** `src/persistence/*`, `src/export/project-io.ts`, `src/export/scorepack.ts`, `src/collab/*`, `server/collab-server.mjs`, testy recovery/collab

### Lokálny projekt a recovery

- dokončiť verifikáciu `SnapshotRepository` a `autosave-debouncer`,
- otestovať save during rapid edits, pagehide, reload, corrupted snapshot, quota/full storage a migration,
- jasne rozlíšiť saved, saving, offline, recovered a failed stav,
- project export/import musí zachovať audio-relevantný stav, plugin snapshots a potrebné seeds,
- pri recovery ponúknuť používateľovi voľbu, neprepísať ticho novšiu verziu.

### Collaboration/server hardening

Súčasný `server/collab-server.mjs` je jednoduchý in-memory server bez auth, s file-backed gallery a základným IP rate limitingom. Pred verejným launchom preveriť:

- limit počtu roomov a connections,
- limit veľkosti message/payload a bezpečné JSON parse failure,
- idle TTL a cleanup, aby memory rástla pod kontrolou,
- rate limit pre publish/play/report/delete operácie,
- observability: structured error log, room count, connection count, rejected payload count,
- gallery moderation/report/delete flow a privacy text,
- CORS/origin policy pre produkčné domény.

Neimplementovať účet, persistentnú DB ani veľký backend rewrite bez samostatného product/security rozhodnutia. Ak launch nemá verejnú collaboration/gallery, najprv feature vypnúť alebo držať za jasným feature flagom.

Akceptácia: malformed alebo príliš veľká request data nezhodí server, idle room sa uvoľní, rate limit je testovateľný a používateľ dostane zrozumiteľnú chybu.

## 12. Branding a release consistency

**Owner:** product/UI cleanup agent  
**Súbory:** verejné UI, `README.md`, `index.html`, landing/gallery copy, PWA metadata, relevantné testy

- odstrániť viditeľné zvyšky starej značky v používateľskom UI; aktuálne treba preveriť najmä `src/gallery/GalleryPage.tsx`, kde môže zostať `PF` brand mark,
- verejne zobrazované názvy musia byť KYX / PRISM / VLYX / VØID,
- ponechať interné compatibility názvy tam, kde ich vyžaduje schema, import, worklet alebo upstream build,
- title, manifest, install prompt, error boundary, gallery, embed a export metadata musia mať konzistentný public brand,
- starú terminológiu v technických interných dokumentoch prepisovať iba tam, kde by sa dostala k používateľovi alebo mýlila agenta.

Akceptácia: čistý grep verejných UI stringov nenájde nechcený starý brand a interné ID ostanú funkčné.

## 13. Agent ownership a sequencing

Agenti nemajú paralelne meniť tie isté centrálne súbory. Odporúčané rozdelenie:

| Agent              | Zodpovednosť                                         | Primárne súbory                                           | Odovzdáva                             |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| A — DSP/release    | PRISM, VLYX upstream, VØID, bounce                   | DSP/upstream, `src/rendering/*`, audio tests              | reprodukcie, testy, build artefacts   |
| B — instrument UX  | preset audition, Inspector Simple/Advanced, curation | `PresetBrowser`, `Inspector`, instrument metadata         | UI flow, undo/reload testy            |
| C — plugin UX      | shell, A/B, gain-match, plugin feedback              | effect UI, `EffectAbControls`, plugin CSS                 | shared contract, keyboard/focus testy |
| D — mixer/creative | mixer, macro, Beat Focus, DICE/Assist/Arrangement    | relevant UI + commands                                    | workflow testy a no-data-loss report  |
| E — platform       | persistence, recovery, collab/server limits          | `src/persistence`, `src/collab`, `server`                 | recovery/security testy               |
| F — release QA     | full gates, browsers, bundle, regression             | test config/report only; production edit iba po potvrdení | release matrix a blocker list         |

Odporúčané poradie:

```text
A baseline/audio → B preset audition → C plugin contracts → D mixer/workflow → E recovery/backend → F full release QA
```

Agent, ktorý musí meniť spoločný `commands.ts`, `AudioEngine.ts`, registry alebo globálne CSS, vopred uvedie kontrakt, dotknuté consumer paths a testy. Ostatní agenti na tento súbor nebudú súčasne aplikovať mechanické úpravy.

## 14. Test strategy

Každá implementácia musí mať primeraný dôkaz:

- **unit/integration:** serializácia, seed, DSP invariants, command/undo, migration, recovery,
- **component:** keyboard/focus, preview/apply/cancel, A/B, gain-match states, empty/error/loading states,
- **browser:** reálny click/keyboard flow, worklet load, audio start, responsive layout, reload,
- **render:** live/offline parity a export metadata,
- **performance:** main-thread analysis, audio callback allocations, bundle budget, rapid macro/drag edits,
- **security/robustness:** malformed import, oversized payload, rate limit, quota failure, missing asset.

Minimum test cases pre kritické flow:

| Flow           | Povinné stavy                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| Preset preview | play, stop, cancel, apply, fast switch, missing asset, reload                 |
| A/B            | empty, store, copy, clear, recall, undo, bypass, reload                       |
| Gain-match     | no signal, waiting, locked, stale, target change, stop/play, bypass           |
| Plugin shell   | collapse, bypass, preset, error, keyboard, resize, focus return               |
| Mixer          | meter, clip, mute/solo, batch, group, master, undo                            |
| Export         | empty, long project, tempo boundary, marker, float WAV, cancel, repeat render |
| Recovery       | rapid autosave, pagehide, corrupted snapshot, quota, migration                |

## 15. Release gates

Release candidate nesmie byť označený ako hotový, kým neprejde:

- `npm run typecheck:clean`,
- celý Vitest test suite bez nových failov,
- `npm run test:browser` alebo aktuálny browser script,
- `npm run build` vrátane worklet buildov a bundle budgetov,
- `npm run format:check` alebo zdokumentovaný presný zoznam existujúcich formatting deviations,
- produkčný audit bez high/critical vulnerability,
- Chromium smoke a manuálny Firefox/Safari/iOS smoke,
- new project → preset preview/apply → plugin chain → A/B/gain-match → mixer → export → reload flow,
- project export/import s PRISM/VLYX/VØID a automation/preset state,
- dva rovnaké exporty s rovnakým seed nastavením,
- overenie, že browser refresh ani tab close nevedú k tichej strate poslednej práce,
- overenie console, network a audio worklet logov v produkčnom builde.

Ak gate neprejde, report musí obsahovať: command, prvý error, reprodukčné kroky, impact, ownera a návrh, či ide o release blocker.

## 16. Explicitné non-goals pred release

- žiadny štvrtý flagship plugin,
- žiadne hromadné pridávanie nástrojov len kvôli počtu,
- žiadny full rewrite sequenceru, mixeru alebo audio engine,
- žiadny nový globálny state framework,
- žiadny AI/network dependency v kritickom create/play/export flow,
- žiadna priama úprava `src/effects/ultina-core/**`,
- žiadne masívne premenovanie interných priečinkov, ID alebo persistence schema,
- žiadny veľký Vite/Vitest/dependency migration tesne pred release,
- žiadne skryté runtime zmeny v audio leveloch kvôli „peknému“ A/B výsledku.

## 17. Agent completion report

Každý agent odovzdáva krátky report v tomto formáte:

```text
Scope:

Changed files:

Public behavior change:

Project-model/schema impact:

Audio live/offline impact:

Undo/autosave/collab impact:

Tests run + result:

Browser/manual checks:

Bundle/performance delta:

Known limitations or blockers:

Rollback plan:
```

Za hotové sa považuje iba zmena, ktorá má jasný scope, test, release impact a neporušuje invariants v kapitole 3.
