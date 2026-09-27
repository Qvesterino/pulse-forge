# MELODIC PRIOR AUDIT — 2026-09-27

**Scope:** `symbolic-melodic-v1` (shipped default) and `symbolic-melodic-v2`
(shipped fallback) — the NEXT-NOTE ONNX priors behind the Intent Engine's
melodic branch.
**Method:** read-only error analysis on the shipped artifacts
(`scripts/audit-melodic-prior.py`), failure-mode breakdown
(`scripts/audit-melodic-duration-collapse.py`), a faithful 5-fold group-CV
weighting A/B (`scripts/audit-melodic-weights-ab.py`) and a finite-difference
gradient check (`scripts/audit-melodic-double-weight-proof.py`).
**Verdict:** the documented reason v2 is "fallback only" is **backwards**, and
both trainers contain a **real gradient bug** in the duration head.

---

## 1. Headline findings

| # | Finding | Evidence |
| - | ------- | -------- |
| 1 | **The v2/v1 comparison is not apples-to-apples.** v1's shipped artifact trained on **190** samples (ds.v1), v2 on **239** (ds.v2). The library grew between the two training runs, so "v2 regressed" partly means "v2 saw different data". | `symbolic-melodic-validation.json` (`samples: 190`) vs `symbolic-melodic-v2-validation.json` (`samples: 239`) |
| 2 | **The shipped 15 % split validates on 29 rows in 4 groups.** Any single valDegreeAcc from it is noise-dominated. 5-fold group CV is the honest number. | `audit-melodic-prior.py`: `val split: 29 rows in 4 groups` |
| 3 | **v2's DEGREE head is BETTER than v1's**, by both metrics — the opposite of what `INTENT_ENGINE.md` §5.3 says. | k-fold: v2 deg **0.7521** vs v1 0.7043 |
| 4 | **v2's DURATION head collapsed toward the rare class** — worse than the majority baseline. | k-fold: v2 dur **0.4511** vs majority 0.4997; 55 predictions for 12 truths of class 8 |
| 5 | **Root cause: a double-multiplied class weight** in the duration gradient (`train-symbolic-melodic.py:105`). The head effectively optimises `wt²`, amplifying the relative pull toward rare classes by `1/wt` (up to **10.2×**). | finite-difference check: analytic norm 0.0224 vs true 0.1463 on the buggy path |

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

**Not a weakness:** duration. v1 duration is solid (86 % on val, 0.7610 pooled
k-fold, all four classes used).

## 3. The documented-comparison correction

`INTENT_ENGINE.md` §5.3 currently reads:

> melodic prior v1 (29-dim, valDegreeAcc 0.679 — preferred)
> melodic prior v2 (41-dim, valDegreeAcc 0.607 — regression on 190 rows, fallback)

After this audit:

- the "190 rows" figure belongs to **v1**, not v2 — v2 trained on 239;
- on the honest 5-fold group CV over all 33 groups, **v2's degree head wins
  0.7521 vs 0.7043** (and v2's shipped report of 0.4828 is a 29-row artefact);
- **v2's duration head is the genuine regression** (0.4511, below the 0.4997
  majority baseline), and it has a concrete, proven cause (finding 5).

So the correct routing is not "v2 is worse". It is **"v2's degree head should
be preferred; its duration head must be fixed before v2 ships as default."**

## 4. Proven fix path

Two independent, measured changes, neither requiring new model architecture:

### 4a. Remove the double weight (correctness fix)

`scripts/train-symbolic-melodic.py:105` multiplies the duration gradient by
`(wt / n)` a second time. Delete that line. The finite-difference check proves
the analytic gradient currently disagrees with the loss being printed, so the
duration head was never optimising the reported objective.

### 4b. Temper the class weights (stability fix)

Linear inverse frequency gives duration-8 (12 samples) a **10.2×** weight over
duration-2 (122 samples). Square-root tempering reduces that to **3.2×**, which
keeps the rare class visible without letting it dominate. The faithful A/B
(`audit-melodic-weights-ab.py`, augmentation merged, 5-fold CV) shows sqrt and
linear are within noise on the currently-shipped recipes — i.e. the tempering
is safe — while the double-weight bug is the dominant cause.

**Retrain gate:** re-run `npm run prior:melodic:v2` after 4a+4b and require
k-fold duration ≥ the majority baseline (0.4997) **and** degree ≥ 0.7521
(no regression on the head that already works).

### 4c. Data gaps (not a code fix)

`d1` and `d5` have **zero** validation examples and `8`-step durations only 12
in the whole library. No weighting scheme invents signal that is not there.
The library needs more sequences that use those degrees before per-class
quality can be claimed.

## 5. Audit artifacts

| Script | Purpose |
| ------ | ------- |
| `scripts/audit-melodic-prior.py` | Full breakdown + 5-fold group CV + v1/v2 head-to-head |
| `scripts/audit-melodic-duration-collapse.py` | Names the duration failure mode (collapse to rare class) |
| `scripts/audit-melodic-weights-ab.py` | Faithful weighting A/B with augmentation merged |
| `scripts/audit-melodic-double-weight-proof.py` | Finite-difference proof of the gradient bug |

All four are read-only: they never write `public/models/`.
