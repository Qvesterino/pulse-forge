# ADR 0047 — Sparse MIDI phrase horizon

- **Date:** 2026-10-15
- **Status:** accepted
- **Scope:** note storage, Piano Roll, MIDI clips, live scheduling and export

## Context

KYX keeps the drum step grid deliberately bounded at 128 sixteenth-note steps
(8 bars). Melodic notes are already stored as sparse tick-based events, but
normalization, the Piano Roll and the scheduler treated that grid end as the
end of every note phrase. This made it impossible to keep an 808 note alive
across the grid boundary without growing every step array or retriggering the
phrase beneath the sustain.

Image-Line's public manuals provide a behavioral reference: the Channel Rack
Step Sequencer has a finite 512-step grid, Piano Roll notes can be resized and
can extend beyond that grid, and Playlist clips arrange material across a
song. KYX adopts those workflow distinctions without copying FL Studio
source code or assets.

## Decision

1. Bump the project schema to v28. `NoteEvent` remains a sparse list; its
   `start` and `duration` can extend beyond `Pattern.stepCount`, subject to
   the existing 8192-bar musical-time safety ceiling. The step arrays stay
   capped at 128 steps.
2. An instrument track's MIDI phrase period is the later of its bounded grid
   length and its last note end rounded up to the next bar. This keeps loop
   boundaries musical and prevents short grid cycles from re-attacking a note
   while it sustains. Drum rows keep their current step-grid loop semantics.
3. The Piano Roll displays the sparse phrase horizon in a horizontally
   scrollable, windowed grid. Its note-length control can place notes from
   1/16 through 64 bars; dragging a note edge continues to resize it. Neither
   operation allocates a longer step array.
4. When add, move or resize extends a note phrase, every MIDI clip using that
   same track/pattern source grows to the phrase length within the arrangement
   safety ceiling in the same undoable command. A shared-source edit remains
   shared; users can use **Make unique & edit** to isolate one clip first.
5. MIDI import and live MIDI recording preserve long note durations within
   the same time ceiling. The existing shared event planner drives live and
   offline playback; a MIDI clip still cuts any tail at its own end.
6. Schema migration keeps old note data unchanged and normalizes it under the
   wider bound. No new persisted fields are introduced.

## Verification gates

- A 12-bar note survives normalization, pattern-grid changes, JSON/Yjs
  round-trips and MIDI import/export.
- The event planner emits one sustained note across the old grid boundary and
  starts a new phrase only at the aligned phrase boundary.
- Piano Roll can place a 12-bar note directly, resize it, scroll to its end,
  and undo the edit; step arrays remain at or below 128 entries.
- Extending a note grows referencing MIDI clips as one undoable document edit.
- A 90-bar arrangement survives save/reopen, live playback and offline export
  to the same musical end. UI work remains bounded to the visible timeline.

The first three gates have targeted unit coverage. The 90-bar persistence,
live playback and offline-export acceptance pass remains open.

## References

- [FL Studio Channel Rack / Step Sequencer manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm)
- [FL Studio Piano roll manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- [FL Studio Playlist manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)
- `docs/adr/0043-patterns-and-full-song-workflow.md`
- `docs/adr/0044-midi-clips-on-instrument-lanes.md`
