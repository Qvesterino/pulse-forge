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

1. Store optional event properties on each `NoteEvent`; schema v35 clamps
   malformed and out-of-range values during normalization. An absent field
   means the instrument default, so old notes retain their sound.
2. Edit event targets through one lower Piano Roll lane. A continuous drag is
   one command; selected notes keep their relative values; Alt-click resets
   them to the target default; a press/release without movement is a no-op;
   `pointercancel` restores the preview without committing.
3. Fine pitch is added to note pitch inside `TriggerEngine`, which is shared by
   live playback and offline render. Per-note audio targets must be consumed by
   a voice-specific runtime; track-wide controls are not a valid substitute.
4. A lightweight shared capability map populates each `InstrumentDefinition`
   with the expression keys consumed by its runtime and drives the Piano Roll
   lane list. The
   first runtime slice supports fine pitch across built-in instruments,
   voice-specific pan on 18 built-in voice instruments, and centered Mod X/Y
   mapped around each instrument's ordinary per-voice cutoff and resonance on
   16 built-in voice-filtered instruments. Release velocity scales the authored
   note-off envelope on 19 built-in instruments; normalized 0.5 preserves the
   authored release, while 0 and 1 scale its time constant to 0.25× and 1.75×.
   Slide-note pitch bends are supported by the gated 808 and monophonic Acid 303. Each runtime must retain the source gate, define a deterministic voice choice and bend without allocating a new attack.
   Mod X/Y use normalized 0..1 values centered at 0.5; 0.5 preserves the
   instrument's ordinary filter settings.
   The UI only shows targets for runtimes that currently consume them. It must
   not imply that a stored value changes sound when that runtime ignores it.
5. Keep the existing `NoteEvent.slide` behavior compatible: it glides into the
   flagged note and is therefore a portamento transition. `NoteEvent.slideNote`
   is separate and changes the pitch of an overlapping held 808 or monophonic
   Acid 303 voice without starting a new attack. A shared capability map gates
   the UI and schema. Acid evaluates the current exponential pitch ramp at the
   event time, caps the bend at the held gate, and keeps note-off attached to
   the source key. Chord/color groups remain open because KYX has no FL-style
   note-color reference selection.
6. Standard MIDI 1.0 output cannot represent arbitrary polyphonic per-note
   expression on one channel. Export or external MIDI support must use an
   explicit MPE/channel policy rather than silently dropping pitch or mapping
   per-note pan to a track-wide controller.

## Current evidence

- `NoteExpression` and held-voice slide-note articulation are normalized as
  project schema v35, including centered Mod X/Y values.
- `setNotesExpression` creates one undoable command and returns an identity
  command when a gesture produces no value change.
- Piano Roll exposes velocity/fine pitch for every instrument, pan for the 18
  runtimes declaring that voice-level capability, Mod X/Y and direct
  cutoff/resonance for 16 per-voice filter runtimes, and release velocity for
  19 runtimes with a note-off envelope.
- The 808 applies filter, panning and release data in its per-voice graph.
  Mod X maps logarithmically from 80 Hz to 16 kHz with 0.5 at the note's
  ordinary cutoff; Mod Y maps Q from 0.1 to 8 with 0.5 at the ordinary
  resonance. Explicit cutoff/resonance fields take precedence if both forms
  are stored on one note.
- Chromium `OfflineAudioContext` at 44.1 kHz rendered the 808 preset with a
  baseline peak of 0.704. Centered Mod X/Y differed from the no-expression
  render by RMS `4.72e-9`; Mod X = 0 changed RMS by `0.783`, and Mod Y = 1 by
  `0.070`. This verifies the 808 path only, not other instruments.
- An 808 slide-note schedules pitch ramps on the current mono voice's main,
  sub and grit oscillators; it does not allocate a voice or retrigger the
  attack. Acid 303 bends its single held oscillator, starts from any in-flight
  exponential portamento ramp, caps at note-off, and keeps the original key
  available for note-off. The existing portamento flag still starts its own
  sliding attack.
- `tests/note-expression.test.ts` covers clamping, Yjs round-trip,
  undo/redo and default-value no-op.
- `tests/per-note-filter-modulation.test.ts` checks that neutral Mod X/Y keeps
  the baseline filter graph unchanged and that direct cutoff/resonance plus
  both Mod lanes reach a voice-local filter on all 16 declared instruments.
  Direct values take precedence over Mod X/Y. It also checks neutral and
  changed release-envelope time constants on all 19 declared instruments.
  This is graph evidence for the declared set, not sample-level parity for
  every instrument.
- Chromium `OfflineAudioContext` sweeps on Acid 303 and Keys preserve neutral
  Mod X/Y within 15% RMS, move RMS by >1.5× for cutoff and Mod X and >1.2×
  for Mod Y, and change the note-off tail by >1.5× between release velocities
  0 and 1. Probe ratios were Acid 5.2×/3.0×/13.7×/211× and Keys
  114×/96.9×/61×/2.9× (cutoff/Mod X/Mod Y/release). The sweep schedules
  real noteOn and noteOff events, rather than reading graph parameters alone.
