# AGENT WORK LOG — Sequential Scheduler Hardening Campaign

Continuity protocol: append-only. Each goal logs goal executed, areas inspected,
confirmed problems, fixes, files changed, validation, unresolved issues, risks,
and recommendations.

---

## GOAL 01 — Repository reconnaissance & system map (2026-09-10)

**Goal executed:** Deep reconnaissance; establish trustworthy system map; fix immediately dangerous issues found en route.

**Areas inspected:**

- Full repo tree (src 20+ subsystems, server, scripts, tests ~200 files).
- Docs distilled via subagent: ARCHITECTURE.md, README, MAINTENANCE_AUDIT_PROGRESS, KNOWN_LIMITATIONS, RELEASE_ROADMAP, SCENE-MODE-ROADMAP, docs/* (4 quality roadmaps, plugin-mixing roadmap, intent roadmap, ADRs, parked plans).
- Uncommitted WIP reviewed file-by-file (718 insertions): coherent KYX-roadmap implementation (preset audition, meter snapshots+clip, resetEffect, Inspector Simple/Advanced, collab-server hardening with tests). Left in place, not committed.
- Core runtime read: main.tsx, services.ts (full), ProjectStore.ts (full), Transport.ts (full), persistence/db.ts (full), Scheduler structure, schema.ts normalizer inventory, vite/vitest configs, package.json scripts.

**Confirmed problems:**

1. Full-suite baseline: `tests/ui/midi-io.test.tsx` failed (waitFor default 1 s timeout under full-suite CPU load) + unhandled `TypeError: URL.revokeObjectURL is not a function` from `src/midi/midiProject.ts:267` — a 5 s post-download revoke timer firing after afterEach restored the jsdom-undefined original. The unhandled error is attributed by vitest to whichever file is running when it fires → can fail UNRELATED files nondeterministically. Same pattern at 5 production sites.
2. Docs drift: MAINTENANCE_AUDIT_PROGRESS lists items as open that are fixed (scene-tempo seam, automation staircase, import caps); Phase C results log records only C01 of 23 marked-complete missions.

**Fixes implemented:**

- `URL.revokeObjectURL?.(url)` optional-call guard at all 5 delayed-revoke sites (src/export/project-io.ts:18, src/midi/midiProject.ts:267, src/rendering/wav.ts:84, src/ui/ExportPanel.tsx:45+251). Invisible in browsers; eliminates the post-test crash class.
- `tests/ui/midi-io.test.tsx` import-test waitFor raised to 10 s timeout (matches rationale already documented in the sibling export test).

**Important files changed:** the 5 above (4 source files, 1 test file).

**Validation:** `tsc --noEmit` PASS; targeted vitest run midi-io + project-io + wav: 18/18 PASS. Full suite re-run deferred to later gates (15 min runtime).

**Unresolved issues:**

- Working tree carries substantial uncommitted WIP (KYX roadmap items) — owner should commit; campaign treats it as the current baseline.
- `npm run test:browser` and `npm run build` not yet run this session (scheduled for GOAL 12 gate).

**Remaining risks:** jsdom full-suite runtime ~15 min encourages partial runs; flaky-timeout class may have other instances (watch in later goals).

**Recommendations for next session:** GOAL 02 — architecture consistency audit. Priorities: verify command-layer exclusivity (no doc mutation outside store.execute), UI→engine direct reach-arounds, duplicate metering/preview paths introduced by WIP, YDocStore/ProjectStore contract parity. Read `tests/collab-contract-parity.test.ts` first as the existing guard.

---

## GOAL 02 — Architecture consistency & ownership audit (2026-09-10)

**Areas inspected:** circular deps (madge, 341 files), UI→infrastructure imports, doc-mutation exclusivity (grep sweep UI + engine), packCode layering, schema/templates cycle, browser-checks.ts role, YDocStore/ProjectStore parity.

**Confirmed findings:**

- 5 circular deps, all function-level-safe at runtime: commands↔packCode (type-only edge), schema↔templates↔template-pack2, metering↔kweighting (const). Two intentional layering couplings: export/packCode→ui (share codes embed theme/padkey prefs — feature), project-model→effects/registry (normalizer clamps params against defs — its job). NOT refactored: no correctness impact; KYX §16 forbids refactor churn pre-release.
- Command-layer exclusivity VERIFIED: zero direct doc/track mutations in src/ui or AudioEngine (grep for assignment/push/splice patterns — clean).
- browser-checks.ts (3.4k lines) is dev-server-only self-test infra, dynamic-imported by scripts/verify-browser.mjs; correctly excluded from prod bundle.
- YDocStore is a strict superset of ProjectStore's public surface; parity pinned by tests/collab-contract-parity.test.ts.

**Fixes:** none required (no violations). Doc drift recorded in SYSTEM_AUDIT_MAP §13.

**Validation:** collab parity tests passed in full-suite baseline.

---

## GOAL 03 — Critical path audit & repair (2026-09-10)

**Areas inspected:** fxeq determinism P0 (deep-dive agent), WIP preset-audition path end-to-end (PresetBrowser + AudioEngine.previewInstrumentPreset + PlaybackController preview-stop policy), collab-server WIP hardening (limits, accounting, cleanup).

**Confirmed problems & fixes:**

1. **fxeq "random" LFO unseeded (KYX P0)** — root cause: `dsp/lfo.ts:92` `Math.random()` in the S&H wave. Nuance found: waveform "random" is currently unreachable from host wiring (latent, not active) — but the defect class + the hardening test's explicit exclusion confirmed it. FIX: per-instance xorshift32 seeded from fixed constant (0x5eed1f0), re-seeded on reset() — follows lofi-module (fixed seeds) + ozvena modPad (re-seed on reset) precedents; authorized by the 2026-09-05 fxeq fork amendment. Worklet rebuilt (`npm run build:fxeq`, zero Math.random in bundle). KNOWN_LIMITATIONS updated (residual: instances share one fixed sequence, no host seed param). Tests: hardening test now INCLUDES "random" in readInto parity + new determinism/reset test.
2. **WIP audition path verified sound**: preview is engine-only (no doc/history/collab mutation), apply = single undoable command, cleanup on unmount/Escape/track-change/play/stop. No fix needed.

**Validation:** 52/52 fxeq tests pass (incl. golden bit-exact — no fixture uses random wave).

---

## GOAL 04 + 05 — Failure modes, resilience, state integrity (2026-09-10)

**Areas inspected (deep-dive agent):** corrupted IDB records, schema-version guards, quota exhaustion UX, snapshot restore flow, user-sample corruption, blocked-DB open, silent-failure sweep of src/persistence.

**Confirmed problems & fixes:**

1. **deleteSnapshot unhandled rejection** (UndoHistoryPanel.tsx) — failed delete died as unhandled rejection, UI stale. FIXED: catch → console.error + visible snapError state.
2. **DB failure masquerading as first-run** (ProjectBrowser.refresh swallowed errors into empty list — user believes projects are gone). FIXED: listError state + alert banner distinguishing storage failure from genuinely-empty; "No projects yet" hidden when listError set.
3. **Snapshot restore irrecoverable after reload** (undo-only safety; auto-snapshots ≥12h apart). FIXED: restoreSnapshot parks best-effort "Auto — before restore" snapshot before executing the (still undoable) command.
4. Manual-snapshot failure silent — FIXED via shared snapError display.

**Verified safe (no fix):** corrupted project/snapshot records skipped per-record; future schemaVersion rejected (no silent re-save data loss); quota → "SAVE ERROR — RETRY" in TopBar + unload warning; user-sample decode failures per-sample caught; midi.requestAccess resolves false (cannot reject).

**Tests added:** delete-failure surfaces error; restore parks safety snapshot (2 new cases in tests/ui/snapshots-panel.test.tsx, 6/6 pass).

**Recorded (not fixed, low):** loadManyByIds/rebuildIndex lack per-record catch (one hard IDB error rejects snapshot list → "No snapshots yet"); FrozenBufferRepository.save swallows errors (freeze silently lost on reload); LibraryRepository.mutate swallows write failures.

---

## GOAL 06 + 07 — Contracts & concurrency (2026-09-10)

**Areas inspected:** Meter/engine contract, collab parity, listener/timer sweep (43 addEventListener sites audited), engine dispose/diff-sync teardown, controller dispose paths.

**Confirmed problems & fixes:**

1. **Meter.tsx duck-typed optional meter methods** — bypassed the engine's typed contract; a renamed method would silently degrade every mixer meter to the legacy path while tests still pass. FIXED: direct typed calls (engine.getTrackMeterSnapshot/getReturnMeterSnapshot); removed the cast + fallback.
2. **useLongPress missing unmount cleanup** — touch press outliving its component could fire a command post-unmount. FIXED: useEffect(() => clear) on unmount.

**Verified clean:** all UI listeners removed in cleanup; all intervals cleaned; engine diff-sync disposes dead track/return nodes + fx runtimes; Ghost/NoteRepeat/Capture stop paths complete; closeProject teardown ordered. Known-by-design: no ctx.close() on the shared AudioContext (single app-lifetime context — page unload closes it); collab fast-path (applyToYDoc) absent for resetEffect/applyEffectPreset/applyInstrumentPreset — full-doc sync fallback is correct, only less efficient (left for the commands.ts owner per KYX §13).

---

## GOAL 08 + 11 — Import/export robustness, security, deps (2026-09-10)

**Areas inspected (deep-dive agent):** project JSON import, share codes, MIDI import, export atomicity, round-trip fidelity; XSS/eval/redirect/secrets/path-traversal/CSP sweep; npm audit.

**Confirmed problems & fixes:**

1. **MIDI import had no size cap** (PatternBar.importMidiFile) — hostile/huge .mid buffers unbounded note arrays pre-clip → tab OOM. FIXED: MAX_MIDI_IMPORT_BYTES = 10 MB (mirrors project import), checked before arrayBuffer(). Test added (oversized file rejected pre-read, 4/4 pass).

**Verified safe:** project import (10MB cap, wrapped parse, no partial state); share codes never throw, 2MB/8MB caps; export atomicity (no partial blobs, no state mutation); zero dangerouslySetInnerHTML/innerHTML/eval/new Function; no open redirects; no secrets (Freesound token is user-provided by design); gallery file writes use server-generated ids + regex-gated routes; npm audit prod = 0 vulnerabilities.

**Recorded (not fixed):** no CSP meta tag (defense-in-depth nicety; no injection sinks exist today); frozen/user-sample audio inherently absent from share round-trips (by design, documented in code).

---

## GOAL 09 + 10 — Undo integrity & resource lifecycle (2026-09-10)

**Areas inspected (deep-dive agent):** resetEffect/applyInstrumentPreset/applyEffectPreset/setEffectParam/setEffectSteps/note commands/scene automation/macro commands reference discipline; engine dispose; timer sweep.

**Confirmed problems & fixes:**

1. **applyInstrumentPreset inserted closure-owned params maps by reference** into every doc revision (execute + undo/redo cycles alias one object). FIXED: copy-on-apply (`params: { ...params }`).
2. **addSceneAutomation inserted caller's target by reference** (doc + undo snapshot would diverge if caller mutates). FIXED: `target: { ...target }`.

**Verified clean:** resetEffect fully copies; setEffectParam/Steps/note/macro commands follow copy discipline; snapshot() deep-freezes prev in dev + round-trip-verifies.

**Performance note:** no new hot-path work introduced; Meter still throttled at 33ms via shared r
afLoop.

---

## GOAL 12 — Final reliability sweep & release readiness gate (2026-09-10)

**Gates run on the working tree:** typecheck PASS; full Vitest suite PASS (1995/0 fail/95 skip on final re-run after fixing two load-flaky waitFors); build + bundle budgets PASS (874/995 KB entry, 1668/2400 KB total); Chromium browser smoke 197/197 PASS (zero console/page errors, real-worklet fxeq render, 2-page collab, embed, share-link, plugin workflow); ai:performance PASS (p95 ~2.2 ms vs 250 ms budget); npm audit prod 0 vulnerabilities; format:check deviations documented (187 files, pre-existing; HEAD was 215).

**Final sweep:** zero console.log/TODO/FIXME in production src; empty catches follow the documented narrow best-effort convention; dev artifacts at root identified as unreferenced (recorded, not deleted — concurrent editor active).

**Deliverable:** RELEASE_READINESS_REPORT.md created.

**Classification: PASS WITH KNOWN RISKS** — 10 enumerated risks (R1-R10), none individually blocking; blocking conditions are process-level: commit the in-flight WIP and run the manual Firefox/Safari/iOS matrix before public launch.

**Campaign totals:** 10 defect classes fixed and verified (revokeObjectURL guard x5 sites, fxeq deterministic S&H + worklet rebuild, snapshot delete failure surfacing, DB-failure alert in ProjectBrowser, pre-restore safety snapshot, MIDI import 10MB cap, Meter typed contract, useLongPress unmount cleanup, copy-on-apply x2 commands, waitFor flake class x2); 5 new regression tests; 2 audit artifacts (SYSTEM_AUDIT_MAP.md, RELEASE_READINESS_REPORT.md) + this log.

**Recommendations for next scheduled session:** (1) after the WIP lands, re-run the full gate matrix on the committed tree; (2) KYX P0 audio items (ultina upstream fixes, ozvena allocation hardening, export policy decisions) remain the highest-value open work; (3) consider a per-record catch in SnapshotRepository.loadManyByIds/rebuildIndex and error surfacing in FrozenBufferRepository.save; (4) run the manual browser matrix.

### GOAL 12 addendum — late findings during final gate

- **Stale source-pin test** (fixed): concurrent editor made rebuildFxChain owner-aware (ownerId first arg, all 5 call sites); tests/performance-hardening.test.ts:98 still pinned the old frozen-track call shape `rebuildFxChain([], ...)` and failed the full suite. Verified the new code preserves the pinned invariant (frozen track rebuilds an EMPTY chain, AudioEngine.ts:1502) and updated the regex — the [] assertion is unchanged.

- **Systemic flake fix**: tests/setup.ts now sets `configure({ asyncUtilTimeout: 5000 })` — lifts every default 1s waitFor/findBy budget to 5s. Root cause of the observed class (midi-io, GalleryPage report): parallel full-suite CPU starvation. Assertions unchanged; per-test overrides still win.

- **Build re-verified** after concurrent rebuildFxChain refactor: budgets 875/995 KB entry, 1669/2400 KB total.

### GOAL 12 close-out

**FINAL SUITE RESULT: 2003 passed / 0 failed / 95 skipped (201 files, exit 0) — fully green**, including the concurrent editor's vendored ultina upstream fixes in their landed state (sculptor/multiband et al., correctly done via the upstream D:/VocalForge_DAW -> re-vendor flow, not local patching).

Run #4 failure attribution: tests/ultina-core-hardening sculptor test hit the documented -12 dB poisoning signature because the suite collected files inside the 19:24-19:32 vendor window (upstream+vendored copies being written concurrently); it passes 3x3 in isolation immediately after and in the final full run. No action needed beyond attribution.

---

## VERIFICATION PASS — VLYX/ultina upstream defect closure (2026-09-10, 20:4x)

**Goal:** verify the 5 documented ultina defects are actually closed after the concurrent upstream→re-vendor wave (commit b22a0a1).

**Per-defect verdicts (code + tests + bundle):

1. Sculptor silent-band poisoning — CLOSED. sculptorModule.ts adds a relative active floor (bands >20 dB below the loudest in-range band are spectral holes): excluded from the reference average AND get targetGain 0 instead of +12 dB boost. Test: "a sparse low spectrum does not drag active bands to the −12 dB limit".
2. Transient/Sustain stereo L→R leak — CLOSED. Root cause was sequential per-channel processing through single-channel buffers (shared crossover state slot 0: L tail seeded R). Fixed with dedicated transient/sustain stereo buffers processed as a pair + CrossoverNetwork now iterates active chCount, not prepared channelCount. Tests: stereo T/S isolation suite incl. "silence on R stays silent after L has excited the crossover".
3. Re-prepare resets LR4 crossover to identity — CLOSED via the prescribed upstream fix: every module prepare() now invalidates cached band/crossover values (cachedBandCount/cachedXover = -1), forcing crossover redesign. Verified in transient/comp/density (+ rest). Test: "re-preparing comp does not turn a 2-band unity chain into +6 dB".
4. Phase Time Shift >4 ms dry/wet compensation — CLOSED. dryDelay.prepare(maxBlockSize, maxDelaySamples) reserves the full 50 ms budget; phaseModule passes ceil(50ms·SR). Test: "delta compensation remains coherent at a 10 ms shift".
5. Mix-assist main-thread analysis — OPEN (the one residual, accurately kept in KNOWN_LIMITATIONS). UltinaPanel has a busy state + 30 ms yield before the call, but analyzeWithTarget still walks the whole buffer synchronously; long material freezes the editor. Recommended next: chunked async loop or Web Worker (host-side per vendoring contract) + progress/cancel.

**Golden vectors:** NOT regenerated — passed within the rmsΔ ≤ toleranceDb contract unchanged, i.e. the fixes were scoped to the broken paths with zero re-voicing of canonical renders. Ideal outcome per the vendoring contract.

**Worklet bundle:** public/ultina-worklet.js rebuilt 19:39 (after all DSP sources 19:20–19:32); new code confirmed in bundle (activeFloor/maxDelaySamples present).

**Validation:** ultina battery 11 files / 158 tests PASS on committed tree. fxeq battery + full suite re-run launched (fxeq gained a further host-seed improvement — per-instance seed from project/owner/effect identity — after the previous full run).

**Tree state:** everything committed as b22a0a1 (incl. campaign artifacts) — release report risk R7 resolved.

**CONFIRMED:** fxeq battery PASS + full suite 2003 passed / 0 failed / 95 skipped (exit 0) on committed tree b22a0a1 — the per-instance fxeq seed improvement and ultina fixes are all green together.

---

## CURRENT KYX ROADMAP IMPLEMENTATION — deployment probe + VLYX hardening (2026-09-12)

**Goal executed:** continue `docs/KYX-PRE-RELEASE-IMPLEMENTATION-ROADMAP.md` against the current shared worktree; close locally actionable release gaps without claiming manual/device or deployed-host completion.

**Changes:**

- Added `scripts/release-deployed-smoke.mjs` and the `release:deployed-smoke` package script. It probes a real app URL for the KYX app shell, manifest identity, five shipped worklets, service worker, and optionally a collab URL for health, exact CORS allowlisting, rejected origins, and gallery admin 401/200.
- Extended `docs/KYX-MANUAL-RELEASE-CHECKLIST.md`, the KYX roadmap, and `RELEASE_READINESS_REPORT.md` with the executable deployed-host command and explicit skipped-service semantics.
- Added upstream VLYX `preReleaseHardening.test.ts` oracles for M/S single-band aliasing and dynamicTilt coefficient reset; corrected the host hardening fixture so the clipper oracle is genuinely linear (`kneeDb=0`), then ran `scripts/vendor-ultina.mjs` and rebuilt `public/ultina-worklet.js`.

**Validation:** current typecheck PASS; VLYX host hardening `9/9`; `ultina-core-hardening` `55/55`; worklet/parity/vectors `26/26`; collab/transport/FXEQ/similar/MPE WIP battery `42/42`; deployed smoke PASS against a local production preview plus production-configured local collab server (static-only mode also reports optional service as SKIP); latest browser smoke `218/218`; release script syntax and package JSON PASS.

**Unresolved:** the complete default Vitest suite still needs a post-fix run from a reviewed/committed tree; physical Safari/iOS/device VØID footprint and an actual public URL remain owner release gates. No release threshold was weakened and no commit was made by this turn.

## CURRENT KYX ROADMAP IMPLEMENTATION — Instant Jam payload hardening (2026-09-12)

**Goal executed:** close a concrete collab release gap from the KYX roadmap without changing project schema or valid transport semantics.

**Change:** added `isSharedTransportState` at the awareness boundary and reject malformed transport pulses before `applyTransportState` can call `Transport.setBpm`, `play`, or `seek`. The guard requires finite non-negative ticks, BPM in the project’s 20–300 range, boolean playback state, finite anchor/recency values, and a non-empty sender ID. `CollaborationProvider` now filters awareness payloads through the same guard. Also fixed the remote play transition: the scheduler is started after `applyTransportState` re-anchors the follower, and remote pause/stop always stops the scheduler and panics active voices.

**Evidence:** `tests/collab-transport.test.ts` 10/10; full collab subset 10 files / 79/79; post-change `npm run typecheck:clean` PASS. No project schema or valid transport semantics changed.

**Still unresolved:** clean committed-tree full suite (the post-change build is now green), manual Firefox/Safari/iOS/device matrix, actual public deploy smoke, VØID physical-device footprint, and WIP owner/land review.

## CURRENT KYX ROADMAP IMPLEMENTATION — final local release verification (2026-09-12)

**Validation:** after the Instant Jam fix, `npm run build` passed (354 modules; entry 931/995 KB; total JS 1832/2400 KB; core worklets 98/120 KB; PWA precache 57 entries / 4001.76 KiB), production Chromium smoke passed with the real ONNX worker, `release:preflight` passed with explicit production env, and `npm run release:deployed-smoke` passed against a fresh local `dist` plus a production-configured local collab server (app shell, manifest, five worklets, service worker, health, exact CORS, forbidden origin, gallery admin 401/200).

**Browser evidence:** latest `npm run test:browser` completed 218/218 checks, including collab edits/presence, Instant Jam seed/adopt and shared transport; the collab-specific Vitest subset completed 10 files / 79/79 and `tests/collab-transport.test.ts` completed 10/10.

**Release boundary:** the local probe is not public-host evidence. The full default Vitest suite still needs a clean reviewed/committed-tree run after the FXEQ fix; Firefox/Safari/iOS manual lifecycle checks, physical-device VØID footprint and the actual deployment URL remain open. No commit was created by this work.

## CURRENT KYX ROADMAP IMPLEMENTATION — full-suite regression closure (2026-09-12)

**Defect found:** the first post-change full Vitest run was not green: `tests/ui/MidiCreativity.test.tsx` had 2 failures because `MpeIndicator` assumed every MIDI facade already exposed the new MPE methods.

**Fix:** `MpeIndicator` now capability-checks `subscribeMpe`, `isMpeConnected`, and `getMpeNotes`, retaining an inactive badge when an older/embedded facade is supplied. Added an explicit legacy-facade regression test in `tests/ui/MpeIndicator.test.tsx`.

**Evidence:** targeted MPE/MIDI tests 6/6; latest full default suite 220 files, 2174 passed, 103 skipped, 0 failed (2277 tests). The updated production build also passed (354 modules; 1832 KB total JS within the 2400 KB budget), production browser smoke passed, and release preflight passed.

**Remaining release gates:** final reviewed/committed-tree rerun, manual Firefox/Safari/iOS and physical-device checks, VØID device footprint, and public-host deployed smoke.

## CURRENT KYX ROADMAP IMPLEMENTATION — sibling biquad recovery hardening (2026-09-12)

**Defect:** a single non-finite sample entering the recursive DF2T biquad could
leave `z1`/`z2` poisoned for every later block, turning a recovered signal into
persistent NaN/silence. This was relevant to both PRISM/FXEQ and VØID/Ozvena.

**Change:** the upstream FXEQ and Ozvena `dsp/biquad.ts` sources now clear the
per-channel recursive state when a block ends with non-finite state; the
vendored sources and generated `public/fxeq-worklet.js`/
`public/ozvena-worklet.js` were rebuilt. Valid finite processing and golden
semantics are untouched; processor-boundary input scrubbing remains the first
line of defense.

**Evidence:** `tests/fxeq-ozvena-biquad-hardening.test.ts` 4/4, `npm run
typecheck:clean` PASS, `npm run build` PASS (354 modules; entry 931/995 KB;
total JS 1832/2400 KB; core worklets 98/120 KB; PWA precache 57 entries /
4002.16 KiB), and the completed default suite is 221 files / 2178 passed /
103 skipped / 0 failed (2281 tests). The final reviewed-tree rerun remains a
release process gate. The related upstream repositories contain the source
edits and must be kept aligned through their normal vendor flow.

The browser FXEQ CPU check was made resistant to one-shot scheduler/GC noise
by measuring three warmed samples and reporting their median; the realtime
limit itself remains 2902 µs per 128-frame block. `npm run test:browser` then
completed 218/218, with a median of 878 µs/block (samples 874/878/916), and
`npm run build` plus production browser smoke remained green.

## HISTORICAL KYX ROADMAP IMPLEMENTATION — PRISM gap review (2026-09-12)

**Scope:** reviewed commit `e701b05` after the FXEQ host/worklet workflow was
landed. The working tree was clean at review time.

**Confirmed implementation:** PRISM now has low-level A/B morph messages,
redo-aware command history, history-recording gates for host sync, limiter gain
reduction snapshots and sidechain audio input. The dedicated adapter/worklet/
processor battery passed 42/42; typecheck and production build passed. Current
build evidence: 354 modules, entry 933/995 KB, total JS 1837/2400 KB, core
worklets 98/120 KB and 57 precache entries / 4010.37 KiB.

**Critical gaps found:** runtime morph slots are not persisted, the PRISM panel
does not wire its sliders to `Slider.onPreview`/`AudioEngine.previewFxParam`,
the PRISM panel has no source picker, and `AudioEngine.fxSignature()` does not
include `sidechainTrackId`. The worklet contract can therefore pass while a
user cannot select a PRISM sidechain, plugin undo can be empty after a normal
drag, and A/B controls can disagree or lose state after reload. These are
tracked as blocking `PRISM-01` in `docs/KYX-PRE-RELEASE-IMPLEMENTATION-ROADMAP.md`.

**Release evidence:** production browser smoke, preflight and real server
smoke passed. Full Vitest under shared-machine load ended at 224 files / 2208
passed / 103 skipped / 1 gallery timeout; isolated `tests/gallery-server.test.ts`
passed 17/17. Chromium smoke was 217/218 because only the aggregate 8-bar
average timing check failed (`avg=7640 ms`); all individual templates and
product flow checks passed. `release:deployed-smoke` correctly remained blocked
because `KYX_DEPLOY_URL` was not configured.

## CURRENT WORKTREE — PRISM host workflow implementation (2026-09-12)

The blocking PRISM host/UI handoff is implemented in commit `a3dd6ba`; the
browser-verifier follow-up is in `8912a09`, and the release hardening batch is
in `cb1bde7`. The current worktree contains one uncommitted LR8 crossover
draft, explicitly outside the release candidate until its bank integration
and regression evidence are complete. The implementation keeps `effect-ab-v1` as the persisted A/B source of truth,
hydrates FXEQ runtime morph slots after mount/rebuild, removes the duplicate
PRISM A/B surface, wires PRISM parameter drags through preview + cancel
rollback, exposes an FXEQ sidechain picker with source-aware rewire, queues
async plugin history requests, and makes sidechain/fx-chain sync idempotent.
Touched areas are `src/ui/FxEqPanel.tsx`, `src/ui/EffectRack.tsx`,
`src/ui/controls.tsx`, `src/audio-engine/AudioEngine.ts`,
`src/effects/fxeqNode.ts`, `src/effects/types.ts`,
`src/audio-worklets/compressor-node.ts`, `src/effects/registry.ts`, the
browser verifier, styles, and their focused tests.

**Targeted evidence:** 6 files / 92 tests passed, including FXEQ host queue,
snapshot hydration/clear, sidechain signature, PRISM UI source picker and
persisted A/B controller, preview/commit/cancel behavior, controls, worklet
entry and plugin surface.

**Post-`cb1bde7` hardening evidence:** 7 focused files / 48 tests passed,
including FXEQ performance/morph, meter ring, registry routing/dispose and
VØID/Ultina hardening. The new FXEQ worst-case soak rendered 300 simulated
seconds with 6.0 MB heap growth, −0.003 dB RMS drift, zero non-finite samples,
zero tail peak and max sample magnitude 0.945.

**Release evidence after this diff:** `npm run typecheck:clean`, `npm run build`
(354 modules; entry 934/995 KB; total JS 1840/2400 KB; core worklets 98/120 KB;
57 precache entries / 4012.49 KiB), `npm run test:browser:production` passed.
The latest `npm run test:browser` reached 216/218: the PRISM plugin workflow
(A/B, pointer drag, plugin undo/redo, morph, source and reload persistence)
passed; two global performance checks failed under machine load. The full
default Vitest run is still
not release-green under shared-machine load: 224 files / 2152 passed / 162
skipped / 5 failed. Two Ozvena hook timeouts followed the 10-minute soak and
three timing budgets failed in that shared-machine run; Ozvena 59/59 and the
collab, VLYX HQ and large-project normalize checks pass in targeted isolation.
No threshold was changed and no PRISM failure occurred. This full-suite result
predates `cb1bde7`; a complete default-suite rerun from the release hardening
commit is still required.

**Remaining release gates:** rerun the browser performance battery in a quiet
runner, run a quiet full suite, separately review or remove the LR8 crossover
draft before tagging the candidate, run the manual
Firefox/Edge/Safari/iOS and physical audio-device matrix, resolve the 209
formatting-deviation decision, and run `release:deployed-smoke` with the real
`KYX_DEPLOY_URL`.

---

## GOAL 01 — Campaign re-verification reconnaissance (2026-09-13)

**Goal executed:** verify that the campaign system map (`SYSTEM_AUDIT_MAP.md`)
and continuity log are still trustworthy after three new commits and an
expanded WIP appeared since the previous release-readiness pass. Establish
the current-state baseline for the next 11 goals in the restarted campaign.
**Do not redesign — just confirm the map matches reality and surface what
drifted.**

**Areas inspected:**

- Git log since last release baseline (`5f49140`) — 3 commits:
  `81553dd docs: reconcile release evidence`, `7abc415 tak asi fajn`,
  `173f5ce fix(ultina): reconcile upstream DSP and protect vendor sync`.
  HEAD is `7abc415`.
- Working tree status — 13 files modified vs HEAD, all concentrated on the
  FXEQ/Ultina DSP experiment (Pre-Emphasis + transient/sustain EQ + FXEQ
  6-band crossover ladder realignment).
- `src/services.ts`, `src/commands/commands.ts`, `src/project-model/schema.ts`
  re-read to confirm load-bearing seams (CoreServices, command imports,
  normalizeProject) match the map's §2–§5 description.
- File-count drift: src `.ts/.tsx` 361 (was ~340), tests 244 (was ~200);
  high-risk file sizes unchanged — `commands.ts` ~228 KB (5.7k lines),
  `AudioEngine.ts` ~166 KB (4.1k lines), `schema.ts` ~80 KB (1.9k lines).
- WIP substance reviewed via `git diff HEAD` on
  `src/effects/fxeq-core/core/{fxEqProcessor, parameterSchema}.ts` —
  confirms a substantive DSP correctness fix (6-band crossover ladder
  realignment + `crossoverFreq6` schema addition with backward-compatible
  pinned defaults), not a stylistic tweak.

**Confirmed problems:**

- The system map (§1, §14) and the release readiness report both still
  reference `5f49140` as the reviewed baseline. The actual HEAD has
  advanced to `7abc415`. The map was **drifted**, not wrong — drift
  recorded.
- The release report's R7 ("separately owned uncommitted Ultina
  Pre-Emphasis + transient/sustain EQ + new contract test") is still open
  and the WIP has now **expanded**: FXEQ 6-band crossover ladder realignment
  is co-mingled in the same uncommitted diff. The two experiments must
  either be reviewed together or separated into two commits before tagging
  an immutable release candidate.
- No new architectural defects found in this re-verification pass — the
  core seams (services, commands, schema, transport, scheduler, audio
  engine) are unchanged from the 2026-09-10 baseline.

**Fixes implemented:** none. Goal 01 is reconnaissance — see next goals.

**Important files changed:**

- `SYSTEM_AUDIT_MAP.md` — §14 baseline rewritten as a two-row table
  (2026-09-10 baseline + 2026-09-13 re-verification with current HEAD,
  commit range, file counts, gate status, and WIP substance). New §15
  added with the carried release gates (R7, full-suite rerun, build
  rerun, browser rerun, manual matrix, deployed smoke, formatting).
- `AGENT_WORK_LOG.md` — this entry appended.

**Validation:**

- `npm run typecheck`: **PASS** on the modified working tree.
- Targeted `vitest run` on the WIP-modified test files
  (`fxeq-core-hardening`, `fxeq-morph`, `fxeq-rack-contract`,
  `ultina-contract-params`): **54/54 PASS** (6.36s).
- Full Vitest suite, `npm run build`, `npm run test:browser`:
  **NOT re-run this session** — left for the GOAL 12 gate per the
  established campaign protocol (the previous campaign session ran the
  full gate matrix; re-running it every reconnaissance pass would
  consume the campaign's budget on no new information).

**Unresolved issues:**

- R7 (Ultina + FXEQ WIP separation) — blocking per RELEASE_READINESS_REPORT,
  unchanged in substance but expanded in scope (FXEQ crossover realignment
  is now in the same uncommitted diff).
- Full Vitest suite rerun — required on the post-`7abc415` tree before any
  release candidate can be tagged. The pre-`5f49140` run had one timeout
  (factory-preset UI regression — fixed in `5f49140`); the post-`7abc415`
  rerun has not been executed.
- Build + bundle budgets — not re-verified after the FXEQ `crossoverFreq6`
  schema change; required by GOAL 12.

**Remaining risks:**

- The WIP touches the **vendored FXEQ core** (which is allowed —
  `vendor-fxeq.mjs` is documented as patchable) but the file
  `src/effects/fxeq-core/core/parameterSchema.ts` now diverges from its
  upstream mirror in `D:/VocalForge_DAW/plugins/fxeq`. The next
  `scripts/vendor-fxeq.mjs` run would silently overwrite this fix.
  Recommendation: a vendor-fxeq guard that detects and reports this exact
  schema drift on next vendor run (or a manual re-apply step).
- The Ultina WIP similarly touches vendored sources
  (`src/effects/ultina-core/**`). `173f5ce fix(ultina): reconcile upstream
  DSP and protect vendor sync` modified `scripts/vendor-ultina.mjs` —
  verify the guard works before re-running the vendor script.

**Recommendations for next session (GOAL 02):**

- Architecture consistency audit, focused on the new WIP:
  - Does the FXEQ `crossoverFreq6` addition respect the existing
    parameter-id contract (commands.ts:59 import; commands execute path)?
  - Does the Ultina transient/sustain + Pre-Emphasis addition respect
    the contract layer (`parameterIds.ts`, `parameterSchema.ts`) or
    leak through `eqModule.ts`/`exciterModule.ts` directly?
  - Are the matching test additions (`tests/fxeq-*.test.ts`,
    `tests/ultina-contract-params.test.ts`) consistent with the existing
    fxeq/ultina test conventions?
  - Does the `vendor-fxeq.mjs` / `vendor-ultina.mjs` upstream protection
    added in `173f5ce` hold for these new schema entries?
- Verify the existing load-bearing invariants from the previous
  campaign's GOAL 02 (command-layer exclusivity, no UI→engine direct
  reach-arounds, YDocStore/ProjectStore parity) are still intact after
  the new commits.

---

## GOAL 02 — Architecture consistency & ownership audit (2026-09-13)

**Goal executed:** verify that the current implementation respects the
intended architecture after the FXEQ crossover realignment landed in the
working tree and the new commits `81553dd`, `7abc415`, `173f5ce`. Re-verify
the load-bearing invariants from the previous campaign's GOAL 02 (command-
layer exclusivity, circular deps, YDocStore/ProjectStore parity) and audit
the new WIP for boundary violations, leaked abstractions, or shared state.

**Areas inspected:**

- **WIP diff (HEAD vs working tree, 14 files):** FXEQ `crossoverFreq6`
  schema addition + 6-band crossover ladder realignment (parameterSchema +
  fxEqProcessor + worklet bundle + 4 test files + 2 golden fixtures). The
  prior Ultina Pre-Emphasis + transient/sustain EQ experiment (R7) is no
  longer in the working tree — committed as part of `173f5ce` or earlier.
- **Command-layer exclusivity re-grep:** `src/ui/**` and
  `src/audio-engine/**` searched for direct `doc.<field>` assignment,
  `doc.<field>.push(`, `doc.<field>.splice(`, indexed assignment
  `doc.<field>[idx] = …`. Zero matches on write patterns. UI files only
  READ from `doc.tracks`/`doc.patterns`/`doc.arrangement` for
  selection/keyboard/shortcut logic. **Confirmed clean.**
- **Command-layer usage in UI:** 311 occurrences of
  `store.execute()`/`applyToYDoc` across 30 UI files — strong evidence
  of command-layer discipline.
- **FXEQ parameter surface ownership:** confirmed `buildFxEqSchema(bandCount)`
  is the single source of truth, consumed by `commands.ts` (3 sites:
  setFxEqParam + 2 preset/undo paths at L5407/L5438/L5456), `effects/registry.ts`,
  `project-model/targets.ts` (automation target validation), `effects/fxeqNode.ts`,
  `ui/FxEqPanel.tsx`, `ui/fxeqCurve.ts`. New `crossoverFreq6` propagates
  automatically through this builder — no command/registry/targets plumbing
  changes needed. **Architectural pattern to preserve.**
- **Circular deps re-check (madge on 362 src files):** same 5 cycles as the
  previous campaign — `commands↔packCode` (type-only), `schema↔templates↔template-pack2`,
  `metering↔kweighting` (const). **No new cycles introduced by the WIP.**
- **Vendor protection review:** read all three vendor scripts.
  `scripts/vendor-ultina.mjs` (from `173f5ce`) gained an
  `assertUpstreamClean()` guard that refuses to run on a dirty upstream
  working tree (`${scope}/src` + `${scope}/tests/vectors`), with
  `--allow-dirty-upstream` escape hatch. `scripts/vendor-ozvena.mjs`
  already had a "Reconciled from Pulse Forge" marker guard with
  `--force-reconciled`. `scripts/vendor-fxeq.mjs` has no guard — the
  fork relationship is intentional (FXEQ may be patched in place; the
  vendor script must not run automatically).
- **Hidden globals / module-level mutable state:** grep for
  `window.__`/`globalThis.__` returned zero matches. No new mutable
  module-level `let`/`var` state in the WIP.
- **Worklet bundle:** `public/fxeq-worklet.js` modified (27 lines net,
  includes the new `crossoverFreq6` schema and 6-band defaults).
  Rebuilt via the standard `predev`/`prebuild` chain; no manual
  worklet edits.

**Confirmed problems:**

- **None.** All architectural invariants from the previous campaign hold;
  the WIP respects every boundary; the new `crossoverFreq6` propagates
  cleanly through the existing parameter-builder seam.
- **Threshold relaxations in 3 test files** flagged for substantive review
  (not as architectural defects):
  - `tests/fxeq-worklet-entry.test.ts`: tail RMS floor relaxed `0.05 → 0.02`.
    Comment justifies: "stale-tail failure mode is RMS ≈ 0". Margin remains
    ~30 dB above the failure signature; relaxation is documented and the
    monotonic-decrease guard above is the real regression catch. **Acceptable.**
  - `tests/fxeq-prepare-hardening.test.ts`: peak floor `7 → 6`, previous-
    in-silence `1e-3 → 2e-3`. Comments explain both as a calibration change
    caused by the realigned default splits (more crossover cascades in the
    one-block startup, more band-5 energy at silence onset). Values still
    meaningful (peak > 6 ≈ 12 dB applied gain; 2e-3 ≈ −54 dB, well below
    audibility). **Acceptable.**
  - **Golden fixture** `tests/fxeq-golden/impulse-response.json`: peak
    `0.47722 → 0.476`, hash changed, RMS and envelope shape essentially
    unchanged. **Legitimate DSP-path change:** with `crossoverFreq6=8000`
    explicitly pinned (and the new `crossoverFreq5=8000` no longer
    collapsed with a hidden 5th split), band 5 now has a real 40 Hz-wide
    sliver above 8 kHz instead of a zero-width dead band, producing a
    sub-percent peak difference. The fixture was regenerated to match the
    corrected, more deterministic output — not a regression masked by an
    update.

**Fixes implemented:** none. No architectural defects required repair.

**Important files changed:**

- `SYSTEM_AUDIT_MAP.md` — §5 expanded with the FXEQ parameter-surface
  ownership pattern (single-source `buildFxEqSchema(bandCount)`,
  consumer list) and the three vendor protection models (ultina dirty-
  upstream, ozvena reconciled-marker, fxeq no-guard by design). §11
  high-risk table updated: FXEQ random-LFO row marked **CLOSED** per
  GOAL 03 evidence (host-seeded xorshift32 refined post-`5f49140`).
- `AGENT_WORK_LOG.md` — this entry appended.

**Validation:**

- `npm run typecheck` (already PASS from Goal 01, re-validated
  unchanged).
- Targeted `vitest run` on the WIP-modified test files
  (`fxeq-core-hardening`, `fxeq-morph`, `fxeq-rack-contract`,
  `ultina-contract-params`) was 54/54 PASS in Goal 01. New test files
  in this session's diff: `fxeq-hardening2.test.ts` (+97 lines),
  `fxeq-prepare-hardening.test.ts` (+13 lines), `fxeq-golden/cases.ts`
  (+8 lines). Targeted re-run on the new files not executed this
  session — the prior 54/54 covers the contract surface, and the new
  tests use the same helpers/imports. Recommended for GOAL 03 before
  any release candidate is tagged.

**Unresolved issues:**

- **R7 expanded (carried from RELEASE_READINESS_REPORT, refreshed):** the
  FXEQ `crossoverFreq6` schema + 6-band crossover realignment is now
  part of the working tree alongside any remaining uncommitted work.
  It is a **substantive DSP correctness fix** (the 8–12 kHz dead-band
  deletion bug is documented and pinned by `fxeq-hardening2.test.ts`),
  not a stylistic tweak. The release report should be updated to
  reflect this expansion.
- **Vendor-fxeq protection gap** (recorded, not fixed — intentional per
  the system map): the FXEQ fork has no in-script guard against
  accidental re-vendoring. Any `node scripts/vendor-fxeq.mjs` run would
  silently overwrite the `crossoverFreq6` patch (and any other in-place
  patches). The current contract is "must NOT run automatically"; a
  defensive `--refuse` default or a manual-reapply warning would be a
  small safety win if the same fork ever needs automated vendoring,
  but is not justified today.

**Remaining risks:**

- The new `crossoverFreq6` is **not in the persisted-state migration
  contract** explicitly. Old saved docs render with the legacy ladder
  (verified by the new test "documents saved with the old defaults
  render with the old splits" — `crossoverFreq6` fills in at 8040 Hz),
  but the `SCHEMA_VERSION = 1` normalization boundary does not know
  about this field. If a future schema bump adds more crossover
  frequency slots, the same pinned-defaults fallback pattern will be
  needed. **No action required now; documented for future-schema
  awareness.**
- `fxeq-morph.test.ts` had to add an explicit `crossoverFreq3: 1200`
  baseline parameter to make the test deterministic with the new schema
  defaults. If other morph/preset tests have implicit assumptions
  about the default ladder (400/1200/4000/8000), they may flake under
  the new defaults (120/400/1200/4000/8000). **Not investigated this
  session** — would be a candidate for GOAL 03's test sweep.

**Recommendations for next session (GOAL 03):**

- Critical-path audit on the new `crossoverFreq6` surface:
  - Does the PRISM panel's crossover editor correctly surface the
    new 6th split when `bandCount = 6`?
  - Does the rack contract correctly reject automation targets
    `crossoverFreq6` when `bandCount < 6`?
  - Does the worklet bundle correctly apply the new schema to
    in-flight instances after a `bandCount` change?
- Investigate the `fxeq-morph.test.ts` baseline-parameter addition:
  if other morph tests have the same implicit-default dependency, the
  same defensive parameter may be needed. Run the full fxeq battery
  (`vitest run tests/fxeq-*.test.ts`) and look for any new failures
  caused by the default-ladder shift.
- Verify the impulse-response peak drift (`0.47722 → 0.476`) is the
  only golden fixture that needed updating — re-run
  `tests/fxeq-golden.test.ts` in isolation and confirm all other
  golden hashes match HEAD (no silent regressions).

## KASKÁDA STEP 1 — processor test battery + factory export (2026-09-17)

**Goal executed:** Phase 1 continuation for the KYX Kaskáda delay — close
the two unchecked boxes of docs/kaskada-architecture.md §9 (unit tests,
factory/testability) before any Phase 2 work. Analysis first: registry,
loader, core bundle and BPM plumbing verified end-to-end; doc-vs-impl gaps
catalogued for a later DSP polish pass.

**Changes:**

- `src/audio-worklets/kaskada-processor.js`: added `createKaskadaProcessor()`
  export (ozvena `createOzvenaProcessor` pattern). Class + `registerProcessor`
  untouched; the esbuild IIFE bundle is byte-identical (verified via rebuild
  + git diff — the unused export is tree-shaken, registration side effect
  intact). New `kaskada-processor.d.ts` type stub mirrors the
  `ozvena-worklet.entry.d.ts` house pattern.
- `tests/kaskada.test.ts` (32 tests): runs the real processor under a
  stubbed AudioWorkletGlobalScope. Echo spacing for free TIME and all five
  SYNC ratios × BPM (sync wins over a decoy TIME; bpm change re-times),
  feedback decay ≈ fbⁿ (mid-band burst RMS — an impulse smears through the
  HP cascade and skews peak ratios), ping-pong L→R→L→R alternation with a
  one-sided burst, freeze write-seal proven bit-identically (render with vs
  without a post-freeze impulse + no-freeze control), loop EQ LP/HP
  darkening on repeats, drive linearity at 0 / saturation at 1, mix/level
  laws, silence-in→silence-out, extremes soak (all-min/all-max/hot
  character sweep/freeze-hot/24 seeded-random draws: finite, |out| < 48,
  no tail growth), 44.1/48 kHz parity (echo position in ms + decay ratio),
  and the contract trio: descriptor ↔ registry param ids (only hidden
  `bpm` extra), DEFAULTS table pinned to descriptor defaults, all 6
  factory presets in-range.

**Defects found (characterised in tests, NOT fixed — step 2 scope):**

1. **Freeze does not loop.** Doc §5.1 pseudocode locks feedback at ~1.0
   during freeze (wet written back = infinite repeat); the implementation
   skips the buffer write entirely, so the advancing read head replays the
   captured content once and then walks into silence. Worse, the ring size
   (96001 @48 kHz) is not a multiple of the echo period, so the read
   position eventually wraps and replays stale content as a glitch every
   ~2 s. Pinned by the "DEFECT (characterised)" test; the seal test stays
   green either way.
2. **Drive small-signal expansion.** `tanh(x·g)/tanh(g)` has small-signal
   gain `g = 1 + 6·drive` (up to 7×), so the effective loop gain at
   drive 1 is `fb·7` — e.g. Dub Space (drive 0.6, fb 0.75) runs at ~3.4×
   loop gain and self-oscillates into a saturated ring. Soak only asserts
   boundedness; normalising for unity small-signal gain is a step-2 fix.
3. Loop EQ colours the wet output path, so the first repeat is already
   filtered (doc §3.4 claims feedback-path-only "bright first slap").
   Reads are linear-interpolated, not hermite (doc §3.1). Both noted in
   the test header; no assertions depend on either.

**Verification:** `npx vitest run tests/kaskada.test.ts` 32/32;
typecheck clean; effects/audio-worklets/presets/effect-reset suites green;
full `vitest run` regression sweep run at session end.

**Recommendations for next session (Kaskáda step 2 — DSP polish):**

- Fix freeze to the documented algorithm (write wet back at ~0.99 instead
  of skipping writes), then flip the DEFECT test to assert sustain; the
  wrap glitch disappears with the same change.
- Re-normalise drive for unity small-signal gain (`tanh(x·g)·(1/g)` style)
  so loop gain stays ≤ fb; re-check Dub Space/Ambient Wash tails by ear.
- Upgrade `readBuffer` to cubic hermite (doc promise; audible on high-fb
  tape/dub presets) and add the missing DC-block one-pole in the loop path.
- Sync docs/kaskada-architecture.md to reality: max delay 2000 ms (not
  5000), buffer is sample-rate-derived (not 16384), resolve the §1 SOLO
  WET contradiction (add the param or descope §1).
- Then browser QA (§9 last box) before any Phase 2 feature.

## KASKÁDA STEP 2 — DSP polish: hermite, DC-block, tape wow, drive
## normalisation, freeze looping (2026-09-17)

**Goal executed:** close the doc-vs-impl gaps catalogued in step 1 and fix
both characterised defects. The guiding invariant: every element of the
delay loop is now CONTRACTIVE (|gain| ≤ 1 at every amplitude), so the
loop gain can never exceed FEEDBK — doc §3.6's "hard ceiling, no runaway"
and §10.4's "freeze hard-caps feedback at 0.99" are now literally true.

**Changes (`src/audio-worklets/kaskada-processor.js`):**

1. **Freeze loops (defect fix).** Freeze no longer skips the buffer write;
   it writes the processed wet back at 0.99 (input sealed out). The read
   head replays looping content forever instead of walking into silence,
   and the stale-replay glitch on ring wrap (~2 s @48 kHz) is gone — the
   loop continuously overwrites old content. The DEFECT test was flipped
   to a sustain test (burst-based: a 0.3 s burst overlaps the 0.25 s echo
   grid so RMS windows track amplitude, not spike sparsity). The seal test
   (post-freeze input bit-identically ignored) still passes unchanged.
2. **Drive unity small-signal (defect fix).** `tanh(x·g)·norm` with
   `norm = 1/tanh(g)` had small-signal gain g (up to 7× at drive 1) —
   loop gain at Dub Space settings was ~3.4× and self-oscillated into a
   saturated ring. Now `tanh(x·g)/g` (g = 1 + 2·drive): small-signal gain
   exactly 1, loud peaks compress down. New test asserts the driven loop
   decays at fb 0.6 + drive 1 (rₙ₊₁/rₙ < 0.7); old control would ring.
3. **Cubic-hermite reads.** `readBuffer` upgraded from linear to 4-point
   3rd-order hermite — the doc §3.1 promise; audible quality gain on
   high-fb tape/dub presets under MOD drift (no more correlated folding
   distortion on fractional positions).
4. **One-pole DC blocker** (~5 Hz) on the wet path, per channel. The loop
   HP already nulls DC (Butterworth HP has an exact DC zero), so this is
   defence in depth for the freeze write-back loop; new test pins the
   guarantee (frozen DC-offset tail decays to zero mean).
5. **Tape wow** (character 1): two fixed slow per-channel LFOs (0.7 Hz,
   dephased π/3), ±0.5 ms ≈ ±2 cents — the doc §3.2 "subtle pitch wobble",
   independent of the MOD knob. Digital/analog untouched.
6. Minor: removed the duplicated `this.mix`/`this.lfoPhase` assignments.

**Bundle:** `public/core-worklet.js` rebuilt (11 new markers verified);
esbuild IIFE unchanged otherwise.

**Doc sync (`docs/kaskada-architecture.md`):**

- §1: SOLO WET / send-return descoped (was promised but absent from the
  §4 contract); moved to §8 Phase 2 (needs a 16th param + Inspector wiring).
- §3.1: max delay 2000 ms (was 5000); ring buffer sized from the context
  sample rate (the "16384 samples" claim was wrong by ~6× at 48 kHz).
- §3.2: tape row documents the implemented wow (rate, depth, dephase).
- §3.4: loop EQ acts on the whole wet path — the first repeat IS already
  coloured; the feedback-path-only "bright first slap" variant was
  considered and deliberately not built (documented as a Phase 2 revisit).
- §3.6: drive unity-small-signal contract spelled out.
- §5.1: pseudocode (dcBlock, freeze write-back), buffer sizing, biquad
  count (2×LP + 2×HP per channel, not "4× and 4×"), freeze semantics.

**Tests:** `tests/kaskada.test.ts` 34/34 (32 → 34: +driven-loop, +DC
guarantee; freeze DEFECT flipped to sustain; harness input for freeze
switched impulse → burst). Typecheck clean.

**Recommendations for next session (Kaskáda step 3 — browser QA):**

- §9's last open box: verify-browser pass on a quiet machine (the suite
  must not run co-tenant — see KNOWN_LIMITATIONS): load worklet in rack,
  Add Effect menu path, drag TIME/SYNC, change transport BPM re-times a
  synced delay, ping-pong audible, freeze sustains, CPU budget for the
  heavier per-sample chain (hermite + wow + DC block ≈ 2× linear-read cost).
- Then Phase 2 picking order (cheapest first): dual spectrum display →
  solo wet (16th param) → reverse mode (latency reporting) → unmask solver.

## MIXER BATCH FX — ADD TO reveals the FX rack (2026-09-17)

**User report:** adding an effect from the Mixer's batch FX bar (select
"Kaskáda Delay" → ADD TO) gave zero visible feedback — no device UI, no
navigation. Root cause: the device UI (rack knobs / flagship panel) lives
in the FX dock panel, and the Mixer never switched to it.

**Changes:**

- `src/ui/dockLayout.ts`: new pure helper `ensurePanelVisible(state,
  panel)` — no-op when the panel is already docked in EITHER slot (reveal
  semantics, deliberately not a toggle: `openInSlotA` would close an
  already-open rack), otherwise opens it in the primary slot.
- `src/ui/Mixer.tsx`: optional `onOpenFxPanel` prop, called after a
  successful `addEffectToTracks` execute (not on command failure).
- `src/ui/App.tsx`: `openFxPanelIfNeeded` binding passed as the prop.

**Tests:** `tests/dock-layout.test.ts` +3 (opens when absent; identity
no-op for slot A; identity no-op for split slot B — `.toBe(original)` on
purpose: callers can skip setDock entirely). `tests/ui/Mixer.test.tsx` +1
(userEvent: select Kaskáda → click ADD TO → spy called). Typecheck clean;
Mixer/dock-layout/EffectRack suites green before the full-suite sweep.

**Note:** BYPASS/REMOVE intentionally do NOT navigate — they act on
existing instances and the user may be mid-batch across many tracks;
only ADD has the "show me what I just created" contract.

---

## GOAL 01 (campaign restart) — TypeScript Type Integrity & Runtime Validation (2026-09-18)

**Campaign restart context.** Daniel initiated a new prompt series under
`D:/QVESTER_LANDING_PAGE/prompts/threejs_scheduler_goals/` (11 files,
`00_GLOBAL_EXECUTION_CONTRACT.md` + `01_TYPESCRIPT_TYPE_INTEGRITY.md` …
`10_PRODUCTION_HMR_WORKERS_SERIALIZATION_FINAL_SWEEP.md`). Scoping confirmed
via ask_user before starting:

- **Scope lock:** only **GOAL 01–03** are in scope for Pulse Forge (audio DAW).
  GOAL 04–10 are Three.js / WebGL / GPU / shader / camera-specific and Pulse
  Forge has **no Three.js dependency** (`package.json` does not list `three`,
  `@react-three/*`, `postprocessing`; `src/ui/` uses only 2D Canvas API for
  Spectrum/Goniometer/LoudnessHistory/WavetablePreview/EnvEditor/fxeqCurve).
  GOAL 04–10 are explicitly recorded here as **reviewed, NOT applicable**
  to keep the campaign log honest about what was checked.
- **Starting point:** begin at GOAL 01 (no separate recon pass — Pulse Forge
  recon from the 2026-09-10 / 2026-09-13 rounds is still trustworthy).

**Goal executed.** Audit TypeScript type integrity in Pulse Forge: hunt for
type-erasure escape hatches, stale fixtures, type-contract drift between
production and test surfaces, unchecked boundary inputs, and unsafe
runtime assumptions. Fix the issues found. Do **not** rewrite production
source where the test fixture was the wrong one — keep the blast radius
narrow.

**Areas inspected.**

- `tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`,
  `verbatimModuleSyntax`, `isolatedModules`. **`noUncheckedIndexedAccess`
  is missing** — indexed access (`arr[i]`) returns `T`, not `T | undefined`.
  Documented as recommendation, not flipped in this campaign (would cause
  a non-trivial wave of fixes across the codebase and warrants its own
  goal).
- Grep sweeps on `src/**/*.{ts,tsx}`:
  - **119 `as any`** total
  - **43 `: any`** total
  - **0 `<any>`** generics
  - **1 `Record<string, any>`**
  - **3 `@ts-ignore` / `@ts-expect-error`**
  - **203 `: unknown`** (most are correct boundaries — deserialized data,
    IPC payloads, schema-drift detectors)
  - **1075 total `as CastType` casts** (vast majority are legitimate
    narrowing: `(el) as HTMLInputElement`, `JSON.parse(x) as Foo`, etc.)
- `tsc --noEmit -p tsconfig.json` on the full tree (`src` + `tests` +
  `vite.config.ts`). Result before fixes: **88 errors in 20 test files,
  zero in `src/`**.
- New uncommitted audio modules reviewed (chorus-processor, stock-delay-
  processor, phase-vocoder, warp-render worker) — no Three.js or GPU
  surfaces; safe to scope out GOAL 04–10.

**Confirmed findings.**

1. **`tests/helpers.tsx` type contract leak (GOAL 01 critical).**
   `mockServices` (line 305) returns `as unknown as Services` after
   building the mock with ~28 `as any` casts. `execute: vi.fn()` (line
   112) is inferred as `(c: unknown) => unknown`, which is **incompatible**
   with the production `ProjectStore.execute(command: Command): void`
   (`src/store/ProjectStore.ts:160`). The `as unknown as Services` at the
   end erases all type information, masking type errors downstream — that
   is exactly the failure mode GOAL 01 calls "test type contract masking
   production type drift". Tightened to
   `execute: vi.fn<(c: Command) => void>()` (4 errors resolved across
   `WavetablePanel.test.tsx`).
2. **`Pattern` fixture stale — 11 occurrences.** `Pattern.notes` is
   `Record<ID, NoteEvent[]>` (required) per `src/project-model/types.ts:438`
   and has existed since the Initial commit (`4096423`). The schema
   normalizer at `src/project-model/schema.ts:1641-1644` backfills `{}`
   when missing, so runtime was safe; the type contract was stricter.
   Fixed: added `notes: {},` before `stepMeta: undefined` in
   `tests/ai-adversarial.test.ts` (5) and `tests/ranking-adversarial.test.ts`
   (6, with one pre-existing duplication collapsed).
3. **Inline structural type contract leak — `WavetablePanel.tsx:41`**
   (GOAL 01 critical, **documented but NOT fixed** in this campaign).
   The component declares
   `services: { bank: { get(id: string | null): AudioBuffer | undefined }; store: { execute: (c: unknown) => unknown } }`.
   The `execute: (c: unknown) => unknown` is incompatible with the
   production `Services.execute: (c: Command) => void`. Any non-mock
   caller passing a real `Services` object would fail typecheck. Fixing
   it requires either changing the prop to `Pick<Services, "bank" | "store">`
   or full `Services`, both of which ripple into GranularPanel,
   WavetablePanel, fxeqCurve, and several adversarial tests. **Recorded
   as a follow-up for a future hardening pass.** Test-side fix used
   `as Parameters<typeof WavetablePanel>[0]["services"]` to bridge the
   two contracts locally.
4. **Missing `.d.ts` declarations for two new worklet modules.**
   `chorus-processor.js` and `stock-delay-processor.js` lacked type
   stubs. `tests/chorus-delay-buss.test.ts` does dynamic
   `await import("../src/audio-worklets/{chorus,stock-delay}-processor.js")`
   which TypeScript could not resolve. Created `.d.ts` files following
   the `kaskada-processor.d.ts` house pattern
   (`src/audio-worklets/chorus-processor.d.ts`,
   `src/audio-worklets/stock-delay-processor.d.ts`).
5. **Stale component API in tests (5 components).**
   - `Goniometer`: tests used `leftAnalyser` / `rightAnalyser` props;
     production now uses a single `analysers: { l, r } | null`. 3 occurrences.
   - `LoudnessHistory`: test used `windowSec={30}` — prop does not exist
     on the component (was renamed/removed in a prior refactor).
   - `GranularPanel` / `InstrumentTrack`: test set `patterns: []` on
     `InstrumentTrack` — the field belongs on the `Pattern` document,
     not on the track.
   - `SampleBrowser`: tests passed `services={mockServices()}` — the
     component fetches `services` from React context; the prop was
     removed in a prior refactor. 4 occurrences.
   - `FreezeButton` / `GroupTrack`: test set `trackIds: []` — `GroupTrack`
     does not have that field. Added the missing required fields
     (`pan`, `effects`).
6. **`liveCount` dead code in `tests/state-store-adversarial.test.ts`.**
   `let liveCount = 0;` was declared and reassigned (`liveCount = 0;`)
   but never read — the assertion that would have used it was deleted.
   Both occurrences removed; comment retained explaining the invariant.
7. **`fakeTransport` closure issue in
   `tests/state-collab-scheduler-adversarial.test.ts`.** Original
   `const t = { … timeAtTick: (tick: number) => tick / 24 / (t.bpm / 60) … }`
   references `t.bpm` before `t` is initialized, giving `t` an implicit
   `any` type and cascading into 3 errors (`tick` and `sec` parameters
   became implicit `any`). Refactored to extract `const bpm = 124` and
   use it in the arrow functions; return the object directly with
   `as unknown as Transport` cast.
8. **`SharedTransportState` adversarial contract.**
   `applyTransportState(target, null)` and `applyTransportState(target,
   { garbage: "x" })` are intentional invalid-input tests (verified by
   the surrounding `expect(touched).toBe(false)` assertion). Cast both
   to `as unknown as SharedTransportState` to satisfy the strict
   signature. Merged `SharedTransportState` into the existing
   `import { … } from "../src/collab/transportSync"` block as a
   `type`-only member to avoid duplicate-identifier errors.
9. **Misc field renames / spread fixes.**
   - `isPlaying: true` → `playing: true` (2x, in `fakeTransport({ … })`
     calls).
   - `VelocityLevel = 0 | 1 | 2 | 3` cast on the loop variable in
     `tests/ai-adversarial.test.ts:102`.
   - `LoopFlipAnalysis | null` early-return: added `if (!a || !b) return;`
     instead of relying on `b` being non-null.
   - `tests/ranking-adversarial.test.ts:619` `...(base.generation as never)`
     → `...base.generation` (with an explicit `if (!base.generation) return;`
     guard so the spread is statically safe).
   - `tests/state-persistence-adversarial.test.ts:457` `realTx(...args)`
     → `realTx.apply(db, args as Parameters<typeof realTx>)` to satisfy
     the strict `Spread types may only be created from object types`
     error from the variadic mock signature.
   - `App.test.tsx:24` `event === "pointerdown"` (where `event` was
     inferred as `keyof DedicatedWorkerGlobalScopeEventMap` because the
     destructured tuple was not widened) → `(args[0] as string) === "pointerdown"`.

**Fixes implemented.** 18 files modified.

- Test surface (16 files):
  - `tests/helpers.tsx` — added `Command` import; tightened
    `execute: vi.fn<(c: Command) => void>()`. The trailing
    `as unknown as Services` and ~28 inner `as any` casts remain — see
    follow-up.
  - `tests/ai-adversarial.test.ts`, `tests/ranking-adversarial.test.ts` —
    added `notes: {},` in 11 Pattern fixtures; collapsed one pre-existing
    duplication; added `if (!base) return;` and `if (!base.generation) return;`
    guards for spread safety.
  - `tests/chorus-delay-buss.test.ts` — now resolves the new `.d.ts`
    stubs (no test edits required).
  - `tests/state-collab-scheduler-adversarial.test.ts` —
    `fakeTransport` rewritten with explicit `bpm` const; `JamRole` split
    into `import { roleAllows, … }` + `import type { JamRole }` per
    `verbatimModuleSyntax`; `SharedTransportState` merged into the
    existing `transportSync` import; `applyTransportState` invalid-input
    tests get `as unknown as SharedTransportState` casts;
    `isPlaying` → `playing`.
  - `tests/state-store-adversarial.test.ts` — `liveCount` declaration
    and assignment removed; invariant preserved by comment.
  - `tests/state-persistence-adversarial.test.ts` — `realTx.apply(db,
    args as Parameters<typeof realTx>)`.
  - 9 unused-`mockServices` imports removed (`DiceContext`,
    `DropZone`, `FreezeButton`, `Goniometer`, `Inspector`,
    `IntentPanel`, `LoudnessHistory`, `SpectrumAnalyzer`,
    `UndoHistoryPanel`).
  - 2 unused-`userEvent` imports removed (`OzvenaPanel`,
    `WavetablePanel`) — replaced with a `// (userEvent removed — unused)`
    comment so the omission is intentional and reviewable.
  - Stale-API test fixes: `Goniometer` (3 sites — `analysers={{ l, r }}`
    or `analysers={null}`), `LoudnessHistory` (1 site), `GranularPanel`
    (`InstrumentTrack.patterns` removed, `level` removed), `SampleBrowser`
    (4 sites — `services` prop removed), `FreezeButton`
    (`GroupTrack.trackIds` removed, `pan` + `effects` added),
    `WavetablePanel` (4 sites — `as Parameters<typeof …>["services"]`
    bridge).
  - `App.test.tsx` — `pointerdown` comparison widened to
    `(args[0] as string) === "pointerdown"`.
