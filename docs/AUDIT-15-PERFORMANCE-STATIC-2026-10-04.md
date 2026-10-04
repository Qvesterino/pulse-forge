# AUDIT 15 (static pass) — PERFORMANCE, 2026-10-04

Static-only pass of the Audit 15 performance scope. **No wall-clock
measurement** — the working tree was under active edit by a parallel session
throughout (36+ changed files, mtimes seconds apart), so any timing number
would have been measured against a moving target. Everything below is either a
code-level fact or a **deterministic count** reproduced in jsdom.

The one item deferred from Audit 16 as "a measured-performance question, not a
demonstrated defect" — forced layout reads per `pointermove` — is now measured.

---

## 1. FINDINGS

### P1 — `ArrangementPanel` does not virtualize; every clip reconciles on every frame (MEDIUM–HIGH)

The audit asks for _excessive rerenders_ under _many clips_. Measured with
`React.Profiler` and a synthetic doc:

| Clips in doc | Clips rendered in DOM | React commits / pointermove |
| ------------ | --------------------- | --------------------------- |
| 1            | 2                     | **1.00**                    |
| 50           | 51                    | **1.00**                    |
| 200          | 201                   | **1.00**                    |

Two facts, and the second is the interesting one:

1. **Commit count is already optimal** — exactly one commit per pointermove, at
   every size. There is no batching waste and no double-commit. Any "optimise
   the drag commit" theory is already refuted by this row.
2. **`renderedClips` tracks `docClips` exactly** (2/1, 51/50, 201/200). The
   panel renders _every clip in the document_, so each of those optimal commits
   reconciles the full clip list. The count is O(1); the **cost is O(clips)**.

This is a real inconsistency inside the codebase: `Sequencer` windows its step
grid to the visible range (`colWindow`) and `PianoRoll` windows its pitch view
(`prView`), both with an overscan and both with a "render everything when width
is 0" fallback. `ArrangementPanel` — the largest component in the repo at
~106 KB — has no equivalent.

**Not fixed here, deliberately.** Adding virtualization to a 106 KB component is
the broad rewrite the audit rules forbid, and it is also the exact file a
parallel session is editing. The defensible action is to record the measurement
and decide deliberately, not to land a half-built window while someone else has
the file open.

### P2 — the forced layout read is _necessary_, and the obvious fix is wrong (RESOLVED AS NON-ISSUE)

Audit 16 left this open. Measured with an instrumented `getBoundingClientRect`
on the lane element:

```
counter positive control: OK (reads after pointerdown=1)
20 lane rect reads over 20 moves = 1.00/move
distinct rects seen: 2;  clip startBar=6  moved=true
```

One read per move — the read-after-write thrash pattern is real. **But** the
probe deliberately injected a container reflow mid-drag (dock resize, panel
open, scroll) and the lane rect genuinely changed: **2 distinct values observed**.

So caching the rect at `pointerdown` would be **wrong** — it would silently land
clips at the wrong bar whenever the viewport moves mid-gesture. A correct
version needs the rect _plus_ invalidation on resize/scroll, which is more
machinery than one read per event justifies. The original decision to defer was
right, and it is now justified by measurement rather than by instinct.

### P3 — the audit's headline scope has no guard at all (HIGH, process gap)

**There is no render-count, rerender-count or commit-count guard anywhere in the
test suite.** Verified by searching the whole of `tests/`: the only hits for
render-related assertions are audio RMS assertions in
`10-generative-track.spec.ts`, which have nothing to do with rendering cost.

The suite has three performance guards, and they cover none of what Audit 15
asks about the main thread:

| Guard                            | Verdict       | Covers                               |
| -------------------------------- | ------------- | ------------------------------------ |
| `fxeq-performance-gates.test.ts` | **Exemplary** | Audio thread DSP cost                |
| `performance-gates.test.ts`      | Real but thin | Intent generation latency (one path) |
| `performance-hardening.test.ts`  | Mixed         | Lifecycle + decorative greps         |

So P1 — a whole-component re-render policy worth 201 DOM nodes per frame at
extreme density — could regress silently tomorrow, and no gate would notice.

### P4 — `fxeq-performance-gates.test.ts` is the model the other guards should follow

Worth recording because it is genuinely excellent and nothing else here is:

- **Self-calibrated ratio**, not wall-clock. Cost is measured against a
  passthrough run taken back-to-back in the same process. The header documents
  why: _"must survive CI machines of wildly different speed AND concurrent load
  (other workers, parallel agents), which inflates absolute wall-clock times
  several-fold."_ On a shared dev machine with parallel agents that is exactly
  the right call.
- **Budgets carry their evidence.** `BUDGET_MORPH_RATIO = 2.4` is documented
  with the pathology it exists to catch: _"the old per-block applyAllParams()
  path measured ~2.4× at HALF the current schema size and would exceed 4×
  today."_ The budget sits in a gap between the known-good and known-bad
  measurements, so the gate discriminates.
