# ADR 0064 — TSAR: the Forge offers READINGS, and a source lives beside the patch

Date: 2026-10-25 · Status: Accepted · Scope: the TSAR Sample Forge, the TSAR
command path, the preview path, the source record model

## Context

The Sample Forge (`src/tsar/forge.ts`) analysed a dropped file and returned
**ONE** plan: one engine, one root, one envelope. `forgePlan` hard-branched at
the end — `kind === "one-shot" ? "sampler" : stable ? "wavetable" : "granular"`
— so a producer who dropped a single recording had exactly one possible
outcome, and no way to hear an alternative before committing to it. The
flagship roadmap (wave 3) asks for the opposite: one import, several
honest readings, heard before they are applied.

Two things had to be decided before that could be built.

1. **Where do the alternative readings come from?** A panel that offers three
   engines for the same file is only useful if each one is justified by the
   audio. A list of buttons that ignores the material is decoration.
2. **What is a "source", anyway?** Today a source IS a string:
   `track.sampleId` points at an id, and what that id MEANS — its name, its
   length, its root, where it came from, whether the file is still there —
   lives outside the project. A patch that travels without the user's library
   arrives with dangling ids and no way to tell the producer WHICH sound is
   missing. The TSAR plan (R2) asks for a local source record with identity,
   name, technical metadata, root/loop information, origin and a missing state.

## Decision

### 1. Readings, not variants — and no seed

`src/tsar/forge-candidates.ts` is a SIBLING of `forge.ts`, not a rewrite of
it. `forgePlan` stays the single analysis implementation (one detector, one
set of numbers) and the candidate layer decides only **which engines the
evidence licenses**.

There is no seed and no `Math.random()`: the same PCM always produces the same
readings, in the same order, because a reading is a READING of the material,
not a draw from a distribution. The seeded mutation ladder belongs to wave 4
(`mutateTsarPatch`), where drawing random variants is the actual point.

`ForgePlan` is deliberately NOT reshaped. `src/ui/ChoralPanel.tsx` is a second
consumer of `forgePlan` (it reads `plan.rootMidi`); changing the plan's shape
would have broken it for no reason.

### 2. A reading the evidence does not support is NOT offered

| Reading                | Offered when                                                  | Why                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playable** (sampler) | always                                                        | A recording can always be played as it is.                                                                                                                 |
| **Tuned** (wavetable)  | `rootMidi !== null && rootConfidence >= 0.5`                  | A wavetable is a PERIODIC table. Without a readable pitch there is nothing to tune to, so offering it would be offering a claim the analysis did not make. |
| **Texture** (granular) | sustained, **or** `releaseSec >= 0.08 \|\| attackSec >= 0.08` | A 20 ms click has nothing to spread. Grains must fit inside the material.                                                                                  |

The order is fixed — playable first, because it always works.

### 3. A weak root is never dressed up as a precise one

`RELIABLE_ROOT_CLARITY = 0.5` gates two separate things: whether the tuned
reading WRITES `srcARoot`/`srcBRoot` at all, and how the evidence line reads.
A weak reading is shown as `root ~MIDI 36 (weak, 20 % sure)` and leaves the
producer's own root untouched. The Forge's existing KPI test already tolerates
±1 semitone on a pad that drifts by design; the candidate layer inherits that
tolerance rather than tightening it into a lie.

### 4. The audition uses the reading's OWN source

`PreviewDeck.previewTrackWithParams` gained a `sampleIdB` parameter and
`previewInstrumentWithSources` was added on top of it. Without this, a Source B
reading would have been auditioned against the track's OLD B source — the
producer would pick by ear for a patch that would not reproduce the choice.
The audition now carries the candidate's own source, and the project is not
touched: hearing is not applying.

### 5. Applying is a NEW sibling command

`applyForgeCandidateCommand` (`src/commands/tsar.ts`) sits NEXT TO
`forgeSampleCommand` rather than replacing it. It merges only the candidate's
overlay onto the track's params (the rest of the patch survives), writes
`sampleId` or `sampleIdB` according to the candidate's OWN slot, clears
`presetId` (a forged patch is no longer the preset it came from), and is ONE
`snapshot()` undo step.

### 6. The source record is a pure model beside the patch

`src/sample-library/source-record.ts` defines the record and the functions that
build one. It does not touch IndexedDB and it does not change the project
document — a source record lives beside the patch, in the user's library, and
the patch keeps only the id.

**Consequence: no schema migration and no `SCHEMA_VERSION` bump.** The
project document's shape does not change in wave 3. The roadmap's
"migration contract first" rule is satisfied vacuously, and this ADR is the
record of that decision rather than a missing step.

