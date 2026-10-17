# Taste Benchmark

> Wave E2 of the intent campaign. Fixed prompt set, real pipeline, objective
> score, committed baseline. This document is the protocol: what the score
> claims, what it refuses to claim, and how it is re-blessed.

## What it is

`npm run taste:benchmark` runs ten fixed prompts (EN + SK) end-to-end through
the **real deterministic pipeline** — parser → plan → candidate generation →
invariant gates → ranker → E1 selection rationale — twice per case, and grades
every case on five objective checks:

| Check           | Question it answers                                              |
| --------------- | ---------------------------------------------------------------- |
| `accepted`      | Did the run produce a proposal at all?                           |
| `genre`         | Did a prompt that NAMES a genre land in that genre?              |
| `candidates`    | Did a multi-candidate run actually build a usable bank?          |
| `deterministic` | Does the second run reproduce the first run's winner hash?       |
| `rationale`     | Is the E1 "why this candidate" rationale attached and non-empty? |

`score = passed checks / all checks` across the set. The committed baseline in
`scripts/data/taste-benchmark.baseline.json` is that score plus every row's
winner hash and rationale; the vitest suite (`tests/taste-benchmark.test.ts`)
re-runs the harness and fails on **any non-timing drift**.

## What it explicitly does NOT claim

- **It does not grade musical quality.** No automated metric can. The
  `humanGrades` field in the baseline exists for the listening protocol and is
  `null` until a human fills it — the harness never writes it.
- **It does not measure the model.** The benchmark runs the deterministic core
  (no symbolic prior, no ONNX). A model-dependent score could not be a stable
  committed baseline; each row records the ranker path it ran under
  (`rankerMode` / `rankerSource`), so a model appearing under the benchmark
  shows up as drift on that field instead of silently changing the score's
  meaning.
- **Timing is informational.** `ms` / `p95Ms` are printed but excluded from
  drift comparison (machines differ).

## Workflow

```bash
npm run taste:benchmark        # run + compare to the baseline (exit 1 on drift)
npm run taste:benchmark:bless  # review the report, then re-bless deliberately
```

Re-blessing preserves `humanGrades`. A drift report names the case and the
field (`selectedHash`, `rationale`, `rankerSource`, …) — fix the regression, or
bless the improvement on purpose. Never edit the baseline by hand.

## Why this exists

It is the regression lock for the two halves of the taste loop shipped so far:
the E1 rationale must stay attached (a silently dropped explanation fails the
run), and the deterministic winner must stay stable (a generator or gate change
that moves a winner is visible in the diff instead of being discovered by ear).
