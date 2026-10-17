# ADR 0049 — Piano Roll per-note Event Editor

- **Date:** 2026-10-17
- **Status:** accepted for the schema and first runtime slice; instrument coverage remains open
- **Scope:** per-note event data, Piano Roll editing, shared live/offline note dispatch

## Context

The FL Studio Piano Roll exposes velocity, pan, release velocity, Mod X/Y,
fine pitch and note articulation as per-note event targets. Image-Line documents
the targets, their ranges and the fact that release and Mod X/Y depend on the
instrument. Its note model uses pan/velocity/release/fcut/fres values in
0..1, fine pitch in ±12 semitones, and separate slide and portamento flags.

- [FL Studio Piano Roll manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- [FL Studio Piano Roll scripting API](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll_scripting_api.htm)

KYX already stores sparse MIDI notes and edits pitch, duration, velocity and a
legacy `slide` flag. The integrated lower lane only edited velocity. Mutations
must remain commands so undo, autosave, collaboration and the engine observe the
same project value.

## Decision

1. Store optional event properties on each `NoteEvent`; schema v33 clamps
   malformed and out-of-range values during normalization. An absent field
   means the instrument default, so old notes retain their sound.
2. Edit event targets through one lower Piano Roll lane. A continuous drag is
   one command; selected notes keep their relative values; Alt-click resets
   them to the target default; a press/release without movement is a no-op;
   `pointercancel` restores the preview without committing.
3. Fine pitch is added to note pitch inside `TriggerEngine`, which is shared by
   live playback and offline render. Per-note audio targets must be consumed by
   a voice-specific runtime; track-wide controls are not a valid substitute.
4. The first runtime slice supports fine pitch across built-in instruments and
   pan, filter cutoff, resonance and release-velocity scaling on the gated 808.
   The UI only shows targets for runtimes that currently consume them. It must
   not imply that a stored value changes sound when that runtime ignores it.
5. Keep the existing `NoteEvent.slide` behavior compatible for now: it glides
   into the flagged note and is therefore a portamento transition. FL's slide
   note instead changes the pitch of an overlapping held voice without
   starting a new attack. A separate slide-note event and its overlap/color
   rules remain a required follow-up before claiming FL parity.
6. Standard MIDI 1.0 output cannot represent arbitrary polyphonic per-note
   expression on one channel. Export or external MIDI support must use an
   explicit MPE/channel policy rather than silently dropping pitch or mapping
   per-note pan to a track-wide controller.

## Current evidence

- `NoteExpression` is normalized as part of project schema v33.
- `setNotesExpression` creates one undoable command and returns an identity
  command when a gesture produces no value change.
- Piano Roll exposes velocity/fine pitch for every instrument and adds the
  808-only pan/filter/release targets.
- The 808 applies filter, panning and release data in its per-voice graph.
- `tests/note-expression.test.ts` covers clamping, Yjs round-trip,
  undo/redo and default-value no-op.
- `tests/ui/piano-roll-event-editor.test.tsx` enters the real selector and
  pointer handlers against a real `ProjectStore`, including no-move and
  `pointercancel` negatives.

## Acceptance gates for further coverage

- Add a declared per-note capability contract for each instrument runtime and
  map pan, release, Mod X/Y and pitch to the runtime's actual voice controls.
- Add audio assertions for each target family; parameter storage alone does
  not prove an audible result.
- Prove live and offline render parity for pitch and each implemented target.
- Add independent overlapping slide-note and portamento semantics, with
  deterministic voice selection and tests for missing/ended source notes.
- Define MPE behavior for external MIDI and MIDI-file round-trip before
  claiming per-note expression interchange.
