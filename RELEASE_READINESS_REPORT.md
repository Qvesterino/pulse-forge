# RELEASE READINESS REPORT — Pulse Forge / KYX

**Date:** 2026-09-13
**Author:** Sequential Scheduler Hardening Campaign (GOAL 12 — final gate)
**Scope:** independent final engineering review over the committed KYX roadmap
work plus subsequent VØID/VLYX hardening, the committed FXEQ crossover change,
and the remaining release gates.

---

## FINAL CLASSIFICATION

# RELEASE BLOCKED — OWNER GATES OPEN

The latest reviewed implementation candidate is `5b2bf5b`, with the functional
implementation/test baseline in `8f11255` and the generated PRISM worklet
artifact synchronized in `dfaf230`. The functional baseline lands the reviewed
FXEQ/PRISM six-band crossover surface on top of the prior
Ultina reconciliation at `173f5ce`. The current HEAD also contains the
test-only browser measurement follow-up `4279467`, built on
the PRISM feature
commits `a3dd6ba`, `8912a09`, `cb1bde7`, `a768595`, `2242541` and `64ca7e4`.
It contains the Ultina contract/worklet reconciliation, a block-boundary
regression test and a dirty-upstream guard for future vendor syncs. The
matching source/test changes are committed in `D:/VocalForge_DAW` as
`c0a549d`. The functional changes are clean in the current worktree; the
functional FXEQ crossover change and its generated worklet are committed and
reviewable in `8f11255` + `dfaf230`.
The ranker boundary hardening is in `f3514a5`; `f07a4e2` adds browser coverage
for missing/offline manifest, model hash mismatch and worker timeout fallback;
`20f63ae` bounds manifest loading with a timeout and abort cleanup. `dad84f3`
preserves scorepack cue duration when resampling, and `a9dd506` ensures only an
explicitly missing cue asset is skipped; abort, decode, offline-render and
memory failures now surface to the caller. `954739e` makes sparse instrument
preset application deterministic by resolving omitted parameters from canonical
instrument defaults before applying preset overrides; the targeted preset and
similarity batch is `16/16`.
`326d443` hardens the main-thread modulation fallback by combining CUTOFF/AMP
routes before applying the worklet-compatible cutoff bounds and AMP floor; the
browser suite now has an explicit negative-route guard. `70cd4e9` forwarded
scheduled continuous MOD A/B amount writes into the amount gains of already-
playing fallback voices; `d4d974b` extends the same live forwarding to source,
destination and LFO-rate selectors.
`91077da` adds deterministic preset discovery metadata (role, energy, BPM
suitability and provenance/license), accessible role/energy filters and safe
re-derivation for malformed legacy metadata; its targeted catalog/UI batch is
`17/17`.
`e8c1ac9` adds a release-facing factory audition gate and fixes content/runtime
defects found by it: all `199/199` factory presets render finite, audible and
unclipped through the same instrument factories as the user preview; slow
attack presets receive an adaptive audition window; Drum Synth clap routing
now connects its noise source; and all granular/vocal-chop factory presets
declare an explicit tonal sample source.
`5b2bf5b` hardens closed-`AudioContext` recovery and context-keyed worklet
refresh locks, makes recorder start/stop/cancel cleanup deterministic, and
moves long onset analysis behind a cancel-safe Worker fallback for transient
navigation and slicing. The candidate commits are clean and the current
worktree is clean.
`601eb6c` adds a cheap dormant amp/morph graph for zero-amount fallback routes
and lazily activates it when a later live `AMT` write reaches a held voice. The
new browser timing guard passed with `diff=0.1507`, `early=0.0000` and
`late=0.1507`.
The latest full-tree Vitest attempt on `5b2bf5b` completed with **236 passed
files, 2334 passed tests and 103 skipped**, with two failures: the browser
compatibility source-contract assertion (fixed afterward and covered by a
current `23/23` targeted batch) and the FXEQ p95 performance budget under
shared load. The same FXEQ performance file then passed in isolation at
`3/3` (`17.5×` p95 vs `25×` budget), so the full-suite failure is recorded as
contention-sensitive evidence, not waived. The historical authoritative
single-worker baseline remains `236/2320/103`; the post-fix targeted
PRISM/Ultina/FXEQ batch is **115/115**.
The latest quiet Chromium smoke before the lazy-activation change was **224/224**
on `91077da`:
every audio/DSP/FXEQ
check, including the corrected latency probe, passed; the `.preset-browser`
bootstrap and PRISM plugin workflow also passed end-to-end. The current full
browser verifier passes **226/226 in Chromium, Firefox and Edge**, including
factory audio, real worklet DSP, PDC, collaboration, embed/share, touch and
plugin workflow. The factory-only verifier is **199/199**. The production dist
smoke, scorepack targeted regression (`4/4`), and explicit production-config
preflight also pass. PRISM A/B persistence, live preview/history, source
selection/rewire, cancel-safe controls, runtime hydration, closed-context
recovery, recorder cleanup and cancel-safe onset analysis are implemented and
targeted/UI/browser-tested. Release remains blocked by the current full-suite
performance outlier plus the owner gates below:
manual browser/device checks, deployed smoke with a real `KYX_DEPLOY_URL`, and
the formatting decision.

