# Ultina — quality roadmap: odozva, prejav, modifikovateľnosť

> Stav dokumentu: 2026-09-05 (aktualizované po U1/U2/U5/P)  
> Hotové: U1 (commit a1b1ba0), U2 (6119e98), U5 (ab3bdb5), P-časť (48cc665). Zostáva: U3, U4, meters pooling, exciter tone, export/import presetov.  
> Scope: výhradne plugin **Ultina** (`src/effects/ultina-core` + `ultinaNode.ts` + `ultina-worklet.entry.js` + panel). FXEQ a Ozvena majú vlastné roadmapy.  
> Účel: vykonateľný plán „ako dotiahnuť Ultinu na world-class úroveň“ nad aktuálnym kódom, nie produktová vízia.

## Pracovný kontrakt

Agent musí:

- najprv prečítať tento dokument a overiť aktuálny worktree (`git status`, `git log --oneline -5`);
- **commitovať po každej dokončenej fáze** — v tomto worktree pôsobí (alebo pôsobilo) viac procesov naraz a zmeny boli už raz ticho vrátené; nebojovaná práca = stratená práca;
- rešpektovať vendored kontrakt: **žiadne priame editácie `src/effects/ultina-core/**`**. DSP zmeny idú do upstreamu `D:/VocalForge_DAW/plugins/ultina` a potom `node scripts/vendor-ultina.mjs && npm run build:ultina`. Host zmeny (registry/commands/engine/panel/wrapper) idú priamo do Pulse Forge;
- po každej DSP zmene spustiť `npx vitest run tests/ultina-vectors.test.ts` — golden vektory musia ostať bit-exact. Ak sa rmsΔ zmení, je to **zmena zvuku**: zastaviť, zdokumentovať prečo je predchádzajúce správanie nesprávne alebo zámerne nové, vektory regenerovať v upstreamu, až potom pokračovať;
- pre každú novú funkciu doplniť regresný test (existujúca infra: `tests/ultina-core-hardening.test.ts`, `tests/ultina-worklet-entry.test.ts`, `tests/ultina-extremes.test.ts`, `tests/ultina-parity.test.ts`);
- použiť existujúce vrstvy (commands → store → engine → worklet port), neobchádzať ich lokálnym React state;
- aktualizovať checkboxy až po dôkaze v teste/builde/smoke teste.

## Definition of Done

Roadmap je splnená, keď:

- každý automatovateľný Ultina parameter (`ALL_PARAMS` s `automatable: true`) ide napísať do automation lane a prežije offline export so správnym časovaním;
- ťahanie akéhokoľvek knotu v UltinaPanel znie plynule počas ťahu (žiadny commit-on-release „schod“);
- comp/transient majú oversampling a dry/wet mix je latencovo kompenzovaný — mix < 100 % necombuje;
- phase modul hlási latenciu, ktorú reálne zavádza, a host PDC ju kompenzuje;
- používateľ vie uložiť, premenovať, načítať a zmazať vlastný preset (local-first, prežije reload);
- všetky nové DSP správanie je pokryté testami, golden vektory sú buď bit-exact, alebo zdokumentovane regenerované;
- `npm run typecheck`, plný `npx vitest run`, `npm run build` (bundle budget) — všetko zelené.

## Aktuálny baseline (hardening pass 2026-09-05 — toto NEOPAKOVAŤ)

Hotové a testované (tests/ultina-core-hardening.test.ts, 20 testov + rozšírené entry/parity suitky):

- clipper knee > 6 dB produkuje monotonnú kompresiu, nie odpad (upstream fix + re-vendor);
- deep parametre ultina/fxeq/ozvena prežijú save→load (`normalizePluginParams` v `registry.ts`, zapojené v `normalizeEffects`, schema.ts);
- `applyUltinaPreset` / `applyUltinaProposal` / `applyFxEqPreset` validujú a clampujú každú hodnotu cez schema;
- ultina wrapper má `setParameterAt` → worklet `paramAt` fronta (časovaná aplikácia, cancel pri manuálnom zásahu, malformed-when fallback);
- AudioEngine automatizácia resolveuje track → group → return (`applyAutomation`, `scheduleTrackAutomation`, `scheduleDeviceAutomation`);
- auto-gain re-armuje startup delay pri disabled→enabled (žiadne integrácie proti starej LUFS);
- learn analyzery a MaskingMeter sú bez alokácií na audio threade; SpectralRegistry publikovanie je view-free a unregister čistí staleness záznamy;
- gate inverted-hysteresis, comp/gate crossover clampy, unmask sidechain bounds, EQ dynRatio clamp, mixAssistant/targetLibrary NaN sanitizácia.

