# KYX — MRT2 generative tracks implementation roadmap

> Stav dokumentu: 2026-09-22
> Scope: provider-backed generative tracks, MRT2 Small integration, live accompaniment, freeze-to-audio a generative resample
> Účel: vykonateľný plán pre Pulse Forge/KYX; nie produktová vízia ani sľub, že MRT2 bude dostupné na každej platforme

## Priebežný stav implementácie

Overené v pracovnom strome 2026-09-22:

| Oblasť                                                                    | Stav                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| ADR, persisted track model, schema v1 → v2 normalizácia                   | hotové a testované                                      |
| provider-neutral contract, mock provider, capability registry, validation | hotové a testované                                      |
| bounded PCM queue s explicitným overrun/underrun stavom                   | hotové a testované                                      |
| capture → durable generated user sample → undoable `AudioClip` command    | hotové na mock provider flow vrátane runtime/UI commitu |
| conditioning z KYX pattern notes do 25 Hz/128-pitch frames                | hotové a testované                                      |
| live engine/worklet bus, persisted macro lanes + scene intensity          | prvý vertical slice hotový; hardening otvorený          |
| MRT2 protocol/IPC safety, host-local latency calibration, resample UI     | prvý slice hotový; native model host otvorený           |

### Dôkazy posledného implementation passu

- `npx tsc --noEmit --pretty false` — MRT2-focused run was PASS before the concurrent intent/song worktree edits; current full rerun is blocked by unrelated `IntentPanel`/song-length and existing test-fixture type errors;
- `npx vite build` — PASS, MRT2 transport je v on-demand chunke `websocket-transport`; aktuálny `node scripts/check-bundle-size.mjs` správne zlyhá na DAW JS `2504/2500 KB` po paralelných non-MRT2 worktree zmenách (predchádzajúci MRT2 pass bol `2499/2500 KB`); full `npm run build` remains blocked by typecheck errors above;
- full targeted generative/lifecycle cluster — PASS, `16 files / 74 tests` including protocol, IPC, provider, player, runtime, capture, export, resample, architecture and transport lifecycle;
- provider-stall hardening — PASS; a failed refresh retires the session/audio graph and allows a later explicit Play to create a fresh session;
- malformed PCM hardening — PASS; every MRT2 transport adapter is revalidated at the provider boundary, non-finite/out-of-range packets terminate the session with an explicit error, and the AudioWorklet drops invalid chunks without producing non-finite output;
- `tests/transport-audit.test.ts` — PASS, generative lifecycle is pinned through transport `play/pause/seek/stop` callbacks;
- 300 s mock live soak — PASS ako zrýchlený virtuálny test (`7500` provider frames);
- Playwright na čistom Vite serveri — landing flow `3/3` PASS a MRT2 generative-track smoke `1/1` PASS; širší Chromium smoke `5/6` (landing, generate a persistence PASS, existujúci panel-toggle overflow test timeoutol pri EXPORT menu, preto browser gate ešte nie je kompletne zelený). Generative track teraz deklaruje `UNAVAILABLE` už pred prvým Play bez native bridge.

## Pracovný kontrakt

Tento dokument je pracovný kontrakt pre implementáciu ďalšej veľkej audio feature. Cieľom je pridať AI hudobníka, ktorý hrá spolu s používateľom, pričom používateľov projektový model, transport, scheduler a AudioEngine zostanú zdrojom pravdy.

Agent musí:

- najprv prečítať tento dokument, relevantné ADR-y a overiť aktuálny worktree;
- zachovať existujúce používateľské zmeny a nerobiť reset, checkout ani široký rewrite;
- nepchať MRT2 SDK, modelové váhy ani provider session do React komponentov, `ProjectDocument` ani AudioWorkletu;
- držať provider za explicitnou capability boundary; neprítomný alebo nepodporovaný provider nesmie pokaziť boot, reload, prehrávanie ani export existujúceho projektu;
- ukladať do `ProjectDocument` iba serializovateľný recipe/config stav, nikdy AudioNodes, sockety, PCM queue, DOM ani runtime session;
- všetky používateľské mutácie viesť cez commands s undo/redo a collab round-trip testom;
- pre live audio použiť AudioWorklet/engine boundary; main thread nesmie byť realtime audio buffer;
- neoznačiť MRT2 ako natívny `InstrumentKind` bez nového ADR. Je to externý generative provider, nie ďalší lokálny synth;
- každú fázu uzavrieť relevantným typecheckom, targeted testami a podľa rizika browser smoke/build gate;
- checkbox odškrtnúť až po dôkaze v teste, browser checku, build-e alebo ručne zdokumentovanom platformovom experimente.

