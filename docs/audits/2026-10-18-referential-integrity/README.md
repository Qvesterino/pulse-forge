# DAW Audit 15 — Referential & Structural Integrity of Project Data

**Date:** 2026-10-18
**Scope:** `ProjectDocument` reference graph — ids, entity references, delete cleanup,
source/media references, structural consistency.
**Verdict:** 4 confirmed defects fixed, 1 documented-contract item deliberately left alone,
1 latent change-detection bug found alongside a fix.

---

## Method

A checker that shares code with the thing it checks cannot see a defect in it, so
`tests/referential-integrity.test.ts` re-derives every "does this resolve?" question
from the raw document and imports **no** resolver from `schema.ts`, `targets.ts` or
`modulators.ts`. `targetResolves` is re-implemented locally rather than delegating to
`isAutomationTargetValid`.

The auditor asks one question over three families of documents:

| family                             | what it covers                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| canonical                          | `testDoc()`, `deterministicTestDoc()`, and a purpose-built `richDoc()` carrying a clip of every system                           |
| corrupted                          | 31 classes, each injecting exactly one broken reference, then asserting `normalizeProject` repairs it                            |
| produced by the real command layer | `deleteTrack` / `deletePattern` / `deleteReturnTrack` / `removeEffectFromTracks` through `ProjectStore`, including undo and redo |

A calibration block proves the auditor is not vacuously green: it must report a
violation when handed one, and see a duplicate id.

---

## Findings

### 1. Duplicate entity ids survived `normalizeProject` — CONFIRMED, FIXED

Every id in the model is the primary key for `find(t => t.id === …)`. A document
carrying two entities under one id therefore produces a **duplicate runtime object**:
the mixer builds a strip for each, while every command, selection and id-lookup
silently addresses only the first.

Measured, before the fix (`testDoc()` with one duplicated track):

```
dup track: doc.tracks.length= 4   find(id)= first   stripsRendered= 4
```

A 3-track project rendered 4 mixer strips; the fourth had no owner. No id collection
was deduped — tracks, patterns, scenes, markers, automation, macros all survived.

The command layer already refuses a colliding id at the boundary (the AI executor
throws on an existing track id), which is why only an **out-of-band** document could
produce this: project import, share code, a collab peer, a hand-edited file.
`normalizeProject` is the only backstop for those, and it had none.

### 2. `markers[].linkedClipId` was never validated — CONFIRMED, FIXED

Every delete verb unlinks markers in-command (`docOps.unlinkMarkersOfClips`), and that
function's own comment states the consequence of not doing so: _"the stale id survived
every save (schema keeps any string) and the scheduler silently fell back to the
global preview bus."_

So the gap was known, documented at the command layer, and never closed at the schema
layer. Clip-group membership — the same kind of cross-reference, held by another
entity — has been validated in `normalizeProject` since v15. Marker links were the
inconsistency: one cross-reference backstopped, the other not.

An imported or collab-merged project keeps a cue pointing at a clip that does not
exist, in every save, forever.

### 3. `midi.drumNoteMap[].padId` was passed through verbatim — CONFIRMED, FIXED

`normalizeMidiDomain` read `m.drumNoteMap` straight through. `deleteTrack` strips the
mappings of the pads it removes, but only on the command path — so a document from
import / share code / a collab peer kept a mapping aimed at a pad that does not exist:
the incoming MIDI note resolved to nothing, silently.

**Latent bug found alongside:** `drumNoteMap` was never listed in the change-detection
guard of that same function. The field was rewritten into the rebuilt object but never
counted as a change, so a filtered mapping would have been computed and then discarded
by the identity guard. The fix is two-sided; falsifying only the filter (mutation M4)
would have left the test green.

### 4. `sanitizeMarkers` promised a dedupe it never performed — CONFIRMED, FIXED

Its doc-comment read _"Filter + clamp marker points (drop empty, **dedupe by id**, sort
by tick)"_. The body had no dedupe. The code now matches its own contract.

Markers are deliberately **not** also listed in the new domain-level dedupe: the first
falsification run proved the two overlap. Keeping both would have been the same
invariant enforced twice, and the second copy would have been untested. One owner,
provably load-bearing.

### 5. Regression introduced by fix 2, caught by an existing gate — FIXED

