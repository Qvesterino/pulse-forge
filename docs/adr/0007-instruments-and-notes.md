# ADR 0007 — Instruments and piano-roll notes

Date: 2026-08-15
Status: Accepted

Instrument tracks (`kind: "instrument"`) carry an instrument kind, a parameter map and (for the sampler) a sample reference. Notes live in the pattern as `NoteEvent[]` keyed by track id — pitch (MIDI), start/duration (ticks), velocity — so one pattern holds drums and melodic content together, matching the future scene model.

Instrument runtimes follow the effect runtime pattern: a registry maps kind → definition (param metadata + factory), the engine diffs serializable state and applies parameter changes to live voices where meaningful (filter cutoff/resonance), and reconstructs runtimes from project data. All four first instruments (Sampler, Analog, Bass, 808) are pure Web Audio voices with bounded polyphony and deterministic oldest-voice stealing.

The scheduler was generalized from a step-grid loop to a lookahead event window in tick space: each pass schedules drum step boundaries and note starts inside `[windowStart, windowEnd)`. This decouples musical events from the 16th grid and opens the path to microtiming, swing and ratchets without a scheduler rewrite.

Consequence: piano-roll editing is pure project-data manipulation (commands + undo/redo); the editor never touches audio runtimes.

## Note length and one-shot articulation

`NoteEvent.duration` is the musical hold time delivered to instrument runtimes. Sustaining instruments shape their voice and release around that duration. Percussive one-shots may preserve their natural decay; when a one-shot instrument can also behave as a held voice, expose an explicit one-shot/gated mode and a separate release control rather than silently changing existing presets. Drum-pad sample length locks trim or extend the selected source region within its available audio; arrangement audio-clip fades remain a separate editing operation.

Drum-pad step locks may override fade-in and fade-out as percentages of the resulting slice duration. Both overrides are fitted together with any inherited pad fade so their envelope cannot exceed the playable slice. Missing step locks leave the pad's own fade settings in effect. Project schema v32 accepts these optional fields; older projects need no data rewrite.
