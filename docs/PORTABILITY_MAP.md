# PORTABILITY MAP

> **Cross-platform readiness campaign — GOAL 01 deliverable** (2026-09-21).
> Answers: *which code is portable domain logic, which is bound to the browser
> runtime, and where are the seams a future Android / iOS / native
> implementation would have to replace?*
>
> Method: three parallel read-only sweeps over `src/` (browser/DOM coupling;
> Node/device/worker coupling; pure-domain + nondeterminism inventory),
> spot-verified against the source. Line references were accurate on the audit
> date. Companion documents: `CAMPAIGN_STATE.md` (campaign ledger),
> `docs/adr/0001-browser-first.md` (platform policy), `ARCHITECTURE.md`.

---

## 1. Classification of the codebase

Six categories per the campaign contract. **PURE** = runs and is testable in
bare Node; **MIXED** = core pure, some symbols/files touch the platform;
**BOUND** = requires the browser runtime.

| Area | Category | Notes and evidence |
|---|---|---|
| `src/project-model/*` | **PURE** (2 timestamp sites) | schema/transforms/groove/automation/modulators/scenes/templates/markers/kit-presets — no DOM, no storage. Only impurity: `new Date().toISOString()` backfill of createdAt/updatedAt (`schema.ts:1585,1589`, `templates.ts:180`) and `uid()` ids (`shared/ids.ts`). ⚠ Import-graph caveat: `schema.ts` + `targets.ts` pull `effects/registry` + `instruments/registry` for param metadata (pure data, but drags worklet node-factory modules + loader into every schema import). |
| `src/commands/*` | **PURE** | Commands are `(doc) → doc` closures (`commands.ts`, 6.3k lines, zero DOM/audio). yjs decoupling via the `yDocBridge` service-locator pattern (`yDocBridge.ts`) — inert unless the host registers helpers. |
| `src/store/*` | **MIXED (clock only)** | `ProjectStore` uses `Date.now()` for undo-coalesce windows / save-status only — never into the doc. `SelectionStore`, `ToolStore` pure. |
| `src/transport` | **PURE by injection** | `Clock` interface (`Transport.ts:3–7`); production injects `{ now: () => engine.currentTime }` (`services.ts:365`). |
| `src/scheduler` | **MIXED (deliberate seam)** | All host access flows through `SchedulerDeps` (`Scheduler.ts:9–100`) — the de-facto audio-host port. Own only `setInterval` (25 ms tick) + console. Already driven headless in tests. |
| `src/intent/*` (pipeline, plan, normalize, text-parser, candidate-bank, hash, schema) | **PURE** | Deterministic, seed-driven (`resolveEffectiveSeed`, `forkRandom`), `AbortSignal`-aware. |
| `src/intent/*` (favorites, audition, song-yield, dice fallback) | **MIXED → BOUND islands** | `favorites.ts` = localStorage ledger (`:94–141`); `audition.ts` = own `window.AudioContext` singleton (`:48–58`); `song.ts:940` `setTimeout(0)` yield; `dice.ts:51` wall-clock fallback seed (documented). |
| `src/intent/providers/*` | **MIXED (graceful)** | Import worker clients but degrade to heuristic/deterministic fallbacks when `Worker`/models are absent (`ranker-client.ts:49`, `prior-client.ts:56`). |
| `src/export/{shareCode,packCode,kitCode,bindsCode,themeCode,zip,quantize}.ts` | **PURE code / MIXED graph** | lz-string + validation + seeded dither (byte-identical exports). ⚠ `packCode.ts:2–3` imports `THEME_PRESETS` from `../ui/theme` and `normalizePadKeyMap` from `../ui/padKeys` — both import **React** (`useSyncExternalStore`), so React enters a pure encoder's graph. |
| `src/export/{project-io,mp3,video,scorepack,zyvo-transfer}.ts` | **MIXED → BOUND** | `project-io`: parse/validate/migrate pure; export = `downloadBlob` (see §4); import reads `FileReader`. `mp3.ts`: lame-wasm + Blob + yield timers. `video.ts`: canvas 2D + MediaRecorder + own AudioContext. `scorepack`/`zyvo`: bound via `renderProject` (OfflineAudioContext). |
| `src/rendering/{renderer,bounce,stems}.ts` | **BOUND, seam-isolated** | `renderer.ts:318–365` constructs the OfflineAudioContext and hands it to `engine.useContext(ctx)` — the sanctioned offline path. `stems.ts` (`buildStemProject`) is already a pure data transform. `wav.ts`: `encodeWav` pure; `downloadWav` → shared `downloadBlob`. |
| `src/audio-engine`, `src/audio-worklets`, `src/effects`, `src/instruments` (runtime halves) | **BOUND (Web Audio)** | The product core. Worklets are pre-built static files in `public/` loaded by root-absolute URL (`audio-worklets/loader.ts:28–33,108–109`). AudioNode creation outside the engine is pervasive **by design** (factories take a ctx param); the enforced invariant is *context creation + graph rebuild only via `AudioEngine`*. |
| `src/persistence/*` | **BOUND with one choke point** | IndexedDB confined to `db.ts` (`openDb`, DB_VERSION 12, `tx()` promise wrapper); repos are concrete classes. ⚠ `UserSampleRepository:197–203`, `FrozenBufferRepository:96–102`, `RecordingRecoveryRepository:231–247` decode audio via throwaway `OfflineAudioContext` — the *storage layer requires Web Audio* today. |
| `src/midi/{MidiInput,MidiOutput,MidiClock}.ts` | **BOUND** | `navigator.requestMIDIAccess` (fire-and-forget, try/catch → feature absent), `performance.now` clock. `midiFile.ts` (SMF codec) and `hum-to-notes.ts`, `patternRecorder.ts` are **PURE**. |
| `src/collab/*` | **BOUND (network)** | No raw WebSocket — y-websocket `WebsocketProvider` + `BroadcastChannelProvider`. `collabShared.ts:31–113` derives ws/wss endpoints from `location` (guarded by `isAllowedServerUrl`). `YDocAdapter` (Y.Doc ↔ ProjectDocument) is a pure converter. |
| `src/ui/*`, `src/embed`, `src/gallery`, `src/landing`, `src/download` | **UI-specific (expected)** | ~70 components; canvas/matchMedia/clipboard/confirm usage concentrated here. 8 components spin their own rAF loops instead of the shared `services/rafLoop.ts` (recorded, not a port blocker). |
| `src/services{,.ts}`, `src/services/*` | **Infrastructure (web-shaped)** | Composition root (`createCoreServices`, `openProject`) — where platform adapters would be threaded. `rafLoop.ts` = shared rAF bus; `funnel.ts` = localStorage counters. |
| `src/ai/*`, `src/analysis/*`, `src/reference/*` | **BOUND, degrade-by-design** | 10 workers, all `new Worker(new URL(...), { type: "module" })`, all with `typeof Worker` guards + sync main-thread fallbacks; models fetched from root-absolute `/models/...`. Zero raw `Math.random` — all seeded. |
| `src/pwa.ts`, `src/sw-update.ts` | **BOUND (Vite/workbox)** | Build-time precache config + `virtual:pwa-register` update banner (http(s)-gated). No equivalent outside the web shell. |
| `scripts/`, `server/`, `desktop/`, `src/browser-checks.ts` | **Infrastructure (Node/Electron, by design)** | `desktop/main.cjs` is a thin shell: `app://` protocol → `dist/`, silent mic+MIDI permission grants, `will-download` → native Save-As, electron-updater. `preload.cjs` exposes only `window.kyxDesktop.isDesktop`. `browser-checks.ts` (192 KB) is a dev-only harness imported solely by `scripts/verify-*.mjs` — never by app code. |
| `src/shared/*` | **PURE** | `rng.ts` (mulberry32/hashString/forkRandom), `ids.ts` (`uid` + test-only deterministic mode), `dice.ts`, `velocityFx.ts`. |