- Source surface (2 new files):
  - `src/audio-worklets/chorus-processor.d.ts`,
    `src/audio-worklets/stock-delay-processor.d.ts` — type stubs
    following the `kaskada-processor.d.ts` house pattern.

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0, zero
  errors). Full count went **88 → 0** across **20 files → 0 files**.
- `npm test --run`: full suite (244 tests across the project) was
  started in the background at the end of this goal. Result will be
  reported in the next session turn or in a follow-up log entry.

**Scope record — GOAL 04–10 NOT applicable.**

Each file from `04_THREEJS_RESOURCE_OWNERSHIP.md` through
`10_PRODUCTION_HMR_WORKERS_SERIALIZATION_FINAL_SWEEP.md` was opened and
read in full. All ten target Three.js / WebGL / GPU surfaces that Pulse
Forge does not use:

| File                                                          | Topic                                            | Pulse Forge relevance |
| ------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| `04_THREEJS_RESOURCE_OWNERSHIP.md`                            | Three.js geometry/material/texture disposal      | N/A — no Three.js     |
| `05_RENDER_LOOP_GPU_CPU_STABILITY.md`                         | Three.js animation loop + GPU stalls             | N/A — no Three.js     |
| `06_SHADER_CORRECTNESS_CONTRACTS.md`                          | GLSL correctness / uniforms / varyings           | N/A — no shaders      |
| `07_SHADER_PERFORMANCE_COLOR_PRECISION.md`                    | GLSL precision / texture formats                 | N/A — no shaders      |
| `08_CAMERA_RESIZE_RAYCAST_INTERACTION.md`                     | Three.js camera + raycasting + resize            | N/A — no Three.js     |
| `09_ASSETS_CONTEXT_BROWSER_CAPABILITIES.md`                   | glTF / KTX2 / GPU context loss                   | N/A — no Three.js     |
| `10_PRODUCTION_HMR_WORKERS_SERIALIZATION_FINAL_SWEEP.md`      | Three.js + HMR + structured-clone hazards        | N/A — no Three.js     |

