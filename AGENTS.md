# AGENTS.md

> Coding-agent entry point for the **KYX / Pulse Forge** Web and Studio DAW.
> Consumed by Codex, OpenCode, Cursor, Aider, Devin, Gemini CLI, and similar.
> For user-facing docs see `README.md`. For architecture see `ARCHITECTURE.md`.
> For the canonical inventory of "what ships today" see `docs/CURRENT-STATE.md`.
> For ADRs see `docs/adr/`.

---

# MANDATORY: PROCESS LIFECYCLE & RESOURCE HYGIENE

PRIORITY: CRITICAL
SCOPE: ALL AGENTS, SUBAGENTS AND DELEGATED TASKS

## 1. PROCESS OWNERSHIP

Every agent is responsible for processes it starts.

Track all spawned processes, including:

- Node.js runtimes
- npm / pnpm / yarn commands
- Vite / Next.js development servers
- Test runners and watchers
- Build processes
- Temporary background services

## 2. IMMEDIATE CLEANUP

After completing verification, testing or building:

- Stop all temporary processes started by the agent.
- Terminate temporary development servers.
- Stop test watchers.
- Stop unnecessary background runtimes.
- Clean up processes after failures and timeouts.
- Never leave temporary processes running unnecessarily.

Cleanup must happen even when a task fails.

## 3. STRICT PROCESS ISOLATION

NEVER use:

```
taskkill /F /IM node.exe
Stop-Process -Name node
killall node
```

These commands are prohibited.

Agents must ONLY terminate processes they own.

Never terminate:

- Processes started by another agent.
- Processes belonging to another session.
- User-managed development servers.
- Shared infrastructure.
- Unknown Node.js processes.

## 4. VERIFICATION LIFECYCLE

Required workflow:

```
START PROCESS
    ↓
REGISTER PROCESS OWNERSHIP
    ↓
RUN TESTS / BUILD / VERIFICATION
    ↓
CAPTURE RESULTS
    ↓
STOP OWNED TEMPORARY PROCESSES
    ↓
VERIFY PROCESS TERMINATION
    ↓
REPORT RESULTS
```

Prefer synchronous, finite commands.

Avoid persistent watchers unless explicitly required.

## 5. SAFE TERMINATION

Always attempt graceful shutdown first.

Use forced termination only when:

- The process belongs to the current task.
- Graceful shutdown has failed.
- The process ownership is verified.

Never terminate an unknown process.

## 6. SUBAGENT RESPONSIBILITY

Every subagent must clean up its own processes.

The parent agent must verify that delegated tasks
did not leave unnecessary processes running.

## 7. COMPLETION CONTRACT

A task is not considered complete until:

- Verification has finished.
- Results have been captured.
- Owned temporary processes are terminated.
- No unnecessary background runtimes remain.
- Existing user processes remain untouched.

PROCESS CLEANUP IS MANDATORY.

## 7.1 SANCTIONED CLEANUP TOOL

Sections 1-7 above are the rule. This subsection is the tool that implements it.
Do **not** write a project-local kill script, and do **not** maintain a list of
processes to kill - a duplicated list is a list nobody checks.

`node-gc` is already on `PATH` (single shared implementation at
`C:\Users\danie\.minimax\bin\node-gc.ps1`):

| Command                    | Effect                                                  |
| -------------------------- | ------------------------------------------------------- |
| `node-gc`                  | reports abandoned test-runtime trees, **kills nothing** |
| `node-gc -Kill`            | terminates them bottom-up (children first, then root)   |
| `node-gc -Root <path>`     | restrict the sweep to one project                       |
| `npm run clean:procs`      | same as `node-gc` (this repo)                           |
| `npm run clean:procs:kill` | same as `node-gc -Kill` (this repo)                     |

Two properties make it safe. **Both must survive any change to it:**

- **Idleness is judged per process tree, not per process.** A tinypool worker
  that has finished its shard sits at 0 CPU while its parent runner is still
  working. A per-process test was falsified in practice: on a legitimate
  40-minute suite it reports a healthy worker as abandoned and destroys the run.
  A tree is abandoned only when _no_ member moves CPU during the sample window.
