# ADR 0056 — One bar length: the musical meter wins (and the pattern grid moved on to ADR 0057)

Date: 2026-10-20 · Status: Accepted (v3 — Stage 2 shipped; the pattern grid handed to ADR 0057) · Scope: project model, Scheduler, arrangement grid, transfer import, meter surfaces

## Context

KYX had **two different definitions of "one bar"** in the same codebase, and
until now no document decided which of them was the truth.

- `BAR_TICKS` (`src/project-model/types.ts:4`) is `PPQ * 4` = 1920 ticks — always
  four quarter notes, whatever the document declares. It was the arrangement's
  bar unit: ruler drawing, clip placement, loop regions, markers, zoom, selection.
- `ticksPerBar(doc)` (`src/project-model/schema.ts`) is
  `PPQ * (4 / denominator) * numerator` — the _musical_ bar length. It is what
  the metronome, the transport bar readout, the Inspector and the MIDI
  conditioning layer use.

Measured divergence (the reproduction lives in
`tests/audit17-bar-length-grids.test.ts`):

| meter | `ticksPerBar(doc)` | `BAR_TICKS` | clip placed at bar 2 | musical downbeat of bar 3 | delta |
| ----- | ------------------ | ----------- | -------------------- | ------------------------- | ----- |
| 4/4   | 1920               | 1920        | 3840                 | 3840                      | 0     |
| 3/4   | 1440               | 1920        | 3840                 | 2880                      | 960   |
| 6/8   | 1440               | 1920        | 3840                 | 2880                      | 960   |

960 ticks is two beats. On a non-4/4 document, a clip placed at bar 2 started
two beats after the bar-2 downbeat the metronome clicks.

The clearest single expression of the defect is in the scheduler itself. One
ternary, two lines apart (`src/scheduler/Scheduler.ts:798-800`):

```ts
const downbeat = inLeadIn
  ? Math.abs((((cursor - clickAnchor) % BAR_TICKS) + BAR_TICKS) % BAR_TICKS) < 1e-6 // 4/4
  : Math.abs(((cursor % barTicks) + barTicks) % barTicks) < 1e-6; // the document's meter
```

The lead-in downbeat and the playback downbeat were computed against different
bar lengths. Audio clips a few lines further down were scheduled with
`clip.startBar * BAR_TICKS`, so in a 6/8 project the audio entered two beats
after the click that is meant to mark the same bar.

The two units were not equally defensible, and the codebase was **half
migrated** rather than consistently wrong:

| Site                                                            | Unit       |
| --------------------------------------------------------------- | ---------- |
| `src/export/transfer-import.ts` (`secondsPerBar`)               | musical ✅ |
| `src/scheduler/Scheduler.ts:785-786` metronome click            | musical ✅ |
| `src/ui/playhead.ts:14` bar readout                             | musical ✅ |
| `src/ui/Inspector.tsx` bar/beat readout                         | musical ✅ |
| `src/ui/playhead.ts:79,109` arrangement playhead / current clip | 4/4 ❌     |
| the remaining ~370 bar↔tick conversions across 55 files         | 4/4 ❌     |

This is why the defect could not be patched site by site: the two conventions
disagree, and "fixing" an individual site before the unit is decided flips it
to whichever convention the fixer happened to assume. A concrete example —
`fittedLoopPlacement` (`src/commands/clipEditing.ts:141`) took a
`beatsPerBar = 4` argument, and `src/ui/BrowserStrip.tsx:90`,
`src/ui/DropZone.tsx:148` and `src/ui/LivePadsPanel.tsx:118` passed
`doc.timeSignature.numerator` into it. For 6/8 that is 6, but a 6/8 bar spans
three quarter notes.

**The mismatch was user-reachable.** `src/ui/TransferImportDialog.tsx` lets the
user pick the meter, pre-fills it from the imported MIDI, and offers 3/4, 6/8,
4/2 and 32/4 alongside 4/4. Nothing told the user that the arrangement grid
stayed 4/4 regardless.

MIDI note timing was _not_ damaged by this: MIDI clips store `startTick`, so
notes keep their absolute musical positions. The damage was to everything
**bar-addressed** — ruler, clip placement, loop regions, markers, selection —
plus the audible disagreement between the click and the audio.

