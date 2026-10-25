# ADR 0062 — KOPA: the kick's shape as a graphic (the layer editor)

Date: 2026-10-25 · Status: Accepted · Scope: KOPA instrument UI, the instrument command path, the preview path

## Context

KOPA is a kick designer with 35 parameters and no picture. A user could set
`tailDecay` to 400 ms but never saw that the tail is ten times longer than
the click, never saw that the sub rides the body's envelope, and never saw
the pitch envelope that gives the kick its snap. The parameters were a list
of sliders — the opposite of a designer's instrument.

The flagship roadmap (wave 2) asks for exactly this: one shared time axis
with the click / body / sub / tail layers separated, the pitch envelope
drawn over them, the basic timing and levels editable in the graphic, a
quick preview with a before/after comparison, and the confirmation written
through the canonical command as ONE undo action.

Three things had to be decided before any of that could be drawn.

1. **Where does the picture come from?** A drawing that only looks right is
   worth nothing — if the graphic and the DSP disagree, the graphic is a
   lie the user pays for.
2. **How does a drag reach the document?** The EnvEditor commits on every
   pointer move, so one drag is dozens of undo steps and "undo my drag" is
   impossible.
3. **How does the preview hear the draft?** The document must not change
   while the user is still dragging.

## Decision

### 1. The picture is the DSP's picture — ONE implementation, measured

`src/kopa/layerModel.ts` is the editor's model, and it does not re-derive
the sound: it IMPORTS the pitch-envelope shape and the decay coefficient
from the processor itself (`pitchEnvAt`, `kopaDecayCoef` in
`src/kopa/dsp/kopaProcessor.ts`). There is one implementation of each, so
the drawn curve and the sound cannot drift apart.

The model is pure and it says the truths the DSP actually implements:

- the layer envelope is the DSP's recurrence, `(1 - coef)^n` — which is why
  the DSP's comment says the envelope "reaches ~5 % after `decaySec`";
- the SUB rides `max(bodyEnv, tailEnv)`, so its width is the LONGER of the
  body and the tail. The graphic draws it that way and says so;
- the BODY has no level parameter (the DSP fixes its mix gain), so the
  graphic offers no height handle for it — the handles are the parameters
  that exist, not the ones that would be nice.

### 2. The time axis is logarithmic

A 3 ms click and a 400 ms tail cannot share a linear axis: on a linear one
the click is a 0.7 % sliver. The axis is log, 1 ms → 3 s (3.48 decades, so
one decade is 28.8 % of the width), and both the drawing and the dragging
use the same mapping — the handle you grab sits where the curve's end is.

### 3. A drag is ONE undo step

`setInstrumentParams` (`src/commands/instrument.ts`) writes SEVERAL
parameters as one command: it records the previous value of every key it
touches, clamps each with the instrument's own definitions, and restores
exactly those keys on undo. The editor paints locally while the pointer
moves and writes the document ONCE, when the pointer comes up.

This is why the EnvEditor is NOT the precedent: it commits per pointer
move, so a drag is dozens of undo steps.

### 4. The audition never touches the document

`AudioEngine.previewInstrumentWithParams` → `PreviewDeck.previewInstrumentWithParams`
builds a TEMPORARY runtime from the draft values (the same factory, the same
DSP, the same normalization gain the live chain applies) and disposes it
after the note's tail. The project is untouched: a comparison is not an
edit. The editor's A/B row previews the saved values (A) or the draft (B).

### 5. Every handle is a real slider

Each handle is focusable, exposes `role="slider"` with its value, and the
arrow keys move it (Shift = a coarse step). The editor stays usable in a
narrow panel and without a mouse.

## Consequences

- KOPA's sound page now shows the shape before the knobs. The bare
  "PREVIEW C2" button is gone: the editor's A/B row owns the audition.
- The editor can only show what the DSP has. A layer without a level
  parameter has no height handle; the sub has no width handle. If KOPA
  later grows a per-layer start offset, the model grows with it — the
  graphic is not a second, weaker instrument definition.
- The command surface grew by one (`setInstrumentParams`). It is the
  general batch form of `setInstrumentParam` and is available to any
  instrument panel.

## Evidence (measured, not asserted)

`tests/kopa/layer-model.test.ts` renders the REAL processor and compares
what came out of it with what the editor would draw:

| Check                                                                                                                                    | Result                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The drawn body envelope vs the RENDERED body envelope (5 points from 10 ms to 400 ms)                                                    | within 8 %                                                              |
| The drawn pitch curve vs the RENDERED pitch (the zero-crossing intervals of the rendered body, vs the model's curve at the same instant) | within 8 %                                                              |
| The sub's envelope at 500 ms with a 100 ms body and a 1 s tail                                                                           | it follows the TAIL, and the body's envelope is 2 % of the tail's there |
| The time axis                                                                                                                            | 1 ms → 3 s over 3.48 decades; one decade = 28.8 % of the width          |

`tests/kopa/editor-command.test.ts`: a four-parameter drag is ONE undo step;
the undo restores exactly the keys it touched; every value is clamped to the
instrument's range; redo replays the whole drag.

`tests/ui/KopaEditor.test.tsx`: the graphic shows the values STORED in the
project; a drag writes one command; the drag changes only the parameter it
touched; the audition calls the preview with no document write at all; one
arrow key is one command; and the graphic offers no handle for a parameter
the DSP does not have.

## What this ADR does NOT change

The KOPA DSP is untouched apart from two expressions being extracted so the
editor can share them (`pitchEnvAt`, `kopaDecayCoef` — the same formulas,
called from the same place). The instrument's parameter list, the presets,
the offline parity contract and the render path are unchanged: the editor
writes existing parameters through the existing command path.
