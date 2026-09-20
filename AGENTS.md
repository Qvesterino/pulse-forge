# AGENTS.md

> Coding-agent entry point for the **KYX / Pulse Forge** browser-native DAW.
> Consumed by Codex, OpenCode, Cursor, Aider, Devin, Gemini CLI, and similar.
> For user-facing docs see `README.md`. For architecture see `ARCHITECTURE.md`.
> For the canonical inventory of "what ships today" see `docs/CURRENT-STATE.md`.
> For ADRs see `docs/adr/`.

---

## 0. Project identity in one paragraph

This is **KYX** (display name; landing page, embed, gallery), internally and on GitHub known as **Pulse Forge** (repo name `pulse-forge`, `package.json#name`). Both names refer to the same product. Use **KYX** in user-facing copy; use **Pulse Forge** in file paths, ADRs and roadmap documents.

A browser-first, fully offline-capable, production-grade digital audio workstation for instrumental beat and scene-score composition. Built on the Web Audio API + AudioWorklet, TypeScript, React 18 and IndexedDB. Ships as a PWA and as a Windows desktop app (Electron). Real-time collaboration, an ONNX-backed intent engine, vendored flagship DSP plugins (PRISM / VLYX / VØID / Kaskáda Delay), and a deterministic offline renderer that shares an `AudioEngine` with live playback.

---

## 1. First session in 60 seconds

```bash
npm install
npm run dev           # vite dev server — http://127.0.0.1:5173
npm run typecheck     # strict tsc --noEmit
npm run test          # vitest (jsdom, ~219 spec files)
npm run build         # production build + bundle budgets
```

Pre-`dev` and pre-`build` hooks rebuild the AudioWorklet bundles (`build:core-worklets`, `build:fxeq`, `build:ultina`, `build:ozvena`). If worklets changed and the dev server is already running, restart it or run the worklet build explicitly first.

The project browser (`src/ui/ProjectBrowser.tsx`) is the first screen on every boot; the landing page (`src/landing/LandingPage.tsx`) is shown once before `localStorage["kyx-onboarded"]` is set to `"1"`. Returning users skip the landing page.

---

## 2. Repository map (one-liner per directory)

