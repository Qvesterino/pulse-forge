# 06 — The realtime budget's device floor

**Audit:** HIDDEN_CREATIVE_POWER_AUDIT (§10.16.9 of `HIDDEN_CREATIVE_POWER_AUDIT_REPORT.md`)
**Measured:** 2026-10-30, on Windows (`D:\pulse-forge`) and on a 2-vCPU GitHub runner (Linux).
**Instrument:** `src/browser-checks.ts` → `auditRtBudget` (committed in `80cb40ee`).

---

## 1. What this file is

The raw measurements behind §10.16.9 of the audit report: **the realtime budget's verdict, the device floor it is now judged
against, and the build/steady split of the dropped quanta.** Everything below is copied verbatim from a run — no line is
transcribed by hand.

The instrument measures three windows on **one context, one rt-monitor, one wall-clock window**:

| window       | graph                   | why                                                    |
| ------------ | ----------------------- | ------------------------------------------------------ |
| floor (cold) | 1 track, **no effects** | the device's own floor, before anything is loaded      |
| floor (warm) | 1 track, **no effects** | the same graph again, to drop the context's cold start |
| graph        | 12 tracks × 4 effects   | the thing under test                                   |

Every count is a **delta between two reads**, because the processor's `blocks` / `droppedQuanta` are cumulative for the life of
the processor (`src/audio-worklets/rt-monitor-processor.js:32-33`) and `resetRtLoad()` only resets the host-side mirror
(`src/audio-worklets/rt-monitor-node.ts:111-123`).

---

## 2. The four desktop runs

### 2.1 This session, run A — contended box (first instrument, no jitter in the line)

```text
PASS perf environment: this machine's timing is measurable — calib=15.5ms (floor 18ms) spread=1.1× (max 2×) — environment=measurable, the budget checks below are gated
FAIL perf: techno — 8-bar render within budget — 21964ms for 14745ms audio (budget 13271ms, 1.49× realtime)
FAIL perf: 8-bar render average across all templates — avg=9118ms worst=21964ms over 14 templates; aggregate=0.56× realtime
PASS rt budget: 12 tracks × 4 effects realtime — blocks=768 xruns=0 heartbeat avg=225.85ms max=252.20ms (expected≈170.67ms, 1.32×) quantum=2.667ms · device floor xruns=0 (1 track, no effects; cold 0 / warm 0) · graph build=0 steady=0
FAIL perf: 8 tracks × 4 effects render stays within baseline + headroom — 17996ms vs 2987ms single-track baseline for 16500ms audio (budget 14987ms, 6.02× baseline)
```

### 2.2 This session, run B — quiet box (final instrument)

```text
PASS perf environment: this machine's timing is measurable — calib=12.0ms (floor 18ms) spread=1.0× (max 2×) — environment=measurable, the budget checks below are gated
FAIL perf: techno — 8-bar render within budget — 13641ms for 14745ms audio (budget 13271ms, 0.93× realtime)
FAIL perf: 8-bar render average across all templates — avg=8346ms worst=19086ms over 14 templates; aggregate=0.52× realtime
PASS rt budget: 12 tracks × 4 effects realtime — blocks=704 xruns=0 heartbeat avg=252.68ms max=367.40ms (expected≈170.67ms, 1.48×) quantum=2.667ms · device floor xruns=0 jitter=1.00× (1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=0
FAIL perf: 8 tracks × 4 effects render stays within baseline + headroom — 16624ms vs 2563ms single-track baseline for 16500ms audio (budget 14563ms, 6.49× baseline)
```

### 2.3 Parallel session — committed artifact (`74a1d8dd`)