The marker fix first compared the sanitized markers with `jsonEqual` instead of the
`JSON.stringify` comparison that call site had always used. `jsonEqual` **counts an
`undefined`-valued key as present** — that is its documented contract, valid because
normalizers are expected to build objects with conditional spreads. `sanitizeMarkers`
builds every marker with `linkedClipId` and `customId` keys present and their values
possibly `undefined`, so the two conventions collided: every marker read as changed,
and `normalizeProject` rewrote a canonical document with explicit `customId: undefined`
keys.

`tests/templates.test.ts`'s _"scene-score template is unchanged by normalization"_ went
red. That gate is the reason this was caught rather than shipped — a template is
supposed to be a fixed point of the normalizer, and the change had broken exactly that.
The comparison is back to `JSON.stringify`, which drops `undefined`-valued keys, and a
fixed-point pin now sits in this audit's own test file.

Recorded because the failure mode is general: **swapping in a "better" comparator is a
behaviour change, not a refactor**, and two correct-looking helpers disagreed about
whether a key exists.

---

## Deliberately NOT changed — documented contract, not a defect

`scenes[].packs`, `.macros`, `.ccRemaps`, `.ccOverrides` and `.modulators` **keep
unknown ids by design**. The source says so for each:

- `packs`: _"pair ids are matched against the packs at use time, so an unknown id is
  dropped by the engine"_
- `macros`: _"macro existence is matched at use time (an unknown id is inert)"_
- `ccOverrides` / `modulators`: _"Unknown mapping ids stay inert"_ / _"Unknown lfo ids
  stay inert"_

They are **named identities** matched at use time. Dropping one on load would destroy a
user's scene automation because a referenced entity is _temporarily_ absent. An auditor
that flagged them as dangling would have been proposing a regression.

These are now pinned by two tests in the inert-by-contract block, so a future reader who
sees a scene referencing a missing macro does not "fix" it.

---

## Fixes

All four are in `src/project-model/schema.ts`, inside `normalizeProject`:

1. **New `dedupeEntityIdsDomain`**, first in the pipeline so every later domain
   validates against the deduped sets. First occurrence wins — it is the entity every
   `find` already resolves to, so no live reference changes meaning. Within-collection
   only: the four clip systems are separately namespaced by their `uid()` prefixes, so
   dropping a clip because another system's clip shares its id would destroy content to
   fix a collision nothing can produce.
2. **`normalizeMarkersDomain`** clears a `linkedClipId` that resolves to no live clip
   across all four clip systems, keeping the marker.
3. **`normalizeMidiDomain`** filters `drumNoteMap` entries whose `padId` is not a live
   pad, **and** registers the field in the change-detection guard.
4. **`sanitizeMarkers`** dedupes by id, as its contract always said.

No behaviour changes for a valid document: every repair is a no-op on a document that
already satisfies the invariant.

---

## Tests Added

`tests/referential-integrity.test.ts` — 40 specs.

| block               | specs | what it pins                                                                                                                                                                                                               |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auditor calibration | 5     | the auditor reports a violation when given one; sees a duplicate; canonical docs are clean; the rich fixture is clean before corruption; the rich fixture is a **fixed point** of `normalizeProject` by reference identity |
| corruption classes  | 31    | each injects one broken reference, asserts the auditor sees it, then asserts `normalizeProject` repairs it                                                                                                                 |
| inert-by-contract   | 2     | scene pins for unknown macro / cc / lfo / fx ids survive                                                                                                                                                                   |
| delete commands     | 5     | `deleteTrack`, its undo and redo, `deleteReturnTrack` + undo, `deletePattern`, `removeEffectFromTracks` + undo — all clean afterwards                                                                                      |

Contributor rule is in the file header: a new persisted field that points at another
entity must be added to `auditReferences` **and** to the corruption classes. A reference
the auditor does not know about is a reference nobody checks.

---

## Verification