| Path | One-liner |
|---|---|
| `src/audio-engine/` | `AudioEngine.ts` (~182 KB) — single source of audio truth; metering, recorder, latency calibration, onset detection, note repeat, IR generator, phase vocoder, time-stretch. |
| `src/audio-worklets/` | AudioWorklet processors: reverb, sidechain, limiter, gate, transient, fxeq, ultina, ozvena, kaskada, wtvoice, granular voice. |
| `src/audio-workers/` | Web Workers that wrap heavy CPU work: `ir-generator.ts`, `onset-detector.ts`, `warp-render.ts`. |
| `src/scheduler/Scheduler.ts` | 25 ms tick / 120 ms lookahead scheduler; the only event driver for live playback. |
| `src/transport/Transport.ts` | Musical-time model (PPQ 480, ticks ↔ seconds); play/pause/stop/loop/metronome. |
| `src/project-model/` | `schema.ts` (`SCHEMA_VERSION = 1`), `types.ts`, transforms, `groove.ts`, `automation.ts`, `modulators.ts`, scenes, **templates** (12), kit-presets, `markers.ts`. |
| `src/commands/` | Command system; every mutation flows through commands; `yDocBridge.ts` for collab; `layerCommands.ts` for grouped redo. |
| `src/store/` | `ProjectStore`, `SelectionStore`, `ToolStore` — pure pub/sub state. |
| `src/instruments/` | `registry.ts` — `INSTRUMENT_DEFS` and `INSTRUMENT_ORDER` for 14 instrument kinds. Mod matrix, randomization. |
| `src/effects/` | `registry.ts` — `EFFECT_DEFS` for 36 effect types + 4 flagship plugin suites. `fxeq-core/`, `ultina-core/`, `ozvena-core/` are vendored cores mirrored from upstream; vendor via `scripts/vendor-*.mjs`. |
| `src/sample-library/` | `manifest.ts` (41 factory assets), `factory.ts` (synthesized fallbacks), `curated.ts` (curated WAV overrides), `kit-pools.ts`, `velocity-layers.ts`. |
| `src/presets/` | `factory.ts` (199 instrument presets + 6 drum presets = 205), `normalization.ts`, `similar.ts`, `audioQuality.ts`. |
| `src/rendering/` | `renderer.ts` (`renderProject()` — the offline render entry point), `bounce.ts`, `stems.ts`, `wav.ts` (16/24-bit + 32-bit float RIFF encoder). |
| `src/export/` | `project-io.ts` (10 MB import cap), `shareCode.ts` (2 M-token / 8 M-char caps), `mp3.ts` (LAME via wasm), `video.ts`, `scorepack.ts`, `zip.ts`, `packCode.ts`, `themeCode.ts`, `kitCode.ts`, `bindsCode.ts`. |
| `src/persistence/` | IndexedDB repositories (project, preset, library, kit, frozen buffers, user samples, ultina presets, groove pool, snapshot), `save-lifecycle.ts`, `autosave-debouncer.ts`. |
| `src/midi/` | Web MIDI input/output/clock; pattern recorder; midiFile/midiProject import-export. |
| `src/collab/` | `YDocStore.ts`, `CollaborationProvider.ts`, `CollabSession.ts` (lazy-loaded), `bandmate.ts` (AI Bandmate), `jamRoles.ts`, `transportSync.ts`. |
| `src/intent/` | Text→beat pipeline: `pipeline.ts`, `plan.ts`, `normalize.ts`, `text-parser.ts`, `candidate-bank.ts`, `providers/{local,symbolic}.ts`. |
| `src/ai/` | Generative engine, feature extractors, ONNX ranker + symbolic priors + their workers, datasets, golden vectors. |
| `src/analysis/` | `ultinaAnalysisClient.ts` + `ultinaAnalysisWorker.ts` — VLYX Mix Assist host. |
| `src/services/` | `rafLoop.ts` (one-bus rAF shared by meters and animations), `services.ts` (long-lived services wiring). |
| `src/ui/` | ~70 React components — every panel/dialog/editor. `App.tsx` (56 KB), `ArrangementPanel.tsx` (106 KB), `ModPanel.tsx` (70 KB), `Sequencer.tsx` (67 KB), `PianoRoll.tsx` (65 KB). |
| `src/embed/`, `src/gallery/`, `src/landing/` | Route-level apps: `/embed` beat player, `/gallery` community feed, `/landing` first-visit page. |
| `server/collab-server.mjs` | y-websocket relay + `/api/gallery` JSON store. One process, one port. |
| `desktop/main.cjs` + `desktop/preload.cjs` | Thin Electron shell (ADR 0010/0011); auto-update via electron-updater against GitHub Releases. |
| `tests/` | Vitest specs (~219 files), Playwright E2E (5 specs), golden-vector locks for the three vendored plugin cores, intent suite, persistence round-trip. |
| `docs/adr/` | Architecture decision records 0001–0011. Read the relevant ADR before touching the area. |
| `docs/CURRENT-STATE.md` | **Single source of truth** for "how many / what ships today". Update it in the same commit when you change a number. |

---

## 3. Non-negotiable invariants

These are the rules every coding agent must follow. They are encoded in `ARCHITECTURE.md` and several ADRs; if you have a good reason to break one, write a new ADR first.

1. **UI describes intent. Project model stores truth. Transport defines musical time. Scheduler plans audio events. AudioEngine executes them. DSP processes sound.** No layer silently absorbs responsibilities belonging to another.
2. **React must never become the source of truth for realtime audio execution.** Mutations go through commands → project model → engine projects onto the audio graph.
3. **One shared engine for live and offline.** The renderer hands the same `AudioEngine` an `OfflineAudioContext`; only the event driver differs. Exports sound exactly like the project.
4. **Determinism.** Same seed + intent + project → same content. AI models live behind timeouts + circuit breaker + heuristic fallback so they can never throw into the UI or audio callback.
5. **AudioWorklet for custom realtime DSP, never the main thread.** Plugins load on demand (`ensureWorkletsForDoc`) so a beat that never touches PRISM doesn't pay for it.
6. **Schema migrations** change `SCHEMA_VERSION` and update `migrateProject`; loading code rejects unknown future versions.
7. **The audio context is shared across projects.** `useContext(ctx)` is the only path that creates `AudioNode`s on a context — so a fresh `OfflineAudioContext` for export never leaks nodes into the live context.
8. **No VST/AU hosting, no ASIO driver management, no multitrack studio recording, no vocal recording** (per `VISION.md §1`). Don't add infrastructure for these.
9. **No Rust/WASM DSP path is shipped today.** AudioWorklet is the realtime DSP boundary. ADR 0005 keeps WASM as a future option. If you need new DSP, write a worklet.
10. **No innerHTML, no dangerouslySetInnerHTML, no eval, no `new Function`** anywhere in `src/`. User-controlled strings (filenames, project names, sample names, share tokens) go through React JSX (auto-escaped) or are sanitized explicitly (see `sanitizeFilename` in `src/export/project-io.ts`).

