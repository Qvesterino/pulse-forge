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
- A 90-bar project survives JSON save/reopen and Yjs round-trip, plays and
  exports through the same end tick, and filtered stems include only their
  selected instrument lanes.
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
