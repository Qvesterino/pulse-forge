# ADR 0057 — The step grid follows the meter: one bar is `ticksPerBar(doc) / STEP_TICKS` steps

Date: 2026-10-20 · Status: Accepted (v3 — Stage 1, 1b, 2a and 2b shipped) · Scope: pattern grid, sequencer ruler, piano roll grid, pattern labels, transfer disclosure, intent engine, MCP surface, AI layer

## Context

ADR 0056 Stage 2 put the **arrangement** on the document's meter: the ruler, clip
placement, loop regions, the metronome and the bar readouts all measure the
metrical bar. It left the **pattern grid** where it was, and named the fix:

> "Fixing it means a metrical step grid and its own ADR."
> — `docs/adr/0056-arrangement-bar-length-and-time-signature.md`, _Consequences and scope limits_

The grid was not one bug but one assumption wearing six faces, and every face
said the same thing: **a bar is 16 sixteenth steps**.

| site                             | what it said                                      | in 3/4                         | in 6/8                                                 |
| -------------------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `src/ui/Sequencer.tsx` ruler     | `i % 4 === 0 ? " beat-start"`, label `i / 4 + 1`  | a "beat 4" that does not exist | the eighth-note pulse the click plays was never marked |
| `src/ui/Sequencer.tsx` cells     | `stepIndex % 4 === 0` → the beat separator line   | separators every 4 steps       | separators every 4 steps                               |
| `src/ui/PianoRoll.tsx`           | bar lines at `bar * 16`, beat lines every 4 steps | bar lines on the wrong steps   | bar lines on the wrong steps                           |
| `src/ui/PianoRoll.tsx` note menu | `"1 BAR" = PATTERN_TICKS` (1920)                  | a note "1 bar" is 1⅓ bars      | a note "1 bar" is 1⅓ bars                              |
| `src/ui/PatternBar.tsx`          | `stepCount / 16` → "bars"; options 16/32/64/128   | "1 bar" for a 16-step pattern  | "1 bar" for a 16-step pattern                          |
| `src/ui/SceneLauncher.tsx`       | `Math.ceil(stepCount / 16)` → "N BARS"            | "1 BAR" for a 16-step pattern  | "1 BAR" for a 16-step pattern                          |

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
steps make a bar. That is a change of _unit_, not of _data_.

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

## Stage 2a — the intent engine and the MCP surface speak the document's bars

The grid was truthful while the ENGINE still asked in 4/4 steps. Five independent
gates demanded "a multiple of 16", the default intent length WAS sixteen steps,
and the text parser turned "8 bars" into 128 steps before anyone knew what meter
the project was in. So in a 3/4 project the engine answered a request for one
bar with a sixteen-step pattern — 1.33 bars, drifting against the very ruler
drawn above it — and the MCP surface rejected **every** bar count that was not a
multiple of four bars.

### The request is asked in BARS; the document's meter answers in steps

- `IntentSpec` carries `bars` — a **meter-independent** request ("8 bars"). The
  document's meter turns it into steps at the one place the document is known:
  `planGeneration(input, doc)`.
- `normalizeIntent(input, doc?)` takes the document as an OPTIONAL second
  argument. With it, the default length is **one bar of that meter** (12 steps in
  3/4, not 16) and a step-framed request is rounded to a whole number of that
  meter's bars. Without it, the meter is unknown and 4/4 is assumed.
- The text parser stops converting: "8 bars" stays `bars: 8` and the meter
  decides the steps. "32 steps" stays a step count.
- The brief contracts keep BOTH facts: a `length` fact (steps) for a
  step-framed request and a new `bars` fact for a bar-framed one. Bars survive
  a change of meter; a step count is the truth of a step count.
- The producers that counted bars by hand (`song.ts`, `song-section-intent.ts`,
  `multi-voice.ts`, `voice-idea.ts`, `candidate-search.ts`) now use the grid's
  `stepsForBars` / `stepsPerBar`.

### 4/4 is byte-identical — including the intent HASH

The `bars` field is carried on the spec **only where the step count cannot say
it** (i.e. where a bar is not sixteen steps). In 4/4 the spec is the same
object it always was: same length, same keys, same `intentHash` — so the same
prompt still produces the same beat, and the learned preferences keyed by the
content hash still point at the same content. A bar-framed request in 4/4
hashes exactly like the legacy step-framed one.

### The MCP surface speaks bars, and reads back both units