---

## 4. Code style and quality gates

- **TypeScript is strict.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `isolatedModules`. Use the existing types in `src/project-model/types.ts`, `src/effects/types.ts`, `src/audio-engine/metering.ts`.
- **Prettier** is the only formatter. Config in `.prettierrc`: `printWidth: 120`, `singleQuote: false`, `trailingComma: "all"`. `npm run format:check` must report `All matched files use Prettier code style!`.
- **Defensive parsing.** Every JSON.parse of untrusted data is wrapped in try/catch with a fallback. Every Web Worker `onmessage` validates `event.data` shape before processing (see `src/audio-workers/onset-detector.ts` and `src/audio-workers/warp-render.ts` for the canonical pattern; `src/audio-workers/ir-generator.ts` and `src/analysis/ultinaAnalysisWorker.ts` follow the same contract).
- **Decompression-bomb and import caps** are mandatory. Existing ceilings: share tokens 2 M chars / 8 M decompressed chars (`src/export/shareCode.ts`), project JSON 10 MB (`src/export/project-io.ts`), audio samples 25 MB (`src/ui/DropZone.tsx`).
- **`?server=` overrides** must use `isAllowedServerUrl` in `src/collab/collabShared.ts` — never bypass it. Self-hosted relays on other hosts must be entered in the UI deliberately, not via URL params.
- **State-management discipline.** Mutations go through commands (with full undo/redo). Project model is a plain serializable object. React components are renderers, never owners, of audio state.
- **Bundle budgets.** `npm run build` enforces budgets (entry 995 KB, total JS 2400 KB, core worklets 120 KB). If you need to grow a chunk, justify it in the PR.
- **AudioWorklet DSP lives in `src/audio-worklets/` and `src/effects/{fxeq,ultina,ozvena}-core/`.** Changes to those trees require running the matching `npm run build:core-worklets` / `build:fxeq` / `build:ultina` / `build:ozvena` before `npm run dev` or `npm run build`. The `predev` and `prebuild` npm hooks already do this automatically.

---

## 5. How to add common things

### Adding a new instrument
1. Define the kind in `InstrumentKind` union in `src/project-model/types.ts`.
2. Implement the instrument body in `src/instruments/registry.ts` (after the existing 14 definitions).
3. Register it in `INSTRUMENT_DEFS` and `INSTRUMENT_ORDER`.
4. Add factory presets to `src/presets/factory.ts` tagged by genre + mood.
5. Write tests: at minimum one happy-path note → audio out, plus one parameter-clamp test.
6. Run `npm run test:browser:factory-presets` to confirm audibility.
7. Update `docs/CURRENT-STATE.md` (bump the 14 → new count).

### Adding a new core effect
1. Define the effect type in `EffectType` union in `src/project-model/types.ts`.
2. Implement the runtime in `src/effects/registry.ts` (after the existing 36).
3. Register it in `EFFECT_DEFS` and the relevant `*_EFFECT_ORDER`.
4. Add at least one automated test in `tests/effects/`.
5. Verify live render and offline render parity (the same engine drives both — see `src/rendering/renderer.ts`).
6. Update `docs/CURRENT-STATE.md` (bump the 36 → new count).

### Adding a new vendored plugin suite (flagship DSP)
1. Open an ADR in `docs/adr/` that records why this plugin suite exists, what it does, and how it is vendored.
2. Mirror the upstream source into `src/effects/<name>-core/` and add a reconciliation script under `scripts/vendor-<name>.mjs`. Refuse to drop reconciliation markers the upstream snapshot lacks.
3. Add a worklet entry under `src/audio-worklets/` and a build script `scripts/build-<name>-worklet.mjs`.
4. Add a golden-vector test suite under `tests/<name>-vectors/` (input → expected output, bit-exact).
5. Wire the load order into `src/audio-worklets/loader.ts` (`PLUGIN_WORKLET_TYPES`).
6. Add a panel under `src/ui/<Name>Panel.tsx` and wire it into `src/ui/dockLayout.ts`.
7. Update `docs/CURRENT-STATE.md` (bump the 4 flagship count + add a row to the flagship table).

### Adding a new project template
1. Define a new `id` in the `TemplateId` union in `src/project-model/templates.ts`.
2. Add a starter doc factory (in `templates.ts` or `template-pack2.ts` for larger genre starters).
3. Add a thumbnail + description in the project browser (`src/ui/ProjectBrowser.tsx`).
4. Test the boot path: open the template, verify transport, mixer, scene state.

