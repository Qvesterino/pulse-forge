# SYSTEM AUDIT MAP — Pulse Forge (public brand: KYX)

**Created:** 2026-09-10 (hardening campaign, GOAL 01)
**Purpose:** Trustworthy map of how the system actually works, for use by scheduled audit/repair sessions.
**Companion docs:** `ARCHITECTURE.md` (intent), `KNOWN_LIMITATIONS.md` (accepted residuals), `AGENT_WORK_LOG.md` (campaign continuity).

---

## 1. Product & stack

Browser-first beatmaking DAW. Public brand **KYX**; flagship plugins publicly named **PRISM** (`fxeq`), **VLYX** (`ultina`), **VØID** (`ozvena`). Internal IDs/persistence keys keep the old Pulse Forge names — do not rename.

- **Stack:** TypeScript, React 18, Vite 6, Web Audio + AudioWorklet, Yjs (lazy collab chunk), IndexedDB persistence, PWA (prompt-mode updates), Vitest (jsdom) + Playwright browser smoke.
- **No backend required for core flow.** One optional Node relay: `server/collab-server.mjs` (WebSocket Yjs relay + file-backed "Beat Gallery" + rate limiting).
- **Entry:** `index.html` → `src/main.tsx` → route split: `/embed` (share player), `/gallery` (feed), `/` landing for first-time visitors → `/studio` → `Boot` → `createCoreServices()` → `ProjectBrowser` → `openProject(core, doc)` → `App`.

## 2. Runtime service composition (`src/services.ts`)

Two service tiers — this is the load-bearing seam of the app:

- **`CoreServices` (cross-project, created once):** `AudioEngine` (one shared `AudioContext`, never re-created across project switches), factory `SampleBank`, and IndexedDB repositories: `ProjectRepository`, `SnapshotRepository`, `PresetRepository`, `LibraryRepository`, `KitRepository`, `GroovePoolRepository`, `LatencyCalibrationController`.
- **`Services` (per open project, `openProject()`):** `store` (`ProjectStore` local OR `YDocStore` when collab is active), `Transport`, `Scheduler`, `PlaybackController`, `MidiInput/Output/Clock`, `UserSampleRepository`, `FrozenBufferRepository`, `ArrangementCaptureController`, `GhostPreviewPlayer`, `NoteRepeatController`, `collab: CollabSession | null`, plus `flushSave()` / `closeProject()` / `getDiagnostics()`.
- `closeProject()` runs ordered teardown (`closed` flag first so pending async continuations — frozen-restore, MIDI permission grant — become no-ops), then flushes the final save.
- **In-flight WIP at campaign start (uncommitted, verified coherent):** KYX roadmap items — instrument preset audition (`AudioEngine.previewInstrumentPreset`), track meter snapshots + clip indication, `resetEffect` command + MODIFIED dirty indicator, Inspector Simple/Advanced, collab-server hardening (room/connection/payload limits, CORS policy, /api/health metrics). Tests for all of the above included.

## 3. State model & ownership

- **Single source of truth:** `ProjectDocument` (`src/project-model/types.ts`, immutable, ~927 lines of types). No React state, no AudioNodes, no DOM refs inside it. Runtime (engine) state must always be reconstructable from it.
- **Mutation path:** UI → **commands** (`src/commands/commands.ts`, 5.7k lines — the central ownership file) → `store.execute(command)` → new immutable doc via `normalizeProject` → `onDocChanged` → (a) `engine.setProject(doc)` diff-sync, (b) `transport.setBpm`, (c) autosave arm.
- **`ProjectStore`** (`src/store/ProjectStore.ts`): undo stack 256 entries, coalescing window 1 s (`coalesceKey`), redo cleared on execute, `jumpTo` history panel, `replaceDoc` watermark reset. History panel diffs via memoized `computeDocDelta`.
- **`YDocStore`** (collab): CRDT-backed store with the same external surface; local-only undo; remote edits never enter the undo stack. Jam roles gate local commands (`roleProvider`, `onRoleBlocked`).
- **Selection/Tool state:** separate `SelectionStore`, `ToolStore` — deliberately outside the doc.
- **Schema:** `SCHEMA_VERSION = 1`; no versioned migrations — instead a full **normalization boundary** (`src/project-model/schema.ts`, ~1.9k lines): every doc entering the store (constructor, `replaceDoc`, execute, undo, redo) passes through `normalizeProject`, which clamps/sanitizes every domain (tracks, scenes, arrangement, automation, LFOs, markers, audio clips, device state…). Import paths additionally validate size ceilings (25 MB project / 10 MB MIDI per release roadmap 1.4).

