# PERF GATE GUARD — the measured bands behind the change (2026-10-30)

Why this folder exists: the perf gates in `src/browser-checks.ts` changed their
FORM in `fe7c3473` — the guard is now the workload's own baseline bracket, and
the shape gate reads the mean of the three heaviest templates instead of the
single heaviest one. Both decisions rest on numbers, and these are the
numbers, with the two scripts that recompute them.

Both scripts read the committed audit logs under `docs/audits/` and need no
other input:

```bash
node docs/audits/2026-10-30-perf-gate-guard/shape-band.mjs
node docs/audits/2026-10-30-perf-gate-guard/shape-burst.mjs
```

## 1. `shape-band.ps1` — the measured distribution shape

It parses every committed run log that carries the 14 per-template render
costs (`perf: <id> — 8-bar render cost|within budget — <n>ms for`) and
computes three statistics of the same set:

| statistic                            | measured band over the runs | budget |
| ------------------------------------ | --------------------------- | ------ |
| heaviest template / average          | 1.57× – 2.41×               | 3×     |
| mean of the two heaviest / average   | 1.53× – 2.13×               | 3×     |
| mean of the three heaviest / average | 1.51× – 1.98×               | 3×     |

The single heaviest template is a per-ITEM extreme. Per-item numbers on this
repo move by up to 2.6× between adjacent runs (the same template measured
6642 ms and 17460 ms), so the extreme carries the noise while the mean of the
top three carries the signal.

## 2. `shape-burst.ps1` — the falsification axis

It replays each measured template set with ONE template 2.6× slower (the
measured per-item spread) and asks which statistic would have gone red at the
3× budget:

| statistic                            | band under the burst | verdict                                   |
| ------------------------------------ | -------------------- | ----------------------------------------- |
| heaviest template / average          | 3.45× – 4.91×        | **over the budget in every measured set** |
| mean of the two heaviest / average   | 2.38× – 3.14×        | over the budget in one set                |
| mean of the three heaviest / average | 1.99× – 2.54×        | under the budget in every set             |

Three is the smallest k that survives the burst everywhere, and it keeps the
gate's teeth: a structural regression moves the heavy tail as a group.

## 3. The machine's own movement — the bracket

The same logs carry the machine's state per run: the single-track baseline
moved **2268 ms → 9133 ms (4.03×) between runs** of the same tree, while
inside one run the bracket's spread was **1.01× and 1.16×**. That gap is why
the gates compare the budget against the BAND the measurement can occupy
(measured/spread … measured×spread) instead of its point estimate, and why a
reading the machine's movement alone explains is reported rather than gated.

Measured on the peer run of 2026-10-30 (`rt-boundary-run1-single-pass.log`):
average 2.17× with spread 1.01× → PASS; dense 5.38× with spread 1.16× → PASS
(worst reading 6.22× against a 7.5× budget).

Local verification of the change (clean worktree at `fe7c3473`, PORT 5405,
437 of 440 checks passed — the three failures are the realtime budget and two
sibling-repo overlay failures, none of them these gates):

```
PASS perf: 8-bar render average stays within the single-track baseline ratio — avg=5924ms worst=12359ms over 14 templates vs 2340ms single-track baseline (2.53×, budget 3×; baseline bracketed 2257–2426ms, 3 readings, spread 1.07× → the same measurement reads 2.36×–2.72×); aggregate=0.37× realtime
PASS perf: the three heaviest templates stay in proportion to the average — three heaviest average 10174ms = 1.72× the average (budget 3×; spread 1.07× → the same measurement reads 1.60×–1.85×)
PASS perf: 8 tracks × 4 effects render stays within the baseline ratio — 13535ms vs 2379ms single-track baseline for 16500ms audio (5.69× baseline, budget 7.5×; baseline bracketed 2306–2451ms, spread 1.06× → the same measurement reads 5.35×–6.05×)
```