The post-`cb1bde7` targeted hardening evidence is green: the relevant release
batch passed `48/48` tests, and the new PRISM 300-second worst-case soak passed
with 6.0 MB heap growth, −0.003 dB drift, zero non-finite samples and a zero
tail peak. The 300-second FXEQ/VLYX/VØID soak tests passed in the current full
attempt; only the compatibility assertion and the shared-load FXEQ p95 budget
failed in that run.

---

## 1. Gate results (this session, working tree)

| Gate                                           | Result                                                                       | Notes                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                            | **PASS**                                                                     | clean `tsc --noEmit`                                                                                                                                                                                                                                                                            |
| Full Vitest suite                              | **CURRENT ATTEMPT — 236 files passed / 2334 tests passed / 103 skipped; 2 failures** | `730.58s`; browser-compat source assertion was fixed afterward and the current targeted compatibility/lifecycle batch is `23/23`; FXEQ p95 budget failed under shared load (`91.6×` vs `25×`) while isolated `tests/fxeq-performance-gates.test.ts` passed `3/3` at `17.5×`; no threshold waiver |
| `npm run build` + bundle budgets               | **PASS — current candidate build after `5b2bf5b`**                                | entry 943 KB / 995 budget; total JS 1859 KB / 2400 budget; core worklets 98 KB / 120 budget; 359 modules; PWA precache 57 entries / 4048.41 KiB; lazy ranker WASM is 13.6 MB and is not precached; worktree clean |
| scorepack targeted regression                  | **PASS — 4/4**                                                               | Resampled cue duration is preserved; pre-aborted exports and missing optional assets remain safe; real cue render/decode/OOM failures are rethrown instead of being silently treated as missing assets |
| preset determinism/discovery targeted regression | **PASS — 17/17**                                                              | Sparse instrument presets resolve omitted values from instrument defaults; deterministic role/energy/provenance metadata and UI filtering are covered; apply/undo and sampler behavior remain covered |
| factory preset audio QA                          | **PASS — 199/199**                                                            | `npm run test:browser:factory-presets`; every factory audition is finite, audible and unclipped after the fixed 0.78 preview headroom; the gate exercises all factory instrument runtimes and factory sample routing |
| `npm run test:browser` (Chromium / Firefox / Edge) | **PASS — 226/226 per engine**                        | Full verifier passed in each engine, including factory audio, real worklet DSP, PDC, collaboration, embed/share, touch and plugin workflow; no threshold changes. |
| current lifecycle/async regression batch      | **PASS — 23/23**                                                               | Closed-context recreation/worklet refresh lock, recorder partial-start/stop/cancel cleanup, onset Worker fallback/copy/filter/abort and browser feature detection. |
| Post-`cb1bde7` hardening regression batch      | **PASS — 48/48 + 300 s PRISM soak**                                          | FXEQ/VØID/Ultina/registry hardening and meter-ring checks pass; soak: 6.0 MB heap growth, −0.003 dB drift, zero tail peak                                                                                                                                                                       |
| `npm run test:browser:production`              | **PASS**                                                                     | Post-`601eb6c` Vite dist preview boots, selects HOUSE, opens FX, adds an effect, fetches shipped worklets and executes a real ONNX Worker score request                                                                                                                                                        |
| `npm run release:preflight`                    | **PASS**                                                                     | explicit production-origin config, optional gallery token, KYX manifest, application chunk, all five shipped worklets and legacy-brand scan                                                                                                                                                     |
| `npm run release:server-smoke`                 | **PASS**                                                                     | spawns the real `node server/collab-server.mjs` entrypoint with production config: `/api/health` 200, allowed CORS header, forbidden origin 403 and admin 401/200; this does not replace a deployed-host health check                                                                           |
| `npm run release:deployed-smoke`               | **BLOCKED — `KYX_DEPLOY_URL` missing**                                       | local fresh-dist/deployed-like probe is documented separately; actual public URL must be configured and checked                                                                                                                                                                                 |
| VLYX hardening2 + upstream parity battery      | **PASS**                                                                     | host contract `8/8`, `ultina-core-hardening` `55/55`, worklet/parity/vectors `28/28`; upstream affected suite `105/105`; source/vendor equality checked after mechanical header transform; no performance threshold changed                                                                                                                        |
| `npm run ai:performance`                       | **PASS**                                                                     | latest worst p95 3.35 ms vs 250 ms budget                                                                                                                                                                                                                                                       |
| `npm audit --omit=dev`                         | **PASS**                                                                     | 0 vulnerabilities                                                                                                                                                                                                                                                                               |
| `npm run format:check`                         | **DECISION OPEN — DEVIATIONS DOCUMENTED**                                    | 209 files report repo-wide formatting deviations; exact command-generated inventory is [`docs/FORMAT-CHECK-DEVIATIONS.md`](docs/FORMAT-CHECK-DEVIATIONS.md). This pass did not perform a formatting-only rewrite; owner must explicitly accept the CI exception or schedule a separate cleanup. |
| Manual Firefox / Safari / iOS Safari smoke     | **OWNER GATE OPEN**                                                          | Windows Playwright WebKit has no Web Audio; real Firefox/Safari/iOS and physical audio-device lifecycle must follow the manual checklist                                                                                                                                                        |