## 4. Time, transport & scheduling

- **Three time domains, never interchangeable:** musical (ticks, PPQ=480, `BAR_TICKS=1920`), audio (`AudioContext.currentTime`), wall/UI (rAF).
- **`Transport`** (`src/transport/Transport.ts`): anchor-based tick↔time mapping, position-preserving `setBpm`, exact-anchor `setBpmAnchored` (scene-tempo seam), loop region, count-in/pre-roll, NaN-guarded seek.
- **`Scheduler`** (`src/scheduler/Scheduler.ts`, ~900 lines): lookahead — 25 ms interval, 120 ms horizon. Tick-space event windows with quantized pattern-launch commits, tempo-seam window splits (piecewise tick→time map matching offline `buildTempoMap`), loop wrap, AudioContext-state gating (suspension "machine-gun" guard + re-anchor on resume), derived-structure caching keyed on doc reference. Callbacks into: engine (trigger/noteOn/audioClips/metronome/automation/modulators/envFollowers/sceneIntensity/sceneTempo/marker), capture, store (`setActivePattern`), MIDI out (delay-from-now conversion).
- **`PlaybackController`** (`src/services.ts`): play/pause/stop/seek/launchScene; pre-roll logic; frozen-source resurrection on play.

## 5. Audio engine & DSP

