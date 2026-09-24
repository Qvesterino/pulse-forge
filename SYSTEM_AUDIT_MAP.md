# SYSTEM AUDIT MAP — Pulse Forge (public brand: KYX)

**Created:** 2026-09-10 · **Last re-verified:** 2026-09-24 (hardening campaign re-run 4, GOAL 01)
**Purpose:** Trustworthy map of how the system actually works, for use by scheduled audit/repair sessions.
**Companion docs:** `ARCHITECTURE.md` (intent), `KNOWN_LIMITATIONS.md` (accepted residuals), `AGENT_WORK_LOG.md` (campaign continuity), `docs/CURRENT-STATE.md` (canonical counts), `docs/PORTABILITY_MAP.md` + `docs/PLATFORM_CAPABILITY_MATRIX.md` (platform contracts), `PLUGIN_HARDENING_AUDIT.md` (audio-plugin sweep follow-ups).

> **Snapshot caveat (2026-09-24):** a second agent session works this repository live and has HARD-RESET uncommitted work twice before (see AGENT_WORK_LOG incidents). During this GOAL 01 session that session committed its mallet pack (`523c4b5`) and an intent sub-genre wave (`3b74e58`) mid-session and left two new untracked test files (`tests/audio-engine-audit15.test.ts`, `tests/tempo-flip-commit.test.ts`). Re-verify via `git log`/`git status` before relying on this map.

---

## 1. Product & stack

Browser-first beatmaking DAW, Slovak beginner beatmaker as target user. Public brand **KYX**; flagship plugins publicly named **PRISM** (`fxeq`), **VLYX** (`ultina`), **VØID** (`ozvena`), **Kaskáda Delay** (`kaskada`), **MORPH** (`morphdynamics`). Internal IDs/persistence keys keep the old Pulse Forge names — do not rename.

- **Stack:** TypeScript, React 18, Vite 6, Web Audio + AudioWorklet, Yjs (lazy collab chunk), IndexedDB persistence, PWA (prompt-mode updates), ONNX runtime (intent ranker + symbolic priors), transformers.js (semantic embeddings, lazy), Vitest (jsdom) + Playwright (e2e) + in-app browser self-tests. Optional Node relay: `server/collab-server.mjs`. Electron desktop shell (`desktop/`). Windows MRT2 companion host lives under `companion/mrt2-windows/` (Python capture host + protocol tests, ADR 0013).
- **Entry:** `index.html` → `src/main.tsx` → route split, each a `React.lazy` chunk: `/embed` (share player), `/gallery` (feed), `/download` (desktop app page), everything else → `Entry`. First-time gate is localStorage `pf-onboarded`: `/studio`, `?import=` (a share link IS onboarding), and the desktop shell (`window.kyxDesktop`) skip the landing; `?landing` forces it. `Boot` resolves `?import=` handoffs → dynamic `import("./services")` → `createCoreServices()` → `openProject()` or `ProjectBrowser` → lazy `App`.
- **Landing handoff chain:** `savePendingHandoff({code, prompt})` (sessionStorage `pf-handoff`/`pf-intent-prefill`/`pf-intent-regen`, all exported consts from `src/landing/handoff.ts` — the sanctioned single source) → Boot peeks/clears (StrictMode-safe) → studio.
- **Ecosystem interop (new since 2026-09-23):** `src/interop/qvesterHandoff.ts` + `qvesterProfileBus.ts` — KYX→Qvester Audio Canvas beat handoff (shared-IDB WAV blob + timestamp contract) and the live audio-profile BroadcastChannel bus. Optional surfaces; KYX boots and works with no Qvester present. Cloudflare Pages deploy scripts (`preview:cf`/`deploy:cf` + `wrangler.toml`) exist for standalone KYX deploys.

## 2. Runtime service composition (`src/services.ts`)

Two service tiers — the load-bearing seam of the app:

