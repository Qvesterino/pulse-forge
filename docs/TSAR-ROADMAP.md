# TSAR — hybridný zvukový engine (implementačný záznam)

> **STATUS: T0–T7 SHIPPED (2026-10-06/07).** This document is kept as the
> implementation record for WHAT shipped and WHY the decisions were made;
> the "how it turned out" notes live under each wave. The original product
> pitch and T0–T7 plan below are historical. For the forward-looking product
> direction and proposed next waves, read
> [`TSAR-PRODUCT-DIRECTION.md`](TSAR-PRODUCT-DIRECTION.md). Counts are in
> `docs/CURRENT-STATE.md` (23 instruments, 610 presets). The 23rd instrument
> is registered in `INSTRUMENT_DEFS`, the dock panel is `Alt+0`, and the
> browser gate `tests/e2e/18-tsar.spec.ts` proves the offline event-queue
> render is audible.

> **Pitch:** TSAR je klenot KYX — hybridný sample+synthesis engine v bottom docku,
> ktorý z jedného WAV-u spraví hrateľný nástroj a z jedného patcha vrstvený zvuk
> hodný produkcie. Inšpirovaný Omnisphere (hybrid source engine, enormná
> presetting knižnica, Sample Direct), ale postavený na tom, čo KYX už má:
> `wtvoice` per-sample voice worklet, `extractWavetable`, `autoMapVelocityLayers`
> a golden-vector gates.
>
> **Návrh produktu a priorít, nie tvrdenie, že to už funguje.** Každá vlna má
> merateľné KPI a standing gate; roadmap scope ≠ shipped feature.
>
> **Autor:** coding agent · 2026-10-06
> **Relevantné diely:** `src/audio-worklets/wtvoice-processor.js`,
> `src/instruments/wavetables.ts` (`extractWavetable`, `buildWavetableMips`),
> `src/samples/autoMap.ts` (`autoMapVelocityLayers`), `src/audio-workers/pitch-tracker.ts`,
> `src/instruments/modmatrix.ts`, `src/presets/*`, `src/ui/dockLayout.ts` + `DockChrome.tsx`

---

## 1. Vízia a positioning

### Prečo TSAR

KYZ dnes nemá **jediný nástroj, ktorý by bol destináciou**. Má 22 dobre
overených nástrojov (22/22 audio reachability, 0 leaks — viď
`docs/INSTRUMENT-VERIFICATION-2026-10-03.md`), ale žiadny z nich nie je ten,
za ktorým producent príde. TSAR je ten nástroj.

### Čím sa líši od Omnisphere

| Omnisphere                          | TSAR                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| 14 000+ presets, gigabajty knižnice | **562 factory presetov + user importy**, lokálne navždy, žiadny cloud                        |
| 8-part multitimbral                 | **Dual-source patch** + layer stack cez existujúce track groups                              |
| Sample Direct (audio → patch)       | **Sample Forge** — drop WAV → auto root/type detekcia → auto-engine routing → hrateľný patch |
| STEAM engine (proprietárny)         | **AudioWorklet per-sample** (wtvoice architektúra), live == offline parita                   |
| Desktop-only plugin                 | **Browser-first, 0 inštalácia**, deterministické render (seed + doc → rovnaké samples)       |

### Čím sa líši od existujúcich KYX nástrojov

| Existujúce                                | TSAR                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `sampler` — jeden sample, velocity layers | **Dual source A/B** (sample/wavetable/granular) + sub + noise + morph |
| `wavetable` — jeden osc bank              | **Per-sample voice engine s morph/scan, sync, FM cross-mod**          |
| `granular` — jeden grain stream           | **Grain ako modulačný zdroj**, nie len generátor                      |
| `spectral` — fixné partials               | **Sample-derived spektrálne partials**                                |
| statický patch                            | **Sample Forge** + preset browser s tagmi + A/B preview               |

---

## 2. Čo už máme (a netreba robiť nanovo)

