# ADR 0044 — MIDI clips on instrument lanes

- **Date:** 2026-10-14
- **Status:** accepted
- **Scope:** project schema, arrangement, MIDI scheduling, editing and export

## Context

KYX patterns already store sparse, tick-based `NoteEvent`s per instrument
track. In Song mode an `ArrangementClip` selects a whole scene, and therefore
plays every instrument represented by that scene's pattern. The arrangement
has no way to place only one instrument's phrase on its own lane. Extending
the pattern step array would conflate phrase length with song length and
violate its tested defensive size bound.

FL Studio's Channel Rack/Piano roll and Playlist are behavioral references:
notes belong to channels, while the Playlist places pattern clips over a
longer song. This ADR implements that separation using KYX's existing project
model and runtime. It does not copy FL source code or assets.

## Decision

1. Bump the project schema from v25 to v26. Add optional
   `Arrangement.midiClips`; absence in old documents means an empty list.
2. A `MidiClip` has `id`, `trackId`, `patternId`, integer `startTick` and
   `lengthTicks`, and optional `phaseOffsetTicks`, `muted`, and `locked`.
   `trackId` must resolve to an instrument track; `patternId` must resolve to
   a pattern. Geometry is in musical ticks (PPQ 480), bounded to the existing
   8192-bar arrangement safety limit.
3. A clip plays only the note list `pattern.notes[trackId]`. Notes remain
   pattern-relative and sparse; clip length determines the visible/playable
   window. Note ends are cut at the clip end. ADR 0047 refines the per-track
   phrase repeat period when a note extends beyond the bounded step grid.
   This permits multi-minute lanes without unbounded pattern arrays and reuses
   the existing Piano Roll.
4. Pattern clips use shared-source semantics: moving, trimming, resizing or
   duplicating a clip never changes note content. Duplicates reference the
   same pattern/track pair. A dedicated “Make unique” command clones the
   source pattern with fresh note ids and repoints only that clip before
   clip-scoped editing.
   Double-clicking a MIDI clip selects its instrument and source pattern,
   seeks the transport to the clip's arrangement start, and opens the Piano
   Roll at the clip's pattern-relative `phaseOffsetTicks`. Shared placements
   are labeled in the lane and editor; “Make unique & edit” isolates the
   placement before opening it.
5. Scene clips and MIDI clips are additive. A MIDI clip can intentionally
   play over a scene clip; users can mute either clip or remove the scene
   instance when they want only the per-instrument arrangement. MIDI clips on
   the same lane may overlap; every active clip contributes its events.
6. MIDI clips follow the arrangement's tempo map. Live playback, offline
   rendering, stem filtering, MIDI export, save/reopen and collaboration all
   read the same clip entities. The realtime scheduler remains the only live
   event driver; offline rendering continues to use the shared `AudioEngine`.
7. All mutations use undoable commands. Move/resize/split preserve source
   phase; deleting a track or pattern removes dependent MIDI clips inside the
   same undo delta. Locking is enforced at command boundaries. Yjs mirrors
   clips as id-addressed plain-JSON entities so concurrent edits to different
   clips do not overwrite each other.
8. Existing `ArrangementClip` and `AudioClip` storage and semantics remain
   unchanged. MIDI clips become a third timeline kind through the existing
   `timelineItemsOf` read projection; no broad physical merge is attempted.

## Verification gates

- v25 project fixtures migrate without content changes; v26 normalization is
  defensive and idempotent, including malformed references and out-of-range
  tick geometry.
- Command tests cover clip creation, shared-source duplication, unique-copy,
  move, resize, split phase continuity, mute, lock, delete, undo and redo.
- Live and offline note event windows agree at clip boundaries, pattern-loop
  boundaries, tempo changes and note ends; no event escapes a muted or trimmed
  MIDI clip.
- A 93-bar project with a 12-bar 808 note survives IndexedDB save/reopen and
  offline WAV export through the final bar in Chromium (180 seconds at 124 BPM;
  `tests/e2e/13-audio-consolidation.spec.ts`). `tests/scheduler.test.ts` also
  advances the live scheduler's controlled audio clock across all 93 bars and
  checks the 12-bar sustain and final-bar clip. An opt-in Chromium soak in the
  same E2E file runs the MIDI-only project through a real AudioContext for the
  full 180-second song, confirms the late 808 source events, and verifies that
  muting prevents a future event, moving changes its start, resizing extends
  the note gate by one bar, and trimming prevents a cut-off note from starting
  inside the shortened clip. A separate test round-trips the 93-bar MIDI
  arrangement and 12-bar note through the YDoc adapter; a stem test verifies
  that the filtered 808 project schedules only its selected instrument's
  events. Firefox live-audio parity, multi-peer Yjs collaboration and rendered
  stem-audio parity remain open gates. The same move/resize/trim and
  double-click-to-Piano-Roll UI gestures pass in Chromium and Firefox; full
  live-audio playback is still Chromium-only.
  An
  opt-in 300-clip Chromium benchmark checks bounded rendering and end-of-song
  scroll response; its machine-specific timings are recorded in ADR 0047.
- The arrangement virtualizes lane content to the viewport; note and clip
  counts do not create work proportional to the whole song on every frame.

## Consequences

- A project may contain scene clips and per-instrument MIDI clips at once; UI
  must make their additive playback clear and offer a fast way to remove or
  mute either source.
- The Piano Roll continues to edit a source pattern, not an embedded clip
  payload. Clip-scoped editing must explicitly make the source unique before
  changing notes when the pattern is shared elsewhere.
- FL behavioral parity is the target for composition workflow, not binary or
  source-level compatibility.

## References

- [FL Studio Channel Rack and Step Sequencer manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm)
- [FL Studio composing workflow](https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/basics_workflow.htm)
- `docs/adr/0002-audio-clock-scheduling.md`
- `docs/adr/0003-project-model-runtime-separation.md`
- `docs/adr/0009-offline-render-export.md`
- `docs/adr/0025-unified-timeline-surface.md`
- `docs/adr/0043-patterns-and-full-song-workflow.md`
- [FL Studio Piano roll manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- [FL Studio Playlist manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)
