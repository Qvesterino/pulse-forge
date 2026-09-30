# INTENT FAILURE MINING — 2026-09-30 (library-gate wave)

Goal: close the gap between the SFT teacher (kyx-intent-v1, 92.3 % attempted-exact, desktop)
and the browser (ONNX head inert), by mining the ONNX student's failures and pulling the
training levers that the data actually supports. Deliverables: a reusable failure miner,
two training levers, a corpus wave, and an honest architectural verdict.

## Baseline → after (val split)

| Stage                                                            | attempted-exact | abstain | note                                            |
| ---------------------------------------------------------------- | --------------- | ------- | ----------------------------------------------- |
| shipped artifact (stale vs corpus)                               | 20.2 %          | 59.1 %  | trained on 1479 rows; corpus moved on           |
| + retrain on current corpus (1525)                               | 14.9 %          | 70.9 %  | harder val; sigmoid collapse visible            |
| + balanced sigmoid BCE (targets/pads)                            | 35.6 %          | 59.1 %  | the all-False collapse fixed                    |
| + log-scaled balanced kind CE                                    | 37.4 %          | 61.0 %  | kind acc 0.870 → 0.906                          |
| + corpus mining wave (+71 pairs, 1850)                           | 32.6 %          | 66.3 %  | harder val (new val rows are deliberately hard) |
| + trunk 512×256                                                  | 36.7 %          | 62.9 %  | marginal                                        |
| + **n-gram featurization v2** (bigrams + char 3-grams, cap 2048) | **72.3 %**      | 28.8 %  | the real lever                                  |
| + vocab headroom (natural 2474 features)                         | **77.0 %**      | 25.8 %  | shipped state; gate still honestly FAILED       |

Gate (attempted-exact ≥ 0.95, wrongKind = 0, abstain ≤ 0.20): **FAILED — 77.0 % / wrongKind 4 /
abstain 25.8 %.** But the n-gram wave TRIPLED joint exactness (20.2 → 77.0 %) and the
"architectural ceiling" verdict above is hereby REVISED: it was a WORD-BoW ceiling, not a
model-family ceiling. Char 3-grams carry the fuzzy read (typos and SK variants share trigrams
with canonical forms), bigrams carry word order — the per-head weak list shrank from 10 heads
to 3 (kind 0.920, direction 0.920, amount 0.917; val mean 0.9784). Determinism holds (val
subset byte-equal across two runs). Remaining gap: rare-kind confusions at the margin
(wrongKind 4/264 — hard-zero gate), the percent head on rare numeric classes, and out-of-scope
kinds that abstain by design (~10 % of val). Re-ranked next levers: char 4-grams + corpus
growth (the featurizer now eats vocabulary diversity instead of drowning in it), calibration
pass on the rare-kind tail, then the sequence student if the closed-head decode still caps
exactness.

Gate (attempted-exact ≥ 0.95, wrongKind = 0, abstain ≤ 0.20): **FAILED — and the 95 % bar is
architecturally out of reach for this student** (see verdict).

## Root causes found (in order of discovery)

1. **Artifact staleness, not skill**: the shipped ONNX was trained on a 1479-row corpus; the
   corpus grew (preset/arrange/clips/compound/clarify kinds) and the parser wave changed.
   Retraining alone was the single biggest lever (wrong baseline made everything unreadable).
2. **Sigmoid all-False collapse**: the multi-label heads (targets/pads) are sparse — unweighted
   BCE learns "always empty" (measured: every fader decode with empty `targets`). Balanced
   positive weighting fixed it → 14.9 → 35.6 %.
3. **Kind-head long tail**: 474 `exact` rows vs 6 `save` rows taught the head to vote
   majority-kind (measured confusions: export→exact ×3, select→fader, transport→exact).
   sqrt-inverse-frequency CE on the kind head → kind accuracy 0.874 → 0.906.
4. **Margin abstention is NOT the bottleneck**: scanning INTENT_MODEL_KIND_MARGIN 1.0 → 0.1
   moved exact by only +4 (37.4 → 36.0 % attempted-exact stays flat). The decoder now accepts
   an optional margin override for mining tools; the production pin is unchanged.
5. **Joint-slot ceiling confirmed**: per-head accuracies 0.83–0.95 compound over the 3–6 active
   slots of an attempted row — attempted-exact asymptotes at ~35–40 % for a bag-of-words trunk.
   This matches the 2026-09-28 "joint-slot ceiling" finding and is now measured end-to-end.

## Failure clusters (val, current artifact)

- Out-of-scope kinds abstain by design (arrange/clips/compound/clarify/preset*): 25/264 rows —
  honest fallbacks, correct per the v1 contract.
- mix vs production vs exact confusions: one-word mix descriptors ("darker", "colder") and
  short verb forms still resolve unreliably.
- percent head weakest slot (0.83–0.86): "nastav master na 80 %" → percent 30 (class-imbalance
  over 20 numeric classes on 1.5k rows).
- Pre-existing contract break found and LEFT to its owner: corpus row "more sub in the mix"
  (wrongKind wave) produces production concept `"sub"` which `validateModelAction` rejects —
  parser and schema disagree; needs the concept added to the schema enum or the row re-routed.

## Hold-out discipline

- val (every-7th split) drove every training decision this session.
- golden.jsonl (74 rows, pinned by tests/intent-sft-golden.test.ts) was NOT looked at, NOT
  tuned against, and stayed byte-identical through every iteration.
- The corpus wave appends at the END of the corpus (the every-7th split keeps all existing
  val rows in place; only new indices join) — no held-out row moved into train.

## Path upward (for the next sessions, in order of expected leverage)

1. **n-gram featurization** (char 3–4 grams + word bigrams) — must land in BOTH the python
   trainer and TS `buildIntentBow` (featureVersion bump + manifest re-pin; the drift gate
   enforces the sync). Catches SK variants and typos the word-BoW cannot see.
2. **Corpus ×3–5** (now cheap: the generator + miner loop is in place) — BoW models scale with
   coverage, and the SFT corpus doubles as LLM fine-tuning data.
3. **Sequence student** (tiny transformer over char/token sequence) replaces the BoW trunk —
   the ONNX head spec (closed-class multi-head decode) is reused unchanged.
4. Until then the ONNX head stays **inert by design** (gatePassed=false pins it): desktop uses
   the SFT model (92.3 %), browser uses the deterministic layer — both honest, nothing guesses.