_Full-run status:_ the current parallel full attempt completed in `730.58s`
with **236 files passed / 2334 tests passed / 103 skipped** and two failures.
One source-contract assertion was fixed afterward; the remaining FXEQ p95
budget failure is contention-sensitive because the same file passed isolated
at `3/3` with `17.5×` p95 vs the `25×` budget. The focused post-crossover PRISM
batch is `115/115`, and the current lifecycle/compatibility batch is `23/23`.
The older 234-file timeout, 224-file/five-failure, and 213/225 browser runs
remain historical timing evidence, not threshold waivers. No threshold was
changed.

### 1a. R6 cross-engine browser matrix evidence (2026-09-12 hardening session)

Current candidate follow-up (2026-09-13): the complete `scripts/verify-browser.mjs`
flow passed **226/226 in Chromium, Firefox and Microsoft Edge** on `5b2bf5b`,
including factory/instrument/effect audio, real worklet DSP, PDC, PRISM
workflow, exports, collaboration, embed/share, touch and plugin workflow.
This is automated cross-engine evidence; it does not close the manual macOS
Safari/iOS Safari or physical-device lifecycle gate.

The older 218/218, 216/218 and 219/219 numbers below are retained as campaign
history only. They must not be used as the current browser gate result.

Ran from the committed tree (`121b7c9` + `51da960`), same
`scripts/verify-browser.mjs` flow per engine via `KYX_BROWSER_ENGINE`:

- **Firefox (Playwright, headless): 216/218 checks passed.** The entire flow
  ran end-to-end — worklet DSP, PRISM/VLYX/VØID, templates, offline renders,
  collab edit/presence over the real server, Instant Jam, embed/share/touch.
  Both failures are measurement artifacts, not DSP defects:
  1. `fxeq CPU budget`: first timing sample measured 1413 µs (48 % of the
     2902 µs budget — healthy); the median was dragged over budget by
     machine-load spikes in samples 2–3 (3268/3332 µs) while parallel
     sessions were building. The check itself documents "idle machines
     measure 26–33 %, loaded more".
  2. `compressor sidechain HPF`: the RMS assertions PASSED (bass-on
     compression engaged, HPF restored the carrier), only the async GR
     meter read 0 — the worklet posts `{type:"gr"}` over the port and the
     check's 120 ms post-render window elapsed before Firefox's offline
     context delivered it. Compression behavior itself is proven by RMS.
- **WebKit (Playwright on Windows): NOT RUNNABLE — environment limitation.**
  Probed directly: this Playwright WebKit build exposes **no Web Audio at
  all** (`typeof AudioContext === "undefined"`, same for
  `OfflineAudioContext`/`webkitOfflineAudioContext`) — a known Playwright
  WebKit-on-Windows port limitation, unrelated to the app. The app's own
  capability gating handles missing Web Audio gracefully; the Safari leg of
  R6 therefore remains a **manual macOS Safari / iOS Safari device pass**.
- **Chromium dev-server verify:** the reviewed PRISM commit reached **219/219**;
  the PRISM plugin workflow and all non-performance product flows passed. The
  run included the real worklet DSP, PDC, meters, export, collab, Instant Jam,
  embed/share, touch and macro checks; no threshold was changed.
- **Deployed smoke (local probe, re-run): PASS** — served fresh `dist` via
  `vite preview`, all five shipped worklets + app shell + manifest + service
  worker verified over HTTP. The actual public URL check remains pending a
  real deployment target.

The host-worker pass adds a dedicated `ultinaAnalysisWorker` bundle
(`39.5 KB`, lazy-loaded), a 4/4 client contract suite, and a sample-rate-
derived 400 ms loudness block fix. The full-suite count above includes those
changes.

## 2. Defects fixed during this campaign (all verified)

