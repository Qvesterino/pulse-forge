# KYX — pre-release implementation roadmap

**Status:** agent-ready implementation source of truth + reviewed execution snapshot (not a release approval)
**Dátum:** 2026-09-13
**Produkt:** KYX browser-first beatmaking DAW  
**Cieľ:** dostať KYX do stavu, v ktorom nový používateľ vytvorí beat, vyberie zvuk, spracuje ho cez pluginy, zrozumiteľne ho zmixuje a bezpečne exportuje bez straty práce, nečakaných level skokov alebo nejasného workflow.

**Reviewed baseline:** `dfaf230` (`build: sync PRISM worklet artifact`) with
functional/test baseline `8f11255` — FXEQ/PRISM six-band crossover surface
correction on top of `173f5ce` (`fix(ultina): reconcile upstream DSP
and protect vendor sync`).
The local KYX tree now contains the reviewed Ultina contract/worklet
reconciliation, the block-boundary regression test and a dirty-upstream guard
for future vendor syncs. The matching upstream source/test changes are
recorded in `D:/VocalForge_DAW` commit `c0a549d`. The FXEQ crossover change and
generated worklet are committed in `8f11255` and `dfaf230`; ranker client
hardening is in `f3514a5` and the browser fallback probe is in `f07a4e2`.
Only the continuity log is outside `HEAD`. Full Vitest baseline and current
Chromium gates are green.
Release approval still waits for the manual device matrix, production deploy
smoke and the formatting decision.

Tento dokument je implementačný plán pre ďalšieho agenta. Každá úloha má byť riešená proti existujúcemu kódu v repozitári, nie ako samostatný redesign produktu.

## Agent execution protocol

### Ako s roadmapou pracovať

1. Agent si najprv prečíta túto kapitolu, kapitolu 2 (source of truth) a kapitolu 3
   (invariants). Až potom si vyberie jednu úlohu z najbližšieho execution queue.
2. Stav `[x]` znamená „implementované a overené“, nie „kód existuje“. Pri každej
   položke musí byť dohľadateľný test, browser check alebo manuálny release dôkaz.
3. Neoverené zmeny v pracovnom strome sa nesmú potichu zahrnúť do tvrdenia, že
   feature je shipped. Najprv sa musia zmapovať, otestovať, zdokumentovať a
   oddeliť od nesúvisiacich zmien.
4. Ak úloha mení audio, project model, export, persistence alebo server, agent
   v completion reporte uvedie live/offline, reload, undo/autosave/collab a
   failure-state dopad. Ak tieto údaje nevie doložiť, úloha nie je done.
5. Po každej centrálnej zmene sa spustí aspoň typecheck + dotknuté testy. Pred
   označením release gate ako zeleného sa spúšťa kompletná sada z kapitoly 15.

### Najbližší execution queue

Toto je praktické poradie práce pre agenta, ktorý preberá aktuálny strom. Kým
nie je uzavretý `REL-01`, nemá zmysel pridávať nový plugin alebo veľký instrument.

