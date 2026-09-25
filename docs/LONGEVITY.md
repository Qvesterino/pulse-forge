# LONGEVITY — the 5-year quality contract

> **Written 2026-09-25, after the cross-platform campaign (13/13 goals), the
> quality waves (typing ×8.9, fault containment, plugin sanity, sound
> coverage 292 → 351 presets), and the first fully green verification bench
> (build EXIT 0 · 5006 tests · 345/345 browser-audible · 0 CVEs).**
>
> This document is the standing answer to one question: _what has to stay
> true for the v5 quality standard to be the same as today's?_ It is a
> contract with future maintainers — including future versions of the AI
> agents that wrote most of this discipline down. Revisit it every year;
> amend it only with a reason written next to the amendment.

---

## 0. The one rule

**Every feature ships with its pin.** A drift test, a golden, a contract
test, or a documented verdict — in the same commit as the feature. An
unpinned feature is half a feature: it works today and silently breaks the
day someone touches its dependencies. This single rule produced more quality
than any tooling investment, and it is the only one in this document that is
non-negotiable.

---

## 1. What provably protects quality — keep doing this

These mechanisms were **validated by incidents**, not by theory. Each one
caught a real defect during the 2026 campaigns.

### 1.1 Drift pins & goldens

- Domain goldens (`tests/domain-goldens/`) replay input → operation →
  expected for param math, transport, commands, serialization, scheduler.
- **Every new subsystem gets a drift pin the same day**: a source-level
  contract check, a golden fixture, or a behavioral sweep. Examples that
  paid off: YDocAdapter drift pin (caught real field loss on first run),
  schema-evolution matrix (pinned the v8 groove-pool incident class),
  sample-contract regex (catches presets pointing at dead samples).
- Goldens are **regenerated only after an intentional change**, and the
  diff is reviewed like code — they are the parity contract for future
  implementations, not snapshots to appease a test runner.

### 1.2 Contracts at the boundaries

- `src/persistence/contracts.ts` (11 `I*Repository`),
  `src/shared/assetUrls.ts`, `src/services/audio-decode.ts`,
  `src/export/download.ts` — the seams a platform port or a backend swap
  replaces. **Boundary contracts are tested like API**: behavior pins, not
  implementation snapshots.
- Rule: a boundary without a contract test is an internal detail pretending
  to be stable. When a seam proves stable across two consumers, promote it.

### 1.3 The verification bench

Full build + budgets + full suite + browser factory-presets QA + npm audit,
run on a quiet tree. Current state (2026-09-25): all green — build EXIT 0
(DAW 2644/2660 KB), 501 files / 5006 tests / 0 fail, 345/345 presets
audible in real Chrome, 0 CVEs.

- It must run **at least once per release wave**, not just during audits.
- It must run **immediately after any dependency major or schema bump**.
- Known standing pressure: DAW JS sat at 2500/2600 before the ceiling was
  raised to 2660 — treat the headroom (16 KB at last check) as a shared
  resource, not free space.

### 1.4 Honest verdicts (no silent ignoring)

Every finding gets one of: **FIXED**, **DEFERRED (with implementation
map)**, or **CLOSED (documented verdict — intentional)**. Silent ignoring
is the one forbidden state. Precedents: the glue-park "bug" that was proven
upstream-correct and reverted (STATE-MACHINES §1); A5 freqShifter Hz-scale
verified correct for a linear-Hz device; A9 dB/threshold ranges closed as
deliberate voicing. Reverting your own fix when the evidence contradicts it
is a legitimate, honorable outcome.

### 1.5 The race protocol (parallel sessions)

Two agent sessions (or two humans) editing one repo is the **default mode
of this project**, not an anomaly. Proven over 5+ absorption incidents:

- Commit early, **explicit paths only**, never `git add -A`.
- After any foreign commit: **re-verify your files in HEAD** (diff the
  regions you touched — absorption is proven, corruption is caught).
- Their in-flight breakage is **theirs** — filter by file, never fix their
  zones; stash-isolate before claiming a failure is yours.
- Exact-match edits are **moving-target sensitive** (a foreign commit can
  rewrite the region between your read and your write). Non-destructive
  throw-before-write scripts + re-run on the settled tree.

---

## 2. What will rot in 5 years — ranked risks and standing mitigations

### 2.1 The schema ladder (risk: user data — the highest stakes)

By v5, SCHEMA_VERSION may climb from 3 to ~10. The one-way door:

- **Every bump gets a real migration step** in `migrateProject` — never
  "normalize fixes it". The normalize-based compat is documented
  (PERSISTENCE-SCHEMAS §1) as _tolerated until the first breaking change_.
- Every version gets **round-trip fixtures**: a doc saved under version N
  loads byte-consistently under N+1, N+2, … (extend
  `tests/persistence/schema-evolution.test.ts`).
- Per-version **golden docs** live with the goldens (decode pins already
  prove v1 codes decode identically under v3 — keep that property).
- Never bump without a round-trip test that **fails first** on a naive
  load.

### 2.2 Dependency majors (risk: build + runtime breakage en masse)

React, Vite, yjs, onnxruntime-web, @huggingface/transformers, lame-wasm —
expect at least one breaking major per dependency per year.

- **Rule: dependency bumps never share a commit with features.** Bump,
  run the full bench, fix, commit — separate.
- The adapter seams (GOAL 03) are the containment: if a major breaks a
  boundary, the fix lands behind the contract, not across the codebase.
- ONNX runtimes are the heaviest (two parallel trees, 640/650 KB budget) —
  a consolidation attempt is a dedicated session with its own parity proof.

### 2.3 Test scale (risk: the gate becomes too slow to trust)

