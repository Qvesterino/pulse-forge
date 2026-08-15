# ADR 0007 — Instruments and piano-roll notes

Date: 2026-08-15
Status: Accepted

Instrument tracks (`kind: "instrument"`) carry an instrument kind, a parameter map and (for the sampler) a sample reference. Notes live in the pattern as `NoteEvent[]` keyed by track id — pitch (MIDI), start/duration (ticks), velocity — so one pattern holds drums and melodic content together, matching the future scene model.

Instrument runtimes follow the effect runtime pattern: a registry maps kind → definition (param metadata + factory), the engine diffs serializable state and applies parameter changes to live voices where meaningful (filter cutoff/resonance), and reconstructs runtimes from project data. All four first instruments (Sampler, Analog, Bass, 808) are pure Web Audio voices with bounded polyphony and deterministic oldest-voice stealing.

The scheduler was generalized from a step-grid loop to a lookahead event window in tick space: each pass schedules drum step boundaries and note starts inside `[windowStart, windowEnd)`. This decouples musical events from the 16th grid and opens the path to microtiming, swing and ratchets without a scheduler rewrite.

Consequence: piano-roll editing is pure project-data manipulation (commands + undo/redo); the editor never touches audio runtimes.
