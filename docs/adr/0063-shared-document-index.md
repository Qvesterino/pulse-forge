# ADR 0063 — The document index is derived, shared, and invalidated by identity

Date: 2026-10-25 · Status: Accepted (shipped) · Scope: project model, audio engine, automation targets

## Context

The performance-cliff audit (`docs/PERFORMANCE_CLIFF_DETECTOR_REPORT.md`) found the same defect
three times in three costumes: **per-item work that scans the whole collection.**

- `soloAudibility(doc).audible(id)` resolved its track with `doc.tracks.find(...)`. The rule is
  consulted **once per track** on every document change — the mixer, the drum scheduler and the
  group commands all read it — so one edit cost **O(T²)**. Measured: the marginal cost per track
  doubled with every doubling of the track count (0.375 → 3.978 µs at 32 → 256 tracks; 16 tracks
  0.0097 ms → 256 tracks **0.684 ms** per document change).
- `AudioEngine.syncPdc()` did the same lookup inside a loop over the track nodes, **twice**.
- `targetOwner()` did it per automation lane per scheduler tick — the automation bridge resolves
  a target per lane per tick and per write.

The audit's strategic conclusion was that this is not three bugs but one missing **mechanism**:
_"if you touch items in a loop, build the index once, outside the loop, and invalidate it by
identity."_ Fixing three sites would have left the pattern available for the next one.

**The codebase already knew the answer.** `normalizeArrangementDomain` builds `scenesById` and
`patternsById` maps once and uses them inside its per-clip map (`src/project-model/schema.ts:1698`).
The problem was never knowledge. It was that the one-line `tracks.find(...)` is always writable
and a shared index is not — **the slow option is the writable one**, so the code chooses it.

The second finding was the good news: the document is **copy-on-write**. `applyDocDelta` applies
operations functionally, keeps the references of unchanged branches, and returns the document
itself when nothing applied (`src/commands/docDelta.ts:245-256`); a command that changes nothing
returns the same document object (`src/store/ProjectStore.ts:257`). So **document identity IS
document version** — which makes a correct cache free.

## Decision

**The document gets one derived index, built once per document version, invalidated by identity.**

1. **`src/project-model/doc-index.ts` owns the index.** `getDocIndex(doc)` returns the index for
   that document version. It is **derived data, never a second source of truth** — the project
   model owns the truth (invariant 1); the index owns a lookup. Nothing writes through it.
2. **Invalidation is free, because the architecture already provides it.** The index is held in a
   `WeakMap` keyed by the document object. A mutation produces a new document (a new key; the old
   entry dies with the old document). A no-op produces the same document (the index stays valid).
   No version counter, no dirty flag, no explicit invalidation call that can be forgotten.
3. **A replaced collection invalidates it too.** The template factories assign `doc.tracks = [...]`
   on the document object, which a `WeakMap` keyed by the document cannot see. The index therefore
   also remembers the array references it was built from and rebuilds when any of them changed.
   _In-place mutation of an array (push/splice) would still be invisible to it; nothing in `src/`
   does that to a project document, and that is now a stated invariant rather than an accident._
4. **Each collection is indexed on first use.** A consumer that only needs the tracks does not pay
   for the scenes and the patterns.
5. **The first match wins — exactly like the scan it replaces.** `doc.tracks.find(t => t.id === id)`
   returns the FIRST match; `new Map(items.map(i => [i.id, i]))` keeps the LAST. A document with a
   duplicate id would otherwise get a different answer from the index than from the scan. The rule
   that decides audibility must not change because of an optimization.
6. **The consumers are the three hot paths the audit named:** `solo-audibility.ts` (the rule),
   `AudioEngine.syncPdc()` (the per-document-change bookkeeping), and `targets.ts`'s
   `targetOwner()` (the per-lane-per-tick resolution).

## Consequences

- The O(T²) is gone from the most frequent interaction in the product, and the O(T) term is gone
  from the per-lane-per-tick path.
- **The cost model of the codebase changes.** New code has a cheap way to resolve a track, and the
  audit's rule — _build the index once, outside the loop_ — becomes the default rather than a
  review comment.
- The index is a **cache, and caches rot.** A consumer that holds a map across a document change
  without asking the index again is holding a stale view. The API makes that awkward (the map is
  only reachable through `getDocIndex(doc)`), but it is not impossible.
- The index is **not** a place to put state. It is a lookup. Anything mutable belongs in the
  project model, where the truth lives.
- The `WeakMap` keeps the index alive exactly as long as the document version it describes. No
  leak: the entry dies with the document.

## Alternatives considered

- **A `Map` rebuilt per call.** Rejected: it is O(T) again on a path that is consulted per track,
  and it throws away the one thing copy-on-write gives for free.
- **An index owned by the store, with explicit invalidation.** Rejected: it would be a second
  source of truth that can go stale — the store would have to be told about every path that
  replaces a document, and every path that mutates one. Identity is the invalidation signal the
  architecture already provides, and it cannot be forgotten.
- **A general "project model API" layer with getters for everything.** Rejected for now: it is a
  much larger surface, and the audit's evidence only justifies the lookups that are actually hot.
  The index grows one collection at a time, each time a consumer needs it.

## Verification

- `tests/doc-index.test.ts` — the gate. It pins three things: the audibility rule answers exactly
  like the pre-index rule at 16, 64 and 256 tracks (the pre-index rule is copied into the test as
  an oracle); the audibility path performs **zero** list scans (a count, not a millisecond, so it
  does not care how busy the machine is); and every count assertion is paired with a **positive
  control** that proves the spy sees a scan when one happens. A guard that cannot fail is worse
  than no guard.
- `scripts/bench-hotpath.ts` case **P.2** — the permanent A/B: the pre-fix rule and the current
  rule measured side by side in the same process, same V8, same heap, interleaved so drift hits
  both sides. It is the repo's own regression instrument, not a throwaway probe.
