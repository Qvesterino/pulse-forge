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

## 5. Non-goals

- No change to the drum prior, the ranker, or v2's shipped artefacts.
- No new corpus ingestion (345 pieces, 29 730 rows as-is).
- No audio-side chord detection (symbolic harmony only).
- No runtime routing before the gate verdict (v3 stays inert until PASS).