- **Orphan status is not used at all.** Measured 2026-10-17 on this machine:
  0 of 65 leftover `node.exe` processes had a dead parent, because
  `pwsh → npm → npx → vitest → tinypool` stays alive under the desktop app.
  "The parent died" is therefore not evidence of anything.

How this tool relates to section 3 (so the two do not look contradictory):

- `node-gc` matches **test runtimes only** (`vitest`, `tinypool`, `jest`).
  Dev servers, MCP servers and desktop apps are never matched by default -
  `-IncludeServices` opts in, and only they should need it.
- **`--watch` is never matched.** A watcher is a deliberate long-lived process,
  and section 3 forbids killing what you cannot prove you own. If you started a
  watcher, you stop it yourself - that is section 2, not `node-gc`.
- The agent runtime is excluded unconditionally: `@oai`, `.minimax`,
  `mcode-tools`, `OpenAI\Codex`, `Kilo`. `node-gc` cannot kill the agent that is
  running it.
- `node-gc` uses `Stop-Process -Id <pid>`, never the prohibited
  `Stop-Process -Name node`. It always targets a resolved, enumerated PID.

Honest scope limit: `node-gc`'s predicate is _abandonment_ (age + whole-tree
idleness), not _ownership_. That is deliberate - it covers exactly the case this
rule exists for, where the owning session is gone and ownership can no longer be
proven from inside a running session. Its threshold is 20 minutes
(`-MinAgeMinutes`) precisely because the default must be safe. When ownership
_is_ provable, stop the process directly instead.

---

## 0. Project identity in one paragraph

This is **KYX** (display name; landing page, embed, gallery), internally and on GitHub known as **Pulse Forge** (repo name `pulse-forge`, `package.json#name`). Both names refer to the same product. Use **KYX** in user-facing copy; use **Pulse Forge** in file paths, ADRs and roadmap documents.

A browser-first, local-first digital audio workstation targeting complete music production: composition, real-instrument recording, editing, mixing and AI-assisted production. KYX Web is built on Web Audio + AudioWorklet, TypeScript, React 18 and IndexedDB; KYX Studio is the separate desktop target for tested native audio I/O and third-party plug-in workflows. The current Windows Electron package is still a thin Web Audio shell. See ADR 0014 and `docs/ROADMAP-FULL-DAW.md`; roadmap scope is not a claim that those features already ship.

> **Orientation:** `docs/AGENT-MAP.md` is the task→files→gate map plus the
> invariant register (every hard-won truth with the test that guards it). Read
> it after this file; `tests/agent-map.test.ts` keeps it honest.

---

## 1. First session in 60 seconds

```bash
npm install
npm run dev           # vite dev server — http://127.0.0.1:5173
npm run typecheck     # strict tsc --noEmit
npm run test          # vitest (jsdom; current spec count is in docs/CURRENT-STATE.md)
npm run build         # production build + bundle budgets
```

Pre-`dev` and pre-`build` hooks rebuild the AudioWorklet bundles (`build:core-worklets`, `build:fxeq`, `build:ultina`, `build:ozvena`). If worklets changed and the dev server is already running, restart it or run the worklet build explicitly first.

The project browser (`src/ui/ProjectBrowser.tsx`) is the first screen on every boot; the landing page (`src/landing/LandingPage.tsx`) is shown once before `localStorage["pf-onboarded"]` is set to `"1"`. Returning users skip the landing page.

---

## 2. Repository map (one-liner per directory)

