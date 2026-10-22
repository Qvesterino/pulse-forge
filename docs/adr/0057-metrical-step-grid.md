# ADR 0057 — The step grid follows the meter: one bar is `ticksPerBar(doc) / STEP_TICKS` steps

Date: 2026-10-20 · Status: Accepted (v8 — Stage 1, 1b, 2a, 2b, 2c, 2d, 2e, 2f, 2g, 2h and 2i shipped) · Scope: pattern grid, sequencer ruler, piano roll grid, pattern labels, transfer disclosure, intent engine, MCP surface, AI layer, AI groove material, MIDI import, pinned model feature contracts, assist layer, metre disclosure, irregular metres

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
already carries the metrical skeleton. **Stage 2c narrowed the WRITE path to
the irregular bars**, where the metrical view deliberately imposes no skeleton
and the metre is still the last word on the downbeat — everywhere else the
reference holds the anchors itself and REPAIR covers them.

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

## Stage 2c — the groove MATERIAL speaks the document's metre

Stage 2b made the AI layer speak the document's metre: the bar count, the
phrase cut, the fill, the kick, the snare. But the CONTENT it drew from was
still a 4/4 groove read at the metrical bar — so the metre was a frame around
4/4 material, not a language the material spoke.

### What was measured, before anything changed

The groove library is 4/4 material: 258 grooves, every row sixteen sixteenth
steps, written for a bar that has four beats. Read at a twelve-step metrical
bar, half of that material falls OUTSIDE the bar:

- a UKG clap on the "and" of 3 and the "and" of 4 (steps 12 and 14) is past a
  6/8 bar's end;
- a rock backbeat on the "ands" of 1 and 3 lands on the wrong units;
- a trap kick on the "and" of 4 is simply not there.

Measured on the commit BEFORE this stage — the same script, the same seeds, in
a worktree at that commit, against the same worktree plus this stage's patch:
the anchor roles' hits that sat OFF the metre's skeleton (12 seeds × 3 genres,
kick + snare + clap):

| metre | before           | after                                                |
| ----- | ---------------- | ---------------------------------------------------- |
| 4/4   | 39.1 % (97/248)  | **39.1 % (97/248)** — the same 248 hits, the same 97 |
| 3/4   | 28.0 % (74/264)  | **5.9 % (12/202)**                                   |
| 6/8   | 3.0 % (6/198)    | **2.0 % (4/196)**                                    |
| 5/4   | 25.9 % (109/421) | **6.0 % (20/332)**                                   |
| 7/8   | 51.0 % (51/100)  | 56.6 % (47/83) — see the irregular limit below       |

4/4 is the control: the genres' syncopation is CONTENT, not contamination, and
the 4/4 byte-identity holds cell for cell (the four canonical hashes below).

7/8 is the declared limit, not a silent one: an irregular bar has ONE pulse,
so the grouping is CONTENT, and the library has no irregular grooves. Most of
the anchor hits are therefore off the skeleton in both measurements — 7/8 has
no skeleton for the snare at all. The projection refuses to invent a 7/8
grouping, and the bar keeps the library's 4/4 shape.

### One owner: `src/ai/groove-view.ts` — the metrical VIEW, not a second library

The library stays 4/4 and stays the source of truth. The metrical view is a
DERIVED PROJECTION of it, and it answers one question: "what does this groove
say in THIS metre?".

1. **The base** — the source row folded into the target bar. A longer source is
   truncated (the bar is cut, never stretched); a shorter target tiles the
   source (the material repeats rather than running out).
2. **The skeleton** — the roles the metre re-voices: the kick on the pulse, the
   snare and the clap on the backbeat. Every other role keeps the folded
   positions, so the groove's own swing survives the fold.
3. **The material** — the role's hits, collected from the WHOLE source row, in
   order. The whole row matters: a 4/4 groove's beat-4 backbeat lives past a
   3/4 bar's end, and it is exactly the material a shorter metre needs.
4. **Re-voice** — the base's hits give way to the metre's skeleton. The
   collected hits are re-emitted on the anchor positions in order; a metre with
   more anchors than the groove has hits repeats them (a shuffle wants a
   backbeat on both its "2" and its "5"), and a metre with fewer keeps the
   first ones (a 3/4 bar has no beat 4).

What the projection refuses to do:

- a bar with ONE pulse (7/8, 5/8) has no skeleton to impose — the grouping is
  content;
- a role with no anchor in this metre (the snare in 7/8) keeps its material;
- a role with no material at all (a groove with no clap) is not invented.

The projection is LEVEL-AGNOSTIC: the same function maps the groove library's
velocities and the Markov model's quantized levels, so the reference and the
generated content can never disagree about where the metre puts a hit.

### The model keeps its frame; the VIEW maps it

The Markov model still generates the SOURCE bar — its own sixteen-position
frame, the frame the library is trained on. The view maps that bar into the
document's metre. Re-framing the model is a retrain with new manifests: the
pinned frames are a MODEL CONTRACT (no manifest records the frame length, so
changing it would break every model silently), and that is a separate stage.

### The reference speaks the metre too — and the WRITE path is NARROWED

Stage 2b had TWO anchor paths, because the library is 4/4 material: REPAIR
(the reference has a hit at the anchor → put it back) and WRITE (the reference
has nothing at the anchor → the metre writes it, wearing the groove's nearest
loudness).

The reference the generator reads is now the METRICAL VIEW, and in every metre
with more than one pulse that view carries the anchors itself — so REPAIR
covers them and WRITE does not fire there. What is left is the case the
projection deliberately refuses to touch: an irregular metre, where the metre
still insists on the downbeat. That is a real state, not a theory — 115 of the
library's 802 kick rows have no hit at step 0 (`house.footwork` kicks on
1/5/9/13), and 218 of the 744 snare/clap rows have no 4/4 backbeat hit.

