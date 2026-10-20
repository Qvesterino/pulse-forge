# ADR 0056 — One bar length: the musical meter wins, the 4/4 arrangement grid is disclosed until it migrates

Date: 2026-10-20 · Status: Accepted (v1) · Scope: project model, Scheduler, arrangement grid, transfer import, meter surfaces

## Context

KYX has **two different definitions of "one bar"** in the same codebase, and
until now no document decided which of them is the truth.

- `BAR_TICKS` (`src/project-model/types.ts:4`) is `PPQ * 4` = 1920 ticks — always
  four quarter notes, whatever the document declares. It is the arrangement's
  bar unit: ruler drawing, clip placement, loop regions, markers, zoom, selection.
- `ticksPerBar(doc)` (`src/project-model/schema.ts`) is
  `PPQ * (4 / denominator) * numerator` — the *musical* bar length. It is what
  the metronome, the transport bar readout, the Inspector and the MIDI
  conditioning layer use.

Measured divergence (the reproduction lives in
`tests/audit17-bar-length-grids.test.ts`):

| meter  | `ticksPerBar(doc)` | `BAR_TICKS` | clip placed at bar 2 | musical downbeat of bar 3 | delta |
| ------ | ------------------ | ----------- | --------------------- | -------------------------- | ----- |
| 4/4    | 1920               | 1920        | 3840                  | 3840                       | 0     |
| 3/4    | 1440               | 1920        | 3840                  | 2880                       | 960   |
| 6/8    | 1440               | 1920        | 3840                  | 2880                       | 960   |

960 ticks is two beats. On a non-4/4 document, a clip placed at bar 2 starts
two beats after the bar-2 downbeat the metronome clicks.

The clearest single expression of the defect is in the scheduler itself. One
ternary, two lines apart (`src/scheduler/Scheduler.ts:798-800`):

```ts
const downbeat = inLeadIn
  ? Math.abs((((cursor - clickAnchor) % BAR_TICKS) + BAR_TICKS) % BAR_TICKS) < 1e-6  // 4/4
  : Math.abs(((cursor % barTicks) + barTicks) % barTicks) < 1e-6;                     // the document's meter
```

The lead-in downbeat and the playback downbeat are computed against different
bar lengths. Audio clips a few lines further down are scheduled with
`clip.startBar * BAR_TICKS`, so in a 6/8 project the audio enters two beats
after the click that is meant to mark the same bar.

The two units are not equally defensible, and the codebase is **half
migrated** rather than consistently wrong:

| Site                                                          | Unit            |
| ------------------------------------------------------------- | --------------- |
| `src/export/transfer-import.ts` (`secondsPerBar`)               | musical ✅      |
| `src/scheduler/Scheduler.ts:785-786` metronome click            | musical ✅      |
| `src/ui/playhead.ts:14` bar readout                             | musical ✅      |
| `src/ui/Inspector.tsx` bar/beat readout                         | musical ✅      |
| `src/ui/playhead.ts:79,109` arrangement playhead / current clip | 4/4 ❌          |
| the remaining ~370 bar↔tick conversions across 55 files        | 4/4 ❌          |

This is why the defect could not be patched site by site: the two conventions
disagree, and "fixing" an individual site before the unit is decided flips it
to whichever convention the fixer happened to assume. A concrete example —
`fittedLoopPlacement` (`src/commands/clipEditing.ts:141`) takes a
`beatsPerBar = 4` argument, and `src/ui/BrowserStrip.tsx:90`,
`src/ui/DropZone.tsx:148` and `src/ui/LivePadsPanel.tsx:118` pass
`doc.timeSignature.numerator` into it. For 6/8 that is 6, but a 6/8 bar spans
three quarter notes.

**The mismatch is user-reachable.** `src/ui/TransferImportDialog.tsx` lets the
user pick the meter, pre-fills it from the imported MIDI, and offers 3/4, 6/8,
4/2 and 32/4 alongside 4/4. Nothing told the user that the arrangement grid
stays 4/4 regardless.

MIDI note timing is *not* damaged by this: MIDI clips store `startTick`, so
notes keep their absolute musical positions. The damage is to everything
**bar-addressed** — ruler, clip placement, loop regions, markers, selection —
plus the audible disagreement between the click and the audio.

## Decision

1. **The musical bar length is the truth.** `ticksPerBarFor(sig)` in
   `src/project-model/schema.ts` is the single source for "how long is a bar",
   and `ticksPerBar(doc)` delegates to it. No other copy of the formula is
   allowed. `BAR_TICKS` is *not* a competing musical truth — it is the
   arrangement grid's unit, always four quarter notes, and that is now a
   documented property rather than an assumption.
2. **The arrangement grid stays 4/4 for now.** Making it follow the meter is
   an on-disk format change (the stored `startBar` / `lengthBars` would change
   meaning for every non-4/4 document) and therefore its own migration, not a
   patch. It is not attempted in this ADR.