1. **Post-test unhandled `TypeError` class** — 5 production sites scheduled `URL.revokeObjectURL(url)` on a 5 s timer; in jsdom the function is undefined after test restore, throwing an unhandled error attributed to whatever file is running → nondeterministic failure of unrelated test files. Fixed with optional-call guard (src/export/project-io.ts, src/midi/midiProject.ts, src/rendering/wav.ts, src/ui/ExportPanel.tsx ×2). No production behavior change.
2. **fxeq "random"-wave LFO unseeded (KYX P0 bullet)** — `Math.random()` in the vendored-fork DSP made the S&H wave nondeterministic. Replaced with per-instance xorshift32 and host-seeded streams (re-seeded on reset) following the lofi/ozvena precedents; worklet bundle rebuilt deterministically; hardening tests cover `"random"`, reset semantics, same-seed multi-instance render equality and intentional different-seed divergence; rack contract covers host seed forwarding; golden fixtures remain bit-exact. KNOWN_LIMITATIONS updated (direct/core callers without a seed retain the fixed compatibility fallback).
3. **`deleteSnapshot` unhandled rejection** — failed snapshot delete died silently with stale UI. Now caught, logged, and surfaced in the panel.
4. **DB failure masquerading as first-run** — ProjectBrowser swallowed storage errors into an empty list ("No projects yet"), inviting the user to believe their work is gone. Now shows an explicit storage-failure alert.
5. **Snapshot restore irrecoverable after reload** — restore was undoable only in-session. A best-effort "Auto — before restore" snapshot is now parked before the command executes.
6. **MIDI import unbounded** — no size cap; hostile .mid could OOM the tab pre-validation. Now capped at 10 MB (mirrors project import), tested.
7. **Meter duck-typing bypassed engine type contract** — a renamed engine method would silently degrade every mixer meter to the legacy path while mocks still pass. Now direct typed calls.
8. **`useLongPress` missing unmount cleanup** — touch press outliving its component could dispatch a command post-unmount. Timer now cleared on unmount.
9. **Copy-on-apply violations in two commands** — `applyInstrumentPreset` (params map) and `addSceneAutomation` (target object) inserted closure-/caller-owned objects by reference across doc revisions; latent undo-snapshot aliasing. Both now copy.
10. **Two full-suite flaky tests** — default 1 s `waitFor` timeouts under parallel CPU load (midi-io import, GalleryPage report). Raised to 10 s matching the repo's documented pattern.
11. **Silent persistence failures in secondary workflows** — frozen-audio save now rejects instead of marking a non-durable freeze complete; library actions surface IndexedDB failure while preserving the optimistic session state; snapshot list/rebuild isolates unreadable rows. Added failure-injection and partial-recovery coverage (28 passed / 1 skipped).
12. **True-stereo factory IR channel layout** — VØID factory IR generation now writes the declared interleaved LL/LR/RL/RR layout before host-side spectral partitioning; upstream phase-3 coverage verifies the matching cross-feed outputs.
13. **VØID cache-hit mutable-ring allocation** — factory IR spectra are cached immutably on the main thread and each delivery receives a fresh mutable block ring; re-selection and multi-delivery coverage verifies no worklet cache-hit allocation path remains.
14. **VØID pre-delay runtime growth** — the full supported delay span is reserved in `prepare()` and ring indexing no longer depends on power-of-two resize boundaries; live parameter and BPM changes are allocation-free, with upstream allocation-count coverage.
15. **Moderation/server launch guard** — gallery DELETE now has its own per-IP rate limit, limiter state has a bounded key count, and production-config enforcement rejects wildcard CORS at server construction; gallery-server regression coverage is 17/17.
16. **Scorepack cancellation contract** — SCOREPACK now shares the export abort signal and checks it between offline render/manifest/ZIP stages; cancellation regression coverage is included in `tests/scorepack.test.ts`.
17. **Legacy public project filename** — new project downloads now use the KYX-branded `.kyx.json` suffix; import continues to accept `.pulseforge.json` for backwards compatibility, covered by the project I/O suite.
18. **Firefox Pluck feedback instability** — Firefox's native biquad gain could make the Karplus–Strong recirculating loop run away after hundreds of cycles. The feedback scalar now stays in the delay loop while the tone filter remains on the audible tap; the installed-browser verification covered the fix.
19. **Firefox OfflineAudioContext source-view invalidation in QA** — the chop check now snapshots source samples before rendering instead of reading a channel view that Firefox may detach during `startRendering()`; the rendered slice is still measured independently.
20. **One-shot voice ceiling over-retirement** — the 64-voice guard now retires exactly the excess insertion-ordered voices instead of waiting for asynchronous `onended` callbacks to shrink the set; targeted regression coverage is in `tests/performance-hardening.test.ts`.
21. **Production core AudioWorklet data-URL failure** — Vite's production URL transform could inline `core-processor.js` as a `data:` URL even though it imports relative processor modules. Chromium rejected the relative imports, so stock effects degraded only in production. The build now emits self-contained hierarchical `bitcrusher-worklet.js` and `core-worklet.js` artifacts, with a production smoke regression.
22. **Native master limiter ceiling units** — `DynamicsCompressorNode.threshold` was being given a linear amplitude instead of dBFS. The fallback now clamps and assigns the dBFS ceiling directly; a source-grep regression test prevents the conversion from returning.
23. **ONNX ranker artifact/export path** — the first generated model was not parseable by ONNX Runtime; the replacement Python exporter now emits a checker-valid Gemm/Relu graph, the package training command points to the canonical exporter/validator, the worker uses the WASM-only runtime, and production smoke exercises the actual model load/inference path.
24. **FXEQ render-thread allocation/jitter** — the limiter/oversampler created
    short-lived subarray views during every oversampled block and the reverb
    rebuild path allocated feedback arrays during morph automation. Both
    vendored FXEQ paths now use explicit input lengths and reused buffers;
    reverb uses fixed-size coefficient storage and avoids redundant mod-rate
    rebuilds. The upstream mirror was updated for its matching source surface;
    targeted performance, parity/golden, build and production smoke pass.
25. **PWA app-shell overreach** — Workbox was precaching internal golden-review
    renders along with optional ranker assets, inflating the install payload to
    16.2 MiB. `golden-review/**`, the ranker model and ORT runtime are now
    explicitly ignored; the shipped app-shell precache is 57 entries / ~4.0
    MiB, while production smoke still verifies on-demand ranker inference.