So the WRITE path is NARROWED, not retired: it is the metre's last word in the
irregular bars, and nowhere else.

**SUPERSEDED IN STAGE 2i.** The irregular bars no longer need the WRITE path: a
DECLARED irregular metre (7/8, 5/8) carries its GROUPS, the metrical view
imposes them, and — exactly like every other metre with more than one group —
REPAIR covers the anchors and WRITE does not fire. What is left for WRITE is
the reference that genuinely misses an anchor (the 115 kick rows and 218
snare/clap rows measured above). The measurements in this section stand; the
sentence about the irregular bars does not.

What changed in the audible result is the loudness, not the positions. The
positions were already right — Stage 2b's WRITE path put them there. Measured
on `ukg.ukg` in 6/8, the same seed and the same script before and after:

| lane | before           | after                |
| ---- | ---------------- | -------------------- |
| kick | 0: 0.65, 6: 0.41 | 0: 0.65, **6: 0.73** |
| clap | 2: 0.45, 8: 0.67 | **2: 0.60**, 8: 0.67 |

The shuffle's second pulse now carries the groove's own beat-2 kick instead of
a nearest-neighbour guess, and its first backbeat carries the groove's beat-4
clap — the material that used to fall off the end of the bar is back, in the
metre's own voice.

### 4/4 is byte-identical — measured, not assumed

The projection does not run in 4/4: the metre IS the library's metre, so the
material is already in the right shape. That is a short-circuit, not a
comparison, and it is why the four canonical content hashes are unchanged:
`17e1439d` (house), `688279c1` (trap), `47f20c59` (dnb), `b4f0ae78` (house-2).
The gate is stronger than the four hashes: a library-wide guard walks all 258
grooves and asserts that the metrical view is the IDENTITY for every row of
every pad in 4/4 — same positions, same values, same length, including the
one groove in the library that carries a fifteen-step row.

### The guards

- **The view invents nothing**: across the library and every metre, every hit
  in a projected row is a value that exists in the source row.
- **The kick sits exactly on the pulse** in every metre with more than one
  pulse — the projection's own contract, checked over the whole library.
- **The 4/4 identity** over the whole library, not over a fixture.
- Stage 2b's third guard still holds: no module in `src/ai/` measures a bar as
  sixteen steps. The Markov model's ledger entry now says why: the model keeps
  its frame, and the VIEW maps it.

## Stage 2d — the IMPORT speaks the document's bars

The grid was truthful and the intent engine asked in bars, but one producer
still padded in 4/4's steps: the MIDI import rounded the imported phrase up to
a multiple of SIXTEEN steps — 4/4's bar — whatever the document declared. In a
6/8 project that produced a 1.33-bar groove whose downbeat reached the bar line
only every fourth bar, and the transfer dialog had to warn the user about it.

### What was measured, before anything changed

The import's length is `ceil(neededSteps / 16) * 16`, where `neededSteps` is the
longest note end. In a 6/8 document that is a length the metrical bar does not
divide, so the imported groove drifts. The material itself was never the
problem — the notes and the drum hits sit at absolute positions, and only the
loop's LENGTH was wrong.

### The fix: pad UP to a whole number of the DOCUMENT's bars

`stepsForWholeBars(doc, neededSteps)`
(`src/project-model/grid.ts`) replaces the hard-coded multiple. The result is
**always at least `neededSteps`** — rounding UP is what keeps the user's
material: nothing is ever cut to fit a bar. The drum-hit window is bounded by
the same number, and because the window is never shorter than the longest
note, no hit is dropped either.

| metre | bar (steps) | material needs | old length | new length         |
| ----- | ----------- | -------------- | ---------- | ------------------ |
| 4/4   | 16          | 20             | 32         | **32** (unchanged) |
| 3/4   | 12          | 20             | 32         | **24** (2 bars)    |
| 6/8   | 12          | 20             | 32         | **24** (2 bars)    |
| 2/4   | 8           | 20             | 32         | **24** (3 bars)    |
| 4/2   | 32          | 20             | 32         | **32** (1 bar)     |

4/4 is the same arithmetic, so every 4/4 project is byte-identical — the
negative control, and not an optional one.

### The material does not move

The two halves of the change are different questions and both are pinned:

1. The LENGTH becomes a whole number of the document's bars. That is the fix.
2. The MATERIAL does not move. The same file imported into 4/4 and into 6/8
   lands its drum hits on the SAME steps and keeps the same note start and
   duration. Only the loop's length changes — the padding, not the content.

A change that moved the user's notes would be a rewrite, not a rounding, and
the repo's rule is that stored content is never re-expressed.

### The disclosure follows the truth

The import no longer drifts, so the warning that said it did became false —
and a disclosure that states something untrue is worse than no disclosure. It
now states what the chosen metre does: the arrangement and the step grid follow
it, and the imported groove is padded to a whole number of the document's bars
so it lands on the downbeat. The old predicate that asked "is the bar four
quarter notes" (`patternGridIsOneBar`) was production-dead the moment ADR 0057
landed — kept alive only by its own tests, which is how a guard ends up
guarding nothing. The grid's owner answers the better question:
`isWholeBarPatternFor(sig, steps)`.

The question changed one answer for the better: in 2/4 the bar is eight steps,
so a sixteen-step pattern is exactly TWO whole bars — it lands on the
downbeat, and the old warning told the user its downbeat "reaches the bar
line only every 2 bars", which was not a drift at all.

## Stage 2e — the PINNED feature contracts read the document's metre

Stage 2c moved the groove MATERIAL onto the document's metre: the library is
4/4 material and the metrical VIEW maps it. The PINNED models were a second
blind spot, and a different one — not where the material sits, but how the
model is told where it sits.

