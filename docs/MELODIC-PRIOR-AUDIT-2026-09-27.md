# MELODIC PRIOR AUDIT — 2026-09-27

**Scope:** `symbolic-melodic-v1` (shipped default) and `symbolic-melodic-v2`
(shipped fallback) — the NEXT-NOTE ONNX priors behind the Intent Engine's
melodic branch.
**Method:** read-only error analysis on the shipped artifacts
(`scripts/audit-melodic-prior.py`), failure-mode breakdown
(`scripts/audit-melodic-duration-collapse.py`), a leakage check
(`scripts/audit-melodic-leakage-check.py`), a retrain gate that trains fresh
models per fold (`scripts/gate-melodic-retrain.py`) and a finite-difference
gradient check (`scripts/audit-melodic-double-weight-proof.py`).
**Verdict:** both trainers contained a **real gradient bug** in the duration
head (proven, fixed, retrained). The first pass of this audit also had a
**methodology error of its own** — section 3 records it.

---

## 1. Headline findings

| # | Finding | Evidence |
| - | ------- | -------- |
| 1 | **The v2/v1 comparison is not apples-to-apples.** v1's shipped artifact trained on **190** samples (ds.v1), v2 on **239** (ds.v2). The library grew between the two training runs, so "v2 regressed" partly means "v2 saw different data". | `symbolic-melodic-validation.json` (`samples: 190`) vs `symbolic-melodic-v2-validation.json` (`samples: 239`) |
| 2 | **The shipped 15 % split validates on 29 rows in 4 groups.** Any single valDegreeAcc from it is noise-dominated (95 % CI ≈ ±18 pp). | `audit-melodic-prior.py`: `val split: 29 rows in 4 groups` |
| 3 | **v2's DURATION head collapsed toward the rare class** — worse than the majority baseline. | honest: v2 dur **0.3793** vs majority 0.4997; 55 predictions for 12 truths of class 8 |
| 4 | **Root cause: a double-multiplied class weight** in the duration gradient (`train-symbolic-melodic.py:105`). The head effectively optimises `wt²`, amplifying the relative pull toward rare classes by up to **10.2×**. | finite-difference check: analytic norm 0.0224 vs true 0.1463 on the buggy path |
| 5 | **The bug is fixed and the retrained v2 passes the gate.** | honest split: degree 0.4828 → **0.5517**, duration 0.3793 → **0.5517** (§4) |
| 6 | **Data gaps**: degree classes `d1`/`d5` have **zero** validation examples; duration-8 has 12 samples in the whole library. | `audit-melodic-prior.py` per-class recall |

## 2. Error breakdown (v1, shipped 29-dim artifact)

Numbers from `audit-melodic-prior.py`, evaluated on the trainer's own split so
they are comparable with the manifest report.

```
by genre (val rows):   house n=16 deg=75.0% dur=100.0%
                       trap  n= 7 deg=85.7% dur= 85.7%
by role (val rows):    bass  n=16 deg=93.8% dur= 93.8%
                       lead  n=13 deg=38.5% dur= 76.9%   <-- weakest axis
by context:            seq start (prev=rest) n=7  deg=42.9%
                       mid-sequence         n=22 deg=77.3%   <-- 34 pt gap
calibration:           mean confidence 0.743 vs accuracy 0.690 -> over-confident
```

**Weakest axes, in order:**

1. **Lead role (38.5 %)** — the model is a bass/anchor predictor, not a
   melody predictor. Bass is nearly solved (93.8 %); lead is barely above chance.
2. **Sequence start (42.9 %)** — with no history the model guesses. The
   template engine's opening bar is therefore where the prior contributes least.
3. **Degree classes d4 / d6 (40 % / 0 %)** — high scale degrees have almost no
   validation examples (d1 and d5 have *zero*), so per-class numbers there are
   not yet meaningful; the classes need more library coverage before they can
   be judged.

**Not a weakness:** duration. v1 duration is solid (86 % on val, all four
classes used).