| Path                                         | One-liner                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/audio-engine/`                          | `AudioEngine.ts` (~182 KB) — single source of audio truth; metering, recorder, latency calibration, onset detection, note repeat, IR generator, phase vocoder, time-stretch.                                                                                                                                                                             |
| `src/audio-worklets/`                        | AudioWorklet processors: reverb, sidechain, limiter, gate, transient, fxeq, ultina, ozvena, kaskada, wtvoice, granular voice.                                                                                                                                                                                                                            |
| `src/audio-workers/`                         | Web Workers that wrap heavy CPU work: `ir-generator.ts`, `onset-detector.ts`, `warp-render.ts`.                                                                                                                                                                                                                                                          |
| `src/scheduler/Scheduler.ts`                 | 25 ms tick / 120 ms lookahead scheduler; the only event driver for live playback.                                                                                                                                                                                                                                                                        |
| `src/transport/Transport.ts`                 | Musical-time model (PPQ 480, ticks ↔ seconds); play/pause/stop/loop/metronome.                                                                                                                                                                                                                                                                           |
| `src/project-model/`                         | `schema.ts` (`SCHEMA_VERSION = 6`), `types.ts`, transforms, `groove.ts`, `automation.ts`, `modulators.ts`, scenes, **templates** (12), kit-presets, `markers.ts`.                                                                                                                                                                                        |
| `src/commands/`                              | Command system; every mutation flows through commands; `yDocBridge.ts` for collab; `layerCommands.ts` for grouped redo.                                                                                                                                                                                                                                  |
| `src/store/`                                 | `ProjectStore`, `SelectionStore`, `ToolStore` — pure pub/sub state.                                                                                                                                                                                                                                                                                      |
| `src/instruments/`                           | `registry.ts` — `INSTRUMENT_DEFS` and `INSTRUMENT_ORDER` for 24 instrument kinds. Mod matrix, randomization.                                                                                                                                                                                                                                             |
| `src/effects/`                               | `registry.ts` — `EFFECT_DEFS` for 48 core effects + 5 flagship plugin suites. `fxeq-core/`, `ultina-core/`, `ozvena-core/` are vendored cores mirrored from upstream; vendor via `scripts/vendor-*.mjs`.                                                                                                                                                 |
| `src/sample-library/`                        | `manifest.ts` and `factory.ts` (factory assets + synthesized fallbacks; counts in `docs/CURRENT-STATE.md`), `curated.ts` (curated WAV overrides), `kit-pools.ts`, `velocity-layers.ts`.                                                                                                                                                                  |
| `src/presets/`                               | `factory.ts` (factory instrument + drum presets; counts in `docs/CURRENT-STATE.md`), `normalization.ts`, `similar.ts`, `audioQuality.ts`.                                                                                                                                                                                                                |
| `src/rendering/`                             | `renderer.ts` (`renderProject()` — the offline render entry point), `bounce.ts`, `stems.ts`, `wav.ts` (16/24-bit + 32-bit float RIFF encoder).                                                                                                                                                                                                           |
| `src/export/`                                | `project-io.ts` (10 MB import cap), `shareCode.ts` (2 M-token / 8 M-char caps), `mp3.ts` (LAME via wasm), `video.ts`, `scorepack.ts`, `zip.ts`, `packCode.ts`, `themeCode.ts`, `kitCode.ts`, `bindsCode.ts`.                                                                                                                                             |
| `src/persistence/`                           | IndexedDB repositories (project, preset, library, kit, frozen buffers, user samples, ultina + morph presets, groove pool, snapshot), `save-lifecycle.ts`, `autosave-debouncer.ts`.                                                                                                                                                                       |
| `src/midi/`                                  | Web MIDI input/output/clock; pattern recorder; midiFile/midiProject import-export.                                                                                                                                                                                                                                                                       |
| `src/collab/`                                | `YDocStore.ts`, `CollaborationProvider.ts`, `CollabSession.ts` (lazy-loaded), `bandmate.ts` (AI Bandmate), `jamRoles.ts`, `transportSync.ts`.                                                                                                                                                                                                            |
| `src/intent/`                                | Text→beat pipeline: `pipeline.ts`, `plan.ts`, `normalize.ts`, `text-parser.ts`, `candidate-bank.ts`, `providers/{local,symbolic}.ts`.                                                                                                                                                                                                                    |
| `src/ai/`                                    | Generative engine, feature extractors, ONNX ranker + symbolic priors + their workers, datasets, golden vectors.                                                                                                                                                                                                                                          |
| `src/generative/`                            | Provider-neutral generative-track runtime, MRT2 browser/Electron adapters, KYX note conditioning, bounded AudioWorklet playback, durable capture and resample.                                                                                                                                                                                           |
| `src/analysis/`                              | `ultinaAnalysisClient.ts` + `ultinaAnalysisWorker.ts` — VLYX Mix Assist host.                                                                                                                                                                                                                                                                            |
| `src/services/`                              | `rafLoop.ts` (one-bus rAF shared by meters and animations), `services.ts` (long-lived services wiring).                                                                                                                                                                                                                                                  |
| `src/ui/`                                    | ~70 React components — every panel/dialog/editor. `App.tsx` (56 KB), `ArrangementPanel.tsx` (shell, 6 383 lines), `ModPanel.tsx` (70 KB), `Sequencer.tsx` (67 KB), `PianoRoll.tsx` (65 KB). Large panels decompose into `src/ui/intent/` and `src/ui/arrangement/` collaborator modules — the panel stays the shell, collaborators stay inert renderers. |
| `src/embed/`, `src/gallery/`, `src/landing/` | Route-level apps: `/embed` beat player, `/gallery` community feed, `/landing` first-visit page.                                                                                                                                                                                                                                                          |
| `server/collab-server.mjs`                   | y-websocket relay + `/api/gallery` JSON store. One process, one port.                                                                                                                                                                                                                                                                                    |
| `desktop/main.cjs` + `desktop/preload.cjs`   | Thin Electron shell (ADR 0010/0011), MRT2 helper process/IPC; native Objective-C++ adapter and CMake build live under `native/mrt2-host/`.                                                                                                                                                                                                               |
| `tests/`                                     | Vitest specs (current count in `docs/CURRENT-STATE.md`), Playwright E2E, golden-vector locks for the vendored plugin cores, intent suite, persistence round-trip.                                                                                                                                                                                        |
| `docs/adr/`                                  | Architecture decision records 0001–0014. Read the relevant ADR before touching the area.                                                                                                                                                                                                                                                                 |
| `docs/CURRENT-STATE.md`                      | **Single source of truth** for "how many / what ships today". Update it in the same commit when you change a number.                                                                                                                                                                                                                                     |

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
8. **Full-DAW scope is authorized by ADR 0014.** Multitrack recording, native audio I/O and third-party plug-in hosting are in scope, but each requires its dedicated follow-up ADR, licensing review where applicable, measurable acceptance tests and an honest support matrix. Do not describe roadmap capabilities as shipped.
9. **No Rust/WASM DSP path is shipped today.** AudioWorklet is the realtime DSP boundary. ADR 0005 keeps WASM as a future option. If you need new DSP, write a worklet.
10. **No innerHTML, no dangerouslySetInnerHTML, no eval, no `new Function`** anywhere in `src/`. User-controlled strings (filenames, project names, sample names, share tokens) go through React JSX (auto-escaped) or are sanitized explicitly (see `sanitizeFilename` in `src/export/project-io.ts`).

---

## 4. Code style and quality gates

- **TypeScript is strict.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `isolatedModules`. Use the existing types in `src/project-model/types.ts`, `src/effects/types.ts`, `src/audio-engine/metering.ts`.
- **Prettier** is the only formatter. Config in `.prettierrc`: `printWidth: 120`, `singleQuote: false`, `trailingComma: "all"`. `npm run format:check` must report `All matched files use Prettier code style!`.
- **EOL policy (2026-10-06): LF everywhere, enforced by `.gitattributes`** (`* text=auto eol=lf`, binaries excluded). Fresh checkouts are LF on every platform — do not rely on `core.autocrlf`, never commit CRLF-only "fixes", and keep the `*.bat/*.cmd eol=crlf` carve-out for future Windows shell scripts. Before this policy, CRLF worktrees made format:check permanently red on Windows and broke vite's parse of shebang+CRLF files.
- **Defensive parsing.** Every JSON.parse of untrusted data is wrapped in try/catch with a fallback. Every Web Worker `onmessage` validates `event.data` shape before processing (see `src/audio-workers/onset-detector.ts` and `src/audio-workers/warp-render.ts` for the canonical pattern; `src/audio-workers/ir-generator.ts` and `src/analysis/ultinaAnalysisWorker.ts` follow the same contract).
- **Decompression-bomb and import caps** are mandatory. Existing ceilings: share tokens 2 M chars / 8 M decompressed chars (`src/export/shareCode.ts`), project JSON 10 MB (`src/export/project-io.ts`), audio samples 25 MB (`src/ui/DropZone.tsx`).
- **`?server=` overrides** must use `isAllowedServerUrl` in `src/collab/collabShared.ts` — never bypass it. Self-hosted relays on other hosts must be entered in the UI deliberately, not via URL params.
- **State-management discipline.** Mutations go through commands (with full undo/redo). Project model is a plain serializable object. React components are renderers, never owners, of audio state.
- **Bundle budgets.** `npm run build` enforces budgets (entry 1070 KB, **studio boot path 2200 KB**, DAW JS 5000 KB, optional lazy AI runtimes 650 KB, core worklets 150 KB, optional FX-extras worklet 64 KB). `scripts/check-bundle-size.mjs` reports the physical shipped JS total separately; any budget increase needs a measured justification there.
- **The studio boot path is the responsiveness number, not the DAW total.** The total counts every chunk, including panels and runtimes that load on demand, so it cannot reward lazy-seam work; the boot-path line sums the App chunk's _static_ closure, which is what a waiting user actually parses. Measured 2026-10-04→10: total +1197 KB while boot path went −106 KB. A rising total is not a user getting slower — check the boot line before treating growth as a problem.
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
6. Update `docs/CURRENT-STATE.md` (bump the 42 → new count).

### Adding a new vendored plugin suite (flagship DSP)

1. Open an ADR in `docs/adr/` that records why this plugin suite exists, what it does, and how it is vendored.
2. Mirror the upstream source into `src/effects/<name>-core/` and add a reconciliation script under `scripts/vendor-<name>.mjs`. Refuse to drop reconciliation markers the upstream snapshot lacks.
3. Add a worklet entry under `src/audio-worklets/` and a build script `scripts/build-<name>-worklet.mjs`.
4. Add a golden-vector test suite under `tests/<name>-vectors/` (input → expected output, bit-exact).
5. Wire the load order into `src/audio-worklets/loader.ts` (`LAZY_WORKLET_TYPES`).
6. Add a panel under `src/ui/<Name>Panel.tsx` and wire it into `src/ui/dockLayout.ts`.
7. Update `docs/CURRENT-STATE.md` (bump the 5 flagship count + add a row to the flagship table).

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

> Adding or touching an audio effect/instrument? Read
> `docs/NEW-EFFECT-CHECKLIST.md` first — it encodes the five known ways a
> parameter goes silently dead (audit 2026-09-27) and the QA obligations
> that catch them.

| Gate                       | Command                                                   | Expected result                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict typecheck           | `npm run typecheck`                                       | EXIT 0 (clean `tsc --noEmit`)                                                                                                                                                                                                            |
| Full Vitest suite          | `npm run test`                                            | See `docs/CURRENT-STATE.md` for the current file count; all tests pass, with intentional skips reported by Vitest                                                                                                                        |
| Suite expectations ratchet | `npm run test:expectations`                               | EXIT 0 — the failure set EXACTLY matches `suite-expectations.json` (new reds AND cured reds both fail; every entry needs owner + reason; `flaky: true` exempts both ways)                                                                |
| Derivable-artifact drift   | `npm run drift:check`                                     | EXIT 0 — regenerated MCP mirrors, domain goldens and the CURRENT-STATE counts match HEAD (stale artifact = drift, exit 1; intentional changes go through `npm run drift:bless` + review; dirty-before paths are skipped, never restored) |
| Format check               | `npm run format:check`                                    | `All matched files use Prettier code style!`                                                                                                                                                                                             |
| Real-browser audio         | `npm run test:browser`                                    | all checks pass in Chromium, Firefox and Edge (historical baseline 226/226)                                                                                                                                                              |
| Factory preset QA          | `npm run test:browser:factory-presets`                    | all factory presets audible (298 today; the script enumerates dynamically)                                                                                                                                                               |
| Targeted plugin hardening  | (per plugin, under `tests/`)                              | PASS for PRISM, VLYX, VØID                                                                                                                                                                                                               |
| 300 s plugin soaks         | (per plugin, under `tests/`)                              | heap growth ≤ 6 MB, drift ≤ 0.003 dB, zero non-finite samples                                                                                                                                                                            |
| Production build           | `npm run build`                                           | exit 0, bundle budgets respected                                                                                                                                                                                                         |
| Engine graph census        | `npx vitest run tests/engine-graph-census.test.ts`        | exit 0 — per-track/group/effect node budgets hold (100 dry tracks + 8 groups ≤ 1000 nodes; one analyser per strip; no PDC delay on dry chains; no group id in `trackNodes`) — see ADR 0048                                               |
| Engine graph reachability  | `npx vitest run tests/engine-graph-reachability.test.ts`  | exit 0 — every strip output reaches `ctx.destination`, every analyser outside `MasterChain.build` is fed by a sink-reaching node, and the only build-ahead nodes are the master's optional stages                                        |
| Golden doctor              | `npx vitest run tests/golden-doctor.test.ts`              | exit 0 — committed multi-voice summaries match live generation and every frozen artifact matches its hash; `npm run goldens:doctor` prints the semantic diff for a re-pin, `-- --bless` refreshes the summaries                          |
| Agent map                  | `npx vitest run tests/agent-map.test.ts`                  | exit 0 — every path, script and invariant guard in `docs/AGENT-MAP.md` still exists, every guard has assertions, no table is gutted, and this file points at the map                                                                     |
| Intent lexicon gate        | `npx vitest run tests/intent-routing-lexicon.test.ts`     | exit 0 — no phrase table shadows a token with a second target, cross-lane overlaps are exactly the documented dual effects, and the precedence corpus (grime, ukg, metal/grunge/thrash, breakbeat/big beat, bare swing) parses as pinned |
| Arrangement DOM census     | `npx vitest run tests/ui/arrangement-dom-census.test.tsx` | exit 0 — the rendered grid follows the viewport, not the project length; 520 clips ≤ 9000 elements                                                                                                                                       |
| Vulnerability audit        | `npm audit --omit=dev`                                    | 0 vulnerabilities                                                                                                                                                                                                                        |

Owner gates still open (release-blocking, not feature-blocking): manual Firefox/Safari/iOS Safari smoke, `release:deployed-smoke` with a real `KYX_DEPLOY_URL`. See `RELEASE_READINESS_REPORT.md`.

### 6.1 Seam coverage — "green" is not "it works"

> Full ledger + evidence: `docs/audits/2026-10-15-seam-coverage/SEAM-COVERAGE.md`.
> Machine-readable: `tests/seam-manifest.json`. Gate: `node scripts/check-seam-coverage.mjs`.

**A test can assert a behavior and still be green while the behavior is broken** — when the defect lives in a _seam_ the test never entered. Five corrections in three days (2026-10-13 → 15) were exactly this: the EQ curve at 16/16 green while a click with no drag wrote −1.09 dB; the reaction bridge at 19/19 green while its caller fed it nothing; the model grammar "pinned" while the shipped artifact no longer loaded.

So when you write a test for a **user-facing seam** — a gesture, a dispatch, a runtime artifact — it must:

1. **ENTER** the real entry point. A test of `hitEqBand` is not a test of `onPointerDown`; a test of a row-shaping function is not a test of what feeds it; a source-text `includes()` check is not a test of behavior.
2. **ASSERT THE NEGATIVE** — prove the no-op. "Writes nothing on click-without-drag", "refuses without the destructive flag", "a stale pointerup does not commit". A happy-path-only seam test cannot catch the bug class that actually ships. `tests/eq-curve-gesture.test.tsx` is the reference: 8 of 12 specs are negative assertions.
3. **Not confuse traversal with assertion.** A test that walks the path and asserts nothing _else_ proves the path exists, not that it works.

Two supporting rules that follow:

- **Naming a seam is part of shipping it.** Add new user-facing seams to `tests/seam-manifest.json` in the same commit as the feature. A seam nobody lists is a seam nobody checks. Statuses: `COVERED` (all three declarations present) · `COVERED_NO_NEGATIVE` (enters the seam, no-op case missing) · `OPEN` (no seam-entering spec).
- **Honest `OPEN` beats a false `COVERED`.** The gate fails only on a false claim; `OPEN` and `COVERED_NO_NEGATIVE` pass. A gate that demands new work gets disabled; a gate that catches lying stays.

The gate checks **declarations, not behavior** — it cannot tell a real no-op assertion from a decorative one. Only a mutation can. Before trusting a new seam test, break the production code deliberately and confirm the named spec goes red. `eq-curve-gesture.test.tsx` did exactly this: restoring the old code turned precisely 2 specs red, which is what makes "12/12 green" mean something there.

### Playwright E2E

```bash
npm run test:e2e:smoke      # 5 core scenarios: landing→studio, panel toggles, generate, persistence, shortcuts
npm run test:e2e            # full Playwright suite (tests/e2e/)
```

The dev server must be on port 5199 with `--strictPort` (the playwright.config.ts owns this). `reuseExistingServer` is on, so a manual `npm run dev` is reused.

---

## 7. Common gotchas (read before opening a PR)

- **Kill the test run you started.** This repo is the worst offender for orphaned Node runtimes: a `vitest run` nobody waits for keeps burning CPU after the session ends. Measured 2026-10-17 on this machine - 48 concurrent `pulse-forge` `node.exe` processes (38 of them tinypool workers) during a burst of parallel runs. Run `node-gc` to see what was abandoned and `node-gc -Kill` to terminate it. Do **not** write your own kill list here; `node-gc` is the single shared implementation and it is deliberately careful - it judges idleness **per process tree** (a finished tinypool shard is idle while its runner still works), it never matches `--watch`, and it ignores the agent runtime's own processes. A run you start must either finish or be killed in the same turn.
- **Multiple agent sessions share one working tree.** Commit early (untracked files get absorbed by concurrent commits without their dependencies), stage only files you authored, never `git stash pop` here, and run clean verifications in a `git worktree` at HEAD. Full protocol with incident history: `docs/MULTI-AGENT-GUARDRAILS.md`.
- **A concurrent commit absorbing your work is normal, not an incident.** Stage exactly your own paths, and if a parallel session's `git commit` sweeps them into a commit titled for its own area — that is the expected outcome of a shared index, not a problem. Do **not** amend, rebase, cherry-pick, or rewrite history to relabel it, and do **not** raise it in your final report, apologise for it, or ask whether to clean up provenance. The work is committed and the tree is clean; that is the whole requirement. Only mention it if you could not verify the content actually landed, or if the absorbed commit is about to be reverted. Commit messages describe an area, not a single author — the project has always worked this way.
- **`useContext(ctx)` is the only path that creates `AudioNode`s.** Creating nodes directly via `ctx.createGain()` etc. without going through `AudioEngine.useContext()` will leave them attached to the wrong context (silent in live, broken in offline). See `ARCHITECTURE.md` §Engine.
- **`?server=` overrides must pass `isAllowedServerUrl`.** Bypassing that helper is a security regression — a crafted link pointing at `wss://evil` would silently relay the victim's whole project through an attacker host.
- **`URL.createObjectURL` requires `URL.revokeObjectURL`** — but only after the browser has fired the click. The codebase uses a 5-second timeout as a safety net; do not shorten it without a reason.
- **Worklet modules are vendored.** A change to `src/effects/fxeq-core/` is incomplete until `npm run build:fxeq` has been run. `predev` and `prebuild` do this automatically.
- **AI models** must be loaded behind `timeouts + circuit breaker + heuristic fallback`. Direct `session.run(...)` on the UI thread is not allowed.
- **Number counts are documented in `docs/CURRENT-STATE.md` only.** When you add or remove an instrument, effect, template, ADR or test file, update that single file in the same commit.
- **AudioWorklet DSP boundary**: AudioWorklets receive raw AudioWorkletProcessor messages — never trust `event.data` shape. The canonical pattern is in `src/audio-workers/onset-detector.ts:96` and `src/audio-workers/warp-render.ts:30-49`. Apply the same defense-in-depth to any new worker you add.
- **`noUnusedLocals` is strict.** A line like `import type { ReactElement }` that's not referenced will fail `tsc --noEmit`. Run `npm run typecheck` before any non-trivial PR.
- **Vitest specs under `tests/e2e/`** are run by Playwright, not vitest — `vitest.config.ts` excludes that directory explicitly to avoid double-execution. New E2E scenarios go in `tests/e2e/` and `playwright.config.ts`.
- **MCP mirrors are GENERATED**: the tool/resource surface lives in
  `src/mcp/tools.ts`; `desktop/mcp-tool-defs.cjs` and
  `server/mcp-core.mjs` are mirrors (locked in place by
  `tests/mcp-mirror-sync.test.ts`). After changing the tool surface run
  `npm run gen:mcp-mirrors` and commit — never hand-edit a mirror.
- **Schema versioning**: any change to the on-disk project shape must bump `SCHEMA_VERSION` in `src/project-model/schema.ts` and add a migration in `migrateProject`. Loading code rejects unknown future versions.
- **Bundle budgets**: `npm run build` enforces entry 1070 KB, DAW JS 5000 KB, optional lazy AI runtimes 650 KB, core worklets 150 KB, optional FX-extras worklet 64 KB. `scripts/check-bundle-size.mjs` reports physical shipped JS separately. Any budget increase needs a measured justification and a script update.
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

# Derivable artifacts (MCP mirrors, domain goldens, CURRENT-STATE counts)
npm run drift:check                          # verify artifacts match their generators
npm run drift:bless                          # regenerate in place for an intentional change

# Frozen goldens (semantic diff before a re-pin)
npm run goldens:doctor                       # hash status + semantic diff for every frozen case
npm run goldens:doctor -- --bless            # refresh the voice summaries (review the printed diff)

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
npm run build:mrt2-native-host                 # macOS Apple Silicon only; MAGENTA_REALTIME_SOURCE must point at upstream v2.0.3
npm run desktop:build:mac:mrt2                 # macOS Apple Silicon MRT2-enabled DMG + ZIP
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

Before opening a PR or guessing at "how does X work", check the relevant ADR. ADRs are short, dated, and authoritative on the _why_ of architectural decisions.

| Topic                                       | Files                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime profiles and browser-first platform | `docs/adr/0014-full-daw-scope.md`, `docs/adr/0001-browser-first.md`, `docs/adr/0005-rust-wasm-dsp-policy.md` |
| Audio clock + scheduling                    | `docs/adr/0002-audio-clock-scheduling.md`, `src/scheduler/Scheduler.ts`                                      |
| Project model ↔ runtime                     | `docs/adr/0003-project-model-runtime-separation.md`, `src/project-model/schema.ts`                           |
| AudioWorklet boundary                       | `docs/adr/0004-audioworklet-boundary.md`, `src/audio-worklets/loader.ts`                                     |
| Effect rack, devices, native effects        | `docs/adr/0006-effect-rack-native-effects.md`, `docs/adr/0006-device-state-slot.md`                          |
| Instruments and notes                       | `docs/adr/0007-instruments-and-notes.md`, `src/instruments/registry.ts`                                      |
| VØID / reverb per-frequency decay           | `docs/adr/0007-ozvena-per-frequency-decay-network.md`                                                        |
| Composition systems (intent, dice)          | `docs/adr/0008-composition-systems.md`, `INTENT_ENGINE.md`                                                   |
| Offline render + export                     | `docs/adr/0009-offline-render-export.md`, `src/rendering/renderer.ts`                                        |
| Desktop packaging                           | `docs/adr/0010-desktop-packaging.md`, `desktop/main.cjs`                                                     |
| Desktop auto-update                         | `docs/adr/0011-desktop-auto-update.md`, `electron-builder.yml`                                               |
| Mobile / Android packaging                  | `docs/MOBILE.md`, `docs/adr/0051-mobile-runtime-profile.md`, `scripts/mobile/`                                |

If a decision feels arbitrary, look for an ADR. If none exists and you think there should be one, write it.

---

## 10. Communication conventions

- **Commit messages**: imperative mood, present tense ("Add", not "Added"); prefix the area in scope (`docs:`, `audio-engine:`, `effects:`, `tests:`, `chore:`, `fix:`, `feat:`).
- **PRs**: keep the diff focused. If your PR touches more than ~600 lines or spans three or more top-level packages, split it.
- **Don't refactor unrelated code in the same PR.** Run `npm run format` before committing to avoid noise.
- **Don't bundle a `package.json` dependency bump with a feature PR.** Bumps get their own PR with `npm audit` before/after evidence.
- **Don't claim a number in `docs/CURRENT-STATE.md` that isn't verifiable from a `grep` or `Get-ChildItem` against the working tree.** The whole point of that file is that every count can be reproduced.
