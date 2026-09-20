# SYSTEM AUDIT MAP — Pulse Forge (public brand: KYX)

**Created:** 2026-09-10 · **Last re-verified:** 2026-09-20 (hardening campaign re-run, GOAL 01+02)
**Purpose:** Trustworthy map of how the system actually works, for use by scheduled audit/repair sessions.
**Companion docs:** `ARCHITECTURE.md` (intent), `KNOWN_LIMITATIONS.md` (accepted residuals), `AGENT_WORK_LOG.md` (campaign continuity), `PLUGIN_HARDENING_AUDIT.md` (audio-plugin sweep follow-ups).

> **Snapshot caveat (2026-09-20):** a second agent session works this repository live and has HARD-RESET uncommitted work once already (see AGENT_WORK_LOG 2026-09-20 incident). Anything not committed can vanish. Re-verify via `git log`/`git status` before relying on this map.

---

## 1. Product & stack

Browser-first beatmaking DAW, Slovak beginner beatmaker as target user. Public brand **KYX**; flagship plugins publicly named **PRISM** (`fxeq`), **VLYX** (`ultina`), **VØID** (`ozvena`), plus **RYFT** (`kaskada`) and the in-flight morph-dynamics flagship. Internal IDs/persistence keys keep the old Pulse Forge names — do not rename.

- **Stack:** TypeScript, React 18, Vite 6, Web Audio + AudioWorklet, Yjs (lazy collab chunk), IndexedDB persistence, PWA (prompt-mode updates), ONNX runtime (intent ranker + symbolic priors), transformers.js (semantic embeddings, lazy), Vitest (jsdom) + Playwright (e2e) + in-app browser self-tests. Optional Node relay: `server/collab-server.mjs`. Electron desktop shell (`desktop/`).
- **Entry:** `index.html` → `src/main.tsx` → route split, each a `React.lazy` chunk: `/embed` (share player), `/gallery` (feed), `/download` (desktop app page), everything else → `Entry`. First-time gate is localStorage `pf-onboarded`: `/studio`, `?import=` (a share link IS onboarding), and the desktop shell (`window.kyxDesktop`) skip the landing; `?landing` forces it. `Boot` resolves `?import=` handoffs → dynamic `import("./services")` → `createCoreServices()` → `openProject()` or `ProjectBrowser` → lazy `App`.
- **Landing handoff chain:** `savePendingHandoff({code, prompt})` (sessionStorage `pf-handoff`/`pf-intent-prefill`/`pf-intent-regen`, all exported consts from `src/landing/handoff.ts` — the sanctioned single source) → Boot peeks/clears (StrictMode-safe) → studio.

## 2. Runtime service composition (`src/services.ts`)

Two service tiers — the load-bearing seam of the app:

- **`CoreServices` (cross-project, created once):** `engine` (AudioEngine, one shared `AudioContext`, never re-created across project switches), `bank` (factory SampleBank + curated WAV layer + user-sample restore), IndexedDB repositories (`repo` projects, `snapshots`, `presets`, `library`, `userKits`, `groovePool`), `latency` (LatencyCalibrationController).
- **`Services` (per open project, `openProject()`):** `store` (ProjectStore local OR YDocStore when collab active), `transport`, `scheduler`, `playback`, `midi`/`midiOutput`/`midiClock`, `patternRecorder` (live MIDI record-to-pattern), `selectionBridge`, `userSamples`, `recordingRecovery` (RecordingRecoveryRepository), `frozenAudio`, `capture` (ArrangementCaptureController), `ghost` (GhostPreviewPlayer), `noteRepeat`, `collab` (CollabSession|null), `bandmate`, `sharedTransportReapply`, plus `flushSave()`/`closeProject()`/`getDiagnostics()`.
- `closeProject()` runs ordered teardown (`closed` flag first so pending async continuations become no-ops), then flushes the final save. Snapshot safety net: 20/project, 30-min throttle.
- **PcmMicRecorder is NOT in services** — consumed directly by `ArrangementPanel`/`ExportPanel`/`HumToMelody`. `MorphPresetRepository` and `UltinaPresetRepository` are also NOT on the DI surface (panels construct them directly — see §17 boundary findings).
- **Intent engine has zero services.ts footprint** — it lives in `src/intent/` + `src/ai/` and is invoked from UI panels against doc + engine.

## 3. State model & ownership