## Decision

1. **The musical bar length is the truth.** `ticksPerBarFor(sig)` in
   `src/project-model/schema.ts` is the single source for "how long is a bar",
   and `ticksPerBar(doc)` delegates to it. No other copy of the formula is
   allowed.
2. **The arrangement grid follows the document's meter.** A bar index is
   converted to ticks with `ticksPerBar(doc)` and nothing else: the ruler, the
   clip placement grid, the loop regions, the markers, the selection, the zoom,
   the metronome and the readouts all measure the same bar. A 4/4 document is
   unchanged, because there the two units were already identical.
3. **The PATTERN grid has its own ADR, and it has moved.** When this ADR was
   written, the pattern grid was the unit that did not follow the meter: a
   pattern was 16 sixteenth steps — `PATTERN_TICKS`, four quarter notes —
   whatever the document declared. **ADR 0057** has since moved the grid onto
   the meter: one bar is now `ticksPerBar(doc) / STEP_TICKS` steps, owned by
   `src/project-model/grid.ts`, and the ruler, the sequencer's beat count and
   the piano roll's bar lines are metrical in every meter. This ADR keeps the
   ARRANGEMENT's bar; ADR 0057 owns the grid's. What the transfer dialog
   discloses is therefore no longer "the grid ignores your metre" — it states
   what the chosen metre does to the import: the imported groove is padded UP
   to a whole number of the document's bars, so it lands on the downbeat.
4. **No surface may change the meter silently.** Every surface that can select
   a non-4/4 meter must disclose the consequence before the user commits to it.
5. **The dialog displays exactly what it asks the user to acknowledge.** The
   warning list renders the merged, de-duplicated warning set (inspection
   warnings + MIDI import warnings + the grid warning) instead of the
   inspection warnings alone. Previously the acknowledgement checkbox could be
   raised by a warning the user was never shown.
6. **4/4 is an invariant.** On a 4/4 document the two units are identical and
   must stay identical through every later stage. It is pinned as an
   invariant, not as an accident.
7. **The migration is staged, and each stage is independently mergeable:**
   - _Stage 1_ — disclose the mismatch. No model change, no on-disk change, no
     behavioural change to any 4/4 project. **Shipped** (`aa2e92c4`).
   - _Stage 2_ — `ticksPerBar(doc)` becomes the only way a bar index is
     converted to ticks. **Shipped** (`1215b0ac`, `aa638640`, `f92cd156`,
     `8bc00ea1`). `BAR_TICKS` survives only as the definition of the pattern
     grid's own length (`PATTERN_TICKS`), as the 4/4 default of the global tick
     cap and as a no-document fallback.
   - _Stage 3_ — see the measured finding below: **no schema migration is
     needed.** The stored values are bar indices, not ticks derived from bars,
     so what changes is their _interpretation_, which is the fix itself.
8. **A meter is one-pattern-per-bar exactly when one bar spans four quarter
   notes.** `patternGridIsOneBar(sig)` encoded that musically when this ADR was
   written — and it is **gone now**. ADR 0057 replaced the question it asked
   with a better one, and the grid's owner (`src/project-model/grid.ts`)
   answers it: `isWholeBarPatternFor(sig, steps)` asks whether a pattern of
   that length lands on the metrical bar line. The two questions differ, and
   the difference is not academic — in 2/4 the bar is eight steps, so a
   sixteen-step pattern is exactly TWO whole bars: it lands on the downbeat and
   needs no warning, even though its bar is not four quarter notes. The old
   predicate was production-dead the moment ADR 0057 landed, kept alive only by
   its own tests, which is how a guard ends up guarding nothing.

### Stage 2 — what was measured, and the ratchet

The bar unit is not a one-line change. Measured over `src/`: **470 occurrences
of the token `BAR_TICKS` across 58 files** before Stage 2 — a figure one
command reproduces:

```
git grep -o BAR_TICKS -- 'src/*.ts' 'src/*.tsx' | wc -l
```

(The ADR's first cut quoted "376 conversions"; that counted conversion
_expressions_, and one expression can carry two tokens. The token count is the
ratchet because it is the number a single command reports.)