- **`CoreServices` (cross-project, created once):** `engine` (AudioEngine, one shared `AudioContext`, never re-created across project switches), `bank` (factory SampleBank + curated WAV layer + user-sample restore), IndexedDB repositories (`repo` projects, `snapshots`, `presets`, `library`, `userKits`, `groovePool`), `latency` (LatencyCalibrationController).
- **`Services` (per open project, `openProject()`):** `store` (ProjectStore local OR YDocStore when collab active), `transport`, `scheduler`, `playback`, `generativeProviders` + `generativeRuntime` (MRT2/agent generative-track runtime), `midi`/`midiOutput`/`midiClock`, `patternRecorder` (live MIDI record-to-pattern), `selectionBridge`, `userSamples`, `recordingRecovery` (RecordingRecoveryRepository), `frozenAudio`, `capture` (ArrangementCaptureController), `ghost` (GhostPreviewPlayer), `noteRepeat`, `collab` (CollabSession|null), `bandmate`, `sharedTransportReapply`, plus `flushSave()`/`closeProject()`/`getDiagnostics()`.
- `closeProject()` runs ordered teardown (`closed` flag first so pending async continuations become no-ops), then flushes the final save. Snapshot safety net: 20/project, 30-min throttle.
- **PcmMicRecorder is NOT in services** — consumed directly by `ArrangementPanel`/`ExportPanel`/`HumToMelody`. `MorphPresetRepository` and `UltinaPresetRepository` are also NOT on the DI surface (panels construct them directly — see §17 boundary findings).
- **Intent engine has zero services.ts footprint** — it lives in `src/intent/` + `src/ai/` + `src/reference/` and is invoked from UI panels against doc + engine.

## 3. State model & ownership

- **Single source of truth:** `ProjectDocument` (`src/project-model/types.ts`, immutable). No React state, no AudioNodes, no DOM refs inside it. Runtime state must always be reconstructable from it.
- **Mutation path:** UI → **commands** (`src/commands/commands.ts`, ~6.8k lines — the central ownership file) → `store.execute(command)` → new immutable doc via `normalizeProject` → `onDocChanged` → (a) engine `setProject` diff-sync, (b) `transport.setBpm`, (c) autosave arm.
- **Command-layer exclusivity VERIFIED 2026-09-20 (GOAL 02 sweep), unchanged since:** zero doc mutations outside commands across src/ui, src/intent, src/audio-engine, src/ai, src/gallery, src/landing, src/embed, src/scheduler. Enforcement stronger than convention: `snapshot()` deep-freezes `prev` in dev/test (`docDelta.ts` deepFreeze). AudioEngine is receive-only (`this.doc = doc` only inside `setProject`). All intent paths (production/exact/song/mix/transitions/revise/brief-fixes) funnel through single-snapshot commands. Collab `YDocStore.execute` routes the same path.
  - Residual risks (not violations): ~22 `applyToYDoc` fast paths in commands.ts must stay semantically identical to `execute()` (solo mode never exercises them); whole-doc snapshot closures (capture.ts `captureLastTake`, ArrangementPanel moveClips/deleteClips, PianoRoll altDragDuplicate) lean on the generic whole-document Yjs diff — a peer's unrelated edit can be clobbered at document granularity.
- **`ProjectStore`:** undo stack 256 entries, 1 s coalescing window, redo cleared on execute, `jumpTo` history panel, `replaceDoc` watermark reset. **`YDocStore`**: same external surface (parity pinned by `tests/collab-contract-parity.test.ts`), local-only undo, jam roles gate commands.
- **Selection/Tool state:** separate `SelectionStore`, `ToolStore` — deliberately outside the doc.
- **Schema:** `SCHEMA_VERSION = 3` (v3 added the Remix-DNA lineage domain with a real sanitize migration; v2 intermediate). Full **normalization boundary** (`src/project-model/schema.ts`, ~2.3k lines): every doc entering the store passes through `normalizeProject`, which clamps/sanitizes every domain. The normalizer is spread-preserving on untouched fields — this is how `pattern.generation` provenance survives every round trip. Import ceilings: 10 MB project JSON, 25 MB audio, 10 MB MIDI, 8 M decompressed share chars / 2 M token chars. `clampEffectParam` (registry) is the single range source reused by schema/targets/commands/intent-mix. Flagship rack mixes store 0..1 doc-scale since 2026-09-23 (`rescaleLegacyRackMix` in `src/effects/definitions.ts`, idempotent legacy >1→/100; node layer bridges ×100 to the vendored 0..100 deep state).
- **React read topology:** fine-grained slice hooks (`useScenes`/`useTracks`/… in `src/ui/context.ts`) replace broad `useDoc()` in ~27 components; rely on normalizeProject structural sharing; `useDoc` remains for doc-wide consumers.
- **Pattern generation provenance (fixed, committed `a91ad77`):** the engine writer stamps `pattern.generation.intent` (`attachProvenance`, `src/intent/providers/local.ts`); readers (embed CTA via `intentSnapshotOfDoc`, gallery regen carry, collab-server genre extraction) read `generation.intent` with legacy top-level `pattern.intent` fallback — pinned by real-shape regression tests in `tests/gallery-intent-carry.test.ts` + `tests/gallery-server.test.ts`. **New readers must use `generation.intent`** (or `intentSnapshotOfDoc`).