- **Single source of truth:** `ProjectDocument` (`src/project-model/types.ts`, immutable). No React state, no AudioNodes, no DOM refs inside it. Runtime state must always be reconstructable from it.
- **Mutation path:** UI → **commands** (`src/commands/commands.ts`, ~6k lines — the central ownership file) → `store.execute(command)` → new immutable doc via `normalizeProject` → `onDocChanged` → (a) engine `setProject` diff-sync, (b) `transport.setBpm`, (c) autosave arm.
- **Command-layer exclusivity VERIFIED 2026-09-20 (GOAL 02 sweep):** zero doc mutations outside commands across src/ui, src/intent, src/audio-engine, src/ai, src/gallery, src/landing, src/embed, src/scheduler. Enforcement stronger than convention: `snapshot()` deep-freezes `prev` in dev/test (`docDelta.ts` deepFreeze). AudioEngine is receive-only (`this.doc = doc` only inside `setProject`). All intent paths (production/exact/song/mix/transitions/revise) funnel through single-snapshot commands. Collab `YDocStore.execute` routes the same path.
  - Residual risks (not violations): ~22 `applyToYDoc` fast paths in commands.ts must stay semantically identical to `execute()` (solo mode never exercises them); whole-doc snapshot closures (capture.ts `captureLastTake`, ArrangementPanel moveClips/deleteClips, PianoRoll altDragDuplicate) lean on the generic whole-document Yjs diff — a peer's unrelated edit can be clobbered at document granularity.
- **`ProjectStore`:** undo stack 256 entries, 1 s coalescing window, redo cleared on execute, `jumpTo` history panel, `replaceDoc` watermark reset. **`YDocStore`**: same external surface (parity pinned by `tests/collab-contract-parity.test.ts`), local-only undo, jam roles gate commands.
- **Selection/Tool state:** separate `SelectionStore`, `ToolStore` — deliberately outside the doc.
- **Schema:** `SCHEMA_VERSION = 1`; no versioned migrations — a full **normalization boundary** (`src/project-model/schema.ts`, ~1.9k lines): every doc entering the store passes through `normalizeProject`, which clamps/sanitizes every domain. The normalizer is spread-preserving on untouched fields — this is how `pattern.generation` provenance survives every round trip. Import ceilings: 10 MB project JSON, 25 MB audio, 10 MB MIDI, 8 MB decompressed share token. `clampEffectParam` (registry) is the single range source reused by schema/targets/commands/intent-mix (verified no drift).
- **React read topology:** fine-grained slice hooks (`useScenes`/`useTracks`/… in `src/ui/context.ts`) replace broad `useDoc()` in ~27 components; rely on normalizeProject structural sharing; `useDoc` remains for doc-wide consumers.
- **Pattern generation provenance (fixed, committed `a91ad77`):** the engine writer stamps `pattern.generation.intent` (`attachProvenance`, `src/intent/providers/local.ts`); readers (embed CTA via `intentSnapshotOfDoc`, gallery regen carry, collab-server genre extraction) read `generation.intent` with legacy top-level `pattern.intent` fallback — pinned by real-shape regression tests in `tests/gallery-intent-carry.test.ts` + `tests/gallery-server.test.ts`. **New readers must use `generation.intent`** (or `intentSnapshotOfDoc`).

## 4. Time, transport & scheduling

- **Three time domains, never interchangeable:** musical (ticks, PPQ=480, `BAR_TICKS=1920`), audio (`AudioContext.currentTime`), wall/UI (rAF).
- **`Transport`:** anchor-based tick↔time mapping, position-preserving `setBpm`, exact-anchor `setBpmAnchored` (scene-tempo seam), loop region, count-in, NaN-guarded seek.
- **`Scheduler`:** 25 ms interval / 120 ms horizon lookahead; tick-space event windows; quantized pattern-launch commits (via sanctioned `store.execute(setActivePattern(...))`); tempo-seam window splits; loop wrap; AudioContext-state gating; derived-structure caching keyed on doc reference (relies on immutability).
- **`PlaybackController`:** play/pause/stop/seek/launchScene; pre-roll; frozen-source resurrection.
- Known open seam: offline scene-BPM handling (needs AudioEngine edit; design in earlier reliability notes).

## 5. Audio engine & DSP