26. **Periodic-tone false PDC measurement** — the browser latency check used a
    single 997 Hz oscillator, allowing correlation to select an arbitrary lag
    separated by whole tone periods after the IIR crossover phase changed. It
    now compares a deterministic low-level chirp through the same PRISM path
    with the limiter off/on; the reported `119` samples align exactly without
    weakening the acceptance budget.

## 3. Remaining risks and blockers

| #   | Severity            | Area                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                             | User impact                                                                                                                                                          | Recommended fix                                                                                                                                          | Blocks release                                                                                                 |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| R1  | Medium              | VLYX/ultina core DSP regressions are closed through upstream→re-vendor; remaining analysis caveats are the simplified K-weighting model and temporary channel-copy cost in the host worker                                                                                           | KNOWN_LIMITATIONS §Ultina; KYX §6.2; upstream + vendored tests and vectors pass; host worker client 4/4 pass                                                                                                                                                         | proposals may use an approximate loudness model; long analysis remains responsive                                                                                    | consider full BS.1770 weighting and worker reuse/streaming after release                                                                                 | No                                                                                                             |
| R2  | Medium              | Export residuals: marker cue one-shots absent from master WAV; scene-intensity/live seam up to one scheduler tick; scene-tempo ±25 ms boundary; offline stage render non-cancellable; video container timing may quantize sub-second files                                           | KNOWN_LIMITATIONS §Export; KYX §6.4; ExportPanel policy UI + targeted export tests                                                                                                                                                                                   | edge-case export artifacts or timing differences                                                                                                                     | full stage cancellation and/or true sub-second container verification after release                                                                      | No                                                                                                             |
| R3  | Closed              | VØID/ozvena factory IR cache-hit rings and pre-delay capacity growth are removed from the audio render path; immutable spectra are reused on the host and mutable rings are delivered per instance, while the complete pre-delay range is reserved in `prepare()`                    | `tests/fx-node-dispose.test.ts`, `tests/ozvena-worklet-entry.test.ts`, upstream pre-delay 9/9, typecheck/build                                                                                                                                                       | bounded startup memory cost remains (~37 MB stereo at 48 kHz; see KNOWN_LIMITATIONS)                                                                                 | include multiple-instance/high-rate memory in manual device QA                                                                                           | No                                                                                                             |
| R4  | Low                 | Collab/gallery server still needs production `CORS_ORIGIN`, a reachable bind host and an operational moderation review; room/connection/payload limits, bounded rate-limit state, production wildcard-CORS fail-fast, and report/delete flow are implemented and tested              | KYX §11; `server/collab-server.mjs`; gallery server/UI suites (17/17); real production entrypoint smoke                                                                                                                                                              | abuse/griefing or an unreachable relay if deployment is misconfigured                                                                                                | set explicit `CORS_ORIGIN`, bind `HOST` to the platform interface (typically `0.0.0.0`), review admin token handling and keep gallery moderation enabled | No (if deployment follows KYX §11 guidance)                                                                    |
| R5  | Closed              | Persistence secondary failure paths are now explicit and recoverable: unreadable snapshot rows are isolated; frozen-audio save and library writes report failure to their UI callers                                                                                                 | targeted persistence suite 28 passed / 1 skipped; current production browser smoke; typecheck/build pass                                                                                                                                                             | no silent "saved" state for these workflows; optimistic library state can be retried in-session                                                                      | retain manual quota/full-storage and refresh/tab-close production smoke                                                                                  | No                                                                                                             |
| R6  | Medium              | Manual browser matrix not run (Safari/iOS Safari plus physical device checks; automated browser smoke does not replace manual lifecycle QA — pagehide/unlock, MediaRecorder, Web MIDI, tab-hide resume)                                                                              | current Chromium/Firefox/Edge verifier is `226/226` per engine with all DSP/FXEQ and PRISM workflow checks passing; Safari/iOS still require the manual checklist; Playwright WebKit on this Windows host could not run the suite because `OfflineAudioContext` is unavailable; RELEASE_ROADMAP §1.1 unchecked | platform-specific lifecycle bugs                                                                                                                                     | run the manual QA checklist pre-launch                                                                                                                   | Conditionally — must be run before public launch per KYX §15, but is a release-process step, not a code defect |
| R7  | Closed in `8f11255` + `dfaf230` | Local Ultina vendor/worklet result remains committed in `173f5ce`, matching upstream source/test is committed in `D:/VocalForge_DAW` as `c0a549d`, and the FXEQ six-band crossover correction plus generated PRISM artifact are committed in `8f11255` + `dfaf230`; lifecycle/async hardening is in `5b2bf5b` | `git show --stat 8f11255`; `git show --stat dfaf230`; source/vendor equality check; upstream affected suite `105/105`; focused PRISM batch `115/115`; current browser `226/226` in Chromium/Firefox/Edge; current worktree clean | the candidate scope is immutable; remaining work is manual/deployed/formatting owner decisions and a clean full-suite performance capture | retain the split commit history and run owner release gates from `20f63ae` | **No — the original mixed-worktree blocker is resolved** |
| R8  | Low                 | Collab undo local-only; Yjs history unbounded; `applyToYDoc` fast path absent for newer commands (resetEffect/preset applies fall back to full-doc sync — correct, less efficient)                                                                                                   | KNOWN_LIMITATIONS §Collab; campaign GOAL 06                                                                                                                                                                                                                          | minor collab efficiency/history growth                                                                                                                               | KYX §8.2 contract work                                                                                                                                   | No                                                                                                             |
| R9  | Info                | Formatting deviations (209 files), root-level dev artifacts (`qa-*.mjs`, `__debug_loop.mjs`, `scratch/`, `topbar-diag.png`, `qa-report.json`), doc drift in MAINTENANCE_AUDIT_PROGRESS                                                                                               | format:check output; SYSTEM_AUDIT_MAP §13                                                                                                                                                                                                                            | none (dev-only)                                                                                                                                                      | cleanup pass post-release                                                                                                                                | No                                                                                                             |
| R10 | Info                | Deferred by owner decision: Vitest 5/Vite 8 migration, `bounceStemsToAudioClip` unwired, racks feature planned-not-started, stem separation parked                                                                                                                                   | RELEASE_ROADMAP; docs/                                                                                                                                                                                                                                               | none                                                                                                                                                                 | n/a                                                                                                                                                      | No                                                                                                             |
| R11 | Medium              | Intent ONNX ranker is technically loadable but remains shadow/fallback-only: trained on heuristic teacher signal, no hand-reviewed golden preference proof, normal sync create/apply path does not invoke it, and 13.6 MB WASM is lazy but not precached for offline-first inference | `docs/intent-engine-ai-ranker-goal.md`; `scripts/validate-intent-ranker.mjs`; `tests/ranker-client.test.ts` 5/5 + `tests/rank-candidates.test.ts` 7/7; `src/browser-checks.ts` fallback probe; production Worker smoke; validation report                                                                                                      | no release UX change while default remains shadow; activating `active` could change candidate choice without musical-quality evidence; offline cold start falls back | keep `active` disabled; finish golden/held-out evaluation, async preview integration, offline cache policy and device QA as P2.5                         | No — only if kept shadow/fallback-only                                                                         |
| R12 | Conditionally closed | FXEQ render-path allocations in oversampler/limiter and reverb morph coefficient rebuilds were removed; thresholds were unchanged                                                                                                                                                    | isolated `tests/fxeq-performance-gates.test.ts` is `3/3` post-fix (`17.5×` p95 vs `25×` budget); focused PRISM batch `115/115`; 8/8 golden cases within tolerance (7/8 bit-exact, one documented legacy split difference); current browser CPU/PDC checks; build + production smoke; one parallel full-suite run had a shared-load p95 outlier | no reproduced isolated allocation regression; full-suite timing is not yet release-green and must be captured again on the final release commit | retain the gate, rerun it from the release commit and escalate only if isolated runs reproduce the outlier | **Conditional — current full-suite performance gate remains open** |
| R13 | Closed              | Instant Jam transport awareness now validates untrusted payloads before applying BPM/tick anchors; remote play starts the scheduler after re-anchoring and pause/stop always halts it                                                                                                | `tests/collab-transport.test.ts` 10/10; collab subset 10 files / 79/79; post-change `npm run typecheck:clean` PASS                                                                                                                                                   | malformed pulses cannot poison playhead state and valid remote play/pause controls the actual scheduler lifecycle                                                    | retain malformed-payload and transition coverage                                                                                                         | No                                                                                                             |
| R14 | Closed              | FXEQ/VØID biquad primitives clear recursive state after a non-finite frame                                                                                                                                                                                                           | `tests/fxeq-ozvena-biquad-hardening.test.ts` 4/4; current source + generated worklets are in the reviewed history; upstream paths `D:/VocalForge_DAW/plugins/{fxeq,ozvena}`; typecheck/build pass                                                                               | without the guard, one bad frame can leave later clean blocks NaN/silent; valid finite/golden path is unchanged                                                      | retain the regression test and rerun it from the release commit                                                                                          | No                                                                                                             |
| R15 | Closed in `2242541` | PRISM host workflow integration is implemented: persisted A/B slots hydrate runtime morph state; PRISM sliders use preview + cancel rollback; source picker rewires sidechain; tempo-sync selects and LR transfer overlay are now user-facing; async history requests are queued                             | targeted host/worklet/processor `45/45`, UI/curve `13/13`, typecheck/build, current PRISM browser workflow `226/226` per Chromium/Firefox/Edge, factory audio `199/199`, production smoke                                                                                                         | no remaining known implementation gap in the reviewed PRISM workflow; release approval still depends on full-suite performance capture, manual/device, deployed-host and formatting owner gates        | retain targeted regressions and execute the remaining owner gates from `20f63ae`                                                                         | **No — see R6, DEP-01 and FMT-01**                                                                         |