---

## 2. Coupling inventory (evidence highlights)

- **Browser globals in domain layers — nearly clean.** Real `window.*` /
  `document.*` access outside UI/route-apps: `services.ts:770–808`
  (visibilitychange gating), `main.tsx` (routing, `kyxDesktop`, handoff),
  `export/*` + `rendering/wav.ts` + `midi/midiProject.ts` (download pipeline —
  now consolidated, §4), `collab/collabShared.ts` (location-derived URLs),
  `collab/bandmate.ts:455`, `intent/audition.ts:51`,
  `effects/fxeq-core/core/presets.ts:962–998` (vendored, globalThis DI seam),
  `audio-engine` mic/latency paths. **Zero** `alert/confirm/prompt` outside
  `window.confirm` in 7 UI files. **Zero** WebGL / OffscreenCanvas / XHR /
  sendBeacon / EventSource in `src/`.
- **Node builtins in `src/` — clean.** No `fs/path/os/crypto/child_process`,
  no `require`, no `__dirname`. One benign macro: `process.env.NODE_ENV` in
  `commands/commands.ts:132` (`isDev()`, Vite-dead-code-eliminated; a native
  toolchain must define it). Zero `import.meta.env` in app code (18 ×
  `import.meta.url` for worker/worklet URLs — standard).