**Batch 1 — the audible path** (shipped, `1215b0ac`): `commands/audioClips.ts`,
`commands/clipEditing.ts`, `scheduler/Scheduler.ts`, `rendering/renderer.ts`,
`audio-engine/liveEditSync.ts`, `audio-engine/triggerEngine.ts`, plus the five
`fittedLoopPlacement` call sites. **470 → 385 tokens in 53 files.**

Two findings that only the measurement could produce:

- **`fittedLoopPlacement` took a BEAT COUNT, and its callers passed the meter's
  numerator.** A 6/8 bar spans three quarter notes, not six, so a fitted loop
  in 6/8 came out one bar long instead of three — and on the old 4/4 grid
  that truncated the audio to a third of itself on every import. The parameter
  is now the bar length in ticks, which is the only unit that cannot be wrong.
- **The scheduler's lead-in downbeat and its playback downbeat measured
  different bars** (`Scheduler.ts`, two lines apart). In 6/8 the accent landed
  on the wrong beat. They now measure the same bar; only the anchor differs.

**Batch 2 — the rest** (shipped: `aa638640` for waves 1–2, and the follow-up
wave in `f92cd156` and `8bc00ea1`): the scene-time helpers, the command layer,
the rendering layer, the project model and the whole UI pixel wave. **385 → 9
tokens in 4 files.** Every one of the 9 is accounted for:

| token | file                          | why it stays                                                                                                                                       |
| ----- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | `src/project-model/types.ts`  | the definition (`PPQ * 4`) and the pattern-grid alias (`PATTERN_TICKS = BAR_TICKS`) — a different unit that happens to have the same length in 4/4 |
| 2     | `src/project-model/schema.ts` | `MAX_ARRANGEMENT_CLIP_TICKS` and its use — a loose global bound, not a grid (see the consequences)                                                 |
| 1     | `src/project-model/schema.ts` | the no-document fallback of `sanitizeAudioClips`, which has no meter to read                                                                       |
| 1     | `src/project-model/schema.ts` | the import of the constant                                                                                                                         |
| 3     | three files                   | comments that explain why the constant is not the grid                                                                                             |

The count is measured at HEAD, not asserted here: re-running the ratchet
command above reproduces 9.

Three structural decisions the batch forced:

- **Pure helpers take the bar length as a NUMBER, not a document.**
  `sceneBarsToSeconds`, `sceneSecondsToBars`, `tempoAtTick` and
  `arrangementSecondsBetweenTicks` take a required trailing `barUnitTicks`. A
  default would have kept every caller on 4/4 semantics while _looking_
  converted — the ratchet would have gone down and the defect would have
  stayed.
- **The ruler's PIXEL width is not a musical unit.** `barWidth` stays a pixel
  value; only the tick↔pixel conversion uses the metrical bar, so a clip lands
  on the drawn bar line instead of a quarter-bar off it.
- **One constant, one meaning.** `song.ts` computed the 16th-note step as
  `BAR_TICKS / 16`, which is exactly `STEP_TICKS`; `midiTime.ts`, the hum→melody
  fill and the piano roll's note-length menu used `BAR_TICKS` for the _pattern_
  grid, which is `PATTERN_TICKS`. The pattern grid got its own name, because
  it is a different unit that happens to have the same length in 4/4.

### The pattern grid — measured, not assumed

Stage 2 made the arrangement metrical. The pattern grid stayed 16 steps, and
the two do not agree outside 4/4-like meters. Measured, in a 6/8 document, the
pattern's phase at successive musical bar lines:

| bar                   | 1   | 2    | 3   | 4   | 5   | 6    | 7   | 8   |
| --------------------- | --- | ---- | --- | --- | --- | ---- | --- | --- |
| pattern phase (ticks) | 0   | 1440 | 960 | 480 | 0   | 1440 | 960 | 480 |

One pattern is 1920 ticks and a 6/8 bar is 1440, so the phrase is 1.33 bars
long: the pattern's downbeat reaches the bar line only every **fourth** bar and
is a quarter note late in between. In 4/4 the same measurement is 0 at every bar
line — the negative control. Pinned by
`tests/adr0056-pattern-grid.test.ts`.