- **`AudioEngine`** (`src/audio-engine/AudioEngine.ts`, ~5.3k lines — second central ownership file): whole WebAudio graph — per-track chains, returns, master chain, analysers/metering, voice sets, instrument runtimes, effect runtimes, automation/modulator application, `setEffectiveBpm` + `pushSyncBpm` (scene-tempo FX sync, live==offline).
- **Master chain stages:** tilt shelf pair `masterTiltLow` (150 Hz) / `masterTiltHigh` (5 kHz) driven by `MasterConfig.tiltDb`; `masterBassMono` M/S low-mono stage (60–400 Hz); master limiter.
- **Effects:** 45 kinds (`EFFECT_DEFS` in `src/effects/registry.ts`, ~4.7k lines; union in `types.ts`): 40 core + 5 flagship (`fxeq, ultina, ozvena, kaskada, morphdynamics`). Worklet policy: "critical" bypass 1:1 on missing worklet vs "degraded" native approximation. Recent core: kaskada (character delay + 32-band unmask solver), tapeStop, ringMod, freqShifter, pitchShift (COLA granular), vinyl, beatMangler, vocoder, multiTapDelay (pure native), stock-EQ worklet; bassMono is a master stage.
- **Flagship cores are vendored:** `fxeq-core` (fork — may be patched; `vendor-fxeq.mjs` must NOT run), `ultina-core`/`ozvena-core` (byte-faithful; NEVER patch locally — fix upstream and re-vendor; both vendor scripts carry dirty-upstream guards). `kaskada-processor.js` + `core-processor.js` live in-tree under `src/audio-worklets/`, built into `public/` by `predev`/`prebuild` (5 bundles).
- **AudioParam safety:** all 25+ worklet wrappers write params via `safeApplyAudioParam` (`src/audio-worklets/safeAudioParam.ts`) — drops NaN/±Infinity (GOAL 16, 2026-09-21).
- **Cue sounds:** `src/intent/transition-cues.ts` bakes FX-cue AudioClips on a dedicated FX Cues track; `ArrangementTransition.cueAssetId` picks the asset.
- **Sample content:** curated layer = 41 factory slots overridden by WAVs in `public/samples/` (`src/sample-library/curated.ts`; `npm run curated:seeds`). Preset loudness: per-family LUFS targets at every instrument-chain build (`src/presets/normalization.ts`); FX-preset analogue `src/effects/presetLoudness.ts` (disjoint domains, same generated filename — confusing but not duplication).
- **Instruments:** 14 kinds, runtime factory. `previewInstrumentPreset` auditions at normalized loudness.
- **Recording:** lossless PCM mic capture (`public/recording-capture-worklet.js` + `PcmMicRecorder`, chunk-ack-after-IDB-commit, start-token guards); crash recovery via `RecordingRecoveryRepository` (own-take ownerId hiding).
- **Offline render:** SAME engine rules (live==offline invariant); WAV 16/24/32-float (float path deliberately retains over-range samples — only 16/24 soft-clip); stems; cancel-before-start abort.
- **In-flight (concurrent session):** morph-dynamics flagship (`src/effects/morph-dynamics-core/**`, panel, automation, worklet entry + build script). Deep params normalize via `normalizePluginParams`; automation targets not yet in `targets.ts` (ModPanel uses `morphLaneRange`). Do not audit internals while in flight.

## 6. Intent engine

- **Entry:** `src/ui/IntentPanel.tsx` — DO IT routes via `src/intent/route.ts`: **arrange** → **mix** (tone comparatives → master tilt / mix chain) → **revise** (section-role word → targeted `reviseSection`, else global same-seed ±0.15) → **generate** (production intent first, weak-parse semantic fallback, candidate bank + ranker). Separate GENERATE and ♪ SONG buttons.
- **Production intents** (`src/intent/production.ts`): 9 concepts × 4 targets, EN+SK, amount modifiers; compiles to FX ops; `applyProductionIntentCommand` = ONE undo step. **Known routing overlap:** "make the drums darker/brighter/warmer" is captured by the MIX branch (master-global) before production can target the drums track — GOAL 03 candidate.
- **Exact intents** (`src/intent/exact.ts`): "set tempo 140 / key Am / mute X / pan / gain / transpose / length" → `applyExactIntentCommand`.
- **Generation pipeline:** parser v3 EN+SK, drum/melodic generators + ONNX symbolic priors, candidate bank (3 template + 2 symbolic), offline audition, `applyGenerationResultCommand` (one undo step + provenance).
- **Ranker:** ONNX listwise re-ranker; `DEFAULT_RANKER_MODE = "shadow"` (localStorage override); lazy worker, timeouts, circuit breaker. Activation gated on HUMAN golden re-review bound to current dataset keys (see AGENT_WORK_LOG 2026-09-19 forensics — shadow is the correct conservative state).
- **Semantic fallback:** MiniLM (118 MB q8, lazy) over curated ~80-entry EN+SK corpus; threshold 0.5; weak parses only.
- **Song builder:** role-aware sections; transitions bake real treatments (`transitions.ts`); C3 targeted revise reads `generation.intent` + same-seed re-gen keeping pattern id; genre tilt/loudness consumption **inert** — `src/intent/genre-reference.generated.ts` is a committed neutral placeholder until `npm run references:genres` runs (concurrent session owns the script).
- **Favorites loop:** favorites retrain all 3 models.

