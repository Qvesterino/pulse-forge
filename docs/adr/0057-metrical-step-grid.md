# ADR 0057 — The step grid follows the meter: one bar is `ticksPerBar(doc) / STEP_TICKS` steps

Date: 2026-10-20 · Status: Accepted (v1 — Stage 1 shipped) · Scope: pattern grid, sequencer ruler, piano roll grid, pattern labels, transfer disclosure

## Context

ADR 0056 Stage 2 put the **arrangement** on the document's meter: the ruler, clip
placement, loop regions, the metronome and the bar readouts all measure the
metrical bar. It left the **pattern grid** where it was, and named the fix:

> "Fixing it means a metrical step grid and its own ADR."
> — `docs/adr/0056-arrangement-bar-length-and-time-signature.md`, *Consequences and scope limits*

The grid was not one bug but one assumption wearing six faces, and every face
said the same thing: **a bar is 16 sixteenth steps**.

| site | what it said | in 3/4 | in 6/8 |
| --- | --- | --- | --- |
| `src/ui/Sequencer.tsx` ruler | `i % 4 === 0 ? " beat-start"`, label `i / 4 + 1` | a "beat 4" that does not exist | the eighth-note pulse the click plays was never marked |
| `src/ui/Sequencer.tsx` cells | `stepIndex % 4 === 0` → the beat separator line | separators every 4 steps | separators every 4 steps |
| `src/ui/PianoRoll.tsx` | bar lines at `bar * 16`, beat lines every 4 steps | bar lines on the wrong steps | bar lines on the wrong steps |
| `src/ui/PianoRoll.tsx` note menu | `"1 BAR" = PATTERN_TICKS` (1920) | a note "1 bar" is 1⅓ bars | a note "1 bar" is 1⅓ bars |
| `src/ui/PatternBar.tsx` | `stepCount / 16` → "bars"; options 16/32/64/128 | "1 bar" for a 16-step pattern | "1 bar" for a 16-step pattern |
| `src/ui/SceneLauncher.tsx` | `Math.ceil(stepCount / 16)` → "N BARS" | "1 BAR" for a 16-step pattern | "1 BAR" for a 16-step pattern |

The ruler is the sharpest version: it counted **beats**, and a beat in KYX is
the denominator's unit — a quarter note in x/4, an eighth note in x/8. The
ruler counted four steps per beat, which is 4/4's beat and nothing else. In
6/8 the metronome clicks six times per bar (the eighth-note pulse) while the
ruler marked four ticks per bar and numbered a "beat 4" that does not exist.

## Decision

### 1. A pattern's length stays an ABSOLUTE count of sixteenth notes

`Pattern.stepCount` is a musical **duration**, and it stays one. It does NOT
become a metrical quantity, so:

- **no stored pattern is resized**, and no user content is silently dropped;
- **`SCHEMA_VERSION` does not move** (still 38) and no migration is added;
- the model layer's `normalizeStepCount` is untouched (it already tolerates any
  count 1..128 — the UI, the intent contracts and the MCP surface were the
  layers that forbade the rest).

The alternative was rejected on a measured ground: a stored pattern carries no
record of the meter it was authored in, so "re-expressing" it is not a
migration, it is a guess about what the user meant. A 16-step pattern in a 6/8
project resized to 12 steps would delete four steps of the user's groove.

**What the meter decides is what ONE BAR MEANS** — how many of those sixteenth
steps make a bar. That is a change of *unit*, not of *data*.

### 2. The grid's bar is the metrical bar, and one module owns it

`src/project-model/grid.ts` is the single owner:

| meter | bar (ticks) | steps/bar | steps/beat | beats/bar |
| ----- | ----------- | --------- | ---------- | --------- |
| 4/4   | 1920        | 16        | 4          | 4         |
| 2/2   | 1920        | 16        | 8          | 2         |
| 3/4   | 1440        | 12        | 4          | 3         |
| 6/8   | 1440        | 12        | 2          | 6         |
| 4/2   | 3840        | 32        | 8          | 4         |
| 5/4   | 2400        | 20        | 4          | 5         |
| 7/8   | 1680        | 14        | 2          | 7         |
| 12/8  | 2880        | 24        | 2          | 12        |

`stepsPerBarFor(sig) = ticksPerBarFor(sig) / STEP_TICKS` — the bar-length
formula is **not** re-implemented; it comes from `ticksPerBarFor` in
`schema.ts`, so the two units cannot drift apart again. The grid's BEAT is the
denominator's unit (`ticksPerBeatFor`), the same unit the metronome clicks, so
the ruler marks what the user hears.