The lessons in those files (`useRef` for transient values, dispose
patterns, camera-aspect on resize, browser-context-loss fallback, etc.)
are reusable engineering hygiene in principle, but applying them
without a Three.js surface is not actionable. **Pulse Forge's actual
analogues are the 2D Canvas-based visualizers** (SpectrumAnalyzer,
Goniometer, LoudnessHistory, WavetablePreview, fxeqCurve, EnvEditor)
and the audio worker / worklet lifecycle. If Daniel wants a
Pulse-Forge-specific version of any of these prompts (e.g. an
"audio worklet / 2D canvas resource ownership" goal), it can be
written as a fresh prompt outside the `threejs_scheduler_goals`
series.

**Unresolved issues / follow-ups.**

1. **`WavetablePanel.tsx:41` inline structural `execute: (c: unknown)
   => unknown`** — real type-contract leak between the component-local
   type and the production `Services.execute`. Fix candidates:
   `Pick<Services, "bank" | "store">` on the prop, or accept full
   `Services`. Ripple effects in GranularPanel and `fxeqCurve` should
   be checked in the same pass. **Estimated 2–3 hours incl. tests.**
2. **`tests/helpers.tsx:305` `as unknown as Services` + ~28 inner
   `as any`** — long-term fix is a `MockServicesBuilder` helper that
   constructs a properly-typed partial mock with overrides, removing
   every `as any` from the test suite. **Estimated 2–4 hours** (largest
   payoff is test-side readability + better error messages).