## 7. Persistence & recovery

- **IndexedDB** `pulse-forge` **v11** (`src/persistence/db.ts`): **14 stores** (projects, meta, presets, library, user-samples, user-sample-audio, recording-sessions, recording-chunks +by-session, frozen-audio, user-kits, groove-pool, project-snapshots, project-snapshot-index, ultina-presets). Transaction helper resolves only on `oncomplete`; 5 s blocked-open timeout.
- **Autosave:** 800 ms debounce / 5 s max-defer; single-writer drain; revision capture; save-status machine. Unload guards. Frozen-track restore with auto-unfreeze; frozen-buffer GC.
- **Export/import:** `.pulseforge.json`, share codes (bomb-capped), MIDI I/O, scorepack, zyvo transfer. Share-code decode = `validateProjectShape` + `normalizeProject`.
- Recorded (not fixed, low): `FrozenBufferRepository.save` and `LibraryRepository.mutate` swallow write failures.

## 8. Collaboration & gallery server

- Client: `YDocStore` + `CollabSession` (lazy), BroadcastChannelProvider, jam roles; undo local-only; Yjs history unbounded (documented).
- Server (`server/collab-server.mjs`, ~850 lines): Yjs WS relay with origin checks; gallery REST (GET/POST /api/gallery, play, report, admin reports/delete, health). Limits: 256 rooms / 512 conns / 32 per room / 96-char ids / 8 MB msgs; gallery 500 items / 400k-char codes; per-IP rate limits; `CORS_ORIGIN` env (production rejects `*`). Gallery items carry genre+regenerable extracted from `pattern.generation.intent` (fixed `a91ad77`).
- Gallery client: feed with inline EmbedApp, OPEN IN KYX, REGEN (intent carry), REMIX (buildRemix → auto-publish with lineage), JAM LIVE, FORK, REPORT.

## 9. UI layer

- `src/ui/` (~90 files): `App` shell, context DI (`useServices`, `useDoc`, slice hooks), heavy panels lazy-loaded. Shared rAF loop (`src/services/rafLoop.ts`, zero imports) drives meters/playhead. `src/services/funnel.ts` — generic, localStorage-only, **no reader yet** (data ships unread).
- **Styles:** `src/styles/` split (19 files + `index.css`; **order load-bearing**).
- **Keybinding policy:** Space = transport always; click-does-not-focus + `data-allow-focus`.
- **PWA:** prompt updates; precache includes curated WAVs, excludes `models/ort/**`, ranker ONNX, `golden-review/**`; 4 MiB/file; desktop build drops the plugin.
- **Desktop:** `desktop/main.cjs` serves `dist/` over `app://bundle` (traversal-guarded), silent media/MIDI grants, electron-updater (GitHub feed), `KYX_SMOKE=1` harness; `/download` route.

## 10. Critical execution paths

1. **Startup:** route pick → Boot handoff → `createCoreServices` → bank decode → `openProject` → engine `setProject` → worklet preload → MIDI access.
2. **Intent → sound:** IntentPanel → route → pipeline candidates (+ranker/semantic) → audition → apply command (ONE undo step) → engine diff-sync.
3. **Edit → sound:** UI control → command → store → normalize → `onDocChanged` → diff-sync → worklet params (`safeApplyAudioParam`).
4. **Playback:** `playPause` → transport anchor → scheduler windows → engine triggers.
5. **Save/reload:** debouncer → repo.save → reload → normalize → rebuild; frozen-restore; recording recovery.
6. **Export:** doc → OfflineAudioContext render → WAV → download (revoke guarded).
7. **Share/publish:** encodeShareCode → embed `#p=` / gallery POST → server extracts genre+regenerable → REGEN CTA → `intentSnapshotOfDoc`.
8. **Collab join:** URL param → lazy chunk → `YDocStore.fromDocument` → ws sync → remote edits through `onDocChanged`.