| Kameň                                                                   | Kde                                                                             | Stav                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| Per-sample voice worklet (unison, mod matrix, SVF)                      | `wtvoice-processor.js` (16.8 KB)                                                | hotové, live                             |
| Sample → wavetable extrakcia (root period, frames, mips)                | `wavetables.ts` `extractWavetable` (period 30 Hz–4 kHz, fallback pre aperiodic) | hotové                                   |
| Sample → velocity/key zones                                             | `samples/autoMap.ts` `autoMapVelocityLayers`                                    | hotové                                   |
| YIN pitch tracker (worker, fmin/fmax parametre)                         | `audio-workers/pitch-tracker.ts`                                                | hotové, použité v U2/U7                  |
| Mod matrix (ENV/LFO/VEL/PRESS → cutoff/morph/amp)                       | `modmatrix.ts`, `wtvoice` má per-sample verziu                                  | hotové                                   |
| Wavetable mips + antialias                                              | `buildWavetableMips`, `pickMipLevel`                                            | hotové                                   |
| Preset model (InstrumentPreset + metadata + tagy)                       | `presets/types.ts`                                                              | hotové                                   |
| Preset similarity                                                       | `presets/similar.ts`                                                            | hotové                                   |
| Flagship panel pattern (worklet + panel + golden vectors)               | `morph-dynamics-core`, `ozvena-core`, `ultina-core`                             | hotový vzor                              |
| Dock panel registrácia + shortcuts                                      | `dockLayout.ts` PANEL_KEYS, `DockChrome.tsx`, `App.tsx` panelRenderers          | hotové                                   |
| Golden-vector test pattern                                              | `tests/morph-dynamics-golden/`, `tests/ultina-vectors/`                         | hotový vzor                              |
| Offline render parity pattern (worklet live + natívny fallback offline) | `registry.ts` `offlineRenderContext(ctx)` guard                                 | hotové, ale je to **kompromis** — viď §4 |

**Zásadné zistenie:** všetky diely pre Sample Forge existujú. Chýba **orchestrácia
(routing rozhodnutie), engine ktorý ich spojí, UI a offline parita**. To je presne
rozsah TSAR.

---

## 3. Gap analýza (čo CHÝBA)

| Gap                                                                                                                                                                                 | Riešenie                                                                      | Vlna |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---- |
| **Dual-source hybrid engine** — jeden patch = sample A + sample B + sub + noise, morph/blend, per-source filter/env                                                                 | nový `tsarvoice-processor.js` (per-sample worklet) + natívny offline fallback | T1   |
| **Sample Forge** — drop WAV → root/type/character analýza → auto-engine (sampler/wavetable/granular) → auto-envelope → hrateľný patch                                               | nový `src/tsar/forge.ts` (pure `(analysis) → patch plan`) + command           | T2   |
| **TSAR factory knižnica** — 100+ presetov naprieč žánrami s tagmi, mood, use-case                                                                                                   | `src/presets/tsar-factory.ts`                                                 | T3   |
| **TSAR panel v docku** — editor s vizualizérom, mod matrix grid, A/B preview, preset browser                                                                                        | `src/ui/TsarPanel.tsx` + dock registrácia                                     | T4   |
| **Offline worklet render** — dnes worklet nástroje renderujú offline cez natívny fallback (wtvoice) alebo vôbec; TSAR musí mať **bit-paritu live == offline cez prácu vo worklete** | event queue v `processorOptions` (renderer pozná všetky noty dopredu)         | T5   |
| **Arpeggiator + performance** — arp, glide/portamento, MPE pressure → morph                                                                                                         | rozšírenie workletu + panel                                                   | T6   |
| **Schema pre dual-source** — `sampleIdB` (Source B sample)                                                                                                                          | `SCHEMA_VERSION 6 → 7` + migrácia (optional pole) + ADR 0023                  | T1   |

---

## 4. Kritické architektonické rozhodnutia

### 4.1 Engine = per-sample AudioWorklet, NIE main-thread graf

`wtvoice` už dokázal, že per-sample voice engine je v KYX možný:
unison bank, morph/scan, sub, SVF filter, per-voice mod matrix — všetko
sample-accurate vo worklete. TSAR nadväzuje:

- **Prečo nie main-thread graf:** mod matrix per-sample (LFO s fázou per hlas,
  envelope na cutoff, velocity → morph) sa na Web Audio grafe nedá urobiť bez
  jedného GainNode/uzla na každú moduláciu na každý hlas — pri 16 hlasoch
  a 8 mod slotoch je to stovky uzlov, ktoré engine musí stavať a prerušovať.
  Worklet to robí v jednej slučke.
