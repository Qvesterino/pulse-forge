# ADR 0077 — The schema version is a mechanism, not a comment

Date: 2026-10-28 · Status: Accepted (shipped) · Scope: project model, migration path, persistence boundary, project browser

## Context

Audit finding **F-13** (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-13) named one thing: **`migrateProject` was not
a migration.** It accepted any version at or below `SCHEMA_VERSION`, never branched on the source version,
and only stamped the version and normalised. The entire per-version history of the project format was a
**comment block** inside the function — prose that no test could see.

The audit's own worry was not "old projects break today". It was: _"there is no version-conditional code to
extend when a real breaking change lands. The first genuine breaking change will have nowhere to live except
inside the normaliser, where it is invisible and unreviewable."_

Re-measured against today's tree (not against the snapshot the audit was written from):

| #   | Question                                                   | Measured answer                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | does the source version discriminate anything?             | **No.** 40 source versions (0…39) produced **1** distinct output. `migrateProject(doc@v)` was byte-identical to `normalizeProject(doc)` for every `v`.                                                                                                                     |
| M2  | is there a version-conditional rule in the history at all? | **No — and that is a measured fact, not a gap.** The one candidate (v19 → v20 splits the master stereo link) is pinned by `tests/schema-migration.test.ts:113` to apply at version **38** as well, so it is a _tolerant repair_, not a version-conditional transformation. |
| M3  | is the declared version checked at all?                    | **No.** `schemaVersion` of `−5`, `−1`, `0`, `1`, `2` were accepted and stamped **39** — the document was re-labelled with a version it never had.                                                                                                                          |

M2 is the finding that decides the shape of the repair. A version-conditional rule is one where only the
document's **own declared version** tells you how to read an existing field. The codebase has never needed
one: every change so far was either **additive** (a new optional field; absent = default) or **tolerant**
(a deprecated field the normaliser still understands and repairs). So the migration chain is legitimately
almost empty — and the work is not to fill it with invented steps, but to make the chain **exist, be walked,
and be enforced**, so the first genuine transformation has a home that cannot be forgotten.

M3 splits in two, and the split matters:

- **An integer version at or below the current one is UPGRADED, never refused.** `tests/project-model/migrate-failure-paths.test.ts` pins this explicitly ("schemaVersion 0 … must not throw", "Negative must not throw"), and `AGENTS.md` invariant 6 says the loader rejects unknown **future** versions. A legacy document is the user's work; refusing it loses data the producer can still recover by hand.
- **A version that is not a version NUMBER is refused.** `NaN` and `1.5` were never written by any build; their shape is unknowable, and stamping them "current" asserts a provenance the document does not have. This is the one refusal that costs nothing.

## Decision

### 1. The version ledger is data, and it is total

`SCHEMA_HISTORY` replaces the comment block. Every version from `MIN_SCHEMA_VERSION` (1 — the version the
initial commit `4096423e` shipped) to `SCHEMA_VERSION` has an entry, and the entry says **what kind of
change it was**:

| `kind`      | What it means                                                                                                      | Step needed?                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `additive`  | the document simply lacks a new optional field; the normaliser's defaults make it current                          | no                                           |
| `inferred`  | a new field whose value must be DERIVED from what the old document holds (v12's delivery profile, v39's point ids) | no — the normaliser derives it version-blind |
| `transform` | the MEANING of an existing field changed                                                                           | **yes** — `MIGRATIONS[version − 1]`          |

The ledger is total **and asserted to be**: the gate test fails if a version has no entry. The history of the
format stopped being prose.

### 2. The chain exists, is walked, and is enforced in both directions

`MIGRATIONS[v]` upgrades a document stored under version `v` to `v + 1`. `migrateProject` walks it. The
chain is **sparse by design** — a version that only added an optional field needs no step, and a version
whose field is merely inferred needs no step either.

The gate test asserts the correspondence **in both directions**:

- every `transform` version has the step it demands (`MIGRATIONS[v − 1]` exists), and
- every step has a version that asks for it (`SCHEMA_HISTORY[k + 1].kind === "transform"`).

So a version cannot be declared a transformation without the step that implements it, and a step cannot
exist without a version that asks for it. **That is the enforcement**: the moment someone bumps the version
and marks the change a transformation, the suite goes red until the step is written.

### 3. The walk is injectable, so the mechanism is provable