## 4. Time, transport & scheduling

- **Three time domains, never interchangeable:** musical (ticks, PPQ=480, `BAR_TICKS=1920`), audio (`AudioContext.currentTime`), wall/UI (rAF).
- **`Transport`:** anchor-based tick↔time mapping, position-preserving `setBpm`, exact-anchor `setBpmAnchored` (scene-tempo seam), loop region, count-in, NaN-guarded seek.
- **`Scheduler`:** 25 ms interval / 120 ms horizon lookahead; tick-space event windows; quantized pattern-launch commits (via sanctioned `store.execute(setActivePattern(...))`); tempo-seam window splits; loop wrap; AudioContext-state gating; derived-structure caching keyed on doc reference (relies on immutability).
- **`PlaybackController`:** play/pause/stop/seek/launchScene; pre-roll; frozen-source resurrection.
- Scene-BPM seam (GOAL 05, `46c9e97`): offline tempo-synced FX now schedule per-window (setEffectiveBpm carries the window start time; AudioParam runtimes stock-delay/chorus/kaskada honor it). Message-port runtimes (fxeq, ozvena, granular, stutter, stepgate, beatMangler) remain last-write-wins offline — ozvena is byte-faithful vendored so processor-side scheduling is upstream-only work.

## 5. Audio engine & DSP

