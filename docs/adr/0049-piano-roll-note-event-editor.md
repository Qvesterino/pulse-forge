# ADR 0049 — Piano Roll per-note Event Editor

- **Date:** 2026-10-17
- **Status:** accepted; a fresh 2026-10-19 live/offline matrix passed in Chromium, Firefox and Edge. Safari remains unverified, and FL-style note-color groups and full MPE/MIDI-file expression interchange are not implemented.
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
   voice-specific pan on 22 built-in voice instruments, including per-hit
   Drum Synth routing and full-voice Spectral routing, and centered Mod X/Y
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
   the source key. FL-style note-color groups remain a separate feature: KYX
   does not store note colors, route colors to MIDI channels, or scope slide
   events to matching color groups.
6. Standard MIDI 1.0 channel-wide controllers cannot represent arbitrary
   independent per-note expression for overlapping notes. Export or external
   MIDI support must use an explicit MPE/channel policy rather than silently
   dropping pitch or mapping per-note pan to a track-wide controller.

## FL Studio compatibility boundary

This ADR uses Image-Line's Piano Roll and Channel Settings manuals as behavior
references, not as a claim of bit-for-bit compatibility. FL Studio offers 16
note-color groups. A color selects a MIDI channel for hosted wrapper plugins,
and slide notes affect notes in the same color group; Mono mode also works per
color group. External MIDI hardware uses a MIDI Out channel instead. KYX has no
persisted note-color group or per-color MIDI routing. Its held `slideNote`
currently bends one matching monophonic voice in 808 or Acid 303, so it does
not reproduce FL Studio's simultaneous color-group slide behavior. Ordinary
note color selection and color-scoped editing are also not implemented.

KYX's stored `NoteEvent.expression` values are internal project data consumed
by declared built-in instrument runtimes and shared by live and offline audio.
They are not currently a lossless MIDI-file interchange format. MPE carries
per-note expression by assigning notes to member channels in a configured
zone. KYX's Web MIDI receiver currently accepts poly pressure, CC74 timbre and
pitch bend, but does not parse MPE zone configuration, keep expression state
keyed by member channel, or apply pitch bend per note. Poly pressure is keyed
by pitch, CC74 is associated with the last note seen on that channel, and all
three inputs route to the first instrument track; pitch bend is track-wide.
The current MIDI-file importer skips CC, pitch bend, program-change and
aftertouch messages. Therefore its live input indicator is an activity display
for a subset of MPE-related messages, not proof that a controller negotiated a
complete MPE connection. These limits must remain visible until channel-zone
handling and MIDI round-trip behavior are specified and tested.

### Supported targets and explicit boundaries

| Target or workflow               | Current scope                                                           | Evidence and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Velocity and fine pitch          | Piano Roll event targets on all 25 registered built-in instrument kinds | Isolated live/offline case per target and instrument; the offline audio sweep separately proves audible response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Per-note pan                     | 22 declared instrument kinds                                            | Isolated live/offline case per instrument; TSAR and KOPA do not declare voice-level pan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cutoff and resonance             | 16 declared instrument kinds                                            | Separate direct cutoff, direct resonance, Mod X, and Mod Y cases for each capable runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Release velocity                 | 19 declared instrument kinds                                            | Isolated live/offline case per instrument; absence keeps the instrument's ordinary release behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Held slide note                  | 808 and Acid 303 only                                                   | One held-voice slide case per runtime; no new attack, and no color-group matching. Legacy `slide` remains portamento.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Note-color groups                | Not implemented                                                         | `NoteEvent` has no persisted color/group identity, and KYX does not provide FL-style color-scoped mono/slide behavior or per-color MIDI channel routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Live MIDI poly pressure          | Partial input only                                                      | Current runtime routes by pitch to the first instrument track; member channel is not preserved in expression state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Live MIDI CC74 timbre            | Partial input only                                                      | Routed to the first instrument track for the most recent note on that MIDI channel; no MPE-zone negotiation or per-note channel identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Live MIDI pitch bend             | Track-wide input only                                                   | The channel is ignored and bend is applied to the first instrument track; this is not per-note MPE pitch bend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MIDI-file expression interchange | Partial: release velocity plus selected song-transfer controllers       | Explicit MIDI note-off velocity imports into `NoteEvent.expression.releaseVelocity` and exports from pattern/song MIDI. In **BRING A SONG**, CC7/10/11 become track-volume/pan automation and CC64 sustain is baked into note lengths; these controller conversions do not yet round-trip as CC events in MIDI export. Velocity-zero note-ons remain ordinary note-offs without an explicit release value. Other CC, pitch bend, program change, aftertouch, SysEx and time-varying per-note expression are not imported; internal `NoteEvent.expression` is not generally promised to round-trip through Standard MIDI files. |