501 files / 5006 tests today. At ~4× this size, single-process runs stop
being a ritual people wait for.

- Shard the suite (per-directory workers) **before** it hurts, not after.
- Keep the fast targeted batches viable: the harness pattern
  (`tests/domain-goldens/harness.ts` — capture/replay share one code path)
  scales to new families cheaply.
- Preserve the **race-protocol test discipline**: exact-match scripts
  throw before write; a 10-space generic match is a substring of a 16-space
  line (learned twice in Session B2/B3).

### 2.4 Platform drift (risk: Web Audio / browser evolution)

The fail-soft pattern (`typeof X !== "undefined"`, capability-gated
degradation) is the correct 5-year stance — keep it. Watch specifically:

- AudioWorklet spec/implementation changes (the processors are JS — that
  is the portability).
- Safari/iOS audio session quirks (already bounded: recorder resume
  timeout, visibility resume, AudioUnlock).
- The `pointer: coarse` touch adaptations — mobile is a real target
  (MOBILE-READINESS documents zero architecture blockers).

### 2.5 Documentation rot (risk: the maps stop matching the code)

The seven campaign documents + QUALITY-BACKLOG are only valuable while
they match reality. Rule: **a session that changes a documented subsystem
updates its document section in the same commit** — proven across 10
sessions (every goal updated its section in-lockstep with the code).

### 2.6 Backlog reflux (risk: "empty backlog" invites skipping the audit)

QUALITY-BACKLOG.md is empty as of 2026-09-25. It will not stay empty —
**re-run the three audits every ~3 months**: sound coverage (new holes),
plugin parameter sanity (new knobs), performance at scale (new hot spots).
The audit method is proven; the findings feed new A/B/C/D rows.

---

## 3. Known deferred items (the honest list at closure)

Carried in QUALITY-BACKLOG / report §3 — not bugs, but unfinished choices:

- **A6-class storage migrations** need a dedicated session per flagship
  (the implementation map for the mix-scale pattern is in the backlog row
  as the template).
- **~28 worklet node factories** lack `onprocessorerror` (only
  createWorkletRuntime + PcmMicRecorder are wired — see
  `src/audio-worklets/processor-errors.ts`).
- **iOS long-press** for right-click-only workflows (clip menu, marker and
  automation-point deletes — dead on iOS; `useLongPress` is the generic
  pattern to reuse).
- **Bounce-to-clip persistence failure** is console-only (needs a
  session-scoped warning channel).
- **Latency probe** has no synthetic test (HIGH risk: recordings drift
  off-grid on silent failure).
- **E2E 02/07 spec triage** and **DAW JS headroom** (16 KB at last bench).
- **Collab**: no reconnect logic (feature absent); relay-down degrades to
  local editing — the "offline, edits stay local" message is queued.

---

## 4. What NOT to do (the anti-patterns that would cost the standard)

1. **No rewrite.** "KYX v5 on a new framework" would discard 351 presets,
   5006 tests, 8 documents of maturity, and every pin. The contracts exist
   so a port can _reuse_ behavior — not so the web app gets thrown away.
2. **No speculative abstractions.** The A6 deferral is the template: touch
   storage semantics only when a breaking change forces it, with the map
   written first. Abstraction before the second consumer is guesswork.
3. **No feature without its pin** (§0).
4. **No broad catch blocks.** Failures stay contained with named errors —
   FAULT-CONTAINMENT is the standard; silent drops are how the
   beatMangler automation bug lived undetected.
5. **No dependency bump riding a feature commit.**
6. **No "fix later" without a written row.** Later is the backlog file,
   not memory.
7. **Never fix the parallel session's in-flight zones** — stash-isolate
   before claiming ownership of a failure; re-run on the settled tree.

---

## 5. The annual ritual (one session, once a year)

1. Re-run this file against reality: are the §1 mechanisms still in place?
2. Re-read the §2 risks: did any mature into an incident?
3. Re-verify the §3 deferred list: still deferred? Still the right call?
4. Re-run the verification bench and record the numbers here.
5. Update the year: "revisited 2027-09-25 — verdict: standard holds" (or
   the amendments, each with a reason).

---

## 6. Where everything lives

| Concern                                | Document / location                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Portability seams & platform map       | `docs/PORTABILITY_MAP.md`                                                                                |
| Boundary contracts                     | `docs/PLATFORM-CONTRACTS.md` + `src/persistence/contracts.ts`                                            |
| State machines & fault map             | `docs/STATE-MACHINES.md`, `docs/FAULT-CONTAINMENT.md`                                                    |
| Persistence inventory & schema policy  | `docs/PERSISTENCE-SCHEMAS.md`                                                                            |
| Parity fixtures & capture workflow     | `docs/GOLDEN-PARITY.md`, `tests/domain-goldens/`                                                         |
| Mobile readiness                       | `docs/MOBILE-READINESS.md`                                                                               |
| Capability matrix / readiness / slices | `docs/PLATFORM_CAPABILITY_MATRIX.md`, `CROSS_PLATFORM_READINESS_REPORT.md`, `docs/PORTING-SLICE-PLAN.md` |
| Live issue backlog                     | `docs/QUALITY-BACKLOG.md` (empty = healthy)                                                              |
| Work history                           | `AGENT_WORK_LOG.md`                                                                                      |
| Session coordination                   | `CAMPAIGN_STATE.md`                                                                                      |

---

_Final note: the strongest asset is not in this list. It is that every
mechanism above was **validated by catching a real defect** during the
2026 waves — not adopted from a book. Keep that standard: a mechanism that
has never caught anything is dead weight; a pin that just caught something
gets documented here._