- Chromium `OfflineAudioContext` now sweeps every built-in fine-pitch route and
  every declared filter, release, pan, and held-voice slide route through
  isolated channel renders. The check passes 79/79:
  neutral Mod X/Y has exactly zero sample delta on all 16 filter instruments,
  changed cutoff and both modulation lanes alter rendered audio on all 16,
  release velocity changes the note-off tail on all 19 release instruments,
  and pan preserves the centered baseline while rendering isolated hard-left/
  right notes plus overlapping opposite-pan notes on all 18 declared
  instruments; held-voice slide audio moves the fundamental on 808 and Acid
  without a new attack. A 12-semitone fine-pitch event enters through the real
  TriggerEngine and changes stereo RMS by more than 0.5% of the baseline on
  all 24 built-in instrument runtimes.
  The sweep exposed and fixed release paths that were being overridden by a
  fixed 808/Clav note-off ramp, a fixed Spectral partial ramp, and Texture's
  short source stop plus additive tremolo bypassing the envelope. A follow-up
  audit found the scheduler supplied note expression, but the `services.ts`
  callback dropped the final argument before `AudioEngine.noteOn`; the callback
  now forwards it, with scheduler-entry and service-wiring specs including the
  no-expression case. The focused command is
  `npm run test:browser:note-expression`; `npm run
test:browser:note-expression:all` runs it in Chromium, Firefox and WebKit.
  On 2026-10-17 Chromium and Firefox each passed 80/80: the 79 OfflineAudioContext
  render checks plus one live/offline aggregate covering four cases (combined
  Analog pitch/pan/filter/release, Analog Mod X/Y, and held slides on 808 and
  Acid). The parity gate requires alignment within 512 samples and a null at or
  below -40 dB, or correlation ≥0.99 when the realtime path is nondeterministic.
  Playwright's Windows WebKit build exposes none of `AudioContext`,
  `OfflineAudioContext` or `AudioWorkletNode`; the all-engine command reports
  that browser as blocked and exits nonzero. This is not Safari evidence.
- `tests/per-note-pan.test.ts` now routes overlapping notes independently on
  Texture Synth and Vocal Chop as well as the 16 previously supported voice
  instruments; neutral Texture pan keeps its existing voice panner centered,
  while Vocal Chop only inserts a panner for non-neutral events.
- Chromium OfflineAudioContext checks render hard-left, hard-right, centered,
  and simultaneous opposing-pan notes for all 18 declared pan-capable
  instruments. They require the centered render to match the authored
  baseline within 5% RMS, each hard-pan render to suppress the opposite
  channel by at least 40 dB, and both simultaneous voices to remain audible
  in their selected channels. The Texture measurement ends before its fixed
  420 ms centered delay return. Pluck preserves its neutral stereo width while
  mapping pan endpoints to true hard-left/right.
- Chromium OfflineAudioContext verifies held-voice slide-note fundamentals
  move from source to target on 808 (55→110 Hz) and Acid 303 (110→220 Hz).
  Graph tests separately verify that those events add no voice/oscillator and
  are ignored when no matching held voice exists. Other runtimes' legacy
  portamento paths do not yet imply FL-style no-retrigger slide-note support.
- The browser verifier now selects Chromium, Firefox, WebKit, or all three.
  Chromium and Firefox pass the same 79 rendered-audio expression checks and
  four representative real-time/offline parity cases. The Playwright WebKit
  build available on this Windows host has no Web Audio API, so Safari remains
  an open verification target. The parity set is representative, not a
  full-registry live/offline proof.
- `tests/ui/piano-roll-event-editor.test.tsx` enters the real selector and
  pointer handlers against a real `ProjectStore`, including no-move and
  `pointercancel` negatives; it also edits Mod X from the lane and verifies
  undo restores the centered default.

## Acceptance gates for further coverage

- Extend voice-specific pan to remaining instrument runtimes, and extend
  direct cutoff/resonance, release velocity and held-voice slide only after
  mapping them to each runtime's actual voice controls. The current slide-note
  slice covers 808 and mono Acid 303; other suitable instruments remain open.
- Add audio assertions for each target family; parameter storage alone does
  not prove an audible result. Chromium OfflineAudioContext measures Acid
  slide-note energy at the source and target fundamentals before and after the
  bend, and now sweeps cutoff/Mod X/Mod Y on all 16 declared filter instruments
  plus release velocity on all 19 declared release instruments. Prove those
  same paths through live playback and offline rendering, and repeat the audio
  sweeps in Firefox and Safari.
- Prove live and offline render parity for pitch and each implemented target.
- Add independent overlapping slide-note and portamento semantics with
  deterministic voice selection for each supported instrument. The 808 and
  mono Acid 303 ignore a slide note without an overlapping held voice; FL-style
  note-color groups and chord reference selection remain unimplemented.
- Define MPE behavior for external MIDI and MIDI-file round-trip before
  claiming per-note expression interchange.