This was the honest remainder of the migration, and it named the next step: "a
metrical step grid (12 steps in 6/8) is a separate change with its own ADR,
because it changes every pattern's length, every drum row, the sequencer UI and
every stored pattern."

**That ADR is ADR 0057, and it has shipped.** The grid is metrical now (one bar
is `ticksPerBar(doc) / STEP_TICKS` steps), and the measurement above survives as
its motivation rather than as the current state: a pattern of 16 steps in 6/8
still drifts, but the GRID no longer disagrees with the ruler — the pattern's
LENGTH does, and the import now pads to whole metrical bars so a fresh import
does not drift at all.

What this ADR therefore no longer says: that the pattern grid ignores the
meter. The truth is the grid follows it, and a pattern that was AUTHORED at
another length keeps its length until the user snaps it.

### Stage 3 — no schema migration is needed

Measured on the model: the values the project stores are **bar indices**
(`ArrangementClip.startBar`, the audio clip's `startBar` / `lengthBars`,
`ChordEvent.startBar`, `ArrangementTransition.lengthBars`, `Marker.bar`), while
the values that must NOT move are **absolute ticks** (`MidiClip.startTick` /
`lengthTicks`, `ArrangementAutomationClip.startTick` / `lengthTicks`). No
stored value is an absolute tick that was derived from a bar conversion, so
there is nothing to re-express: switching the unit changes the _meaning_ of the
stored number, and that is the fix.

Consequence, stated plainly: in an existing non-4/4 document, bar-addressed
content shifts by the meter ratio — that is the defect being corrected, and it
is what a DAW does when the meter changes. MIDI note timing does not move at
all, because MIDI clips store absolute ticks.

## Acceptance gates

- A 4/4 document is unchanged: `ticksPerBar(doc) === BAR_TICKS`, and the
  transfer dialog raises no grid warning.
- `isWholeBarPatternFor(sig, 16)` — the grid's own question ("does a 16-step
  pattern land on the metrical bar line") — is true exactly for 4/4, 2/2, 8/8
  and 2/4, and false for 3/4, 6/8, 4/2 and 12/8. The 2/4 case is the one that
  changed: the old predicate asked a different question and put 2/4 on the
  other side of the line.
- `ticksPerBar(doc)` and `ticksPerBarFor(doc.timeSignature)` return the same
  value — the formula has one implementation.
- Choosing a non-4/4 meter in the transfer dialog shows the grid warning,
  naming the metrical bar in ticks and in steps, and the import button stays
  disabled until the review box is ticked.
  The warning is shown **as soon as the meter says so — before any file is
  chosen**. The meter control is live from the moment the dialog opens, so a
  disclosure that waits for the file inspection discloses the mismatch only
  after the user has already committed to the meter. The first cut of this ADR
  gated the warning on `inspection` for exactly that reason, and the gate
  wording above did not pin the timing, which is how the hole survived its own
  acceptance gate. Pinned by
  `tests/adr0056-grid-warning-disclosure.test.tsx`.
- The warning says what is TRUE about the chosen metre: the arrangement and the
  step grid follow it, and the imported groove is padded to a whole number of
  the document's bars. The Stage 1 text ("the arrangement grid is 4/4") became
  false when Stage 2 landed and was replaced rather than left standing; the
  Stage 2 text ("the pattern grid is fixed at 16 steps") became false when
  ADR 0057 landed and was replaced the same way. A disclosure that states
  something untrue is worse than no disclosure.
- The warnings the dialog asks the user to acknowledge are the warnings the
  dialog displays.
- The existing 4/4 transfer-import behaviour and its specs are unchanged.

## Consequences and scope limits

- The arrangement, the metronome and the readouts now agree in every meter.
  A 6/8 or 3/4 import is a metrical project end to end: the ruler's bar, the
  clip placement, the loop region, the count-in accent, the render length and
  the bar's audible duration are all the metrical bar.
- **The pattern grid moved on to ADR 0057, and the import moved with it.** The
  grid is metrical now (one bar is `ticksPerBar(doc) / STEP_TICKS` steps), and
  the MIDI import pads the imported phrase UP to a whole number of the
  document's bars — so a fresh 6/8 import lands on the downbeat instead of
  1.33 bars into the bar. What is left is the pattern's own LENGTH: a groove
  authored at another length keeps it until the user snaps it to a whole bar,
  and the grid now SHOWS that ("1.33 bars") instead of hiding it.