- **Timers in domain modules:** scheduler tick, MIDI clock, sidechain poll
  (`effects/registry.ts:2423`), yield-to-UI `setTimeout(0)` in
  `intent/song.ts:940` + `export/mp3.ts:46`. `project-model`, `commands`,
  `store`, `transport`: **timer-free**.
- **Storage:** exactly one file touches `indexedDB` (`persistence/db.ts`).
  localStorage/sessionStorage spread across UI, gallery, ai flags, engine
  calibration prefs, intent favorites, sample-library, funnel — all
  per-device preferences by design, none are project data.
- **File I/O:** no File System Access API anywhere (deliberately portable).
  Open = `<input type="file">` (5 UI sites) + drag-drop; save = the shared
  `downloadBlob` boundary (§4). Electron bridges via `will-download`.
- **Workers/worklets:** 10 workers (inventory in audit; every client degrades
  to a sync fallback when `Worker` is unavailable), ~30 worklet node
  factories, static worklet bundles served from `public/` by root-absolute
  URLs. The one bundled-URL worklet is the latency probe.
- **Platform detection:** 32 `typeof X !== "undefined"` guards (AudioContext,
  OfflineAudioContext, MediaRecorder, Worker, navigator MIDI, location) —
  all fail soft; one `webkitAudioContext` fallback (audition.ts); Electron
  detect via `window.kyxDesktop`; PWA banner http(s)-gated.

## 3. Sanctioned seams a port can build on

1. `AudioEngine.useContext(ctx)` — context creation + graph rebuild in one
   place; offline renders already flow through it.
2. `Clock` interface (transport) + `SchedulerDeps` (scheduler) — time and the
   audio host are already injected; scheduler runs headless in tests.
3. `persistence/db.ts` `openDatabase` injection (3 of 11 repos) +
   `autosave-debouncer` injectable `now/setTimeout/clearTimeout` — the
   in-repo template for contract-izing storage (GOAL 02/03).
4. `yDocBridge` register/consume service-locator — proof the codebase
   decouples optional platform chunks from pure core.
5. `fxeq-core` `globalThis` browser-DI seam (vendored) — capability-checked
   DOM usage without DOM imports.
6. Worker clients' uniform `typeof Worker` degradation + job/timeout/breaker
   wrappers (`src/ai/*-client.ts`).
7. `shared/ids.ts` deterministic id mode (`useDeterministicIds`) — proves doc
   ids can be made reproducible; `shared/rng.ts` seeded streams.
8. Composition root `src/services.ts` (`createCoreServices`/`openProject`) —
   single place to thread a future platform-adapter object.

## 4. Repairs taken in GOAL 01 (small, safe, evidence-backed)

1. **Single save boundary.** The `Blob → URL.createObjectURL → <a>.click() →
   delayed revoke` pipeline existed in 5 hand-rolled copies
   (`export/project-io.ts`, `rendering/wav.ts`, `midi/midiProject.ts`,
   `ui/DiceContext.tsx`, vendored `fxeq-core` presets). All non-vendored
   copies now delegate to **`src/export/download.ts` `downloadBlob`** — the
   one function a non-DOM shell replaces (Electron already intercepts via
   `will-download`). Bonus fix: `DiceContext.exportFavoritesPack` revoked the
   object URL synchronously after click (against the repo-wide 5 s safety
   net, AGENTS.md §7) — the shared boundary restores the delayed revoke.