### What was measured, before anything changed

The pinned ONNX priors and the melodic model take a feature row per (pad, step)
or per note. Five of its values are the note's position inside the bar, on a
sixteen-step scale, and the drum row carries two flags. All of it was 4/4:

- the position folded at sixteen (`s16 = step % 16`). In a 6/8 bar — twelve
  steps — the bar's last eighth was called "10/16", a position that does not
  exist in that bar;
- the frame position had a floor of sixteen steps (`Math.max(16, stepCount)`),
  so a 6/8 bar looked like the first three quarters of a 4/4 one;
- `isDownbeat` was `s16 === 0`, so the SECOND bar's downbeat (step 12) was not
  a downbeat;
- `isBackbeat` was `s16 === 4 || s16 === 12` — 4/4's beat 2 and beat 4. In a
  6/8 bar the backbeat is the shuffle's "2 & 5" (steps 2 and 8), and in a 3/4
  bar there is no beat 4 at all, so the model was told about a backbeat the bar
  does not have.

### The fix: the position is divided by the BAR'S OWN LENGTH

`src/ai/symbolic/step-position.ts` is the one owner. The five position values
are now a phase encoding of "where in the bar is this note" — `phase` and its
first two harmonics, with `phase` the position in the bar DIVIDED BY THE BAR'S
LENGTH. The frame is the pattern's own length (at least one metrical bar), and
the two flags come from Stage 2b's metre (`isDownbeat`, `isBackbeatAnchor`)
instead of a second copy of 4/4's rules.

The feature COUNT is unchanged and so are the pinned manifests: no retrain.

### Why the bar's own length, and not a rescale onto sixteen steps

A phase encoding puts the downbeat at phase 0 and the half-bar at phase 0.5 in
EVERY metre, so the model reads "the downbeat" and "the half-bar" as the
numbers it learned in 4/4: in 6/8 the third eighth — the half of a
dotted-quarter bar — arrives with exactly the values 4/4's half-bar had. A
fixed-scale rescale would have to round, and rounding collides neighbouring
steps in a long bar: in 4/2, steps 1 and 2 would both land on 1.

### 4/4 is byte-identical — and the control is independent

In 4/4 the bar is sixteen steps, so the phase IS the legacy `s16/16` and every
one of the five values is bit-for-bit what it was; the frame floor and the two
flags are the same for the same reason. The spec does not take the production
code's word for it: it re-implements the legacy formula and compares the
production row against it, so the control cannot be satisfied by the code
agreeing with itself.

### The corpus and the favourites declare the training frame

The corpus IS 4/4 sheet music and the shipped models were trained on its rows,
so the ingest passes the 4/4 frame explicitly and those rows do not move — the
models stay exactly as validated. The favourites are stored 4/4 material for
the same reason. The runtime path passes the document's metre.

### The ledger shrank — and the rule became executable

Stage 2b's guard declares the sites that still state a 4/4 length, and the
ledger may only shrink. The six pinned-ONNX entries are GONE: those contracts
no longer fold the bar at sixteen, and the model's canonical frame is a named
constant in one owner.

The Markov model's entry went too, and that one is a lesson: its
sixteen-position state space is a NAMED constant (`STEPS_PER_BAR = 16`), so
the AST guard never saw it — and an entry the guard cannot see only HIDES a
file from the scan. The model's 4/4 frame is recorded here instead, and the
file is scanned like any other.

What remains is TWO entries, and they are the two things that really are 4/4
material AND still state it as a literal: the corpus the models were trained
on, and the pinned v2 chord-duration contract.

And the rule is now EXECUTABLE: a spec fails the gate when a ledger entry's
file no longer trips the guard. "The ledger may only shrink" was a sentence;
it is now a check.

### What this is NOT

The models are still 4/4-TRAINED. This change makes the feature they read
TRUTHFUL about the bar in a non-4/4 project; it does not give the model
non-4/4 training data, because none exists — the corpus is 4/4 sheet music. A
model trained on metrical frames is a retrain with new manifests: a versioned
step, and still open.

### What is still open (and where)

- **Stage 2c — metrical groove content.** The groove library is 4/4 material:
  the Markov model's state space is sixteen positions, and the corpus was
  ingested on that frame. The ONNX priors' feature CONTRACTS read the
  document's metre since Stage 2e — what is still open is the TRAINING side: a
  model trained on metrical frames is a retrain with new manifests (a
  `features.v3` contract, and re-validating the pinned manifests), and there is
  no metrical training data to retrain on — the corpus is 4/4 sheet music.
- **Content-shaped producers** — live capture's 16-slot grid and the 4/4
  templates — still wrap or carry user material at 4/4's length. The MIDI
  import's 16-rounding is **done in Stage 2d**. The remaining two are
  producers of content, not readers of the metre, and the reason is
  measurable: the capture FOLDS the take into the grid (`relStep % 16`), so
  changing the grid's length RE-ARRANGES the recording — a hit at step 13
  wraps to step 1 in a twelve-step grid, and the groove the player performed
  is no longer the groove that comes back. The import never had that problem:
  it placed the material at absolute positions and changed only the padding.
  The templates' grooves are 4/4 by composition.
- **The assist layer** (`src/assist/patternOps.ts`) still counts bars by hand.
  Measured, the obstacle is NOT the missing document: three of the four
  `buildAssistPatch` call sites (`commands/patternAssist.ts`, `ui/AssistPanel.tsx`,
  `assist/selected-step-plan.ts`) HAVE the document. The obstacle is that the
  assist operation copies content BAR BY BAR, and the SOURCE bar and the TARGET
  bar are different units whenever the source is not bar-aligned: a 16-step
  pattern in a 6/8 project has its own sixteen-step structure, and reading it
  with a twelve-step bar misaligns the copy, while copying a whole metrical bar
  drops four steps of the user's material. So this needs a POLICY for
  non-aligned sources (copy the content's own bars, or the metrical bar and
  say what was dropped), not a parameter. **DONE in Stage 2g** — the policy is
  the metrical bar, and the cut is counted and stated.

