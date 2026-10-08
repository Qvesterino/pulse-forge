# ADR 0029 — Section feedback and rendered-song ranking

Date: 2026-10-07 · Status: Accepted · Scope: section/song Producer DNA ranking

## Context

Whole-song feedback has its own preference task, but the plan also needs a
section-level learning loop and a way to use the song audio summaries already
collected from explicit full-song comparisons. Section feedback must not leak
into pattern or song preferences. Song audio ranking must compare candidates
from complete renders against an honest global baseline and remain easy to
disable.

## Decision

1. Record section A/B outcomes under the existing `section` task. Candidate
   snapshots use `features.v2`, `audio.v2` when available, and a content hash of
   the section pattern, role, bar length and scoped FX. The context is derived from
   the section generation intent and role.
2. Offer only sections with the same planned role and bar length. Each side is
   rendered alone as its complete section pattern with scoped FX. A directional
   choice, `neither`, or `both` is enabled only after both separate renders finish
   natural playback. Stopping or switching away never completes the audition.
3. These are isolated section auditions. They omit neighbouring transition
   audio and surrounding arrangement automation; the UI and evaluator must not
   describe them as whole-arrangement section renders.
4. Song audio ranking may use only complete lanes that have already rendered
   successfully. Do not automatically render hidden alternatives. Each candidate
   uses the existing bars-weighted `global-song.v1:section-quality-mean` baseline,
   symbolic features, and its ephemeral render's `audio.v2` summary.
5. Fit symbolic and audio preferences in the `song` context only. Sum their
   residuals, clamp the combined residual to ±0.20, and retain the existing audio
   adapter's own ±0.12 ceiling. Do not promote candidates rejected by song-build
   hard gates.
6. Show an audio DNA tip only when the audio adapter returns a non-flat ranking
   from explicit song evidence. The tip applies only among already-rendered lanes
   and displays the relevant comparison count and evidence weight. Learning pause
   or clearing memory removes the personal ranking; global order remains the
   fallback.
7. Report accuracy and paired lift by `pattern`, `section` and `song` from the
   same leakage-safe chronological group split. Never mix task scores into one
   quality claim that hides a weak task behind a stronger one.

## Consequences

- Section votes can train the same section-context adapters already consulted
  while generating section candidates, without becoming pattern or song votes.
- Explicit song comparisons now affect re-ranking after two or more complete
  lanes have been rendered. Initial song generation remains symbolic because
  it does not render every lane.
- Both section and song audio vectors remain compact summaries. Raw PCM is
  temporary and is not stored in Producer Memory.
- The evaluator can now show whether an audio or symbolic contribution helps in
  each task separately, while preserving the shared group holdout.
- Probe selection uses the current reason-specific pairwise model's predictive
  entropy and effective-evidence shrinkage alongside measured axis isolation.
  It is a deterministic query-value proxy, not calibrated expected information
  gain. More detailed arrangement-dramaturgy features and an opt-in blind pilot
  remain follow-up work. No positive quality-lift claim is justified before
  grouped chronological holdout and human pilot evidence.