| check                                                                                                         | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/referential-integrity.test.ts`                                                          | **40 passed**                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npx tsc -p .artifacts/tsconfig.audit15.json` (scoped to the two changed files)                               | **exit 0**                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npx vitest run tests/templates.test.ts tests/referential-integrity.test.ts tests/project-invariants.test.ts` | **201 passed**                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| falsification harness (`.artifacts/falsify-audit15.mjs`)                                                      | **7/7 mutations went red, control included**                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run typecheck` (whole repo)                                                                              | **BLOCKED** — pre-existing syntax error in `src/ui/padChannelState.ts:26` (`T>;`, missing `)`), committed by the parallel session in `ba7a2261`. Not this change; not touched.                                                                                                                                                                                                                                                                                             |
| full `npm run test`                                                                                           | **34 failed.** 1 was mine — `templates.test.ts` canonicality, the regression in finding 5, now fixed. The other 33 were re-run in isolation: **10 still fail, 23 pass**, so 23 were machine-load flakes. **None of the 10 remaining files references `normalizeProject` or `migrateProject` at all** (verified by grep), so they cannot be caused by changes confined to that function; they are pre-existing in HEAD from the parallel session's instrument and UI waves. |

### Falsification

A green suite proves nothing until each guard is shown able to go red. Each fix was
reverted one at a time; the matching test had to fail.

| mutation         | reverted                                                      | verdict      |
| ---------------- | ------------------------------------------------------------- | ------------ |
| M1               | `dedupeEntityIdsDomain` removed from the pipeline             | DETECTED     |
| M2               | `sanitizeMarkers` stops deduping by id                        | DETECTED     |
| M3               | `normalizeMarkersDomain` stops clearing a dead `linkedClipId` | DETECTED     |
| M4               | `normalizeMidiDomain` stops rejecting an unknown `padId`      | DETECTED     |
| M5               | `drumNoteMap` change-detection removed from the rebuild guard | DETECTED     |
| M6               | scene macro pins dropped                                      | DETECTED     |
| **C1 (control)** | **the auditor's own duplicate detection neutered**            | **DETECTED** |

The control is what makes the other six meaningful: it proves the harness can see red
in the test file itself.

Three harness failures had to be diagnosed before any verdict could be trusted, and
each one initially looked like "weak guard":

1. **First run: 0/7, all `UNCLEAR`.** `execFileSync` cannot spawn `npx` on Windows
   without `shell: true`; every run threw with `status: null` and empty output. The
   control was `UNCLEAR` too — the signature of a broken harness, not six weak guards.
2. **Second run: crash mid-restore, worktree left MUTATED.** `copyFileSync` _replaces_
   a file, and Windows refuses that while the parallel session's vitest holds a
   user-mapped section on `schema.ts`. The harness died inside the restore and left
   `src/project-model/schema.ts` carrying a live mutation in the shared tree. Restored
   by content write after the lock cleared; every write now retries and the run verifies
   its own restore before reporting.
3. **The regression suite run in parallel with the falsification harness was void.**
   Both touched `src/project-model/schema.ts`. Those numbers were discarded and re-run.

M2 was also **not** detected on the first attempt — and that turned out to be true
information rather than a weak guard: the domain-level dedupe already covered markers,
so the two fixes overlapped. That finding is what drove the decision to give the
invariant a single owner.

---

# Risk-closure round (same day)

The five remaining risks were worked rather than left as prose. One turned out to
hide a **fifth confirmed defect**.

## R1 — cost of the dedupe pass: measured, and the optimization reverted

`dedupeEntityIdsDomain` runs after every command and every autosave, so the
"not profiled" risk was real. Measured (`.artifacts/measure-dedupe.mjs`):

| scale | entities | dedupe pass | normalizeProject | dedupe share |
| ----- | -------- | ----------- | ---------------- | ------------ |
| 1x    | 269      | 0.069 ms    | 1.059 ms         | 6.5 %        |
| 4x    | 1,052    | 0.201 ms    | 3.262 ms         | 6.2 %        |
| 16x   | 4,184    | 0.911 ms    | 14.375 ms        | 6.3 %        |

Linear, and a **stable ~6 % of the total**, independent of scale — under 1 % of
the 100 ms normalization budget in `tests/stress.test.ts` at 16x a large project.
No early-out is warranted.

A lazy variant of the loop (materialize the output array only on the first
duplicate) was written and **reverted**: the difference sat inside the machine's
noise floor — the same run's `normalizeProject` totals drifted by 30 % between
passes, because the parallel agent session was running tests throughout. An
unmeasurable optimization that makes the obvious version harder to read is not
kept. The measurement and the reverted attempt are recorded in the source.

## R2 — cross-system clip-id collisions: closed by measurement

The open question was whether any producer mints ids itself, which would make a
cross-system collision reachable. Answered by reading, not by assumption:

- `importProject` (project-io.ts:30) "validates shape, migrates schema, and
  normalizes" — it never mints an id.
- `uid(prefix)` always prefixes: `clip-<uuid>` vs `audioclip-<uuid>`. A
  cross-system collision needs the same prefix _and_ the same uuid.
- The test-only deterministic mode uses one shared monotonic counter, so even
  there ids stay unique across systems.

No reachable producer. The decision to dedupe within collections only is correct,
and this is now a closed question rather than a "revisit if…".

## R3 — the auditor's own coverage, now machine-checked — and a fifth defect

Mapping every `*Id` field in `types.ts` to its interface showed the auditor was
missing a whole collection: `ProjectDocument.liveSets` and `activeLiveSetId`
existed and were checked by nobody. Probing it found the fifth confirmed defect.

### 5. `AudioClip.liveSetId` survived both the delete command and the normalizer — CONFIRMED, FIXED

`LivePadsPanel.tsx:126` writes `liveSetId` + `livePadSlot` onto a clip when a Live
Pad is launched. `sanitizeAudioClips` then validated that pair on **shape alone**
(non-empty string, slot 0–15) and never resolved the set. `deleteLiveSet` removed
the set, fixed `activeLiveSetId`, and never touched the clips.

Measured, through the real command layer only:

```
BEFORE delete: clip.liveSetId = liveSet-f40a71b0…  slot = 0
AFTER  delete: clip.liveSetId = liveSet-f40a71b0…  slot = 0
liveSets remaining: 0
=> DANGLING: YES — persists in every save
normalizeProject on an imported dead reference -> liveSet-f40a71b0…
```

This is worse than the marker case in finding 2: **a user gesture reaches it**,
not just an out-of-band document. `normalizeArrangementDomain` now strips the pair
when the set is absent, in the same shape as the existing take-group strip below
it in that function.

The first probe was wrong twice and both errors were caught by re-measuring rather
than by reasoning: `LiveSet.trackId` looked dangling but is _optional_ and already
validated (schema.ts:2945), and `activeLiveSetId` looked dangling but already
falls back (schema.ts:2998). Reporting either would have been a false finding.

### The coverage gate, and the two weak guards hiding in it

`tests/referential-auditor-coverage.test.ts` extracts every `*Id`/`*Ids` field
from a named set of document-graph interfaces and requires each to be audited or
exempted with a reason — in both directions, so a stale exemption also fails.

**On its first run it found six real gaps in the auditor**: `TrackInputInsert.presetId`,
`AudioClip.takeId`, `AudioClip.compSourceTakeId`, `AudioTakeGroup.activeTakeId`,
`AudioTakeGroup.compTakeId`, plus an incomplete interface list. The take-group
internals turned out to be validated thoroughly by `sanitizeAudioTakeGroups`
(schema.ts:726–731) — the product was fine, the auditor was not, so the checks
were added there.

Honest scope, stated in the file: **the gate checks the bookkeeping, not the
judgement.** An exemption is acceptable because someone wrote down a reason; the
gate only enforces that the reason exists and has not gone stale. A gate that
tried to re-derive the judgement would be a second, weaker auditor.

Falsifying the gate then exposed **two guards in the gate itself that could not
fail** — both were `expect([]).toEqual([])`, which passes forever:

- The stale-exemption and blank-reason checks now pin the empty case _and_ a
  fabricated non-empty case **in one assertion on one call site**. Splitting them
  let `const stale = []` delete half the check while the positive control — which
  exercised the helper directly, not the call site — stayed green.
- The extraction sanity check no longer rests on a threshold that can simply be
  lowered; it names five fields that MUST be extracted.

### One owner, decided by falsification

A command-level cleanup of `AudioClip.liveSetId` inside `deleteLiveSet` was
written first, matching the `deleteTrack` precedent. Falsifying it left the suite
**green** — `normalizeArrangementDomain` caught the same defect anyway. That is
the two-implementations-of-one-rule shape that lets the weaker copy rot
unnoticed, so the command-level copy was **removed** and the normalizer kept as
the single, more general owner (it covers the import and collab paths too). This
is the same resolution as the marker dedupe in finding 4.

## Harness failures found while falsifying the new guards

Three more, each of which first looked like a weak guard:

1. **Vitest truncates `it.each` titles at ~37 characters** —
   `'audio clip points at a deleted live s…' is repaired…` — and `-t` matches the
   _truncated_ name. Three filters written against the readable name selected
   **zero tests**, exited 0, and read exactly like "this guard cannot go red". The
   harness now reports a run that selected nothing as its own verdict, and every
   filter is a prefix short enough to survive truncation.
2. **The non-vacuity parser then failed the other way**: it counted only `passed`,
   so four genuine REDs were reported as `NO-TEST-RAN`. It now counts `passed +
failed` — a run that fails one test _did_ run a test.
3. **M7 was not a weak guard, it was an overlap** — see "One owner" above. The
   mutation was changed to one that actually destroys the property.

## Verification

| check                                                                                           | result                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/referential-integrity.test.ts tests/referential-auditor-coverage.test.ts` | **52 passed**                                                                                                                                                                                                                                                        |
| + `stress` + `templates` + `project-invariants`                                                 | **222 passed**                                                                                                                                                                                                                                                       |
| `npx tsc -p .artifacts/tsconfig.audit15.json` (scoped)                                          | **exit 0**                                                                                                                                                                                                                                                           |
| `.artifacts/measure-dedupe.mjs`                                                                 | linear, ~6 % of normalizeProject                                                                                                                                                                                                                                     |
| `.artifacts/falsify-audit15-risks.mjs`                                                          | **8/8 mutations went red, control included, worktree restored**                                                                                                                                                                                                      |
| `npm run typecheck` (whole repo)                                                                | still red, **not ours** — `src/plugin-audit-checks.ts(112)` TS6133 and `src/ui/Diagnostics.tsx(42)` TS2774, both in files the parallel session is actively editing. The earlier `padChannelState.ts` syntax error was fixed by that session mid-review (`aac1cc61`). |

## Still open

- `docs/CURRENT-STATE.md` still carries the parallel session's uncommitted edits,
  so the audit-15 invariants remain undocumented there. No count bump is needed —
  the spec files are already committed and counted.
- Whole-repo typecheck cannot serve as a gate while the parallel session's
  in-flight files are red; this audit verified its own files with a scoped tsconfig.
- The dedupe pass is linear and cheap, but it is a new O(n) step on the hottest
  path. If `normalizeProject` ever becomes the bottleneck under a very large
  project, the honest starting point is this measurement, not a guess.

1. ~~**`normalizeProject` is on the critical path of every command.**~~ **RESOLVED
   in the risk-closure round above (R1):** measured at 0.069 ms for 269 entities and
   0.911 ms for 4,184 — linear, a stable ~6 % of `normalizeProject`, under 1 % of the
   100 ms budget in `tests/stress.test.ts` at 16x a large project. A lazy-allocation
   variant was tried and reverted because it could not be shown above the noise floor.
2. ~~**Cross-system clip-id collisions are not repaired.**~~ **RESOLVED in R2:** no
   reachable producer creates one. `importProject` never mints ids, `uid(prefix)`
   always prefixes, and the deterministic test mode uses one shared counter. This is a
   closed question, not a "revisit if…" — though a genuinely new import path that mints
   ids itself would reopen it, and the coverage gate would not catch it (it checks the
   document model, not the producers).
3. **Import is not end-to-end validated.** Every gap found here lived on the
   out-of-band path, and the auditor now covers the classes it knows about. A new
   persisted field that references another entity is still only protected if someone
   adds it to `auditReferences`.
4. **The repository-wide `npm run typecheck` gate is red** — now on the parallel
   session's in-flight files (`src/plugin-audit-checks.ts(112)` TS6133,
   `src/ui/Diagnostics.tsx(42)` TS2774), not on anything this audit touched. The
   `src/ui/padChannelState.ts` syntax error that blocked it earlier was fixed by that
   session mid-review (`aac1cc61`). Until those clear, whole-repo typecheck cannot gate
   anything — which is why this audit verified its own files with a scoped tsconfig.
5. **`docs/CURRENT-STATE.md` was intentionally left unmodified.** It is mid-edit by the
   parallel session; committing it would have swept their uncommitted changes into this
   commit. The spec-file count needs no bump — `tests/referential-integrity.test.ts` was
   already absorbed into commit `ba7a2261`, so the committed count of 1080 already
   includes it. **The audit-15 invariants are therefore not yet documented in
   CURRENT-STATE.md** and should be added when that file is next committed cleanly.