## Stage 2f — the METER is a first-class part of the REQUEST

Every layer above now spoke the document's metre. The REQUEST did not: the metre
was reachable only as the literal phrase "time signature 3/4" (`src/intent/exact.ts`),
which is an API spelling, not a human one. A user who typed "make me a beat in
6/8" got a 4/4 beat and a 4/4 project — the metre word was silently ignored,
which is the worst kind of failure: no error, just a beat in the wrong metre.

### One owner of the metrical vocabulary

`src/intent/meter-phrase.ts` is the one module that answers "which metre does
this text ask for?", and BOTH parsers ask it — the text parser (the generation
path) and the exact parser (the command path). Two parsers that read the same
sentence must not disagree about the metre.

The vocabulary is deliberately narrow:

- the NAMED form — "time signature 3/4", "meter 6/8", "takt 7/8", "signatura
  5/4" — with the word on either side of the number;
- the NAMED FEEL — "waltz" / "valčík" is a 3/4 in every genre;
- the BARE form ("6/8") is offered SEPARATELY, and only to the generation path.
  The command path must not take it: "make me a 3/4 beat" would become a
  document change with no beat — the user would get a metre and no music;
- **"shuffle" is NOT a metre.** A UKG shuffle is 4/4 with a swung sixteenth, a
  feel and not a bar. Mapping it to 6/8 would hijack every UKG request and
  change the genre's sound, so the word is left alone.

### The ORDER is the substance

A sentence can name a metre AND a length ("make it 2 bars in 3/4"), and the
length is read in the DOCUMENT's meter at the moment it is applied. So the
metre op is applied FIRST (a stable sort), or "2 bars in 3/4" would add 32
steps — two 4/4 bars — instead of 24, two 3/4 bars.

The requested metre also decides the LENGTH itself: `normalizeIntent` resolves
the bar length from the REQUESTED metre (`intent.timeSignature ?? doc.timeSignature`),
so "two bars in 3/4" is 24 steps before the document is even touched.

### 4/4 is byte-identical

The requested metre is carried on the intent spec **only where the request
names one** — the same rule Stage 2a used for `bars`. A 4/4 request produces
the same spec, the same canonical intent hash, the same generated beat and the
same learned preferences as before. The metre reaches the document only when
the user asked for it (the generation apply carries it: twelve steps in a 6/8
bar is exactly one bar).

Pinned by `tests/adr0057-requested-meter.test.ts` (11 specs).

## Stage 2g — the ASSIST layer counts bars in the document's metre

The assist layer was the last producer that counted bars by hand. Its four
operations and its thinning pass all believed that a bar is sixteen sixteenth
steps:

| site                                        | what it said                       | in 6/8                                             |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `expandWithBuild` — `baseBars`, `stepCount` | `round(stepCount / 16)`, `bars*16` | a four-bar build was 64 steps = **5.33 bars**      |
| `expandWithBuild` — the copy                | `baseRow[bar*16 + s]`, `s < 16`    | the source was copied in 4/4 bars                  |
| `expandWithBuild` — the notes               | `16 * STEP_TICKS` per bar          | the notes repeated every 4/4 bar                   |
| `replaceRows` — the style grooves           | tiled every 16 steps               | the "four-on-floor" kick rode the EIGHTHS          |
| `makeFill` — the zone                       | `stepCount - 16`                   | the fill's zone was 1.33 bars, crossing a bar line |
| `varyPattern` / `thinStepSelection`         | `i % 4 === 0`                      | 6/8's backbeat was thinnable                       |

### The metre is asked of the ONE owner, not re-derived

`src/assist/patternOps.ts` does not compute a bar length. It asks
`src/ai/meter.ts` (the pulse, the backbeat, the bar) and
`src/ai/groove-view.ts` (how 4/4 material says itself in another metre). Every
operation takes the meter as its LAST argument and defaults to
`DEFAULT_AI_METER` (4/4), so a caller that knows no meter keeps the legacy
behaviour byte-for-byte.

The request carries the metre (`AssistRequest.timeSignature`, optional and
absent in 4/4); the pipeline resolves it once; the commands pass the
document's metre (`src/commands/patternAssist.ts`,
`src/commands/assistSelectionCommands.ts`); the UI passes it in the preview
(`src/ui/AssistPanel.tsx`, `src/ui/DiceContext.tsx`, `src/ui/IntentPanel.tsx`).
A broken signature is DROPPED, not repaired: with no usable metre the layer
runs in 4/4, the identity, and never invents a bar length.

### The anchors are the metre's, not "every fourth step"

The pulse AND the backbeat are the metre's skeleton, and they are what the
assist layer protects. In 4/4 the union is exactly the legacy `step % 4 === 0`
(the pulse is the quarter note, and the backbeat already sits inside it). In
6/8 the pulse is the dotted quarter (0, 6) and the backbeat the shuffle's
"2 & 5" (2, 8) — and the legacy rule would have let a thinning pass DELETE the
backbeat. Measured over 200 seeds: the legacy removed the 6/8 backbeat in 16 of
them, the metrical layer in 0.

### The style grooves are re-voiced, not truncated

