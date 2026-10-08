# ADR 0027 — Local preferences for rendered candidate audio

Date: 2026-10-07 · Status: Accepted · Scope: Producer DNA, intent ranking, offline audio analysis

## Context

KYX already renders a small finalist set offline and scores it against coarse
genre targets. That objective audio fit is useful as a global selector, but it
does not learn whether a particular user prefers a brighter, bass-heavier,
more dynamic or louder result. The existing A/B learner mostly sees symbolic
pattern features, so it cannot learn those audio preferences from a choice.

The extension must preserve the browser-first boundary, keep raw audio out of
Producer Memory, respect the user's learning switch and remain subordinate to
the global selector and all hard generation gates.

## Decision

1. Derive an optional, versioned `audio.v1` vector only from candidates that
   successfully complete the existing offline finalist render. It contains
   five normalized scalars: RMS, peak, crest factor, zero-crossing rate and
   low-band energy ratio. They are compact acoustic proxies, not claims of
   instrument, preset, stereo-width or semantic timbre recognition.
2. Store that vector alongside the candidate snapshot for explicit A/B
   observations. Never persist PCM, spectrograms, filenames, project names or
   prompts as part of this feature. Old observations without the optional
   vector remain valid and train the symbolic adapter as before.
3. Learn general and reason-scoped pairwise adapters from directional A/B
   choices only. `brightness`, `lowEnd`, `dynamics` and `level` use only their
   corresponding audio dimensions. `neither`, `both`, audition and apply are
   not directional labels.
4. Apply a small, confidence-shrunk audio residual only after the ordinary
   ranker and deterministic genre audio fit. The residual is bounded to 0.12
   score units, cannot promote a rejected candidate and is absent when
   preference learning is paused or the audio model has insufficient evidence.
5. Capture the non-personal score after genre audio fit with a versioned
   selector identity. Evaluate the audio contribution separately on the
   final chronological holdout of connected session/lineage/candidate groups.
6. Keep `pattern` and `section` evidence in different preference contexts.
   Whole-song learning requires its own explicit choice UI and evaluation; a
   pattern or section label must not silently become a song-level label.

## Consequences

- A/B comparisons between rendered finalists can teach a local preference for
  the measured acoustic properties while raw audio stays ephemeral.
- `audio.v1` remains a supported legacy vector. New renders use the additive
  `audio.v2` contract defined in ADR 0030 when the required summaries exist.
- Genre fit remains the global baseline; local audio preference is an
  explainable residual and can be removed by pausing or clearing Producer DNA.
- The small vector does not yet model instrument identity, presets, stereo
  image, detailed spectra, section evolution or full-song taste. Those require
  separate versioned contracts and explicit evaluation before activation.
- The implementation is not evidence of improved recommendations until an
  opt-in blind pilot shows positive held-out paired lift without constraint or
  diversity regressions.