| ID         | Stav                                           | Priorita        | Úloha                                                                                                     | Reálne touchpoints                                                                                                                                                                                                                           | Done keď                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REL-01`   | **CLOSED — reviewed baseline `dfaf230`**       | P0              | Zmapovať a uzavrieť commitnutý release scope bez straty PRISM/VLYX/VØID capability                         | `git show dfaf230`, `git show 8f11255`, `src/effects/`, `src/audio-engine/`, `src/ui/`, `tests/`                                                                                                                                               | reviewed commit je čistý a čitateľný; každá capability má dôkaz aj otvorený follow-up; release approval je samostatný krok                                                                                                                     |
| `PRISM-01` | **IMPLEMENTED — current browser 219/219** | P0         | Uzavrieť PRISM A/B, plugin history, gain-match/meter a spectral sidechain ako jeden zrozumiteľný workflow | `src/ui/FxEqPanel.tsx`, `src/ui/fxeqCurve.ts`, `src/ui/EffectRack.tsx`, `src/ui/EffectAbControls.tsx`, `src/audio-engine/AudioEngine.ts`, `src/effects/fxeqNode.ts`, `src/effects/fxeq-worklet.entry.js`, `src/project-model/schema.ts`, `src/commands/commands.ts` | source picker + rewire, live preview/history, persisted A/B hydration, cancel-safe controls, musical tempo-sync selects, transfer overlay and async history queue are implemented; current quiet Chromium acceptance is 219/219; full Vitest is also green, manual/deploy gates remain open |
| `DSP-01`   | **PASS — current candidate gates green**           | P0              | Uzavrieť FXEQ full-load realtime performance gate                                                         | `tests/fxeq-performance-gates.test.ts`, `src/effects/fxeq-core/core/`, `src/effects/fxeq-core/modules/`, `scripts/build-fxeq-worklet.mjs`                                                                                                    | allocation-free oprava, gate 3/3, full Vitest `236/2319/103`, current browser worklet/CPU checks and build/budget pass                                                                                                                       |
| `DSP-02`   | **PASS — current candidate gates green**           | P0              | Obnoviť biquad state po non-finite audio frame                                                            | upstream FXEQ/VØID `dsp/biquad.ts`, vendored `src/effects/*-core/dsp/biquad.ts`, generated worklets, `tests/fxeq-ozvena-biquad-hardening.test.ts`                                                                                            | upstream fix je znovu vendored, 4/4 host regression, worklety/build, full Vitest `236/2319/103` and browser smoke pass                                                                                                          |
| `QA-01`    | **OWNER GATE OPEN**                            | P0              | Manuálny browser/device release matrix                                                                    | [`docs/KYX-MANUAL-RELEASE-CHECKLIST.md`](./KYX-MANUAL-RELEASE-CHECKLIST.md)                                                                                                                                                                  | Chromium/Edge/Firefox/Safari macOS/Safari iOS prejdú create → sound → FX → mix → export → reload flow                                                                                                                                                 |
| `DEP-01`   | **OWNER GATE OPEN — `KYX_DEPLOY_URL` missing** | P0              | Overiť produkčný deploy, nie iba lokálny server smoke                                                     | `scripts/release-preflight.mjs`, `scripts/release-server-smoke.mjs`, `scripts/release-deployed-smoke.mjs`, nasadený host                                                                                                                     | `release:deployed-smoke` prejde s reálnym `KYX_DEPLOY_URL`; HTTP smoke overí app shell, manifest, všetkých päť workletov, service worker, health, CORS/origin rejection a voliteľne gallery auth; browser refresh/tab-close recovery ostáva v matrixe |
| `VOI-01`   | **OWNER GATE OPEN**                            | P0              | Zmerať VØID IR/pre-delay footprint na fyzických zariadeniach                                              | `src/effects/ozvena-core/`, `src/ui/OzvenaPanel.tsx`, `docs/KYX-MANUAL-RELEASE-CHECKLIST.md`                                                                                                                                                 | máme device/browser meranie ready time, peak memory proxy, pre-delay range, dropout a recovery správania                                                                                                                                              |
| `FMT-01`   | **DECISION OPEN**                              | Release hygiene | Rozhodnúť o 209 formatting deviations                                                                     | `npm run format:check`, [`docs/FORMAT-CHECK-DEVIATIONS.md`](./FORMAT-CHECK-DEVIATIONS.md)                                                                                                                                                    | buď samostatný formatting-only cleanup, alebo explicitne schválená CI výnimka bez zmenšenia scope                                                                                                                                                     |

`P2` backlog sa nesmie predbiehať pred týmito položkami. Ak agent narazí na
nejasný scope, najprv doplní reprodukciu alebo rozhodovací záznam do reportu;
nevyplní medzeru novou architektúrou iba preto, aby test prestal padať.

### PRISM-01 — implementačný handoff a aktuálny dôkaz

Commit `e701b05` pridal väčšinu nízkoúrovňového povrchu. Aktuálny worktree
implementoval celý host/UI handoff; zoznam nižšie zostáva audit trailom a
completion kontraktom, nie otvoreným návrhom na druhú session.

1. **A/B source of truth — DONE.** `EffectAbControls` už ukladá full
   snapshot do `deviceState.kind = "effect-ab-v1"` a má testovaný reload/undo
   flow. Runtime sloty v `fxeqNode.ts` sú iba audio-runtime cache, ale pri
   mount/rebuild sa hydratujú z toho istého persistovaného device state. Druhý
   nekompatibilný schema kind sa nepridal.
2. **A/B duplicita a lifecycle — DONE.** PRISM nesmie mať dve nezávislé sady A/B
   tlačidiel s rozdielnym správaním. Persistovaný A/B controller má byť miesto,
   kde používateľ ukladá a recalluje stav; morph slider je jeho rozšírenie.
   Recall je cancel-safe pri unmount-e, odstránení FX aj rýchlom A→B→A klikaní;
   zastaraný `setTimeout` recall sa nepoužíva.
3. **Live preview s históriou — DONE.** `Slider` podporuje `onPreview` a
   `AudioEngine.previewFxParam`; PRISM slidery posielajú live audio preview,
   zatiaľ čo commit ide cez `setFxEqParam`/existujúce command API. Pointer-cancel
   vracia audio runtime na dokumentovú hodnotu a neostáva v plugin history.
4. **External sidechain routing — DONE.** `fxeq-worklet.entry.js` a core
   sidechain prijímajú a `EffectRack.tsx` picker je dostupný aj pre `fxeq`.
   Zmena `sidechainTrackId` je súčasťou `fxSignature` a host po synchronizácii
   vykoná explicitný rewire path. Overené sú source selection, persisted source,
   fallback/idempotent disconnect a reálne PRISM browser routing.
5. **Async host contract — DONE.** `undoParam`/`redoParam` dnes používajú jednu
   callback queue s busy policy, takže druhý klik pred odpoveďou neprepíše prvú.
   Ošetrené sú double-click, dispose počas odpovede, malformed history reply a
   callback po reload-e; `syncFxParams` má history gate v `try/finally`.
6. **Browser acceptance — PRISM flow DONE; global release gates open.** Browser check teraz
   reálne otvorí PRISM, vyberie a overí sidechain source, uloží A aj B cez pointer
   drag, overí plugin undo/redo, morph, collapse/expand a reload persistence;
   samostatný browser suite zároveň prešiel real-worklet DSP, PDC, metery,
    sidechain render, export determinism a zero-error flow. Latest quiet
    Chromium beh prešiel `219/219`; predchádzajúci loaded run mal jeden
    `.preset-browser` bootstrap timeout, ktorý sa pri rerun-e zopakovaním
    nepotvrdil. Zostávajú full Vitest, manuálny device a deploy gates.

### PRISM-01 — presné done artefakty

Agent odovzdáva všetky body naraz v completion reporte:

| Oblasť      | Povinný dôkaz                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI          | `tests/ui/EffectRack.test.tsx` alebo dedicated `FxEqPanel` suite pokrýva dostupnosť, disabled/loading/error states, keyboard/pointer cancel a absenciu duplicitného A/B affordance |
| Host        | `tests/fxeq-host-integration.test.ts` pokrýva source rewire, dispose, async history queue a persisted slot hydration                                                               |
| Worklet/DSP | `tests/fxeq-worklet-entry.test.ts` + processor suite pokrývajú morph cancellation, history recording, redo semantics, sidechain OFF/mono/stereo a finite GR                        |
| Persistence | reload + `normalizeProject` + `deviceState` round-trip test; full snapshot map je finite, bounded a schema-valid                                                                   |
| Audio       | live/offline render parity, no NaN/Inf, latency/PDC unchanged, no click at morph/sidechain transitions                                                                             |
| Release     | typecheck, targeted tests, full Vitest, build/budget, browser dev + production smoke; thresholds sa nemenia                                                                        |

### REL-01 — reviewed scope ledger (updated 2026-09-13)

Nasledujúca tabuľka je ledger scope; PRISM implementation je commitnutý v
`a3dd6ba`, browser-verifier follow-up v `8912a09`, release hardening v
`cb1bde7`, audio runtime/perf batch v `d9dd58c`, PRISM crossover/render-quality
v `a768595`, tempo-sync/transfer-overlay UI v `2242541`, split hit-testing v
`64ca7e4`, test/evidence stabilization v `5f49140` a browser latency-probe
hardening v `4279467`, plus Ultina source/vendor reconciliation v `173f5ce`
(upstream source/test commit `c0a549d`) a FXEQ six-band crossover correction v
`699c8a3`. Commit `8f11255` je aktuálny reviewed functional/test baseline;
`dfaf230` synchronizuje jeho generated PRISM worklet. Working tree má navyše
iba oddelený continuity log.
Je to release bookkeeping, nie dôkaz, že verejný deploy alebo celý KYX release
je hotový. Každý ďalší agent
najprv skontroluje `git status`, `git show --stat HEAD` a tento ledger; nový diff
musí dostať vlastného ownera, test a rozhodnutie.

| Scope                                               | Súbory                                                                                                                                                                                                                                                                                                                                        | Owner / dôvod                                                                                         | Dôkaz                                                                                                                                                              | Rozhodnutie                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| PRISM host workflow surface                         | `src/effects/fxeq-core/core/commandHistory.ts`, `src/effects/fxeq-core/core/fxEqProcessor.ts`, `src/effects/fxeq-worklet.entry.js`, `src/effects/fxeqNode.ts`, `src/effects/types.ts`, `src/audio-engine/AudioEngine.ts`, `src/ui/FxEqPanel.tsx`, `src/ui/fxeqCurve.ts`, `src/ui/EffectRack.tsx`, `src/styles.css`, `public/fxeq-worklet.js`, `tests/fxeq-*.test.ts` | DSP/host/UI owner; technický surface pre morph, undo/redo, GR, sidechain, tempo-sync, transfer overlay a six-band crossover surface | current focused PRISM batch `115/115`, UI/curve suite `18/18`, typecheck, build, 8/8 golden cases within tolerance; current Chromium `219/219`; full Vitest `236/2319/103`; manual/deploy/formatting owner gates remain open | **IMPLEMENTED IN `a3dd6ba` + `a768595` + `2242541` + `64ca7e4` + `699c8a3` + `8f11255` + `dfaf230`**; owner gates remain open |
| Instant Jam transport boundary + follower scheduler | `src/collab/transportSync.ts`, `src/collab/CollaborationProvider.ts`, `src/services.ts`, `tests/collab-transport.test.ts`                                                                                                                                                                                                                     | collab/audio-runtime owner; ochrana pred malformed awareness payloadom a oprava remote play lifecycle | transport `10/10`, collab subset `79/79`, typecheck                                                                                                                | **LAND / retain** schema guard aj transition testy                                                                 |
| MPE compatibility fallback                          | `src/ui/MpeIndicator.tsx`, `tests/ui/MpeIndicator.test.tsx`                                                                                                                                                                                                                                                                                   | MIDI/UI owner; staršia embedded facade nesmie zhodiť celý MIDI panel                                  | targeted MPE/MIDI `6/6`                                                                                                                                            | **LAND / retain** inactive fallback                                                                                |
| Biquad non-finite state recovery                    | upstream `D:/VocalForge_DAW/plugins/fxeq/src/dsp/biquad.ts`, upstream `D:/VocalForge_DAW/plugins/ozvena/src/dsp/biquad.ts`, vendored `src/effects/fxeq-core/dsp/biquad.ts`, vendored `src/effects/ozvena-core/dsp/biquad.ts`, generated `public/fxeq-worklet.js`, `public/ozvena-worklet.js`, `tests/fxeq-ozvena-biquad-hardening.test.ts`    | DSP/audio owner; jeden chybný frame nesmie otráviť rekurzívny filter na zvyšok session                | host regression `4/4`; upstream guard + vendor/worklet rebuild                                                                                                     | **LAND / retain** upstream→vendor process, needitovať vendored core ako nový source-of-truth                       |
| Browser timing measurement + release evidence       | `src/browser-checks.ts`, `scripts/verify-browser.mjs`, `AGENT_WORK_LOG.md`, `RELEASE_READINESS_REPORT.md`, tento roadmap                                                                                                                                                                                                                      | current quiet Chromium `219/219`, Microsoft Edge `218/218` and automated Firefox `218/218`; all audio/DSP/FXEQ checks pass including latency `119/119` and hard CPU; ranker missing/offline, hash-mismatch and timeout fallback probe passes; production browser smoke PASS; build/preflight/server smoke pass; full Vitest `236/2319/103` | **OWNER GATES REMAIN** manual device/deploy/formatting                                                             |
| Ultina contract/DSP source-of-truth reconciliation  | `D:/VocalForge_DAW/plugins/ultina/src/contracts/parameter{Ids,Schema}.ts`, `plugins/ultina/src/dsp/modules/{eqModule,exciterModule}.ts`, vendored mirrors, `public/ultina-worklet.js`, `tests/ultina-contract-params.test.ts` | VLYX/DSP owner; Pre-Emphasis is now live at values 1..3, transient/sustain EQ is isolated, and future vendor syncs cannot overwrite dirty hardening silently | host contract `8/8`; upstream affected `105/105`; local source/vendor equality after mechanical header transform; worklet rebuild; focused battery `137/137` | **COMMITTED LOCALLY IN `173f5ce`; upstream source/test committed in `D:/VocalForge_DAW` as `c0a549d`** |
| Formatting-only test diffs                          | `tests/ultina-hardening2.test.ts`, `tests/ultina-worklet-entry.test.ts`                                                                                                                                                                                                                                                                       | QA hygiene owner; iba Prettier layout, žiadna runtime zmena                                           | diff je syntakticky/semanticky formatting-only; Ultina battery `55/55` + `26/26`                                                                                   | **LAND iba ako súčasť výslovne reviewed batchu**; inak izolovať do samostatného formatting commitu                 |

Ak sa po tomto bode objaví nový súbor v `git status`, agent ho musí doplniť do
ledgeru alebo odstrániť iba po preukázaní, že ide o cudzí/nezamýšľaný artefakt.

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
- nové project exporty používajú verejnú príponu `.kyx.json`; legacy `.pulseforge.json`
  ostáva podporované pri importe,
- explicitný host seed pre PRISM/FXEQ s rovnakou hodnotou v live/offline chain,
- VLYX upstream hardening: Sculptor sparse-spectrum guard, stereo T/S isolation,
  crossover re-prepare invalidation a Phase Time Shift dry/delta capacity,
- VLYX Pre-Emphasis is now a real upstream DSP contract: enum value 0 remains
  flat for backward compatibility, values 1..3 drive the exciter shelf around
  saturation, and the inverse state is continuous across render blocks;
  `eq.channelMode` 3/4 now isolates transient/sustain components in both
  stereo channels,
- VLYX Mix Assist/Reference Match host-side worker with transferable audio,
  explicit cancellation and recoverable worker errors,
- SCOREPACK export uses the shared abort controller and cancels cleanly at
  stage boundaries,
- VLYX loudness analysis now uses sample-rate-derived 400 ms integration
  blocks while retaining the documented simplified K-weighting model,
- VØID true-stereo factory IR layout now interleaves LL/LR/RL/RR correctly;
  factory IR spectra are cached on the main thread while each delivery gets a
  fresh mutable convolver ring,
- VØID pre-delay reserves its complete supported range during `prepare()`;
  live delay/tempo changes no longer resize or copy audio buffers from the
  render path,
- browser FXEQ realtime timing gate now reports three warmed samples and uses
  their median; the `2902 µs` one-quantum threshold is unchanged, so host
  timer/GC spikes are visible in the report without weakening the actual gate,
- persistence failure paths now surface retryable errors: frozen-audio saves
  cannot silently claim durability, library actions keep optimistic session
  state while reporting IndexedDB failure, and snapshot list/rebuild skips
  isolated unreadable rows,
- zjednotený persistovaný A/B controller pre PRISM/VLYX/VØID shell s
  undo-preserving recall; PRISM morph surface je napojený na `effect-ab-v1`
  a runtime sloty sa hydratujú pri mount/rebuild,
- PRISM/FXEQ core + worklet + host adapter surface pre precompiled morph,
  redo-aware plugin history, limiter gain-reduction snapshot a sidechain input;
  host/UI workflow je implementovaný a browser-accepted,
- gallery report/delete moderation flow s rate-limitom, admin auth a privacy policy,
- server-side moderation DELETE limiter, bounded per-IP limiter state a
  production CORS fail-fast guard,
- `release:preflight` overuje production CORS config, voliteľný gallery admin
  token, KYX manifest a všetkých päť shipped worklet artefaktov pred deployom,
- `release:server-smoke` spúšťa skutočný collab-server entrypoint v production
  režime a overuje health, CORS, origin rejection a admin auth contract,
- `release:deployed-smoke` je pripravený pre skutočný app/collab host: kontroluje
  app shell, KYX manifest, päť workletov, service worker, health, presný CORS
  allowlist, rejected origin a voliteľný gallery admin auth; lokálny preview +
  lokálny production collab probe prešiel,
- VLYX hardening battery `tests/ultina-hardening2.test.ts` uzatvára ďalších šesť
  edge-case kontraktov (LR4 mid-band, non-finite recovery, M/S single-band
  aliasing, dynamicTilt coefficient reset, Phase re-entry a stale comp meters);
  upstream `tests/preReleaseHardening.test.ts` má rovnaké kritické oracle testy,
  vendor bol znovu synchronizovaný a `public/ultina-worklet.js` rebuildnutý,
- Instant Jam shared-transport awareness payload má runtime schema guard:
  nefinite/out-of-range BPM, tick alebo malformed sender metadata sa zahodia
  pred zásahom do `Transport`/scheduler; `tests/collab-transport.test.ts`
  pokrýva 10/10 kontraktov; remote play transition zároveň štartuje scheduler
  až po úspešnom re-anchorovaní a remote pause/stop ho vždy zastaví,
- `release:preflight` skenuje aj shipped HTML/JS/CSS na starý verejný brand;
  kompatibilné import prefixy a zámerný Qvester interoperability text ostávajú
  povolené,
- regression tests pre každý z vyššie uvedených kontraktov.
- core AudioWorklet packaging: `core-processor.js` sa v production už nespolieha
  na Vite `data:` URL, ale na hierarchické self-contained artefakty
  `public/bitcrusher-worklet.js` a `public/core-worklet.js`; oba majú release
  preflight aj samostatný bundle budget,
- master limiter fallback používa pre `DynamicsCompressorNode.threshold` správne
  dBFS ceiling hodnoty a má source-grep regresný test.
- Intent Engine binding pre key/BPM/role constraints, deterministicý local
  provider s repair/fallback diagnostics a provenance v generation metadata.
- current instrument/runtime hardening: dedicated Granular voice worklet with
  live playhead and deterministic seeded grains, MPE timbre (CC74) routing,
  Bass polyphony 8 voices, and a bounded 64-voice one-shot ceiling,
- Intent candidate-bank generation with deterministic seeds, quality scoring
  and provenance for the selected candidate; model caches reuse immutable
  Markov/melodic source data without changing generation semantics.
- Intent `features.v1` extractor and ONNX ranker are present as a
  shadow/fallback-only WIP: feature vectors, candidate-batch ranking, a
  hash-pinned 24.7 KB model, ESM Worker packaging and direct production
  inference smoke exist, but the normal synchronous create/apply pipeline does
  not activate the model and no claim of musical superiority is allowed yet.

### Čo ešte potrebuje release triage

Reviewed local baseline `dfaf230` je čitateľný; functional/test baseline je
`8f11255`; PRISM implementation je v
`a3dd6ba`, browser-verifier follow-up v `8912a09`, crossover/render-quality v
`a768595`, tempo-sync/transfer-overlay UI v `2242541`, split hit-testing v
`64ca7e4`, browser latency hardening v `4279467`, FXEQ six-band crossover
correction v `699c8a3`, generated worklet sync v `dfaf230` a Ultina
source/vendor reconciliation v `173f5ce`.
VocalForge upstream source/test counterpart k Ultine je commitnutý ako
`c0a549d`; local vendor/worklet je obsahovo zosynchronizovaný a ďalší vendor
sync je chránený dirty-upstream preflightom. FXEQ crossover correction je
commitnutý a jeho current focused coverage je uvedená v scope ledgeri.
Nasledujúce body sú commitnutý technický scope alebo otvorené release
rozhodnutia; commitnutie samo osebe neznamená, že je feature user-facing a
release-safe:

- AutoMap už nie je iba helper: je integrovaný do drop/import proposal flow,
  má explicitné `PREVIEW`/`CANCEL`/`APPLY MAP`, jednu undoable layer command
  operáciu a unit/UI/browser coverage. Pred release ešte treba potvrdiť
  reálny file-drag a export/import/collab parity v manuálnej matrixe;
- zmeny v `src/intent/`, `src/ai/` a `src/instruments/` musia prejsť samostatným
  diff reviewom, pretože zasahujú deterministickú generáciu, registry a live /
  offline audio parity;
- nový ONNX ranker WIP (`src/ai/features/`, `src/ai/ranking/`,
  `public/models/`, Python training tooling) je release-neutrálna shadow /
  fallback vrstva. Pred aktiváciou treba dokončiť held-out/golden evaluáciu,
  async pipeline integration, offline-cache contract a device budget; pred
  release sa nesmie prepnúť na `active` ani prezentovať ako AI quality gain;
- FXEQ render-path allocation audit: vendored PRISM oversampler/limiter now
  reuses internal buffers with explicit frame lengths; band quality changes no
  longer construct a compatibility object per block; VØID/FXEQ reverb FDN
  coefficient arrays are fixed-size and `modRateHz` uses an O(1) update path.
  The corresponding upstream FXEQ mirror was updated where its source surface
  matches. No performance threshold was raised;
- PWA shell audit: internal `golden-review/**` renders and the optional ONNX
  ranker model/runtime are excluded from Workbox precache. The latest build
  precaches 57 entries / ~4.0 MiB while the ranker remains explicitly
  on-demand;
- PRISM host workflow implementation v aktuálnom worktree má persistovaný A/B
  controller, live preview/cancel rollback, source picker + rewire, async
  history queue a runtime hydration; targeted/UI/browser acceptance je zelená.
  Release copy môže PRISM označiť ako implementovaný, ale nie ako celý KYX
  release-approved, kým neprejdú globálne QA/deploy gates;
- PRISM crossover/render-quality v `a768595` pridáva kanonické LR2/LR4/LR8
  voľby, phase equalization a voliteľný 8× offline quality tier. Vlastný
  targeted suite (`20/20` crossover tests + `2/2` render-quality tests),
  generated `public/fxeq-worklet.js` review, typecheck, build a Chromium
  `219/219` acceptance už prešli a full Vitest je `236/2319/103`; owner gates
  zostávajú otvorené;
- PRISM UI v `2242541` dokončuje Q2 tempo-sync enum rendering ako hudobné
  voľby a kreslí LR crossover window + per-band transfer overlay; `64ca7e4`
  dopĺňa effective split normalization pre canvas/hit-test. `699c8a3` dopĺňa
  `crossoverFreq6` až do DSP/worklet/schema surface a odstraňuje dead-band/
  crossed-split stav v 6-band defaultoch. Targeted UI/curve test je teraz
  `18/18`; current quiet browser acceptance je `219/219` na `f07a4e2` a full
  Vitest je `236/2319/103`. Current implementation gates sú zelené;
  zostávajú owner/manual/deploy/formatting rozhodnutia;
- agent nesmie tieto súbory prepisovať, squasovať ani vyhadzovať bez toho, aby
  najprv zaznamenal vlastníka zmeny a dôvod rozhodnutia v completion reporte.

Overené príkazy a výsledky:

| Gate                                                       | Výsledok                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck:clean`                                  | PASS                                                                                                                                                                                                                                                                                                                                                       |
| full Vitest (single-worker authoritative run)              | **PASS — 236 files, 2319 passed, 103 skipped, 2422 total** in 1760.09s; includes the soak-heavy suite and no threshold changes |
| `npm run build` + worklet buildy + bundle budget           | PASS — current candidate: entry 938 KB / 995 KB, total JS chunks 1849 KB / 2400 KB, core worklets 98 KB / 120 KB, 356 modules; PWA precache 57 entries / 4038.21 KiB; lazy ranker WASM is 13.6 MB and excluded from the app-shell precache                                                                                                                  |
| `npm run build:ultina`                                     | PASS — rebuilt `public/ultina-worklet.js`                                                                                                                                                                                                                                                                                                                  |
| `npm run test:browser`                                     | **PASS — final quiet rerun 219/219 Chromium on `f07a4e2`**; all audio/DSP/FXEQ checks pass (including latency `119/119`, multi-instance CPU `42.6%` and template performance); UI bootstrap, PRISM workflow, collab, embed/share and touch pass; explicit ranker missing/offline, hash-mismatch and timeout fallback probe also passes; two earlier noisy retries had isolated timing misses, with no threshold change                                                                                                                                                                          |
| `npm run test:browser:production`                          | **PASS** — dist boot, HOUSE template, sequencer, FX rack, all shipped worklet assets and ONNX worker smoke                                                                                                                                                                                                                                                                   |
| Post-`cb1bde7` hardening regression batch                  | PASS — 48/48 targeted tests + 300 s PRISM soak (6.0 MB heap growth, −0.003 dB drift, zero non-finite samples, zero tail peak); current full suite is also green                                                                                                                                                                      |
| `npm run release:preflight`                                | **PASS** — explicit `NODE_ENV=production`, production origin, KYX artifacts and shipped-brand scan                                                                                                                                                                                                                                                                                                   |
| `npm run release:server-smoke`                             | PASS — real entrypoint health/CORS/origin/admin contract                                                                                                                                                                                                                                                                                                   |
| `npm run release:deployed-smoke`                           | **BLOCKED — `KYX_DEPLOY_URL` missing**; local fresh-dist/deployed-like probe is documented separately, but actual public URL is still required for DEP-01                                                                                                                                                                                                  |
| VLYX hardening2 + upstream parity battery                  | PASS — host `8/8` contract + `ultina-core-hardening` `55/55`, worklet/parity/vectors `28/28`; upstream affected suite `105/105`; source/vendor equality checked after mechanical header transform                                                                                                                                                        |
| `tests/collab-transport.test.ts`                           | PASS — `10/10`; malformed awareness payloads are rejected and remote play scheduler transition is covered                                                                                                                                                                                                                                                  |
| PRISM/FXEQ + VLYX + VØID targeted Vitest suite             | PASS — current focused PRISM batch `115/115`; crossover hardening, worklet, rack, morph and golden cases are green; golden parity is 8/8 within tolerance (7/8 bit-exact, one documented legacy split difference)                                                                                                                        |
| upstream Ultina affected suite                             | PASS — 105/105 tests; source/test changes are committed in `D:/VocalForge_DAW` as `c0a549d`                                                                                                                                                                                                                                                               |
| VLYX analysis worker client suite                          | PASS — 4/4 tests                                                                                                                                                                                                                                                                                                                                           |
| persistence failure/recovery targeted suite                | PASS — 28 passed / 1 skipped                                                                                                                                                                                                                                                                                                                               |
| VØID upstream/pre-delay + factory-IR hardening             | PASS — 49/49 targeted upstream tests; 72/72 host/worklet tests                                                                                                                                                                                                                                                                                             |
| affected post-fix suites (`services-close-race`, `TopBar`) | PASS — 20/20 tests                                                                                                                                                                                                                                                                                                                                         |
| scoped Prettier + `git diff --check`                       | PASS                                                                                                                                                                                                                                                                                                                                                       |

Posledný dokončený kompletný `npm test` beh je release-green: `236` súborov,
`2319` testov prešlo, `103` bolo zámerne skipped (`2422` total) v single-worker
  behu za `1760.09s`. Staršie červené behy nižšie zostávajú historickým evidence
shared-machine contention a nepredstavujú aktuálny stav kandidáta.
224 súborov, 2152 testov prešlo, 162 bolo zámerne skipped a 5 zlyhalo.
Zlyhania sú dva Ozvena hook timeouty po 10-minútovom soak teste a tri merané
časové budgety pod shared-machine contention. Ozvena `59/59`, collab
performance, VLYX HQ aj veľký normalize test prešli v cielenom izolovanom
behu; funkčná regresia nie je potvrdená. PRISM suite v tomto behu nemá
failure. Quiet rerun je povinný. Neskorší single-worker pokus bol po dlhom
období bez výstupu manuálne ukončený, takže nepredstavuje nový PASS ani nový
failure count.
Predchádzajúci historický beh pred poslednou biquad recovery a allocation opravou
bol tiež červený: 1 zlyhanie, 2113 passed, 103 skipped (211 súborov, 2217 testov).
Profilovanie ukázalo dve konkrétne triedy render-path práce: `subarray()`
view/copy churn v FXEQ oversampler/limiteri a reverb `recompute()` alokácie
počas A/B morphu. Oprava je v zdroji aj shipped FXEQ worklete; cielený post-fix
performance gate je 3/3, s full-load median/p95 ratio 17.6×/6.7× a morph ratio
2.00× pri limitoch 22×/25×/2.4×. Po finálnom land/commit treba suite ešte
zopakovať na reviewed release strome; host contention je v tomto workspace
samostatný zdokumentovaný faktor. Zámerné
stderr z recovery testov, jsdom canvas a test-only act warnings nie sú samy
osebe production errors.

`npm run format:check` na celom strome je stále červený kvôli 209 zdokumentovaným formatting deviations. Presný, command-generated zoznam je v [`docs/FORMAT-CHECK-DEVIATIONS.md`](./FORMAT-CHECK-DEVIATIONS.md). Pred release treba buď vykonať samostatný formatting-only cleanup, alebo tento zoznam explicitne akceptovať v CI gate; nesmie sa to maskovať zmenou scope checku.

Ešte povinné pred verejným deployom: manuálny Firefox/Safari/iOS smoke podľa
[`docs/KYX-MANUAL-RELEASE-CHECKLIST.md`](./KYX-MANUAL-RELEASE-CHECKLIST.md),
reálne audio zariadenia, produkčný CORS origin, deploy/server health check a
end-to-end refresh/tab-close recovery na produkčnom hoste.

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
- VLYX analysis host bridge: `src/analysis/ultinaAnalysisClient.ts`, `src/analysis/ultinaAnalysisWorker.ts`,
- persistence a recovery: `src/persistence/`, `src/export/project-io.ts`, `src/export/scorepack.ts`,
- collaboration/backend: `src/collab/`, `server/collab-server.mjs`,
- testy: `tests/` a browser smoke testy v konfigurácii projektu.

V repozitári už existuje:

- 14 instrument kinds vrátane sampleru, synthov, wavetable, granular, keys, pluck, log drum, spectral pad, vocal chop a drum synth,
- tri flagship efekty PRISM, VLYX a VØID plus širší FX registry,
- preset browser s vyhľadávaním, filtrami, favorites, recent a user presetmi,
- sample preview cez `services.engine.previewAsset`,
- preview infraštruktúra v `AudioEngine` / `GhostPreviewPlayer`,
- plugin A/B ovládanie cez `EffectAbControls` aspoň pre PRISM a VØID,
- VLYX vlastný A/B, gain-match, delta, reference match, EQ learn a mix assist,
- Beat Focus režim v `Sequencer.tsx`,
- DICE, Assist a Arrangement workflow,
- autosave/snapshot infrastructure a lokálna collaboration vrstva.

Kanonický aktuálny počet a poradie nástrojov je `INSTRUMENT_ORDER` v
`src/instruments/registry.ts` spolu s `InstrumentKind` v
`src/instruments/types.ts`. Staršie produktové roadmapy môžu obsahovať historický
počet; pri implementácii má prednosť kód a normalizácia v
`src/project-model/schema.ts`.

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

- [x] deterministický PRISM/FXEQ export (core, host seed aj browser
      `serialize → reload → offline bounce`; 219/219 Chromium gate),
- [x] odstránenie potvrdených VLYX DSP regresií (upstream → vendor → worklet),
- [x] hardening VØID IR/pre-delay runtime allocations; reálne device footprint
      meranie ostáva manuálny release krok,
- [x] export clipping/tempo/marker policy; zámerné residuals sú v §6.4 a
      `KNOWN_LIMITATIONS.md`,
- [x] ne-deštruktívny preset audition pre nástroje,
- [x] persistovaný generický A/B a gain-match kontrakt pre flagship shell,
- [x] PRISM morph/undo/sidechain host workflow — implementované a browser-
      accepted v aktuálnom candidate; `219/219` quiet Chromium a full Vitest
      `236/2319/103` prešli, manuálny/device/deploy release kroky zostávajú,
- [x] recovery, reload a export/import smoke v automatizovanom Chromium flow;
      tab-close/production-host recovery ostáva manuálny release krok.
- [x] FXEQ full-load realtime gate: allocation path je opravený, cielený aj
      full-suite/browser gate prešiel bez oslabenia limitov; owner device/deploy
      release kroky zostávajú samostatne otvorené.

### P1 — najväčší UX dopad

- [x] Simple/Advanced instrument workflow,
- [x] jednotný plugin shell a focus/keyboard správanie,
- [x] mixer metering, clip feedback a batch operácie,
- [x] DICE → preview → lock → vary → arrange flow,
- [x] Beat Focus session/shortcut polish,
- [x] verejná branding konzistencia a release documentation.

### P2 — po release alebo iba ak neohrozuje P0/P1

- [ ] ďalšie sound packs a preset curation,
- [ ] pokročilejšie routing templates,
- [ ] cloud účty, serverová persistentná databáza alebo komplexná moderácia,
- [ ] nový flagship plugin alebo veľký instrument expansion.

P2 neznamená „zabudnuté“. Znamená to, že tieto veci nesmú ohroziť prvý release.
Každý budúci agent si vyberie konkrétny balík, nie neurčité „polish všetkého“:

#### P2.1 — Sampler ingestion: keyzones, velocity a round-robin — [x] implemented

**Cieľ:** import viacerých pomenovaných sample súborov bez ručného kreslenia
každého layeru.

**Touchpoints:** `src/samples/autoMap.ts`, `src/ui/DropZone.tsx`,
`src/ui/SampleBrowser.tsx`, `src/commands/layerCommands.ts`,
`src/project-model/types.ts`, `src/project-model/schema.ts`,
`src/audio-engine/AudioEngine.ts`, `tests/automap.test.ts`.

**Poradie implementácie:**

1. uzamknúť filename convention pre root note, velocity a RR counter;
2. dokončiť parser a deterministic ordering bez použitia UUID/timestampu na
   rozhodovanie;
3. integrovať preview importu s explicitným `Apply`/`Cancel`;
4. uložiť vrstvy cez existujúce layer commands a normalizáciu;
5. overiť overlapping velocity/RR výber, keyzone hranice, missing asset,
   reload, export/import, collaboration a live/offline render.

**Done:** nový používateľ pretiahne multi-sample set, vidí navrhnuté zóny,
počuje preview, vie návrh odmietnuť alebo aplikovať jednou undo operáciou a
rovnaký projekt dá rovnaký sample výber po reload/renderi. Samotná helper
funkcia bez UI integrácie sa za hotovú feature nepočíta. Aktuálny stav túto
podmienku spĺňa; manuálny file-drag a cross-browser/device parity ostávajú
release QA krokom.

#### P2.2 — Modulation matrix rollout

**Cieľ:** rozšíriť už zavedený modulation contract na ďalšie nástroje bez
kopírovania nových ad-hoc routovacích grafov.

**Touchpoints:** `src/instruments/modmatrix.ts`,
`src/instruments/registry.ts`, `src/audio-engine/AudioEngine.ts`,
`src/project-model/schema.ts`, `src/ui/Inspector.tsx`,
`src/rendering/renderer.ts`, instrument tests a browser parity checks.

**Done:** každý rollout má explicitnú neutralitu pri `amount = 0`, live update,
automation/p-lock, polyPressure/MPE podľa capability, dispose pri stop/panic,
fallback a bit-stabilný alebo toleranciou definovaný offline výsledok.

#### P2.3 — Onboarding, templates a sound discovery

**Cieľ:** skrátiť cestu od prázdneho projektu k prvému dobrému beatu bez
zahltenia používateľa ďalšími controls.

**Touchpoints:** `src/ui/ProjectBrowser.tsx`, `src/ui/GenerateDialog.tsx`,
`src/ui/DiceTray.tsx`, `src/ui/Inspector.tsx`, `src/presets/factory.ts`,
`src/presets/`, relevantné UI/browser tests.

**Done:** nový používateľ vie vytvoriť beat, nájsť vhodný preset a pochopiť
scope Preview/Apply/Undo bez návodu; template je iba project data, nie druhý
audio engine; onboarding nezapisuje neviditeľné zmeny do projektu.

#### P2.4 — Routing templates a collaboration expansion

Tieto balíky sa môžu začať až po product/security rozhodnutí. Pred
implementáciou treba definovať permission model, persistence model, migráciu,
rate limits, rollback a privacy policy. Bez toho sa nepridáva účet, cloud DB,
komplexná moderácia ani veľký server rewrite do kritického create/play/export
flow.

#### P2.5 — Intent AI-assisted candidate ranking — shadow-only WIP

**Cieľ:** zúžiť viac validných deterministic kandidátov na najvhodnejší návrh
pomocou verzovaného feature contractu a lokálneho ONNX Worker-a, bez toho, aby
model generoval alebo mutoval pattern.

**Aktuálne touchpoints:** `src/ai/features/pattern-features.ts`,
`src/ai/ranking/ranker-types.ts`, `src/ai/ranking/ranker-client.ts`,
`src/ai/ranking/ranker-worker.ts`, `src/ai/ranking/rank-candidates.ts`,
`src/intent/providers/local.ts`, `public/models/`,
`scripts/generate-intent-ranker-dataset.mts`,
`scripts/train-intent-ranker.py`, `scripts/validate-intent-ranker.mjs`,
`scripts/sync-ort-assets.mjs`, `public/models/ort/`,
`tests/pattern-features.test.ts`, `tests/rank-candidates.test.ts`.

**Čo je implementované:** 54-position `features.v1` vector s clippingom,
UUID-free hashom a presence flags; batch extraction/ranking nad validnými
kandidátmi; `off`/`shadow`/`active` flag s heuristic fallbackom; lazy ESM
Worker; CPU/WASM-only ONNX import; lokálny model + manifest hash verification;
timeout/circuit breaker; malformed-score validation; production build a
Chromium smoke, ktorý skutočne načíta Worker, WASM a model; browser fallback
probe pre missing/offline manifest, hash mismatch a timeout. Default je
`shadow` a bežný sync command pipeline naďalej používa heuristic ranking.

**Ďalšie kroky pred prípadným `active`:**

1. preukázať held-out golden preferencie odlišné od teacher heuristiky;
2. zapojiť async pipeline do explicitného preview flowu bez blokovania command
   apply, undo/redo, autosave, collab a offline export invariants;
3. browser test missing-model/hash-mismatch/timeout fallbacku je hotový
   (`219/219`); reload/offline-cache a device cold-start evidence ostáva pre
   P2.5 device gate;
4. zmerať cold-start, WASM memory a preview budget na Safari/iOS a slabom
   zariadení;
5. až potom oddelene rozhodnúť o engine/ranker version bump a rollout guard.

**Done:** ranker mení výber iba po explicitnom release rozhodnutí, má kvalitnú
held-out evaluáciu, stabilnú provenance, UX opt-out a browser/device dôkaz.
Kým tieto podmienky nie sú splnené, model je iba diagnostický shadow signal a
heuristika je jediný release-safe výber.

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
npm run test:browser:production
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

#### Evidence v aktuálnom pracovnom strome

- [x] všetky identifikované stateful PRISM random streams používajú deterministický
      default alebo explicitný host seed,
- [x] `AudioEngine` odvodzuje seed stabilne z projektu, ownera a FX identity a
      `fxeqNode` ho forwardingom pošle do workletu,
- [x] core regression pokrýva reset, rovnaký seed pri viacerých inštanciách a
      zámernú odlišnosť pri inom seed; rack contract pokrýva seed forwarding,
- [x] browser-level test `serialize → reload → offline bounce` beží v
      `src/browser-checks.ts`; dve PRISM worklet inštancie po JSON/migration
      round-tripe ostali pod max-sample toleranciou `1e-5` (Chromium gate 219/219).

### 6.2 VLYX upstream kvalita

**Owner:** VLYX/DSP agent  
**Súbory:** upstream `D:/VocalForge_DAW/plugins/ultina`, potom vendor/build output; host testy v `tests/`

#### Potvrdené prípady — stav

- [x] Sculptor pri sparse/silent band nesťahuje všetky aktívne pásma,
- [x] Transient/Sustain neprepúšťa stereo L do R,
- [x] reprepare existujúcej inštancie neresetuje LR4 crossover do identity,
- [x] Phase Time Shift nad približne 4 ms správne kompenzuje dry/wet a delta,
- [x] mix assist/reference match analýza beží v host-side workeri, takže dlhší materiál neblokuje main thread; UI má busy/cancel/error stav.
- [x] loudness integration používa sample-rate-derived 400 ms bloky.

#### Akceptačné kritériá

- štyri vyriešené DSP regresie majú upstream test, host regression test a nový
  vendored/worklet artefact,
- live/offline parity je overená na krátkom aj dlhšom fixture,
- analysis busy/cancel/failure stav je viditeľný v UI a neblokuje editor,
- pri nedostupnom upstream repozitári agent nahlási blocker; nesmie patchovať vendored core ako skratku.

### 6.3 VØID runtime hardening

**Owner:** VØID/audio agent  
**Súbory:** upstream/vendor VØID core, `src/ui/OzvenaPanel.tsx`, `src/ui/EffectRack.tsx`, príslušné testy

#### Implementácia

- [ ] zmerať IR loading a pripravený pre-delay footprint na reálnych browser zariadeniach,
- [x] odstrániť audio-thread partition FFT allocation/copy; generovanie aj
      partition FFT batch bežia na hoste a worklet dostáva transferované spektrá,
- [x] pre-delay buffer je rezervovaný pri `prepare()` pre celý podporovaný
      rozsah; parameter/tempo zmeny už nerastú v audio callback ceste,
- [x] pridať loading/ready/error stav pre IR bez falošného dojmu, že efekt je aktívny,
- [x] automaticky overiť bypass, reload, viac VØID delivery ciest a offline
      render; manuálna cross-browser/device QA ostáva release gate.

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

Aktuálny stav: head-trim, `stretchRate`, sample-rate/bit-depth policy a deterministicý
render sú pokryté testami. Marker cue one-shoty zostávajú zámerne mimo master WAV,
ale `ExportPanel` pred exportom zobrazuje, že patria do SCOREPACK. Master/stem/track
offline render a scorepack jednotlivé render stage sa stále nedajú prerušiť
uprostred `OfflineAudioContext`; scorepack však po novom rešpektuje CANCEL medzi
stages a počas manifest/ZIP fázy. Panel vysvetľuje túto hranicu aj
frame-granularitu video kontajnera.

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
- všetkých 14 instrument kinds má validný default, preset a reset path,
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

Súčasný `server/collab-server.mjs` je jednoduchý in-memory server bez auth, s file-backed gallery a IP rate limitingom. Pred verejným launchom preveriť:

- limit počtu roomov a connections,
- limit veľkosti message/payload a bezpečné JSON parse failure,
- idle TTL a cleanup, aby memory rástla pod kontrolou,
- rate limit pre publish/play/report/delete operácie; limiter nesmie rásť
  bez hranice pri nových IP adresách,
- observability: structured error log, room count, connection count, rejected payload count,
- gallery moderation/report/delete flow a privacy text,
- CORS/origin policy pre produkčné domény; pri `NODE_ENV=production` alebo
  `enforceProductionConfig: true` wildcard CORS odmietnuť už pri štarte.
- production process musí bindovať na reachability interface platformy
  (typicky `HOST=0.0.0.0` v kontajneri), nie zostať na defaultnom loopbacke.

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