## 11. Async/concurrency boundaries

- Scheduler interval vs immutable doc reads; close-race `closed` flag guards; PcmMicRecorder start-token guards; single-writer save drain; delayed blob-URL revokes (optional-call); collab ws → YDoc apply → subscriber emission; rAF metering; worklet load fallback → rebuild-on-ready; ranker/semantic worker timeouts + circuit breakers.

## 12. High-risk areas

| Area | Risk | Evidence |
|---|---|---|
| `src/commands/commands.ts` (~6k L) | Central ownership; 22 `applyToYDoc` fast paths must mirror `execute()` | GOAL 02 sweep |
| `src/audio-engine/AudioEngine.ts` (~5.3k L) | Graph lifecycle, diff-sync; long-lived `this.doc` aliases undo snapshots (dev-only freeze) | GOAL 02 sweep |
| Concurrent-session churn | HARD RESET wiped uncommitted campaign work once (2026-09-20); commit campaign fixes promptly | work log incident |
| intent/ ↔ commands/ folder cycle | commands.ts imports intent/{production,pipeline,exact}; intent/{song,mix} import commands back — acyclic by file-level accident; one import from closing a hard cycle | GOAL 02 §17.6 |
| Intent routing overlaps | mix branch shadows production intents (darker/brighter/warmer + target word) | GOAL 03 candidate |
| `genre-reference.generated.ts` placeholder | genre loudness/tilt inert until measured; concurrent session owns | §6 |
| Ranker shadow default | trained ranker unused pending human golden re-review | §6 |
| DI bypasses in UI | GroovePoolRepository constructed in ModPanel/RackStrip; Morph/Ultina preset repos constructed in panels | §17.2 |
| Collab server exposure | limits+CORS shipped; moderation client-side only | §8 |
| Offline render non-cancellable mid-render; offline scene-BPM seam | export residuals | KNOWN_LIMITATIONS |
| jsdom full-suite runtime | 345 files, >2h on shared machine; flaky-timeout class | work log |

## 13. Discrepancies (docs vs reality, 2026-09-20)

1. README "36 effects" vs actual 45 (40 core + 5 flagship).
2. KNOWN_LIMITATIONS 32-float soft-knee claim stale (float path deliberately retains over-range samples).
3. Funnel marks have no consumer.
4. `effectProcessorStatus` cast union (registry.ts ~160-186) lists 24 kinds; `WORKLET_EFFECTS` has 32 — missing reverb, ringMod, tapeStop, freqShifter, pitchShift, vinyl, beatMangler, vocoder (harmless today, misleading list).
5. Development leftovers at root (`__debug_loop.mjs`, `qa-report.json`, `scratch/`, `tests/_dbg-*`, `tests/_probe-*`, `tests/_debug_archive/`) — GOAL 11 candidates.
6. `src/shared/dice.ts` imports intent/ai modules — feature logic parked in shared/ (upward edge).
7. `src/services.ts` imports `recordPlayActivity` from `./ui/playActivity` (infra→ui edge; file is import-free, harmless, mislocated).

## 14. Known architectural constraints (intentional — do not "fix")

- Immutable doc + command pattern; no global state framework. Undo at command layer only.
- Preview/audition transient — never mutates doc/history/collab. Engine previews write AudioNodes with rollback maps only.
- Live==offline DSP parity; seeded randomness; golden fixtures as contracts.
- Internal IDs and persisted formats frozen for branding. Vendored cores: fxeq patchable, ultina/ozvena byte-faithful.
- Collab: custom servers trusted; undo local-only; Yjs history unbounded. IndexedDB-only persistence.
- Ranker shadow-by-default until human re-review. `ARCHITECTURE.md §4` monorepo layout aspirational — not a defect.

## 15. Baseline health

### 2026-09-20 re-verification (GOAL 01+02)