Verifikačný baseline: `tsc` 0 chýb, plný vitest 1662 passed / 88 skipped (0 fail), build ~954/995 KB entry, ultina suitky 86/86 + 29/29 hardening+entry.

Slabiny, ktoré tento roadmap rieši (z kvalitatívneho auditu):

1. automatizačný povrch = len 7 rack parametrov (ModPanel číta `EFFECT_DEFS["ultina"].params`);
2. drag v paneli commituje až na release → počuteľné schody;
3. dynamika bez oversamplingu, dry/wet mix bez latencnej kompenzácie;
4. phase modul zavádza až 50 ms inter-channel delay bez hlásenia a bez vlastnej dry/wet kompenzácie;
5. žiadne používateľské presety (iba factory + A/B slot).

---

## Fáza U1 — Automatizačný povrch pre deep parametre (najväčší hodnotový skok)

**Cieľ:** „čokoľvek, na čo klikneš, ide natiahnuť v čase.“ ModPanel dnes ponúka fxParam targety len z registry rack zoznamu (`src/ui/ModPanel.tsx:97-102, 201`, `laneRange` z registry min/max na riadku ~139).

Postup:

- [x] Nový zdroj lane targetov pre flagship pluginy: `getAutomatableParamIds()` z `src/effects/ultina-core/contracts/parameterSchema.ts` (už existuje, filtruje `automatable`) → mapovanie na `{ id, name, min, max, unit }` z `ALL_PARAMS`/`PARAM_BY_ID`. Enum/boolean parametre sú väčšinou `automatable: false` — to je správny filter, nemeniť.
- [x] UI: target picker v ModPanel nesmie vykresľovať ~200 flatten položiek — zoskupiť podľa prefixu modulu (`eq.*`, `comp.*`, …), doplniť search input. Existujúci react-window je k dispozícii.
- [x] Lane hodnoty sú plain-unit (rovnaká doména ako `setUltinaParam`), clamp cez `clampUltinaParam` pri zápise bodu — žiadna normalizovaná divergencia medzi lane a panelom.
- [x] Runtime už funguje genericky: `applyAutomation`/`scheduleDeviceAutomation` posielajú ľubovoľné `paramId` do workletu, worklet `param`/`paramAt` akceptuje akýkoľvek id, `paramAt` aplikuje časovane (fáza hotová v hardeningu). Overiť a otestovať — engine zmena by nemala byť potrebná.
- [x] `.enabled` parametre v lane: každý bod musí spustiť graph re-sync — worklet to robí (`.endsWith(".enabled")` v oboch cestách vrátane `applyDueParams`). Testovať offline render s automation na `comp.enabled`.
- [x] Collab: lane s deep paramId prežije delta sync (id je string, žiadna schema zmena) — regresný test do `tests/collab-automation.test.ts`.

Akceptancia: lane na `eq.band3.gainDb` mení EQ počas prehrávania aj v offline exporte v správnych časoch; `npx vitest run tests/automation.test.ts tests/collab-automation.test.ts` zelené; nové UI testy pre picker.

## Fáza U2 — Live drag preview (commit-on-release → plynulý pohyb)

**Cieľ:** pocit z „software“ na „nástroj“. Dnes `Slider` (`src/ui/controls.tsx:15-52`) drží lokálny `dragValue` a pošle jeden command na pointer-up.

Postup:

- [x] Počas ťahu posielať **fire-and-forget port správy** priamo na runtime (`engine.getFxRuntime(trackId, fxId)` — doplniť accessor, ak nie je; runtime už má `setParameter` aj `setParameterAt`). Doc/command zápis ostáva na commite ako dnes — undo história sa nemení.
- [x] Throttle na rAF (max 1 správa/frame), hodnoty clampovať client-side cez `clampUltinaParam` (port nevaliduje).
- [x] Zvukový test: pri ťahaní (burst test v entry súpise) `global.outputGainDb` z −24 na 0 nesmie vzniknúť zipper nad slyšiteľnosť — worklet smoother (20 ms) to zahładzuje; overiť práve na najrýchlejšej možnej sekvencii správ.
- [x] Pozor na kolíziu s `paramAt` cancel-logikou: manuálny `param` počas ťahu zruší pending automation pre ten istý id — to je želané správanie, dokumentovať v teste.
- [x] Panel ↔ doc konzistencia: po commite sa `dragValue` zruší a prevzatie z doc nesmie skočiť (command hodnota = posledná drag hodnota).

