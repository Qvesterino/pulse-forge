# ADR 0075 — An automation point is addressed by identity, not by position or value

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: project model, command layer, structural delta, collab adapter

> **ADR number.** This was drafted as 0073 and renumbered: a parallel session claimed 0073 for
> `0073-tsar-controlled-mutations.md` while this finding was being repaired.

## Context

Audit finding **F-07** (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-07) and its sibling **F-29** describe one
seam: **an automation point had no identity of its own.** A point was `{ tick, value }` and nothing else,
so every reference to it was made through its _value_ or its _slot_.

Re-measured against today's tree (not against the snapshot the audit was written from), that single
decision produced **four** distinct defects:

| #   | Defect                                                                                  | Measured behaviour                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | the command layer duplicated an identical point                                         | `addAutomationPoint` twice with the same `(tick, value)` → lane points 1 → 2, undo stack 2 → 3. The MCP had a guard bolted on top of the command; the UI, the intent pipeline and collab did not. |
| M2  | the MCP's `movePoint` acknowledgement read the committed point back **by index**        | a point moved from bar 1 to bar 8 was acknowledged as `1.1=0.1 → 1.2=0.2` — it named a point the move never touched, because the lane had re-sorted and index 0 now held a different point.       |
| M3  | an undo could not re-anchor a point that had been **edited** since it was created       | the delta carried the point as it was; after the human moved it, the content matched nothing, the removal found no match and **removed nothing** — while still consuming a history entry.         |
| M5  | a positional capture (`lane.points[index]`) pointed at whatever occupied the slot later | the AI's delete, built against the doc it saw, removed the **human's** point after a collaborator inserted an earlier one.                                                                        |

The audit had already closed the _destructive_ half of F-29 at the delta layer (the `del` op now carries
the element it removed and verifies the slot before splicing). That fix is content-based, and it is
exact only while no two points in a curve are value-identical. It is also defeated by M3: content that
has _changed_ matches nothing at all.

The report itself named the correct repair — "give points a stable `id`; this is a `SCHEMA_VERSION` bump
plus a migration" — and scheduled it deliberately (S-3). It is not a workaround; it is the one change
that closes M1, M2, M3 and M5 at the same source.

**A class measurement first.** An AST probe over the whole program (not a regex) found 122 sites whose
contextual type is `AutomationPoint` — 25 in `src/`, 97 in tests. The 25 split into two kinds that must
NOT be treated alike:

- **authored** points, which live in the document (`AutomationLane`, `SceneAutomation`,
  `ArrangementAutomationClip`, `GenerativeMacroAutomation`) and need an identity;
- **ephemeral** points — interpolated ramp samples, live intensity curves — which never enter the
  document and have no identity to carry.

A _required_ `id` on the shared type would have forced meaningless ids onto the ephemeral class; an
_optional_ `id` would have let an authored point silently lose it. The repair keeps one type and
separates the two classes by **where the point lives**, not by how it is spelled.

## Decision

### 1. The point carries an identity; the type says why it is optional

```ts
export interface AutomationPoint {
  tick: number;
  value: number;
  id?: ID; // stable identity (SCHEMA v39+)
}
```

The `id` is **optional in the type** because the same shape serves ephemeral curves. It is **guaranteed
in the document**: the normaliser assigns one to every authored point that lacks it. The guarantee is
enforced, not hoped for — `tests/automation-point-identity.test.ts` asserts that every authored point in
a normalised document carries a unique id.

### 2. The normaliser is the migration

`SCHEMA_VERSION` 38 → 39. The migration is the normaliser: `assignPointIds` backfills an id on every
authored point that lacks one, across all four carriers (project lanes, scene automation, arrangement
automation clips, generative macro automation).

Two properties make that safe:

- **Existing ids are preserved.** A re-normalisation must never renumber a live document — every
  collaborator's copy would diverge.
- **A missing id is minted DETERMINISTICALLY** from the carrier and the slot (`pt-<carrierId>-<slot>`).
  Two clients that load the _same_ legacy file must derive the _same_ identity: a random id would make
  their collab merge treat every point as a new one. The points a command creates are minted with
  `uid("pt")` — one client creates them, so a random id is correct there.