- **HEAD:** `a91ad77` (campaign commit: provenance fix re-applied) on top of concurrent session's `ca876d5` chain.
- **Incident:** concurrent session's `git reset` (reflog HEAD@{5}, ~20:1x) wiped the uncommitted first application of the provenance fix + the map rewrite. Re-applied, validated (33/33 gallery suites, filtered tsc clean), committed as `a91ad77`. Campaign rule going forward: **commit campaign fixes promptly; never leave them uncommitted across sessions.**
- `tsc --noEmit`: PASS (filtered clean for all campaign files).
- Full Vitest suite: a background run was killed as STALE (the hard reset changed the tree mid-run). Fresh full-suite baseline deferred; treat as GOAL 12 gate.
- `npm run build` / browser suites: not re-run (GOAL 12 gate). Budgets: entry 1070 KB, total 2400 KB, landing closure 600 KB (forbidden: transformers.web-, App-), worklets 150 KB — `scripts/check-bundle-size.mjs`.

### Historical

- 2026-09-13: full suite 2315 passed/103 skipped; build PASS; browser smoke 218/218 (Edge+Firefox); release preflight + server smoke PASS.
- 2026-09-10: campaign origin; 1983/1/95 baseline; revokeObjectURL guard class fixed.

## 16. Areas requiring deeper audit (queued)

1. **GOAL 03:** intent routing overlap (mix vs production with explicit targets); `?regen=1` end-to-end on a REAL generated beat.
2. **GOAL 04/05:** recording-recovery lifecycle; FrozenBuffer/Library silent-write-failure paths.
3. **GOAL 07:** PcmMicRecorder chunk-ack under IDB slowness; concurrent commit absorption races.
4. **GOAL 10:** kaskada unmask solver CPU; morph-dynamics DSP budget once landed.
5. **GOAL 11:** root/test debug leftovers; dual ORT trees (`@huggingface/transformers` + onnxruntime-web).
6. Funnel telemetry consumer; genre-reference measurement + commit (concurrent session).

## 17. Boundary & ownership findings (GOAL 02, 2026-09-20)

1. **Command-layer exclusivity: HOLDS** (see §3). No violations found; enforcement via dev-only deepFreeze of undo snapshots.
2. **DI bypasses (UI constructs infra directly):** `ModPanel.tsx` + `RackStrip.tsx` `new GroovePoolRepository()` (services surface already exposes `groovePool` — route through DI); `MorphDynamicsPanel.tsx` (`MorphPresetRepository`, in-flight file — concurrent session's; NOT touched) and `UltinaPanel.tsx` (`UltinaPresetRepository`) — repos not on services surface at all. Growing UI→IndexedDB coupling pattern.
3. **Storage key duplication:** `pf-publish-code` defined in `gallery/PublishButton.tsx`, `gallery/GalleryPage.tsx` AND written as a raw literal in `ui/CollabPanel.tsx:90` (magic string, third site, outside gallery layer). Other keys single-source. Naming conventions coexist (`pf-kebab` vs `pf:colon`) — cosmetic.
4. **Literal duplication:** output-trim clamp `[-18,+12]` + 1-decimal rounding coded in `src/effects/presetLoudness.ts` (`clampFxOutputTrimDb`) AND inline in `src/project-model/schema.ts:~641` — schema should call the function (same numbers today).
5. **Provenance walk duplication:** fixed by `a91ad77` (EmbedApp now uses `intentSnapshotOfDoc`; server reads `generation.intent`).
6. **intent/ ↔ commands/ bidirectional folder coupling:** `commands.ts` imports `intent/production|pipeline|exact`; `intent/song.ts` + `intent/mix.ts` import `commands/commands` (`snapshot`). No module cycle today (verified import chains); one careless import from closing a hard cycle. Monitor; extract `snapshot` helper if it ever closes.
7. **`effectProcessorStatus` stale cast union:** registry.ts cast literal missing 8 worklet kinds (harmless — type-only; runtime accepts full set).
8. **Exhaustiveness gap:** `EFFECT_ORDER`/`CORE_EFFECT_ORDER` are plain arrays — a new EffectType missing from them silently vanishes from Add-Effect menus with no compile error. Consider an exhaustive-guard test.
9. **Mislocated files (cosmetic):** `src/shared/dice.ts` (feature-coupled), `src/ui/playActivity.ts` (imported by services.ts).
