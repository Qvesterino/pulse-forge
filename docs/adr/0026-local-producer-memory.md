# ADR 0026 — Local Producer Memory events

Date: 2026-10-07 · Status: Accepted · Scope: Producer DNA, intent learning, local persistence, evaluation

## Context

KYX already records explicit A/B choices in a bounded `localStorage` ledger and
uses them as synchronous input to its deterministic personal ranker. Intent
corrections, workflow outcomes and durable generation lineage do not yet share
a versioned history. The ranker ledger also has no session or lineage grouping,
so a chronological report alone cannot establish a trustworthy held-out lift.

Producer Memory needs a durable event contract without making React, project
documents, or a second mutable project model the source of truth. It must also
keep raw prompts, audio, project names and file paths out of personal learning
storage by default.

## Decision

1. Store events and resumable pattern branches in separate
   `producer-memory-events` and `producer-lineage` object stores inside the
   existing Pulse Forge IndexedDB database (DB v15). Add both stores without
   changing or migrating project records.
2. Use a versioned event envelope with opaque event, session and lineage ids.
   Supported events are intent correction, pairwise choice, settled edit,
   apply, undo, dismiss and forget. A pairwise event embeds only the existing
   validated preference observation. Intent correction values are normalized
   field/value pairs; arbitrary phrase text is not accepted by this schema.
3. Validate and rebuild records on every write, read and import. Reject unknown
   event kinds, unsupported schema versions, oversized vectors, malformed ids
   and unknown fields. Keep at most 512 events (with category quotas), at most
   48 lineage snapshots, a 64,000-character limit per event and a 256,000-
   character limit per lineage node. The repository fails closed when IndexedDB
   is unavailable.
4. Hydrate a bounded in-memory ranker view from IndexedDB at app startup so
   candidate generation can keep its synchronous deterministic API. Until
   hydration completes, the ranker uses the existing `localStorage` ledger;
   afterward it merges durable pairwise/edit events with that legacy fallback.
   New writes and forgetting refresh the view. Workflow and correction events
   remain outside preference training.
5. Export/import a versioned memory pack containing events, optional lineage
   snapshots, favorited patterns and compact style examples. Favorite seeds,
   pad/track ids and names are anonymized while musical pattern data is kept so
   the imported profile can keep learning from explicit ★ choices. Import
   validates the complete pack before writing and merges each bounded dataset.
   Forget tombstones cover events and branch nodes. Event deletion and full
   memory reset do not mutate `ProjectDocument`, undo history, or personal
   model weights. Personal models remain local artifacts and can be retrained
   from imported favorites. The user-facing full reset clears the legacy
   preference ledger, favorites, style examples and personal models.
6. `apply`, `undo`, `dismiss`, listening and `USE` are workflow outcomes, not
   taste labels. Only explicit pairwise choices and later-confirmed settled
   edits may become ranking evidence. Current intent and hard constraints
   always outrank learned preferences.
7. Evaluation of event packs is chronological and excludes candidate hashes,
   sessions and lineages observed in earlier data from held-out scoring. Legacy
   observations without group ids remain candidate-hash-disjoint only and
   carry an explicit caveat.

## Consequences

- Existing projects and their schema are untouched; this is a local persistence
  migration only.
- A bounded event history and separate bounded pattern store support intent
  correction, branch restore and per-item forgetting without logging raw
  prompts, project names or audio. Branches are scoped to a hashed project and
  track/pad identity so stale content is not silently replayed elsewhere.
  Explicit DNA exports also include the user's kept musical patterns; they do
  not include their original seed text or track labels.
- Existing A/B, settled-edit and brief-correction collectors write to the
  event store; the ranker hydrates pairwise/edit evidence from that durable
  history and merges the legacy synchronous ledger as a migration fallback.
  Apply, candidate-related undo and probe dismissal are workflow-only events.
  Exact-context intent corrections are offered back as explicit user-accepted
  suggestions.
- A larger memory, phrase learning, cloud sync, or a new learned model requires
  a separate decision and a user-visible privacy/control path.