## Produktový kontrakt

V1 má používateľovi umožniť:

```text
Chord / note context + style prompt
                  ↓
             MRT2 Small
                  ↓
       live generative accompaniment
                  ↓
        Preview → Capture → AudioClip
```

Generatívna stopa má byť ďalší hudobník v KYX. Vlastné drums, 808 a chord track zostávajú pod kontrolou používateľa. AI generuje sprievodný stem, nie celý projekt.

### Explicitne podporované

- textový style prompt;
- audio-derived style reference, keď je provider dostupný;
- note/chord conditioning odvodené z KYX patternov a transportu;
- explicitný drums režim `off`/`on`/`provider-default`, iba ak ho konkrétny provider skutočne podporuje;
- naše produktové makrá `energy`, `density`, `variation`, `texture` ako wrapper semantics;
- section-aware zmeny podľa arrangement/scenes;
- live preview s indikovanou latenciou a stavom bufferu;
- capture/freeze do normálneho persistentného KYX audio assetu a `AudioClip`.

### Mimo rozsahu prvej verzie

- hostovanie MRT2 priamo vo Web Audio alebo v browserovom AudioWorklete;
- automatické sťahovanie veľkých modelov pri boote KYX;
- cloudová inference ako tichý fallback;
- vydávanie `Energy`, `Density` alebo `Texture` za natívne MRT2 parametre;
- generovanie vokálnych textov alebo imitácia konkrétnych žijúcich umelcov;
- priame prepisovanie používateľových drums/808 bez explicitnej akcie;
- live generative output ako jediný zdroj pravdy pre offline export.

## Externý MRT2 kontrakt, ktorý musíme rešpektovať