## 3. Methodology correction (this audit's own error)

The **first version of this document** reported v2 degree **0.7521** and called
it "better than v1". That was a **leakage artefact**, caught by
`audit-melodic-leakage-check.py` while building the retrain gate:

| metric | rows the model trained on | rows it never saw (honest) |
| ------ | ------------------------- | -------------------------- |
| v2 degree | 0.7952 | **0.4828** |
| v2 duration | 0.4667 | **0.3793** |

A *shipped* model was trained with one specific 15 % split held out. Evaluating
it on all 5 k-fold splits therefore measures **training accuracy** on every fold
that does not contain those 4 held-out groups — 210 of 239 rows. The k-fold
number averaged leaked and honest rows, inflating the result.

**Consequence:** only a **freshly trained model per fold** (the retrain gate)
gives an apples-to-apples comparison between recipes. All corrected numbers in
this document come from that gate.

## 4. The fix (applied and verified)

Two changes to `scripts/train-symbolic-melodic.py`, with the hot path extracted
to `scripts/train_symbolic_melodic_lib.py` so the gate trains through the exact
same code:

### 4a. Remove the double weight (correctness)

Line 105 multiplied the duration gradient by `(wt / n)` a second time. Deleted.
The finite-difference check now passes: the analytic gradient matches the loss
being printed.

### 4b. Temper the class weights (stability)

`--weight-power` (default 0.5) replaces linear inverse frequency with
square-root tempering: the rare/common weight ratio drops **10.2× → 3.2×**.
Chosen by measurement, not taste — the gate was run at 0.5 and 1.0 (§5).

### Measured result (shipped 15 % split, apples-to-apples)

| head | shipped v2 | retrained v2 | delta |
| ---- | ---------: | -----------: | ----: |
| degree | 0.4828 | **0.5517** | +0.0689 |
| duration | 0.3793 | **0.5517** | +0.1724 |

Both heads now use their full class range (8/8 and 4/4). Train fit is 0.802 /
0.900, so the model is not over-fitting. `node scripts/validate-symbolic-melodic.mjs v2`
passes; `weightPower` is recorded in the manifest for provenance.

## 5. Recipe comparison (gate runs)

Pre-registered gate: duration ≥ majority baseline (0.4997), degree ≥ shipped v2
(0.4828), no class collapse.

| recipe | degree | duration | verdict |
| ------ | -----: | -------: | ------- |
| one-hot, power 1.0 | 0.4854 | 0.6067 | PASS (k-fold) |
| one-hot, power 0.5 | 0.4812 | 0.5941 | PASS (k-fold) |
| embedding, power 1.0 | 0.4770 | 0.5439 | FAIL (degree) |
| **embedding, power 0.5 (shipped)** | **0.5021** | **0.6025** | **PASS (k-fold)** |

The shipped **embedding + power 0.5** recipe has the best degree head at
k-fold and clears duration by 0.10 over the baseline.

## 6. Remaining data gaps (not a code fix)

`d1` and `d5` have zero validation examples and `8`-step durations only 12
samples library-wide. No weighting scheme invents signal that is not there.
Growing the library (more sequences using those degrees/durations) is the next
real lever, and should be measured against these k-fold numbers.

## 7. Audit artifacts

| Script | Purpose |
| ------ | ------- |
| `scripts/audit-melodic-prior.py` | Full breakdown + per-class/context/calibration |
| `scripts/audit-melodic-duration-collapse.py` | Names the duration failure mode |
| `scripts/audit-melodic-leakage-check.py` | Quantifies seen-vs-unseen accuracy of a shipped model |
| `scripts/gate-melodic-retrain.py` | Pre-registered retrain gate (trains fresh models per fold) |
| `scripts/audit-melodic-double-weight-proof.py` | Finite-difference proof of the gradient bug |
| `scripts/train_symbolic_melodic_lib.py` | Shared trainer primitives (gate and trainer share one code path) |

All audit scripts are read-only: they never write `public/models/`.

