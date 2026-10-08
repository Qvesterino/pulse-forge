# ADR 0032 — Versioned song dramaturgy features

Date: 2026-10-07 · Status: Accepted · Scope: local song-level Producer DNA

## Context

The current song snapshot averages section-level pattern features by bar count.
That describes the average contents of a song but loses the order and contrast
between its sections. It cannot distinguish an intentional build/drop arc from
the same sections rearranged into a flat sequence.

Song-level preference needs a separate feature contract so pattern vectors are
never silently reinterpreted. It also needs to preserve old preference packs,
remain local, and let the user say whether a comparison is about form, section
development, transitions, contrast, harmony, sound, mix, or the overall song.

## Decision

1. Add an optional `song-dramaturgy.v1` vector to song candidate snapshots. It
   measures section-role proportions and repetition, bar-weighted energy and
   density arcs, instrumentation changes, transition patterns, adjacent
   section contrast, motif statistics and harmony summaries. Values are
   normalized scalars; names, prompts, project identifiers, audio and raw
   musical events are not stored in this vector.
2. Keep the existing pattern `features.v1/v2` and audio `audio.v1/v2` fields
   unchanged. Existing observations without the new optional vector remain
   valid; only new song comparisons can train the dramaturgy adapter.
3. Fit a deterministic, shrinkage-weighted pairwise adapter from directional
   song choices. The adapter can be scoped to overall impression, development,
   transitions, contrast/repetition or harmony. Its combined residual is
   bounded and is added only after the global song baseline.
4. Add explicit `sound` and `mix` comparison focuses that train their matching
   rendered-audio dimensions: timbre/periodicity for sound and level/dynamics/
   stereo for mix. They do not train pattern or dramaturgy adapters.
5. Keep every focus within the `song` task. A selected focus is stored with the
   observation and does not become a pattern or section label. Existing and
   unscoped song choices continue to train the general song adapter.
6. Report song-dramaturgy holdout accuracy and paired lift separately from
   pattern-symbolic, rendered-audio, and blind-pilot metrics. The feature block
   remains a candidate selector signal, not an objective measure of song
   quality, until held-out and human-listening evidence supports it.

## Consequences

- Reordered or structurally contrasting songs can have different local
  snapshots even when their average section features are similar.
- The new block is additive and backward-compatible with existing memory
  exports. It requires no project-model migration and stores no raw audio.
- The user can direct explicit song feedback at a measurable musical aspect.
  Focus-specific models require their own evidence and remain confidence-
  shrunk; no focus is claimed calibrated before a real pilot.