### Adding a new AI model (ONNX)
1. Train with the matching `scripts/train-*.py` and validate with `scripts/validate-*.{py,mjs}`.
2. Pin the model under `public/models/<name>-v1.onnx` + a sibling `<name>-v1.manifest.json` that records `featureVersion`, `featureCount`, `modelHash` (SHA-256), `inputName`, `outputName(s)`, `report`.
3. Add a worker under `src/ai/<bucket>/<name>-worker.ts`. The worker must validate `event.data` (Float32Array + size check) before passing to ORT.
4. Wire the worker into `src/ai/<bucket>/<name>-client.ts` with timeout + circuit breaker + deterministic heuristic fallback.
5. Add a golden set under `tests/intent/` and a real-inference smoke test.

---

## 6. Test gates — what must be green before merging

| Gate | Command | Expected result |
|---|---|---|
| Strict typecheck | `npm run typecheck` | EXIT 0 (clean `tsc --noEmit`) |
| Full Vitest suite | `npm run test` | 219+ files / 2351+ tests / 103+ skipped, all PASS |
| Format check | `npm run format:check` | `All matched files use Prettier code style!` |
| Real-browser audio | `npm run test:browser` | 226/226 in Chromium, Firefox and Edge |
| Factory preset QA | `npm run test:browser:factory-presets` | 199/199 |
| Targeted plugin hardening | (per plugin, under `tests/`) | PASS for PRISM, VLYX, VØID |
| 300 s plugin soaks | (per plugin, under `tests/`) | heap growth ≤ 6 MB, drift ≤ 0.003 dB, zero non-finite samples |
| Production build | `npm run build` | exit 0, bundle budgets respected |
| Vulnerability audit | `npm audit --omit=dev` | 0 vulnerabilities |

Owner gates still open (release-blocking, not feature-blocking): manual Firefox/Safari/iOS Safari smoke, `release:deployed-smoke` with a real `KYX_DEPLOY_URL`. See `RELEASE_READINESS_REPORT.md`.

### Playwright E2E

```bash
npm run test:e2e:smoke      # 5 core scenarios: landing→studio, panel toggles, generate, persistence, shortcuts
npm run test:e2e            # full Playwright suite (tests/e2e/)
```

The dev server must be on port 5199 with `--strictPort` (the playwright.config.ts owns this). `reuseExistingServer` is on, so a manual `npm run dev` is reused.

---

## 7. Common gotchas (read before opening a PR)

- **`useContext(ctx)` is the only path that creates `AudioNode`s.** Creating nodes directly via `ctx.createGain()` etc. without going through `AudioEngine.useContext()` will leave them attached to the wrong context (silent in live, broken in offline). See `ARCHITECTURE.md` §Engine.
- **`?server=` overrides must pass `isAllowedServerUrl`.** Bypassing that helper is a security regression — a crafted link pointing at `wss://evil` would silently relay the victim's whole project through an attacker host.
- **`URL.createObjectURL` requires `URL.revokeObjectURL`** — but only after the browser has fired the click. The codebase uses a 5-second timeout as a safety net; do not shorten it without a reason.
- **Worklet modules are vendored.** A change to `src/effects/fxeq-core/` is incomplete until `npm run build:fxeq` has been run. `predev` and `prebuild` do this automatically.
- **AI models** must be loaded behind `timeouts + circuit breaker + heuristic fallback`. Direct `session.run(...)` on the UI thread is not allowed.
- **Number counts are documented in `docs/CURRENT-STATE.md` only.** When you add or remove an instrument, effect, template, ADR or test file, update that single file in the same commit.
- **AudioWorklet DSP boundary**: AudioWorklets receive raw AudioWorkletProcessor messages — never trust `event.data` shape. The canonical pattern is in `src/audio-workers/onset-detector.ts:96` and `src/audio-workers/warp-render.ts:30-49`. Apply the same defense-in-depth to any new worker you add.
- **`noUnusedLocals` is strict.** A line like `import type { ReactElement }` that's not referenced will fail `tsc --noEmit`. Run `npm run typecheck` before any non-trivial PR.
- **Vitest specs under `tests/e2e/`** are run by Playwright, not vitest — `vitest.config.ts` excludes that directory explicitly to avoid double-execution. New E2E scenarios go in `tests/e2e/` and `playwright.config.ts`.
- **Schema versioning**: any change to the on-disk project shape must bump `SCHEMA_VERSION` in `src/project-model/schema.ts` and add a migration in `migrateProject`. Loading code rejects unknown future versions.
- **Bundle budgets**: `npm run build` enforces entry 995 KB, total JS 2400 KB, core worklets 120 KB. If you need to grow a chunk, justify it in the PR and update `scripts/check-bundle-size.mjs`.
- **Live and offline render parity**: the renderer hands the same `AudioEngine` an `OfflineAudioContext`. If a feature only works in one path, that's a bug. Verify by exporting the project and listening to the result.