- **`AudioEngine`** (`src/audio-engine/AudioEngine.ts`, ~5.8k lines — second central ownership file): whole WebAudio graph — per-track chains, returns, master chain, analysers/metering, voice sets, instrument runtimes, effect runtimes, automation/modulator application, `setEffectiveBpm` + `pushSyncBpm` (scene-tempo FX sync, live==offline).
- **Master chain stages:** tilt shelf pair `masterTiltLow` (150 Hz) / `masterTiltHigh` (5 kHz) driven by `MasterConfig.tiltDb`; `masterBassMono` M/S low-mono stage (60–400 Hz); master limiter. `setMasterConfig` is the single command surface.
- **Effects: 47 kinds** (`EFFECT_DEFS` in `src/effects/registry.ts`, ~3.7k lines; per-effect node wrappers in `src/effects/*Node.ts`; union in `types.ts`): 42 core + 5 flagship (`fxeq, ultina, ozvena, kaskada, morphdynamics`). Worklet policy: "critical" bypass 1:1 on missing worklet vs "degraded" native approximation. `WORKLET_EFFECTS` (registry.ts ~186) is the complete severity map; `effectProcessorStatus` casts via `WorkletType` (fixed 2026-09-24 — the old hand-maintained literal cast kept drifting). Recent core: kaskada (character delay + 32-band unmask solver), tapeStop, ringMod, freqShifter, pitchShift (COLA granular), vinyl, beatMangler (scheduled automation now routes port-carried params, 2026-09-23), vocoder, multiTapDelay (pure native), reverseSwell, granularFreeze send; bassMono is a master stage.
- **Flagship cores are vendored:** `fxeq-core` (fork — may be patched; `vendor-fxeq.mjs` must NOT run), `ultina-core`/`ozvena-core` (byte-faithful; NEVER patch locally — fix upstream and re-vendor; both vendor scripts carry dirty-upstream guards). `kaskada-processor.js` + `core-processor.js` live in-tree under `src/audio-worklets/`, built into `public/` by `predev`/`prebuild` (6 bundles incl. morph-dynamics). MORPH (`morph-dynamics-core/`) is first-party DSP.
- **AudioParam safety:** all 25+ worklet wrappers write params via `safeApplyAudioParam` (`src/audio-worklets/safeAudioParam.ts`) — drops NaN/±Infinity (GOAL 16, 2026-09-21).
- **Cue sounds:** `src/intent/transition-cues.ts` bakes FX-cue AudioClips on a dedicated FX Cues track; `ArrangementTransition.cueAssetId` picks the asset.
- **Sample content:** 71 factory assets (`src/sample-library/manifest.ts`) overridden by curated WAVs in `public/samples/` (`src/sample-library/curated.ts`, 68 overrides — mallet assets are synthesis-only; `npm run curated:seeds`; verify script checks parity). Kick bank 15, snare 9, hat 10, dedicated tonal bank + mallet pack (`523c4b5`). Preset loudness: per-family LUFS targets at every instrument-chain build (`src/presets/normalization.ts`); FX-preset analogue `src/effects/presetLoudness.ts` (disjoint domains, same generated filename — confusing but not duplication).
- **Instruments:** 15 kinds (flute is #15), runtime factory. 325 factory presets (319 instrument + 6 drum-synth; verified via vite-node import count 2026-09-24). `previewInstrumentPreset` auditions at normalized loudness.
- **Recording:** lossless PCM mic capture (`public/recording-capture-worklet.js` + `PcmMicRecorder`, chunk-ack-after-IDB-commit, start-token guards); crash recovery via `RecordingRecoveryRepository` (own-take ownerId hiding; `pruneAncient()` GCs 30-day-old staging).
- **Vocal profile V1 "Počujem ťa" (new subsystem `src/vocal/`, 10 files):** analyzes a recorded vocal/hum take into a **proposal** `VocalProfile` (key, tempo, phrase map, energy; content-hashed; `measured:false` when the signal can't support a field) — never mutates directly; application flows through undoable commands (`adapt.ts`), consumed by `IntentPanel` + `intent/compose.ts` + `intent/song.ts`. Worker-backed (`analyzer-worker.ts`). Reuses the existing PcmMicRecorder pipeline — no new recording infrastructure (VISION §1 boundary respected: it analyzes takes, it is not a vocal-track recording studio).
- **Offline render:** SAME engine rules (live==offline invariant); WAV 16/24-bit soft-kneed, 32-float deliberately retains finite over-range samples (KNOWN_LIMITATIONS corrected 2026-09-24); stems; cancel-before-start abort; `encodeWavAsync` chunked/abortable; render-cancel race fixed (background render discarded).
- **Generative tracks (MRT2):** `src/generative/` provider-neutral runtime; browser adapter bounded to AudioWorklet playback; Electron helper + native host under `native/mrt2-host/` (macOS only, ADR 0012); Windows capture-first companion under `companion/mrt2-windows/` (ADR 0013, Python host + benchmark gate scripts).

## 6. Intent engine

- **Entry:** `src/ui/IntentPanel.tsx` — DO IT routes via `src/intent/route.ts`: **arrange** → **conversation intents** (loudness → fader → tempo → vibe, GOAL 38/40: real fader/setBpm/composite production ops) → **mix** (tone comparatives → master tilt / mix chain) → **revise** (section-role word → targeted `reviseSection`, else global same-seed ±0.15) → **generate** (production intent first, weak-parse semantic fallback, candidate bank + ranker). Separate GENERATE and ♪ SONG buttons.
- **Brief contract (Fáza 1, 2026-09-24):** `src/intent/brief-contract.ts` compiles the parsed prompt into an explicit POVINNÉ/PREFERENCIE/ZÁKAZY/ZACHOVAŤ/NEISTÉ statement list shown before generation; `preserve` roles in IntentSpec protect named tracks from overwrite; `BriefContractSummary.tsx` offers one-click fixes (briefFixes merged into all 4 assembly points). Transient only — no schema change.
- **Producer session memory (GOAL 41):** `src/intent/producer-session.ts` records genre/bpm/key/mood decisions per session, powers "ten istý, len pomalšie" follow-ups and B/C variant chips (one-shot patches).
- **Production intents** (`src/intent/production.ts`): 12 concepts × 4 targets, EN+SK, amount modifiers; compiles to FX ops; `applyProductionIntentCommand` = ONE undo step. Routing: explicit target track family + no genre signal → production wins over global mix (`41a0417`).
- **Exact intents** (`src/intent/exact.ts`): "set tempo 140 / key Am / mute X / pan / gain / transpose / length" → `applyExactIntentCommand`.
- **Generation pipeline:** parser v3 EN+SK (sections, brief roles, SK deaccent rules), drum/melodic generators + ONNX symbolic priors (hybrid v3 active, 60-dim semantic conditioning), candidate bank, offline audition, `applyGenerationResultCommand` (one undo step + provenance). 61 artist presets (researched BPM rosters), roller/amen/horrorcore grooves.
- **Ranker: ACTIVE** (`DEFAULT_RANKER_MODE = "active"`, flipped via listening-room golden holdout 0.75 — the 2026-09-20 shadow state is obsolete). Rerank V3: top-3 finalists render → audio-fit blend; learned weights via `npm run rerank:fit`.
- **Semantic fallback:** MiniLM (118 MB q8, lazy) over curated EN+SK corpus; threshold 0.5; weak parses only.
- **Audio reference T4+ (`src/reference/`):** 🎧 REF decodes a WAV → `analyzeAudioReference` (AST labels, tempo onset-autocorrelation, Goertzel/Krumhansl key) → patch merged into 4 generation paths; persistent chip + `clearReference`. Groove extraction (🥁) feeds real DRUMS rows.
- **Song builder:** role-aware sections; transitions bake real treatments; C3 targeted revise reads `generation.intent`; genre loudness/tilt references now MEASURED (`src/intent/genre-reference.generated.ts` is generated from rendered songs — the old placeholder residual is resolved; `npm run references:genres` regenerates). SUNO MODE + dynamic song forms (short/radio/extended/epic/exact).
- **Favorites loop:** favorites retrain all models; `taste:train` orchestrator.

## 7. Persistence & recovery

- **IndexedDB** `pulse-forge` **v12** (`src/persistence/db.ts`): **15 stores** (projects, meta, presets, library, user-samples, user-sample-audio, recording-sessions, recording-chunks +by-session, frozen-audio, user-kits, groove-pool, project-snapshots, project-snapshot-index, ultina-presets, morph-presets). Transaction helper resolves only on `oncomplete`; 5 s blocked-open timeout; `onversionchange` yields so a newer tab can upgrade; failed opens are not cached (transient failures retry).
- **Autosave:** 800 ms debounce / 5 s max-defer; single-writer drain; revision capture; save-status machine. Unload guards. Frozen-track restore with auto-unfreeze; frozen-buffer GC.
- **Export/import:** `.pulseforge.json`, share codes (bomb-capped), MIDI I/O, scorepack, zyvo transfer. Share-code decode = `validateProjectShape` + `normalizeProject`. `encodeWavAsync` (chunked, progress, abort, byte-identical with sync path).
- **Write-failure surfacing VERIFIED (GOAL 04, 2026-09-21):** `FrozenBufferRepository.save` and `LibraryRepository.mutate` throw descriptive errors, every caller surfaces them (FreezeButton error state + bank cleanup, SampleBrowser `reportLibraryFailure`, PresetBrowser `guard`→saveError). Recovery paths: frozen-restore decode failure → track auto-unfreezes; library load failure → EMPTY fallback, non-cached.
- **Recording recovery:** chunk-ack only after IDB commit, single write-chain, persistence errors → auto-stop + staged blocks recoverable, `pruneAncient()` on open.

## 8. Collaboration & gallery server

- Client: `YDocStore` + `CollabSession` (lazy), BroadcastChannelProvider, jam roles; undo local-only; Yjs history unbounded (documented). Pre-adopt auto-snapshot ('auto — before collab adopt') mitigates offline-adopt loss.
- Server (`server/collab-server.mjs`, ~855 lines): Yjs WS relay with origin checks; gallery REST (GET/POST /api/gallery, play, report, admin reports/delete, health). Limits: 256 rooms / 512 conns / 32 per room / 96-char ids / 8 MB msgs; gallery 500 items / 400k-char codes; per-IP rate limits; `CORS_ORIGIN` env (production rejects `*`). Gallery items carry genre+regenerable extracted from `pattern.generation.intent`.
- Gallery client: feed with inline EmbedApp, OPEN IN KYX, REGEN (intent carry), REMIX (buildRemix → auto-publish with Remix-DNA lineage, schema v3 domain), JAM LIVE, FORK, REPORT.

## 9. UI layer

- `src/ui/` (93 files): `App` shell (1.4k lines — slimmer after the topbar/dock refactors), context DI (`useServices`, `useDoc`, slice hooks), heavy panels lazy-loaded. Shared rAF loop (`src/services/rafLoop.ts`, zero imports) drives meters/playhead. `src/services/funnel.ts` — generic, localStorage-only, **still no reader** (data ships unread).
- **Styles:** `src/styles/` split (19 files + `index.css`; **order load-bearing**).
- **Keybinding policy:** Space = transport always; click-does-not-focus + `data-allow-focus`; FxIntentBar input carries `data-allow-focus`.
- **PWA:** prompt updates; precache includes curated WAVs, excludes `models/ort/**`, ranker ONNX, `golden-review/**`; 4 MiB/file; desktop build drops the plugin.
- **Desktop:** `desktop/main.cjs` serves `dist/` over `app://bundle` (traversal-guarded), silent media/MIDI grants, electron-updater (GitHub feed), `KYX_SMOKE=1` harness; `/download` route; MRT2 helper process/IPC; CI packages a macOS MRT2 QA artifact gated on shared checks.

## 10. Critical execution paths

1. **Startup:** route pick → Boot handoff → `createCoreServices` → bank decode → `openProject` → engine `setProject` → worklet preload (context-construction failure is caught + deferred to first gesture) → MIDI access.
2. **Intent → sound:** IntentPanel → route (conversation→mix→revise→generate) → brief contract summary → pipeline candidates (+active ranker/semantic) → audition → apply command (ONE undo step) → engine diff-sync.
3. **Edit → sound:** UI control → command → store → normalize → `onDocChanged` → diff-sync → worklet params (`safeApplyAudioParam`).
4. **Playback:** `playPause` → transport anchor → scheduler windows → engine triggers.
5. **Vocal profile:** record take (PcmMicRecorder) → `src/vocal/analyze` worker → VocalProfile proposal → user accepts → undoable adapt commands (key/tempo/phrases into doc).
6. **Save/reload:** debouncer → repo.save → reload → normalize (v1→v3 migration path) → rebuild; frozen-restore; recording recovery.
7. **Export:** doc → OfflineAudioContext render → WAV/MP3/stems/scorepack → download (revoke guarded).
8. **Share/publish:** encodeShareCode → embed `#p=` / gallery POST → server extracts genre+regenerable → REGEN CTA → `intentSnapshotOfDoc`.
9. **Collab join:** URL param → lazy chunk → `YDocStore.fromDocument` → ws sync → remote edits through `onDocChanged`.
10. **Ecosystem handoff:** studio → `qvesterHandoff` (shared-IDB WAV + timestamp) → Qvester Audio Canvas; profile bus channel `pulse_forge` (subscribe-only from KYX side).

## 11. Async/concurrency boundaries

- Scheduler interval vs immutable doc reads; close-race `closed` flag guards; PcmMicRecorder start-token guards; single-writer save drain; delayed blob-URL revokes (optional-call); collab ws → YDoc apply → subscriber emission; rAF metering; worklet load fallback → rebuild-on-ready; ranker/semantic/reference workers bounded by timeouts + circuit breakers; vocal analyzer worker validates message shape; IntentPanel generation aborted on project switch (Audit 13).

## 12. High-risk areas

| Area | Risk | Evidence |
|---|---|---|
| `src/commands/commands.ts` (~6.8k L) | Central ownership; ~22 `applyToYDoc` fast paths must mirror `execute()` | GOAL 02 sweep, re-verified 2026-09-20 |
| `src/audio-engine/AudioEngine.ts` (~5.8k L) | Graph lifecycle, diff-sync; long-lived `this.doc` aliases undo snapshots (dev-only freeze) | GOAL 02 sweep |
| Concurrent-session churn | TWO hard resets of uncommitted work (2026-09-20); commit campaign fixes promptly; uncommitted mallet pack in tree 2026-09-24 | work log incidents |
| intent/ ↔ commands/ folder cycle | commands.ts imports intent/{production,pipeline,exact}; intent/{song,mix} import commands back — acyclic by file-level accident; one import from closing a hard cycle | GOAL 02 §17.6 |
| Ranker ACTIVE in prod path | activation resolved the shadow risk; new risk class: ranker regressions are user-visible → golden gate (`rerank:fit`, holdout) is the guard | ranker-client.ts:24 |
| MRT2 companion boundary | `native/mrt2-host/` + `companion/mrt2-windows/` + desktop IPC are release-gated separately (ADR 0012/0013); macOS artifact unsigned/unnotarized, no model-inference proof | docs/CURRENT-STATE.md |
| DI bypasses in UI | Morph/Ultina preset repos constructed in panels (GroovePool fixed) | §17.2 |
| Funnel telemetry | data ships unread | §13 |
| Offline render non-cancellable mid-render; offline scene-BPM message-port seam | export residuals | KNOWN_LIMITATIONS |
| jsdom full-suite runtime | 494 files; 15–90 min on this machine; historical flaky-timeout class mostly fixed (revoke guards) | work log |
| Root tracked leftovers | `quantize.cmd.ts`, `test-de.mjs`, `cdot/`, `qffx-schema.md`, `tests/_debug_archive/`, stray logs are TRACKED scratch — cleanup candidates (GOAL 11) | `git ls-files` 2026-09-24 |

## 13. Discrepancies (docs vs reality — refreshed 2026-09-24)

RESOLVED since 2026-09-20: README effect/preset counts (fixed 2026-09-24); AGENTS.md counts (fixed 2026-09-24); KNOWN_LIMITATIONS 32-float claim (corrected 2026-09-24); `WORKLET_EFFECTS` completeness + drifting cast union (fixed 2026-09-24, registry.ts); `pf-publish-code` triple definition (now single `PUBLISH_CODE_KEY` in galleryApi.ts); missing EFFECT_ORDER exhaustive guard (`tests/effects.test.ts` "EFFECT_ORDER covers every definition"); genre-reference placeholder (now measured).

STILL OPEN:

1. Funnel marks (`src/services/funnel.ts`) have no consumer — data ships unread.
2. Tracked scratch at root: `quantize.cmd.ts` (scale-quantize command prototype, no importers), `test-de.mjs` (fake-indexeddb scratch), `cdot/ncommands.ts` (command-file fragment, no importers), `qffx-schema.md`, `_final_check.log`, `_tc4.log`, `coverage-run.log`, `coverage-iter2.log`, `tests/_debug_archive/`. Untracked: `scratch/`, `remotion/`, `out/`, `golden-review/`. → GOAL 11 candidates.
3. `src/shared/dice.ts` imports intent/ai modules — feature logic parked in shared/ (upward edge, cosmetic).
4. `src/services.ts` imports `recordPlayActivity` from `./ui/playActivity` (infra→ui edge; file is import-free, harmless, mislocated).
5. `docs/CURRENT-STATE.md` said browser factory QA "252/252" — historical moment count; preset count is now 325 (QA script enumerates dynamically). Count rows corrected to 71 assets / 325 presets 2026-09-24 (the mallet commit `523c4b5` shipped without the doc bump the repo policy requires).

## 14. Known architectural constraints (intentional — do not "fix")

- Immutable doc + command pattern; no global state framework. Undo at command layer only.
- Preview/audition transient — never mutates doc/history/collab. Engine previews write AudioNodes with rollback maps only.
- Live==offline DSP parity; seeded randomness; golden fixtures as contracts.
- Internal IDs and persisted formats frozen for branding. Vendored cores: fxeq patchable, ultina/ozvena byte-faithful, MORPH/kaskada first-party.
- Collab: custom servers trusted; undo local-only; Yjs history unbounded. IndexedDB-only persistence.
- No VST/AU hosting, no ASIO, no multitrack studio/vocal-recording infrastructure (VISION §1). The vocal-profile subsystem analyzes takes via the existing mic pipeline; it does not add recording infrastructure.
- AI models always behind timeouts + circuit breaker + deterministic fallback. Inference never on the audio thread.
- `ARCHITECTURE.md §4` monorepo layout aspirational — not a defect.

## 15. Baseline health

### 2026-09-24 re-verification (re-run 4, GOAL 01)

- **HEAD:** `523c4b5` (the concurrent session committed its mallet pack + intent sub-genre wave mid-session; 154 commits since the 2026-09-20 audited baseline `a91ad77`), plus two untracked in-flight test files from that session (left in place).
- `tsc --noEmit` strict: **PASS** (twice — before and after the registry cast fix).
- Full Vitest suite: running at map-write time (494 spec files); result appended to AGENT_WORK_LOG on completion.
- `npm run build` / browser suites / factory-preset QA: not re-run this session (GOAL 12 gate). Budgets: entry 1070 KB, DAW 2500 KB, AI runtimes 650 KB, worklets 150 KB — `scripts/check-bundle-size.mjs`.
- Prior gate (re-run 3, 2026-09-21): 4097/4101 tests, build+preflight+server-smoke+audit PASS → "PASS WITH KNOWN RISKS" (4 failures attributed to concurrent session, later fixed by them per AGENT_WORK_LOG).

### Historical

- 2026-09-20: provenance seam fixed `a91ad77`; full-suite runs on the shared machine were unreliable (stale kills), deferred to gate.
- 2026-09-14: full suite 239/2351/103; build PASS; browser 226/226 (Chromium+Firefox+Edge); factory QA 292/292; soaks PASS; audit 0 vulns.
- 2026-09-13: full suite 2315/103; browser smoke 218/218.
- 2026-09-10: campaign origin; revokeObjectURL guard class fixed.

## 16. Areas requiring deeper audit (queued for re-run 4)

1. **GOAL 02:** Morph/Ultina preset-repo DI bypass (growing UI→IndexedDB coupling pattern); intent↔commands cycle monitor; new intent surfaces (producer-session, brief-contract, conversation faders) command-path exclusivity spot-check.
2. **GOAL 03/07:** vocal-profile lifecycle (take → analyze → apply) end-to-end; Qvester handoff timestamp contract under clock skew; generative-runtime races on project switch.
3. **GOAL 05:** schema v3 lineage domain migration matrix (v1/v2 docs → v3, share codes, collab blobs).
4. **GOAL 10:** kaskada unmask solver CPU; morph-dynamics DSP budget; vocal analyzer worker cost on long takes.
5. **GOAL 11:** root tracked leftovers (§13.2); funnel consumer; dual ORT trees (`@huggingface/transformers` + onnxruntime-web) — accepted, documented.
6. **GOAL 12 gate:** build + budgets + browser suites + factory QA (298) + preflight + server smoke + `npm audit --omit=dev`.

## 17. Boundary & ownership findings (GOAL 02, 2026-09-20 — refreshed 2026-09-24)

1. **Command-layer exclusivity: HOLDS** (see §3). Enforcement via dev-only deepFreeze of undo snapshots.
2. **DI bypasses (UI constructs infra directly):** `GroovePoolRepository` bypass FIXED (routes through services). REMAINING: `MorphDynamicsPanel.tsx` (`new MorphPresetRepository()` ×4) and `UltinaPanel.tsx` (`new UltinaPresetRepository()` ×2) — repos not on the services surface. Growing UI→IndexedDB coupling pattern; promote to a shared repository surface or services.
3. **Storage keys:** `pf-publish-code` duplication RESOLVED (`PUBLISH_CODE_KEY` in `gallery/galleryApi.ts`, consumed by CollabPanel + GalleryPage). Naming conventions coexist (`pf-kebab` vs `pf:colon`) — cosmetic.
4. **Literal duplication:** output-trim clamp `[-18,+12]` + 1-decimal rounding coded in `src/effects/presetLoudness.ts` (`clampFxOutputTrimDb`) AND inline in `src/project-model/schema.ts` — schema should call the function (same numbers today; verify line before touching).
5. **Provenance walk duplication:** fixed by `a91ad77`; contract pinned by `tests/gallery-intent-contract.test.ts`.
6. **intent/ ↔ commands/ bidirectional folder coupling:** `commands.ts` imports `intent/production|pipeline|exact`; `intent/song.ts` + `intent/mix.ts` + `intent/compose.ts` import `commands/commands` (`snapshot`). No module cycle today; one careless import from closing a hard cycle. Monitor; extract `snapshot` helper if it ever closes.
7. **Exhaustiveness:** `EFFECT_ORDER` guard EXISTS (`tests/effects.test.ts:13`). `INSTRUMENT_ORDER` guard — verify presence when touching instruments.
8. **Mislocated files (cosmetic):** `src/shared/dice.ts`, `src/ui/playActivity.ts`, root `quantize.cmd.ts`/`cdot/` scratch.
9. **Flagship mix scale:** unified to doc 0..1 with `rescaleLegacyRackMix` (2026-09-23); vendored deep state stays 0..100 behind node bridges — do not "fix" the ×100 bridges, they are the contract.
