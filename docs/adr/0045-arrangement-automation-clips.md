# ADR 0045 — automation clips on the arrangement timeline

- **Date:** 2026-10-14
- **Status:** accepted
- **Scope:** project schema, arrangement editing, live scheduling, offline rendering and collaboration

## Context

KYX already has pattern-relative MOD automation lanes and scene-relative
automation. Neither is a standalone song-timeline object. A producer could not
place a volume/filter sweep over a chosen section, extend it independently, or
keep it aligned while moving the song arrangement.

Image-Line's Playlist and Automation Clips manuals are behavioral references:
automation is timeline content, the curve belongs to the clip, and clips can
be moved and resized independently. KYX implements its own schema, UI and
runtime; it does not copy FL Studio code or assets.

## Decision

1. Bump the project schema from v26 to v27. Add optional
   `Arrangement.automationClips`; absence in older projects means no clips.
2. A clip stores a primary target, optional linked targets, absolute tick
   start, visible tick length, sorted curve points in the primary target's
   units, and optional source phase, mute and lock flags. Linked targets map
   the curve linearly through normalized 0..1 space between each target's
   legal parameter range; discrete targets round to the nearest legal step.
   The existing 8192-bar geometry ceiling applies;
   malformed targets, points and flags are normalized on load.
3. MOD's “ARR” action copies the selected lane to the arrangement at the
   playhead, using the active pattern length as its initial duration. The
   arrangement lane can also place clips from its target row. Double-clicking
   a clip adds a target-clamped curve point; dragging a point edits it and
   right-clicking removes it. Move, trim, resize, duplicate, mute, lock and
   delete are undoable commands.
4. A left trim advances `phaseOffsetTicks`; the source curve remains intact.
   Resize, move and duplicate preserve that phase. This keeps the same curve
   shape when editing its visible boundary.
5. Pattern mode keeps its existing MOD automation behavior. In Song mode, if
   any arrangement automation clip targets a parameter, that target's
   pattern-relative MOD lane is suppressed for the song pass. Arrangement
   automation then owns the target. This explicit precedence avoids two
   independent writers racing the same parameter.
6. When arrangement clips for the same target overlap, the clip with the
   latest start tick wins for the overlap. If clips share a start tick, the
   lexicographically smaller clip id wins. Earlier clips resume after the
   winning clip ends. Live scheduling and offline rendering use the same
   resolved segments and target/value curve semantics through the arrangement
   tempo map. Automation clips extend song end
   for transport looping and export. Stem rendering filters clips by target
   track. Stop/reset includes targets referenced only by arrangement clips.
7. Yjs stores clips as id-addressed entities with separately synchronized
   targets, linked targets and curve points. Deleting a target track, return
   or effect removes clips whose primary target was deleted and strips only
   the removed destination from surviving linked clips, with linked markers
   and clip-group references handled by the same undoable command.

## Consequences and follow-up

- A single curve can drive multiple parameters. Its points stay in the primary
  target's units; each linked lane previews and edits the same normalized
  curve in its own target range, with discrete values snapped to steps.
- The editor supports curve preview and direct point editing. Project-scoped
  timeline copy/cut/paste carries scene, audio, MIDI and automation clips as
  one selection, preserving their relative positions, MIDI sources, automation
  targets and curve phase. Paste refuses to silently retarget a missing MIDI
  source or automation target.
- The overlap winner is deterministic and resumes the earlier curve when it
  ends. At the playhead, arrangement lanes mark the active winner and dim
  shadowed clips; selecting a clip raises it visually for editing without
  changing playback precedence.
- Projects keep existing pattern and scene automation untouched. Old files
  load with no arrangement automation clips and continue to play as before.

## Verification gates

- v26 documents migrate without content changes; v29 documents retain their
  single-target automation clips; malformed v30 targets normalize
  idempotently and stay within tick and point bounds.
- Trim/split preserve source phase; add/move/resize/duplicate/point/mute/lock/
  delete commands preserve undo and redo.
- Overlapping clips targeting one parameter resolve to the same winner in
  live playback and offline export; an earlier clip resumes when the winner
  ends.
- Linked-target range mapping is consistent in the editor, live scheduler and
  offline render; conflicts are resolved independently per target.
- Live and offline events agree at clip start/end, interior curve points,
  tempo seams and mute boundaries. Song end includes the last automation clip.
- Yjs round-trip preserves primary/linked targets, curve, phase and clip flags.
  Track/effect deletion removes dependent links without losing undo state.
