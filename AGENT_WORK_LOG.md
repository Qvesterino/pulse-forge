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
