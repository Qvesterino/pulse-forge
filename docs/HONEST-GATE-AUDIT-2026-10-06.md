# HONEST-GATE AUDIT — 2026-10-06

**Scope:** every confidence/certainty-producing estimator in `src/reference/` +
`src/ai/`. Motivated by the U0.5 fix (`dfe6bf06`): a self-normalizing scorer
promoted spectral-leakage wobble on a bare sine into "150 BPM @ 0.979". The
sweep asked one question of every estimator: **is there an ABSOLUTE floor, or
does the score only make sense relative to the signal's own maximum?**

**Method:** enumerate (`grep` for confidence/clarity/voiced/abstain/corr) →
read every producer → classify → measure adversarial inputs (sine, white /
pink / lowpassed noise, silence, click trains, the 5 UN-SUNO golden fixtures)
with a probe → fix confirmed holes with measured thresholds → pin with
`tests/honest-gates.test.ts` (10 specs) → keep every golden KPI floor green.

## Verdicts

| Estimator                      | File                                        | Semantics                                                         | Absolute floor?                                                    | Verdict                              |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| F2 key lane `analyzeTonality`  | `src/reference/analysis/tonal.ts`           | weighted absolute + separation + tonalEnergy + peakiness          | YES (`best.score − 0.3`, tonal-energy term)                        | SAFE — the model to copy             |
| F1 rhythm lane `analyzeRhythm` | `src/reference/analysis/rhythm.ts`          | dominance + strength(**self-normalized**) + alignment + stability | NO                                                                 | **BUG — fixed**                      |
| Tempo candidates               | `src/reference/analysis/tempoCandidates.ts` | share of own max (ported, relative by design)                     | —                                                                  | consumers must gate                  |
| `estimateTempo`                | `src/ai/audio-tempo-key.ts`                 | winner.score (self-normalized)                                    | crest floor (dfe6bf06)                                             | FIXED, then **hardened** (see below) |
| `estimateKey`                  | `src/ai/audio-tempo-key.ts`                 | Pearson margin (best − second)                                    | NO                                                                 | **BUG — fixed**                      |
| Chord detection                | `src/reference/analysis/chords.ts`          | KK correlation                                                    | YES (`MIN_PROFILE_CORRELATION = 0.55`)                             | SAFE                                 |
| Bass transcription             | `src/reference/analysis/bass.ts`            | YIN clarity                                                       | YES (measured voiced gate)                                         | SAFE                                 |
| Melody transcription           | `src/reference/analysis/melody.ts`          | YIN clarity                                                       | YES (`CLARITY_GATE = 0.65`/frame)                                  | SAFE                                 |
| Beat-grid alignment            | `src/reference/analysis/beatGrid.ts`        | (best − mean)/mean step score                                     | (component of F1 mix)                                              | covered by the F1 entry gate         |
| Intent model                   | `src/ai/*` heads                            | ONNX decode + abstain                                             | YES (`INTENT_MODEL_ABSTAIN_MARGIN = 2.0`, loader `gatePassed` pin) | SAFE (prior campaign)                |
| `confidenceLevel/Label`        | `src/reference/analysis/confidence.ts`      | presentation thresholds                                           | —                                                                  | presentation only                    |

## Confirmed bugs → fixes

### 1. F1 rhythm lane: phantom pulse ABOVE the warning threshold

`strength = clamp01(top.score)` is a share of the envelope's own maximum, so
stationary input scored near 1.0. Measured on the raw combined flux envelope
(2048/512 @ 22050):

| input                        | crest     | reported                                      |
| ---------------------------- | --------- | --------------------------------------------- |
| sine 440/220/110 Hz          | 2.5–4.9   | 86–140 BPM @ conf 0.574–0.600, **no warning** |
| white / pink / lowpass noise | 4.8–5.3   | ~126 BPM @ conf 0.640, **no warning**         |
| click trains                 | 22.6–48.0 | correct BPM, conf 0.7–0.8                     |
| golden fixtures (5 genres)   | 11.5–26.5 | correct BPMs                                  |

**Fix:** `onsetEnvelopeCrest()` + `ONSET_CREST_FLOOR = 8` in
`src/reference/dsp/spectralFlux.ts` (one home, shared); `analyzeRhythm`
returns its documented empty result (null BPM + warning) below the floor.
The docstring always promised "pure tonal content → null" — now enforced.

### 2. estimateTempo: the crest gate was on the WRONG envelope

The dfe6bf06 gate ran on the **baseline-removed** envelope. Baseline removal
flattens slow trends but _amplifies_ frame-to-frame relative wobble on noise:
white/pink raw crest 5.9/6.0 → baseline-removed 10.5/10.8 — pink noise leaked
past the floor and produced a confident ~126 BPM. **Fix:** gate the RAW
combined envelope before removal (stationary ≤ 6.0 vs. click trains ≥ 36.8 —
cleaner separation than the removed envelope ever had).

### 3. estimateKey: fabricated keys on any noise color

The Pearson margin cannot gate — real boombap material scores margin 0.025
while pink noise scores 0.235. The absolute floors can (measured):

| input                                             | best corr   | chroma max/mean |
| ------------------------------------------------- | ----------- | --------------- |
| white noise                                       | 0.463       | 1.76            |
| pink noise                                        | 0.573       | 1.89            |
| lowpass 150–500 Hz                                | 0.500–0.584 | 1.79–1.90       |
| bare sine (root honest, mode ambiguous by design) | 0.685       | 11.9            |
| golden fixtures                                   | 0.737–0.880 | 2.55–4.05       |

**Fix:** two absolute gates in `estimateKey` — `KEY_MIN_CONCENTRATION = 2`
(chroma max/mean; primary, robust to noise color) AND
`KEY_MIN_CORRELATION = 0.6` (best rotation; secondary). Below either → null;
callers keep their patch without the key, exactly as the docstring promised.

## Snapshot honestly regenerated (reviewed, not blessed)

`tests/reference/__snapshots__/golden.test.ts.snap` — the "C sustained-note
track" case pinned a phantom "65 BPM @ 40% confidence" for a pure sustained
triad drone (zero onsets). After the fix: `bpm: null` + warning, summary reads
"No reliable tempo detected" (the descriptor layer's existing null-tempo
wording), groove family falls back to `four_on_the_floor` (the documented
"No tempo → the family that assumes least" convention). The 120 BPM click
snapshot is unchanged. All other fixtures' snapshots unchanged.

## Non-goals / follow-ups

- `src/vocal/` and `src/presets/audioQuality.ts` are adjacent but out of this
  sweep's scope (user-scoped to reference + ai); the vocal profile already
  inherits the fixed estimators.
- `analyzeTonality` still returns a low-confidence tonic on noise (tonic
  non-null with `confidence < 0.55` + warning) instead of the docstring's
  "null tonic on broadband noise" — the confidence number is honest and the
  warning fires, so this is a wording gap, not a phantom-confident bug.
  Left documented; a future wave may align the null behavior with the text.