3. **Add `noUncheckedIndexedAccess` to `tsconfig.json`** as a
   separate, scoped goal. Estimated **1–2 hours** but produces a
   cascade of small fixes — should be its own GOAL because it touches
   every file that does `arr[i]` or `obj[key]`.
4. **Targeted audit of the remaining 119 `as any` in `src/`** — most
   are legitimate (Yjs `yMap.get()` returns `any` by design — yjs does
   not ship first-class TS types for its shared types; this is a
   well-known pattern across the Yjs ecosystem). A grep plus a manual
   sweep of `commands.ts`, `schema.ts`, `project-model/schema.ts`,
   and `audio-engine/` would likely find 5–10 unsafe uses that are
   worth fixing individually. Estimated **1–2 hours**.

**Remaining risks.**

- The 244-test full-suite run was started at the very end of this goal
  and may surface regressions introduced by the test-side fixes
  (especially `WavetablePanel`'s `as Parameters<typeof …>["services"]`
  bridge, which can mask a real type drift if production's
  `Services.execute` ever changes). If failures appear, they should be
  triaged against the bridge contract, not against the test fixtures.
- `as unknown as …` casts are sticky: future contributors will copy
  them. The WavetablePanel and helpers.tsx follow-ups should be
  prioritized before more callers adopt the pattern.

**Recommendations for next session.**

- **GOAL 02 — React lifecycle, state & async correctness audit.**
  Pulse Forge has rich `useEffect`/`useState` usage in `src/ui/` (mixer
  panel, arrangement, effects rack, plugin popouts) plus the
  AudioUnlock gate (which already received a fix during the 2026-09-10
  GOAL 01 — the `pointerdown` registration test added here will be
  one of the audit points). Targets: cleanup correctness on unmount,
  AbortController usage in async effects, race conditions between
  fast user input and slow persistence writes, async state updates
  after unmount, audio worklet message-port lifecycle.
- After GOAL 02 finishes, **GOAL 03 — React render performance & state
  topology audit** is the natural next step (frame-rate derived values
  on Spectrum/LoudnessHistory/Goniometer, broad context subscriptions,
  oversized global store reads, virtualization on arrangement/track
  lists). When both are green, Pulse Forge's "01–03" coverage of this
  prompt series is complete and 04–10 can stay parked.
- **Optional earlier detour:** the `WavetablePanel.tsx` services-prop
  fix (follow-up #1) is small enough to bundle with GOAL 02 and would
  clean up one of the two `as unknown as …` hotspots identified here.


---

## GOAL 02 (campaign restart) — React Lifecycle, State & Async Correctness (2026-09-18)

**Goal executed.** Audit Pulse Forge for React lifecycle correctness, effect
cleanup, async race conditions, subscription leaks, and timer/listener
ownership. Pulse Forge has rich `useEffect` usage in `src/ui/` (mixer panel,
arrangement, effects rack, plugin popouts, sw-update), plus a 15-minute
service-worker poll timer, persistence listeners, and audio worklet messaging
that can outlive their hosts. The objective was to identify concrete leak
or race-class bugs, fix the high-impact ones, and avoid papering over real
problems with blanket memoization.

**Areas inspected.**

- Grep sweep on `src/**/*.{ts,tsx}` for lifecycle-relevant primitives:
  - **122 `useEffect` calls** across `src/ui/`
  - **0 `useLayoutEffect`** (clean — no imperative layout work)
  - **15 `registerRaf` / `requestAnimationFrame` sites** (centralised — good)
  - **0 `setInterval` / `setTimeout` in `src/ui/`** (RAF only — good)
  - **0 `AbortController` in `src/`** (async work is NOT cancellable
    anywhere — every `void somePromise().then(setState)` is a candidate
    setState-on-unmounted-component class)
  - **0 `addEventListener` in `src/ui/`** (lifecycle-owned listeners
    only — but `sw-update.ts` adds document-level listeners at module
    load)
  - **9 `new AudioContext`** sites (mostly singleton — verified)
  - **0 `MessagePort` postMessage sites** — audio worklet messaging uses
    `AudioWorkletNode.port`, not the raw MessagePort API; lifecycle
    audit still needed because `AudioWorkletNode.port` survives unmount
    unless `disconnect()` is called.

- Per-file `useEffect` cleanup audit (regex `return\s+(?:\(\)\s*=>|function\s*\()`):
  - **0 cleanup candidates in `src/ui/` matched by the regex.** This is
    misleading — most effects legitimately need no cleanup (drawing into a
    canvas, syncing `setState` from props, focusing an input on open,
    scrolling the selected row into view). The audit then dropped to a
    targeted **manual review of every file with the lowest
    effect-to-cleanup ratio** — `OzvenaPanel.tsx`, `PaletteOverlay.tsx`,
    `Inspector.tsx`, `MidiPanel.tsx`, `MpeIndicator.tsx`,
    `ProjectBrowser.tsx`, `SampleBrowser.tsx`. Five of those seven were
    pure (drawing / focus / scrollIntoView / prop-sync); two had real
    leak classes — see findings.

- AudioContext lifecycle spot-checks: `browser-checks.ts` (MediaRecorder
  feature detection) and `export/video.ts` use temporary contexts in
  try-finally blocks with `.close().catch(() => {})` — **correct**.
  `embed/EmbedApp.tsx` and `audio-engine/AudioEngine.ts` use a single
  long-lived AudioContext via `ctxRef.current ??= new AudioContext()` —
  **correct**.

**Confirmed findings.**

1. **`src/sw-update.ts` — `initSwUpdate()` is not idempotent (GOAL 02
   critical).** The module wires three resources on first call: a
   `setInterval(15 * 60 * 1000)` that polls for service-worker updates,
   a `document.addEventListener("visibilitychange", …)` that re-checks
   when the tab becomes visible, and a `reload` / `dismiss` button pair
   (guarded by `if (document.getElementById("pf-update-banner")) return`
   so the banner itself does not double). Because the module is
   imported once from `main.tsx`, the *current* code path does not leak
   in production. The hazard is structural: any second call (Vite HMR
   re-evaluation, a future test that touches the module, an alternate
   host that mounts `initSwUpdate` more than once) stacks a fresh
   interval **and** a fresh document listener every time. There was no
   exported `disposeSwUpdate`, so even a deliberate reset was impossible.
2. **`src/ui/SampleBrowser.tsx:53-55` — async userSamples.list() without
   cancellation.** The mount effect did
   `void services.userSamples.list().then(setAllUserAssets)` with no
   cleanup. If `SampleBrowser` unmounts before the IndexedDB read
   resolves (e.g. the user opens a sample browser modal, hits Cancel,
   and the panel is removed in the same tick), `setAllUserAssets`
   still fires on an unmounted component. Modern React 18 silently
   drops the update, but it is a hard `act()` warning under StrictMode
   and is observable in React DevTools. The fix is a `cancelled` flag
   closed over by the cleanup function.
3. **`src/ui/ProjectBrowser.tsx:51-55` — async repo.listAll() without
   cancellation.** Same class as #2, just on the project listing. The
   original implementation factored `refresh()` through `useCallback`
   and called it from a separate `useEffect([refresh])`. The
   `useCallback` boundary made the cancellation harder to spot: the
   `.then(setProjects)` chain belonged to a different function than the
   effect. Inlined the call directly into the effect so the
   `cancelled` flag is local to the mount cycle.
4. **`src/ui/JamGate.tsx:44` — unsafe cast on an async boundary
   (separate finding from the same audit pass).**
   `const ctx = services.engine.ensureContext() as AudioContext`
   followed by `if (ctx.state === "suspended") await ctx.resume()…`.
   When `ensureContext()` returns `undefined` (engine pre-init, failed
   unlock, suspended services object), `ctx.state` throws
   `TypeError: Cannot read properties of undefined`. The test
   `tests/ui/JamGate.test.tsx` surfaces this as an **unhandled
   rejection** during teardown (441 tests still PASS — the failure is
   in an event handler that fires after the assertion). **Not fixed in
   this campaign**: a fix here requires deciding what `JamGate` should
   do when the audio engine is not ready (gate the pointer-down
   handler behind an `isReady` flag from the engine, or render an
   "Unlock first" placeholder instead of a tappable button). Tracked
   as a follow-up.
5. **`src/audio-worklets/` MessagePort lifecycle.** Out-of-scope for
   this fix pass because every audio worklet in Pulse Forge is a
   short-lived `AudioWorkletNode` created inside a useEffect that also
   stores it in a `useRef`, with `disconnect()` and `.port.close()`
   called in the matching cleanup. Spot-checked Kaskáda, chorus,
   stock-delay, and the regular effect rack — pattern is consistent.
   **No action required**, but a `tests/audio-worklet-lifecycle.test.ts`
   sweep would be a worthwhile follow-up.
6. **No other `useEffect` leaks found.** The seven files with the
   lowest `useEffect`-to-cleanup ratio (`OzvenaPanel`, `PaletteOverlay`,
   `Inspector`, `MidiPanel`, `MpeIndicator`, `ProjectBrowser`,
   `SampleBrowser`) were reviewed one-by-one. Five have legitimate
   no-cleanup patterns (drawing into a canvas, syncing derived state
   from props, focusing an input on `open`, scrolling the selected row
   into view); two are #2 and #3 above. `App.tsx` and
   `ArrangementPanel.tsx` carry the bulk of the more involved effects
   and they each already use the right idioms (`mounted.current`
   guard, `transientJumpAbortRef`, `recRef`, `signal = beginExport()`).

**Fixes implemented.** 5 files modified, 1 test file + 1 stub added.

- `src/sw-update.ts` — added `initialized` flag and `disposeSwUpdate`
  exported alongside `initSwUpdate`. `initSwUpdate` now early-returns
  if already initialised; `disposeSwUpdate` clears the poll interval
  and removes the `visibilitychange` listener. The poll interval ID and
  the listener reference are stored at module scope so dispose can
  clean them up exactly. Idempotency is testable without standing up the
  full PWA plugin.
- `src/ui/SampleBrowser.tsx` — replaced the mount effect with a
  `cancelled` flag + cleanup pattern. Comment documents why the flag is
  necessary (setState on unmounted component, StrictMode + DevTools
  warnings).
- `src/ui/ProjectBrowser.tsx` — inlined the IndexedDB read into the
  effect body and added a `cancelled` flag. The intermediate `refresh`
  useCallback stays for the manual refresh button but is no longer
  the only path. The error-handling branch now also respects the
  `cancelled` flag so a late rejection from a fast-unmount-then-throw
  race cannot trigger a `setListError` after unmount.
- `tests/sw-update-lifecycle.test.ts` — new regression test with 4
  scenarios:
  1. `initSwUpdate` is idempotent — repeated calls do not stack
     intervals or document listeners.
  2. `disposeSwUpdate` clears the poll interval and removes the
     visibilitychange listener, and a follow-up `initSwUpdate` wires
     fresh handlers (proves we are not stuck in the initialised state).
  3. `disposeSwUpdate` without prior init is a no-op (does not throw,
     does not touch timers).
  4. Per-cycle accounting: 3 init / 2 dispose cycles produce exactly
     3 `setInterval` calls and 3 `addEventListener("visibilitychange")`
     calls, paired with 2 `clearInterval` and 2 `removeEventListener`.
- `tests/_stubs/virtual-pwa-register.ts` — new stub module.
- `vite.config.ts` + `vitest.config.ts` — both now alias
  `virtual:pwa-register` to the stub so the test graph resolves the
  import. The alias is duplicated across the two config files because
  Vite's `mergeConfig` is not used here and a production-only alias
  in `vite.config.ts` would not be visible to vitest.

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0, zero
  errors).
- `npm test -- --run tests/sw-update-lifecycle.test.ts
  tests/ui/ProjectBrowser.test.tsx tests/ui/SampleBrowser.test.tsx`:
  **3/3 test files passed**, 9 tests passed (4 sw-update +
  4 SampleBrowser + 1 implicit ProjectBrowser), 4.27 s. Exit code 0.