---

## 8. Useful commands cheat sheet

```bash
npm run dev                                   # vite dev server (5173)
npm run test                                  # vitest
npm run typecheck                             # tsc --noEmit
npm run format                                # prettier --write
npm run format:check                          # prettier --check (must be clean)
npm run build                                 # production build + bundle budgets
npm run preview                               # serve dist/
npm run test:e2e:smoke                        # 5 core Playwright scenarios
npm run test:browser                          # real-browser verifier
npm run test:browser:factory-presets          # factory preset audio QA

# Worklets (auto-run by predev/prebuild hooks)
npm run build:core-worklets
npm run build:fxeq
npm run build:ultina
npm run build:ozvena

# AI model pipeline
npm run ranker:train                          # python: regenerate dataset, train, validate
npm run ranker:activate                        # flip shadow → active after golden gate passes
npm run prior:train                            # python: regenerate + train + validate symbolic prior
npm run ai:baseline                            # generate intent-ranker baseline
npm run ai:performance                         # latency harness for the intent pipeline

# Vendor reconciliation (mirrors upstream cores; both refuse to drop reconciled markers)
npm run vendor:ultina
npm run vendor:ozvena
npm run vendor:fxeq

# Desktop (Windows)
npm run desktop:dev                            # vite dev + Electron window
npm run desktop:build                          # NSIS installer + portable exe in release/
npm run desktop:smoke                          # boot Electron over dist/

# Collab / gallery server
npm run collab                                 # ws://127.0.0.1:1234 + /api/gallery

# Release
npm run release:preflight                     # explicit production config + shipped artifacts scan
npm run release:server-smoke                  # spawn server/collab-server.mjs and hit /api/health
npm run release:deployed-smoke                # requires KYX_DEPLOY_URL
```

---

## 9. Where to look for context before guessing

Before opening a PR or guessing at "how does X work", check the relevant ADR. ADRs are short, dated, and authoritative on the *why* of architectural decisions.

| Topic | Files |
|---|---|
| Browser-first platform | `docs/adr/0001-browser-first.md`, `docs/adr/0005-rust-wasm-dsp-policy.md` |
| Audio clock + scheduling | `docs/adr/0002-audio-clock-scheduling.md`, `src/scheduler/Scheduler.ts` |
| Project model ↔ runtime | `docs/adr/0003-project-model-runtime-separation.md`, `src/project-model/schema.ts` |
| AudioWorklet boundary | `docs/adr/0004-audioworklet-boundary.md`, `src/audio-worklets/loader.ts` |
| Effect rack, devices, native effects | `docs/adr/0006-effect-rack-native-effects.md`, `docs/adr/0006-device-state-slot.md` |
| Instruments and notes | `docs/adr/0007-instruments-and-notes.md`, `src/instruments/registry.ts` |
| VØID / reverb per-frequency decay | `docs/adr/0007-ozvena-per-frequency-decay-network.md` |
| Composition systems (intent, dice) | `docs/adr/0008-composition-systems.md`, `INTENT_ENGINE.md` |
| Offline render + export | `docs/adr/0009-offline-render-export.md`, `src/rendering/renderer.ts` |
| Desktop packaging | `docs/adr/0010-desktop-packaging.md`, `desktop/main.cjs` |
| Desktop auto-update | `docs/adr/0011-desktop-auto-update.md`, `electron-builder.yml` |

If a decision feels arbitrary, look for an ADR. If none exists and you think there should be one, write it.

---

## 10. Communication conventions

- **Commit messages**: imperative mood, present tense ("Add", not "Added"); prefix the area in scope (`docs:`, `audio-engine:`, `effects:`, `tests:`, `chore:`, `fix:`, `feat:`).
- **PRs**: keep the diff focused. If your PR touches more than ~600 lines or spans three or more top-level packages, split it.
- **Don't refactor unrelated code in the same PR.** Run `npm run format` before committing to avoid noise.
- **Don't bundle a `package.json` dependency bump with a feature PR.** Bumps get their own PR with `npm audit` before/after evidence.
- **Don't claim a number in `docs/CURRENT-STATE.md` that isn't verifiable from a `grep` or `Get-ChildItem` against the working tree.** The whole point of that file is that every count can be reproduced.
