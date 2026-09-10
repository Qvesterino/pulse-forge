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