### 3. The ruler counts the metrical beats, and the RESET is the bar line

The beat number resets at every metrical bar. That reset is how the bar line
shows itself: in 3/4 the ruler reads 1, 2, 3, **1**, 2, 3 — the second "1" IS
the bar line. No new chrome, no new CSS, and **4/4 is pixel-identical** to
before (16 steps, 4 per beat, beats 1–4).

### 4. The labels state the truth, including a fractional bar count

A pattern that is not a whole number of bars is SAID to be one: "16 steps =
1.33 bars", not "1 bar". The length control offers whole bars **in the
document's meter** (1/2/4/8 bars → 12/24/48/96 steps in 3/4), and a pattern
whose length is not a whole number of bars keeps its own entry in the control,
labelled honestly — the control must always show the pattern's real length.

### 5. The transfer disclosure now attributes the drift to the PATTERN's length

The dialog used to say "the 16-step pattern grid is fixed … whatever the
meter". That sentence became false the moment the grid moved, and a disclosure
that states something untrue is worse than no disclosure. It now says what is
actually true: the grid follows the meter, and the **imported pattern keeps
its own length** — 16 sixteenth notes is 1.33 bars of 6/8, so it drifts until
the user snaps it to a whole bar.

## Stage 1 — what shipped

- `src/project-model/grid.ts` — the truth (`stepsPerBar`, `stepsPerBeat`,
  `barsPerPattern`, `isWholeBarPattern`, `patternLengthOptions`,
  `beatNumberAtStep`).
- `src/project-model/schema.ts` — `ticksPerBeatFor(sig)`, so the beat formula
  is single-sourced like the bar formula.
- `src/ui/Sequencer.tsx` — the ruler and the step cells follow the meter.
- `src/ui/PianoRoll.tsx` — the bar lines, the beat lines, the note-length menu
  and the phrase label follow the meter.
- `src/ui/PatternBar.tsx`, `src/ui/SceneLauncher.tsx` — the labels and the
  length control follow the meter.
- `src/mcp/audio-preview.ts` — the one place that already computed the
  formula now imports it.
- `src/export/transfer-import.ts` — the disclosure, re-worded.
- **The producers that create a pattern with no content of its own** — a new
  pattern is one metrical bar, because it has no groove to preserve:
  `src/commands/patterns.ts` (the user's "new pattern"),
  `src/commands/padOps.ts` (a pad chop) and `src/intent/song.ts` (an empty
  section of N bars). In 4/4 these are 16 steps, exactly as before.
- **The exact-intent path** (`src/intent/exact.ts`, `src/commands/intentRouting.ts`)
  — the engine speaks the document's BARS: "4 bars longer" adds four metrical
  bars (48 steps in 3/4, not 64), "make the loop 4 bars" is an absolute length
  in bars, and the read-back states both units ("48 steps (4 bars)"). This is
  the path the MCP surface calls, so the agent-facing surface inherits it.

  The producers whose output has CONTENT are deliberately not in this stage:
  the templates (their grooves are 4/4 by composition), the MIDI import
  (`src/midi/midiProject.ts` rounds an imported phrase up to a 16-multiple) and
  live capture (`src/arrangement/capture.ts` wraps a take into a 16-slot
  grid). Resizing those would delete or stretch a user's material.

## Stage 2 — what is still open (and where)

The grid now tells the truth, and a NEW pattern is right. What still drifts is
a pattern that was authored in another meter — a 16-step pattern in a 6/8
project is 1.33 bars, and the grid now SHOWS that instead of hiding it. The
remaining work is to make every producer and every contract speak the
document's meter. The highest-risk sites, mapped (read-only sweep,
2026-10-20):

1. **The AI layer.** `src/ai/phrase.ts` cuts the phrase on 16-step boundaries
   and anchors the kick/snare with `step % 4` / `step % 8 === 4`; `src/ai/markov.ts`
   wraps its state machine `mod 16`; `src/ai/quality.ts` and
   `src/ai/features/pattern-features.ts` detect downbeats with `step % 16`.
   Changing these changes generated output at a fixed seed — a determinism
   invariant, so it needs its own measured baseline.
