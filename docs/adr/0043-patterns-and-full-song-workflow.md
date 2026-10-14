# ADR 0043 — Pattern and full-song composition workflows

- **Date:** 2026-10-14
- **Status:** accepted — product direction
- **Scope:** composition UX, arrangement workflow, future MIDI clip model

## Context

The studio currently opens on a pattern editor. Its ruler counts beats and its
default 16 steps are one bar of sixteenth notes. Melodic notes are edited in a
piano roll attached to the active pattern. A separate Song mode plays the
arrangement, where scene clips select patterns and can span many bars. The
project, scheduler and offline renderer already support long arrangements, but
the distinction is easy to miss and the default pattern view looks like the
whole composition surface.

At the same time, a full-song, per-instrument MIDI timeline is not the same
thing as a longer step grid. Pattern data is bounded for safe editing and
normalization; the current project-model ceiling is 128 steps (8 bars). The
Pattern Bar currently offers a 256-step option even though the command and
normalizer clamp it to 128. Auto Arrange currently lays out 36 bars, which is
about 70 seconds at 124 BPM. Those are real workflow gaps for a user expecting
to make a conventional three-minute track.

## Decision

1. KYX supports **both** composition scales as first-class workflows:
   - **Pattern workflow:** edit reusable drum and instrument phrases with the
     step grid and piano roll, then reuse them.
   - **Song workflow:** arrange a complete song on a timeline, with explicit
     sections and playback/export through the complete duration.
2. The 16-step default remains a one-bar starting point, not a song-length
   limit. Do not grow step arrays to represent a whole song. Keep their
   defensive ceiling at 128 steps (8 bars) until a separate measured review
   establishes a safe alternative. Long-form playback uses arrangement time.
3. **First implementation stage:** make the existing pattern → scene → song
   path obvious and dependable. Song creation must support a user-selected
   target duration, including about three minutes. At 120 BPM in 4/4 that is
   90 bars; at 124 BPM it is 93 bars. Auto Arrange's current 36-bar form is a
   starting skeleton, not a three-minute result. The UI must make the full
   duration visible, editable and exportable.
4. **Second implementation stage:** add independent, editable MIDI clips on
   instrument-track lanes across the song timeline. Preserve scene clips for
   section/pattern workflows so existing projects and live scene launching
   continue to work. MIDI clips use sparse musical events and tick-based
   duration, not one large step array. Their live playback and offline export
   lower through the same scheduler/renderer contract.
5. **Third implementation stage:** add independent automation clips on the
   song timeline. Automation clips own a target, curve, duration and source
   phase; they are separate from pattern-relative MOD lanes and scene lanes.
   In Song mode, an arrangement clip takes precedence over the same target's
   MOD lane; Pattern mode continues to use the MOD lane.
6. Stage 2's persisted shape, source/duplicate semantics, undo, clip editing,
   migration, collaboration encoding and playback contract are specified in
   [ADR 0044](./0044-midi-clips-on-instrument-lanes.md). Every edit remains
   command-based and undoable.
7. Stage 3's curve, clip-editing and scheduling contract is specified in
   [ADR 0045](./0045-arrangement-automation-clips.md).
8. Use FL Studio as a behavioral reference for the separation between patterns,
   note editing and the song Playlist, including note-end resizing and arranging
   clips. Implement KYX's own model, UI and assets; no FL source code or assets
   are copied.

## Research findings and current parity