- **`AudioEngine`** (`src/audio-engine/AudioEngine.ts`, 4.1k lines — second central ownership file): owns the whole WebAudio graph — per-track chains (gain/pan/mute/solo/sends), returns, master limiter, analysers (metering), voice sets (drum voices, preview voices, instrument preview voices), one-shot committed sources (audio clips/markers/clicks), instrument runtimes (registry factory), effect runtimes (worklet nodes + fallbacks), automation/modulator application, effective-BPM sync for tempo-synced runtimes.
- **Effects:** `src/effects/registry.ts` + worklet wrappers in `src/audio-worklets/` (~20 processors). Flagship cores are **vendored**: `src/effects/fxeq-core/**` (fork — may be patched, `vendor-fxeq.mjs` must NOT run), `src/effects/ultina-core/**` (byte-faithful vendored — 5 documented upstream defects, NEVER patch here; fix upstream `D:/VocalForge_DAW/plugins/ultina` and re-vendor), ozvena likewise. Worklet bundles are built into `public/` by `scripts/build-{fxeq,ultina,ozvena}-worklet.mjs` (run via `predev`/`prebuild`).
- **FXEQ parameter surface** is owned by the vendored core (`src/effects/fxeq-core/core/parameterSchema.ts` → `buildFxEqSchema(bandCount)`). It is the **single source of truth** consumed by `src/commands/commands.ts` (3 sites for set/preset/undo paths), `src/effects/registry.ts`, `src/project-model/targets.ts` (automation target validation), `src/effects/fxeqNode.ts`, `src/ui/FxEqPanel.tsx`, `src/ui/fxeqCurve.ts`. New FXEQ parameters (`crossoverFreq6` added 2026-09-13, see §14 WIP substance) propagate automatically through `buildFxEqSchema(bandCount)` — no command/registry/targets plumbing changes needed. This is the architectural pattern to preserve.
- **Vendor protection models** (intentionally heterogeneous, each matches the fork's relationship with its upstream):
  - **`scripts/vendor-ultina.mjs`** (added 2026-09-13 in `173f5ce`): `assertUpstreamClean()` refuses to run if the upstream working tree has uncommitted files in `${scope}/src` or `${scope}/tests/vectors`. `--allow-dirty-upstream` escape hatch. Prevents silent overwrites of an in-place patch.
  - **`scripts/vendor-ozvena.mjs`**: detects "Reconciled from Pulse Forge" markers in the destination and aborts if the upstream snapshot would silently revert in-place audit fixes. `--force-reconciled` escape hatch.
  - **`scripts/vendor-fxeq.mjs`**: **no guard** — FXEQ is a fork that may be patched in place. The script must not run automatically; any re-vendor overwrites in-place patches by design.
- **Instruments:** 14 kinds, `src/instruments/registry.ts`, runtime factory pattern (`InstrumentRuntime`: noteOn/noteOff/panic/dispose/setParams…).
- **Offline render:** `src/rendering/bounce.ts` uses `OfflineAudioContext` through the SAME engine DSP rules (live==offline is a core invariant); `wav.ts` (16/24/32-float), `video.ts`, stems.
- **DSP invariants:** zero allocation in `process()`, bounded blocks, determinism (no wall-clock in DSP), golden fixtures/vectors as contracts (`tests/fxeq-golden`, `tests/ozzena-golden`, `tests/ultina-vectors`).

## 6. Persistence & recovery

- **IndexedDB** `pulse-forge` v10 (`src/persistence/db.ts`): 11 stores (projects, meta, presets, library, user-samples + audio bytes, frozen-audio, user-kits, groove-pool, project-snapshots + snapshot index, ultina-presets). Transaction helper resolves only on `oncomplete` (durability); blocked-open timeout; rejection not cached.
- **Autosave:** debouncer (800 ms, max-defer 5 s / 50 arms — `autosave-debouncer.ts`), single-writer drain (`flushSave` chains queued revisions), save-status state machine (`saved|dirty|saving|error`), revision capture (`documentAtStart`) so a newer edit during an in-flight write is re-queued.
- **Snapshots:** `SnapshotRepository` — session-start + ≥24 h daily, 20/project, best-effort.
- **Unload safety:** `installSaveUnloadGuards` (pagehide + beforeunload dirty warning). Frozen tracks restore from IndexedDB with auto-unfreeze on missing buffer; unreferenced frozen buffers GC'd across ALL projects.
- **Export/import:** `.pulseforge.json` (`src/export/project-io.ts`, sanitized + size-capped), share codes (LZ-compressed URL param), MIDI file I/O, scorepack.

## 7. Collaboration

- Client: `YDocStore` + `CollabSession` (y-websocket, lazy chunk), `BroadcastChannelProvider` for local tabs, jam roles (`src/collab/jamRoles.ts`).
- Server: `server/collab-server.mjs` — Yjs relay (rooms), awareness, Beat Gallery (JSON file, 500-item cap), rate limiting (post/play), and (WIP) room/connection/payload limits + CORS policy + health metrics.
- Undo is local-only in collab; Yjs history intentionally unbounded (documented limitation).

## 8. UI layer

- `src/ui/` (~1.1 MB): `App` shell, context-based DI (`useServices`, `useDoc`, `useLibrary` in `ui/context`). Heavy panels lazy-loaded (`FxEqPanel`, `UltinaPanel`, `OzvenaPanel`, `SliceLab`, collab chunk).
- Shared rAF loop (`src/services/rafLoop.ts`) drives meters/playhead without per-component timers.
- Routes split at `main.tsx`; embed/gallery never load studio chunks. PWA update banner (`sw-update.ts`).

## 9. Critical execution paths (for GOAL 03)

1. **Startup:** `createCoreServices` → factory bank decode → `openProject` → engine `setProject` → worklet preload → MIDI access (async, close-race-guarded).
2. **Edit → sound:** UI control → command → store → `onDocChanged` → engine diff-sync (rebuild chains) → worklet param writes.
3. **Playback:** `playPause` → transport anchor → scheduler windows → engine triggers → (MIDI out / capture ring side-channels).
4. **Save/reload:** debouncer → `repo.save` (IndexedDB, revision-guarded) → reload → repository list/open → normalize → engine rebuild; frozen-audio restore path.
5. **Export:** doc → `OfflineAudioContext` render (same engine) → WAV encode → blob download (revoke guarded).
6. **Collab join:** URL param → lazy chunk → `YDocStore.fromDocument` → ws connect → sync step 1/2 → remote edits flow through `onDocChanged` path.

## 10. Async/concurrency boundaries (for GOAL 07)

- Lookahead scheduler interval vs. immutable doc reads (reference-stable caching).
- Close-race guards in `openProject` (`closed` flag) for: frozen restore, MIDI permission, snapshot check.
- Save drain (single-writer promise chain + queued follow-ups).
- Collab ws messages → YDoc apply → subscriber emission.
- rAF metering loop; debounced autosave; 5 s delayed blob-URL revokes (now optional-call guarded).
- Worklet module loading is fire-and-forget with fallback → rebuild-on-ready.

## 11. High-risk areas (concentrate audit effort here)

| Area | Risk | Evidence |
|---|---|---|
| `src/commands/commands.ts` (5.7k L) | Central ownership; every mutation passes here; undo correctness | KYX §3 rule 9 |
| `src/audio-engine/AudioEngine.ts` (4.1k L) | Graph lifecycle, diff-sync, voice leaks, worklet fallbacks | KYX §3 rule 9 |
| Vendored `ultina-core` | 5 confirmed upstream DSP defects; must NOT be patched locally | KNOWN_LIMITATIONS §Ultina |
| `fxeq` random LFO unseeded | Nondeterministic exports (P0 in KYX roadmap) — **CLOSED** by host-seeded xorshift32 (re-seeded on reset) per GOAL 03 (2026-09-10); per-instance host seed from project/owner/effect identity refined further post-`5f49140` | KNOWN_LIMITATIONS §Export |
| Offline render non-cancellable; 32-float WAV hard clip; marker cues missing in master WAV | Export residuals | KNOWN_LIMITATIONS §Export |
| Ozvena audio-thread allocations (IR partition FFT, pre-delay growth) | Dropouts | KNOWN_LIMITATIONS §Ozvena |
| Collab server exposure (pre-auth internet) | Limits shipped in WIP; moderation/CORS still open | KYX §11 |
| Scene-mode Wave 2/3 (wall-clock composition, texture upgrades) | In-flight feature, unchecked roadmap items | SCENE-MODE-ROADMAP |
| jsdom test-suite runtime (~15 min full run) | Flaky-timeout class of failures (one fixed this session) | work log GOAL 01 |

## 12. Known architectural constraints (intentional — do not "fix")

- Immutable doc + command pattern; no global state framework (explicit non-goal).
- Undo at command layer only, never reverses WebAudio directly.
- Collab undo local-only; custom collab servers trusted by design (documented).
- Preview is transient runtime state — never mutates doc/history/collab (KYX §3 rule 2).
- Live==offline DSP parity; deterministic seeds for playback-affecting randomness.
- Internal IDs (`fxeq`/`ultina`/`ozvena`) and persisted formats are frozen for branding.
- `ARCHITECTURE.md §4` apps/packages monorepo layout is aspirational; actual layout is flat `src/` (README documents the mapping). Not a defect.
- IndexedDB-only persistence (no OPFS yet) — README-accurate; ARCHITECTURE §47 recommends OPFS for samples (future work).

## 13. Discrepancies found (docs vs reality)

1. `MAINTENANCE_AUDIT_PROGRESS.md` still lists as open several items fixed later (scene-tempo seam, automation staircase, import size caps) — superseded by RELEASE_ROADMAP/KNOWN_LIMITATIONS.
2. Instrument count drift: README "14 instruments", KYX roadmap says 13 (registry has 14 kinds incl. drumsynth — KYX doc counts differently). Cosmetic.
3. Phase C checklist in MAINTENANCE_AUDIT_PROGRESS marks C01–C23 complete but the results log records only C01 — record gap, not necessarily a code problem.
4. `tests/_debug_archive/`, `scratch/`, `__debug_loop.mjs`, `qa-*.mjs` scripts at root — development leftovers (GOAL 11 sweep candidates).

## 14. Baseline health

### 2026-09-10 baseline (original GOAL 01)

- `tsc --noEmit`: **PASS**
- `vitest run`: **1983 passed / 1 failed / 95 skipped** (200 files, ~15 min). The 1 failure (`tests/ui/midi-io.test.tsx` import waitFor) was load-related flake + an unhandled `URL.revokeObjectURL` TypeError from a post-test 5 s timer — **fixed this session** (optional-call guard at 5 production sites + 10 s waitFor timeout). Browser suite (`npm run test:browser`) not yet re-run this session — GOAL 12 gate.
- Build: not yet re-run this session — GOAL 12 gate.

### 2026-09-13 re-verification (current release-candidate review)

- **HEAD:** `699c8a3` (`tentokrat`) — the reviewed FXEQ six-band crossover
  surface correction is committed on top of the Ultina reconciliation in
  `173f5ce`; the prior browser measurement follow-up is `4279467`.
- **Prior campaign commits:** `81553dd`, `7abc415` and `173f5ce` remain
  historical context; the current functional baseline is `699c8a3`.
- **Working tree:** only `AGENT_WORK_LOG.md` is modified outside `HEAD`; no
  functional FXEQ/Ultina WIP is mixed into the candidate.
- **FXEQ change:** `crossoverFreq6` is present in the authoritative schema,
  processor bulk/single routing, PRISM panel drag surface and generated
  `public/fxeq-worklet.js`. Defaults are the intended
  `120/400/1200/4000/8000` ladder; monotonic clamping enforces a 40 Hz minimum
  gap and widens legacy coincident 8 kHz splits to 8.04 kHz.
- `tsc --noEmit`: **PASS** after the current review.
- Focused PRISM batch: **115/115 PASS** after the six-band UI test was added.
  Golden parity is
  **8/8 within tolerance**, with 7/8 bit-exact and one expected legacy-split
  difference.
- Full Vitest suite: **not re-run after `699c8a3`** — the historical
  authoritative run was 234 files / 2300 passed / 103 skipped / 1 timeout;
  complete post-candidate rerun remains required.
- `npm run build`: **PASS** after `699c8a3` — entry 938 KB / 995 KB, total JS
  1849 KB / 2400 KB, core worklets 98 KB / 120 KB, 356 modules, PWA precache
  57 entries / 4037.47 KiB.
- `npm run release:preflight` and `npm run release:server-smoke`: **PASS**
  with explicit production environment/origin settings.
- Browser smoke: the latest clean Chromium run is **218/218 before
  `699c8a3`**; current-candidate rerun remains required. Manual Safari/iOS and
  deployed-host checks remain owner gates.

### WIP substance (what changed since the previous campaign session)

- **FXEQ 6-band crossover ladder realignment** (`src/effects/fxeq-core/core/parameterSchema.ts`, `fxEqProcessor.ts`): the schema gains `crossoverFreq6` (default 8000 Hz, 4–20 kHz range). Existing saved docs continue to pin their old values explicitly — backward compatible. Defaults now realigned to `DEFAULT_CROSSOVER_FREQS` ladder (120/400/1200/4000/8000). Comment notes the previous defect: a 6-band config had splits 4 and 5 coinciding on the bank's hidden 8000 Hz default, creating a dead band; dragging Xover 5 above 8 kHz silently inverted against the invisible split and deleted 8–12 kHz from the summed output. **This is a substantive DSP correctness fix**, not a stylistic change.
- **Ultina transient/sustain + Pre-Emphasis experiment** (`src/effects/ultina-core/dsp/modules/eqModule.ts`, `exciterModule.ts`, `contracts/{parameterIds, parameterSchema}.ts`, `dsp/maskingMeter.ts`, `dsp/primitives.ts`): landed and reconciled through `173f5ce`; the matching upstream source/test is `D:/VocalForge_DAW` commit `c0a549d`, with dirty-upstream vendor protection in place.
- **FXEQ six-band crossover correction** is landed in `699c8a3`; its focused hardening, UI drag, rack contract and golden coverage are green. It is a substantive DSP/defaults change and must remain in the final browser/full-suite review.

## 15. Open release gates (carried from 2026-09-13 RELEASE_READINESS_REPORT, refreshed)

- **R7 (closed in `699c8a3`):** the formerly mixed Ultina/FXEQ worktree is
  separated into reviewed commits; only the continuity log remains dirty.
- **Full Vitest suite rerun** on the post-`699c8a3` tree — last authoritative
  run was pre-`5f49140` (1 timeout, 2300 pass).
- **`npm run test:browser`** rerun — required to confirm PRISM plugin workflow
  + the new FXEQ 6-band crossover surface in real WebAudio.
- **Manual Firefox/Safari/iOS matrix** — owner gate, unchanged.
- **`release:deployed-smoke`** with a real `KYX_DEPLOY_URL` — owner gate, unchanged.
- **Formatting deviations (R9)** — 209 files, owner decision pending.