2. **The intent / brief contracts.** Five independent gates demand a length
   that is a multiple of 16 (`src/intent/schema.ts`, `project-brief.ts`,
   `creative-task-contract.ts`, `src/project-model/producer-brief.ts`,
   `src/intent/normalize.ts`). They would reject a metrical 12/20/24.
   **The exact-intent path is done** (Stage 1b): the applier and the parser
   speak the document's bars — "4 bars longer" adds four METRICAL bars, and
   "make the loop 4 bars" is an absolute length in bars. The BRIEF contracts
   are still open: they validate a request with no document in hand.
3. **The MCP surface.** `src/mcp/tools.ts` rejects any `setPatternLength`
   outside 16..128, and maps `bars → length: bars * 16`. For a platform that
   AI agents drive, this is the surface that must speak bars.
4. **Content-shaped producers.** The MIDI import's 16-rounding
   (`src/midi/midiProject.ts`), live capture's 16-slot grid
   (`src/arrangement/capture.ts`) and the 4/4 templates
   (`src/project-model/templates.ts`, `template-pack2.ts`).
5. **The ONNX feature vectors.** `src/ai/symbolic/*` encodes a fixed 16-step
   bar into a fixed-width feature row; moving the grid means re-validating the
   pinned model manifests under `public/models/`.

The visible surface's remaining 4/4 sites are declared in the guard's ledger
(`tests/adr0057-metrical-step-grid.test.ts`): the assist / generate / dice
preview grids (16 cells, because the generator's output shape is 16), the
automation lane's beat grid, the brief's length readout, and the hum-to-melody
contour's bar lines. **The ledger may only shrink.**

## Acceptance gates

- The truth table above holds, and the grid's bar is the metrical bar by
  construction (`stepsPerBarFor(sig) * STEP_TICKS === ticksPerBarFor(sig)`).
- **4/4 is unchanged**: 16 steps, 4 per beat, a 1920-tick bar, ruler beats
  1–4 per bar, length options 16/32/64/128. A guard that fired in 4/4 would
  be wrong.
- The ruler's beat count resets at every metrical bar, and the count equals the
  number of beats the metronome clicks in that meter.
- A WHOLE-BAR pattern never drifts: its phase is 0 at every bar line, in 3/4,
  6/8, 4/2 and 7/8.
- A pattern that is not a whole number of bars is reported as a fractional bar
  count, never rounded to "1 bar".
- The steps-per-bar formula exists in exactly one module, and no UI file
  converts a step count to a bar count by hand. The guard proves it can fail.
- The transfer disclosure says what is true: the grid follows the meter, and
  the imported pattern keeps its own length.

## Consequences and scope limits

- **4/4 projects cannot tell the difference.** 16 steps, 4 per beat, a
  1920-tick bar, the same ruler, the same labels, the same menu. This is the
  point of deciding the unit rather than the data.
- **A 16-step pattern in 6/8 still drifts.** What changed is that the grid now
  shows the bar line at step 12 and the label says "1.33 bars". The defect
  moved from *invisible* to *visible*; Stage 2 removes it for new patterns.
- **The stored model did not move.** No schema version, no migration, no
  resized pattern, no lost content.
- `patternGridIsOneBar(sig)` (ADR 0056) still answers "is the metrical bar the
  16-step grid bar" — a true statement, but no longer the defect's name. The
  defect's name is now the pattern's LENGTH.
- The scene-launcher label reads the document through a plain
  `services.store.getDoc()` getter rather than a subscription: the strip must
  not re-render on every unrelated store mutation. A meter change arrives with
  a project change that re-renders the shell.
- The metronome's beat is the denominator's unit, and so is the grid's. A 6/8
  project therefore ticks six times per bar and numbers six beats per bar. The
  dotted-quarter reading (two pulses per 6/8 bar) is a DIFFERENT convention and
  is not adopted here — the click and the grid agree, which is what the user
  perceives.

## References

- `src/project-model/grid.ts` — the grid truth (one owner)
- `src/project-model/schema.ts` — `ticksPerBarFor`, `ticksPerBeatFor`
- `src/ui/Sequencer.tsx` — the ruler and the step cells
- `src/ui/PianoRoll.tsx` — the bar lines, the note-length menu
- `src/export/transfer-import.ts` — `patternGridWarning`
- `tests/adr0057-metrical-step-grid.test.ts` — the truth table and the guard
- `tests/adr0056-pattern-grid.test.ts` — the drift, and the whole-bar control
- `docs/adr/0056-arrangement-bar-length-and-time-signature.md` — the arrangement's move onto the meter
