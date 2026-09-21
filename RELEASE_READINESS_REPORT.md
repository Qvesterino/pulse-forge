# RELEASE READINESS REPORT — Pulse Forge / KYX

**Date:** 2026-09-21
**Author:** Sequential Scheduler Hardening Campaign re-run 3 (GOAL 12 — final gate)
**Scope:** full-gate verification over HEAD after the re-run-3 campaign
(GOALs 01-11: provenance seam, architecture/boundary audit, intent routing,
resilience, state integrity, contracts, concurrency, format robustness,
undo sweep, resource lifecycle, security/dependency review) and the final
gate series below. Supersedes the 2026-09-14 edition of this report.

---

## FINAL CLASSIFICATION

# PASS WITH KNOWN RISKS

The core product journeys are green: typecheck, production build with all
bundle budgets, release preflight (production config + KYX branding scan),
server smoke (health/CORS/origin/admin contract), npm production audit
(0 vulnerabilities), and 4097/4101 unit/integration tests (117 skipped by
design). The campaign introduced zero regressions. Four test failures and
two unhandled errors remain — ALL attributable to the concurrent session's
Sep 20-21 work (master glue, send-PDC, offline tail pin, in-flight mic
input-gain feature), none touching campaign-touched surfaces, none blocking
internal dogfooding. They DO block a public release until the owner
resolves them (list below).

---

## GATE RESULTS (2026-09-21, 20:28-21:52)

| Gate | Result | Evidence |
|---|---|---|
| tsc --noEmit (strict, whole tree) | PASS | 0 errors after the concurrent session's harmony test imports were cleaned (mechanical fix committed `6668a0a`) |
| Full Vitest suite | 4097 passed / 4 failed / 117 skipped (394 files, 82 min) | failures itemized below, all Sep 20-21 concurrent-session surfaces |
| npm run build | PASS | entry 364/1070 KB, DAW chunks 2374/2400 KB, semantic 568/650 KB, core worklets 111/150 KB, landing route 546/600 KB, precache 116 entries / 10.9 MB |
| release:preflight (NODE_ENV=production, explicit CORS_ORIGIN) | PASS | production config + shipped-artifact branding scan clean after the VocalForge leak fix (`6668a0a`) |
| release:server-smoke | PASS | real entrypoint health/CORS/origin/admin contract |
| npm audit --omit=dev | PASS | 0 vulnerabilities |

---

## BLOCKING-FOR-PUBLIC-RELEASE ITEMS (concurrent-session surfaces)

1. **send-PDC cleanup regression (MEDIUM, deterministic)** —
   `tests/send-pdc.test.ts` 2/8 fail: removing a send no longer drops its
   PDC delay node, and group-route disconnect on move/delete is broken.
   Reproduces in isolation and in worktree bisect (introduced between
   `a5b7ec4` 2026-09-20 and HEAD during the group-routing/LFO churn;
   exact commit unresolvable — the bisect flaked). Impact: stale DelayNodes
   accumulate per send edit (memory + audio-path risk). Owner: concurrent
   session.
2. **Offline tail default stale source-pin (LOW)** — `tests/offline-parity.test.ts`
   pins the old literal `options.tailSeconds ?? 2`; renderer now uses
   `resolveRenderTailSeconds(doc)` (intentional change in `eba23cf`). Update
   the pin to the new accessor (the intent — offline tail ≥ live tail —
   still holds).
3. **master glue fallback assertion (LOW)** — `tests/master-finish.test.ts`
   expects threshold 0 after the GLUE toggle-off, gets -6; the concurrent
   safetyLimiter work parked values differently. Owner decision: fix either
   the park behavior or the expectation.
4. **Unhandled errors in-run** — `recorder.getInputLevel is not a function`
   (ArrangementPanel timer vs the in-flight mic input-gain feature's mock)
   and one tinypool worker exit (environmental, 82-min run on a shared
   machine).

## NON-BLOCKING KNOWN RISKS (carried from campaign)

- DAW JS chunk budget headroom is 26 KB (2374/2400) — next feature lands
  over budget; re-chunk or raise deliberately.
- AI session worker singletons are resident by design (semantic holds the
  118 MB model once used) — documented in GOAL 10.
- The campaign's flaky-fixture fix (snapshot seq) needs one clean full-suite
  confirmation; this run's composition did not exercise the old flake.
- Dual ORT trees accepted (both lazy, wasm never precached; ~650 KB lazy
  cost for semantic users only).
- Ranker remains shadow-by-default pending the human golden re-review
  (product decision, unchanged this campaign).

## CAMPAIGN DELIVERABLES THIS RUN (re-run 3, GOALs 01-11)

- Provenance reader/writer seam fix (gallery REGEN/REMIX/genre chips live
  for the first time on real beats) + first no-hand-stamped regen chain test.
- Intent router: targeted production intents now beat global mix when the
  user names a target; `?regen=1` chain locked end-to-end.
- Resilience: boot survives AudioContext refusal; crashed-take staging
  pruned after 30 days; write-failure surfacing verified end-to-end.
- State integrity: collab pre-sync command buffer (kills the fragment/
  self-seed/hasRemote self-write family); user-sample render readiness
  (freeze no longer bakes silence); offline scene-BPM per-window scheduling
  (AudioParam runtimes).
- Contracts: gallery intent metadata server/client matrix; bank sample
  re-upload hook (+ detachBank leak fix); collab offline-adopt snapshot.
- Robustness/integrity: format fuzz suite; 57-command undo round-trip
  sweep (+ setGroove absence fix); PCM chunk-ack proven under IDB latency;
  deterministic snapshot fixture.
- Security/lifecycle: npm audit 0; stale artifact untracking; VocalForge
  legacy branding purged from the shipped ZYVO path (found by the gate).

---

## VERIFICATION LOG

- Full-suite log: this run's vitest output (82 min, 394 files).
- Build log: budgets as tabled; artifacts in dist/.
- Commits this campaign (re-run 3): a91ad77, 3aa6bba, 41a0417, fe39f8f,
  0857b82, 41c461b, 46c9e97, eb87fa2, 1e579bf, c3ae155, 1c48769, aa31897,
  8b2b3e4, 0ed2469, f6c89f9, d22203d, b49c041, 6673829, f70e4e0, be48953,
  6668a0a (interleaved with the concurrent session's commits, all verified
  in HEAD).