## 4. Architecture & process observations

- The system is unusually well-audited: immutable-doc + command architecture is enforced consistently (zero violations found), undo integrity verified by deep-freeze + round-trip snapshots in dev, live==offline parity is a tested invariant, and every prior defect fix carries an inline regression note.
- Test-suite runtime (~8–15 min full run in jsdom) is the main process friction — it already produced two load-flakes of the same class this campaign; further default-timeout `waitFor`s may flake intermittently (pattern fix is one line each, applied where observed).
- `SYSTEM_AUDIT_MAP.md` (new) gives future sessions the subsystem inventory, critical paths, and high-risk table; `AGENT_WORK_LOG.md` (new) carries full campaign continuity.

## 5. Pre-launch checklist (owner actions)

1. Review/tag `5b2bf5b` as the current KYX implementation candidate; it includes the reviewed `e8c1ac9` factory-audition fixes plus closed-context recovery, context-keyed worklet refresh locking, deterministic recorder cleanup and cancel-safe onset analysis. Its functional/test baseline is `8f11255`, with matching upstream Ultina source/test committed as `c0a549d`. Keep `e701b05` as the immutable historical comparison baseline. The current worktree is clean.
2. The latest full Vitest attempt reached `236` passed files / `2334` passed tests / `103` skipped, with one compatibility source assertion fixed afterward and one FXEQ p95 budget outlier under shared load. The compatibility/lifecycle targeted batch is `23/23`; isolated FXEQ performance is `3/3` at `17.5×` p95 vs `25×` budget. Factory preview audio QA is `199/199`, browser verification is `226/226` in Chromium/Firefox/Edge, scorepack is `4/4`, and production smoke/build pass. Preserve thresholds and rerun the full suite from the final release commit until the performance result is captured green or escalated as a reproducible performance regression.
3. Run the manual Firefox/Safari/iOS matrix using `docs/KYX-MANUAL-RELEASE-CHECKLIST.md` (KYX §5 checklist).
4. Set `KYX_DEPLOY_URL` to the real public host and run deployed smoke; if the collab/gallery server is exposed publicly, configure `CORS_ORIGIN` and review moderation flow (R4).
5. Accept or schedule R1–R2 audio residuals per the KYX roadmap sequencing; R3 is closed in the audited tree.
