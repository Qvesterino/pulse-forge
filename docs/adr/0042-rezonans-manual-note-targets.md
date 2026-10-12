# ADR 0042 — REZONANS: absolute per-voice note targets

- **Status:** accepted (2026-10-12)
- **Amends:** `0040-rezonans-vocal-formant-harmonizer.md`, `0041-rezonans-formant-bands.md`
- **Scope:** add a manual-note harmony mode without changing existing modes or saved patches.

## Context

REZONANS currently asks each voice for an interval or scale degree and resolves
that intent against the live singer, key and chord lane. This is expressive and
musically aware, but it cannot directly voice a fixed written harmony such as
`C4 / E4 / G4` while the singer moves. ADR 0041 explicitly deferred per-voice
note entry as a separate solver branch. That is now a product requirement for
arranged, repeatable vocal stacks.

## Decision

1. Add `MANUAL NOTES` as a fifth global harmony mode. Existing OFF, INTERVAL,
   DEGREES and CHORD TONES retain their current semantics.
2. Add one per-voice `note` parameter, stored as MIDI note number 36–96 (C2–C7).
   Its default is inert unless MANUAL NOTES is selected.
3. In MANUAL NOTES, the solver targets each voice's absolute note. It clamps the
   requested target to the existing pitch-shifter range of ±12 semitones from
   the detected singer. The solver meter reports the applied target, so the
   pitch ladder never claims a note the audio did not render.
4. Keep ratio glide, unvoiced hold, formant articulation, voice level, pan,
   humanization, and the existing latency/PDC path unchanged.
5. The panel replaces each degree control with a note-name selector in this
   mode. It explains the ±12-semitone reach, and the generic editor exposes the
   same finite note list.
6. Existing projects are compatible: absent `voiceN.note` values load from
   defaults, and no project schema migration is required.

## Validation

- Solver tests pin absolute note targeting, multi-voice independence and the
  ±12-semitone applied-target clamp.
- Processor render test measures the selected note in wet audio.
- UI test verifies note selectors appear only in MANUAL NOTES and commit the
  selected MIDI note.
- Rezonans golden, real-phrase, live/offline and 300-second soak suites remain
  green; effect defaults goldens are regenerated through the repository's
  derivable-artifact workflow.

## Addendum (2026-10-12) — expose range-limited targets

When a MANUAL NOTES target exceeds the pitch shifter's ±12-semitone reach from
the detected singer, the voice row now shows the note actually applied by the
solver, for example `LIMIT A3`. The status comes from the processor's resolved
`voiceMidi` meter and is shown only for an enabled voice while the input passes
the configured clarity gate. Its accessible status text names both the request
and the applied note. This preserves the existing audio limit while making its
effect on an absolute target visible at the control that selected it.

Validation: `tests/ui/RezonansPanel.test.tsx` switches from no meter to a
clamped live target and checks both the visible applied note and the accessible
request-to-applied explanation.

## Addendum (2026-10-12) — direction-symmetric pitch glide

The existing 5–80 ms GLIDE control keeps the established upward-transposition
response, now mirrored in semitone space for downward motion. A one-pole
directly on ratios moves an octave-up target much faster in cents than an
octave-down target. A plain linear semitone one-pole fixes that asymmetry but
softens the previously faster transition; the symmetric curve preserves that
response in both directions. The hop-scaled coefficient remains independent of
quality. Pitch range, solver targets, humanization and saved parameters are
unchanged.

Validation: the REZONANS golden suite checks equal up/down glide progress,
finite invalid-input handling, the established ±12-semitone ceiling and the
rendered MANUAL NOTES target at Economy, Balanced and Fine quality.