```text
PASS perf environment: this machine's timing is measurable — calib=14.1ms (floor 18ms) spread=1.0× (max 2×) — environment=measurable, the budget checks below are gated
FAIL perf: techno — 8-bar render within budget — 13839ms for 14745ms audio (budget 13271ms, 0.94× realtime)
FAIL perf: 8-bar render average across all templates — avg=8624ms worst=13839ms over 14 templates; aggregate=0.53× realtime
PASS rt budget: 12 tracks × 4 effects realtime — blocks=832 xruns=0 heartbeat avg=216.15ms max=269.70ms (expected≈170.67ms, 1.27×) quantum=2.667ms · device floor xruns=0 jitter=1.00× (1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=0
FAIL perf: 8 tracks × 4 effects render stays within baseline + headroom — 17944ms vs 2938ms single-track baseline for 16500ms audio (budget 14938ms, 6.11× baseline)
```

Source: `docs/audits/2026-10-29-browser-audit/browser-audit-3328668c-plus-rt-floor-loaded.log`. **Provenance caveat:** that log was
produced against a working tree that also contained the uncommitted instrument, so its name says `head-3328668c` and its bytes
came from a later state. The `77/77` parity line in it is unaffected; the realtime line is by construction this instrument's.

### 2.4 The 2026-10-29 tree — the run in which the offline budgets passed

```text
PASS perf environment: this machine's timing is measurable — calib=12.3ms (floor 18ms) spread=1.1× (max 2×) — environment=measurable, the budget checks below are gated
PASS rt budget: 12 tracks × 4 effects realtime — blocks=960 xruns=0 heartbeat avg=179.69ms max=215.30ms (expected≈170.67ms, 1.05×) quantum=2.667ms
```