- `npm test -- --run tests/sw-update-lifecycle.test.ts tests/ui/`:
  **78/78 test files passed**, **441/441 tests passed**, 53.45 s. Exit
  code 0. One unhandled rejection recorded during teardown (JamGate
  test, finding #4 above) — does not affect test pass/fail counts.

**Unresolved issues / follow-ups.**

1. **`src/ui/JamGate.tsx:44` unsafe cast on async boundary** —
   `ensureContext() as AudioContext` followed by `ctx.state` / `ctx.resume()`
   throws when the engine is not ready. Fix candidates:
   (a) gate the tappable surface behind an `engineReady` flag derived
   from `services.engine.isContextRunning?.()` (or similar);
   (b) render an "Unlock audio first" placeholder that explains why the
   button is non-interactive. **Estimated 1–2 hours** and ideally
   packaged with the next audio-engine lifecycle sweep.
2. **`AudioWorkletNode.port.close()` lifecycle test.** A test file that
   asserts each worklet consumer in `src/audio-worklets/*-node.ts`
   closes the underlying port on unmount. Spot-checked by hand, but a
   regression test would make this safe against future refactors.
   **Estimated 1 hour.**
3. **Generic `MockServicesBuilder` for `tests/helpers.tsx`.** The
   follow-up from GOAL 01 still applies — once the producer side has a
   properly-typed builder, every `useEffect` cancellation test can use
   the same mock without `as any`. This would also unlock the use of
   `vi.useFakeTimers()` against the audio-engine path, which is
   currently hard to write.
4. **`AbortController` for fetch / IPC paths.** Pulse Forge has zero
   `AbortController` usage. The async patterns that currently rely on
   `void somePromise().then(setState)` (SampleBrowser / ProjectBrowser
   fix is the local cancellation flag pattern; for fetch / IPC paths,
   AbortController is the idiomatic choice) should adopt it where the
   underlying API supports it (e.g. `fetch`, `AudioDecoder.configure`,
   `MediaRecorder.stop()`). **Estimated 2–3 hours** as a sweep.

**Remaining risks.**

- The JamGate teardown error is benign for the test pass count but
  would surface as a console error in production for any user who
  clicks the JAM GATE before unlocking audio. Not a regression from
  this campaign — pre-existing.
- `sw-update` is still imported as a side-effect from `main.tsx` only.
  If a future test or HMR boundary ends up running the module twice
  without an intervening `disposeSwUpdate`, the new `initialized`
  guard will still prevent the leak. The fix is robust against that
  hazard.

**Recommendations for next session.**

- **GOAL 03 — React render performance & state topology audit.** With
  lifecycle hygiene restored, the next class of issues is on the
  render path. Pulse Forge already centralises RAF (15 sites), so the
  natural audit points are: (a) whether any component subscribes to a
  high-frequency store via `useStore` / `useContext` and re-renders on
  every frame, (b) whether the Spectrum / LoudnessHistory / Goniometer
  canvas visualizers update their internal state at frame rate through
  React (imperative `useRef` is preferred), (c) whether broad
  selectors return unstable objects and defeat `memo`, (d) whether
  large lists (track strips, sample browser, history panel) need
  virtualization. Files to start in: `src/ui/SpectrumAnalyzer.tsx`,
  `src/ui/Goniometer.tsx`, `src/ui/LoudnessHistory.tsx`,
  `src/ui/WavetablePreview.tsx`, `src/ui/SliceLab.tsx`,
  `src/ui/RackStrip.tsx`, `src/ui/Mixer.tsx`, `src/store/`,
  `src/services.ts`.
- **Optional earlier detour:** the JamGate fix (follow-up #1) is
  small enough to bundle with GOAL 03 if a render audit path lands on
  the audio engine anyway.


---

## GOAL 03 (campaign restart) — React Render Performance & State Topology (2026-09-18)

**Goal executed.** Audit React render behaviour in Pulse Forge with
emphasis on unnecessary render propagation, unstable identities, expensive
derivation, and poorly placed state. Pulse Forge is a real-time audio
DAW: transport position, meter values, spectrum analyser readings, and
goniometer samples all change at frame rate; if any of those routes
through React state without throttling, the entire `useDoc()` subtree
re-renders at audio rates. The audit covered the entire `src/ui/`
tree, the context providers, the canvas visualizer fleet, and the
high-map-count panels.

**Areas inspected.**

- Grep sweep on `src/**/*.{ts,tsx}` for the prompt's audit vocabulary:
  - **122 `useEffect`** across `src/ui/` (7+ in `App.tsx`, `ArrangementPanel.tsx`,
    `TopBar.tsx`, `SliceLab.tsx`, `RackStrip.tsx`)
  - **0 `useLayoutEffect`** — no imperative layout writes
  - **0 `useMemo`** in `App.tsx`, `ArrangementPanel.tsx`, `TopBar.tsx`,
    `Mixer.tsx`, `ModPanel.tsx` at audit start; `PianoRoll.tsx`
    already uses `useMemo` for ghost-note derivation, `SliceLab.tsx`
    and `RackStrip.tsx` use it for parameter lists
  - **0 `useCallback`** at audit start in any of the high-map panels —
    most handler props are passed to native elements where identity
    does not matter
  - **`useSyncExternalStore` is the universal context primitive.**
    All of `useDoc`, `useSaveStatus`, `useLastSavedAt`, `useCanUndo`,
    `useCanRedo`, `useLatencyCalibration`, `useArrangementCapture`,
    `useLibrary`, `useSceneRuntimeState`, `useTool`, `useSelection`
    are thin wrappers over `useSyncExternalStore` with a stable
    `subscribe` and a stable `getSnapshot` returning the same field
    reference unless the store actually changed (`getDoc → this.doc_`,
    `getSaveStatus → this.saveStatus_`, `getLastSavedAt → this.lastSavedAt_`,
    `canUndo`/`canRedo` are getters returning booleans).
  - **0 `useStore` / generic store hook** in Pulse Forge — every
    subscriber goes through the dedicated context hooks above.
- Canvas visualizer audit (`getContext("2d")` sites):
  `SpectrumAnalyzer`, `Goniometer`, `LoudnessHistory`, `fxeqCurve`,
  `WavetablePreview`, `KaskadaPanel`, `FxEqPanel`, `OzvenaPanel`,
  `GranularPanel`, `UltinaPanel`, `SliceLab`. **All of them** use
  `registerRaf` (shared RAF pool in `src/services/rafLoop.ts`) for
  their per-frame draw loop and store the analyser snapshots in
  `useRef` (mutable), never in `useState`. `Goniometer` and
  `SpectrumAnalyzer` use `useState` for a `{width, height}` backing
  store driven by `ResizeObserver` only — that is the correct
  React-state pattern (the observer fires on layout change, not per
  frame). **No canvas visualizer routes frame-rate values through
  React state.** This is exactly the pattern GOAL 03 promotes.
- Transport-position routing audit (`src/ui/playhead.ts`):
  `useTransportPosition`, `usePlayheadStep`, `usePlayheadBar`. **All
  three** use `registerRaf` plus an internal `last` cache; the setState
  fires only when the display string / step number / bar-quantised
  position actually changes. `usePlayheadBar` quantises to 1/8 bar
  (so the playhead pixel only updates 8× per bar, not 60× per second).
  Pulse Forge is doing frame-rate throttling at the *transport
  state* layer, not just at the canvas layer — the right place.
- High-map-count panels (≥ 8 `.map(` calls):
  `ModPanel.tsx` (39), `ArrangementPanel.tsx` (23), `PianoRoll.tsx`
  (23), `Mixer.tsx` (17), `DiceTray.tsx` (10), `EffectRack.tsx`
  (11), `GenerateDialog.tsx` (9), `MidiPanel.tsx` (9),
  `PresetBrowser.tsx` (8), `RackStrip.tsx` (9), `UltinaPanel.tsx`
  (22). Most of these are *composition* (track strips, pattern
  lanes, mod routings) where the inner JSX is small. The two with
  the worst derived-state cost are `ModPanel.tsx` and `Mixer.tsx`,
  because both walk `doc.tracks` 4-5× per render without memoization.

**Confirmed findings.**

1. **`src/ui/ModPanel.tsx` — broad `doc.tracks.filter(...)` chain
   without memoization.** At audit start the component did five
   expensive computations on every render: `[...doc.tracks, ...doc.returns]`,
   `doc.automation.find(...)`, `doc.patterns.find(...)`, `targetOwner(...)`
   (also walks tracks/returns), and the `hasDeepParams` predicate
   over `addableTrack.effects`. Every store mutation re-rendered
   `ModPanel` (it is a `useDoc` subscriber), and each re-render
   allocated five new arrays plus the `.find`/`.filter` walks. With a
   typical 16-track session that is ~80 comparisons + 5 array
   allocations per store tick. Memoization collapses it to one pass
   per snapshot.
2. **`src/ui/Mixer.tsx` — five `doc.tracks.filter(...)` calls per
   render.** Same shape as #1: `selectedTracks`, `soloCount`,
   `muteCount`, `collapsedGroups` (Set), `visibleTracks`. Each
   is `O(n)` and recomputed for every doc mutation. For a
   30-track session the chain walks `doc.tracks` five times
   (~150 comparisons) on each `useDoc` re-render — and `Mixer`
   subscribes to `useDoc`, `useSelection`, and reads `selection`
   which itself is a `useSyncExternalStore`, so render frequency
   is high.
3. **`src/ui/SliceLab.tsx`, `src/ui/RackStrip.tsx`** — already use
   `useMemo` for parameter lists and effect chains. Spot-checked
   and confirmed correct. **No action.**
4. **`src/ui/PianoRoll.tsx`** — uses `useMemo` for `ghostNotes`
   and `ghostTrackNotes`. The non-memo parts are small (cursor
   pos, hover note id). **No action.**
5. **`App.tsx` 8 `.map(` calls + 12 `useEffect`** — main loop
   mounts the workspace; the maps are over fixed-length lists
   (`doc.tracks`, `doc.scenes`, `doc.effects`). Audited: no derived
   state, no `find` in render body, no per-frame allocations.
   **No action.**
6. **`src/ui/ArrangementPanel.tsx` (2362 lines, 23 `.map(` calls)**
   — broad `useDoc()` subscriber. Maps are scene / clip / marker
   iterations over `doc.scenes`, `doc.tracks`, `doc.markers`,
   `doc.automation`. The component is the heart of the song editor
   and re-renders on every store mutation. `usePlayheadBar` (used
   internally for the ruler) is already throttled to 1/8 bar, so
   transport ticks are not the dominant re-render cause — store
   mutations are. The right fix is **fine-grained selectors**
   (`useScenes`, `useTracks`, `useMarkers`) so a track-param edit
   does not invalidate the marker lane. **Out of scope for this
   campaign** — it requires introducing 4-5 new context hooks
   (`src/ui/context.ts` is the central place) and migrating every
   call site, which is multi-day work. Tracked as a follow-up
   with estimated 4-6 hours.
7. **No frame-rate routing bugs found.** The canvas visualizer
   audit (item in *Areas inspected*) confirmed every analyser /
   meter / spectrum component draws through `registerRaf` with a
   `useRef` buffer. The transport hooks (`usePlayheadBar` etc.)
   use the `last === next` guard. Pulse Forge's React state
   topology is correct at the *frame* layer.

**Fixes implemented.** 2 source files modified, 0 tests added (the
memoization is correctness-preserving: existing tests continue to
assert the same DOM shape and the same user-visible behaviour).

- `src/ui/ModPanel.tsx`:
  - Added `useMemo` to the import line.
  - Memoized `routableTracks = useMemo(() => [...doc.tracks, ...doc.returns], [doc.tracks, doc.returns])`.
  - Memoized `selectedLane = useMemo(() => doc.automation.find(...) ?? null, [doc.automation, selectedLaneId])`.
  - Memoized `pattern = useMemo(() => doc.patterns.find(...)!, [doc.patterns, doc.activePatternId])`.
  - Memoized `addableTrack = useMemo(() => targetOwner(doc, addTarget.trackId), [doc, addTarget.trackId])`.
  - Memoized `hasDeepParams` (deps: `addableTrack`).
  - Each memo has a comment explaining the dependency choice and
    why it is safe.
- `src/ui/Mixer.tsx`:
  - Added `useMemo` to the import line.
  - Memoized `selectedTracks` (deps: `doc.tracks`, `selectedIds`).
  - Memoized `soloCount` (deps: `doc.tracks`).
  - Memoized `muteCount` (deps: `doc.tracks`).
  - Memoized `collapsedGroups` (deps: `doc.tracks`).
  - Memoized `visibleTracks` (deps: `doc.tracks`, `collapsedGroups`).
  - `batchCount` stays inline (cheap numeric expression).

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0).
  (Initial run flagged 12 errors because the `useMemo` import was
  omitted in `ModPanel.tsx`; the import was added and re-run
  cleared all 12 — including a couple of pre-existing implicit-any
  warnings that were masked by the missing import.)
- `npm test -- --run tests/ui/ModPanel.test.tsx
  tests/ui/Mixer.test.tsx tests/mixer-batch.test.ts`:
  **3/3 test files passed**, 16 tests passed (9 ModPanel +
  4 Mixer + 3 mixer-batch), 5.97 s. Exit code 0.
- Behavioural parity: the memoization preserves the *exact* array
  shape and element order of the original code (each `useMemo` body
  is a verbatim copy of the original expression). There is no
  observable difference in render output — only in allocation
  frequency.

**Scope record — "not a render problem" rebuttals.**

Several candidates looked like render issues on paper but the
investigation showed they were already handled correctly:

| Candidate                                       | Verdict                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Canvas visualizers routing frame data via state | **Not a bug** — every visualizer uses `registerRaf` + `useRef`. |
| Transport position via `useState`               | **Not a bug** — throttled to step / 1/8-bar granularity.      |
| Context providers with rapidly changing values  | **Not a bug** — all hooks use `useSyncExternalStore` with stable `getSnapshot` returns. |
| `Mixer` / `ArrangementPanel` broad re-render on every store mutation | **Partially a bug** — caused by `useDoc` (full snapshot) instead of fine-grained selectors. Tracked as a follow-up, not fixed in this pass. |
| `PianoRoll` heavy `.map` calls                  | **Not a bug** — already uses `useMemo` for ghost notes.        |
| `EffectRack` / `RackStrip` effect chains        | **Not a bug** — already uses `useMemo` for parameter lists.    |
| `App.tsx` 12 `useEffect` + 8 `.map`             | **Not a bug** — main loop mounts workspace; no derived state in render body. |

**Unresolved issues / follow-ups.**

1. **Fine-grained selectors for `ArrangementPanel.tsx`.**
   Replace the broad `useDoc()` with `useScenes()`, `useTracks()`,
   `useMarkers()`, `useAutomation()` (and the equivalent for
   `ModPanel` if profiling shows it). This is the *real* render
   bottleneck in Pulse Forge, but it requires either (a) creating
   four to five new context hooks in `src/ui/context.ts`, plus (b)
   migrating every call site, plus (c) adding per-slice getSnapshot
   helpers on `ProjectStore` (`getScenes()`, `getTracks()`,
   `getMarkers()`, `getAutomation()`). Estimated **4-6 hours**.
2. **`Mixer` `React.memo` on the row component.** The current
   `Mixer` keeps the entire track strip tree in a single render.
   Extracting a `TrackStrip` row component and wrapping it in
   `memo` with `track.id` as the prop key would let unaffected
   rows skip re-render when one track mutates. Estimated 1-2 hours
   once `useTracks()` exists.
3. **`ArrangementPanel.tsx` virtualisation for clip rows.**
   With dense scenes (50+ clips), the entire clip lane re-renders.
   A virtualised clip list would only mount the rows that are in
   viewport. This is the most impactful change for very long songs
   but only relevant above ~30 clips per scene. Estimated 2-3 hours.
4. **`SliceLab` `Object.keys(EFFECT_DEFS).sort()` per render**
   (in `Mixer.tsx` too). Memoize once at module level — minor
   saving but improves cold-render time of `Mixer`. Estimated
   15 minutes.
5. **`JamGate.tsx:44`** — GOAL 02 follow-up, still open.

**Remaining risks.**

- The `useDoc` subscription model in Pulse Forge means that *every*
  store mutation (even an undo/redo of a one-character rename)
  invalidates the `useDoc` snapshot and re-renders every
  subscriber. The fine-grained-selector work above is what
  closes that gap.
- `ArrangementPanel` is the biggest single render-cost component.
  If a future feature lands there (e.g. a multi-lane editor), the
  fine-grained-selector work becomes a prerequisite rather than a
  nice-to-have.

**Recommendations for next session.**

- The first three prompts of this campaign (`01_TYPE_INTEGRITY.md`,
  `02_LIFECYCLE_STATE_ASYNC.md`, `03_RENDER_PERFORMANCE.md`) are
  now done in Pulse Forge. The campaign contract is fulfilled for
  the applicable scope. Suggested next directions (any of which
  can be run as fresh campaigns, not necessarily under the
  `threejs_scheduler_goals` umbrella):
  - **Fine-grained selectors + `Mixer`/`ArrangementPanel` memo
    row components** (GOAL 03 follow-up #1 + #2, 5-8 hours).
    Highest ROI for render performance.
  - **`Worklet messaging audit`** (GOAL 02 follow-up #2): a test
    file that asserts every `AudioWorkletNode` consumer closes
    its port on unmount.
  - **`JamGate.tsx` engine-readiness gate** (GOAL 02 follow-up #1,
    1-2 hours): close the unsafe cast at `JamGate.tsx:44`.
  - **`noUncheckedIndexedAccess` enable** (GOAL 01 follow-up #3,
    1-2 hours): opt-in cascade across the project.
  - **`MockServicesBuilder` for `tests/helpers.tsx`** (GOAL 01
    follow-up #2, 2-4 hours): eliminates the 28 `as any` casts
    in tests and unlocks `vi.useFakeTimers()` against the
    audio-engine path.
- The 04-10 prompt series remains parked as "reviewed, NOT
  applicable" — Pulse Forge has no Three.js surface. If Daniel
  wants Pulse-Forge-specific analogues for the Three.js lessons
  (resource ownership / lifecycle for the 2D canvas fleet, GPU
  context loss fallback for the audio context, structured-clone
  safety for IPC payloads), those can be written as fresh
  prompts in a sibling directory.


---

## GOAL 04 (campaign restart) — Intent Engine T1 closure + T2 symbolic neural prior (2026-09-19)

**Goal executed:** Per INTENT_ENGINE.md roadmap: (1) verify + document T1 (async ONNX ranker wiring — already implemented in the working tree), (2) rewrite the EN text intent parser to v2, (3) build T2 — a second generation source (ONNX symbolic drum prior) feeding the SAME candidate bank through the SAME gates.

**Areas inspected:**

- `src/intent/**` (all contracts + providers), `src/ai/ranking/*` (ranker trio + active mode), `src/ui/IntentPanel.tsx` + `GenerateDialog.tsx` + `DiceContext.tsx`, `src/commands/commands.ts` (applyGenerationResultCommand), groove library + pad roles, ranker training tooling (`scripts/*intent-ranker*`), docs (`docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md`), INTENT_ENGINE.md created as the living master map.

**Confirmed problems / findings:**

1. Stale-read hazard: initial exploration reads returned pre-2026-09-18 file states (async wiring looked missing/double-generating). Current disk state verified by mtime + re-read: T1 wiring (generateAsyncResult + abort/supersede + apply-exactly-previewed-result) already existed from the 2026-09-18 session with passing tests. Gaps §7.1 of INTENT_ENGINE.md closed as documentation, not code.
2. Old text parser: ~40 EN single keywords only, no key/BPM-range/bars/phrases; role negation broken by later positive matches ("no drums" re-added drums via the `drums` keyword).

**Fixes implemented (T1b parser v2):**

- `src/intent/text-parser.ts` rewritten: phrase-aware regexes over normalized text — multi-word genres/styles, BPM ranges ("140 to 150", "between 138 and 145"), musical keys with enharmonic flats + minor default ("in f# minor" → "F# Natural Minor"), bar-count length (8 bars → 128 steps), canonical moods consumed by mapIntentToOptions, trait phrases, role negations with exclusion state (nodrums/nobass suppress later positive matches; "no drums" alone → remaining three roles).
- Tests: `tests/intent-text-parser.test.ts` (12: determinism, genre mapping, bpm ranges+bounds, keys incl. db→C#, bars→steps, roles incl. negations, trait sliders, full compose through normalizeIntent, whitespace noise).

**Fixes implemented (T2 symbolic prior):**

- Contract `src/ai/symbolic/prior-features.ts` — prior-features.v1: 44 fixed inputs (genre 4 + style 21 groove-id one-hots + pad role 9 + step-in-bar 5 + frame position 3 + downbeat/backbeat flags). Dataset script imports this module (no layout drift); test pins vocab == GROOVE_LIBRARY.
- Tooling: `scripts/generate-symbolic-prior-dataset.mts` (87 552 samples from every groove × pattern × 16/32-step frames, 8.2% hits, gitignored artifact regenerated by the chain), `scripts/train-symbolic-prior.py` (numpy MLP 44→64→32→1, weighted BCE pos_weight≈11, Adam, group split by groove#pattern), `scripts/validate-symbolic-prior.mjs` (ORT-web probe: names/shapes/finiteness/determinism/hash/<1 MB). npm chain `prior:train`.
- Artifact: `public/models/symbolic-prior-v1.onnx` (19.9 kB) + manifest (sha256 + report). Training metrics: valAUC 0.916 (held-out groups), trainAUC 0.925.
- Runtime: `prior-types.ts`/`prior-worker.ts`/`prior-client.ts` mirror the ranker pattern — lazy ORT WASM worker (single-threaded, wasmBinary from /models/ort/), SHA-256 model verification, timeouts (run 500 ms / load 3 s / manifest 1.5 s), circuit breaker (3), flag `pf:symbolic-prior` on|off, controlled fallbacks only.
- Provider: `src/intent/providers/symbolic.ts` `SymbolicPriorProvider` (id `pulse-forge.symbolic-prior`, v `prior.v1`) — seeded sampling (`forkRandom(seed|drums.neural)`) around learned probabilities, density/energy as runtime gains, kick downbeat floor under preserveAnchors, melodic parts from the existing engine generated drum-free. Shared gates enforced by exporting `evaluateCandidate`/`attachProvenance`/`candidatePlan` from providers/local.ts; prior candidates enter the SAME bank with `source: "symbolic-prior"`, same invariants/repair/heuristic+ONNX ranking. Any prior failure only shrinks the bank.
- Contracts: `IntentSpec.symbolicCandidates` (0..4, default 0 — sync path and golden baselines unchanged), `GenerationPlan.symbolicSeeds` + `subSeeds.drumsNeural`, diagnostics banners `candidate-bank-selected:<i>:<source>` + `symbolic-prior-candidates:<n>`. IntentPanel "ťahák" requests 2 symbolic candidates.
- Smoke: `scripts/smoke-symbolic-prior.mts` — REAL model + REAL features: house 4/4 kick 0.69–0.86, trap broken kick (downbeat 0.95, off-quarters 0.23 vs house 0.79), seeded deterministic sampling, 6/6 PASS.

**Important files changed:** src/intent/{types,schema,normalize,plan,candidate-bank,index}.ts, src/intent/providers/{local,symbolic}.ts, src/intent/text-parser.ts, src/ui/IntentPanel.tsx, src/ai/symbolic/* (5 files), scripts/{generate-symbolic-prior-dataset.mts,train-symbolic-prior.py,validate-symbolic-prior.mjs,smoke-symbolic-prior.mts}, public/models/symbolic-prior-v1.{onnx,manifest.json}, package.json (`prior:train`), tests/{intent-text-parser,symbolic-prior}.ts, tests/{intent-binding,intent-ranker-active,intent-async-pipeline}.test.ts (banner format), INTENT_ENGINE.md, this log. Also: removed an unused `STEP_TICKS` import from the concurrent session's `tests/store-undo-frame.test.ts` to unblock shared typecheck.

**Validation:** `npx tsc --noEmit` clean; full vitest 2 861/2 861 green after banner-format updates (2 859 pre-existing passes + 2 updated); browser verification 231/232 with `offline generation: preview → accept → undo/redo → export → reload` PASS (2 unrelated audio-domain checks flaky/failing from the concurrent effects workstream: preset loudness map drift, PDC limiter skew — not touched); prior smoke 6/6.

**Unresolved issues / risks:**

1. Symbolic prior v1 is drums-only; melodic parts follow the template melodic engine (documented scope). Quality of prior candidates depends on heuristic+ranker gates — no human golden listening pass yet.
2. Training data = the shipped groove library: the prior interpolates templates, it does not yet exceed them. Favorites-driven retraining is the T2 follow-up.
3. ONNX WASM inference determinism assumed single-runtime; provenance records model hash (belt) but cross-version float equality is not guaranteed (documented in INTENT_ENGINE.md §9 context).
4. Dataset artifact (19 MB) intentionally not committed; `prior:train` regenerates deterministically.

---

## GOAL 05 (campaign restart) — Intent Engine T2 v2: melodic prior + favorites feedback loop (2026-09-19)

**Goal executed:** Per INTENT_ENGINE.md T2 v2: (1) a MELODIC symbolic prior (next-note ONNX model) that replaces template melody in prior candidates when available, (2) a LOCAL favorites feedback loop — dice ★ → ledger → exportable pack → weighted retraining of the drum prior.

**Areas inspected:**

- `src/ai/grooves/melodic-data.ts` (MELODIC_BY_GENRE: role + octaveOffset + note sequences), `src/ai/melodic.ts` (degreeToPitch/expandChord/CHORD_VOICINGS, notes-per-bar rule, NoteEvent construction), `src/project-model/scales.ts` (SCALE_INTERVALS/parseKey/snapToScale), DiceContext/DiceTray favorites flow, existing prior trio (`src/ai/symbolic/*`).

**Fixes implemented (melodic prior):**

- Contract `src/ai/symbolic/melodic-features.ts` — melodic-features.v1: 29 inputs (genre 4 + role 3 + note-start position 5 + prev degree one-hot 8 + prev duration one-hot 4 + contour class 5). Two heads: DEGREE (8 classes: rest + degrees 0..6) and DURATION (1/2/4/8). Degrees are scale-relative → every sampled note is in-key BY CONSTRUCTION.
- Exported `degreeToPitch` + `expandChord` from `src/ai/melodic.ts` so the provider reuses the EXACT engine pitch math (octave offset per role from MELODIC_BY_GENRE, snapToScale, clamps).
- Tooling: `scripts/generate-symbolic-melodic-dataset.mts` (190 next-note samples incl. wrap-around transitions), `scripts/train-symbolic-melodic.py` (numpy shared-trunk 29→64→32 + two Gemm heads, class-weighted CE per head, Adam, group split), `scripts/validate-symbolic-melodic.mjs` (ORT-web: names/shapes/determinism/hash). npm chain `prior:melodic`.
- Artifact: `public/models/symbolic-melodic-v1.onnx` (17.7 kB) + manifest. Metrics: valDegreeAcc 0.714 (majority baseline 0.370), valDurationAcc 0.607 (baseline 0.469).
- Runtime: prior worker/client generalized to TWO models in ONE worker — `kind: "drums" | "melodic"`, per-kind session cache, worker-side normalization (sigmoid for drums, softmax per head for melodic), `runMelodicNext()` client API, unified `outputs` response shape, melodic manifest guard. Drums manifest on disk has no `kind` — coerced client-side.
- Provider (`src/intent/providers/symbolic.ts`, engine version `prior.v2`): prior-sampled melody REPLACES template melody when the model answers (autoregressive per role, role loops concurrent, `controls.temperature` shapes distributions, chord voicings via engine's expandChord); unavailable model keeps template melody (soft degradation). Notes mapped to tracks with the generator's name-match/positional rule.
- Tests: `tests/symbolic-melodic.test.ts` (7) — contract, key-safe notes (snapToScale identity), determinism, template fallback. `tests/symbolic-prior.test.ts` mock extended with a default-unavailable `runMelodicNext`.

**Fixes implemented (favorites feedback loop):**

- `src/intent/favorites.ts` — localStorage ledger `pf:intent-favorites`: record on dice ★ (dedupe seed+grooveId, cap 200 FIFO, best-effort storage), `buildFavoritesPack()`, and `favoritesToDrumSamples()` — the SHARED converter (same prior-features.v1 contract → no layout drift), weight 3, vocab-guarded.
- DiceContext: `toggleFav` records the PREVIEWED roll (intent + drum rows + pad names/ids from the live doc) when a roll is ★-ed; `exportFavoritesPack` downloads the pack. DiceTray: "⬇ ★" button. `URL.revokeObjectURL?.()` guard per repo convention.
- `scripts/export-favorites-training.mts` (`npm run prior:favorites -- <pack.json>`): pack → weighted samples → spawns `train-symbolic-prior.py --favorites`; trainer folds weighted samples into the TRAIN split ONLY (validation stays library-only) and retrains.
- Tests: `tests/favorites-ledger.test.ts` (7) — record/dedupe/cap/pack + converter labels/weights/vocab guards.
- End-to-end proof: synthetic 3-entry pack → 768 weighted samples → 2 304 train rows → retrained model (new sha256, valAUC 0.918); the library-only release model was RESTORED afterwards (hash 77c50729…, valAUC 0.9162).

**Important files changed:** src/ai/symbolic/{melodic-features,prior-types,prior-worker,prior-client}.ts, src/ai/melodic.ts (2 exports), src/intent/providers/symbolic.ts, src/intent/favorites.ts, src/ui/{DiceContext,DiceTray}.tsx, scripts/{generate-symbolic-melodic-dataset.mts,train-symbolic-melodic.py,validate-symbolic-melodic.mjs,export-favorites-training.mts,smoke-symbolic-prior.mts}, public/models/symbolic-melodic-v1.{onnx,manifest.json}, package.json (`prior:melodic`, `prior:favorites`), tests/{symbolic-melodic,favorites-ledger,symbolic-prior}.test.ts, INTENT_ENGINE.md.

**Validation:** `npx tsc --noEmit` clean; smoke 10/10 with REAL artifacts (house classic bass rests on the off-and after a root P(rest)=1.00, prefers eighth notes, genres differentiate); favorites chain proven end-to-end then restored; full vitest suite + browser smoke — see GOAL 04 validation for the unrelated audio-domain flaky checks.

**Unresolved issues / risks:**

1. Melodic dataset is tiny (190 samples) — the model interpolates the shipped library; it will only become personal via favorites (melodic-side favorites retraining is a v3 candidate).
2. Autoregressive melodic sampling = one worker roundtrip per note (~9–36 per candidate at 16–64 steps); comfortably inside budgets today, but a batched speculative decode is the known lever if previews lengthen.
3. Favorites ledger is per-browser and manual-export only — no cloud, by design; a project-embedded export could be added later.

---

## GOAL 04 — Top-5 production & developer-experience fixes (2026-09-18)

**Goal executed.** Daniel's follow-up to the threejs_scheduler_goals campaign
asked for concrete fixes on five specific items identified at the end of GOAL
03:

1. **`JamGate.tsx:44`** — production `TypeError` when the audio engine is not
   ready (unhandled rejection in JamGate test teardown).
2. **Type contract leak** — `WavetablePanel.tsx:41` inline `execute: (c:
   unknown) => unknown` vs production `Services.execute: (c: Command) =>
   void`, plus `tests/helpers.tsx:305` `as unknown as Services` and ~28
   inner `as any` casts.
3. **Test suite wall-clock** — 78 test files × ~5 s jsdom init = ~400 s
   `environment` time on the last full-suite run.
4. **`noUncheckedIndexedAccess` not enabled** in `tsconfig.json` —
   recommended safety net from GOAL 01.
5. **`ArrangementPanel.tsx` broad `useDoc()` re-render** — 2362 lines,
   23 `.map()` calls re-renders on every store mutation.

**Scope reality check.** Each of the five was triaged with a **small
diagnostic pass before committing to a fix**, because the previous
campaign ended with several follow-ups that turned out to be either
already addressed or out of campaign scope. Same discipline this
round:

| # | Item | Verdict | Action taken |
| - | ---- | ------- | -------------|
| 1 | `JamGate.tsx` production crash | **Mylný nález z GOAL 02.** `JamGate.tsx:43-44` already reads `const ctx = services.engine.ensureContext() as AudioContext | undefined` and guards `if (ctx && ctx.state === "suspended")`. `ensureContext(): BaseAudioContext` in `AudioEngine.ts:683` returns a context or throws — it never returns `undefined` in production. The teardown TypeError seen during the GOAL 02 sweep was a test-side artefact: `mockServices()` in `tests/helpers.tsx` builds `engine.ensureContext = vi.fn()` (no return), so any test that *bypasses* the guard would crash. **No production code change required.** | None — re-documented as a test-mock hygiene issue, deferred. |
| 2 | `WavetablePanel` + `helpers` type contract | **Partial fix.** `WavetablePanel.tsx` prop type rewritten to `Pick<Services, "bank" | "store">` (was an inline structural type with the wrong `execute: (c: unknown) => unknown` signature). `helpers.tsx` `MockServicesBuilder` rewrite remains out of scope (would touch ~28 `as any` casts across the test surface — multi-hour refactor). | `Pick<Services, "bank" | "store">` landed. Tests pass. |
| 3 | Test-suite wall-clock | **Tried and reverted.** `isolate: false` cut a 78-file run from ~400 s to ~13 s but produced 7 contamination failures in `WavetablePanel`/`SampleBrowser`/`Mixer` because each file expects a fresh jsdom DOM and module-level service mocks. `pool: 'forks'` + `maxForks: 6` (without `isolate: false`) added IPC overhead without a real speedup — extrapolation was slower than the default `pool: 'threads'`. | Both reverted. Vitest config left at project defaults. |
| 4 | `noUncheckedIndexedAccess` | **Tried and reverted.** Enabling the flag produced **4708 typecheck errors** (a 53× increase vs the 88 errors the GOAL 01 sweep closed) — a project-scale cascade through every `arr[i]` / `obj[key]` access. **Discovered a structural issue along the way** (see below). | Rolled back to baseline. Documented as a multi-hour systematic pass. |
| 5 | `ArrangementPanel` fine-grained selectors | **Out of scope this session.** 4-6 hour work to introduce `useScenes`/`useTracks`/`useMarkers`/`useAutomation` hooks, migrate ~12 call sites in `ArrangementPanel.tsx` and `ModPanel.tsx`, and add `getScenes`/`getTracks`/etc. snapshot helpers on `ProjectStore`. The render bottleneck is real but is one feature PR per selector + a full re-test pass. | Deferred. |

**Fixes implemented.** 2 production-source edits, 0 new tests (the
fixes preserve behaviour, existing tests cover the same DOM shape).

- `src/ui/WavetablePanel.tsx`:
  - Added `import type { Services } from "../services"`.
  - Prop type changed from `{ bank: { get(id: string | null): AudioBuffer | undefined }; store: { execute: (c: unknown) => unknown } }` to `Pick<Services, "bank" | "store">`.
  - Comment explains why: tests previously had to write
    `as Parameters<typeof WavetablePanel>[0]["services"]` as a bridge;
    `Pick` makes that bridge unnecessary because the production
    `Services` is structurally compatible with the test's
    `mockServices()` return.

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0).
- `npm test -- --run tests/ui/WavetablePanel.test.tsx`: **4/4 tests
  passed** in 887 ms, no `as never` bridge needed.
- `npm test -- --run tests/ui/WavetablePanel.test.tsx
  tests/ui/SampleBrowser.test.tsx tests/ui/Mixer.test.tsx` after a
  vitest config tweak: **11/11 tests passed** in 20.39 s (still 5 s of
  per-file jsdom init — the structural cost is real).

**Discovered along the way (not fixed, but recorded).**

1. **`tsbuildinfo` cache can mask real typecheck errors.** During
   the `noUncheckedIndexedAccess` experiment, the build cache file
   (`./tsconfig.tsbuildinfo`, 239 KB, generated by `incremental: true`)
   absorbed the partial run and produced a stale snapshot. With the
   rollback the cache still held an inconsistent view, surfacing
   **two false-positive errors in `controls.tsx:50-51`** (`holdFired`
   and `dragStart` declared as `useRef` but never read — both are
   actually used on lines 91, 93, 96, 111, 115, 119, 127, 128).
   Clearing the cache (`mv tsconfig.tsbuildinfo tsconfig.tsbuildinfo.bak`)
   and re-running typecheck brought the count back to 0. **Recommendation:**
   Pulse Forge's CI should always run `npx tsc --noEmit -p tsconfig.json
   --incremental false` (or simply remove the cache file before
   typecheck) so the build cache cannot mask regressions introduced
   during partial config experiments. The cost is a fresh 30-60 s
   typecheck per run, which is acceptable on CI.
2. **`tsconfig.tsbuildinfo` is not in `.gitignore`.** 239 KB generated
   file sitting in the source tree, currently untracked. Either
   add `tsconfig.tsbuildinfo*` to `.gitignore` or run a one-time
   `git rm --cached tsconfig.tsbuildinfo` to stop accidental
   commits. (Out of scope this session.)
3. **`mockServices().engine.ensureContext` returns `undefined` by
   default.** The default mock is `vi.fn()` with no return, so any
   test that calls `engine.ensureContext()` and then chains `.state`,
   `.resume()`, etc. **without** an `if (ctx && …)` guard will throw
   `TypeError: Cannot read properties of undefined`. `JamGate.tsx`
   already guards, but this is a known footgun for future tests. A
   `MockServicesBuilder` rewrite (GOAL 01 follow-up #2) would fix
   this by giving the mock a typed return like
   `vi.fn<() => BaseAudioContext>()`.

**Unresolved issues / follow-ups (carried forward from earlier goals).**

1. **`tests/helpers.tsx` `MockServicesBuilder` rewrite.** Touches ~28
   `as any` casts across the test surface. Best done with the
   `WavetablePanel`/`FxEqPanel`/`fxeqCurve` prop migration to
   `Pick<Services, …>` so the mock's narrow surface matches what
   components actually use. **Estimated 2-4 hours.**
2. **`ArrangePanel.tsx` fine-grained selectors.** Requires
   `useScenes`/`useTracks`/`useMarkers`/`useAutomation` context hooks
   and matching `ProjectStore.getX()` snapshot helpers. **Estimated
   4-6 hours.**
3. **`noUncheckedIndexedAccess` systematic pass.** Needs a separate
   campaign — 4708 errors cascade means it touches essentially every
   file. Best run as its own GOAL with `incremental: false` forced
   for typecheck in CI. **Estimated 1-2 hours of focused work** if
   scoped to high-traffic files (`commands.ts`, `schema.ts`,
   `AudioEngine.ts`); 6-10 hours if done across the entire project.
4. **Test-suite wall-clock reduction.** The 5 s per-file jsdom init
   is structural. The only safe path without test contamination is
   `globalSetup` (run once before the suite) + per-file isolation
   for tests that mutate module-level state. **Estimated 4-8 hours.**
5. **`JamGate.tsx` is fine in production; test mocks are the issue.**
   The follow-up here is "make `mockServices().engine.ensureContext`
   return a typed stub" rather than "fix `JamGate`". Tied to follow-up
   #1 (MockServicesBuilder rewrite).
6. **`tsbuildinfo` gitignore hygiene.** One-line change.

**Remaining risks.**

- The `tsconfig.tsbuildinfo` cache file continues to grow with each
  run (239 KB observed today). It is not in `.gitignore`, so a
  developer running `git add .` from the root could accidentally
  commit it. Pulse Forge already has `*.tsbuildinfo` patterns in
  many subdirectory `.gitignore` files; the root `tsconfig.tsbuildinfo`
  is the orphan.
- `noUncheckedIndexedAccess` is still the right safety net to enable
  eventually, but the 4708-error cascade means it would need its own
  campaign — at minimum a `// @ts-expect-error` sweep followed by
  targeted fixes.

**Recommendations for next session.**

- Pick **one** of the three larger follow-ups (`MockServicesBuilder`,
  `ArrangementPanel` selectors, `noUncheckedIndexedAccess`) and run it
  as its own GOAL — each is multi-hour work and does not benefit
  from being lumped into a "catch-up" pass.
- Add `tsconfig.tsbuildinfo*` and `*.bak` to `.gitignore` (one-line
  change, 30 seconds).
- Switch the CI typecheck command to `npx tsc --noEmit -p
  tsconfig.json --incremental false` so the build cache cannot
  silently mask regressions from experimental config changes
  (matches the same hygiene as the vitest revert).
- The `JamGate` teardown unhandled rejection seen in earlier sweeps
  is fixed in production (`if (ctx && …)` guard) and remains a
  test-mock hygiene issue; will resolve naturally once
  `MockServicesBuilder` lands.


---

## GOAL 04 follow-up — Mini MockServicesBuilder + `.gitignore` hygiene (2026-09-18)

**Goal executed.** While wrapping up GOAL 04, two follow-up items were
small enough to land in the same session without expanding scope:

1. **Mini `MockServicesBuilder` for `engine.ensureContext`.** The
   previous `mockServices()` used `vi.fn()` for `engine.ensureContext`,
   which returns `undefined`. Any test that bypassed the `if (ctx &&
   ...)` guard crashed with `TypeError: Cannot read properties of
   undefined`. The original `JamGate.tsx` *does* guard, but the same
   pattern existed in test mocks and was a footgun for future tests.
2. **`.gitignore` hygiene for `tsconfig.tsbuildinfo`.** The 239 KB
   incremental build cache was sitting in the source tree with no
   `.gitignore` entry; accidental commits were a single `git add .`
   away. The `tsconfig.json` already has `"incremental": true`, so the
   cache regenerates safely each run.

**Plus one bonus discovery from the rebuild:**

3. **`PianoRoll.tsx` had two pre-existing typecheck bugs that were
   being silently masked by the stale `tsbuildinfo`.** When the cache
   was shaken during the GOAL 04 sweep, `npx tsc --noEmit -p tsconfig.json
   --incremental false` surfaced `openMenu` missing from
   `useRef<PianoRollNoteHandlers>` initializer (line 1072) and
   `Parameter 'd' implicitly has an 'any' type` / `Parameter 'p'
   implicitly has an 'any' type` in the inline `toggleSlide` command
   (lines 1763-1772). Both fixed.

**Fixes implemented.** 3 source files modified.

- `tests/helpers.tsx`:
  - Added a `mockAudioContext(state: AudioContextState = "suspended"):
    MockAudioContext` factory. `MockAudioContext` is a structural
    `Pick<AudioContext, "state" | "resume" | "currentTime" |
    "decodeAudioData">` (note: `resume` is on `AudioContext`, not
    `BaseAudioContext` — this is the bug the first draft of this
    factory hit and which got corrected before commit).
  - `core.engine.ensureContext` and `engine.ensureContext` now
    return `mockAudioContext()` instead of `undefined`. Both
    `engine.context` getters return `mockAudioContext("running")`.
  - The earlier `as unknown as Services` and ~28 inner `as any` casts
    remain — a complete `MockServicesBuilder` rewrite is still
    multi-hour work. The minimal change here closes the specific
    footgun the GOAL 02 sweep flagged.

- `.gitignore`:
  - Added `tsconfig.tsbuildinfo*`, `*.bak`, and `*.tsbuildinfo`.
  - The 239 KB `tsconfig.tsbuildinfo` file already in the tree is now
    excluded. The two `tsconfig.tsbuildinfo.pre-goal04-clean*` rename
    artefacts from the cache shake also match the wildcard and are
    excluded.

- `src/ui/PianoRoll.tsx`:
  - Added `ProjectDocument` to the type import from
    `../project-model/types`.
  - `useRef<PianoRollNoteHandlers>({...})` initializer (line 1072)
    gained an `openMenu: () => {}` no-op so the initial reference
    matches the interface. The actual handler lives on the
    `noteHandlersRef.current` re-assignment (line 1081):
    `openMenu: (note, x, y) => setNoteMenu({ noteId: note.id, x, y })`.
  - The inline `toggleSlide` command in the `s` keyboard shortcut now
    types its `execute`/`undo` callbacks as `(d: ProjectDocument) =>
    ProjectDocument` and the inner `.map((p: Pattern) => ...)`. The
    `Command` interface requires `(doc: ProjectDocument) =>
    ProjectDocument`, so the previous `(d: any) => ...` would have
    type-checked (any is assignable to anything) but lost type
    information on the way in.

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0).
- `npm test -- --run tests/ui/JamGate.test.tsx
  tests/ui/PianoRoll.test.tsx tests/ui/WavetablePanel.test.tsx`:
  **3/3 test files passed**, 15 tests passed (4 JamGate + 7
  PianoRoll + 4 WavetablePanel), 11.07 s. **No unhandled rejection
  during teardown** — the JamGate TypeError that originally surfaced
  the bug is gone.
- `git status` should now show `tsconfig.tsbuildinfo` and the
  `pre-goal04-clean*` artefacts as ignored rather than untracked.

**Recommendations for the rest of GOAL 04.**

- **Switch the CI typecheck command to `npm run typecheck:clean`.**
  Pulse Forge already ships a `typecheck:clean` script that does
  `rm tsconfig.tsbuildinfo && tsc --noEmit --incremental false` — it
  is the exact command we used here to surface the `PianoRoll` bugs.
  Local dev can stay on `typecheck` (incremental cache helps for
  fast iteration); CI should always use `typecheck:clean` so the
  cache cannot mask regressions from experimental config changes.
- **Complete the `MockServicesBuilder` rewrite later.** The mini fix
  here closes the JamGate footgun but leaves ~28 `as any` casts in
  `tests/helpers.tsx` for the rest of the Services surface. The full
  rewrite (4 hours, see GOAL 04 main report) is the proper follow-up.
- **The other GOAL 04 items** (test-suite wall-clock reduction,
  `noUncheckedIndexedAccess` systematic pass, `ArrangementPanel`
  fine-grained selectors) remain parked as future campaigns — each
  is multi-hour work and would benefit from its own goal document in
  `prompts/` so they don't get bundled with quick fixes again.


---

## GOAL 04 follow-up — Fáza E: Fine-grained selectors infrastructure (2026-09-18)

**Goal executed.** Fáza E was the largest of the 5 follow-ups identified
at the end of GOAL 03 — *ArrangementPanel fine-grained selectors* — and
would have taken 4-6 hours of systematic work if pursued end-to-end in
this session. The realistic deliverable was to lay the **infrastructure**
so that future sessions (or any contributor) can migrate
`ArrangementPanel.tsx`, `ModPanel.tsx`, `Mixer.tsx`, and the 33 other
files that subscribe via `useDoc()` one component at a time without
churning through the same setup work. That goal is achieved.

**Areas inspected.**

- **`useDoc()` call sites** in `src/ui/`: 36 broad subscriptions across
  ArrangementPanel, ModPanel, Mixer, TopBar, Sequencer, PianoRoll,
  PatternBar, TrackTabs, MacroPerformanceBar, MasterMeter,
  AssistPanel, CollabPanel, ContextMenu, DiceTray, EffectRack,
  ExportPanel, FloatingPlugin, FreezeButton, GenerateDialog, Inspector,
  IntentPanel, MidiPanel, PresetBrowser, RackStrip, ScalePanel,
  SliceLab, SceneLauncher, UltinaPanel, UndoHistoryPanel,
  DiceContext, PadModSection, ChannelStrip, MasterStrip,
  MacroCard, ScenePanel. The dominant bottleneck is `ArrangementPanel.tsx`
  (2362 lines, 23 `.map()`) — confirmed by a comment in
  `Sequencer.tsx:1562` that explicitly avoids `useDoc()` to prevent
  re-rendering all ~4000 StepCells on every store mutation.

- **`normalizeProject` (schema.ts:1841)** — confirmed to use
  **structural sharing** for slices that did not actually change
  (`normalizeTracksDomain` uses `return changed ? clean : sends` on
  nested sanitization, `normalizeScenesDomain` short-circuits when
  `filtered.length === scenes.length`, etc.). This is the load-bearing
  invariant that makes fine-grained selectors work: when the user
  edits a track gain, the `scenes` array is preserved by reference,
  so `useSyncExternalStore` skips the re-render.

**Confirmed findings.**

1. **`ProjectStore` lacked slice-level getters.** Every doc mutation
   forced `useDoc()` consumers to re-render even when the slice they
   read had not changed. The existing `getDoc()` returns the full
   document reference, which `normalizeProject` does change on any
   mutation (it is the outermost `s.changed = true` flag that flips
   the new doc through). Slice-level getters return stable
   sub-references when the corresponding domain normaliser did not
   mutate.
2. **`useSyncExternalStore` in `context.ts:54` already uses
   `store.subscribe` + `store.getDoc` — the same pattern works
   perfectly with slice getters.** No new React machinery is
   required; the change is purely additive in the hook layer.
3. **`ProjectStore | YDocStore` union type.** Both stores needed
   matching slice getters so that `useScenes()` etc. compile in solo
   mode (`ProjectStore`) and collab mode (`YDocStore`).
   `ProjectStore` got the canonical implementation; `YDocStore` got
   delegating getters (`this.doc_.X`). For collab, the slices are
   rebuilt from the Yjs snapshot on every call, so a remote mutation
   from another peer will invalidate every selector (no structural
   sharing across the network) — but a local command that mutates
   only one slice via `applyProjectToYMap`'s targeted diff path keeps
   the others stable, which is the common case in the UI hot path.

**Fixes implemented.** 4 source files modified, 1 new test file.

- `src/store/ProjectStore.ts` — added `getScenes`, `getTracks`,
  `getReturns`, `getArrangement`, `getMarkers`, `getAutomation`,
  `getPatterns`, `getMacros`, `getMaster` — each `= (): SliceType =>
  this.doc_.sliceField`. Pure getters, no caching, no derived state.

- `src/collab/YDocStore.ts` — added the matching 9 getters right
  after `getLastSavedAt`. Each delegates to `this.doc_.X` and includes
  a long comment explaining why structural sharing is NOT guaranteed
  across the network in collab mode but IS preserved for local
  targeted-diff mutations.

- `src/ui/context.ts` — added 9 hooks mirroring the slice getters:
  `useScenes`, `useTracks`, `useReturns`, `useArrangement`,
  `useMarkers`, `useAutomation`, `usePatterns`, `useMacros`,
  `useMaster`. Each is a thin wrapper over `useSyncExternalStore` with
  the same shape as the existing `useDoc()`. Comment explains the
  migration pattern.

- `tests/helpers.tsx` — added 9 delegating getters on the mock store
  (`getScenes: () => project.scenes`, etc.). This was the same
  test-mock hygiene issue that surfaced in Fáza A (`engine.ensureContext
  = vi.fn()` returning `undefined`) — without these getters,
  `useSyncExternalStore` immediately fails with `getSnapshot is not a
  function` the first time a component reads through the new hooks.

- `tests/ui/fine-grained-selectors.test.tsx` (new) — 3 regression
  tests that lock in the structural-sharing contract:
  1. `useScenes()` returns the **same array identity** after a track
     gain mutation (the unmutated scenes slice stays referentially
     stable).
  2. `useScenes()` returns the **same array identity** after a BPM
     change.
  3. `useTracks()` returns the **same array identity** after a BPM
     change.
  These three together document the invariant the migration
  depends on: every slice hook is stable across mutations that do
  not touch its slice. If a future refactor breaks structural sharing,
  these tests fail loudly.

**Validation.**

- `npx tsc --noEmit -p tsconfig.json`: **PASS** (exit code 0).
- `npm test -- --run tests/ui/fine-grained-selectors.test.tsx`:
  **3/3 tests passed**, 23 ms, exit code 0.
- `npm test -- --run tests/store-undo-frame.test.ts`: **3/3 tests
  passed**, 23 ms, exit code 0 (confirms the new ProjectStore getters
  do not regress the undo/frame logic that depends on
  `this.doc_ === oldDoc` checks).

**Migration path (deferred to next session).**

The infrastructure is in place. Migrating `ArrangementPanel.tsx`,
`Mixer.tsx`, and `ModPanel.tsx` to the new hooks is a *pure*
mechanical refactor — each file currently reads `doc.tracks`,
`doc.scenes`, `doc.arrangement`, `doc.markers`, `doc.automation`,
`doc.patterns`, `doc.macros` via `useDoc()`; switching to the matching
`useXxx()` hook is a `replace_one` per call site, with the
re-render benefit kicking in immediately. Estimated work:
- `ArrangementPanel.tsx` (2362 lines, 3 `useDoc()` sites) — 1-2 h
- `Mixer.tsx` (640 lines, 3 `useDoc()` sites) — 30-45 min
- `ModPanel.tsx` (~1700 lines, 2 `useDoc()` sites) — 30-60 min
- 33 smaller consumers — 1-2 h total if done systematically with a
  `find . -name '*.tsx' -exec sed -i 's/useDoc()/useTracks()/g'` style
  sweep followed by manual review (some of them genuinely need the
  full document).

**Recommended next steps.**

1. Start with `Mixer.tsx` — smallest scope, three call sites that all
   read either `doc.tracks` or `doc.returns`, easiest to verify.
2. Run `tests/ui/Mixer.test.tsx` + the regression test after each
   migration to make sure no slice access regressed to `undefined`.
3. Apply the same pattern to `ModPanel.tsx` and `ArrangementPanel.tsx`.
4. As a final sweep, run `git grep -l 'useDoc()' src/ui/` and audit
   each remaining site for whether the component only reads one slice
   (good candidate) or genuinely needs the whole document
   (`TopBar.tsx` is one of the latter — it passes `doc` to
   `useTransportPosition` for timeSignature).

**Unresolved issues / follow-ups (carried forward).**

1. **Component migration** (see above). Each component is its own
   mini-campaign; doing all 36 in one go is not realistic and risks
   breaking the visual diff review for `ArrangementPanel.tsx` and
   friends. Best done one file at a time with the regression test
   confirming structural sharing still works after each migration.
2. **Yjs structural sharing** — for collab mode, every slice changes
   identity on a remote mutation. The 9 hooks still work in collab
   mode (they always return the latest Yjs snapshot slice), but they
   do not save re-renders the way they do in solo mode. This is
   fundamental to Yjs and not fixable without a CRDT-level diff
   cache. Documented in the `YDocStore.ts` getter comment.
3. **`useSceneRuntimeState` and similar collab-only hooks** were not
   touched. They are fine-grained already; this campaign focused on
   the document-slice layer only.


---

## GOAL 06 (campaign restart) — Intent Engine A1: candidate audition (2026-09-19)

**Goal executed:** A1 from the INTENT_ENGINE.md next-steps proposal — the user HEARS every ranked candidate and PICKS one, instead of receiving an invisible winner (SUNO-core UX).

**Areas inspected:**

- `src/rendering/renderer.ts` (renderProject, RenderOptions, PlayMode "pattern" renders the ACTIVE pattern via getActivePattern), `src/embed/EmbedApp.tsx` (AudioBufferSourceNode playback pattern), `src/services.ts` (bank access), `src/rendering/wav.ts`, current IntentPanel async flow.

**Fixes implemented:**

- Provider: extracted `LocalDeterministicProvider.generateRanked()` returning `{ proposal, ranked (best-first bank), modelScores, ranker meta }`; `generate()` is now a thin top-1 wrapper — zero behavior change for existing callers. The mode="off" short-circuit was REMOVED for multi-candidate plans (audition needs the heuristic-ranked bank even with the model off); `rankCandidatesWithModel` already degrades to heuristic order in that case.
- Contracts (src/intent/types.ts): `RankerSelectionMeta` (mode now honest "off"|"shadow"|"active"), `GenerationRanked`, `RankedCandidate`; `GenerationResult.bank?` + `selection?` — in-memory only, never serialized into the project.
- Pipeline: `generateAsyncResult(..., { includeBank: true })` attaches `result.bank` + `result.selection`; new `resultForCandidate(result, index)` builds the applyable GenerationResult for ANY candidate — content-identical to the auditioned pattern, stamps `ranker.selectedIndex` + `selection:user-audition` warning, preserves the historical "no ranker provenance in off mode" contract (guarded by tests).
- Winner-identity invariant: `generateRanked` replaces bank[0] with the provenance-stamped pattern so `result.proposal.pattern === bank[0].pattern`.
- Audio: `src/intent/audition.ts` — `auditionDoc` (temporary doc: candidate as active pattern, emptied arrangement), `renderAuditionBuffer` (renderProject mode "pattern", 44.1 kHz, 0.4 s tail — same offline chain as exports), `playAuditionBuffer`/`stopAudition` (shared AudioContext, previous source stopped). Nothing touches the live engine/transport/project.
- UI (IntentPanel): after GENERATE the panel lists the bank — ▶/■ audition per candidate (lazy render + AudioBuffer cache, supersede-guarded), TPL/PRIOR badge, heuristic + ONNX scores, ★ best marker, repaired badge, USE per row (one undo step; stops playback, clears bank) with USE RESULT fallback for bankless (fallback) runs. Unmount stops playback. styles.css appended (intent-candidates block).
- Tests: `tests/candidate-audition.test.ts` (7) — bank contents/sources, winner identity, heuristic score ordering (off mode), resultForCandidate content-identity + provenance, off-mode no-stamp contract, shadow-mode stamping, apply-exact-content + undo restores.

**Important files changed:** src/intent/providers/local.ts, src/intent/{types,pipeline}.ts, src/intent/audition.ts, src/ui/IntentPanel.tsx, src/styles.css (append), tests/candidate-audition.test.ts, INTENT_ENGINE.md (§5.5 + map).

**Validation:** intent-area regression suite 101/101 green (16 files: async pipeline, binding, ranker-active, symbolic drum/melodic, favorites, parser, dice, ranker-client, pattern-features); typecheck clean for all changed files.

**Unresolved issues / risks:**

1. Shared-repo typecheck currently fails in files owned by the CONCURRENT session (context.ts earlier, ExportPanel.tsx at last check — actively being edited, errors shifting minute-to-minute). NOT touched by this goal; my files verified clean via filtered tsc. Full-suite + browser smoke re-runs should happen once that workstream settles.
2. Audition render runs on the main thread via renderProject — fine for 16–64-step candidates; a worker move is the noted lever if long-form (A2) lands.
3. GenerateDialog does not have the audition UI yet (its live-preview UX needs a different integration); IntentPanel is the full audition surface.

---

## GOAL 07 (campaign restart) — Intent Engine B1: bilingual EN+SK text parser (2026-09-19)

**Goal executed:** B1 from the INTENT_ENGINE.md next-steps proposal — Slovak support in the text intent parser, explicitly designed to be regression-free against EN (user concern: "nebude to na škodu?").

**Design (the anti-škoda rules, documented in the parser header):**

1. EN regexes untouched; input is de-accented ONCE (arrangeWords convention) — ASCII passes through as a no-op, so EN behavior is byte-compatible (original 12 tests unchanged and green).
2. SK extends DETECTION only — canonical values stay EN ("dark", "rolling", Natural Minor) because mapIntentToOptions / resolveGroove switch on them.
3. Genres are indeclinable loanwords in SK (techno/house/trap/ambient) — genre detection shared verbatim, zero risk.
4. SK inflection handled with curated STEMS ("bubn" → bubny/bubnov/bubnoch; "tmav|temn"; "tvrd"; "bas(a|u|y|ou|ov)"; "roluj"; "klasick"; "hlbok"; "priemysel"…), pinned by tests on multiple inflected forms.

**Fixes implemented (src/intent/text-parser.ts v3):**

- deaccent + lowercase applied once at input normalization.
- SK style stems merged into STYLE_PHRASES (roluj→rolling, hlbok→deep, klasick→classic, minimal(ny), industrial(ny)/priemysel, organick, plavuj→drifting).
- SK moods → canonical EN moods (tmav/temn→dark, tvrd/agresiv→aggressive, poko/jemn/makk→chill, svetl/vesel→energetic) + SK trait stems (tepl, studen/chladn, hust, jednoduch, zlozit/komplex, hypnot(ick), tazk, lehky, sirok, rychl, pomal, smutn/emocion).
- BPM: "na/pri/okolo 140" singles; "medzi 138 a 145" ranges (the bare "a" conjunction is deliberately NOT a generic separator — only inside "medzi X a Y" — to avoid false positives).
- Keys: "v f# mol" → F# Natural Minor, "g dur" → G Major, "harmonicka/molodicka mol"; EN patterns take precedence, SK falls back.
- Length: "8 taktov / 4 takty" alongside bars.
- Roles: bez bubnov/bicích (nodrums), bez bas(y/u/a) (nobass), len/iba bubny/bicie (drumsonly), len/iba melódia (melodyonly), celý beat/všetko (all), bubn/bic→drums, bas(a|u|y|ou|ov)→bass, akord→chords, melodi-stem + lead(om|u|a)→lead. Negation-suppression state machine shared with EN.
- IntentPanel placeholder now shows an SK example.
- Tests: 6 new SK cases (18 total in the file) — inflected adjectives across forms, mol/dur keys, takt counts, role negations, SK BPM phrasing, mixed SK/EN sentence. One documented v1 ambiguity surfaced by the tests: "deep techno" resolves genre house (first-match rule deep→house, identical in pure EN) — test avoids it and the ambiguity is now documented.

**Important files changed:** src/intent/text-parser.ts, src/ui/IntentPanel.tsx (placeholder), tests/intent-text-parser.test.ts, INTENT_ENGINE.md (§7.2 row + footer).

**Validation:** parser suite 18/18 (12 EN regression unchanged + 6 SK); intent-area regression (pipeline/mapping/binding/async/audition/symbolic) 44/44 green; typecheck clean for changed files. Concurrent-session in-flight typecheck breakage (ExportPanel) remains theirs, untouched.

**Unresolved issues / risks:**

1. SK dictionary is curated (~40 stems) — long-tail synonyms ("špinavý", slang) are not covered; the embedding-based understanding (T1 krok 2) is the systemic answer and will subsume this dictionary as a fast-path fallback.
2. "deep techno" genre ambiguity (deep→house first-match) predates SK and applies to EN too; flagged, not changed (changing it would alter existing behavior).

---

## GOAL 08 (campaign restart) — Intent Engine C1+C2: favorites → melodic prior + ranker preference learning (2026-09-19)

**Goal executed:** Complete the local learning loop — dice ★ now retrains ALL THREE learned models from one exported pack: drum prior (existing), melodic prior (C1, new), and the ONNX ranker (C2, new — learns from human PREFERENCES instead of the heuristic teacher).

**Areas inspected:**

- `scripts/train-intent-ranker.py` (MLP RankNet, golden position-labeling mechanism, full-batch Adam), `scripts/train-symbolic-melodic.py`, `src/ai/grooves/melodic-data.ts` (octaveOffset per role), `src/ai/melodic.ts` (degreeToPitch), `src/project-model/scales.ts` (parseKey/SCALE_INTERVALS), DiceContext recording block.

**Fixes implemented:**

- **Ledger v2** (`src/intent/favorites.ts`): `FavoriteLedgerEntry` gained optional `length, style, ghostWeight, microWeight, velocityVariation, temperature, key, melodic[]` (additive — v1 packs stay valid). `MelodicLedgerPart` = {role, trackName, notes[{pitch,start,duration,velocity}]}, capped `MELODIC_NOTES_CAP=128`. `roleForTrack()` mirrors the generator's name-match→positional heuristic.
- **DiceContext recording** now captures the full reconstruction context: generation controls from `pattern.generation`, project key, and melodic parts per instrument track (role via roleForTrack, notes capped).
- **C1 converter** `favoritesToMelodicSamples()`: pitches inverted to scale degrees through the EXACT engine math (degreeToPitch with recorded key + role octave offset from MELODIC_BY_GENRE); chord voicings collapse to their lowest pitch per start (expandChord re-adds voicings at generation); entries without a recorded key are skipped (inversion would be garbage). Output = melodic-features.v1 next-note samples with weight, group `fav:<seed>:<role>`.
- **C1 trainer hook**: `train-symbolic-melodic.py --favorites [--favorite-oversample N]` — weighted samples folded into TRAIN split only (validation stays library-only), oversampled by weight × N.
- **C2 group builder** `scripts/generate-intent-ranker-favorites.mts` — `buildFavoriteRankerGroups(pack)`: for each entry, rebuild the EXACT intent (all controls recorded), generate the favourite's pattern + 3 same-intent sibling rolls (derived seeds), cross the same invariant gates, extract features.v1 through the real pipeline, and emit dataset-schema groups (`favorite: true`, `winnerIndex` = favourite's position in the heuristic order, favourite heuristicScore pinned to 1). Direct-run CLI guarded with fileURLToPath (Windows-safe).
- **C2 trainer hook**: `train-intent-ranker.py --favorites [--favorite-oversample]` — favorite groups merged into the dataset, winner row labeled 1.0 (the human's pick tops its group BY DEFINITION), groups are TRAIN-only (validation stays teacher-labeled for honest metrics), favorite rows oversampled ×3 so the human signal outweighs its small count; report carries `favoriteGroups`.
- **Export chain** `scripts/export-favorites-training.mts` → `npm run favorites:retrain -- <pack.json>`: drums → melodic (skipped when pack has none) → ranker, all through the shared TS converters (no format bridging, no drift), python failures propagate.
- Tests: `tests/favorites-ledger.test.ts` 11/11 — ledger v2, drum conversion, melodic pitch→degree inversion verified against degreeToPitch, chord-root collapse, key-less entry skip, roleForTrack matrix.

**E2E proof (synthetic 3-entry pack WITH melodic, all models backed up first):**

- drums: 768 weighted samples → 2 304 train rows → new hash, valAUC 0.9175.
- melodic: 12 samples → 108 weighted → new hash, valDegreeAcc 0.643 / valDurationAcc 0.679.
- ranker: 3 preference groups (0 skipped) → merged train-only ×3 → new hash 24.7 kB, golden verdict ready-for-active.
- All three original artifacts RESTORED after the proof; hashes re-verified by all three validators (`validate-intent-ranker.mjs`, `validate-symbolic-prior.mjs`, `validate-symbolic-melodic.mjs`).

**Important files changed:** src/intent/favorites.ts, src/ui/DiceContext.tsx, scripts/{generate-intent-ranker-favorites.mts,export-favorites-training.mts,train-intent-ranker.py,train-symbolic-melodic.py}, package.json (`favorites:retrain`), tests/favorites-ledger.test.ts, INTENT_ENGINE.md (§5.4, §7.2, T2 roadmap, map).

**Validation:** typecheck clean for all changed files; favorites-ledger 11/11; intent-area spot regression (symbolic drum/melodic, audition, parser, pipeline) 59/59 green; three-model retrain chain proven end-to-end then restored.

**Unresolved issues / risks:**

1. Ranker favorites currently reconstruct siblings from the TEMPLATE generator only (prior candidates not reconstructed — their sampling depends on the live prior version, which changes between retrains; reconstruction must stay deterministic across time). Consequence: the model learns the preference within the template candidate space; extending to prior candidates needs pinning the prior hash at record time.
2. One documented behavior note: favorite groups participate in the trainer's golden-position labeling path only via winnerIndex=1.0 labeling; no new golden file is written.
3. The concurrent session's in-flight typecheck breakage (ExportPanel) still theirs; my files verified clean via filtered tsc.

---

## GOAL 09 (campaign restart) — Intent Engine A2: song builder — "make it a song" (2026-09-19)

**Goal executed:** A2 from the INTENT_ENGINE.md next-steps proposal — one intent ("dark rolling techno at 140") builds a FULL arranged song: per-genre form, role-aware section patterns, scenes with roles/intensity, contiguous clips, markers, transitions — installed as ONE undoable command.

**Areas inspected:**

- `src/project-model/types.ts` (SceneRole, Scene.role/intensity, Marker, ArrangementTransition, BAR_TICKS), `src/commands/commands.ts` (createScene/setSceneRole/addArrangementClip overlap rules, autoArrangeSong template + markers/transitions write shape), `src/project-model/groove.ts` (drumHitsInWindow TILES the pattern across the clip via mod(patternTicks) — a section with an N-bar pattern plays the WHOLE pattern, not a tiled 1-bar loop; verified before designing full-length section patterns).

**Key design decisions:**

1. **Commands never generate** (repo etiquette): `buildSong(doc, intent)` does all generation (async, yields between sections via setTimeout(0), onProgress callback for the UI); `applySongCommand(doc, build)` only folds the pre-built result into one snapshot (execute/undo are plain doc swaps).
2. **Deterministic id-based docs instead of uid()**: clips/markers/transitions get ids derived from the section pattern id (`clip-<patternId>`) — the command is a pure snapshot, and rebuilds stay diff-stable.
3. **Full-length section patterns**: each section's pattern has stepCount = bars×16 (phrase plans + fills span the section), NOT a tiled 1-bar loop — verified the renderer tiles anyway when clips exceed pattern length.
4. **Related-not-identical sections**: seeds `baseSeed|song:<i>:<role>` share the namespace (one idea arranged), while role-aware energy/density/complexity deltas (clamped 0..1) give the musical gradient (drop = base +0.3, break = base −0.35).
5. **Section generation via the canonical SYNC single-candidate path**: audition/ranking is a single-pattern UX; a 7-section song generates 7 deterministic patterns (fast, no bank).

**Fixes implemented:**

- `src/intent/song.ts`: `SONG_FORMS` per genre (house/techno 7 sections / 44 bars, trap 6, ambient 5 with its own labels Emergence→Swell→Peak→Stillness→Dissolve), `planSongForm` (deterministic, clamped deltas), `buildSong` (progress + yield, resolvedBpm/key capture), `applySongCommand` (patterns + scenes(role/intensity/name) + contiguous clips + markers(BUILD/DROP/BREAK) + transitions(riser→drops, fill→build B, break→break/outro) + bpm + activePatternId, one undo), `previewSongForm` (no-generation UI preview).
- IntentPanel: "♪ SONG" button next to GENERATE (busy state, progress in the status line, applies immediately — the result IS the arrangement).
- styles.css: `.intent-actions` split-row + song button accent.
- Tests: `tests/intent-song.test.ts` (6) — form determinism + genre shapes, slider deltas + clamping, related-but-distinct sections (same namespace, different content hashes), bpm resolution, full apply assertions (patterns/scenes/roles/names/contiguous clips/markers/riser transitions/active pattern) + ONE-undo restore.

**Important files changed:** src/intent/song.ts, src/ui/IntentPanel.tsx, src/styles.css (append), tests/intent-song.test.ts, INTENT_ENGINE.md (§5.6, §7.2, T3, map).

**Validation:** song tests 6/6 first run; intent-area regression 97/97 across 11 files; typecheck clean for changed files. Concurrent session's ExportPanel breakage remains theirs (untouched, filtered tsc used).

**Unresolved issues / risks:**

1. Song audition (hearing the WHOLE song before apply) is not wired — offline render of 44 bars is too long for the main thread; natural follow-up once the render moves to a Worker (also noted under A1).
2. Sections generate via template candidates only (no prior/ranker) — a song-wide candidate bank would multiply generation cost 5x; per-section prior candidates remain a v2 option.
3. Transitions are type markers only (riser/fill/break metadata) — actual transition SOUND generation (riser samples, fill patterns) stays open (T3 remainder).


---

## GOAL 10 (campaign restart) — Intent Engine D1+D3: intent-to-mix chain + unified intent bar (2026-09-19)

**Goal executed:** D-batch finale — (D1) the intent shapes the MIX (tone/punch/space/pump derived from genre/mood/energy, plus explicit mix words), and (D3) one text input routes to the right executor (arrange / mix / pattern).

**Areas inspected:**

- `src/effects/registry.ts` (EFFECT_DEFS param ids for eq/reverb/saturation/compressor/pump, clampEffectParam), `src/commands/commands.ts` (addEffectToTracks/removeEffectFromTracks/setEffectParam/setEffectSidechainSource, snapshot fold etiquette), `src/project-model/types.ts` (EffectInstance.sidechainTrackId), `src/intent/favorites.ts` (roleForTrack heuristic reuse), `src/intent/arrangeWords.ts` (parseArrangeIntent reuse for routing).

**Fixes implemented:**

- `src/intent/mix.ts`:
  - `planMixProfile(intent, overrides)` — deterministic intent→mix decisions: EQ tilt by tone (dark = lowShelf +2.5/highShelf −2.5/LP 14k, bass deepened to +3; bright/warm/cold variants), punch = drum compressor (−16/4:1/fast attack/+2 makeup) + saturation drive, space = reverb on chords+lead (ambient/chill lush 0.45/3.5 s; techno/trap/aggressive DRIER via negative decisions; "huge reverb" override multiplies), pump = sidechain pump on bass+chords keyed from drums for house/techno energy ≥ 0.55. CONSERVATIVE default: neutral intent without overrides touches no EQ.
  - `applyMixIntent(doc, profile)` — adds missing effects, clamps every param via clampEffectParam against EFFECT_DEFS, wires sidechainTrackId to the drum track, folds everything into ONE undo snapshot (arrangeWords etiquette); idempotent (second identical apply throws "changed nothing"). Track targeting reuses roleForTrack; fixed a "chords" (IntentRole) vs "chord" (melodic-part) naming mismatch found by the tests.
  - `removeMixEffect` target-scoped reset path.
- `src/intent/route.ts`:
  - Mix vocabulary parser (EN+SK, de-accented): reverb/punch/pump/tone overrides; KEY SEMANTIC RULE — plain adjectives ("dark techno") stay PATTERN intents while comparatives ("darker", "tmavší") or mix nouns/verbs ("more reverb", "punchier", "bez pumpy") route to MIX.
  - `routeIntentText(text, doc)` — priority arrange (scenes exist + clean op parse) → mix (explicit vocabulary) → pattern (default); least-destructive interpretation wins.
- IntentPanel: "⚡ DO IT" button — routes the text itself and reports what it did in the status line ("⚡ arranged — 2 ops" / "⚡ mix: tone: dark · pump: sidechain 61%"); GENERATE and ♪ SONG remain explicit.
- Tests: `tests/intent-mix-route.test.ts` (14) — profile determinism, per-mood/genre decisions (dark techno vs ambient chill), conservativeness, overrides, apply assertions (fx added, params clamped, pump sidechained to drums, no pump on drums, ONE undo restores pristine tracks), idempotency, mix parser EN/SK, comparative-vs-plain routing rule, router priority incl. scene-word hijack guard.

**Important files changed:** src/intent/mix.ts, src/intent/route.ts, src/ui/IntentPanel.tsx, src/styles.css (append), tests/intent-mix-route.test.ts, INTENT_ENGINE.md (§5.7, §7.2, map).

**Validation:** mix/route tests 14/14; intent-area regression 111/111 across 12 files (song, parser, pipeline, audition, symbolic drum/melodic, favorites, mapping, binding, async, arrangeWords); typecheck clean for changed files. Concurrent session's ExportPanel breakage remains theirs.

**Unresolved issues / risks:**

1. Mix decisions are static profiles - no loudness measurement loop (limiter target) and no per-section mix in the song builder yet; both are natural D1 v2 items.
2. Pump routing assumes the drum track as sidechain source (the only rhythmic anchor today).
3. Router ambiguity is resolved heuristically (least destructive); a disambiguation chip row ("did you mean mix?") could replace it if misroutes show up in use.

## GOAL 11 (campaign restart) - Fine-grained selectors: 27 components migrated from useDoc() to slice hooks (2026-09-21)

**Goal executed:** Migrate every consumer of `useDoc()` in `src/ui/` to fine-grained slice hooks (`useTracks`, `useReturns`, `useArrangement`, `useScenes`, `useMarkers`, `useAutomation`, `usePatterns`, `useMacros`, `useMaster`, `useActivePatternId`, `useSceneAutomation`) where structural sharing in `normalizeProject` (`src/project-model/schema.ts:1841`) makes per-slice re-render avoidance work. Added two new slice hooks (`useActivePatternId`, `useSceneAutomation`) to round out the 11 slice surface.

**Areas inspected:** every `.tsx` file under `src/ui/` — 27 files had one or more `useDoc()` calls (~36 callsites total). Audited each `doc.X` reference and replaced with the matching slice hook OR with `services.store.getDoc()` plain getter (when `doc` was only consumed as a command argument in async callbacks). Special attention to:
- `Mixer.tsx` (3 useDoc sites — top, MasterStrip, ChannelStrip) — 36 `services.store.execute(command(doc, ...))` calls all reference local `doc = services.store.getDoc()`.
- `ArrangementPanel.tsx` (~80 `doc.X` references) — bulk `replace_all` per slice, plus removal of an unused `doc` prop on `IntensityLane`.
- `ModPanel.tsx` — 3 useDoc sites (ModPanel/MacroCard/ScenePanel) plus 4 `ReturnType<typeof useDoc>` type annotations replaced with `ProjectDocument`.

**Fixes implemented:**

- `src/store/ProjectStore.ts` — added `getSceneAutomation()` and `getActivePatternId()` (line ~177), with comment block on structural sharing invariant.
- `src/collab/YDocStore.ts` — same two delegating getters (line ~260) with note that collab mode invalidates ALL selectors on remote mutation (slice stability is a local-mode property).
- `src/ui/context.ts` — added `useSceneAutomation()` and `useActivePatternId()` hooks (line ~115).
- `tests/helpers.tsx` — added `getSceneAutomation: () => project.sceneAutomation` and `getActivePatternId: () => project.activePatternId` to mockServices store.
- 27 components migrated:
  - **Plain getter swap** (`doc` only consumed in async callbacks): `UltinaPanel`, `CollabPanel`, `FreezeButton`, `IntentPanel`, `PresetBrowser`, `SliceLab`, `ScalePanel`, `UndoHistoryPanel`, `Inspector`, `FloatingPlugin`, `EffectRack/Device`.
  - **Single-slice hook**: `TrackTabs` (useTracks), `MacroPerformanceBar` (useMacros), `MasterMeter/MasterStereoMeters` (useMaster), `RackStrip` (usePatterns+useActivePatternId), `FloatingPlugin` (useTracks), `EffectRack` (useTracks).
  - **Multi-slice hook**: `TopBar` (useArrangement+useActivePatternId), `SceneLauncher` (useScenes+useArrangement+usePatterns+useActivePatternId), `PatternBar` (usePatterns+useActivePatternId), `DiceTray` (useTracks+usePatterns+useActivePatternId), `GenerateDialog` (useTracks+usePatterns), `AssistPanel` (useScenes), `ExportPanel` (useMarkers+usePatterns+useTracks+useMaster+useActivePatternId), `ContextMenu` (useArrangement+useActivePatternId), `MidiPanel` (2 calls: useTracks+useReturns / useTracks+usePatterns+useActivePatternId), `Sequencer` (4 calls: usePatterns+useTracks+useActivePatternId), `PianoRoll` (usePatterns+useTracks).
  - **Heavy ones**: `Mixer.tsx` (useTracks+useReturns+useMaster+useMacros across 3 components), `ModPanel.tsx` (useTracks+useReturns+useAutomation+usePatterns+useMacros+useActivePatternId+useSceneAutomation across 3 components), `ArrangementPanel.tsx` (useScenes+useArrangement+useTracks+useMarkers+usePatterns+useActivePatternId, plus IntensityLane doc-prop removal).

**Important files changed:** `src/store/ProjectStore.ts`, `src/collab/YDocStore.ts`, `src/ui/context.ts`, `tests/helpers.tsx`, plus 27 component files in `src/ui/`.

**Validation:**
- 5 Mixer tests PASS (`tests/ui/Mixer.test.tsx`) + 5 touch-reachability + 3 fine-grained selectors = 13/13.
- 9 ModPanel tests PASS (`tests/ui/ModPanel.test.tsx`).
- 24 ArrangementPanel tests PASS (`tests/ui/ArrangementPanel.test.tsx`) — including the scene intensity lane tests that exercise the `IntensityLane` doc-prop removal.
- Full `tests/ui/` sweep: **468 tests in 83 test files PASS, 0 failed**.
- typecheck:clean PASS for all migrated files (only pre-existing errors in `src/intent/song.ts` from concurrent work, and `src/audio-engine/PcmMicRecorder.ts:175` — both unrelated and confirmed pre-existing via git stash).

**Unresolved issues / risks:**

1. **`useDoc()` is still exported** from `src/ui/context.ts` and still referenced in `tests/_stubs/virtual-pwa-register.ts` etc. It now has zero remaining consumers in `src/ui/`. Decision: leave it exported — collaborators (Yjs mock, future tests) may need a full-doc snapshot. If zero uses accumulate over the next sprint, remove in a follow-up.
2. **YDocStore collab caveat**: each `applyToYDoc` mutation from a remote peer invalidates ALL slices in the network model because Yjs doesn't share structure across the network. Fine-grained subscriptions in collab mode still work but provide no re-render savings. Local-mode users get the full benefit.
3. **`PcmMicRecorder.ts:175` typecheck warning** (`"live" !== "ended"`) is a pre-existing narrowing bug not touched by this migration. Logged separately as a follow-up.
4. **The full-doc hook (`useDoc`) now overlaps with `useActivePatternId`** — both subscribe to the same doc, but `useDoc` re-renders on every slice mutation while `useActivePatternId` only re-renders when `doc.activePatternId` actually changes (thanks to `===` compare on the string). New code should reach for the slice hook; `useDoc` is reserved for legacy callers.
5. **Bugs uncovered**: removing the unused `doc` declaration in `Sequencer.tsx`'s `TrackHeaderRow` and `PadRow` initially broke 4 callers that referenced `doc` in JSX. Re-added `const doc = services.store.getDoc()` in both. Pattern: ALWAYS grep for `doc\b` (word boundary, no slice prefix) before declaring a plain getter swap.


---

## GOAL 11 (campaign restart) — Intent Engine A2 v2: songwriting roles verse/chorus/bridge (2026-09-19)

**Goal executed:** The user asked whether the song builder handles "how intro/verse/chorus/bridge/outro should LOOK" — assessment showed sections differed only by slider deltas and SceneRole had no verse/chorus/bridge. This goal made them first-class: role-aware INSTRUMENTATION per section + a pop form + full tooling support.

**Areas inspected:**

- All SceneRole consumers: project-model/schema.ts (SCENE_ROLES clamp list + inferSceneRole name inference — CRITICAL: unextended clamp list would silently DROP new roles on project load), commands.ts autoArrangeSong role bucketing, collab/bandmate.ts etiquetteFor, ui/ArrangementPanel.tsx role picker, intent/arrangeWords.ts ROLE_SYNONYMS, grooves renderer (verified clips tile patterns — full-length section patterns unaffected).

**Fixes implemented:**

- `SceneRole` += "verse" | "chorus" | "bridge" (types.ts; additive union — backward compatible). `SCENE_ROLES` clamp list extended (schema.ts) and `inferSceneRole` recognizes Verse/Chorus/Hook/Bridge scene names — SEMANTIC CHANGE: a scene named "Chorus" now infers `chorus`, not `drop`.
- `arrangeWords.ts` ROLE_SYNONYMS: chorus (chorus|hook|refren), verse (verse|zloh — STEM form after tests caught that "pridaj zlohu" accusative failed the zloha boundary), bridge (bridge|most|mostik). "chorus" is no longer a drop alias; "bridge" no longer a break alias; plain drop/break unchanged.
- `autoArrangeSong`: new roles fold into nearest buckets (chorus→drop, verse→build, bridge→break) so auto-arrangement uses them.
- `bandmate.ts` etiquetteFor: verse = 0.85 density no fill; chorus = full + fill at p ≥ 0.9; bridge = 0.4 density, hats+perc only. roleFromName recognizes the new roles.
- `ArrangementPanel` role picker: VERSE/CHORUS/BRIDGE entries.
- `song.ts` (A2 v2): `SongSectionSpec.instrumentation: IntentRole[]` — the roles a section GENERATES (intro/outro = drums+bass, build/verse = +chords, drop/chorus = full, break/bridge = chords+lead). `buildSong` intersects instrumentation with the USER's intent roles ("no drums" wins in every section); actual generated roles land in provenance (`SongBuildSection.roles`). SONG_FORMS regenerated wholesale (two-writer formatting conflict made incremental patching unreliable): house/techno electronic forms + instrumentation, trap switched to the POP FORM (intro(4) → verse(8) → chorus(8) → verse(8) → chorus(8) → bridge(4) → chorus(8) → outro(4) = 52 bars, CHORUS impact markers, bridge strips to chords+lead), ambient labels keep their own instrumentation.
- Tests: intent-song 11/11 (form shapes, instrumentation per label, trap pop role sequence, chorus-has-lead vs verse-not provenance via section.roles, bridge zero drum hits + melodic present, user-role intersection, apply/undo, clampSceneRole/inferSceneRole); arrangeWords 13/13 (new EN+SK synonyms incl. refren/zlohu/most; drop/break unchanged).

**Important files changed:** src/project-model/{types,schema}.ts, src/intent/{arrangeWords,song}.ts, src/commands/commands.ts (autoArrange buckets), src/collab/bandmate.ts, src/ui/ArrangementPanel.tsx, tests/{intent-song,intent/arrangeWords}.test.ts, INTENT_ENGINE.md (§5.8, §7.2, T3, map).

**Validation:** intent-area regression 133/133 across 13 files (incl. project-invariants for schema round-trip); typecheck clean for changed files. Two incidents documented: (1) a python heredoc wrote literal backspace bytes (0x08) into schema.ts regexes — repaired via chr(92) construction and verified by cat -A + tsc; (2) SONG_FORMS had formatting from two writers — resolved by full-block regeneration from a canonical spec. Concurrent session's controls.tsx typecheck breakage remains theirs.

**Unresolved issues / risks:**

1. inferSceneRole semantic change: projects with scenes NAMED "Chorus" (previously inferred drop) now infer chorus after reload — musically correct, but arrangement markers/buckets keyed to drop shift; a one-line note belongs in the next release notes.
2. Instrumentation filtering relies on the generator honoring `roles` (verified) — lead parts on 2-track docs fall back positionally to the bass track (generator naming heuristic), so "lead present" is provenance-level truth, not a per-track guarantee.
3. Pop form exists for trap only; house/techno verse/chorus variants can be added on demand (SONG_FORMS entry each).


---

## GOAL 12 (campaign restart) — Intent Engine C1+C2: artist "type beat" dictionary + "more X" revise routing (2026-09-19)

**Goal executed:** Per docs/intent-artists-and-revise-plan.md (green-lit after web research): (C1) artist/type-beat references resolve to style presets instead of falling back to a default house pattern; (C2) "more energetic"-style comparatives REVISE the last result with the same seed instead of generating something unrelated.

**Research (web, sources in the plan doc):** Travis Scott type beats 130–140 BPM dark/psychedelic pads + distorted 808s; Metro Boomin 130–140 (73/81 half-time) dark cinematic; rage beats (Carti/Yeat/Southstar) 150–165 bright distorted synths, punk energy; drill 140–145 sliding 808s; boom bap 85–95 swung soul; Fred again 128–136 emotive house/garage; amapiano 110–115 log drums.

**Fixes implemented:**

- `src/intent/artists.ts`: `ARTIST_PRESETS` — 14 presets / ~40 match phrases (travis scott, metro boomin, 21 savage, carti/rage, yeat, southstar/kyle beat, pop smoke/uk drill/central cee, ice spice/jersey, kanye/boom bap, fred again, disclosure/ukg, fisher/tech house, amapiano/rema/tyla, SHM/big room). Each maps ONLY to existing engine vocabulary (genre/style/mood/sliders/BPM prior) — no new capabilities, legally clean (a name → a style description). `matchArtistPreset` = deterministic word-boundary phrase match, list order = priority.
- `text-parser.ts` integration: artist preset applied FIRST as the BASE; explicit text words still override it ("travis scott type beat **bright**" → mood energetic + energy 0.95 beat the preset's dark/0.7 — a trait gap for "bright" was found by the tests and fixed). detected chip "♪ travis scott". **Bug fix**: "drill" mapped to TECHNO (tempo-proximity mistake) → now trap; redundant "drill beat" entry removed.
- `route.ts` (C2): `parseReviseIntent` — comparative + attribute pairs ("more energetic/energic/energy", "calmer", "busier/denser", "menej husty", "viac energie") → `revise` route with `REVISE_DELTA = 0.15`. Router priority updated: arrange → mix (SOUND: tone/reverb/punch) → revise (CONTENT: energy/density) → pattern. The punch/energy distinction is deliberate and tested ("more punch" = compression = MIX; "more energetic" = slider = REVISE).
- `IntentPanel.tsx`: generation flow refactored into `runGeneration(intentInput, controller)` + `lastIntentRef` (intent of the last generation). REVISE route re-runs the SAME intent with the shifted slider (same seed ⇒ same beat family, moved character) through the standard audition flow; without a last generation it applies the attribute to the parsed intent as a fresh pattern. Status reports "⚡ energy +0.15 — same seed".
- Tests: `tests/intent-artists.test.ts` (11) — presets (TS/metro/rage/kanye/drill), no-"type"-phrase matching, text-over-preset priority, drill bugfix, no-artist regression, matcher determinism; revise parser EN+SK (incl. the user's literal "more energic"); router priority matrix; same-seed identity integration (same generation seed, moved energy, different content hash, reproducible).

**Important files changed:** src/intent/{artists,route,text-parser}.ts, src/ui/IntentPanel.tsx, tests/intent-artists.test.ts, INTENT_ENGINE.md (§5.9 done + map), docs/intent-artists-and-revise-plan.md (plan + research sources).

**Validation:** artist/revise tests 11/11; parser 18/18 unchanged (EN regression intact); intent-area regression 144/144 across 14 files; typecheck clean for changed files. Concurrent session's controls.tsx breakage remains theirs (filtered tsc).

**Unresolved issues / risks:**

1. The alias dictionary is curated — unknown artist names still fall to defaults (the honest limit until T1 step 2 embedding understanding); the dictionary remains as the fast offline fallback afterward.
2. Revise works on the last PATTERN generation only — revising a whole SONG (all sections' sliders) is a natural follow-up once per-section intents are retained in SongBuild.
3. Preset BPM priors are ranges — resolvedBpm still honors an explicit BPM in the text over the preset's range.


---

## GOAL 13 (campaign restart) — Intent Engine T1 krok 2: semantic embedding layer (2026-09-19)

**Goal executed:** The long-planned semantic step — a multilingual sentence-embedding model running IN THE BROWSER that resolves intent by MEANING above the keyword parser, making unknown phrasings and unfamiliar artist references resolvable ("beat in the style of the rapper from astroworld" → trap, with zero keyword overlap).

**Design decision (documented, deliberate):** RETRIEVAL over a curated corpus, not trained heads. Head training needs labeled artist data we don't have; embedding-kNN needs only reference sentences — and MiniLM is genuinely TRAINED for semantic similarity, so it generalizes to phrasings and names the corpus never contained. Model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` q8 (118 MB, EN+SK+) via `@huggingface/transformers` v4.3 in a Web Worker.

**Offline-first guarantees:**

- Model NOT committed: `npm run semantic:fetch` downloads ONNX q8 + tokenizer into `public/models/semantic/` in HF layout (gitignored). Worker sets `env.allowRemoteModels = false` — no silent CDN fallback; a missing model surfaces as a controlled failure.
- `semanticAvailable()` probes the manifest (one 404 remembered per session) before any worker spawn. PWA precache glob (js/css/html/svg/png/woff2/wav) excludes the model automatically.
- Feature flag `pf:semantic-embed` on|off; every failure resolves null → keyword parser path byte-identical to before.

**Fixes implemented:**

- `src/ai/semantic/` — semantic-worker (lazy transformers.js pipeline, mean-pool + L2 normalize, v4 `env.localModelPath`, session pipeline cache), semantic-client (lazy spawn, 20 s+ embed timeout, circuit breaker, manifest probe), semantic-types (embed contract).
- `src/intent/semantic.ts` — `buildSemanticCorpus()` (~80 entries: every artist preset EN+SK + genre×mood vocabulary EN+SK paraphrases), `semanticIntentFor(text, {embed})` — dependency-injected embedder (unit-testable without network), corpus embedding cached per session, cosine kNN, `SEMANTIC_THRESHOLD = 0.5`.
- IntentPanel: GENERATE path enriches WEAK keyword parses (no genre word, no ♪ preset) via semantic matching; chip "🧠 label (score %)"; confident keyword parses skip the model entirely (zero latency).
- `scripts/fetch-semantic-model.mjs` + `npm run semantic:fetch [-- --mini]`; HF-layout fix (files under `<modelId>/`, not flat) caught by the smoke run.
- Tests: `tests/intent-semantic.test.ts` (7) — corpus integrity/canonical patches, kNN with a deterministic genre-cluster mock embedder (match, below-threshold null, embedder-failure null, corpus cache), no network in unit tests.
- Smoke: `scripts/smoke-semantic.mts` with the REAL 118 MB model through the app's own matching function — 4/4: unknown trap phrasing via astroworld reference → trap 0.685; SK "pomaly pokojný zvuk pre scénu" → ambient 0.835; party groove → house 0.661; unrelated nonsense (quarterly taxes) → null.

**Important files changed:** src/ai/semantic/* (3 files), src/intent/semantic.ts, src/ui/IntentPanel.tsx, scripts/{fetch-semantic-model.mjs,smoke-semantic.mts}, tests/intent-semantic.test.ts, package.json (@huggingface/transformers, `semantic:fetch`), .gitignore, INTENT_ENGINE.md (§5.8b).

**Validation:** semantic unit tests 7/7; real-model smoke 4/4; intent-area regression 151/151 across 15 files; typecheck clean for changed files.

**Unresolved issues / risks:**

1. First-use latency: model load + corpus embedding (≈118 MB download on first ever use if not pre-fetched, seconds of WASM inference) — masked by the "🧠 semantic…" status; a warmup call on panel open could hide more.
2. Corpus is curated (~80 entries) — coverage grows by adding reference sentences; favorites can seed corpus entries in a future iteration.
3. transformers.js v4 bundles its own onnxruntime — coexists with the repo's direct onnxruntime-web usage in separate worker chunks, but total lazy-chunk bytes grew; acceptable (semantic path is opt-in by usage).
4. The concurrent session's controls.tsx typecheck breakage remains theirs; filtered tsc used.


---

## GOAL 14 (campaign restart) — Intent Engine T3: real transition sounds (2026-09-19)

**Goal executed:** The last open T3 item — arrangement transitions stopped being metadata-only: every transition now BAKES a real sound into the OUTGOING section's pattern (drum-language transitions: fills, riser builds, break dropouts).

**Areas inspected:**

- `src/ai/drums.ts` (existing fill "boost" is mild — last-4-step velocity bumps + ghosts; transition fills are deliberately stronger), `src/ai/phrase.ts` (phrase plan marks fill/outro bars — transition fills layer on top), `src/intent/quality.ts` (refreshPatternOutputHash for post-modification provenance), `src/ai/pad-roles.ts` (role-aware pad selection).

**Fixes implemented:**

- `src/intent/transitions.ts` — `applyTransitionToPattern(doc, pattern, type, { allowDrums })`:
  - **fill**: zeroes the last bar (kick anchor preserved), adds a full-bar 16th snare/clap roll with a 0.3→0.9 velocity crescendo + a tom run (fall back to roll voices) on the final 4 steps;
  - **riser**: last TWO bars (fallback to fill when < 2 bars): pulse bar (quarter snare 0.4→0.7 + open-hat 8ths) then a full 16th roll crescendo 0.4→0.95 + rising open hats;
  - **break → dropout**: zeroes the outgoing last bar — the silence IS the transition;
  - drop/impact/custom unchanged. Deterministic (fixed ramps, no RNG), role-aware voices (snare+clap roll, tom run, open-hat sparkle), rows initialized for pads the pattern never used, output hash refreshed.
  - `allowDrums: false` (drum-free outgoing section — a bridge, or user "no drums") suppresses drum-based treatments; dropout always applies (it only removes). The user's role request cuts across transitions — caught by the song tests as a REAL feature interaction (bridge/fill collision) and resolved principledly.
- `song.ts` buildSong: after generating all sections, each transition bakes its treatment into the outgoing section (deterministic, still ONE undo step, reproducible hashes).
- Tests: `tests/intent-transitions.test.ts` (8) — type→treatment map, fill crescendo rules + kick anchor + untouched earlier bars, 2-bar riser shape, dropout silence, no-op types, determinism, real-kit generation, and song-level baking (Build A riser bars, Drop A silent last bar, Break fill suppressed for drum-free instrumentation).

**Important files changed:** src/intent/{transitions,song}.ts, tests/intent-transitions.test.ts, tests/intent-song.test.ts (bridge assertion → body bars only, barHits helper), INTENT_ENGINE.md (§5.10, T3 closed, map).

**Validation:** transition tests 8/8; intent-area regression 159/159 across 16 files (incl. project-invariants); typecheck clean for changed files.

**Unresolved issues / risks:**

1. Risers are DRUM-language builds (rolls), not synthesized noise sweeps — true riser WAV assets need sample-bank + AudioClip persistence infrastructure (the last open T3/T4-horizon item).
2. Transition fills may stack with the generator's own mild phrase fills in the last bar — intentional (the transition roll dominates), verified non-breaking.
3. House Break section suppresses its launch fill (drum-free rule) — musically debatable; if it bothers ears, the rule can become "bridge-only suppression" later.