2. **Audition context lifecycle.** `intent/audition.ts` keeps a
   module-private preview AudioContext by design (offline-rendered buffer,
   live engine untouched), but a closed context (OS device swap, system
   suspend) previously wedged auditions forever. Now: closed contexts are
   detected (`state === "closed"`) and rebuilt lazily, via `onstatechange`.
   The remaining nuance — a second live context alongside the engine — is
   **by design** for previews and is recorded in §5.

## 5. Highest-risk portability dependencies (ranked)

1. **Root-absolute asset serving** — worklet bundles from `public/`
   (`loader.ts:28–33,108–109`, `PcmMicRecorder.ts:581`) + model/sample
   fetches (`/models/...`, `/samples/...`). Electron needed a custom
   `app://` standard scheme to keep this working. Any non-http target breaks
   lazy chunks, worklet loading and model fetches **simultaneously**. →
   Contract candidate: an asset-URL resolver.
2. **Persistence requires Web Audio** — the three storage repos decode bytes
   with throwaway `OfflineAudioContext`; a port needs a decode adapter or
   pure decoders before storage can move. → GOAL 03 contract: `AudioDecoder`.
3. **Audio I/O surface** — engine context bootstrap, mic
   (`getUserMedia` ×4 sites, error-name→message mapping already exists),
   Web MIDI (2 modules), plus the second live contexts in `export/video.ts`
   and `intent/audition.ts` (previews). Per-app audio-session platforms
   (iOS WebView) interrupt each context independently; only the engine
   rebuilds. → GOAL 03/04: audio-session + recording contracts, context-loss
   recovery outside the engine.
4. **Worker-everything with sync main-thread fallbacks** — a native port must
   map workers to threads *and* keep a sync path (or accept jank) where
   fallbacks trigger; ONNX wasm fetches root-absolute URLs.
5. **PWA/offline model is Vite-plugin-bound** — workbox precache (incl.
   curated WAVs) + `virtual:pwa-register` have no equivalent off the web;
   offline guarantees must be re-stated per platform.
6. **Collab endpoint derivation from `location`** (`collabShared.ts`) —
   ws/wss from page protocol/host/port; a port must inject endpoint config
   and re-host y-websocket/BroadcastChannel transports.
7. **Export encoder graph pulls React** — `packCode.ts` imports pure data
   from `../ui/theme` + `../ui/padKeys` (which import React). Small extraction
   makes pack/share codes Node-runnable. → GOAL 02 target.
8. **Definitions/runtime entanglement** — `schema.ts`/`targets.ts` consume
   param metadata from `effects/registry.ts`/`instruments/registry.ts`, which
   also hold audio runtime factories + worklet imports. Splitting DEFINITIONS
   from RUNTIME gives the port a light pure schema graph. → GOAL 02 target
   (largest, highest payoff).
9. **Micro-nits recorded:** `process.env.NODE_ENV` macro (native toolchain
   must define it); unseeded `Math.random` in `shared/velocityFx.ts:14,23`
   and wall-clock seeds in `commands.ts:4012` / `commands.ts:2925` (GOAL 09
   determinism targets — replayability of humanize/randomize edits); snapshot
   and recovery-repo ids use `Date.now()+Math.random` (metadata only); own
   rAF loops in 8 components bypass `rafLoop.ts`.

## 6. Known non-issues (verified, do not re-investigate)

- No VST/ASIO/multitrack-recording infrastructure exists to port (VISION §1).
- No File System Access API usage; no `showOpenFilePicker` anywhere.
- No `navigator.permissions.query` — mic/MIDI permission handled by
  getUserMedia error names / requestMIDIAccess try-catch.
- `src/browser-checks.ts` is dev-tooling (dynamically imported by
  `scripts/verify-*.mjs` only), not shipped app code.
- Electron shell already follows the thin-bridge pattern (11-line preload,
  single `isDesktop` flag) — nothing to unwind for other shells.