The style tables ("four-on-floor", "backbeat", "house"…) are 4/4 material, so
they go through the same metrical view as the groove library: the kick rides
the metre's pulse, the snare the metre's backbeat, and the hats keep their
folded positions (a hat is not the metre's skeleton). The REPLACE operation
therefore keeps the style's MEANING in the new metre instead of cutting it at
the bar line.

### The policy for a source that does not fill whole bars

The build copies the source BAR BY BAR, and the bar is the document's. A source
that is a whole number of the metrical bars — the normal case, and the case
every producer in this product now produces — is copied exactly. A source that
is NOT (sixteen steps in a 6/8 project is 1.33 bars) is cut at the bar line,
which is the LEGACY's own policy (a twenty-step source in 4/4 lost four steps
the same way) with the bar length corrected. The cut is COUNTED
(`assistSourceAlignment`) and STATED — in the command's detail and in the
Assist preview — because a cut the user cannot see is a cut the user cannot
undo either.

### The visible surface followed, and the ledger shrank

The Assist preview drew a fixed sixteen-cell bar with 4/4 beat markers — the
last visible 4/4 site in this layer. It now draws ONE METRICAL BAR (twelve
cells in 6/8) with the metre's own beat markers, and the visible-surface
ledger in `tests/adr0057-metrical-step-grid.test.ts` lost its entry. The
ledger may only shrink; this stage shrank it.

### 4/4 is byte-identical — measured, not assumed

The pre-patch implementation (extracted verbatim from the parent commit into
the same process) and the metrical one, on the same fixture, with the same
seeds: **8 of 8 operations byte-identical** — VARY (with and without an
explicit 4/4 meter), BUILD, REPLACE (hats, kicks, snares), FILL and the
thinning pass.

### What changed in 6/8

Measured on the same script, before and after, in a 6/8 document (24 steps =
two 6/8 bars):