Akceptancia: ťah počas prehrávania znie plynule v reálnom prehliadači; undo vráti presne jednu undoable zmenu; tests/ultina-worklet-entry.test.ts rozšírené o burst `param` správ (100 správ/block) — žiadna degradácia.

## Fáza U3 — Sonic transparency: oversampling dynamiky + kompenzovaný dry/wet

**Cieľ:** odstrániť aliasing vysokých pomerov kompresie a comb filtering pri mix < 100 %. **Toto je zámerne zmena zvuku** — platiť sa musí vektorovým postupom z pracovného kontraktu.

Postup (všetko upstream → re-vendor):

- [ ] Comp + transient: 2× oversampling detekčnej a gain cesty (skúsiť najprv len gain aplikáciu — detektor môže ostať base-rate, lacnejšie a metricky jednoznačné). Známe náklady: +latencia (reportovať cez `getLatency`, worklet ju už prepošle do PDC) a CPU (merať v `tests/ultina-extremes.test.ts` štýle).
- [ ] Každý multiband modul: dry vetva v mix stage delay-ovať o `getLatencySamples()` modulu (FIR 31 / OS 4 + nová OS latencia) — pattern: zdieľaný delay buffer v `MultibandProcessor`, nie 6× copy-paste. Overiť, že delta listen ostaň konzistentný (delta = processed − delayed dry).
- [ ] Meranie pred/po: render mix_50 vektor + own A/B render, zdokumentovať rmsΔ a posúvajúcu latenciu. Ak sa `mix_50_percent` vektor zmení, regenerovať upstream s justification komentárom v PR/commit správe.
- [ ] Perf gate: najhorší konfigurácia (všetky moduly, hybrid crossover, OS on, 96 kHz) musí ostať pod audio budgetom — rozšíriť `tests/ultina-extremes.test.ts` o wall-clock per block meranie.

Akceptancia: 10 kHz sine + ratio 20:1 comp nemá aliasing škálu (spektrálny test); mix 50 % sine necombuje (phase-coherent RMS ≈ unity pri passthrough module); vektory buď bit-exact, alebo regenerované so zdokumentovanou zmenou.

## Fáza U4 — Phase modul: latencná sémantika (design rozhodnutie)

**Cieľ:** prestať mlčať o 50 ms. Inter-channel offset sa nedá reportovať skalárom — treba rozhodnutie, nie patch.

Návrh sémantiky (upraviť pri implementácii):

- [ ] `getLatency()` vráti **spoločný** delay = max(delayL, delayR) aplikovaný obojma kanálmi; skutočný inter-channel rozdiel (time-shift param) ostáva nez-kompenzovaný — to je kreatívna funkcia modulu, nie defekt, a host PDC ju kompenzovať nemá.
- [ ] Vnútorná dry/wet a delta vetva modulu: dry delay-ovať o rovnaký spoločný delay (dnes comb). Time-shift offset nechať wet-only.
- [ ] All-pass z⁻¹ (1 sample pri rotation 0) — zohľadniť v spoločnom deleji alebo odstrániť pri rotácii 0 (bypass cesta).
- [ ] Dokumentovať v module hlavičke: čo host PDC kompenzuje a čo nie.
- [ ] X-correlation auto-align na audio threade (do ~523k MAC/block pri 512) — rozložiť lag-ov do viacerých blokov (round-robin 64 lags/block), search range via ring buffer naviac cez blok.

Akceptancia: `getLatencySamples()` != 0 s aktívnym phase modulom; PDC test (`tests/fx-node-latency.test.ts` pattern) pre ultinu s phase zapnutým; delta listen phase = čistý posun bez echa.

## Fáza U5 — Používateľské presety

**Cieľ:** uložiť/načítať/prehmatať/zmazať vlastný zvuk. Local-first, nie v project doc (analogia: `UserSampleRepository`).

Postup:

- [x] `UltinaPresetRepository` (IndexedDB, pattern `tests/persistence/UserSampleRepository.test.ts`): `{ id, name, params, createdAt, schemaVersion }`; load validuje každý kľúč cez `tryGetUltinaParamDef` + `clampUltinaParam`, neznáme id dropne (rovnaká disciplína ako `normalizePluginParams`).
- [x] UI v UltinaPanel: Save (menovaný), list react-window, rename, delete, overwrite-confirm. Preset select dnes renderuje len `FACTORY_PRESETS` (`UltinaPanel.tsx:779-797`) — zlúčiť zoznamy (factory sekcia + user sekcia).
- [x] Aplikácia ide existujúcim `applyUltinaPreset` commandom (undo zdarma, validácia zdarma).
- [ ] Export/import JSON (clipboard/file) — voliteľné, NEHOŤANÉ, ale lacné; pri importe plná validácia.
- [x] Nezávislosť od SCHEMA_VERSION projektu; vlastný `schemaVersion` pre budúce migrácie.

Akceptancia: uložený preset prežije reload prehliadača; načítanie corruptnutého JSON nespadne panel (error boundary pattern z panelu); tests/persistence rozšírené.

## Fáza P — P3 polish (kedykoľvek medzi fázami, neblokujú nič)

- [ ] Pooling `getMeters()` v 10 moduloch (pattern `unmaskModule.ts:526-536`) — ~3,4k allocs/s na 86 Hz poli odstránené; čisto mechanická zmena, vektory musia ostať bit-exact.
- [x] LufsMeter: „stale“ marking — stale guard v UltinaProcessor (unfed > 3 s → −70 do autoGain); plné meter marking NEHOŤANÉ, kým short-term window plne neprejde (doplňok k auto-gain re-arm fixu).
- [x] eqLearn/crossoverLearn: block-size-aware smoothing coef (`1 − exp(−frameCount/tauSamples)`); top bandy nad 0,45·sr odvodzovať pri `prepare()`.
- [ ] Exciter tone one-pole: coef z `sampleRate × (OS ? 4 : 1)` — **zmena zvuku pri prepnutí OS**, platiť vektorovým postupom.
- [x] EQ band gainDb defensive clamp ±24 v module (dnes až v schema).
- [x] `fxMetersEnabled` dead-key cleanup — pokryté paralelnou session v disposeTrackNodes/Group/Return.

---

## Verifikačný matrix (po každej fáze)

```bash
# upstream (VocalForge_DAW/plugins/ultina) — len pri DSP fázach U3/U4/P-DSP
node scripts/vendor-ultina.mjs
npm run build:ultina

# Pulse Forge
npx tsc --noEmit
npx vitest run tests/ultina-vectors.test.ts      # bit-exact, alebo zdokumentovaná regenerácia
npx vitest run tests/ultina-core-hardening.test.ts tests/ultina-worklet-entry.test.ts
npx vitest run tests/ultina-extremes.test.ts tests/ultina-parity.test.ts tests/ultina-soak.test.ts
npx vitest run                                   # plný suite pred commitom
npm run build                                    # bundle budget (entry 995 KB, chunks 2400 KB)
npm run test:browser                             # aspoň raz po U2 a U5 (reálny worklet)
```

Commit per fáza. Správa: `[ultina] U<n>: <čo>` + pri sonic zmenách explicitná veta „zmienia zvuk: <čo a prečo>“.

## Riziká a pravidlá

- **Concurrent-actor worktree:** zmeny už boli raz ticho vrátené. Commitovať často, pred prácou overiť `git status`.
- **Golden vektory sú kontrakt s VocalForge:** regenerácia len so zdôvodnením v upstream commite; Pulse Forge strana nikdy neupravuje `tests/ultina-vectors/` ručne (vendor script ich prepíše).
- **U3/U4 menia latenciu a zvuk:** vždy merané, nikdy „od oka“; soak test (300 s) musí ostať finite/drift-free.
- **Automatizačný povrch (U1) je API expanzia:** nové lane targety v collabe — otestovať delta round-trip predtým, než pôjde do produkčnej branche.

## Mimo rozsahu (vedomé rozhodnutia)

- WASM port DSP jadra — CPU je dnes pod budgetom, negatívny pomer nákladov/zisk.
- Nové moduly do grafu (saturation bus, transient-design tier 2) — samostatný produktový plán.
- Per-channel PDC kompenzácia time-shiftu — kreatívna funkcia, nie defekt (pozri U4).
- Zmeny FXEQ/Ozvena — majú vlastné roadmapy; cross-plugin patterny sa kopírujú, nie reimplementujú v tejto línii.