- `kyx_generate` accepts **any whole number of the document's bars** and names
  the meter's real limit ("1 to 10 (one bar is 12 steps)") instead of an empty
  list of "supported whole-bar lengths".
- `kyx_music.setPatternLength` takes `bars` **or** `steps` (not both). Bars are
  the document's; the read-back states both units — "24 steps (2 bars)" — and
  the returned data carries `steps` and `bars`.
- The creative-task contract (the agent-facing request) resolves the length
  against the project's meter and no longer demands a multiple of sixteen.

### What still drifts, and why it is not here

The AI layer's own 16-step shapes (`src/ai/phrase.ts`, `markov.ts`, `quality.ts`,
`pattern-features.ts`) change the GENERATED CONTENT at a fixed seed — a
determinism invariant that needs its own measured baseline. The content-shaped
producers (MIDI import, live capture, the 4/4 templates) resize user material.
The ONNX feature vectors encode a fixed 16-step bar. Those are Stage 2b.

## Stage 2b — the AI layer speaks the document's metre

The grid was truthful and the intent engine asked in bars, but the GENERATOR was
still the last layer that believed a bar is sixteen sixteenth steps. Every
generation decision it made — where the bars are, where the phrase cuts, where
the fill lands, where the kick and the snare sit, how long the melody's bar is,
how the groove material is folded — was 4/4 arithmetic wearing the clothes of a
default.

### What was measured, before anything changed

Generation in a 3/4 document did not fail. It produced a pattern and ACCEPTED it.
The defect was not a rejection, it was a **truncated 4/4 groove**:

| metre | generated kick | generated snare | what it was                                                  |
| ----- | -------------- | --------------- | ------------------------------------------------------------ |
| 4/4   | 0, 4, 8, 12    | 4, 12           | the house groove, correct                                    |
| 3/4   | 0, 4, 8        | 4               | the 4/4 bar cut at step 12 — the beat-4 backbeat simply gone |
| 6/8   | 0, 4, 8        | 4               | the same truncation, called a shuffle                        |

Three separate defects shared one cause: the bar is 16 steps.

### One owner: `src/ai/meter.ts`

The AI layer's metrical facts live in ONE module, `src/ai/meter.ts`. It does not
re-implement the bar formula — `stepsPerBarFor` / `stepsPerBeatFor` come from
`src/project-model/grid.ts`, so the pattern grid and the generator cannot drift
apart. It owns the **pulse rule**:

| metre | pulse             | kick            | backbeat                    |
| ----- | ----------------- | --------------- | --------------------------- |
| 4/4   | quarter (4)       | 0, 4, 8, 12     | 4, 12                       |
| 3/4   | quarter (4)       | 0, 4, 8         | 4                           |
| 2/4   | quarter (4)       | 0, 4            | 4                           |
| 5/4   | quarter (4)       | 0, 4, 8, 12, 16 | 4, 12                       |
| 2/2   | half (8)          | 0, 8            | 8                           |
| 6/8   | dotted quarter(6) | 0, 6            | 2, 8 (the "2 & 5")          |
| 12/8  | dotted quarter(6) | 0, 6, 12, 18    | 2, 8, 14, 20                |
| 7/8   | the whole bar     | 0               | — (the grouping is content) |

Three regimes:

1. **SIMPLE** — the denominator's unit is at least a quarter note (x/1, x/2,
   x/4): the pulse IS that unit, the kick rides every pulse and the backbeat
   every SECOND pulse (beats 2 and 4). In 4/4 this is exactly the legacy rule.
2. **COMPOUND** — x/8 (or finer) with a numerator that is a multiple of three:
   the units group in threes (the dotted quarter). The kick rides the GROUP;
   the backbeat is the SECOND unit inside each group — the shuffle's "2 & 5". A
   compound meter deliberately does NOT get "every second pulse": that would put
   the snare on the second dotted quarter and turn a shuffle into a tresillo.
3. **IRREGULAR** — a bar that does not divide into equal pulses of at least a
   quarter note (7/8, 5/8, 3/16): the whole bar is one pulse, only the downbeat
   is anchored, and the grouping (2+2+3) is GROOVE CONTENT, not arithmetic.
   Declared, not guessed.

### The seam: the metre travels in the options, and only when it is not 4/4