MRT2 sa skladá z MusicCoCa style embeddingu, SpectroStream codec vrstvy a decoder-only generátora. Model card uvádza text/audio style vstup, MIDI stav 128 pitchov a stereo 48 kHz audio výstup. `mrt2_small` má 230M parametrov; realtime je podľa upstream dokumentácie určený pre Apple Silicon Mac. ([model card](https://huggingface.co/google/magenta-realtime-2), [MRT2 README](https://github.com/magenta/magenta-realtime/blob/main/README.md), [models.md](https://github.com/magenta/magenta-realtime/blob/main/docs/models.md))

Z toho vyplývajú tieto záväzné pravidlá:

- conditioning sa musí preložiť z KYX tick/note modelu na provider frame model; scheduler nesmie posielať náhodné MIDI eventy priamo z Reactu;
- 48 kHz stereo výstup sa musí explicitne prispôsobiť `AudioContext.sampleRate` pred vložením do live ring bufferu;
- provider musí deklarovať, či podporuje text style, audio style, note control, drums control, realtime stream, offline render a seed;
- ak provider seed alebo bit-exaktnú deterministickosť negarantuje, capture do audio assetu je reproducibility boundary;
- licenčný audit je release blocker: upstream uvádza Apache 2.0 pre codebase a CC-BY 4.0 pre model weights. ([model card](https://huggingface.co/google/magenta-realtime-2))

## Definition of Done

Roadmap je splnená, keď:

- KYX vie vytvoriť generatívnu stopu s MRT2 provider configom bez toho, aby MRT2 bolo súčasťou hlavného browser bundle;
- projekt sa otvorí a prehrá aj na hoste bez MRT2 bridge; stav je používateľovi jasne oznámený;
- text/audio style a KYX note context sa validovane preložia na provider request;
- live stream ide cez bezpečnú AudioWorklet/engine cestu s bounded bufferom, underrun stavom a merateľnou latency compensation;
- generovaný výsledok sa dá jedným undoable workflowom zachytiť ako persistentný KYX audio asset a normálny `AudioClip`;
- live provider output nie je potrebný v `OfflineAudioContext`; export používa zachytený asset alebo explicitný provider pre-render prepass;
- section intensity, makrá a automation sú uložené v project modeli, nie iba v React state;
- reload, schema migration, undo/redo, collab round-trip a missing-provider fallback sú pokryté testami;
- codebase neporuší strict typecheck, bundle budget, audio worker boundary ani existujúce live/offline render parity testy;
- MRT2 code/model attribution a platform support matrix sú súčasťou release dokumentácie.

## Aktuálny baseline — čo už existuje

Toto sa nemá implementovať od nuly:

- `src/project-model/types.ts` už obsahuje `AudioClip`, arrangement audio clips a `FrozenState`;
- `src/commands/commands.ts` už obsahuje add/edit/split/consolidate audio clip commandy a freeze/unfreeze commandy;
- `src/audio-engine/AudioEngine.ts` už vie route-núť audio clip cez track FX a pracovať s persistentnými frozen buffermi;
- `src/rendering/renderer.ts` používa rovnaký `AudioEngine` pre live/offline render;
- `src/persistence/FrozenBufferRepository.ts` a user-sample persistence poskytujú vzor pre durable audio bytes;
- scheduler už pozná pattern/song windows, arrangement clips, scene intensity a MIDI output boundary;
- `src/intent/` a `src/ai/` už majú provider/fallback/circuit-breaker vzory, ale MRT2 nesmie potichu kopírovať ich UI ani runtime kontrakt;
- aktuálny schema version je `2`; persisted generative track shape je pokrytý normalizáciou v1 → v2 a update `SCHEMA_VERSION`.

## Navrhovaná persisted shape

Finálny tvar schváli ADR, ale implementácia má smerovať k explicitnému track kindu, nie k falošnému inštrumentu:

```ts
interface GenerativeTrack {
  id: ID;
  kind: "generative";
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  effects: EffectInstance[];
  sends: Record<ID, number>;
  groupId?: ID;
  color?: string;
  frozen?: FrozenState;
  generative: GenerativeTrackConfig;
}

interface GenerativeTrackConfig {
  providerId: string;
  modelId: string;
  style: { kind: "text"; text: string } | { kind: "audio"; bufferId: string };
  noteSourceTrackId?: ID;
  chordSourceTrackId?: ID;
  drumsMode: "off" | "on" | "provider-default";
  macros: {
    energy: number;
    density: number;
    variation: number;
    texture: number;
  };
  seed?: string;
  latencyMode: "live" | "capture";
  providerVersion?: string;
}
```

Persisted config nesmie obsahovať socket state, model path, generated PCM, connection token, AudioBuffer ani transient status. Generated audio bytes a provenance patria do durable audio repository; track/clip v dokumente nesie iba identity a recipe metadata.

## Fázy implementácie

### Fáza 0 — preflight, ADR a feasibility spike

**Súvisiace súbory:** `docs/adr/0012-mrt2-generative-tracks.md`, `docs/CURRENT-STATE.md` iba ak sa zmení verifikovateľný počet, nový `docs/` spike report, prípadne samostatný native prototype mimo web bundle.

- [x] skontrolovať `git status --short` a zapísať baseline typecheck/test/build stav;
- [x] vytvoriť ADR 0012 s rozhodnutím: provider boundary, optional native bridge, track kind, freeze semantics, platform support a licenčné povinnosti;
- [x] overiť upstream C++/MLX API pre session lifecycle, audio callback, note/MIDI input, style input, model loading a stop/restart;
- [ ] overiť reálny output sample rate/channels, chunk size, warm-up latency a dlhý stream na Apple Silicon;
- [x] zistiť, či upstream API garantuje seed/determinism a ktoré conditioning možnosti sú dostupné v `mrt2_small`;
- [ ] vyrobiť minimálny 4–8 taktový WAV cez upstream runtime bez zásahu do KYX;
- [x] zapísať výsledok a neistoty do ADR/spike reportu. Nezačať track model, kým nie je jasné, čo bridge skutočne vie.

**Checkpoint:** máme overený externý audio vstup/výstup a platformovú maticu; žiadny MRT2 kód ešte nie je importovaný do browser bundle.

### Fáza 1 — provider-neutral contract a mock runtime

**Súvisiace súbory:** nový `src/generative/`, `src/services/services.ts` alebo aktuálny services entry point, nové `tests/generative/`.

- [x] definovať `GenerativeAudioProvider`, `GenerativeSession`, `GenerativeCapabilities`, `GenerativeInput` a `GenerativeAudioChunk`;
- [x] oddeliť control plane (start/stop/style/note frames/status) od audio plane (PCM chunks);
- [x] pridať mock provider s deterministickým PCM fixture outputom;
- [x] pridať validáciu requestov, finite-number guardy, bounded queue policy a cancellation;
- [x] doplniť všeobecný provider timeout/error policy pre externé adaptery;
- [x] napojiť provider registry cez capability detection, nie cez priame `if (window...)` v UI;
- [x] pridať plné contract testy pre ordering chunkov, gap/underrun, reconnect state, dispose, unsupported capability a deterministic mock output.

**Akceptácia:** celý generative runtime sa dá testovať bez MRT2, bez audio device a bez native hosta.

### Fáza 2 — project model, schema migration a commands

**Súvisiace súbory:** `src/project-model/types.ts`, `src/project-model/schema.ts`, `src/project-model/targets.ts`, `src/commands/commands.ts`, collab adapter/store testy.

- [x] pridať `GenerativeTrack` do `Track` unionu a normalizerov;
- [x] pridať `createGenerativeTrackModel()` s bezpečnými defaultmi a provider configom;
- [x] bumpnúť `SCHEMA_VERSION` a pokryť v1 → v2 normalizáciu; neznáme future versions sa naďalej odmietajú;
- [x] normalizovať provider id, model id, prompt, style buffer id, macro range, drums mode a optional seed;
- [x] doplniť undoable commands: add track a edit config patch;
- [x] zabezpečiť collab round-trip vrátane neznámeho provideru a chýbajúceho audio assetu;
- [x] rozhodnúť, že generative macro automation bude samostatný validated lane type v `GenerativeTrackConfig`; runtime ho vzorkuje rovnako pre live aj capture;
- [x] pridať project round-trip, malformed JSON, migration, undo/redo a collab testy.

**Akceptácia:** generative track je čistý serializovateľný model a jeho načítanie bez providera nespôsobí ticho alebo crash celého projektu.

### Fáza 3 — capture/bake workflow ako prvý používateľský vertical slice

**Súvisiace súbory:** `src/generative/`, `src/persistence/`, `src/commands/commands.ts`, `src/rendering/`, relevantné UI v `src/ui/`.

- [x] implementovať `captureTrack()` nad provider-neutral session contractom; mock provider flow je pokrytý runtime testom;
- [x] vybrať durable storage kontrakt pre generated WAV/PCM bytes a provenance metadata; neprepísať silently existujúce user sample rows;
- [x] vytvoriť generated asset id, input hash a provider/model metadata;
- [x] pripraviť capture ako normálny `addAudioClip` command cez `persistGeneratedAudioAsClip`, s okamžitým `SampleBank` importom a Inspector commitom;
- [x] zabezpečiť jeden používateľský undo krok pre commit clipu a document identity guard proti súbežnej editácii počas renderu;
- [x] previewovať live output cez existujúci `AudioEngine` track graph, nie cez druhý ad-hoc audio graph;
- [x] doplniť trim, split, reverse, stretch a FX smoke test na generated clip;
- [x] doplniť reload test: projekt + generated bytes prežijú zavretie/obnovenie rovnako ako ostatné durable audio.

**Akceptácia:** používateľ vie dostať generovaný stem do timeline a ďalej s ním pracovať ako s bežným KYX audio materiálom aj bez live MRT2 runtime.

### Fáza 4 — MRT2 native bridge

**Súvisiace súbory:** nový `desktop/` bridge/IPC contract podľa ADR 0012, `src/generative/providers/mrt2/`, `desktop/main.cjs`, `desktop/preload.cjs`, optional localhost companion protocol docs.

- [x] implementovať transport-neutral control protocol s versioned messages;
- [x] binary PCM posielať oddelene od JSON control messages;
- [x] v Electron hoste povoliť iba explicitne spustený a validovaný loopback companion endpoint cez úzky IPC boundary; žiadny arbitrary executable/model path z URL parametra alebo projektu;
- [x] pre browser režim podporiť iba deliberate localhost companion connection s origin/token kontrolou, ak to ADR schváli;
- [x] deklarovať platform capability: Apple Silicon realtime, offline-only alebo unavailable; Windows KYX musí mať jasný fallback stav;
- [x] zobraziť/propagovať model loading, downloading, ready, buffering, unavailable, error a reconnect stavy;
- [x] browser Inspector smoke overuje vytvorenie generative tracku, provider/model surface, localhost-only companion endpoint a bezpečný idle stav bez native hosta;
- [x] neukladať absolútne model paths, IPC tokeny ani host-local capabilities do project documentu;
- [x] pridať mock IPC boundary test a protocol invalid-message/size/shape test;
- [ ] pridať native bridge smoke test na podporovanom Apple Silicon hoste — na Windows je native MRT2 zámerne explicitne unavailable.

**Akceptácia:** bridge vie dodať rovnaký `GenerativeAudioProvider` contract ako mock provider a pri páde sa korektne odpojí bez poškodenia AudioEngine.

### Fáza 5 — live playback cez AudioWorklet a transport

**Súvisiace súbory:** `src/audio-worklets/`, `src/audio-engine/AudioEngine.ts`, `src/scheduler/Scheduler.ts`, `src/transport/Transport.ts`, `src/services/`, `tests/` a browser checks.

- [x] navrhnúť bounded PCM ring buffer s explicitným sample-rate/channel contractom;
- [x] preniesť chunks do AudioWorkletu cez `MessagePort`/transferable buffers; žiadne per-block main-thread PCM kopírovanie;
- [x] pridať generative output bus, ktorý sa route-ne cez track gain/pan/effects/sends/group ako ostatné tracky;
- [x] synchronizovať session start/stop/pause/seek s transportom; bar-boundary latency policy a kalibrácia zostávajú hardening;
- [x] odmerať provider warm-up a control latency; uložiť iba host-local user-facing calibration, nie runtime socket stav;
- [ ] riešiť underrun, overrun, provider stall, tempo change, loop, stop a context suspend/resume; provider-stall retirement is now implemented/tested, while the remaining realtime/browser matrix stays open;
- [x] oddeliť scheduler plánovanie note frames od AudioEngine execution; Scheduler nesmie vlastniť provider session;
- [ ] pridať browser checks pre play/stop/seek, provider unavailable, underrun recovery a zero non-finite samples; provider-unavailable/localhost Inspector smoke je už pokrytý samostatne; worklet/provider boundary coverage now proves invalid PCM is dropped and never rendered, but the real-browser underrun/transport matrix remains open;
- [x] overiť 300 s virtuálny mock live soak s finite/ordered chunks;
- [ ] overiť CPU/heap growth a latency pri samostatnom native soaku na podporovanom Macu.

**Akceptácia:** live generative track hrá v synchronizácii bez runaway bufferu, bez audio callback exception a bez main-thread audio execution.

### Fáza 6 — KYX conditioning, section awareness a makrá

**Súvisiace súbory:** `src/generative/conditioning/`, `src/project-model/automation.ts`, `src/project-model/targets.ts`, `src/scheduler/Scheduler.ts`, relevantné UI panely.

- [x] vytvoriť čistú funkciu, ktorá preloží KYX notes/chords na provider frame representation;
- [x] explicitne otestovať note onset, sustain, release, overlapping notes, tempo change a pattern loop;
- [x] oddeliť chord source, note source a drums mode; neposielať 808/drums, ak je režim `off`;
- [x] použiť existujúcu scene/arrangement intensity ako prvý section-aware driver;
- [x] pridať validated generative macro lanes; runtime má rovnakú interpretáciu v live aj capture ceste;
- [x] namapovať `energy`, `density`, `variation`, `texture` na provider capability/profile, pričom unsupported mapping musí byť viditeľný a stabilný;
- [x] dodať Inspector panel pre prompt/style, source tracks, drums mode, macro values, live status a capture action;
- [x] pridať testy pre section boundary, automation continuity a fallback na poslednú validnú conditioning konfiguráciu.

**Akceptácia:** rovnaký project recipe vytvára konzistentný conditioning request v mock live aj capture režime; žiadny macro názov nepredstiera natívnu MRT2 podporu.

### Fáza 7 — offline/export parity a freeze semantics

**Súvisiace súbory:** `src/rendering/renderer.ts`, `src/rendering/track-renderer.ts`, `src/export/`, generated asset repository, relevantné browser checks.

- [x] rozhodnúť a zdokumentovať, že live external provider nie je priamo dependency `OfflineAudioContext`;
- [x] export live generative track buď odmietne s jasnou správou, alebo vyžiada explicitný capture/pre-render prepass;
- [x] po capture používať iba rovnaký `AudioClip` path ako live prehrávanie a offline renderer;
- [ ] overiť sample-accurate placement, fades, stretch, reverse, FX, group routing a master chain;
- [x] zabezpečiť, že incomplete/failed capture nevytvorí v projekte orphan clip ani fake success state;
- [ ] pridať render→encode→reload test a parity test live preview vs captured clip v toleranciách definovaných testom;
- [x] oddeliť track-level engine freeze optimization od produktovej akcie `Capture/Freeze to Audio`; export guard akceptuje iba durable generative `AudioClip`, nie interný `FrozenState`.

**Akceptácia:** export je reprodukovateľný po capture a projekt nikdy nesľubuje offline render z nedostupného realtime providera.

### Fáza 8 — generative resample a provider-neutral expansion

**Súvisiace súbory:** `src/generative/conditioning/`, `src/ui/ArrangementPanel.tsx`, generated asset repository, `src/export/`, shared runtime package decision.

- [x] z vybraného audio regionu vytvoriť bezpečný, capped audio reference request;
- [x] resamplovať reference na MusicCoCa kontrakt (16 kHz mono podľa model card) mimo AudioWorklet realtime callback;
- [x] generovať A/B/C/D variation jobs s cancellation a per-job provenance;
- [x] previewovať variácie bez automatického vloženia do projektu;
- [x] drag/drop alebo explicitný commit vloží vybranú variáciu ako normálny audio clip;
- [x] pridať source hash, provider/model version a user prompt k generated assetu;
- [ ] až po stabilizácii KYX workflowu rozhodnúť, či `src/generative/` extrahovať do zdieľaného QWESTER runtime pre ZYVO.

**Akceptácia:** generative resample je sampling workflow s AI pomocou, nie nevratné nahradenie pôvodného materiálu.

## Testovací a validačný matrix

### Model/schema/commands

- schema v1 → nová verzia migration;
- malformed provider config, unknown provider, missing asset, future schema;
- command undo/redo, concurrent capture completion a collab round-trip;
- deterministic mock provider input/output hashes.

### Audio/runtime

- finite samples, no NaN/Infinity, bounded queue;
- sample-rate conversion 44.1 ↔ 48 kHz;
- start/stop/pause/seek/loop/tempo change;
- underrun/overrun/stall/reconnect;
- effects, sends, groups, mute/solo a master chain;
- live/capture/offline clip parity.

### Browser/native

- browser bez provideru: project boot, playback, import/export;
- Electron bez Apple Silicon capability: explicit unavailable state;
- supported native host: bridge smoke, 300 s soak, memory/CPU/latency report;
- invalid IPC message, unexpected disconnect, oversized PCM chunk a malformed JSON;
- no model weights in Vite entry chunks a no bundle budget regression.

## Riziká a rozhodnutia, ktoré musia zostať viditeľné

| Riziko                                     | Ochrana                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| MRT2 realtime je platformovo obmedzené     | provider capability matrix, bake fallback, transparentný unavailable stav          |
| live stream nie je bit-deterministický     | capture asset + provenance je reproducibility boundary                             |
| PCM bridge spôsobí glitch alebo GC spike   | bounded transferable ring buffer v AudioWorklete, soak gate                        |
| conditioning API sa zmení upstream         | versioned adapter, capability negotiation, contract tests                          |
| generated audio sa stratí po reload        | durable asset repository pred commitom do project modelu                           |
| prompt/audio input prekročí resource cap   | duration/size limits, cancellation, validation a decompression/import caps         |
| license/attribution nebude ship-ready      | ADR + release checklist + bundled attribution, žiadne implicitné model downloady   |
| generative track obíde engine architecture | runtime session v services, audio cez engine/worklet boundary, React iba intent UI |

## Odporúčané poradie prvých implementačných PR

1. ADR 0012 + feasibility report; bez produkčného MRT2 bundlingu.
2. Provider contract + deterministic mock + contract tests.
3. Schema migration + `GenerativeTrack` + commands + collab round-trip.
4. Capture generated WAV → durable asset → normal `AudioClip`.
5. MRT2 native adapter za rovnakým provider contractom.
6. Live AudioWorklet stream a transport synchronization.
7. Section awareness, macros a UI polish.
8. Generative resample a shared runtime audit pre ZYVO.

Prvý release milestone má byť splnený už po kroku 4: používateľ musí vedieť AI-generated materiál dostať do KYX timeline a ďalej ho produkčne upravovať aj vtedy, keď live MRT2 na konkrétnom hoste nie je dostupné.
