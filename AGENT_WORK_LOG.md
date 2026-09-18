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