The live MPE activity badge means only that poly pressure or CC74 input was
observed. It does not assert MPE zone configuration, channel/member tracking,
per-note pitch bend, or MIDI-file interchange. The MIDI boundary test locks the
current pitch-keyed state and first-instrument routing so this partial behavior
cannot be mistaken for full MPE support.

References:

- [FL Studio Piano Roll: Color Groups, Slides and MIDI](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- [FL Studio Channel Settings: Mono and Portamento](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/chansettings_misc.htm)
- [The MIDI Association: MPE profiles and member channels](https://midi.org/6-new-profile-specifications-adopted)

## Current evidence

- `NoteExpression` and held-voice slide-note articulation are normalized as
  project schema v35, including centered Mod X/Y values.
- `setNotesExpression` creates one undoable command and returns an identity
  command when a gesture produces no value change.
- Piano Roll exposes velocity/fine pitch for every instrument, pan for the 22
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
- The live wavetable and granular AudioWorklet bridges previously dropped
  `releaseVelocity` while forwarding note-on events. Both bridges now send the
  normalized value with each sample-timed note-on; each worklet stores it on
  that voice and derives the release time constant at the matching note-off.
  Raw processor audio specs prove that neutral 0.5 is sample-identical to the
  default, release values 0 and 1 leave pre-note-off audio unchanged and change
  the post-note-off tail by more than 1.5×. Live and offline now use the same
  final-output graph and worklet processor for both instruments. The 2026-10-18
  Chromium audit measured pre-note-off ratios of 1.00×/1.00× and live/offline
  release-response ratios of 3.37×/3.37× for wavetable and 2.37×/2.37× for
  granular. Chromium and Firefox each passed the 85/85 top-level audit. This
  verifies response parity for these release paths; it is not a full-registry
  waveform parity result.
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
  isolated channel renders. The 2026-10-18 browser audit passed 85/85
  top-level checks:
  neutral Mod X/Y has exactly zero sample delta on all 16 filter instruments,
  changed cutoff and both modulation lanes alter rendered audio on all 16,
  release velocity changes the note-off tail on all 19 release instruments,
  and pan preserves the centered baseline while rendering isolated hard-left/
  right notes plus overlapping opposite-pan notes on all 22 declared
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
test:browser:note-expression:all` runs the supported Chromium, Firefox and Edge
  targets. WebKit remains an explicit diagnostic target because this Windows
  build does not expose Web Audio.
  The 2026-10-18 full verifier run passed 85/85 top-level checks in Chromium
  and Firefox. That run covered the 24-instrument Chromium OfflineAudioContext
  sweep, ten selected live/offline parity cases, and the Wavetable/Granular
  release-response audit; it did not yet exercise the full registry-derived
  parity matrix. The registry-derived live/offline parity matrix now changes
  one target at a time. A fresh run on 2026-10-19 using
  `npm run test:browser:note-expression:all -- --parity-only` passed all 157
  cases in Chromium, Firefox and Edge, with one full-matrix checker per
  browser. Earlier Edge evidence also passed across four bounded instrument
  batches (41 + 47 + 48 + 21):
  velocity and fine pitch on all 25 registered instruments; pan on all 22
  declaring it; release velocity on all 19; direct cutoff and resonance plus
  Mod X and Mod Y on each of the 16 filter runtimes; and held slide notes on
  808 and Acid. Every target/instrument pair has an independent live-to-offline
  comparison with deterministic offline controls and the declared spectral and
  RMS bounds. Exact target-level membership is locked by
  `tests/parity-obligation.test.ts`. Playwright's Windows WebKit build exposes
  none of `AudioContext`, `OfflineAudioContext` or `AudioWorkletNode`; Safari
  remains unverified.
- Pluck's recursive delay feedback now runs in
  `src/audio-worklets/karplus-strong-processor.js` whenever the core worklets
  are ready; the existing native graph remains a startup fallback. The
  sample-clocked loop makes fractional-pitch feedback bit-identical across
  both live captures and the offline render. The browser parity harness also
  detaches its sample bank and disposes each temporary `AudioEngine` in a
  `finally` block before closing the context, including when a render fails.
- `tests/per-note-pan.test.ts` now routes overlapping notes independently on
  Texture Synth and Vocal Chop as well as the 16 previously supported voice
  instruments, Drum Synth and Spectral Pad. Drum Synth inserts a voice-local
  panner only for a non-neutral note pan; its default event path remains
  direct. Spectral Pad pans the complete voice, including the optional rotary
  wet path, and leaves its centered graph unchanged. The graph spec covers
  independent overlapping pan values and asserts that an expression-free
  Drum Synth note allocates no panner.
- Chromium OfflineAudioContext checks render hard-left, hard-right, centered,
  and simultaneous opposing-pan notes for all 22 declared pan-capable
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
- The browser verifier selects Chromium, Firefox, Edge, WebKit, or all three
  supported browser targets. Its
  157-case parity matrix is derived from the 25-instrument registry and
  capability map, with every target tested separately and exact membership
  locked by `tests/parity-obligation.test.ts`. Windows Playwright WebKit has no
  Web Audio API, so Safari remains an open verification target.
- `tests/ui/piano-roll-event-editor.test.tsx` enters the real selector and
  pointer handlers against a real `ProjectStore`, including no-move and
  `pointercancel` negatives; it also edits Mod X from the lane and verifies
  undo restores the centered default.

## Remaining scope and regression gates

- The registry-derived matrix covers 157 target/instrument cases: velocity and
  fine pitch on all 25 built-in instruments; pan on all 22 declaring it; release
  velocity on all 19 declaring it; cutoff, resonance, Mod X and Mod Y on all 16
  filter runtimes; and held slide notes on 808 and mono Acid 303. A fresh
  2026-10-19 run passed all 157 cases in Chromium, Firefox and Edge.
  `tests/parity-obligation.test.ts` locks exact target
  membership. Rerun the matrix in Chromium, Firefox and Edge whenever an
  instrument or expression target changes.
- Safari remains unverified. The Windows Playwright WebKit runtime exposes none
  of `AudioContext`, `OfflineAudioContext` or `AudioWorkletNode`, so it cannot
  execute this audio parity matrix. Do not describe this as Safari parity.
- TSAR and KOPA do not declare per-note pan. Other instruments do not gain a
  target until their runtime has a corresponding voice control and an audible
  live/offline assertion.
- Held slide-note evidence covers only 808 and mono Acid 303. Independent
  overlapping slide-note and portamento voice selection remain open. A slide
  without a matching held voice follows the documented ordinary-note behavior.
- FL-style note-color groups and chord reference selection remain
  unimplemented. Live MIDI poly pressure and CC74 are partial and pitch-keyed;
  pitch bend remains track-wide on the first instrument. MPE zone/member-channel
  handling and MIDI-file expression import/export are not implemented. Keep
  these boundaries explicit until their data model, routing and round-trip
  behavior have dedicated acceptance tests.