- **Determinizmus:** žiadny `Math.random`; unison/LFO fázy z voice counteru.
  Rovnaká správa → rovnaké samples (invariant #4).

### 4.2 OFFLINE PARITA je kritická — a je to najtvrdší problém

**Dnešný stav (wtvoice):** live ide cez worklet, ale **offline render worklet
NEPOUŽÍVA** — `registry.ts` má `offlineRenderContext(ctx)` guard, ktorý pre
OfflineAudioContext vždy vyberie natívny Web Audio graf. Dôvod (v kóde):
Chromium **nepumpuje message queue workletu počas `OfflineAudioContext`
renderu** — noty poslané cez `port.postMessage` pred `startRendering()` sa
spracujú až po dobehnutí renderu, takže wavetable track exportoval TICHO
(live fungoval). Natívny graf to obchádza tým, že envelopes sa schedulujú vopred.

**Pre TSAR to nestačí**, lebo natívny graf nevie dual-source morph, sync, FM
cross-mod ani per-sample mod matrix. Dva možné riešenia:

**A. Event queue cez `processorOptions` (preferované, overené proti rendereru).**

Renderer už dnes pozná **všetky noty projektu dopredu** a scheduluje ich
s absolútnymi časmi (`renderer.ts:529` `scheduleNotes` → `engine.noteOn(..., timeAt(tick))`).
Overené poradie v `renderProject`:

1. `engine.setProject(...)` (~471/490) — **tu sa stavia inštrumentový runtime**
   (`AudioEngine.ts:1815` factory call). V tomto bode noty ešte nie sú známe
   runtime-u ako celok… ale:
2. `scheduleNotes` / `scheduleDrums` / `scheduleAutomation` (~522–545) —
   všetky `noteOn` volania prebehnú s absolútnymi `when`.
3. `await engine.prepareOfflineRender()` (~581) — **pred** `startRendering`.
4. `ctx.startRendering()` (~587).

**Mechanizmus:** TSAR runtime v offline kontexte (`offlineRenderContext(ctx)`)
**nebuferuje do portu** — každý `noteOn/noteOff/pressure/param` zapíše do
in-memory event queue. V `prepareOfflineRender()` runtime vytvorí
`AudioWorkletNode("tsar-processor", { processorOptions: { events: queue } })`
a pripojí ho na output. Keďže `prepareOfflineRender` beží po schedulovaní a
pred `startRendering`, node existuje včas a nesie kompletné notové dáta.

Live cesta (port `postMessage`) a offline cesta (`processorOptions.events`)
zdieľajú **ten istý interpreter správ** — jedna funkcia `applyEvent(event)`
v procesore. Testovateľné: `tests/tsar/offline-parity.test.ts` renderuje ten
istý projekt live-captured PCM vs offline render a porovnáva vzorky.

**B. Hybridný fallback (záložné, ako wtvoice).**
Natívny simplifikovaný graf pre offline. **Zamietnuté pre TSAR** — fallback by
znamenal, že export znie INAK než live (porušenie invariantu #3 „exports sound
exactly like the project"). Pre ostatné nástroje je fallback prijateľný
kompromis; pre klenot DAW nie.

**Dôsledok A:** T5 musí prísť **pred** T1 dokončením, alebo T1 musí mať
offline-parity gate už v prvej vlne. Poradie: T0 → T1 (s A) → T2 → …

### 4.3 Dual-source patch bez multitimbralu

Omnisphere má 8-part multitimbral. TSAR v1 má **jeden track = jeden patch =
Source A + Source B + Sub + Noise**. Multitimbral sa dosiahne **existujúcimi
track groups** (layer stack = viac TSAR trackov v skupine). Dôvod:

- `InstrumentTrack` má `params: Record<string, number>` + `sampleId: string | null`.
  Dual source potrebuje `sampleIdB` — **jedno nové optional pole**, žiadna
  reštrukturalizácia.
- 8-part multitimbral by vyžadoval nový shape (`parts: PatchSource[]`) —
  veľká schema zmena, veľká migrácia, veľké UI. Nie v1.
- KYX už má group tracks s vlastným mixer stripom — layer stack je prirodzený.

### 4.4 Sample Forge = deterministické rozhodnutie, nie ML

Forge klasifikuje sample a routuje engine **merateľnými pravidlami**:

| Vlastnosť                 | Detekcia                                                                          | Routing                                              |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Root pitch                | `trackPitch` (fmin 30–250 pre bass, 70–1050 default) s clarity gate               | sampler/wavetable root note                          |
| One-shot vs loop          | attack/decay + sustain (attack/sustain ratio — rovnaký diskriminátor ako U3 kick) | one-shot → sampler, sustained → wavetable            |
| Tonálny vs perkusívny     | spektrálna periodicita (autokorelácia peak)                                       | tonálny → wavetable, perkusívny → sampler s envelope |
| Dĺžka > 2 s + stabilný f0 | pitch track stability                                                             | wavetable (extractWavetable frames)                  |
| Dĺžka > 4 s + nestabilný  | textúra                                                                           | granular                                             |
| Šum/FX                    | žiadny f0, žiadna periodicita                                                     | sampler s envelope + FX                              |

**Honesty:** ak root nie je detegovateľný (clarity < gate), Forge **povie
„neviem určiť výšku"** a nechá root na používateľovi (default C4) — nikdy
nevymyslí pitch. Rovnaké pravidlo ako UN-SUNO.

---

## 5. Vlny (každá = samostatné PR, standing gates)

### T0 — Golden harness a KPI (meranie PRED feature) — ~0,5 bloku

- `tests/tsar/golden-voices.ts`: syntetické referenčné zdroje (sínus s harmonickými,
  saw, noise burst, 808 sub, formant).
- `tests/tsar/golden-set.test.ts`: definícia KPI (nižšie §6) — render cez
  `renderProject` na headless AudioBuffer, porovnanie s referenčnými vektormi.
- **Determinizmus:** rovnaký seed + patch → bit-identické samples.
- **Úsilie:** ~0,5 bloku. **Riziko:** žiadne.

### T1 — TSAR engine core (worklet + model + engine wiring) — ~2–2,5 blokov

- `src/audio-worklets/tsar-processor.js`: per-sample engine
  - Source A + Source B: každý sample / wavetable(mips) / granular frame bank
  - Morph A↔B (crossfade, nie len blend pri crossfade nule)
  - Sub osc (sínus/808-shaped, -1/-2 oktáva), Noise (deterministický seed)
  - Per-source SVF filter (LP/HP/BP/notch, 2-pól) s keytracking + envelope
  - Per-voice envelope (ADSR) + LFO (rate, sync) + velocity routing
  - Per-sample mod matrix (rovnaký numerický kontrakt ako `wtvoice`)
  - Unison (detune, voices, width) na každom source
  - **Offline event queue cez `processorOptions`** (§4.2 A, overené poradie)
- `src/tsar/params.ts`: ParamDef schéma (TSAR_PARAMS) — stabilné ID, ktoré
  neprežijú len jednu verziu (žiadne `tsarA`, `tsarB`; `srcAMorph`, `srcALevel`…).
- `InstrumentKind "tsar"` v `project-model/types.ts` + registrácia v
  `INSTRUMENT_DEFS` / `INSTRUMENT_ORDER`.
- `sampleIdB` v `InstrumentTrack` + `SCHEMA_VERSION 6 → 7` + migrácia.
- `src/tsar/engine.ts` — runtime wrapper (`InstrumentRuntime` kontrakt):
  live cez worklet port, offline cez event queue → `processorOptions` v
  `prepareOfflineRender()`; fallback na natívny jednoduchý graf LEN ak worklet
  nie je dostupný (jsdom/starý prehliadač).
- **On-demand worklet load (KRITICKÉ):** `ensureWorkletsForDoc` dnes načítava
  len plugin EFFEKTY (`PLUGIN_WORKLET_TYPES`); instrument worklety (`wtVoice`,
  `grainVoice`) sú v `CORE_TYPES` a teda v boot bundli. TSAR worklet (≈160 KB)
  nesmie ísť do core bundlu — potrebuje **rovnakú lazy cestu ako plugin
  efekty**: nový `TSAR_WORKLET_TYPES`/`instrumentWorkletTypesInDoc(doc)` +
  `loadInstrumentWorklet(ctx, "tsar")` volaný z `ensureWorkletsForDoc`
  (aj v rendereri, aj v `AudioEngine` pri `setProject`), registrovaný len keď
  projekt obsahuje TSAR track. Test: projekt bez TSAR nikdy nenačíta
  `public/tsar-worklet.js` (network assertion vo `test:browser`).
- **Acceptance:**
  - `npx vitest run tests/tsar` zelené vrátane `offline-parity.test.ts`
    (live-captured PCM vs offline render, vzorky bit-identické ± 1 LSB).
  - 16 hlasov @ 48 kHz: `process()` priemer < 25 % realtime budgetu (merané
    `rtMonitor` alebo offline profil).
  - `npm run test:browser` — TSAR track hrá a renderuje sa v Chromium;
    boot bez TSAR tracku nenačíta TSAR worklet.
- **Úsilie:** ~2–2,5 bloku. **Riziko:** offline event queue a lazy worklet
  load sú súčasťou tejto vlny (T5 je len ich dokumentačné vytiahnutie);
  najrizikovejšie je poradie v rendereri — prvý test musí byť render parity,
  nie feature.

### T2 — Sample Forge — ~1–1,5 bloku

- `src/tsar/forge.ts` (pure): `forgePlan(pcm, sampleRate) → ForgePlan`
  - root detection cez `trackPitch` (parametrizované rozsahy) + clarity gate
  - one-shot/loop/sustained klasifikácia (attack/sustain + periodicita)
  - engine routing (sampler / wavetable / granular)
  - auto-envelope (attack/release z obálky), auto-norm (peak)
  - velocity layer split (ak je sample multi-hit — napr. 4× kick v jednom WAV)
  - **Honesty:** `confidence`, `warnings[]`, nikdy ticho nevymyslený pitch
- `src/commands/tsar.ts`: `forgeSampleCommand(doc, trackId, sampleId, plan)`
  — jeden undoable command, ktorý aplikuje patch (+ prípadný layer split).
- UI hook v `DropZone`/`Inspector` (T4 dotiahne): drop WAV na TSAR track →
  „FORGE" CTA → preview → Apply.
- **Acceptance:** root presnosť ≥ 95 % na syntetickej sade (sínus, saw,
  808 sub, formant, basové tóny 40–250 Hz); one-shot vs loop klasifikácia
  ≥ 90 %; determinizmus (rovnaký WAV → rovnaký plán).
- **Úsilie:** ~1–1,5 bloku. **Riziko:** polyfonné samples (Forge povie
  „neviem", nie hádže).

### T3 — TSAR factory knižnica + preset browser dáta — ~1–1,5 bloku

- `src/presets/tsar-factory.ts`: ~120 presetov naprieč 19 žánrami, tagované
  (`useCase`, `mood`, `energy`, `bpmRange` — existujúci `PresetMetadata`).
  - 30× bass, 30× lead, 25× pad/texture, 20× keys/pluck, 15× fx/riser.
- `npm run presets:loudness` gate (rovnaký ako ostatné factory banks).
- Similarity search cez existujúci `presets/similar.ts`.
- **Acceptance:** každý preset je auditovateľný (params sedia v rozsahoch),
  loudness gate prejde, `docs/CURRENT-STATE.md` bump (562 → 682).
- **Úsilie:** ~1–1,5 bloku. **Riziko:** veľký content task — rozdeliť na
  podvlny ak treba.

### T4 — TSAR panel v docku — ~1,5–2 bloky

- `src/ui/TsarPanel.tsx`:
  - Source A/B taby s waveform/wavetable vizualizérom (mips level pick)
  - Morph fader A↔B + Sub/Noise sekcia
  - Filter + envelope grafy (drag)
  - Mod matrix grid (8 slotov, drag source → destination — existujúci
    `ModMatrixRow` vzor)
  - FX rack (2 sloty — existujúce efekty)
  - Preset browser s tagmi + podobné zvuky
  - Sample Forge drop zone + FORGE CTA
- Registrácia: `PANEL_KEYS` + `DockChrome` tab (label „TSAR") +
  `App.tsx panelRenderers` + `Alt+9` shortcut.
- **Acceptance:** panel sa otvára na vybranom TSAR tracku, všetky controls
  commitujú cez commands (žiadny priamy store zápis), undo funguje,
  `tests/ui/TsarPanel.test.tsx` zelené; `touch-reachability` gate.
- **Úsilie:** ~1,5–2 bloky. **Riziko:** vizualizér výkon (requestAnimationFrame
  budgeting — používať existujúci `rafLoop.ts` bus).

### T5 — Offline worklet render (event queue) — ~1 blok

> Toto je súčasť T1; uvádzam ako samostatnú vlnu, lebo je to architektonický
> upgrade, ktorý môže neskôr poslúžiť AJ `wtvoice` a `grainVoice`.

- `src/rendering/renderer.ts`: pri TSAR tracku predá event list do
  `processorOptions.events` (renderer už má všetky noty).
- Worklet: `processorOptions.events` naplní rovnaký event queue, ktorý port
  správy používajú za behu. Jeden interpreter, dve cesty.
- **Acceptance:** `tests/tsar/offline-parity.test.ts` — live capture vs offline
  render bit-identické; existujúci render testy zelené.
- **Follow-up (mimo TSAR):** ak sa osvedčí, migrovať `wtvoice`/`grainVoice`
  na ten istý mechanizmus (vlastná vlna, vlastný ADR).
- **Úsilie:** ~1 blok. **Riziko:** Chromium verzie — test v reálnom browseri
  (`test:browser`), nie len jsdom.

### T6 — Arpeggiator + performance — ~1–1,5 bloku

- Arp: rate (sync), pattern (up/down/updown/random-seeded/order), octaves,
  gate, swing; beží **vo worklete** (sample-accurate, nie main-thread timer).
- Glide/portamento (rovnaký kontrakt ako existujúci `slideFrom` v runtime API).
- MPE: pressure → morph (dnes PRESS → cutoff/amp; TSAR pridá morph destination).
- **Acceptance:** arp deterministický (seed), render parita, panel controls.
- **Úsilie:** ~1–1,5 bloku.

### T7 — Polish, docs, release gates — ~0,5–1 blok

- ADR 0023 (TSAR engine decision + offline event queue).
- `docs/CURRENT-STATE.md` (instruments 22 → 23, presets bump).
- `README.md` + `DEMO-SCRIPT.md` sekcia.
- Bundle budget: TSAR worklet samostatný bundle (`public/tsar-worklet.js`),
  budget do `scripts/check-bundle-size.mjs` (návrh: 160 KB, merané pred
  commitom).
- Golden-vector suite `tests/tsar-golden/` (input → sample-exact output)
  podľa vzoru `morph-dynamics-golden`.
- **Úsilie:** ~0,5–1 bloku.

**Celkom ≈ 9–11 agent-blokov.** Poradie T0 → T1(+T5) → T2 → T4 → T3 → T6 → T7;
T3 (content) a T4 (UI) môžu bežať paralelne s T2.

---

## 6. KPI (nie vanity)

| Metrika                       | Cieľ                                      | Vlna  | Poznámka                                 |
| ----------------------------- | ----------------------------------------- | ----- | ---------------------------------------- |
| Live ↔ offline parita         | **bit-identické (±1 LSB)**                | T1/T5 | invariant #3 — exports znejú ako projekt |
| CPU: 16 hlasov @ 48 kHz       | < 25 % realtime budgetu                   | T1    | merané, nie odhadované                   |
| Root detection presnosť       | ≥ 95 % na syntetickej sade                | T2    | honesty: pod gate = „neviem"             |
| One-shot vs loop klasifikácia | ≥ 90 %                                    | T2    |                                          |
| Determinizmus                 | rovnaký seed + patch → bit-identické      | T1    | invariant #4                             |
| Forge honesty                 | 100 % plánov má `confidence` + `warnings` | T2    | nikdy ticho nevymyslený pitch            |
| Factory presety               | ~120, loudness gate zelený                | T3    | `presets:loudness`                       |
| Bundle (TSAR worklet)         | ≤ 160 KB                                  | T7    | merané pred commitom                     |
| Golden vectors                | sample-exact                              | T7    | vzor `morph-dynamics-golden`             |
| Panel gates                   | touch-reachability + undo + commands      | T4    | žiadny priamy store zápis                |

---

## 7. Poctivosť a hranice (anti-goals)

- **Nie je to ROMpler ani 14 000 presetov.** TSAR je engine + ~120 kvalitných
  presetov + **tvoj sample sa stane patchom**. Knižnica je diferenciátor, nie
  substitút za engine.
- **Žiadny nový ML model v MVP.** Forge je deterministický DSP (rovnako ako
  UN-SUNO). Ak klasifikácia nedosiahne KPI, zvážime malý ONNX klasifikátor —
  ale až po DSP, s manifest+gate rituálom.
- **Žiadne cloud sample libraries.** Sample Forge pracuje s user samplemi
  (25 MB cap z DropZone zostáva).
- **Offline parita sa neobchádza fallbackom.** Ak worklet nevládze offline
  event queue, TSAR sa NE-dodá s „offline znie inak" kompromisom.
- **`sampleIdB` je jediná schema zmena.** Ak by v1 chcela viac (parts array,
  per-source mod matrix v modeli), je to nová vlna + nový ADR.

---

## 8. Architektúra (invarianty, ktoré nesmieme porušiť)

- **DSP vo worklete** (`tsar-processor.js`), main thread nikdy. DSP patrí do
  `src/audio-worklets/` + build script `scripts/build-tsar-worklet.mjs`
  (vzor `build-morph-dynamics-worklet.mjs`), bundle `public/tsar-worklet.js`.
- **Pure + commands** — `forge.ts` je `(pcm, sr) → ForgePlan`, `tsar.ts`
  commands sú `(doc, …) → Command`; UI len opisuje intent (AGENTS #1/#2).
- **Jedno undo** pre Forge apply.
- **Live == offline parita** — event queue v processorOptions (T5).
- **Determinizmus** — žiadny `Math.random`; unison/LFO fázy z voice counteru.
- **Schema**: `sampleIdB` → `SCHEMA_VERSION 7` + migrácia + ADR 0023.
  Žiadne iné model zmeny.
- **Worklet load on demand**: TSAR worklet sa načíta len ak projekt obsahuje
  TSAR track (`ensureWorkletsForDoc` vzor), nie pri boote.
- **`useContext(ctx)`** jediná cesta k AudioNode; TSAR runtime rešpektuje
  `InstrumentRuntime` kontrakt.

---

## 9. Otvorené otázky (rozhodnúť pred T1)

1. **Názov a branding.** „TSAR" je pracovný. Akronym voliteľný
   (Timbre Synthesis And Resynthesis?). Brand musí sedieť s PRISM/VLYX/VOID/MORPH
   (krátke, tmavé, konzolové).
2. **Dva sample sources vs jeden sample + syntetické.** V1 navrhuje
   `sampleId` + `sampleIdB`. Ak by jeden sample + wavetable/sub/noise stačil,
   ušetríme schema zmena — ale stratíme „Omnisphere dual-source" esenciu.
   **Odporúčanie: dva samples, lebo to je pointa.**
3. **Granular ako tretí source?** V1: granular je len routing pre Forge
   (one-shot → sampler, sustained → wavetable, textúra → granular). Plný
   granular source v TSAR patchi je kandidát na T8.
4. **Arp vo worklete vs main thread.** Worklet (sample-accurate) je správne,
   ale je to viac práce. Alternatíva: scheduler-driven arp (existujúci
   `Scheduler`), menej presný. **Odporúčanie: worklet.**
5. **FX rack v TSAR vs globálny effect rack tracku.** V1: 2 FX sloty vo
   worklete (jednoduché: drive + chorus/delay), zvyšok cez track effect rack.
   Plný FX rack v TSAR je scope creep.
6. **Kedy T5 (offline event queue) generalizovať na `wtvoice`/`grainVoice`.**
   Po TSAR release, vlastná vlna.

---

## 10. Vzťah k existujúcim dokumentom

Tento plán **dopĺňa, nenahrádza**:

- `docs/UN-SUNO-PLAN.md` — transkripcia hudby do projektu (TSAR je nástroj,
  UN-SUNO je pipeline; môžu sa spojiť: UN-SUNO nájde melódiu → TSAR z nej
  spraví patch).
- `docs/ROSTER-EXPANSION-ROADMAP.md` — dáta (artist/žánre); TSAR je engine.
- `docs/INSTRUMENT-VERIFICATION-2026-10-03.md` — 22/22 nástrojov overených;
  TSAR je 23. a musí prejsť tou istou graph-reachability suite.
- `docs/ROADMAP-FULL-DAW.md` — TSAR patrí do „differentiation, not a blocker".

---

## 11. Prvý krok (T0) — čo spraviť hneď

1. `tests/tsar/golden-voices.ts` so syntetickými zdrojmi (deterministické,
   seedované — rovnaký vzor ako `tests/unsuno/golden-synth.ts`).
2. `tests/tsar/golden-set.test.ts` s KPI kontraktom (dormantné bloky pre
   T1/T2 KPI — `skipIf` gating, aktivujú sa keď vrstva povie `implemented`).
3. ADR skeleton `docs/adr/0023-tsar-hybrid-engine.md` (rozhodnutia §4).

**T0 je čisto meracia vlna — žiadny feature kód.** Lekcia z UN-SUNO U0
(„merané, nie vymyslené"): KPI kontrakt musí existovať skôr, než prvý riadok
enginu.

---

## 12. Ako to dopadlo (SHIPPED, 2026-10-06/07) — merané, nie odhadované

Každá vlna skončila s testami, ktoré bežali; toto je záznam o tom, čo sa
v priebehu merania UKÁZALO (a čo sa opravilo), nie sľub.

### T0 — golden harness — SHIPPED

`tests/tsar/golden-voices.ts` (6 seedovaných zdrojov: sine/saw/808/noise/
formant/drifting pad) + `golden-set.test.ts` (6 specov: determinizmus,
non-silence, dĺžka, Goertzel root-dominance, one-shot vs sustained shape).
**Dva fixture nálezy, ktoré testy chytili:** formant suma prekročila 1.0
(clip — znížené úrovne), a plain-autocorrelation root check čítal oktávu
nesprávne (pure sine → cos(ωL) je vysoký na malých lagoch) → prepnuté na
Goertzel energiu proti susedom ±1 semitone.

### T1 — engine core — SHIPPED

`src/tsar/dsp/tsarProcessor.ts` (typed, priamo testovateľný): 16 hlasov,
dual-source, morph, sub/noise, per-source Chamberlin SVF, 4-slot mod matrix,
glide, velocity, drive, tone, width, 1/√n polyfónia. `tsar-worklet.entry.js`

- `scripts/build-tsar-worklet.mjs` (22 KB bundle), lazy loader
  (`INSTRUMENT_WORKLET_TYPES`), `sampleIdB` + `SCHEMA_VERSION 13`.
  `tests/tsar/engine.test.ts` (17 specov, všetky zelené).

**Štyri reálne DSP bugy, ktoré testy odhalili:**

1. **Invertovaná/nesprávna SVF normalizácia** — pôvodný tvar
   `(input − q·s1 − s2)/(1+q·f+f²)` takmer vôbec nefiltroval (cutoff 300 Hz
   na 261 Hz tón sotva zmenil RMS). Port z overeného
   `svfilter-processor.js` (semi-implicit Chamberlin + `f·q` stability
   guard) dal skutočný útlm (cutoff 100 Hz → 7.6×).
2. **Voice lifecycle leak** — dlhý release na Source B držal hlas v 16-slot
   pool-e, aj keď B bol ticho (active count ostal 1 po >1 s). Fix: B env
   počíta len keď `levelB > 0`.
3. **16 hlasov prebudzovalo bus** (peak 2.09) — pridaný 1/√n polyphony
   divisor so smoothed menovateľom.
4. **Testovacia metrika bola zlá** — zero-crossing počet nemeria jas (každý
   harmonický stack 261 Hz tónu kríži nulu rovnako). Nahradené
   first-difference energy ratio; morph aj filter testy potom skutočne
   merajú to, čo tvrdia.

### T5 — offline event queue — SHIPPED (v rámci T1)

`AudioEngine.prepareOfflineRender()` volá `runtime.prepareOfflineRender()`,
ktorý vytvorí worklet node s `processorOptions.events` (celý naplánovaný
zoznam not) — lebo Chromium nepumpuje port messages počas
`OfflineAudioContext` renderu. **Jeden `applyEvent` interpreter pre obe
cesty**, bit-identické merané v `tests/tsar/engine.test.ts`; reálny browser
dôkaz v `tests/e2e/18-tsar.spec.ts` (peak > 0.005).

**Dva kritické bugy odhalené až browser E2E (unit testy ich nevideli):**

1. **`loadInstrumentWorklet` nikdy nehlásil readiness** — `readyInstrumentTypes`
   set sa inicializoval len pre plugin typy v `loadCoreWorklets`, takže
   `isWorkletReady("tsar")` bolo vždy false. Fix v `loader.ts`.
2. **Worklet čítal globál `processorOptions`** — v modernom Chrome je táto
   globálna premenná `undefined`; `processorOptions` prichádza ako
   **`constructor(options).processorOptions`**. Preto bol offline render
   digitálne ticho, kým live cesta cez port fungovala. Toto je presne tá
   trieda chyby, kvôli ktorej je `tests/e2e/18-tsar.spec.ts` povinný.

### T2 — Sample Forge — SHIPPED

`src/tsar/forge.ts` (pure): YIN root detection (absolute-threshold descent,
žiadne oktávové chyby), one-shot/sustained cez median-of-windows decay
ratio (robustný voči AM — prvá verzia s okrajovými decilami falošne čítala
golden pad ako decay), engine routing (sampler/wavetable/granular podľa
stability f0), envelope + normalizácia, honesty gates. `forgeSampleCommand`
(slot A/B, 1 undo). Testy: `forge.test.ts` (12) + `forge-command.test.ts`
(6) — root KPI 100 % (≥95 % cieľ), one-shot KPI 100 % (≥90 % cieľ).

### T3 — factory bank — SHIPPED

`src/presets/tsar-factory.ts`: 8 archetypov × 6 žánrových profilov = **48
presetov** v lazy `pack-presets` chunku (eager graf zostal pack-free).
`presets:loudness` gate premeral **610/610 presetov**; testy `presets.test.ts`
(6: schéma, unikátnosť, rozsahy, metadata, determinizmus, „profily reálne
hýbu zvukom"). **Loudness gate chytil reálny problém:** pady/textúry s dlhým
attackom merali v 0.78 s probe takmer ticho (+18 clamp), príliš hlasné
varianty (-18 clamp) — vybalansované na stred.

### T4 — dock panel — SHIPPED

`src/ui/TsarPanel.tsx` (source/morph matrix/LFO/arp surfaces, Forge drop
zone s reálnym `importAudioFile` + `forgePlan` + `forgeSampleCommand`,
factory browser s filtrom). `PANEL_KEYS` + `DOCK_TABS` + `App.tsx` +
`Alt+0` shortcut + `23-tsar.css`. Testy `TsarPanel.test.tsx` (5: empty
state, source surfaces, command-per-control, filter+apply preset, matrix
wiring). **Graph audit:** TSAR natívny fallback (keď worklet chýba) dáva
audible=1 — inak by bol 23. nástroj mŕtvy graf.

### T6 — arpeggiator — SHIPPED

Per-sample arp clock v DSP: UP/DOWN/UPDN/ORDER/seeded-RANDOM, rate/octaves/
gate/swing, okamžitý prvý step pri stlačení klávesy (`arpPress` force).
`tests/tsar/arp.test.ts` (5: retrigger count, gate energy, RANDOM
determinizmus, release-clean, octaves menia linku). **Nález:** prvý step
chýbal (arp čakal celý step) — opravené.

### T7 — release gates — SHIPPED

ADR `docs/adr/0023-tsar-hybrid-engine.md`; `CURRENT-STATE.md` (23 nástrojov,
610 presetov); bundle budget row `TSAR_WORKLET_BUDGET_KB = 48` (merané
22 KB); `tests/e2e/18-tsar.spec.ts` (2, chromium); parity obligation
prechádza; `test:fast` 421/421.

### Otvorené (poctivo, nie blokujúce)

- **Per-source filter je post-sum** (jeden SVF na source na hlas, nie per
  unison copy) — CPU optimalizácia, zvukovo ekvivalentná pre v1.
- **Mod matrix má 4 sloty** (schéma má 8 v pláne; UI aj DSP používajú 4 —
  rozšírenie je jednoduchý follow-up).
- **Granular source je position-scan**, nie plný grain cloud (Forge routing
  ho používa pre drifty; plný grain engine je kandidát na T8).
- **Offline event queue generalizácia** na `wtvoice`/`grainVoice` — tie
  stále používajú natívny fallback offline (funguje, ale líši sa od live);
  vlastná vlna s ADR amendmentom.
