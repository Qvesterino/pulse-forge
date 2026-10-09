# KOPA + KOREŇ — implementačný plán

**Stav:** návrh na implementáciu · **Aktualizované:** 2026-10-09
**Rozsah:** dva nové flagship výstupy — **KOPA** (kick designer, nový `InstrumentKind`) a **KOREŇ** (missing-fundamental bass exciter, nový core efekt).
**Predpoklad:** aktuálny strom (23 inštrumentov, 52 efektov, `SCHEMA_VERSION = 16`, TSAR T0–T7, ADR 0023 hotové).
**Nadväzuje na:** `docs/NEW-EFFECT-CHECKLIST.md` (povinný), ADR 0004 (AudioWorklet boundary), ADR 0003 (project model ↔ runtime), ADR 0023 (worklet lazy-load precedent), `docs/TSAR-IMPLEMENTATION-ROADMAP.md` (§ štýl fáz a brán), `docs/CURRENT-STATE.md` (jediný zdroj počtov).

> Pracovné mená: **KOPA** = slov. „kopa" (úder/kick), kód `kopa`. **KOREŇ** = slov. „koreň"
> (root — missing _fundamental_ = chýbajúci koreň), kód `bassHarmonic`. Mená sú návrh;
> pred UI implementáciou sa dajú zmeniť (rovnako ako TSAR „ORBIT" v R6). **ID v schéme
> (`kopa`, `bassHarmonic`) sa po shipnutí nemení.**

---

## 0. Prečo práve tieto dva a čo NErobiť

Gap analýza (2026-10-09, `INSTRUMENT_META` + `EFFECT_META` + roadmapy):

1. **Kick designer je jediná veľká diera v nástrojoch.** `drumsynth` kick je 8 parametrov
   (`src/instruments/definitions.ts:844-861`, model `src/instruments/registry.ts:6048-6077`):
   TONE = start pitch, BODY = drop time, SNAP = noise click, DECAY, DRIVE (jeden tanh).
   Existujú len **3 kick factory presety** (`factory.drumsynth.techno.punchkick` :5363,
   `factory.drumsynth.trap.longkick` :5381, `factory.drumsynth.techno.909kick` :6035). Naproti tomu
   808 má `punch / punchTime / knock / grit / click / sub / glide / distType(5) + mod matrix`
   (`definitions.ts:204-270`, DSP `registry.ts:985-1003`) — SubLab-úroveň.
2. **Bass harmonic processor neexistuje.** Máme `subOsc` + `monoBassFrequency` na bassBusse
   (`definitions.ts:1350-1378`) a chain „808 HARMONICS" (tapeSat+EQ, `src/effects/chains.ts:18`),
   ale žiadny frequency-tracked generátor chýbajúceho fundamentu (MaxxBass/R-Bass úloha).

**Nerobiť (duplicity, overené v kóde):**

- OTT / upward multiband — VLYX `density` už je upward compressor (`ultina-core/dsp/modules/densityModule.ts`).
- Sidechain carve — PRISM `sidechainMode` + 32-band `unmask`; PRÚD = dyn EQ.
- De-esser — `compressor` DE-ESS band-pass mód (`definitions.ts:798`).
- Gross Beat — beatMangler; vocal chop — vocalchop + pitchShift + vocoder.
- Ďalší hybridný synth — TSAR kryje rozsah.

**Poradie:** Fáza 1 = KOREŇ (menší diff, čisto efekt, dá sa shipnúť rýchlo a overiť infra pre
KOPA worklet). Fáza 2 = KOPA (nový instrument + práca so schémou + panel). Fáza 3 = obsah
(presety, role, AI routing, dokumentácia).

---

## 1. Spoločné pravidlá (platia pre OBE položky)

1. **DSP v AudioWorklete** (`AGENTS.md` §3.5). Žiadna per-sample syntéza na main threade.
2. **Offline cesta je súčasť hotového diela, nie fallback pre flagship.** Dve povolené
   architektúry podľa povahy práce:
   - **KOREŇ** je insert efekt (nie event-queue nástroj): DSP je deterministický z parametrov,
     worklet sa v offline kontexte vytvorí rovnako ako v live → **parita automaticky**.
     Parametre cez `AudioParam` descriptory + `safeApplyAudioParam` (M2 vzor
     `zenit-m2-nodes.ts`, `safeAudioParam.ts`) — `setValueAtTime` je súčasť render timeline,
     žiadne port správy. Worklet je lazy modul načítaný cez `ensureWorkletsForDoc`
     - honest 1:1 bypass fallback (`WORKLET_EFFECTS` "degraded").
   - **KOPA** je nástroj s `noteOn` udalosťami: offline musí dostať **predvyplnenú event queue**
     cez `processorOptions` (presne vzor TSAR `src/instruments/tsarNode.ts:292-300`, ADR 0023 bod 2).
     **Nepoužiť** `!offlineRenderContext()` gate — to je cesta pre `wtvoice` (rozdielny zvuk v exporte),
     pre flagship neprijateľná.
3. **`hashString` sa nemení** (seed stabilita, `tests/seed-stability.test.ts`). Nové seedy len
   novými id-prefixmi (vzor `fx-dsp-v1`).
4. **Všetky registračné povrchy** (`NEW-EFFECT-CHECKLIST.md` §11): union → META → ORDER →
   engine dispatch (pre efekt `EFFECT_DEFS`; pre nástroj `INSTRUMENT_DEFS`) → worklet loader.
5. **Worklet bundle gate** (`scripts/check-bundle-size.mjs`): každá nová DSP musí mať vlastný
   **budget riadok**; core worklet bundle je dnes **145 413 B / 150 KB** — KOREŇ tam ísť NESMIE
   (viď §3.2, vlastný modul = vlastný riadok, vzor TSAR).
6. **Presety bez meraného gainu neplatia.** Každý nový instrument preset prejde
   `npm run presets:loudness` (mapa `src/presets/preset-loudness.generated.ts`, gate
   `tests/preset-loudness-audit.test.ts`); každý nový FX preset prejde
   `npm run presets:fx-loudness` (`src/effects/preset-loudness.generated.ts`,
   `src/effects/presetLoudness.ts`). Clamp ±18 dB = fix family/level, nie cap.
7. **Determinizmus + dve kontroly**: (a) dva rendery toho istého projektu = bit-identické;
   (b) live vs offline parita — KOREŇ vstúpi do `PARITY_FX_EXCLUSIONS` len ak má pomenovaný
   free-running dôvod, inak musí prejsť null testom (`src/testing/live-offline-parity.ts`).
   KOPA: parita je `processorOptions` kontrakt, test ako `tests/tsar/engine.test.ts`.
8. **Každá viditeľná kontrola má merateľný účinok** — `NEW-EFFECT-CHECKLIST.md` §13;
   audítor `src/plugin-audit-checks.ts` (min AJ max musia pohnúť metrikou).
9. **`docs/CURRENT-STATE.md` v TOM ISTOM commite** — bumpnúť inštrumenty, efekty, presety,
   spec-file count; `npm run drift:check` musí byť zelený.
10. **Žiadna schema migrácia** — nové `EffectType`/`InstrumentKind` id je aditívne; `SCHEMA_VERSION`
    sa nemení (vzor: TSAR nepotreboval migráciu pre nový kind, len `sampleIdB` pridal samostatne).

---

## 2. FÁZA 1 — KOREŇ (`bassHarmonic`)

### 2.1 Produktová definícia

Frekvenčne sledovaný psychoakustický exciter, ktorý vygeneruje čitateľné harmonické z basového
fundamentu a oddelí ich od čistého subu. Účel: 808/sub funguje na telefónoch, AirPodsoch a
klubových PA bez straty tela; basová linka „prejde" aj v malých reproduktoroch.

**Nie je to** EQ ani saturácia: DSP sleduje fundament, syntetizuje 2. (a voliteľne 3.) harmonickú
**frekvenčne závisle**, a pôvodný sub necháva neporušený (`subAnchor`).

### 2.2 Parametre (návrh `ParamDef`, id stabilné)

| id          | label      | min   | max | default | format/taper | úloha                                           |
| ----------- | ---------- | ----- | --- | ------- | ------------ | ----------------------------------------------- |
| `drive`     | DRIVE      | 0     | 1   | 0.45    | pct          | hustota/sila generovaných harmoník              |
| `focusHz`   | FOCUS      | 40    | 220 | 90      | Hz, log      | stred tracking okna fundamentu                  |
| `harmonics` | HARMONICS  | 0     | 1   | 0.5     | pct          | pomer 2./3. harmonická (0=2nd, 1=3rd-lean)      |
| `subAnchor` | SUB ANCHOR | 0     | 1   | 0.7     | pct          | koľko originálneho subu zostane pod excitom     |
| `lowCut`    | LOW CUT    | 20    | 200 | 45      | Hz, log      | HPF pod ktorým sa už negeneruje (ochrana repro) |
| `range`     | RANGE      | 1     | 4   | 2       | oct integer  | rozsah generovania v oktávach nad fundamentom   |
| `attack`    | ATTACK     | 0.001 | 0.1 | 0.008   | s, log       | čas nábehu generátora (transient zachovaný)     |
| `release`   | RELEASE    | 0.01  | 1   | 0.12    | s, log       | čas uvoľnenia generátora                        |
| `mix`       | MIX        | 0     | 1   | 0.6     | pct          | dry/wet                                         |
| `output`    | OUTPUT     | -18   | 12  | 0       | dB           | trim                                            |

Poznámky:

- **Žiadny `sidechainTrackId`** — KOREŇ je vložený na basovej stope, kde signál je (modifikuje
  sa vlastný vstup). Sidechain by bol duplicitný s `sidechain`/`pump`; ak niekedy treba key
  z inej stopy, je to samostatná feature, nie v1.
- `range` ako `kind: "discrete"`, `step: 1`, options OCT×1..4 (vzor `BEATMANGLER_MODES`).
- Všetky format funkcie musia byť finite na celom rozsahu (`checkParamSurface`,
  `tests/plugin-functional-audit.test.ts:114`).

### 2.3 DSP (`src/audio-worklets/bass-harmonic-processor.js`)

Nový **samostatný** worklet modul (nie v core bundli — ten je na 145/150 KB). Vlastný build
script + vlastný budget riadok (vzor TSAR, `scripts/build-tsar-worklet.mjs` +
`TSAR_WORKLET_BUDGET_KB`).

**Algoritmus (per-sample, mono-sum detection, stereo generation):**

1. **Detektor fundamentu:** dva prekrývajúce envelope followery na spoločnom mono sume
   (fast ~3 ms / slow ~30 ms) → `envFast/envSlow`. Zero-crossing rate estimator (rovnaký
   princíp ako `bassbuss-sub-processor.js:53-63`, s hysteréziou ±0.01) udržiava odhad `f0`
   v okne `focusHz × [0.5, 2]` (mimo okna sa generátor tlmí — nezvyčajné frekvencie sa nechajú
   na pokoji, to je „honest" správanie).
2. **Generator:** fázový akumulátor `phase += 2π·(2·f0)/sr` (resp. 3× podľa `harmonics`
   mix pomeru) → `sin` s oknovou obálkou `gain = drive × envShape`; `attack/release` one-pole
   na obálku generátora (**per-sample koeficient!** — pasca „per-block constant" z checklistu §4).
3. **Sub anchor:** vstupný signál prejde one-pole HP na `lowCut` + gain `subAnchor`; generované
   harmonické sa pripočítajú **nad** touto vetvou (nie je to klasický dry/wet mix, ale
   „sub sa zachová, harmonické sa pridajú").
4. **Ochrany:** všetky stavové filtre flush pred uložením (checklist §4, precedent multitap-soak);
   žiadne alokácie v `process()`; `sanitizeSample` finálnych vzoriek.
5. **Determinizmus:** žiadny RNG. Rovnaký vstup → rovnaký výstup vzorka-po-vzorke.

**Fallback bez workletu (povinné):** `WORKLET_EFFECTS.bassHarmonic = "degraded"`; runtime vráti
**honest bypass 1:1** s `degradedReason: "AudioWorklet unavailable — bass harmonic bypassed"`.
Žiadna aproximácia, ktorá by predstierala činnosť (precedent `apeks/sirka/prud`).

### 2.4 Integrácia (presný zoznam súborov)

1. `src/project-model/types.ts` — do `EffectType` pridať `| "bassHarmonic"` (na koniec).
2. `src/effects/definitions.ts` — `bassHarmonicParams: ParamDef[]` (§2.2) + `EFFECT_META` záznam
   (`type: "bassHarmonic", name: "KOREŇ", category: "character"`); pridať do `EFFECT_ORDER`
   aj `CORE_EFFECT_ORDER` (mixér Add Effect).
3. `src/effects/registry.ts` — `bassHarmonic: EffectDefinition` s factory:
   `isWorkletReady("bassHarmonic", ctx) ? createBassHarmonicNode(ctx, instance) : bypassRuntime(...)`;
   `WORKLET_EFFECTS.bassHarmonic = "degraded"`; pridať do `EFFECT_DEFS`.
4. `src/audio-worklets/bass-harmonic-node.ts` — node wrapper. **Odporúčaný vzor: M2 pattern**
   (`src/audio-worklets/zenit-m2-nodes.ts:14-86` + `safeAudioParam.ts`): deklarovať **AudioParam
   descriptory** pre všetky parametre s rovnakými rozsahmi ako `EFFECT_META` a písať cez
   `safeApplyAudioParam(node, id, value, when)`. Prečo toto a nie port messages:
   - **offline automation funguje natívne** — `setValueAtTime` je súčasť render timeline,
     žiadne `paramAt` port správy (ktoré Chromium počas `startRendering()` nedoručuje a
     vyžadujú `processorOptions` queue) — presne preto APEKS/ŠÍRKA/PRÚD nepotrebujú žiadnu
     offline machinériu;
   - **descriptor pin zdarma** — `tests/param-range-coherence.test.ts` FULL SWEEP pinuje
     `desc.min ≤ def.min && desc.max ≥ def.max` pre každý spoločný id (pridať riadok do
     `EFFECT_PROC_PAIRS`);
   - `safeApplyAudioParam` blokuje non-finite (spec by inak hodil TypeError a zabil sync).
     Fallback: `degraded` 1:1 bypass (vzor `makeStereoWorkletRuntime` + `WORKLET_EFFECTS`).
5. `src/audio-worklets/bass-harmonic-processor.js` — DSP (§2.3),
   `registerProcessor("bass-harmonic-processor", …)` + `src/audio-worklets/bass-harmonic-worklet.entry.js`
   tenký entry (import procesora; vzor `src/effects/*-worklet.entry.js`), ktorý build skript
   bundluje do `public/bass-harmonic-worklet.js`. **Nutný `bass-harmonic-processor.d.ts` stub**
   (`export {};`, house pattern `apeks-processor.d.ts`) — plain-JS procesor importovaný z TS
   testov by inak neprešel `tsc --noEmit` (`allowJs` nie je zapnutý).
6. `src/audio-worklets/loader.ts` — **odporúčanie: rozšíriť `PLUGIN_WORKLET_TYPES` o `"bassHarmonic"`**
   (+ `PLUGIN_MODULE_URLS.bassHarmonic = assetUrl("/bass-harmonic-worklet.js")`). Dôvody:
   - `pluginTypesInDoc` (loader.ts:265) skenuje typy efektov voči `PLUGIN_WORKLET_TYPES` →
     `ensureWorkletsForDoc` ho načíta **len keď ho projekt používa** (live aj renderer);
   - `AudioEngine.ts:1080` hot-swap fallback→worklet je viazaný na ten istý zoznam → funguje
     bez ďalšej zmeny enginu;
   - `scripts/measure-fx-preset-loudness.mjs:171` načíta `PLUGIN_WORKLET_TYPES` → meranie
     prejde bez úpravy skriptu.
     Názov „PLUGIN" je pri first-party efekte mierne zavádzajúci — **riešenie: premenovať na
     `LAZY_WORKLET_TYPES` v samostatnom čisto-mechanickom commite** (grep-and-rename naprieč
     loader/engine/skripty/testy), aby aditívna vlna nebola zamiešaná s rename difom.
     Alternatíva (nový `LAZY_CORE_WORKLET_TYPES`) znamená dotknúť sa 4 miest (loader scan,
     engine hot-swap, loudness skript, `loadAllWorklets`) — viac priestoru na chybu za krajší názov.
     **Rozhodnutie + dôsledky zapísať do ADR (viď §5).**
7. `scripts/build-bass-harmonic-worklet.mjs` — esbuild bundle `public/bass-harmonic-worklet.js`
   (vzor `build-tsar-worklet.mjs`).
8. `package.json` — `build:bassHarmonic`; pridať do `predev`/`prebuild` reťaze.
9. `scripts/check-bundle-size.mjs` — vlastný budget riadok `BASS_HARMONIC_WORKLET_BUDGET_KB = 24`
   s komentárom prečo + kontrola „missing file" (vzor TSAR riadok `:341-355`).
10. `src/effects/presets.ts` — aspoň 4 presety (`CORE_EFFECT_PRESETS`), napr.
    „808 Phone" (drive .7, focus 70, subAnchor .8), „Club Sub" (drive .35, focus 110),
    „Drill Growl" (drive .8, harmonics .7, lowCut 55), „Subtle Body" (drive .25, mix .35);
    `presetsForEffect` gate `tests/fx-catalog.test.ts` vyžaduje **≥2 presety** a blurb ≤80 znakov.
11. `src/effects/blurbs.ts` — jedna veta: „Adds readable bass harmonics so subs carry on phones and small speakers".
12. `src/effects/chains.ts` — voliteľne chain „BASS PHONE READY" (bassHarmonic + eq-air) — až po
    presety; nie je povinné pre v1.
13. `src/effects/role-presets.ts` — rola `bass` tabuľka (vzor `tapeSat.bass`) — povinné, inak
    „auto role preset" pre basovú stopu KOREŇ neponúkne.
14. `src/ui/effectEditorRegistry.ts` — `primaryParamIds: ["drive", "focusHz", "subAnchor", "mix"]`
    (first-view kontrola).
15. `src/intent/mix.ts` — `EFFECT_KNOB.bassHarmonic = "drive"` + `EFFECT_WORDS` regex
    (`/\bbass.?harmon|\bkoren/` → `bassHarmonic`) pre intent parser (SK/EN).
16. `tests/param-range-coherence.test.ts` (`EFFECT_PROC_PAIRS`) a
    `tests/plugin-functional-audit.test.ts` (`WORKLET_CASES`) — pridať záznam
    `["bassHarmonic", "bass-harmonic-processor"]`; descriptor bounds musia pokrývať def rozsahy
    (`desc.min ≤ def.min && desc.max ≥ def.max`) — **povinné** pre `param-range-coherence` FULL SWEEP.
    (`src/plugin-audit-checks.ts` je browser audit tool, nie vitest — riadime sa testmi, ktoré
    vitest skutočne spúšťa.)
17. Testy (viď §2.5) + `docs/CURRENT-STATE.md` bump (efekty 52 → 53).

### 2.5 Testy Fázy 1

| Súbor                                                | Čo pinuje                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/bass-harmonic.test.ts`                        | factory vytvorí runtime; default params finite a audible; clamp NaN→default; fallback = `degraded` + 1:1; **unit**: 55 Hz sine in → výstup má viac energie pri 110 Hz (Goertzel) pri `drive` max; pri `drive=0` je 2H energia ≤ vstup; `subAnchor=0` utlmí fundament; `lowCut` HPF merateľne zmení spektrum pod prahom; `mix=0` = presný passthrough (bit-identický dry). |
| `tests/bass-harmonic-golden.test.ts`                 | dva rendery tej istej konfigurácie = bit-identické; 3 rendery bez ping-pong; determinizmus pri `focusHz` mimo okna (nič sa negeneruje).                                                                                                                                                                                                                                   |
| `tests/param-range-coherence.test.ts` (rozšírenie)   | def↔descriptor bounds (riadok v `EFFECT_PROC_PAIRS`).                                                                                                                                                                                                                                                                                                                     |
| `tests/plugin-functional-audit.test.ts` (rozšírenie) | `WORKLET_CASES` záznam; min AJ max hýbu meranou metrikou.                                                                                                                                                                                                                                                                                                                 |
| `tests/fx-catalog.test.ts` (auto)                    | blurb + ≥2 presety + presety v rozsahoch — prejde, keď §2.4 body 10-11 sedia.                                                                                                                                                                                                                                                                                             |
| `npm run presets:fx-loudness`                        | vygeneruje `FACTORY_FX_PRESET_GAIN_DB` pre nové presety; pri `PLUGIN_WORKLET_TYPES` rozšírení prejde bez úpravy skriptu (vid §2.4 bod 6).                                                                                                                                                                                                                                 |
| `npm run test:browser`                               | reálne prehratie KOREŇ v reťazci: efekt znie, meter sa hýbe, determinizmus; **musí bežať s `loadAllWorklets`** (checklist §6).                                                                                                                                                                                                                                            |
| `npm run drift:check`                                | count bump + `param-math.json` golden (defaults/clamp) pre nový typ sa pregeneruje `npm run goldens:capture` → skontrolovať diff → `drift:bless`.                                                                                                                                                                                                                         |

**Brána Fázy 1:** všetky vyššie zelené; `npm run build` zelený (entry/worklet budgety);
`npm run typecheck`, `format:check`, `test:expectations`.

---

## 3. FÁZA 2 — KOPA (`kopa`)

### 3.1 Produktová definícia

Dedikovaný kick designer na úrovni Kick 2 / BigKick / Punchbox, ale s KYX-špecifickou
výhodou: **jeden nástroj pod jednou strechou s 808/mixom/exportom**, deterministický a
key-tracked na ladenie s 808.

**Zvuková architektúra (vrstvy, každá nezávislá):**

- **PITCH** — pitch envelope: `pitchAmount` (0–48 st), `pitchTime` (5–200 ms), `pitchCurve`
  (exp/lin/snap/hold), `keyTrack` (0 = fixný na tón C, 1 = ladený na MIDI notu, aby kick ladil s 808).
- **CLICK** — transient: `clickType` (noise / HP-noise / sine / impulse), `clickTone` (300–9000 Hz),
  `clickDecay` (0.2–20 ms), `clickLevel`.
- **BODY** — telo: `bodyTune` (±24 st), `bodyDecay` (30 ms–2 s), `bodyHollow` (2. harmonická mix),
  `bodyWave` (sine/triangle/saw mix) — „punch" moderného trapu.
- **TAIL** — chvost: `tailDecay`, `tailLevel`, `tailTune` — dlhý 808-style kick (drill).
- **SUB** — fázovo locknutý sub pod fundamentom: `subLevel`, `subTune`; deterministické,
  mono (fáza z hlavného oscilátora, žiadny voľný oscilátor → žiadny drift).
- **CHARACTER** — `drive` (0–1) + `driveType` (Soft/Tube/Hard/Fold — 4 z 5 kriviek, ktoré už
  existujú pre 808, `registry.ts:985-1003`), `punch` (compressor-ish glue na celý voice),
  `stereo` (width; kick je default mono).
- **Glue/OUT:** `level` (dB).

### 3.2 DSP — rozhodnutie: worklet s event queue (nie native graf)

**Prečo worklet a nie native graf:** fázovo locknutý sub, 4-krivkový per-voice shaper,
presný pitch envelope s krivkami a deterministický offline render potrebujú per-sample prácu.
Native graf by vyžadoval stovky nódov na voice a nevie „hold" krivky.

**Kritická architektúra (ADR 0023 pattern, `NEW-EFFECT-CHECKLIST.md` §5):**

- `src/kopa/dsp/kopaProcessor.ts` — typované, vitest-testovateľné jadro (precedent
  `src/tsar/dsp/tsarProcessor.ts`). **Max 16 hlasov**, oldest-steal, per-voice envelope/shaper.
- `src/kopa-worklet.entry.js` — tenký wrapper (vzor `src/tsar-worklet.entry.js`): port + block loop,
  `processorOptions = { params, events }`; **live = port, offline = predvyplnená queue**,
  jeden `applyEvent` interpret.
- `src/instruments/kopaNode.ts` — runtime bridge (vzor `src/instruments/tsarNode.ts`):
  - live: `AudioWorkletNode("kopa-processor")` hneď, `noteOn` → `port.postMessage` s `when`.
  - offline: buffer eventov + `prepareOfflineRender()` → vytvorí node s `processorOptions.events`
    (bez tohto Chromium v offline renderi port správy nedoručí — `tsarNode.ts:10-23`).
- **Fallback bez workletu (povinný, audible, nie ticho):** reálny natívny kick voice
  (osc + pitch ramp + noise click + waveshaper) — vzor `createTsarFallbackRuntime`
  (`tsarNode.ts:69`), aby jsdom graph audit a pred-worklet prostredie nevideli mŕtvy graf.
- **Lazy load:** `INSTRUMENT_WORKLET_TYPES` rozšíriť o `"kopa"`; `instrumentWorkletTypesInDoc`
  (scan `track.instrument`) + `loadInstrumentWorklet(ctx, "kopa")` + `AudioEngine.queueKopaWorkletLoad`
  (vzor `AudioEngine.ts:872-893` — fallback→worklet hot-swap pri `setProject`).
- **Budget:** `public/kopa-worklet.js` vlastný riadok `KOPA_WORKLET_BUDGET_KB = 32`
  (16 hlasov, jednoduchšie než TSAR; TSAR má 48 pri ~22 KB reálne — nechajme 32 ako strop).

### 3.3 Parametre (návrh; id stabilné; `modMatrixParams(false, {cutoff:false})` na koniec)

`PITCH`: `pitchAmount` 0–48 st (default 24), `pitchTime` 5–200 ms log (40), `pitchCurve`
0–3 exp/lin/snap/hold (0), `keyTrack` 0/1 (1).
`CLICK`: `clickType` 0–3 (0), `clickTone` 300–9000 Hz log (2500), `clickDecay` 0.2–20 ms log (3),
`clickLevel` 0–1 (0.35).
`BODY`: `bodyTune` −24–24 st (0), `bodyDecay` 0.03–2 s log (0.35), `bodyHollow` 0–1 (0.25),
`bodyWave` 0–2 sin/tri/saw (0).
`TAIL`: `tailDecay` 0.05–3 s log (0.4), `tailLevel` 0–1 (0.25), `tailTune` −24–24 st (0).
`SUB`: `subLevel` 0–1 (0.3), `subTune` −12–12 st (0).
`CHARACTER`: `drive` 0–1 (0.25), `driveType` 0–3 Soft/Tube/Hard/Fold (0), `punch` 0–1 (0.2),
`stereo` 0–1 (0).
`OUTPUT`: `level` −24–6 dB (−6).
`MOD MATRIX`: ENV/LFO/VEL/PRESS → AMP (`modMatrixParams(false, { cutoff: false })` — KOPA nemá
filter, takže CUTOFF nesmie byť v dropdown options; precedent vocalchop, `definitions.ts:841`).

Poznámka k menu: **`SIMPLE_PARAM_IDS` v `src/ui/Inspector.tsx:60`** = hobby (simple) view;
KOPA záznam: `["pitchAmount", "pitchTime", "clickLevel", "bodyDecay", "tailDecay", "drive", "level"]`
(plný view je default, keď záznam chýba — `Inspector.tsx:185` — takže záznam je optimalizácia, nie povinnosť).

### 3.4 Integrácia (presný zoznam súborov)

1. `src/project-model/types.ts` — `InstrumentKind` + `| "kopa"`.
2. `src/instruments/definitions.ts` — `kopaParams`, `INSTRUMENT_META.kopa`, `INSTRUMENT_ORDER` na koniec.
3. `src/instruments/registry.ts` — `const kopa: InstrumentDefinition = { kind: "kopa", name: "KOPA", params: kopaParams, factory(ctx, track, env) { … createKopaRuntime / createKopaFallbackRuntime } }` + `INSTRUMENT_DEFS.kopa`.
4. `src/kopa/dsp/kopaProcessor.ts` — DSP jadro (typed, žiadny DOM; rovnaký kontrakt ako `tsarProcessor.ts`).
5. `src/kopa-worklet.entry.js` — wrapper + `registerProcessor("kopa-processor", …)`.
6. `src/instruments/kopaNode.ts` — runtime bridge s `prepareOfflineRender`.
7. `scripts/build-kopa-worklet.mjs` + `package.json` (`build:kopa`, predev/prebuild).
8. `src/audio-worklets/loader.ts` — `INSTRUMENT_WORKLET_TYPES` + `"kopa"`, `INSTRUMENT_MODULE_URLS.kopa = assetUrl("/kopa-worklet.js")`.
9. `src/audio-engine/AudioEngine.ts` — `queueKopaWorkletLoad` vedľa `queueTsarWorkletLoad` (volanie v `ensureContext` a `setProject`); zvážiť zovšeobecnenie na `queueInstrumentWorkletLoad(ctx, doc)` pre oba (kód hygiene — jeden helper, nie copy-paste; ak sa to dotkne TSAR, spraviť samostatný commit pred KOPA).
10. `src/project-model/schema.ts` — `INSTRUMENT_NAMES.kopa = "Kopa"` (musí sedieť s `INSTRUMENT_META`; `normalizeProject` lečí neznáme kindy — `schema.ts:1442` — takže staré projekty sú v bezpečí, ale nový kind musí byť v NAME mape, inak padne `createInstrumentTrackModel`).
11. `src/integrations/audiotool-nexus/mapping.ts` — `DEFAULT_GM_PROGRAM_BY_INSTRUMENT.kopa = 38` (bass drum program) — inak typecheck padne pri `Record<InstrumentKind, number>`.
12. `src/ui/TrackTabs.tsx` — `KIND_BADGE.kopa = "KPA"` + `<option value="kopa">` v add-track menu.
13. `src/ui/Inspector.tsx` — `SIMPLE_PARAM_IDS.kopa` (§3.3).
14. `src/ui/FloatingPlugin.tsx` — `HOBBY_PARAMS.kopa` (voliteľné, má default fallback = všetky).
15. `src/instruments/randomize.ts` — `EXCLUDE.kopa = ["subTune", "bodyTune", "tailTune"]`? nie — tune nechať randomizovať v deep mode; skôr `EXCLUDE` nedávať, ale `NEVER_RANDOMIZE` už kryje level/gain.
16. **Ďalšie `InstrumentKind`-viazané povrchy (dohľadané `rg`):**
    - `src/embed/energy.ts:34` — `DRUM_KINDS = new Set(["drum", "drumsynth"])` → pridať `"kopa"`
      (embed energy analýza inak kick v embed prehrávači nepočíta ako bubon).
    - `src/rendering/stems.ts:14-19` — stem kategórie; rozhodnúť, či KOPA patrí do „drums" stemu
      (áno, ak je to jediný kick nástroj na stope) — pridať filter.
    - `src/intent/exact.ts:103` — `[/\bdrum ?synth\b/i, "drumsynth"]` — pridať `[/\bkopa\b|\bkick ?design/i, "kopa"]`.
    - `src/mcp/tools.ts:2331` — fallback `"analog"` pre neznámy kind; KOPA je v `INSTRUMENT_DEFS`,
      takže MCP `kyx_catalog`/track-add ho uvidí automaticky.
    - `src/effects/sourceProfiles.ts:168` — 808/bass/logdrum → bass source profil; KOPA **nie je**
      bass (je to kick), takže sem nepatrí — explicitne overiť, že default profil sedí.
17. **Presety:** `src/presets/kopa-factory.ts` (nový súbor, ~16 presetov: techno punch, trap long,
    drill knock, phonk clipped, house thump, 909 clean, jersey clicky, dnb tight, dub weight,
    hyperpop snapped, ambient soft, boombap dusty, amapiano log, trance steady, detroit funk, hardstyle reverse-bass);
    zaviesť do `FACTORY_PRESETS` (eager, lebo drumsynth presety sú eager `factory.ts:5365`).
18. `src/presets/catalog.ts` — `inferUseCase` má `drumsynth → drums`; **KOPA je tiež drums role**
    (bass-role inštrumenty idú na `bass` plateau; kick nie je bass — pridať `if (preset.instrument === "kopa") return "drums";` pred bass check? — pozor, `inferUseCase` kontroluje `["bass","808","logdrum"]` pred drumsynth riadkom; kopa tam nie je, takže spadne na tokeny; explicitný `kopa → drums` riadok je potrebný **pred** token fallbackom, inak ho tokeny „kick" pošlú do neznáma).
19. `src/presets/factory-loader.ts` — nič (KOPA presety eager, nie pack).
20. Testy: viď §3.5.
21. `docs/adr/0035-kopa-kick-designer.md` (viď §5).
22. `docs/CURRENT-STATE.md` — inštrumenty 23 → 24, presety bump, spec count bump.

**Caveat k loudness meraniu (TSAR precedent, vedomé rozhodnutie):** `scripts/measure-preset-loudness.mjs`
zámerne neloaduje žiadne worklet moduly (meria deterministický natívny offline graf) — TSAR presety
sú v mape merané cez **jeho natívny fallback**. Pre KOPA to znamená to isté: gain map meria fallback,
nie worklet engine. V1 odporúčanie: **prijať precedent** (fallback je reálny kick voice, nie bypass;
live worklet cesta má vlastnú audibility kontrolu v `browser-checks.ts` „live worklet-path audibility"),
ale toto **explicitne zapísať do ADR 0035** ako známy kompromis + alternatívu (harness update, ktorý
pre KOPA načíta `loadInstrumentWorklet` + `prepareOfflineRender`) nechať na samostatnú vlnu.

### 3.5 Testy Fázy 2

| Súbor                                         | Čo pinuje                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/kopa/engine.test.ts`                   | DSP jadro: 16 hlasov voice-steal (najstarší); `noteOn` → `pitchAmount` mení priebeh pitch rampy (známy vstup → známa frekvencia v čase); `keyTrack=1` pri notách C1/C2 → fundament 2× (Goertzel); `subLevel` pridá energiu pod fundamentom; `driveType` 4 krivky menia THD merateľne; **bit-identický live-port vs offline-queue** (presne ako `tests/tsar/engine.test.ts`). |
| `tests/kopa/offline-parity.test.ts`           | `renderProject` s KOPA stopou dvakrát = bit-identické; `prepareOfflineRender` nasadí queue pred `startRendering`.                                                                                                                                                                                                                                                            |
| `tests/kopa/fallback.test.ts`                 | Bez workletu (jsdom / bez modulu) je runtime **audible**, nie ticho (`instrument-graph-reachability` auto-pokryje); fallback nesmie tvrdiť `degraded` ako ticho.                                                                                                                                                                                                             |
| `tests/kopa-presets.test.ts`                  | Každý preset: params v rozsahoch, každý počuteľný (peak > floor, finite), žiadny duplikát id, `inferUseCase → drums`.                                                                                                                                                                                                                                                        |
| `tests/instrument-definitions.test.ts` (auto) | nový kind prejde (META/ORDER/registry identita).                                                                                                                                                                                                                                                                                                                             |
| `tests/parity-obligation.test.ts` (auto)      | KOPA buď prejde parity corpus, alebo má pomenovanú exklúziu (KOPA by mala prejsť — deterministická, bez free-running fázy).                                                                                                                                                                                                                                                  |
| `npm run test:browser:factory-presets`        | `auditFactoryPresetAudio` enumeruje dynamicky → automaticky zahrnie nové KOPA presety (298 → +16).                                                                                                                                                                                                                                                                           |
| `npm run presets:loudness`                    | meranie a gain map pre KOPA presety (drum family = drums plateau).                                                                                                                                                                                                                                                                                                           |
| `npm run test:browser`                        | reálny Chromium: KOPA track hrá, worklet sa lazy-načíta len keď je KOPA v projekte, export znie ako playback.                                                                                                                                                                                                                                                                |

**Brána Fázy 2:** všetko zelené + E2E smoke (`npm run test:e2e:smoke`), build, budgety;
KOPA worklet reálne zmeraný a zapísaný (nie odhad).

---

## 4. FÁZA 3 — obsah a dokončenie

1. **Intent/AI routing:** `FAMILY_INSTRUMENTS` v `src/intent/preset-intent.ts:48` — KOPA patrí
   do `drums`? (family je bass/chords/lead; kick nie je v žiadnej) — rozhodnúť: buď pridať
   `drums` family (a napojiť na dice/kit), alebo KOPA explicitne mimo preset-intent rodín
   (jednoduchšie a čestnejšie pre v1). Zdokumentovať v ADR.
2. **MCP surface:** `kyx_catalog` (`src/mcp/tools.ts:4742`) enumeruje `INSTRUMENT_DEFS` →
   KOPA sa objaví automaticky; skontrolovať, že `EFFECT_KNOB` má `bassHarmonic` a že
   `kyx_effect` tool funguje (test `tests/mcp-tools.test.ts`).
3. **MCP mirrors:** po akomkoľvek zásahu do tool surface `npm run gen:mcp-mirrors` + commit
   (mirror test to vynúti).
4. **Dokumentácia:** README sekcia nástrojov + KOREŇ v efektoch; `docs/CURRENT-STATE.md` finálne
   čísla; `docs/ROADMAP.md` odkaz (nová stratégia nepatrí do starých roadmap).
5. **Voliteľne** (až po dátach): chain „BASS PHONE READY", KOREŇ v `role-presets` pre `drums`
   stopu (kick bus), KOPA ikona/badge, template starter s KOPA stopou.
6. **Voliteľná 3. harmonická / formant** pre KOREŇ a **clickType 4 (impulse-train)** pre KOPA
   sú **mimo v1** — samostatná vlna po dátach (držať v1 malé a dokončené).

---

## 5. ADR a dokumentačné povinnosti

- **ADR 0035 — KOPA kick designer** (pred implementáciou Fázy 2): prečo nový instrument (nie
  rozšírenie drumsynth), prečo worklet s event queue, prečo lazy instrument modul, čo je
  fallback, aký je budget, prečo žiadny schema bump, a **zapísaný kompromis loudness merania**
  (fallback vs worklet cesta, §3.4 caveat).
- **ADR 0034 — KOREŇ bass harmonic exciter:** rozhodnutie použiť M2 AudioParam pattern (nie port
  messages), rozšírenie lazy worklet zoznamu o first-party efekt (+ plánovaný rename na
  `LAZY_WORKLET_TYPES` v samostatnom commite), dôsledky pre `check-bundle-size`
  a `ensureWorkletsForDoc`, a prečo žiadny schema bump.
- **CURRENT-STATE bump** v každej fáze (inštrumenty 23→24, efekty 52→53, presety, spec files).
- **NEW-EFFECT-CHECKLIST.md** prejsť bod po bode v PR popise (dôkaz, nie tvrdenie).

---

## 6. Sekvencia commitov (každý samostatne zelený)

```text
FÁZA 1 (KOREŇ)
  chore(loader): rename PLUGIN_WORKLET_TYPES -> LAZY_WORKLET_TYPES (mechanický, ak ADR schváli)
  chore(loader): lazy core worklet seam — bassHarmonic v lazy zozname + budget riadok
  feat(fx): bassHarmonic DSP worklet + golden testy
  feat(fx): KOREŇ registrácia, node wrapper (M2 AudioParam), fallback, blurb
  feat(fx): KOREŇ presety + role preset + fx-loudness meranie
  docs: KOREŇ CURRENT-STATE + ADR 0034

FÁZA 2 (KOPA)
  refactor(audio-engine): queueInstrumentWorkletLoad zovšeobecnenie (TSAR + KOPA)
  feat(kopa): DSP jadro + worklet entry + offline event queue
  feat(kopa): registrácia naprieč povrchmi (union/META/ORDER/schema/badges/menu)
  feat(kopa): natívny fallback voice
  feat(kopa): 16 factory presetov + loudness meranie
  feat(ui): KOPA inspector/hobby view + add-track
  test(browser): KOPA lazy-load + live/offline parita
  docs: ADR 0035 + CURRENT-STATE
  chore: drift:bless, gen:mcp-mirrors, finálny sweep
```

Každý commit: `npm run typecheck && npm run test && npm run format:check` lokálne;
pred merge gate tabuľka z `AGENTS.md` §6.

---

## 7. Riziká a mitigácie

| Riziko                                                                                             | Mitigácia                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| KOPA pitch envelope „per-block constant" pasca (checklist §4)                                      | per-sample koeficienty, golden test na priebeh rampy v čase                                                                |
| KOPA offline ticho (checklist §5)                                                                  | `processorOptions.events` + test bit-identity live vs offline (nie `!offline` gate!)                                       |
| KOREŇ detektor fundamentu na polyfonickom/pulznom vstupe (kick+808 súčasne)                        | tracking okno + „mimo okna ticho" (honest), test s poly signálom; ak nevie, generátor sa utlmí — žiadne falošné harmonické |
| Core worklet budget (145/150 KB)                                                                   | KOREŇ aj KOPA idú lazy vlastnými modulmi s vlastnými budget riadkami; core bundle sa nedotkneme                            |
| `Record<InstrumentKind,...>` typecheck vlny (mapping.ts, INSTRUMENT_NAMES, KIND_BADGE, badge mapy) | presný zoznam povrchov v §3.4; `tsc` ich odhalí — prejsť `rg "Record<InstrumentKind"` pred PR                              |
| Loudness gate padne na nové presety                                                                | meranie hneď po presetoch (`presets:loudness` / `presets:fx-loudness`), clamp ±18 dB = fix family, nie cap                 |
| Preset gate „každý inštrument má preset"                                                           | KOPA presety v tom istom commite ako registrácia (test `plugin-functional-audit.test.ts:587`)                              |
| Drift gate (param-math golden, count rows)                                                         | `npm run goldens:capture` → skontrolovať diff → `drift:bless` v tom istom commite                                          |
| Multi-agent shared tree                                                                            | commitovať po každej fáze; stage len vlastné cesty (`AGENTS.md` §7)                                                        |

---

## 8. Definícia done

- **KOREŇ:** efekt na všetkých povrchoch, ≥4 presety s meraným gainom, role preset, blurb,
  live/offline parita, golden testy, browser check, budget riadok, ADR, CURRENT-STATE bump.
- **KOPA:** 24. inštrument, worklet + offline event queue, natívny fallback (audible),
  lazy load s vlastným budget riadkom, ≥16 presetov s meraným gainom (všetky počuteľné),
  badge/menu/Inspector/hobby view, live↔offline bit-parita, browser factory-preset QA,
  ADR, CURRENT-STATE bump.
- `npm run typecheck`, `npm run test`, `npm run test:expectations`, `npm run drift:check`,
  `npm run format:check`, `npm run build`, `npm run test:browser`, `npm run test:browser:factory-presets`,
  `npm run test:e2e:smoke` — všetko zelené.
- Žiadne tvrdenie „shipnuté" o tom, čo ešte nie je zmerané (AGENTS.md §8).