3. **No surface may change the meter silently.** While the grid stays 4/4,
   every surface that can select a non-4/4 meter must disclose the mismatch
   before the user commits to it. The transfer import dialog now does:
   `arrangementGridWarning()` (`src/export/transfer-import.ts`) states that the
   arrangement grid is 4/4, that the metronome follows the chosen meter, that
   the two grids do not line up, and that imported audio lanes are measured in
   the chosen meter but placed on the 4/4 grid. The warning participates in
   the dialog's existing acknowledgement gate, so it cannot be scrolled past
   and imported without ticking the review box.
4. **The dialog now displays exactly what it asks the user to acknowledge.**
   The warning list renders the merged, de-duplicated warning set (inspection
   warnings + MIDI import warnings + the grid warning) instead of the
   inspection warnings alone. Previously the acknowledgement checkbox could
   be raised by a warning the user was never shown.
5. **4/4 is an invariant.** On a 4/4 document the two units are identical and
   must stay identical through every later stage. It is pinned as an
   invariant, not as an accident.
6. **The migration is staged, and each stage is independently mergeable:**
   - *Stage 1 (this ADR)* — disclose the mismatch. No model change, no
     on-disk change, no behavioural change to any 4/4 project.
   - *Stage 2* — one helper, `barTicks(doc)`, becomes the only way a bar
     index is converted to ticks. `BAR_TICKS` survives only as
     `DEFAULT_BAR_TICKS`, for 4/4 defaults and for the ruler's pixel width,
     which has no musical unit at all.
   - *Stage 3* — `SCHEMA_VERSION` bump plus a migration that re-expresses
     `startBar` / `lengthBars` for documents saved with a non-4/4 meter.
     Documents saved under 4/4 are numerically unchanged.
7. **A meter matches the 4/4 grid when one bar spans four quarter notes.**
   `arrangementGridMatchesMeter(sig)` encodes that musically, not numerically:
   4/4, 2/2 and 8/8 match; 3/4, 6/8, 4/2, 12/8 and 2/4 do not. A meter that
   matches produces no warning.

## Acceptance gates

- A 4/4 document is unchanged: `ticksPerBar(doc) === BAR_TICKS`, and the
  transfer dialog raises no grid warning.
- `arrangementGridMatchesMeter` is true exactly for 4/4, 2/2 and 8/8, and
  false for 3/4, 6/8, 4/2, 12/8 and 2/4.
- `ticksPerBar(doc)` and `ticksPerBarFor(doc.timeSignature)` return the same
  value — the formula has one implementation.
- Choosing a non-4/4 meter in the transfer dialog shows the grid warning,
  naming both the grid's tick length and the meter's, and the import button
  stays disabled until the review box is ticked.
  The warning is shown **as soon as the meter says so — before any file is
  chosen**. The meter control is live from the moment the dialog opens, so a
  disclosure that waits for the file inspection discloses the mismatch only
  after the user has already committed to the meter. The first cut of this ADR
  gated the warning on `inspection` for exactly that reason, and the gate
  wording above did not pin the timing, which is how the hole survived its own
  acceptance gate. Pinned by
  `tests/adr0056-grid-warning-disclosure.test.tsx`.
- The warnings the dialog asks the user to acknowledge are the warnings the
  dialog displays.
- The existing 4/4 transfer-import behaviour and its specs are unchanged.

## Consequences and scope limits

- A 6/8 or 3/4 import is now *labelled* as a 4/4-grid project instead of
  silently producing a project whose ruler and metronome disagree. It is not
  yet *fixed*; the grid itself still needs Stage 2 and Stage 3.
- The audio-lane consequence is stated in the warning but not repaired: an
  imported lane's length is computed in the chosen meter
  (`secondsPerBar`) and then placed on the 4/4 grid, so the lane's timeline
  length does not match its audio duration in a non-4/4 meter.
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

- `src/project-model/types.ts` — `BAR_TICKS`, `PPQ`
- `src/project-model/schema.ts` — `ticksPerBarFor`, `ticksPerBar`,
  `arrangementGridMatchesMeter`
- `src/scheduler/Scheduler.ts` — the click (musical) against the audio clip
  schedule (4/4)
- `src/export/transfer-import.ts` — `arrangementGridWarning`,
  `secondsPerBar`
- `src/ui/TransferImportDialog.tsx` — the meter choice and the warning gate
- `tests/audit17-bar-length-grids.test.ts` — the pinned 4/4 invariant and the
  measured non-4/4 divergence
- `tests/adr0056-arrangement-grid-warning.test.tsx` — the disclosure gate
- `docs/DAW-TRANSFER-EXPORT-GUIDE.md` — the transfer contract this dialog
  implements