- Before Stage 2 the pattern grid and the 4/4 arrangement grid agreed with each
  other and disagreed with the metronome. Stage 2 traded that: the click and
  the ruler agree, and for a while the pattern grid was the odd one out.
  ADR 0057 removed the odd one out. Both disagreements were 4/4-invisible, so
  no 4/4 project changed at any point.
- The audio-lane consequence is stated in the warning. `fittedLoopPlacement`
  measured the bar in beats and now measures it in ticks, so an imported lane
  is no longer truncated to a third of its length in 6/8. The remaining
  limitation is that a lane's length is still _rounded up_ to whole metrical
  bars, which leaves a tail of silence rather than a cut-off.
- `MAX_ARRANGEMENT_CLIP_TICKS` is still derived from `BAR_TICKS`, so in a
  non-4/4 document it is a loose bound: it allows up to 1.33× the intended
  maximum bar count in 6/8. It never rejects a clip that should be allowed.
  Recorded, not changed — the bar-count clamps use `MAX_ARRANGEMENT_CLIP_BARS`
  and are correct.
- Other meter-setting surfaces (the `kyx_music` MCP tool, the text-intent
  path, `setTimeSignature`) can still change a project's meter without
  disclosure. They are a follow-up; this ADR covers the transfer dialog
  because that is the surface that offers a non-4/4 meter as a first-class
  choice.
- `setTimeSignature` accepts denominator 2|4|8|16 while the transfer dialog
  also offers 1 and 32. That divergence is recorded, not changed here.
- `midiImportWarnings()` and the warning block inside `inspectTransferFiles()`
  compute overlapping MIDI warnings from two different conditions
  (`distinctTimelineEvents(...) > 1` versus `.length > 1`). The merged set is
  de-duplicated, so no warning is double-shown; the duplication is recorded
  as a cleanup, not fixed in this ADR.
- No existing project format changes. No 4/4 project changes behaviour.

## References

- `src/project-model/types.ts` — `BAR_TICKS`, `PATTERN_TICKS`, `PPQ`
- `src/project-model/schema.ts` — `ticksPerBarFor`, `ticksPerBar`,
  `patternGridIsOneBar`
- `src/project-model/scene-time.ts` — the bar-unit helpers
- `src/scheduler/Scheduler.ts` — the click (musical) against the audio clip
  schedule
- `src/export/transfer-import.ts` — `patternGridWarning`, `secondsPerBar`
- `src/ui/TransferImportDialog.tsx` — the meter choice and the warning gate
- `tests/audit17-bar-length-grids.test.ts` — the pinned 4/4 invariant and the
  measured non-4/4 divergence
- `tests/adr0056-pattern-grid.test.ts` — the measured pattern-grid drift and
  its 4/4 negative control
- `tests/adr0057-metrical-import-length.test.ts` — the import's metrical
  length: a whole number of the document's bars, the material unmoved, and the
  4/4 negative control
- `docs/adr/0057-metrical-step-grid.md` — the pattern grid's own ADR: the
  metrical step grid, the AI layer's metre, and the import's bar-length
- `tests/adr0056-pattern-grid-warning.test.tsx` — the warning's truth table
  (`patternGridIsOneBar`) and the 4/4 negative control
- `tests/adr0056-grid-warning-disclosure.test.tsx` — the disclosure arrives
  before the meter is committed
- `tests/adr0056-stage2-bar-formula-guard.test.ts` — the bar-length FORMULA
  exists in exactly one module (an AST guard, because a name sweep cannot see
  a formula written backwards)
- `tests/adr0056-stage2-bar-unit.test.ts` — the Stage 2 gate: a 6/8 clip lands
  on the musical bar, the render length follows the meter, the bar's audible
  duration follows the meter, and the count-in accent measures the document's
  bar — each with a 4/4 negative control
- `tests/fit-loop-placement.test.ts` — the loop-fit bar unit
- `docs/DAW-TRANSFER-EXPORT-GUIDE.md` — the transfer contract this dialog
  implements