- **p95 gated separately** from median, so periodic allocation/GC churn cannot
  hide behind a healthy median.

### P5 — `performance-hardening.test.ts` mixes real tests with greps that cannot fail

Three of its assertions are `expect(source).toMatch(/identifier/)` over source
text, e.g. the song-mode cache test checks only that the strings
`songCacheProject` / `songClipsCache` / `songScenesByIdCache` /
`songPatternsByIdCache` appear, and that one `if (this.songCacheProject === doc)`
line is present.

These are **rename detectors, not behaviour detectors**. Delete the caches and
inline a freshly built `Map` on every tick — a worse implementation — and the
test stays green. They are not wrong to have; they are weaker than they look in
a file that also contains genuinely behavioural tests (idempotent dispose,
coalesced gesture history, diff-cache invalidation).

### P6 — `MAX_SYNC_PREVIEW_MS = 250` is a loose budget for a _synchronous_ gate (LOW)

`performance-gates.test.ts` asserts intent preview latency stays under
`MAX_SYNC_PREVIEW_MS = 250`. For work that blocks the UI thread, 250 ms is past
the point where interaction feels responsive — 100 ms is the conventional
"feels immediate" line and ~250 ms is where lag becomes noticeable to a user.
This is a judgment call, not a demonstrated defect, and the intent pipeline does
real work; recorded as a risk, not a finding.

---

## 2. FIXES

**None.** This pass measured and characterised; it deliberately changed no
product code.

Two fixes that looked justified were rejected on the evidence:

- The per-move layout read (P2) — the probe showed the rect legitimately
  changes mid-gesture, so the obvious optimisation is a correctness regression.
- Clip virtualization (P1) — a broad rewrite of a 106 KB component that a
  parallel session currently has open.

## 3. TESTS ADDED

**None committed.** Measurements ran from a throwaway probe
(`tests/ui/_probe-perf.test.tsx`), removed after the numbers were taken. It
prints with `console.info` and asserts only its own positive controls, so it is
a measurement instrument, not a gate — landing it as-is would be exactly the
"test that cannot fail" trap P5 documents.

The one assertion worth promoting once the tree is quiet is the
`1.00 commit per pointermove` result: it is deterministic, it protects the
behaviour Audit 16 fixed, and it would catch a future batching regression.

## 4. VERIFICATION

| Measurement                                            | Result                                      |
| ------------------------------------------------------ | ------------------------------------------- |
| Counter positive control (reads after `pointerdown`)   | **1** — counter proven live                 |
| Lane rect reads per `pointermove`                      | **1.00** (20 moves)                         |
| Distinct lane rects across a mid-drag reflow           | **2** — read is necessary                   |
| Clip actually moved (guards a meaningless measurement) | `startBar=6`, `moved=true`                  |
| React commits per `pointermove`                        | **1.00** at 1 / 50 / 200 clips              |
| Clips rendered vs. in document                         | **2/1, 51/50, 201/200** — no virtualization |
| Render/rerender guards in the whole suite              | **0**                                       |

### Two probe defects of my own, recorded

Both would have produced confident nonsense:

1. **Instance spy shadows prototype.** `vi.spyOn(lane, ...)` creates an _own_
   property that shadows `Element.prototype`. Counting on the prototype
   therefore saw **0 reads** — a beautiful, clean, completely fake "0.00/move".
   The count has to live inside the instance mock. Caught only because the
   positive control was written.
2. **Counting after teardown.** Measuring `document.querySelectorAll(".arr-clip")`
   after `cleanup()` reported `renderedClips=0` for all three sizes, which would
   have looked like aggressive virtualization — the exact opposite of the truth.

## 5. REMAINING RISKS

1. **No wall-clock audit was performed.** The measured layer — CPU spikes, long
   tasks, memory growth, GC pressure, audio dropouts, scrolling while playing,
   autosave during playback — needs a quiet tree. That is the real Audit 15.
2. **P1 is unfixed and unguarded.** 201 DOM nodes per frame at 200 clips. At
   realistic song density (4-bar clips ⇒ ~60 clips for a 10-minute track) this
   is likely fine; the exposure is pathological density. It is a _cost_ risk,
   not a responsiveness risk, because the commit count is already 1/move.
3. **`rt-monitor-processor` is not registered**, so `renderProject` throws
   `InvalidStateError` in the offline path. This blocks
   `scripts/measure-genre-references.mjs`, which is the only producer of
   `src/intent/audio-targets.generated.ts` — a file that currently exists as an
   **empty object**, so `tests/audio-targets.test.ts` fails 2 of 4 with all 19
   genres reported missing. In progress by another session.
4. **Typecheck is red on another session's in-flight work**, so repo-wide
   "typecheck clean" remains unclaimable; per-file claims were used instead.
5. **`performance-hardening.test.ts`'s source greps give false assurance**
   (P5) and could be promoted to behavioural assertions — or relabelled as
   structural guards so their weaker status is explicit.
