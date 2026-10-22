# W1 PLAN — Chord-aware melodic prior (melodic-features-v3)

> Status: **IN PROGRESS 2026-10-06** — revised after the discovery pass: v3
> already EXISTS end-to-end on the library side (contract → dataset generator
> → trained model → runtime function), richer than this plan's first draft.
> This document now tracks the REAL contract and the actual gaps. The
> pre-registered gate criteria (§4) may not change after the first gated run.

---

## 1. What already exists (discovered 2026-10-06 — do not rebuild)

| Piece                                                    | State                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/symbolic/melodic-features-v3.ts`                 | ✅ contract: v1 base (genre one-hot 4 + role 3 + step 5 + prev degree 8 + prev duration 4 + contour 5) + chord root DEGREE one-hot 8 + quality 8 (harmony.ts vocab incl. dim/maj7/sus2) + harmonic function 4 (T/S/D/p) + NEXT-chord root 8 + position-in-chord 3 + motif hash 8 = **68 dims** |
| `src/ai/harmony.ts`                                      | ✅ `ChordEvent {degree, quality, func, duration}`, `expandProgression`, `CHORD_INTERVALS` — the vocabulary v3 consumes                                                                                                                                                                         |
| `scripts/generate-melodic-v3-dataset.mts`                | ✅ library rows via `selectProgression` → `expandProgression` → `chordAtStep`; dataset `symbolic-melodic-v3-ds.v1` (9 592 samples)                                                                                                                                                             |
| `public/models/symbolic-melodic-v3.{onnx,manifest.json}` | ✅ trained — **library-only: `midiCorpusSamples: 0`**, `gatePassed: None` (no verdict exists)                                                                                                                                                                                                  |
| `runMelodicNextV3` (prior-client)                        | ✅ implemented — **NO CALLER**: the provider routes v1/v2 only; v3 is inert (nothing claims otherwise)                                                                                                                                                                                         |
| `tests/melodic-features-v3.test.ts`                      | ✅ 7/7                                                                                                                                                                                                                                                                                         |

The first draft of this plan designed a parallel contract (v2 + tonic-relative
pc block); it is superseded by the existing richer contract above.

## 2. The actual gaps (what W1 still needs)

1. **Corpus → v3 chord-event adapter** (THE missing bridge — the W1
   hypothesis is untested without it): the MIDI corpus's `splitRoles` already
   extracts the chord track, but sample building throws it away. Needed: a
   pure `chordNotes → ChordEvent[]` derivation (slice the chord track by
   onset groups → sounding pc set → root pc by template match over
   `CHORD_INTERVALS` → tonic-relative degree + quality + function → slice
   duration in steps), then the v3 generator's own `chordAtStep` +
   `buildMelodicFeatureRowV3` path runs unchanged for corpus rows.
2. **Honest genre conditioning for the corpus.** v3's genre one-hot reuses
   v1's 4-genre list; W2's corpus rows were labelled `"ambient"` (a legacy of
   the pre-fix conditioning collision). The corpus is classical — v3 gets its
   own genre list with a 5th `"classical"` slot. The v3 contract may change
   NOW because it is ungated and unrouted (nothing consumes the 68-dim
   layout); after the gate it freezes.
3. **Gate v3 plumbing**: `gate-melodic-retrain.py` has no v3 path.
4. **Gated retrain** (§4) → manifest `gatePassed` → only on PASS: the
   provider routing flips to v3 behind the gate verdict.

## 3. Slices

1. **This session:** plan doc (this) + `deriveCorpusChordEvents` (pure chord
   track → ChordEvent[], tested) + v3 genre list extension ("classical") +
   `--midi-corpus` wiring into the v3 dataset generator.
2. Gate plumbing (python: dataset width, v3 manifest fields, gate script v3
   path) + dataset regeneration (library + corpus).
3. Gated retrain → verdict → on PASS: provider routing + manifest pins +
   CURRENT-STATE; on FAIL: the honest record, corpus stays out.

## 4. Pre-registered gate (unchangeable after the first gated run)

Same harness family as W2 (`gate-melodic-retrain.py`), identical folds,
electronic ds.v3 library validation, baseline = same folds WITHOUT corpus:

- **PRIMARY (must hold all):**
  - a) 2-fold degree(v3 with corpus) ≥ 2-fold degree(v3 without corpus) −
    0.01; same for 3-fold;
  - b) duration metrics not worse than the no-corpus v3 run by > 0.02;
- **SECONDARY (reported, not gating):** d1/d5 honest-class retention on
  corpus folds; degree on the corpus's own held-out classical slice.

PASS → `gatePassed: true` in the v3 manifest, provider routing lands, the
corpus becomes the first non-procedural training source in the project.
FAIL → the corpus records its second negative result and stays out; the plan
documents the falsification. No artefact ships on a FAIL — the W2 rule.

## 4b. GATE VERDICT — FAIL (2026-10-07, recorded per the W2 rule)

Ran exactly as pre-registered (same harness, identical library folds,
baseline = same folds minus `classical.*` rows):

| run                                          | 2-fold degree | 2-fold duration | 3-fold degree | 3-fold duration |
| -------------------------------------------- | ------------: | --------------: | ------------: | --------------: |
| baseline (no corpus)                         |        0.4933 |          0.5512 |        0.4850 |          0.5610 |
| + corpus (20 407 classical rows, train-only) |        0.4891 |          0.4736 |        0.4922 |          0.5383 |

- Criterion (a) degree: **PASSED both folds** — 2-fold within tolerance
  (−0.0042), 3-fold the corpus actually HELPS (+0.0072). The chord-
  conditioning hypothesis is CONFIRMED for degree: with harmony context,
  the classical corpus no longer drags degree accuracy (the W2 failure
  mode is gone).
- Criterion (b) duration: **FAILED both folds** — 2-fold −0.078, 3-fold
  −0.023 (just past the 0.02 line). The corpus's legato duration
  distribution still biases the duration head toward long classes while
  the electronic val wants short ones. W2's mechanism now lives ENTIRELY
  in the duration axis.

**Verdict: FAIL (must hold all). No artefact ships.** The v3 model stays
library-only-trained and inert (unchanged); the corpus stays out.

**Sharp follow-up hypothesis (W1b — NOT pre-registered, not fished by this
gate):** the failure is isolated to the duration head; a duration-preserving
corpus integration (re-balance corpus duration classes toward the library
distribution, or drop the duration head's corpus loss term) may convert this
to a PASS. Requires its own pre-registration before any rerun.

## 4c. W1b PRE-REGISTRATION — per-head data rights (locked before the rerun)

W1's verdict split the hypothesis: harmony transfers (degree PASSED, 3-fold
corpus helps +0.0072), texture does not (duration FAILED, -0.078/-0.023).
W1b turns that split into the mechanism:

**Mechanism (the architectural decision):** corpus rows train the SHARED
TRUNK and the DEGREE head only. Their contribution to the DURATION head's
loss and gradient is ZERO (per-row duration mask in `MLP.train_step`), and
the duration head's class weights are computed from the library slice only.
The duration head is taught exclusively by the electronic library; the
corpus teaches voice-leading over harmony, nothing else.

**Gate criteria — IDENTICAL to §4, no relaxation:**

- a) 2-fold and 3-fold degree(corpus, heads-split) ≥ degree(baseline) − 0.01;
- b) duration(corpus, heads-split) not worse than duration(baseline) by
  > 0.02 — with the mechanism in place the expected value is ≈ baseline
  > (shared-trunk drift aside), so this is now an honest test of "the corpus
  > does not damage what it does not teach".

PASS (both, both fold counts) → the corpus ships as a DEGREE teacher:
retrain the shipped v3 with --w1b-heads-split, manifest records the recipe,
provider routing lands. FAIL → the corpus parks PERMANENTLY (two mechanisms,
one verdict each — no third roll without a new architectural idea).

## 4d. W1b VERDICT — FAIL (2026-10-07); the corpus parks permanently

Ran exactly as pre-registered in §4c (same folds, mask mechanism,
library-only duration class weights):

| run                      | 2-fold degree | 2-fold duration | 3-fold degree | 3-fold duration |
| ------------------------ | ------------: | --------------: | ------------: | --------------: |
| baseline (no corpus)     |        0.4933 |          0.5512 |        0.4850 |          0.5610 |
| W1 shared-training (§4b) |        0.4891 |          0.4736 |        0.4922 |          0.5383 |
| W1b heads-split          |        0.4710 |          0.5109 |        0.4783 |          0.5688 |

- Criterion (a) degree: **FAILED** — 2-fold 0.4710 < 0.4833 (worse than
  BOTH the baseline and the §4b shared run). Splitting the heads tore the
  shared trunk between two input distributions; degree lost more than the
  corpus ever gave it.
- Criterion (b) duration: **FAILED** — 2-fold 0.5109 vs 0.5512 (−0.040).
  The mask moved duration toward baseline (vs §4b's 0.4736) but never
  reached it: the trunk the corpus trains is the duration head's input.

**Verdict: FAIL. The corpus parks PERMANENTLY** — two architectural
mechanisms (shared training; per-head data rights), one verdict each, and
§4c allows no third roll without a genuinely new idea. What the campaign
leaves behind, all reusable: the corpus→ChordEvent bridge, the gate's v3
path, the trainer's per-head mask (a correct, tested primitive), the
"classical" conditioning slot, and TWO clean negative results that fence
the idea space: classical melodic texture does not transfer into this
electronic-library prior under ANY integration tried, harmony alone or
masked. The next chord idea needs a different model family (sequence
models with attention over harmony), not a different merge trick.

## 5. Non-goals

- No change to the drum prior, the ranker, or v2's shipped artefacts.
- No new corpus ingestion (345 pieces, 29 730 rows as-is).
- No audio-side chord detection (symbolic harmony only).
- No runtime routing before the gate verdict (v3 stays inert until PASS).
