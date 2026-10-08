# ADR 0028 — Song-level Producer DNA preferences

Date: 2026-10-07 · Status: Accepted · Scope: song generation, Producer DNA, local preference evaluation

## Context

Pattern-level choices cannot describe preferences about a complete arrangement.
Whole-song comparisons must therefore use a distinct `song` preference task,
while preserving the existing local-only memory and the rule that audition or
application alone is not a directional preference.

At generation time, KYX can score the best-per-section arrangement and complete
alternate lanes symbolically. It does not render every complete lane up front,
so full-song acoustic features are available only after the user selects and
auditions a lane.

## Decision

1. Build a fixed-width song snapshot by averaging the existing pattern feature
   vectors weighted by each section's bar count. Keep a stable content hash and
   version the global baseline as `global-song.v1:section-quality-mean`.
2. Store song feedback under the separate `song` task. It must not train the
   `pattern` or `section` adapters. An explicit A/B winner is directional;
   `neither` and `both` remain non-directional outcomes.
3. Offer a comparison only for distinct complete song candidates whose renders
   have each finished full playback. Stopping early, switching lanes, or merely
   rendering a candidate does not count as audition evidence.
4. Attach the compact, versioned rendered-audio summary to an explicitly
   compared song snapshot when available. New captures use `audio.v2`; imported
   `audio.v1` summaries remain readable. Never persist raw PCM or derive
   preferences from playback alone.
5. Use the song-context symbolic ranker to suggest a lane during build. After
   at least two complete lanes have already rendered, the user-facing panel may
   re-rank only those lanes using song-context symbolic and audio evidence;
   never trigger hidden renders to obtain that evidence. ADR 0029 defines the
   section and rendered-song ranking details.
6. Keep the global selector, preserve rules and hard generation gates
   authoritative. Personal ranking is an explainable, bounded residual with a
   deterministic fallback when learning is disabled or evidence is insufficient.

## Consequences

- Whole-song choices now provide useful local preference evidence without
  treating a loop comparison as an arrangement preference.
- Song snapshots can support pairwise evaluation with the existing connected
  session/lineage/candidate holdout protocol.
- Full-song audio learning is captured and re-ranking is implemented under
  ADR 0029. It remains limited to complete lanes the user has already rendered;
  the initial build recommendation stays symbolic.
- Section-level preferences are implemented separately under ADR 0029. More
  detailed arrangement dramaturgy and a real-user blind pilot remain follow-up
  work.