`applyMigrations(doc, fromVersion, chain = MIGRATIONS)` takes the chain as an argument. A spec can hand in a
chain of its own and prove that the steps run **in ascending order**, **only for documents at or below the
step's own version**, and **not at all** for a document that is already current. Without this the chain
would be a decorative empty map — a husk that looks like a mechanism and is not one.

### 4. The one version-conditional rule has a version-aware home, and the tolerant path shares it

`MIGRATIONS[19]` is the v19 → v20 master-link split: v19 stored ONE combined stereo link, v20 stores TWO
(transient + release) and the v19 value maps to **both**.

The normaliser still repairs the deprecated field, because a document can also arrive **late** — a peer on
an older build, a hand-edited file — and must not silently lose its link setting. Both paths call **one**
function, `resolveLimiterLinks`:

```ts
export function resolveLimiterLinks(
  legacyStereoLink: unknown,
  transientLink: unknown,
  releaseLink: unknown,
): { transient: number; release: number };
```

One rule, two intents. The gate test asserts that the version-aware step and the tolerant path produce the
same numbers, so they can never drift apart and read the same field two ways.

### 5. What the build refuses, it refuses VISIBLY

A document the build cannot open must not **vanish** — that is the F-14 failure class, where a project that
`listAll` skipped looked LOST. `ProjectRepository.listIncompatible` now also lists a document whose version
is not a version number, and `IncompatibleProjectMeta` carries a `direction` (`newer` | `unsupported`) so the
browser can badge it honestly ("NEWER VERSION" vs "UNSUPPORTED VERSION") instead of lying about the side.

## Consequences

- **The first genuine breaking change has a home**, and cannot be added without the suite noticing. That is
  the whole point of the finding.
- **The migration path is still total.** Every integer version at or below the current one is upgraded. No
  legacy document is refused, and none disappears.
- **The version ledger is reviewable.** "What did v22 do" is a row in a table, not a paragraph in a comment,
  and the table is asserted to be complete.
- **`normalizeProject` keeps its job**: shape repair, version-blind, tolerant of a late arrival. It did not
  become a migration — that would have been the very defect this ADR removes.
- **The behaviour the audit locked in is unchanged**: migrating from every version yields exactly the
  normaliser's result. The gate test asserts it for all 39 versions, on a document that carries the v19
  combined link (the one field whose reading is version-sensitive).

## Alternatives rejected

- **Refuse every version below the current one.** Rejected: it contradicts an explicit contract test
  (`migrate-failure-paths.test.ts`) and `AGENTS.md` invariant 6, and it would make old projects vanish from
  the library — the F-14 failure class, reached from the other side. The past is the user's work.
- **Fill the chain with a step for every version.** Rejected as fiction: it would encode a claim ("this
  version needed a transformation") that no measurement supports. M2 shows the only candidate is a tolerant
  repair, pinned as such by an existing test.
- **Move the tolerant repair out of the normaliser into the chain.** Rejected: the collab path does not go
  through `migrateProject` (`ProjectStore` normalises directly), so a peer on an older build would lose its
  master-link setting. The repair must be reachable from both paths — which is why they share one function
  instead of one owning the field.
- **Leave the history as a comment and add an empty `MIGRATIONS` map.** Rejected: an empty map that nothing
  writes to is a husk. The ledger, the correspondence test and the injectable walk are what make the chain a
  mechanism rather than a placeholder.
- **Derive the ledger from the source history automatically.** Rejected: the note is prose, and prose does not
  compile. The value of the ledger is that it is a value.

## Verification

- `tests/schema-version-chain.test.ts` (14 specs, new) — the ledger is total and in range; the ledger and
  the chain correspond in both directions; the walk is version-aware, ordered and idempotent; migrating from
  every version yields the normaliser's result; the version-aware step and the tolerant path are one rule;
  the future and the non-numbers are refused; every integer version is still upgraded; and a document the
  build cannot open is **listed**, not lost.
- `tests/templates.test.ts`, `tests/persistence/round-trip-integrity.test.ts`, `tests/schema-migration.test.ts`,
  `tests/project-model/migrate-failure-paths.test.ts`, `tests/compatibility-golden.test.ts`,
  `tests/persistence/schema-evolution.test.ts`, `tests/collab.test.ts`, `tests/ui/ProjectBrowser.test.tsx` —
  green.
- `tests/automation-point-identity.test.ts` and `tests/mcp-target-substitution.test.ts` currently fail **at
  clean `HEAD` in an isolated worktree** — a parallel session rewrote `src/mcp/tools.ts` after F-07/F-08
  shipped. Not this ADR's regression; reported, not repaired.