`GenerateOptions.timeSignature` is the carrier, and it obeys the same rule as
Stage 2a's `bars`: it is **present only when the metre is not 4/4**. In 4/4 the
options object, the generation recipe and the recipe's hash are the objects they
have always been. In any other metre the metre is part of the generation
IDENTITY — the same seed in 3/4 and in 4/4 are different beats — so the recipe
records it (`PatternGeneration.timeSignature`).

The document's metre reaches the layer at `planGeneration(input, doc)`, and
`generatePattern(doc, options)` falls back to the document's metre when the
options do not carry one (the dice tray, AI Flip and the direct command paths
all land there).

### What changed, layer by layer

- `src/ai/drums.ts` — the bar count, the base sequence's length, the fill's
  placement, the phrase contour's length, the metric accents' hierarchy and the
  density pruning's anchor protection follow the metre.
- `src/ai/phrase.ts` — the phrase plan cuts at the metrical bar line, and the
  fill zone is the bar's last PULSE (a quarter note in 4/4, a dotted quarter in
  6/8).
- `src/ai/quality.ts` — the anchor rule, the syncopation metric, the reference
  phase and the bar-repetition slices are the metrical ones.
- `src/ai/style-quality.ts` — the syncopation weight, the anchor test and the
  downbeat ratio are measured against the metrical pulse.
- `src/ai/melodic.ts`, `src/ai/melodicDice.ts` — the melodic density is per
  metrical bar; the dice phrase's downbeat bonus and its bar-end breath sit on
  the metrical bar's first and last step.
- `src/ai/evaluation.ts`, `src/ai/features/pattern-features.ts` — the downbeat
  count, the pattern's length in bars and the phrase length are metrical.
- `src/ai/flip.ts` — the flipped pattern is a whole number of the DOCUMENT's
  bars (the LOOP's own grid stays sixteen steps: the loop's metre is not known).
- `src/intent/pattern-verbs.ts` — "thin the drums" keeps the DOCUMENT's
  downbeat (the beat 1 of every 3/4 bar), not every sixteenth step; the ghost
  verb adds hits off the metrical pulse. This is the intent layer's last
  hand-counted bar, and it was the same defect in a different room.

### The groove reference folds at the metrical bar

The reference groove is 4/4 material. Reading it at `step % 16` meant the second
bar of a 3/4 pattern reached past the groove's material. It now folds at the
**metrical** bar, so the second bar draws the groove's FIRST bar again.

### Two anchor paths — repair, and write

- **REPAIR** (every metre): the reference has a hit at the anchor and the
  sampler dropped it → the reference's own hit goes back. This is the legacy
  rule, unchanged.
- **WRITE** (any metre but 4/4): the reference has NOTHING at the anchor. The
  groove library is 4/4 material, so it carries no skeleton for a 3/4 or a 6/8
  bar — without this path the generator would write a truncated 4/4 bar and
  call it 6/8. The metre writes the anchor, and the groove still writes its
  loudness (the nearest reference hit of that role).

4/4 is deliberately excluded from the WRITE path: that metre's behaviour is the
promise the overwhelming majority of the product depends on, and its material
already carries the metrical skeleton. **Stage 2c (metrical groove content)
will retire the WRITE path everywhere**, because the reference will then hold
the anchors itself.

### 4/4 is byte-identical — measured, not assumed

The baseline was captured against HEAD with the CANONICAL content hash (rows,
notes, step meta — project UUIDs excluded, so the number is reproducible; an
object hash would change on every run because the pattern's own id is a random
UUID):

| case               | content hash |
| ------------------ | ------------ |
| 4/4 house (seed 1) | `17e1439d`   |
| 4/4 trap           | `688279c1`   |
| 4/4 dnb            | `47f20c59`   |
| 4/4 house (seed 2) | `b4f0ae78`   |

Identical hash, identical hit positions, identical note starts, identical recipe
and identical phrase plan. `tests/adr0057-ai-meter.test.ts` pins them.

The non-4/4 rows changed, and they changed towards the metre: 3/4 house now
generates kick 0, 4, 8 and snare 4; 6/8 house generates kick 0, 6 and snare
2, 8 — a shuffle that is actually a shuffle.

### A guard, because a ledger is not a promise

`src/ai/meter.ts` is the only module allowed to know how long a bar is. The
guard walks `src/ai/` and fails on a numeric SIXTEEN in a multiplicative
expression (`x * 16`, `x / 16`, `x % 16`) — the shape of the old assumption. The
declared exceptions (the Markov model's 4/4 state space, the corpus ingest's
training frame, the pinned ONNX feature frames, the v2 feature contract's
chord-duration fraction) are listed with their reasons, and **the ledger may
only shrink**. The guard proves it can fail on a synthetic violation.