| what                    | legacy                          | metrical                                  |
| ----------------------- | ------------------------------- | ----------------------------------------- |
| BUILD to four bars      | 64 steps = 5.33 bars            | **48 steps = 4.00 bars**                  |
| BUILD's phrase plan     | bars at 0/16/32/48              | **bars at 0/12/24/36**                    |
| FILL's zone (24 steps)  | starts at 8 (the last 16 steps) | **starts at 12 (the last 6/8 bar)**       |
| FILL's zone (32 steps)  | starts at 16                    | **starts at 20**                          |
| REPLACE four-on-floor   | 0, 4, 8, 12, 16, 20, 24, 28     | **0, 6, 12, 18** (the dotted quarter)     |
| REPLACE backbeat        | 4, 12, 20, 28                   | **2, 8, 14, 20** (the shuffle's "2 & 5")  |
| REPLACE house hats      | 2, 6, 10, 14, 18, 22, 26, 30    | **2, 6, 10, 14, 18, 22** (the folded bar) |
| VARY thins the backbeat | 16 of 200 seeds                 | **0 of 200 seeds**                        |

The hats are the one row that did NOT gain a skeleton, and that is the
projection's own rule: a hat is not the metre's skeleton, so it keeps the
folded positions of the 4/4 style.

Pinned by `tests/adr0057-assist-meter.test.ts` (14 specs).

## Stage 2h — the metre is never changed silently

### What was measured, before anything changed

ADR 0056 shipped the transfer dialog's disclosure and left a note in its own
"Consequences":

> Other meter-setting surfaces (the `kyx_music` MCP tool, the text-intent path,
> `setTimeSignature`) can still change a project's meter without disclosure.
> They are a follow-up.

They were. Three surfaces changed a project's metre and said only what they
were asked to say:

| surface            | what it said                                | what it did NOT say |
| ------------------ | ------------------------------------------- | ------------------- |
| `setTimeSignature` | `Time signature 6/8` (the undo label)       | what 6/8 measures   |
| the intent path    | `time signature 4/4→6/8 ✓`                  | what 6/8 measures   |
| the MCP surface    | `time signature is now 6/8 (one undo step)` | what 6/8 measures   |

And a fourth surface was not in that list at all: the AI GENERATION path
(`src/commands/aiPattern.ts`) writes `doc.timeSignature` DIRECTLY, so it never
went through the command and never inherited anything the command could have
said. "Make me a beat in 6/8" moved the project into 6/8 and the user was told
nothing about what 6/8 measures.

### One owner: `src/project-model/meter-disclosure.ts`

The words live in ONE module, and it owns the measured facts:

- the metrical BAR in ticks and in sixteenth steps (`ticksPerBarFor`,
  `stepsPerBarFor`) — the ruler, the clip placement, the loop region;
- the metrical BEAT in ticks and in sixteenth steps, and how many beats the bar
  holds (`ticksPerBeatFor`, `stepsPerBeatFor`) — the click the metronome plays
  and the count the ruler prints;
- what happens to the user's own pattern: its LENGTH does not change, so a
  pattern that is not a whole number of the new bars drifts against the ruler.

The transfer dialog now quotes the same `meterMeaning()` sentence it always
quoted, so the dialog that OFFERS a metre and the surfaces that CHANGE a metre
cannot describe the same metre in two different ways. The formula is not
re-implemented there: `meterFacts` reads `ticksPerBarFor` / `stepsPerBarFor` /
`ticksPerBeatFor` / `stepsPerBeatFor`, so the sentence cannot state a number
the engine does not use.

### The silence rule is the SIGNATURE, not the bar

This is the part that was not obvious while writing it. The first version keyed
the disclosure on the BAR — "the bar did not change, so say nothing" — and that
would have been WRONG:

- 4/4 → 2/2 keeps the bar's 1920 ticks and its 16 steps, but the beat becomes
  a half note, so the metronome clicks TWICE a bar instead of four times
  (`ticksPerBeatFor`, `src/scheduler/Scheduler.ts`). A disclosure keyed on the
  bar would stay silent about a change the user can HEAR.

So the disclosure fires when the SIGNATURE changes, and it states the beat as
well as the bar:

```
bar = 1440 ticks / 12 steps (6 beats of 240 ticks); your 16-step pattern is 1.33 bars and drifts against the ruler — snap it to a whole bar (12 steps) to land on the downbeat
```

And 4/4 → 4/4 says NOTHING at all. That is the negative control every spec
pins: a disclosure that fires on a no-op is a disclosure nobody reads.

### The four surfaces

| surface            | where the disclosure lands                                                      |
| ------------------ | ------------------------------------------------------------------------------- |
| `setTimeSignature` | `Command.detail` — the consequence note the command toast shows under the label |
| the intent path    | the read-back line (`exactReadback`) — the intent's own receipt                 |
| the MCP surface    | the tool response text                                                          |
| the AI path        | `Command.detail` — the BAR clause only                                          |

Two details are deliberate:

- The AI path states only the BAR. Its generated pattern is built IN the
  requested metre, so a clause about the OLD pattern's length would describe
  material that no longer exists.
- The intent path's grouped command does not carry the command's detail
  (`applyExactIntentCommand` returns a fresh `snapshot`), so the read-back
  shows the clause exactly once — a receipt, not a toast plus a receipt.

### The guard

`tests/adr0057-meter-disclosure.test.ts` (24 specs) pins:

- the four surfaces disclose, and they say the SAME words (the clause string
  is compared across all of them);
- 4/4 → 4/4 discloses nothing, on every surface;
- 4/4 → 2/2 discloses the BEAT change;
- the numbers in the clause are the MEASURED ones, for every metre;
- **no surface changes the metre without disclosing it** — an AST scan finds
  every site that BUILDS a metre or calls the command, the ledger of sites
  that do not change a project's metre is complete, every metre surface asks
  the one owner for the words, and **the ledger may only SHRINK** (every entry
  must still be needed);
- **the disclosure's words live in ONE owner** — the owner's phrases may not
  be re-typed in another surface;
- the guard is **proven able to fail**: the last specs feed it synthetic
  violations, and the behavioural specs were falsified by removing the
  command's disclosure (three specs went red).

### The model retrain is still a to-do

Nothing here changes the models. The pinned ONNX contracts still read a
sixteen-step frame and the models are still 4/4-TRAINED; this stage only
makes the SURFACE tell the truth about the metre the document now carries. The
retrain stays a to-do, and it is the same to-do as in Stage 2e: a versioned
`features.v3` contract, re-validated manifests, and metrical training data
that does not exist yet (the corpus is 4/4 sheet music).

## Stage 2i — an IRREGULAR bar has GROUPS, not a pulse

Stage 2b made the AI layer speak the document's metre, 2c made the groove
MATERIAL speak it, and 2g made the assist layer count the document's bars. An
irregular bar was left with a regime of its own: the whole bar was ONE pulse,
only the downbeat was anchored, and the grouping was declared "content, not
arithmetic".

That regime was RIGHT about the arithmetic and WRONG about the consequence.

### What was measured, before anything changed

A 7/8 document (house, seed "measure", two bars, the product's canonical
generation options) produced:

```
Kick Deep   [0, 14]      <- the downbeat of each bar, and nothing else
Kick Punch  [0, 14]
Clap        [12]          <- one stray note
Hat Closed  [1]
Hat Open    [6]
```

The kick was a bare click on the beat 1 of every bar: the groove was GONE, not
merely sparse. A 5/8 document produced Kick Deep [0, 10] and Kick Punch
[0, 10] — the same bare click — with a few stray notes around it.

Two rules in the code produced that, and both are real:

1. **The syncopation budget.** `enforceSyncopationBudget`
   (`src/ai/style-quality.ts`) removes every hit whose syncopation weight is
   above zero and that is not an anchor. The weight treated only
   `position % meter.pulseSteps === 0` as on-grid. In 7/8 the pulse IS the
   whole bar (fourteen steps), so every hit off the downbeat weighed **1** —
   the maximum — and the budget stripped the groove lane by lane.
2. **The metrical view's refusal.** `src/ai/groove-view.ts` refused to
   re-voice the kick in a metre with one pulse, on the ground that "the
   grouping is content". So even the material that survived had nowhere to go.

Rule 2 was a DELIBERATE product decision from Stage 2c and rule 1 was its
consequence. Stage 2i supersedes the decision — not because it was wrong in
principle, but because the product had no irregular CONTENT to put in place of
the grouping, and a metre with no content is a metre that does not work.

The same script and the same seed, after this stage:

```
Kick Deep   [0, 4, 8, 14, 18, 22]   <- the 2+2+3's downbeats
Kick Punch  [0, 4, 8, 14, 18, 22]
Clap        [8, 22, 23]              <- the accent group ("5") and a ghost
Hat Closed  [1, 4, 5, 8, 11, 15, 17, 19, 21, 25, 27]
```

The 5/8 document went from Kick [0, 10] to Kick Deep [0, 6, 10, 16] and Clap
[5, 6, 16] — the 3+2's "1" and "4", with the backbeat on the accent.

### The one owner: `src/ai/meter.ts` — the GROUPS

An irregular bar's structure is not a PULSE but a LIST OF GROUPS. The metrical
facts carry them:

| fact         | 4/4      | 6/8   | 7/8       | 5/8      | 11/8  |
| ------------ | -------- | ----- | --------- | -------- | ----- |
| `pulseSteps` | 4        | 6     | **14**    | **10**   | 22    |
| `groups`     | 4,4,4,4  | 6,6   | **4,4,6** | **6,4**  | 22    |
| `irregular`  | false    | false | **true**  | **true** | false |
| the kick     | 0,4,8,12 | 0,6   | **0,4,8** | **0,6**  | 0     |
| the backbeat | 4,12     | 2,8   | **8**     | **6**    | —     |

The pulse value is NOT changed. 7/8's `pulseSteps` is still 14, because that
fact says the pulse does not repeat — and the GROUPS say where the accents
are. Replacing the legacy value would have hidden the difference between the
two, and `tests/adr0057-irregular-metre.test.ts` pins both.

**The groupings are DECLARED, not guessed.** 7/8 is not one metre but several
(2+2+3, 2+3+2, 3+2+2, 2+2+2+1) and 5/8 likewise (3+2, 2+3). The signature does
not say which, and the groove library cannot say it either — MEASURED: the
library is 4/4 material (258 grooves, every row sixteen steps), and
`src/ai/grooves/balkan.ts` carries eurodance-flavoured 4/4 grooves, not 7/8
content. So the product DECLARES the common ones and says so:
`IRREGULAR_GROUPINGS = { "7/8": [2, 2, 3], "5/8": [3, 2] }`.

**The accent is the LAST group.** In 2+2+3 the accent is the long group's
downbeat (the "5"); in 3+2 it is the only group downbeat besides the
downbeat (the "4"). Both are the last group, so both fall there — and both are
where a snare lives. The kick rides the GROUP downbeats: the "1", the "3" and
the "5" of a 2+2+3.

**The grid follows the group.** The eighths inside a 2+2+3 are 0, 2, 4, 6, 8,
10, 12 — counted from each group's own downbeat, so the long group's third
eighth (12) is on the grid even though it is not a multiple of the short
group's half.

### The change, layer by layer

- **The anchors.** `isPulse` is the group downbeat in an irregular metre; the
  backbeat is the accent group.
- **The metrical view.** The projection imposes the declared grouping: the
  kick on the group downbeats, the snare on the accent. A bar with ONE group
  still keeps the groove's own shape — the refusal survives, it is simply
  narrower than it was.
- **The syncopation grid.** The weight is the metrical grid: the group
  downbeat is 0, the eighths inside the group are 0.35, everything else is 1.
- **The accent hierarchy.** The downbeat, the accent group, the group
  downbeats, the rest — the shape the phrase dynamics apply.
- **The fill.** A fill swells into the ACCENT group (the 2+2+3's last three
  eighths), not into "the last pulse".
- **The quality metrics.** The off-pulse test asks the grid, not the pulse.
- **The intent verbs.** The off-beat is "not a group downbeat".

### 4/4 and every regular metre are byte-identical — measured, not assumed

The four canonical content hashes are unchanged (17e1439d, 688279c1, 47f20c59,
b4f0ae78) and the generated rows are the same lane by lane. MEASURED on the
direct generation path (the same script, the same seed, before and after):
4/4 `Kick Deep [0, 4, 7, 8, 12, 16, 20, 23, 24, 28]`, `Kick Punch
[4, 12, 19, 20, 28]`, `Clap [4, 5, 12, 20, 28, 30]`; 6/8 `Kick Deep
[0, 6, 12, 18]`, `Clap [2, 8, 14, 20]` — identical to the last step.

The metrical facts are legacy for every regular metre, and the identity is
structural, not lucky: for a simple metre the groups ARE the pulses, and the
half-grid test is the legacy `pulseSteps / 2` test, step by step. The spec
re-implements the legacy formula and compares it against the production one, so
the control cannot be satisfied by the code agreeing with itself.

### The fallback: a grouping the product does not know

An irregular metre that is NOT declared (11/8) keeps the whole bar as one
group: one anchor (the downbeat), no backbeat, the projection's refusal
stands, and the content is exactly what it was — MEASURED before and after,
lane by lane: `Kick Deep [0, 22]`, `Kick Punch [0, 22]`, `Clap [12]`, `Hat
Closed [1]`, `Hat Open [14]`. The product does not guess a grouping.

### The pinned models are NOT retrained — and NOT edited

The pinned ONNX feature files are not touched. The backbeat FLAG follows the
metre, because that is what Stage 2e established ("the two flags come from
Stage 2b's metre"), and the feature COUNT and the pinned manifests are
unchanged: no retrain. The models are still 4/4-TRAINED, and the irregular
lane has no training data at all — that is the same to-do as in Stage 2e: a
versioned `features.v3` contract, re-validated manifests, and metrical
training data that does not exist yet.

### The groove LIBRARY is still 4/4

An irregular groove is produced by the METRICAL VIEW, not by a library entry.
A library of real 7/8 grooves is a content project, and for the model to
learn them it is also the retrain above. What ships now is a 7/8 document
that finally plays like 7/8 instead of clicking on the downbeat.

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
   (measured against a captured baseline). The groove CONTENT is 4/4 —
   **DONE in Stage 2c**: `src/ai/groove-view.ts` is the metrical view of the
   library, and the material now carries the metre's anchors in the groove's
   own voice. **The IRREGULAR metres** — **DONE in Stage 2i**: an irregular bar
   has GROUPS (7/8 is 2+2+3, 5/8 is 3+2), the kick rides the group downbeats,
   the backbeat sits on the accent, and the syncopation grid follows the
   group — so a 7/8 document finally plays like 7/8 instead of clicking on
   the downbeat.
2. **The intent / brief contracts.** **DONE in Stage 2a** — the five gates
   (`src/intent/schema.ts`, `project-brief.ts`, `creative-task-contract.ts`,
   `src/project-model/producer-brief.ts`, `src/intent/normalize.ts`) no longer
   demand a multiple of sixteen, and the brief carries bars beside steps.
3. **The MCP surface.** **DONE in Stage 2a** — `kyx_generate` takes the
   document's bars, `setPatternLength` takes bars or steps and reads back
   both, and the creative-task request resolves the length against the meter.
4. **Content-shaped producers.** The MIDI import's 16-rounding
   (`src/midi/midiProject.ts`) is **DONE in Stage 2d** — the imported pattern
   is padded up to a whole number of the document's bars, and the material
   does not move. Still open: live capture's 16-slot grid
   (`src/arrangement/capture.ts`) and the 4/4 templates
   (`src/project-model/templates.ts`, `template-pack2.ts`).
5. **The ONNX feature vectors.** `src/ai/symbolic/*` encodes a fixed 16-step
   bar into a fixed-width feature row; moving the grid means re-validating the
   pinned model manifests under `public/models/`. This is **Stage 2e**, and it
   is a retrain, not a flip: no manifest records the frame length, so changing
   it would break every model silently. Stage 2c kept the Markov model's frame
   for the same reason — the model generates its own bar and the metrical view
   maps it.
6. **The assist layer.** **DONE in Stage 2g** — the four operations and the
   thinning pass count bars in the document's metre, the style grooves are
   re-voiced through the metrical view, the anchors are the metre's pulse and
   backbeat, and the visible preview follows (the ledger shrank).
7. **The REQUESTED metre.** **DONE in Stage 2f** — the metre is a first-class
   part of the request, with one owner for the vocabulary and the order that
   settles the metre before the length.

The visible surface's remaining 4/4 sites are declared in the guard's ledger
(`tests/adr0057-metrical-step-grid.test.ts`): the generate / dice preview
grids (16 cells, because the generator's output shape is 16), the automation
lane's beat grid, the brief's length readout, and the hum-to-melody contour's
bar lines. **The ledger may only shrink** — and Stage 2g shrank it: the Assist
preview drew a fixed sixteen-cell 4/4 bar, and it now draws one metrical bar.

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
- **The import speaks the document's bars**: the imported pattern's length is a
  whole number of the document's bars, the material does not move, and 4/4 is
  byte-identical.
- **A compound metre gets a shuffle, not a tresillo**: in 6/8 the backbeat is
  the second unit inside each group of three.
- **4/4 keeps the same generated beat** — the same canonical content hash, the
  same anchors, the same recipe, and no metre in the recipe at all.
- **No AI module measures a bar as sixteen steps** — the guard proves it can
  fail, and the 4/4 ledger may only shrink.
- **The groove material speaks the document's metre**: the metrical view
  projects the library's 4/4 material into the document's metre, the anchors
  carry the groove's OWN loudness (not a nearest-neighbour guess), and no
  projected hit is a value the source row did not have.
- **The requested metre is a request**: "time signature 6/8", "meter 3/4" and
  "waltz" are read by ONE vocabulary owner, the metre is settled BEFORE the
  length, and a request that names no metre leaves the intent hash — and the
  generated beat — untouched.
- **The assist layer speaks the document's metre**: a build of N bars is N
  bars of the metre, the fill's zone is the last metrical bar, the style
  grooves are re-voiced on the metre's anchors, and the thinning pass cannot
  delete the metre's backbeat. 4/4 stays byte-identical, and a source that
  does not fill whole bars says how much was cut.
- **The metrical view is the identity in 4/4** — for every groove, every pad,
  every row: same positions, same values, same length.
- **An irregular bar is given the skeleton it DECLARES, and not one it does
  not** — 7/8 is 2+2+3 and 5/8 is 3+2, so the kick rides the group downbeats
  and the backbeat sits on the accent group; an irregular metre whose grouping
  is NOT declared (11/8) keeps the library's grouping and has no backbeat to
  be re-voiced onto.
- **An irregular bar plays like itself** — a 7/8 document produces a 7/8 groove
  (the kick on the groups, the backbeat on the accent), not a click on the
  downbeat; and 4/4 and every regular metre are byte-identical to what they
  were before this stage.
- **The metre is never changed silently**: every surface that can change a
  project's metre discloses what the new metre MEASURES and what happens to
  the material, and they all say the same words.
- **4/4 → 4/4 says nothing** — a disclosure that fires on a no-op is a
  disclosure nobody reads.
- **4/4 → 2/2 discloses the BEAT** — the bar keeps its length, but the click
  changes, and a change the user can hear is disclosed.

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
- `src/project-model/meter-disclosure.ts` — the DISCLOSURE truth (one owner)
- `src/ai/meter.ts` — the AI layer's metrical truth (one owner)
- `src/ai/groove-view.ts` — the metrical VIEW of the groove material (one owner)
- `src/ui/Sequencer.tsx` — the ruler and the step cells
- `src/ui/PianoRoll.tsx` — the bar lines, the note-length menu
- `src/export/transfer-import.ts` — `patternGridWarning`
- `tests/adr0057-metrical-step-grid.test.ts` — the truth table and the guard
- `tests/adr0057-metrical-import-length.test.ts` — the import's metrical
  length, the material that does not move, and the 4/4 negative control
- `tests/adr0057-metrical-intent-length.test.ts` — the intent engine's bars, the MCP surface's bars, and the second guard
- `tests/adr0057-ai-meter.test.ts` — the AI layer's metre, the 4/4 baseline, and the third guard
- `tests/adr0057-metrical-groove.test.ts` — the groove material's metre, the
  library-wide guards, and the 4/4 negative control
- `tests/adr0057-irregular-metre.test.ts` — the irregular metres' groups, their
  anchors, their generated content, and the undeclared fallback
- `tests/adr0056-pattern-grid.test.ts` — the drift, and the whole-bar control
- `tests/adr0057-meter-disclosure.test.ts` — the disclosure on every surface,
  the 4/4 negative control, the metre-site guard, and its falsification
- `docs/adr/0056-arrangement-bar-length-and-time-signature.md` — the arrangement's move onto the meter