(The three offline budgets passed here — their numbers are in §4's table.) This run predates the instrument, so its line carries
neither a floor nor a window-scoped `blocks`.

---

## 3. The CI runner

### 3.1 The red that started this — old instrument

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=960 xruns=7 heartbeat avg=184.39ms max=188.30ms (expected≈185.76ms, 0.99×) quantum=2.902ms
```

### 3.2 The instrumented run — commit `e40253f3`, "Browser audio checks (Chromium)"

Read from the job's **error annotation** (one API request; no logs API was used):

```text
failing checks: 1 FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=960 xruns=1 heartbeat avg=186.16ms max=212.70ms (expected≈185.76ms, 1.00×) quantum=2.902ms · device floor xruns=0 jitter=1.00× (1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
```

**What that one line says:**

- `device floor xruns=0 jitter=1.00×` — the runner holds an **empty** graph perfectly and delivers the heartbeat exactly on
  cadence. **The runner can measure**, so by §10.16.2's rule ("the environment must explain the gate, never fail it") it
  deserves a **gated** verdict. The red is legitimate.
- `graph build=0 steady=1` — the single dropped quantum is in the **play** window, not in the construction. The old
  `xruns=7` counted from the processor's creation and so swept the construction in; it was never decomposable.
- `blocks=960` is now the **window**, not the count since the context was created.

---

## 4. The environments fail each other's checks

| check                   | 2026-10-29 idle run (`82f59555`, desktop) | current tree (desktop)                           | current tree (runner) |
| ----------------------- | ----------------------------------------- | ------------------------------------------------ | --------------------- |
| realtime budget         | ✅ 1.05×                                  | ✅ **0** xruns / ❌ **1** xruns / ❌ **1** xruns | ❌ `xruns=1`          |
| `perf: techno`          | ✅ 9015 ms                                | ❌ 13839 / 13641 / 21964 ms                      | ✅                    |
| `perf: 8-bar average`   | ✅ avg 4708 ms (aggregate 0.29×)          | ❌ avg 8624 / 8346 / 9118 ms                     | ✅                    |
| `perf: 8×4 vs baseline` | ✅ 10697 ms vs 2284 ms (**4.68×**)        | ❌ 17944 / 16624 / 20701 ms                      | ✅                    |

**IN PLACE (2026-10-30, evening): the middle column's ORIGINAL values were withdrawn as untraceable.** This file first carried
`10509 ms / avg 5197 ms / 13915 ms (5.45×)` for the 2026-10-29 tree. A search of every `*.log` under `docs/audits/` finds
**`10509`, `5197` and `13915` in no artifact at all** — they reached this file from a session message whose run was never
committed to a log. They are **withdrawn**. The replacement column is the tracked idle log
`browser-audit-head-82f59555.log` (commit `82f59555`, 2026-10-29 10:31, **439/439 green**), which carries the **same 77-case
corpus** as every later log — so it is also the fact that **the corpus size cannot explain** the later reds (the parallel
session's own commit `c0400b33` added a **third offline render per case**, and that is what made the run heavier; it has since
been fixed by the constant capture frame, `CAPTURE_LEAD_FRAMES` in `src/testing/live-offline-parity.ts:88-122`).

The runner's job reported **`failing checks: 1`** — only the realtime budget. On the desktop the three offline budgets **fail**.
**Same tree, same checks: each environment fails exactly what the other passes.**

**And the device floor is clean in every environment — the device is never the excuse:**

| environment                    | device floor   | realtime verdict | offline verdict |
| ------------------------------ | -------------- | ---------------- | --------------- |
| desktop, this session (12.0ms) | 0 xruns, 1.00× | ✅ **0** xruns   | ❌ 3 red        |
| desktop, parallel (13.3ms)     | 0 xruns, 1.00× | ❌ **1** xruns   | ❌ 1 red        |
| CI runner, 2-vCPU Linux        | 0 xruns, 1.00× | ❌ **1** xruns   | ✅ 3 green      |

The parallel session's fresh run at HEAD `3328668c` (`d5480075`,
`docs/audits/2026-10-29-browser-audit/browser-audit-3328668c-plus-rt-floor.log`):

```text
FAIL rt budget: 12 tracks × 4 effects realtime — OVER BUDGET — blocks=896 xruns=1 heartbeat avg=197.32ms max=221.70ms (expected≈170.67ms, 1.16×) quantum=2.667ms · device floor xruns=0 jitter=1.00× (1 track, no effects; cold 0/1.00× / warm 0/1.00×) · graph build=0 steady=1
FAIL perf: 8 tracks × 4 effects render stays within baseline + headroom — 20701ms vs 3604ms single-track baseline for 16500ms audio (budget 15604ms, 5.74× baseline)
```

**The graph drops exactly one quantum in two of the three runs**, on two operating systems and two CPU budgets. The 12×4 realtime
graph sits **on** the boundary — it either makes it or misses by one quantum. The jitter tells the same story from the continuous
side: **1.16×, 1.27× and 1.48×** against a 1.5× limit across three runs of one tree.

**And the render path did not change.** Between the 2026-10-29 tree and the current tree:

```text
git log --since=2026-10-29 07:00 -- src/rendering src/audio-engine src/project-model src/effects src/audio-worklets
→ (no commits)
```

The two parity fixes (`c0400b33`, `db28fffa`) touched only `src/testing/live-offline-parity.ts` and test files. What **did**
change is the weight of the run before the budgets: the parity corpus grew **67 → 77 items**, each one an offline render plus
a realtime capture, all in the same browser page before the perf section opens.

**Mechanism: _Not verified._** Heap growth and GC pressure is the obvious candidate, but `calib` is a pure CPU spin and cannot
see the allocator or the collector, so it cannot confirm it.

---

## 5. What the floor changes

Without the floor, `xruns=7` on the runner and `xruns=0` on the desktop are two numbers about two machines, and the reading
"the runner is too slow" is available. **With** the floor, both environments report a **clean device** (0 xruns, 1.00×
jitter) and the difference moves to the graph — which sits at **1.27×–1.48×** of the jitter limit on the desktop and drops
**one quantum in 960** on the runner. The finding is a **capacity** finding, not a machine excuse.

## 6. Reproduction

```bash
# the whole browser gate (the perf section is near the end; the rt line is the one that matters)
PORT=5219 npm run test:browser

# the runner's line (error annotation; no logs API needed)
#   GET /repos/Qvesterino/pulse-forge/commits/e40253f3/check-runs
#   GET /repos/Qvesterino/pulse-forge/check-runs/<id>/annotations
```

The realtime budget's own message carries everything this file quotes: `device floor xruns=… jitter=…` (cold/warm),
`graph build=… steady=…`, the window-scoped `blocks`, and the heartbeat jitter against its expected cadence.
