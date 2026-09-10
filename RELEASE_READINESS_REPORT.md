# RELEASE READINESS REPORT — Pulse Forge / KYX

**Date:** 2026-09-10
**Author:** Sequential Scheduler Hardening Campaign (GOAL 12 — final gate)
**Scope:** independent final engineering review over the working tree (committed HEAD `40f5c86` + substantial uncommitted KYX-roadmap WIP + this campaign's fixes).

---

## FINAL CLASSIFICATION

# PASS WITH KNOWN RISKS

All automated release gates pass on the audited tree. The repository is engineering-ready: no open correctness, data-integrity, security, or stability defect was found that materially threatens the intended release scope. However, (a) the working tree carries large uncommitted feature work with a concurrent editor active, (b) the product's own KYX roadmap still lists open P0 audio-quality items that are conscious, documented residuals rather than defects introduced now, and (c) manual cross-browser smoke (Firefox/Safari/iOS) has not been performed this session. Release may reasonably proceed once the tree is committed and the manual matrix is run; the risks below are non-blocking individually but must be accepted explicitly.

---

## 1. Gate results (this session, working tree)

| Gate | Result | Notes |
|---|---|---|
| `npm run typecheck` | **PASS** | clean `tsc --noEmit` |
| Full Vitest suite | **PASS — 2003 passed / 0 failed / 95 skipped** (201 files, final confirmation run; four earlier runs each surfaced exactly one distinct issue, all diagnosed: two load-flakes fixed, one stale source-pin test fixed, one mid-vendor transient from the concurrent editor's ultina re-vendoring — all resolved or attributed) |
| `npm run build` + bundle budgets | **PASS** | entry 874 KB / 995 budget; total JS 1668 KB / 2400 budget; PWA precache 45 entries |
| `npm run test:browser` (Chromium smoke) | **PASS 197/197** | incl. real-worklet fxeq render, 2-page collab sync over real server, embed, share-link import, plugin workflow; zero console/page errors |
| `npm run ai:performance` | **PASS** | p95 ≈ 2.2 ms vs 250 ms budget |
| `npm audit --omit=dev` | **PASS** | 0 vulnerabilities |
| `npm run format:check` | **DEVIATIONS DOCUMENTED** | 187 files deviate (pre-existing repo-wide; HEAD was 215 — the in-flight WIP *improved* it). Per the release-gate rule this is an accepted, documented deviation, not a blocker. |
| Manual Firefox / Safari / iOS Safari smoke | **NOT RUN** | manual matrix, outside this session's automation (risk R6) |

*Final confirmation run: **2003 passed / 0 failed / 95 skipped, exit 0** (19:35–19:41), including the concurrent editor's vendored ultina fixes in their landed state.

## 2. Defects fixed during this campaign (all verified)

1. **Post-test unhandled `TypeError` class** — 5 production sites scheduled `URL.revokeObjectURL(url)` on a 5 s timer; in jsdom the function is undefined after test restore, throwing an unhandled error attributed to whatever file is running → nondeterministic failure of unrelated test files. Fixed with optional-call guard (src/export/project-io.ts, src/midi/midiProject.ts, src/rendering/wav.ts, src/ui/ExportPanel.tsx ×2). No production behavior change.
2. **fxeq "random"-wave LFO unseeded (KYX P0 bullet)** — `Math.random()` in the vendored-fork DSP made the S&H wave nondeterministic. Replaced with per-instance xorshift32 (fixed seed, re-seeded on reset) following the lofi/ozvena precedents; worklet bundle rebuilt deterministically; hardening test now covers `"random"` (was explicitly excluded) + new determinism/reset assertions; golden fixtures remain bit-exact. KNOWN_LIMITATIONS updated (residual: all instances share one fixed sequence; no host-visible seed param).
3. **`deleteSnapshot` unhandled rejection** — failed snapshot delete died silently with stale UI. Now caught, logged, and surfaced in the panel.
4. **DB failure masquerading as first-run** — ProjectBrowser swallowed storage errors into an empty list ("No projects yet"), inviting the user to believe their work is gone. Now shows an explicit storage-failure alert.
5. **Snapshot restore irrecoverable after reload** — restore was undoable only in-session. A best-effort "Auto — before restore" snapshot is now parked before the command executes.
6. **MIDI import unbounded** — no size cap; hostile .mid could OOM the tab pre-validation. Now capped at 10 MB (mirrors project import), tested.
7. **Meter duck-typing bypassed engine type contract** — a renamed engine method would silently degrade every mixer meter to the legacy path while mocks still pass. Now direct typed calls.
8. **`useLongPress` missing unmount cleanup** — touch press outliving its component could dispatch a command post-unmount. Timer now cleared on unmount.
9. **Copy-on-apply violations in two commands** — `applyInstrumentPreset` (params map) and `addSceneAutomation` (target object) inserted closure-/caller-owned objects by reference across doc revisions; latent undo-snapshot aliasing. Both now copy.
10. **Two full-suite flaky tests** — default 1 s `waitFor` timeouts under parallel CPU load (midi-io import, GalleryPage report). Raised to 10 s matching the repo's documented pattern.

## 3. Remaining risks (accepted, non-blocking)

| # | Severity | Area | Evidence | User impact | Recommended fix | Blocks release |
|---|---|---|---|---|---|---|
| R1 | Medium | VLYX/ultina vendored core — 5 documented upstream DSP defects (sculptor silent-band poisoning, T/S stereo L→R leak, re-prepare crossover reset, Phase-Shift >4 ms dry/wet, main-thread mix-assist analysis) | KNOWN_LIMITATIONS §Ultina; KYX §6.2; **fixes were landing via the proper upstream→re-vendor flow DURING this audit** (upstream `D:/VocalForge_DAW/plugins/ultina` + vendored copies modified 19:24–19:32; sculptor/multiband among them) | audible mixing-tool inaccuracy on specific material | confirm the in-flight upstream fixes land + vectors regenerated; re-run ultina suites | No (documented; actively being fixed) |
| R2 | Medium | Export residuals: 32-float WAV hard clip at ±1.0; marker cue one-shots absent from master WAV; scene-intensity live/export ≤1 scheduler tick; scene-tempo ±25 ms boundary; offline stage render non-cancellable; video <1 s records 1 s | KNOWN_LIMITATIONS §Export; RELEASE_ROADMAP Fáza 3 | edge-case export artifacts | KYX §6.4 policy decisions | No |
| R3 | Medium | VØID/ozvena audio-thread allocations (IR partition-FFT batch, pre-delay growth) | KNOWN_LIMITATIONS §Ozvena | possible dropouts on low-end devices during IR load/resize | KYX §6.3 upstream hardening | No |
| R4 | Low | Collab/gallery server pre-auth exposure | KYX §11 — limits shipped in WIP (rooms/connections/payloads/CORS/metrics, tested); moderation flow + prod CORS allowlist still open | abuse/griefing on a public deployment | set `CORS_ORIGIN`, keep gallery behind feature flag until moderation reviewed | No (if deployment follows KYX §11 guidance) |
| R5 | Low | Persistence residual gaps: `loadManyByIds`/`rebuildIndex` no per-record catch; `FrozenBufferRepository.save` swallows errors (freeze lost on reload); `LibraryRepository.mutate` swallows write failures; manual-snapshot failures silent (now surfaced in panel) | campaign audit, GOAL 04 | degraded recovery UX in rare storage-failure paths | per-record guards + error surfacing (KYX Fáza 6) | No |
| R6 | Medium | Manual browser matrix not run (Firefox/Safari/iOS Safari — pagehide/unlock, MediaRecorder, Web MIDI, tab-hide resume) | RELEASE_ROADMAP §1.1 unchecked | platform-specific lifecycle bugs | run the manual QA checklist pre-launch | Conditionally — must be run before public launch per KYX §15, but is a release-process step, not a code defect |
| R7 | Low | Working tree mid-flight: ~1000+ lines uncommitted KYX work + a concurrent editor observed active throughout the campaign (branding pass, gallery moderation, preview-stop policies, collab hardening, fxeq owner-aware FX chains, ultina upstream DSP fixes vendoring) | git status; file timestamps; the repo's own verify-browser.mjs documents and retries this co-editing race | any single full-suite run can catch a mid-save snapshot (one did: ultina sculptor test failed during the 19:24–19:32 vendor window, passes 3×3 after) | commit/land the WIP, re-run gates on the quiescent tree | No for code quality (all failures diagnosed: 2 flake-class fixed, 1 stale test pin fixed, 1 mid-vendor transient); Yes for tag/build reproducibility |
| R8 | Low | Collab undo local-only; Yjs history unbounded; `applyToYDoc` fast path absent for newer commands (resetEffect/preset applies fall back to full-doc sync — correct, less efficient) | KNOWN_LIMITATIONS §Collab; campaign GOAL 06 | minor collab efficiency/history growth | KYX §8.2 contract work | No |
| R9 | Info | Formatting deviations (187 files), root-level dev artifacts (`qa-*.mjs`, `__debug_loop.mjs`, `scratch/`, `topbar-diag.png`, `qa-report.json`), doc drift in MAINTENANCE_AUDIT_PROGRESS | format:check output; SYSTEM_AUDIT_MAP §13 | none (dev-only) | cleanup pass post-release | No |
| R10 | Info | Deferred by owner decision: Vitest 5/Vite 8 migration, `bounceStemsToAudioClip` unwired, racks feature planned-not-started, stem separation parked | RELEASE_ROADMAP; docs/ | none | n/a | No |

## 4. Architecture & process observations

- The system is unusually well-audited: immutable-doc + command architecture is enforced consistently (zero violations found), undo integrity verified by deep-freeze + round-trip snapshots in dev, live==offline parity is a tested invariant, and every prior defect fix carries an inline regression note.
- Test-suite runtime (~8–15 min full run in jsdom) is the main process friction — it already produced two load-flakes of the same class this campaign; further default-timeout `waitFor`s may flake intermittently (pattern fix is one line each, applied where observed).
- `SYSTEM_AUDIT_MAP.md` (new) gives future sessions the subsystem inventory, critical paths, and high-risk table; `AGENT_WORK_LOG.md` (new) carries full campaign continuity.

## 5. Pre-launch checklist (owner actions)

1. Land/commit the in-flight KYX work; re-run gates on the committed tree (all commands listed in §1).
2. Run the manual Firefox/Safari/iOS matrix (KYX §5 checklist).
3. If the collab/gallery server is exposed publicly: configure `CORS_ORIGIN`, review moderation flow (R4).
4. Accept or schedule R1–R3 audio residuals per the KYX roadmap sequencing.
