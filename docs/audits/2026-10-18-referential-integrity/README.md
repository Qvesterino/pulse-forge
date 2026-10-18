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

| family | what it covers |
| --- | --- |
| canonical | `testDoc()`, `deterministicTestDoc()`, and a purpose-built `richDoc()` carrying a clip of every system |
| corrupted | 31 classes, each injecting exactly one broken reference, then asserting `normalizeProject` repairs it |
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
function's own comment states the consequence of not doing so: *"the stale id survived
every save (schema keeps any string) and the scheduler silently fell back to the
global preview bus."*

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

Its doc-comment read *"Filter + clamp marker points (drop empty, **dedupe by id**, sort
by tick)"*. The body had no dedupe. The code now matches its own contract.

Markers are deliberately **not** also listed in the new domain-level dedupe: the first
falsification run proved the two overlap. Keeping both would have been the same
invariant enforced twice, and the second copy would have been untested. One owner,
provably load-bearing.

---

## Deliberately NOT changed — documented contract, not a defect

`scenes[].packs`, `.macros`, `.ccRemaps`, `.ccOverrides` and `.modulators` **keep
unknown ids by design**. The source says so for each:

- `packs`: *"pair ids are matched against the packs at use time, so an unknown id is
  dropped by the engine"*
- `macros`: *"macro existence is matched at use time (an unknown id is inert)"*
- `ccOverrides` / `modulators`: *"Unknown mapping ids stay inert"* / *"Unknown lfo ids
  stay inert"*

They are **named identities** matched at use time. Dropping one on load would destroy a
user's scene automation because a referenced entity is *temporarily* absent. An auditor
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

`tests/referential-integrity.test.ts` — 39 specs.

| block | specs | what it pins |
| --- | --- | --- |
| auditor calibration | 4 | the auditor reports a violation when given one; sees a duplicate; canonical docs are clean; the rich fixture is clean before corruption |
| corruption classes | 31 | each injects one broken reference, asserts the auditor sees it, then asserts `normalizeProject` repairs it |
| inert-by-contract | 2 | scene pins for unknown macro / cc / lfo / fx ids survive |
| delete commands | 5 | `deleteTrack`, its undo and redo, `deleteReturnTrack` + undo, `deletePattern`, `removeEffectFromTracks` + undo — all clean afterwards |

Contributor rule is in the file header: a new persisted field that points at another
entity must be added to `auditReferences` **and** to the corruption classes. A reference
the auditor does not know about is a reference nobody checks.

---

## Verification

| check | result |
| --- | --- |
| `npx vitest run tests/referential-integrity.test.ts` | **39 passed** |
| `npx tsc -p .artifacts/tsconfig.audit15.json` (scoped to the two changed files) | **exit 0** |
| falsification harness (`.artifacts/falsify-audit15.mjs`) | **7/7 mutations went red, control included** |
| `npm run typecheck` (whole repo) | **BLOCKED** — pre-existing syntax error in `src/ui/padChannelState.ts:26` (`T>;`, missing `)`), committed by the parallel session in `ba7a2261`. Not this change; not touched. |
| full `npm run test` | see the completion report — the suite was still running when this file was written |

### Falsification

A green suite proves nothing until each guard is shown able to go red. Each fix was
reverted one at a time; the matching test had to fail.

| mutation | reverted | verdict |
| --- | --- | --- |
| M1 | `dedupeEntityIdsDomain` removed from the pipeline | DETECTED |
| M2 | `sanitizeMarkers` stops deduping by id | DETECTED |
| M3 | `normalizeMarkersDomain` stops clearing a dead `linkedClipId` | DETECTED |
| M4 | `normalizeMidiDomain` stops rejecting an unknown `padId` | DETECTED |
| M5 | `drumNoteMap` change-detection removed from the rebuild guard | DETECTED |
| M6 | scene macro pins dropped | DETECTED |
| **C1 (control)** | **the auditor's own duplicate detection neutered** | **DETECTED** |

The control is what makes the other six meaningful: it proves the harness can see red
in the test file itself.

Three harness failures had to be diagnosed before any verdict could be trusted, and
each one initially looked like "weak guard":

1. **First run: 0/7, all `UNCLEAR`.** `execFileSync` cannot spawn `npx` on Windows
   without `shell: true`; every run threw with `status: null` and empty output. The
   control was `UNCLEAR` too — the signature of a broken harness, not six weak guards.
2. **Second run: crash mid-restore, worktree left MUTATED.** `copyFileSync` *replaces*
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

## Remaining Risks

1. **`normalizeProject` is on the critical path of every command.** `dedupeEntityIdsDomain`
   runs first and allocates two `Set`s per collection on every apply, on every command,
   on every autosave. The cost is linear in entity count and the whole pass is a no-op
   on a valid document, but it is a new O(n) step on the hottest path in the app and has
   not been profiled under a large project.
2. **Cross-system clip-id collisions are not repaired.** Within each of the four clip
   systems ids are deduped; an audio clip and a midi clip sharing one id would survive.
   Markers, transitions and clip groups resolve against the union, so such a collision
   would be ambiguous for them. No reachable producer creates one (the `uid()` prefixes
   differ), so this is deliberate — repairing it would destroy content to fix a collision
   nothing can produce. Revisit if a new import path ever mints ids itself.
3. **Import is not end-to-end validated.** Every gap found here lived on the
   out-of-band path, and the auditor now covers the classes it knows about. A new
   persisted field that references another entity is still only protected if someone
   adds it to `auditReferences`.
4. **The repository-wide `npm run typecheck` gate is red** on a file this audit did not
   touch (`src/ui/padChannelState.ts`, committed in `ba7a2261`). Until that is fixed,
   whole-repo typecheck cannot be used as a gate for anything — which is why this audit
   verified its two files with a scoped tsconfig.
5. **`docs/CURRENT-STATE.md` was intentionally left unmodified.** It is mid-edit by the
   parallel session; committing it would have swept their uncommitted changes into this
   commit. The spec-file count needs no bump — `tests/referential-integrity.test.ts` was
   already absorbed into commit `ba7a2261`, so the committed count of 1080 already
   includes it. **The audit-15 invariants are therefore not yet documented in
   CURRENT-STATE.md** and should be added when that file is next committed cleanly.