### What is still open (and where)

- **Stage 2c — metrical groove content.** The groove library is 4/4 material:
  the Markov model's state space is sixteen positions, the ONNX priors encode a
  sixteen-step bar, and the corpus was ingested on that frame. Those are pinned
  model contracts; changing them is a versioned step (a `features.v3` contract
  with an explicitly metrical frame, and re-validating the pinned manifests).
- **Content-shaped producers** — the MIDI import's 16-rounding, live capture's
  16-slot grid, the 4/4 templates — still resize or wrap user material. They
  are producers of content, not readers of the metre.
- **The assist layer** (`src/assist/patternOps.ts`) still counts bars by hand,
  because an assist operation works on a pattern and has no document.

## Stage 2 — what is still open (and where)

The grid now tells the truth, a NEW pattern is right, the intent engine asks in
the document's bars and the MCP surface answers in them. What still drifts is
a pattern that was AUTHORED in another meter — a 16-step pattern in a 6/8
project is 1.33 bars, and the grid now SHOWS that instead of hiding it. The
remaining work is to make every producer and every contract speak the
document's meter. The highest-risk sites, mapped (read-only sweep,
2026-10-20):

1. **The AI layer.** **DONE in Stage 2b** — `src/ai/meter.ts` owns the metrical
   facts; the phrase, the anchors, the fills, the melodic density and the
   quality metrics follow the document's metre, and 4/4 is byte-identical
   (measured against a captured baseline). The groove CONTENT is still 4/4 —
   that is Stage 2c.
2. **The intent / brief contracts.** **DONE in Stage 2a** — the five gates
   (`src/intent/schema.ts`, `project-brief.ts`, `creative-task-contract.ts`,
   `src/project-model/producer-brief.ts`, `src/intent/normalize.ts`) no longer
   demand a multiple of sixteen, and the brief carries bars beside steps.
3. **The MCP surface.** **DONE in Stage 2a** — `kyx_generate` takes the
   document's bars, `setPatternLength` takes bars or steps and reads back
   both, and the creative-task request resolves the length against the meter.
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
- **The intent engine asks in the document's bars**: the default length is one
  bar of that meter, a bar-framed request is resolved by that meter, and a
  step-framed request is a step count.
- **4/4 keeps the same intent hash** — a bar-framed request in 4/4 produces the
  same spec, and therefore the same beat, as the legacy step-framed one.
- **The MCP surface accepts every whole number of the document's bars** and
  reads the length back in both units.
- **The AI layer speaks the document's metre**: the bar count, the phrase cut,
  the fill, the kick and the snare sit where that metre puts them, and the
  groove reference folds at the metrical bar.
- **A compound metre gets a shuffle, not a tresillo**: in 6/8 the backbeat is
  the second unit inside each group of three.
- **4/4 keeps the same generated beat** — the same canonical content hash, the
  same anchors, the same recipe, and no metre in the recipe at all.
- **No AI module measures a bar as sixteen steps** — the guard proves it can
  fail, and the 4/4 ledger may only shrink.

## Consequences and scope limits

- **4/4 projects cannot tell the difference.** 16 steps, 4 per beat, a
  1920-tick bar, the same ruler, the same labels, the same menu. This is the
  point of deciding the unit rather than the data.
- **A 16-step pattern in 6/8 still drifts.** What changed is that the grid now
  shows the bar line at step 12 and the label says "1.33 bars". The defect
  moved from _invisible_ to _visible_; Stage 2 removes it for new patterns.
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
- `src/ai/meter.ts` — the AI layer's metrical truth (one owner)
- `src/ui/Sequencer.tsx` — the ruler and the step cells
- `src/ui/PianoRoll.tsx` — the bar lines, the note-length menu
- `src/export/transfer-import.ts` — `patternGridWarning`
- `tests/adr0057-metrical-step-grid.test.ts` — the truth table and the guard
- `tests/adr0057-metrical-intent-length.test.ts` — the intent engine's bars, the MCP surface's bars, and the second guard
- `tests/adr0057-ai-meter.test.ts` — the AI layer's metre, the 4/4 baseline, and the third guard
- `tests/adr0056-pattern-grid.test.ts` — the drift, and the whole-bar control
- `docs/adr/0056-arrangement-bar-length-and-time-signature.md` — the arrangement's move onto the meter