The record's identity is the **CONTENT**, not the import moment:
`sourceContentHash` is a fingerprint of the decoded samples, so the same file
imported twice is recognisable as one source. The existing `userSampleId` is
time-derived (`Date.now()`) and is NOT stable.

The record has a STATE, and `missing` is the important one: a patch can
reference a sample the library no longer holds, and that must be VISIBLE and
ACTIONABLE ("the audio is not in your library") rather than a silent hole.

## Consequences

- One import now produces several readings, each with a reason, an evidence
  line, and a warning where the material does not support the claim.
- The producer hears a reading before applying it, and the audition uses the
  sound the reading will actually be applied with.
- A source is described independently of any patch: its name, its measured
  root and confidence, its technical metadata, its content hash, its origin,
  and whether its bytes are still here.
- The panel grew a `tsar-source-line` per source. It is a line, not a panel:
  the panel is controls, not an essay.
- The command surface grew by one (`applyForgeCandidateCommand`).

## Evidence (measured, not asserted)

`tests/tsar/forge-candidates.test.ts` (17 specs) drives the candidate layer
with the six deterministic golden voices:

| Check                                                                  | Result                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| The playable reading is offered for any audible source                 | always                                                    |
| The tuned reading is offered only for a source with a readable root    | wavetable only when `rootConfidence >= 0.5`               |
| The texture reading is offered for sustained material                  | granular for sustained / spreadable sources               |
| The readings differ in the PARAMS they write, not only in their labels | 3 distinct overlays                                       |
| The tuned reading sets the root only when the reading is reliable      | a weak root is never written                              |
| Determinism                                                            | the same PCM gives the same candidates, in the same order |
| The candidates do not depend on the slot; the PARAMS do                | slot prefixes only                                        |
| Every candidate carries a reason (and a warning when it has no root)   | no silent candidate                                       |
| A one-shot gets `srcASus = 0`; a sustained source gets a hold          | envelope follows the measurement                          |
| The grain size fits inside the source it reads                         | `sourceSec / 2`, clamped [0.005, 0.3]                     |

`tests/tsar/forge-candidate-command.test.ts` (8 specs): applying is ONE undo
step; a Source B reading lands in B and leaves EVERY `srcA*` parameter
byte-identical; a Source A reading leaves every `srcB*` parameter alone; the
reading's overlay never carries a foreign slot's key; the granular reading
lands the grain cloud, not just the engine switch; a rootless reading leaves
the producer's own root (55) alone; the rest of the patch survives
(`srcAMorph`, `subLevel`, `lfoRate`); `presetId` clears; a non-TSAR track, a
missing track and a missing sample id are all refused.

`tests/sample-library/source-record.test.ts` (12 specs): the content hash is
stable for the same audio, tells different audio apart, and treats the sample
rate and the recording's length as part of the identity; an unanalysed source
invents no root; `markSourceMissing` keeps the identity and the metadata while
saying the bytes are gone; a weak pitch is described as weak and never as a
precise note.

`tests/ui/TsarForgeCandidates.test.tsx` (7 specs): one import offers several
readings and changes NOTHING yet (no command is executed); a reading can be
heard before it is applied and the audition does not touch the project; the
audition carries the reading's OWN source (a B reading is heard with the B
source); applying is ONE command that lands the source in the chosen slot; a
silent source is refused with an explanation and no list of readings; the
imported sound gets a source record with its measured root and content hash; a
patch source whose audio is gone is shown as MISSING, with an actionable
reason.

### Bundle cost (measured, isolated)

Both numbers come from the SAME tree built twice — the direct parent
`971750b0` and this wave's commit plus its final patch — in two isolated
worktrees, so a parallel session's concurrent commits cannot contaminate the
delta.

|                  | Before  | After   | Delta                       |
| ---------------- | ------- | ------- | --------------------------- |
| DAW JS sum       | 5666 KB | 5672 KB | **+6 KB** (ceiling 5630 KB) |
| Studio boot path | 2135 KB | 2135 KB | **+0 KB** (ceiling 2200 KB) |

The DAW-JS gate was **already red by 36 KB before this wave** (measured on the
direct parent), so this wave accounts for 6 of the 42 KB. The ceiling was not
raised: the trigger in `scripts/check-bundle-size.mjs` forbids a raise without
a diet, and wave 2's dead-weight audit (`scripts/audit-dead-weight.mjs`)
measured 204 of 204 chunks reachable and 0 modules shipped twice in the main
graph — the sum is shipped product. The decision belongs to the budget owner;
these numbers are the evidence.

## What this ADR does NOT change

The TSAR DSP is untouched. The engine routing rules, the three engines, the
parameters and the factory presets are unchanged — the candidate layer chooses
an engine and sets EXISTING parameters through the EXISTING command path. The
project document's shape does not change, so there is no schema migration. The
library's persistence does not change: the source record is derived, not
stored, in wave 3.