| Workflow                           | FL Studio reference behavior                                                                                                         | KYX today                                                                                                                                       | Gap / direction                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Short rhythm editing               | The Channel Rack Step Sequencer edits pattern steps; FL documents a 512-step ceiling.                                                | The default 16 steps are one 4/4 bar; KYX safely caps a pattern at 128 steps (8 bars).                                                          | Keep the bounded pattern editor. Full-song duration belongs on the arrangement timeline, not in an unbounded step array.                |
| Melodic phrase and 808 note length | The Piano roll edits notes independently by channel; note ends can be dragged and note lengths follow snap.                          | KYX Piano Roll supports dragging the note's right edge to resize; note duration is bounded by the pattern end, up to 8 bars.                    | Make the Piano Roll discoverable from the selected instrument and keep sustained notes editable across the phrase.                      |
| Full-song timeline                 | The Playlist lays out pattern, audio and automation clips against a bar ruler with snap and zoom; clips can be moved and duplicated. | KYX supports scene, audio, MIDI and automation clips on a song timeline, with multi-minute Auto Arrange, live song playback and offline export. | Long-song save/playback/export still needs the explicit 90+ bar acceptance pass.                                                        |
| Arrangement clip editing           | Playlist grouping moves and edits selected clips as a unit; copy/paste and snap work on timeline content.                            | KYX copy/cut/paste includes all four clip kinds; arrow nudges and drag gestures move cross-lane groups with a shared preview and one undo step. | Scene-lane collisions or locked members can block the complete group; continue the long-song acceptance pass and refine group feedback. |
| Automation in the arrangement      | Automation Clips have editable curves and can link to one or more parameters; overlapping clips can be focused and edited.           | KYX v27 has single-target clips with point editing, mute, lock, shared clipboard, and deterministic latest-start overlap priority.              | Add multi-target links and an explicit focus affordance for choosing the overlap winner.                                                |
| Pattern vs song playback           | FL exposes Pattern Mode for auditioning the active pattern and Song Mode for Playlist playback.                                      | KYX has `pattern` and `song` transport modes; song rendering follows the arrangement extent.                                                    | Expose the relationship in the editor and verify the same end point for live playback and offline export.                               |

These findings use Image-Line's official [Channel Rack / Step Sequencer](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm), [Piano roll](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm), [Playlist](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm), [Automation Clips](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist_automationclip.htm), and [composition workflow](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_workflow.htm) documentation as behavioral references. The Playlist manual describes multi-clip group operations; the Automation Clips manual covers curve editing and focus behavior. These are workflow observations, not a claim that KYX currently has full FL Studio feature parity.

## Acceptance gates

### Stage 1 — pattern to complete song

- A new user can distinguish the one-bar drum grid, piano-roll note duration,
  pattern length and full-song duration without relying on hidden gestures.
- A project can be built to a target of at least 180 seconds, including
  sections, repeated material and a sustained 808 note.
- Save/reopen preserves clip placement, note lengths, song end and tempo map.
- Song-mode playback and offline export reach the same arrangement end; no
  material is truncated at the active pattern boundary. The output duration is
  within one bar of the requested duration, with FX tail handled separately.

### Stage 2 — per-track MIDI timeline

- MIDI clips can be created, moved, resized, split, duplicated and deleted on
  the intended instrument lane, with snap, selection and undo/redo behavior.
- Notes can be edited across multiple bars without increasing the bounded
  pattern-step arrays.
- Existing scene clips, scene launching, recording audio clips, collaboration,
  save/reopen, live playback and offline export keep their established
  semantics.
- A long-form fixture exercises at least 90 bars through normalization,
  persistence, scheduling and export, with bounded UI work at the viewport.

## Consequences

- “16 steps” must never be presented as the maximum song length.
- The current 256-step Pattern Bar choice is removed or changed until the model
  ceiling changes through an explicit, measured decision.
- Stage 1 can use the current project schema. Stage 2 requires a schema bump
  and migration only after its follow-up ADR is accepted.
- Product copy may describe multi-minute creation only after the corresponding
  save/reopen, playback and export gates pass.

## References

- `docs/adr/0003-project-model-runtime-separation.md`
- `docs/adr/0009-offline-render-export.md`
- `docs/adr/0025-unified-timeline-surface.md`
- `docs/ROADMAP-FULL-DAW.md`
- [FL Studio Piano roll manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- [FL Studio Playlist manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)
- [FL Studio Channel Rack / Step Sequencer manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm)
