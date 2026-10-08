# ADR 0030 — Versioned timbre, voicing and stereo preference features

Date: 2026-10-07 · Status: Accepted · Scope: rendered audio summaries and Producer DNA

## Context

The five `audio.v1` scalars measure level, crest, zero-crossing rate and low
frequency energy. They cannot represent spectral shape, periodicity or stereo
image, so a user's explicit A/B choices cannot teach those audible differences.
The extension must preserve imported v1 observations, keep raw PCM ephemeral,
remain bounded after offline rendering, and avoid treating a mono render as a
measured stereo preference.

## Decision

1. Keep `audio.v1` as a supported legacy contract. New captures emit
   `audio.v2`, whose first five values preserve the v1 order and normalization:
   RMS, peak, crest factor / 20, zero-crossing rate / 0.4 and low-band ratio.
2. Append six normalized values to `audio.v2`: spectral centroid / Nyquist,
   85% energy rolloff / Nyquist, spectral flatness, normalized autocorrelation
   periodicity, mid/side width, and remapped L/R correlation. The first four
   added values are always measured; the final stereo pair has an explicit
   availability mask and is present only for a stereo render.
3. Bound the analysis after render completion: up to eight evenly spaced
   2048-sample FFT windows, up to four short autocorrelation windows, and at
   most 16,384 stereo sample positions. No analysis runs in an audio callback.
4. Validate both vector versions on every local import/read. A v1 vector is
   read as its five available prefix values; the six v2-only dimensions remain
   unavailable. Pair training uses only dimensions available on both sides,
   and candidate scoring uses only dimensions shared by the current candidate
   set. This prevents missing stereo data from becoming a false mono label.
5. Preserve reason-scoped learning. `brightness`, `lowEnd`, `dynamics` and
   `level` keep their existing meanings; `timbre`, `voicing` and `stereo` are
   available only when both candidates carry the corresponding v2 dimensions.
   A/B choices remain the only directional labels.
6. Use the existing deterministic pairwise audio ranker and its confidence
   shrinkage/residual caps. Do not add a new ONNX model or alter hard gates.
   The ordinary global audio-fit score keeps its existing RMS/crest/ZCR/low-band
   target behavior, so the v2 extension adds personal preference evidence
   without silently changing the genre baseline.
7. Store only normalized scalars, availability bits and existing content
   hashes in Producer DNA. Raw PCM and spectrograms remain ephemeral. The
   vectors are acoustic proxies, not instrument/preset identity or a claim of
   artistic quality.

## Consequences

- Pattern finalist, section and full-song A/B snapshots can learn more about
  timbre, periodicity and stereo where the render supports those measurements.
- Existing `audio.v1` exports and observations remain valid; no project schema
  migration is required because the feature contract is nested in the local
  preference snapshot.
- The evaluator reports v1-prefix and full-v2 paired lift on the same
  leakage-safe holdout, including the incremental difference by preference
  task. V2 metrics require both holdout candidates to have v2 summaries.
- The added values still require grouped chronological holdout evaluation.
  A positive quality claim and release-wide activation require the opt-in blind
  pilot gate in the Recursive Learning plan.