### 3. The command layer addresses points by id

`addAutomationPoint` mints an id, refuses to insert a point that duplicates an existing
`(tick, value)`, and its undo re-anchors on the id. `moveAutomationPoint` **keeps** the point's id
across the move, and re-anchors on it. `deleteAutomationPoint` re-anchors on it. The scene-automation
and arrangement-clip commands got the same treatment. The re-anchor chain is
**id → object identity → `(tick, value)` (last match)**: the id is the authority, the other two are the
fallbacks for a document that predates v39.

The duplicate guard lives at the **command boundary**, not on one surface. The MCP had grown a guard of
its own; that guard was a shadow of the rule, and every other entry point (the UI, the intent pipeline,
a collab merge) bypassed it. Now the rule is in the one place all of them go through.

### 4. The structural delta anchors on the id — including the empty-array transition

`computeDocDelta` classified an array as an id-keyed entity list only when **both** sides were
non-empty. A curve that gained its **first** point therefore fell back to the positional diff, and the
removal op was anchored on a slot. The empty side carries no evidence about the element type — the
other side does. The classification now follows the side that has elements, which makes the
empty/non-empty transition consistent with the non-empty/non-empty one it already was.

### 5. The collab adapter carries the id

`YDocAdapter` writes points as Y.Maps and read them back with `.get()`. The id is now synced like any
other field, and read back. Without this, a peer that received a point would mint its own identity and
the two would be different points to every undo, the delta and the next merge.

## Consequences

- **An undo removes the entity it created.** Not "whatever occupies its slot", and not "the first point
  with the same value". The invariant I-14 in the audit is now mechanically true.
- **A curve cannot hold two indistinguishable points.** The duplicate guard sits where every entry
  point meets the domain, so the rule cannot be bypassed by adding a new surface.
- **The MCP's acknowledgement names the point it acted on**, read back from the committed document by
  id — not by index, and not by value.
- **The document shape changed**: an authored point carries an `id`. `SCHEMA_VERSION` 38 → 39; a v38
  file loads, is normalised, and comes back with ids on every point. `migrateProject` still does not
  branch on version (that gap is **F-13**, open and untouched by this ADR) — for an additive optional
  field the normaliser _is_ the migration, and that is honest here.
- **The collab merge is deterministic.** Two clients that load the same legacy file derive the same
  point identities, so the merge sees the same points and not two sets.

## Alternatives rejected

- **De-duplicate identical inserts and undo the last match; no schema change.** Rejected: it does not
  close M3 (a point that was _edited_ matches nothing) and it does not close M5 (a positional capture
  still points at whatever took the slot). A value-identical pair can also be reached by an _edit_, not
  only by an insert — the human drags the AI's point onto the AI's own coordinates.
- **Give every point a required `id`.** Rejected: it would force meaningless identities onto the
  ephemeral class — interpolated ramp samples and live intensity curves, which never enter the
  document — and it would have touched 122 construction sites for no gain.
- **Rename the shared type and split it into an authored and an ephemeral shape.** Rejected as churn
  without a gain: the two classes differ in _where they live_, and the normaliser already knows that.
- **Make the delta's content match smarter.** Rejected: two byte-identical points are indistinguishable
  by any content rule, and a point whose content _changed_ matches nothing. Identity is the only
  information that survives both.

## Verification

- `tests/automation-point-identity.test.ts` (8 specs, new) — the identity is present and unique, the
  legacy backfill is deterministic and preserves existing ids, normalisation is idempotent, the command
  layer refuses a duplicate, M3/M5/M2 are closed, and the delta's removal op is id-anchored.
- `tests/mcp-target-substitution.test.ts` (4 specs, new) — the F-08 counterpart (ADR 0076).
- `tests/doc-delta.test.ts`, `tests/automation-*.test.ts`, `tests/commands.test.ts`,
  `tests/referential-integrity.test.ts`, `tests/mcp-tools.test.ts` — green; the assertions that pinned
  an exact point object now pin the tick/value and let the id ride along.
