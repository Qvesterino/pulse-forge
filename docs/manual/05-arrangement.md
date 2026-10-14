# Arrangement

The timeline where a song is built. It holds **scene clips** (sections),
**instrument MIDI clips** (per-track phrases), **audio clips**, and
**automation clips**. Each has its own rules, all follow the song's tick and
tempo map.

## Navigation

- `Ctrl+wheel` zooms the timeline around the cursor (0.05×–40×).
- `←`/`→` nudge the selected clips one bar; `Shift`+arrows nudges a sixteenth.
- Drag the ruler to set a time range; `Shift`+click adds a marker; `P` turns
  the selection into the loop region.
- `J` toggles the snap grid (OFF / 1 bar / 1/2 / 1/4 / 1/8 / 1/16); holding
  `Shift` during a drag suspends snapping for that gesture.

## Scene clips — structure

- **Place**: click an empty lane bar and pick a scene, or drag from the scene
  launcher. Scene clips snap to whole bars and never overlap.
- **Move**: drag. **Resize**: drag the right edge (whole bars).
- **Trim left**: drag the left edge zone — the clip starts later in its
  content; the end stays put.
- **Swap scene**: replace a clip's scene without touching position or length
  (the variant swap in the clip menu).
- **Split**: use the razor (cut tool) at the click position — bar-accurate.

## Build a complete song

1. Create or duplicate scenes for the sections you need; assign roles such as
   INTRO, BUILD, DROP, BREAK and OUTRO.
2. Switch the transport to **SONG** and open **ARR**.
3. Choose **SONG · 1:00–4:00** next to **AUTO ARRANGE**, then click
   **AUTO ARRANGE**. The seven-section form is scaled to the selected duration
   in whole bars at the project tempo. Scene tempo changes can change its final
   wall-clock duration.
4. Refine the clips on the timeline, then play and export in SONG mode. The
   arrangement continues beyond the active pattern's length. **AUTO ARRANGE**
   replaces the scene-clip layout as one undoable edit.

For hand-built arrangements, drag scenes from the launcher into the timeline,
resize clips to extend them, and duplicate sections to repeat them. A 3-minute
4/4 song is about 90 bars at 120 BPM or 93 bars at 124 BPM.

## Instrument MIDI clips — notes across the song

The step grid is a pattern editor, not the song-length limit. In the **MIDI
TRACKS** lanes, press **+** beside an instrument or double-click its lane to
place the active pattern at that time. Each clip plays only that instrument's
notes, repeats them to fill its visible length, and can be moved or extended
without growing the bounded step grid. Drag the left edge to trim while
keeping the phrase phase; drag the right edge to extend it. Use the clip menu
to duplicate or make it unique before changing notes that should differ from
other clips using the same pattern. A sustained 808 note can cross pattern
bars in the Piano Roll; its end is cut only at the MIDI clip's end.

## Audio clips — sound

- **Move/trim**: drag the body to move; drag the left/right edge zones to trim
  (audio-precise; the grid applies only when snap is on). `Alt`+an edge **time-
  stretches** the clip instead of trimming it.
- **Slip**: `Alt`+drag the body — the content shifts inside the clip while the
  clip stays where it is. (Not available for reversed, looping or warped
  clips.)
- **Fades**: drag the small top-corner handles for fade-in/out; the top-middle
  handle sets clip gain. Fade curve (linear / equal power) per clip in the
  audio menu.
- **Crossfade**: overlap two clips on one track, select the range, press `X` —
  complementary equal-power fades over the overlap. Adjacent clips get short
  de-click seams instead.
- **Split**: `Ctrl+E` splits the audio clip at the playhead; the razor splits
  sample-precisely at the click.
- **Loop**: the clip menu toggles content looping (a 4-bar atmosphere filling
  16 bars).
- **Warp**: warp markers pin source time to the timeline (stretch mode =
  pitch-preserving); `Alt`+edge time-stretches without markers.

## The shared toolbox

| Action             | How                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Select             | click; `Ctrl`+click toggles; `Shift`+click ranges; marquee on empty lane                                                         |
| Copy / Cut / Paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` — all four clip kinds paste together at the playhead, keeping relative spacing within the project |
| Duplicate          | the clip menu (or `Ctrl+D` for patterns/time ranges)                                                                             |
| Delete             | `Delete`                                                                                                                         |
| Group / Ungroup    | `Ctrl+G` / `Ctrl+Shift+G` — arrow nudges move all group members together                                                         |
| Lock / Unlock      | `Shift+L` — locked clips refuse moves, trims, splits and deletes                                                                 |
| Nudge              | `←`/`→` (one bar), `Shift`+arrows (1/16)                                                                                         |
| Ripple             | the ripple toggle shifts everything after the edit to preserve gaps                                                              |
| Mute               | `M` on selected audio clips                                                                                                      |
| Locators / loop    | `P` — selection becomes the loop region                                                                                          |

## Groups and locks

Groups (violet top bar) make selected clips move as one under arrow nudging or
dragging, preserving their relative timing across scene, audio, MIDI and
automation lanes. Fine nudges and sub-bar dragging work for groups without
scene clips; a group containing a scene clip moves by whole bars. The live
preview shows the planned position for every member, and one completed drag is
one undo step.
Locks (dashed, dimmed) make clips immune to direct edits — a locked clip
refuses moves, trims, splits and deletes from every surface. Muting and
duplication still work on locked clips.

## Chord track

The violet lane above the timeline is the **chord track** — the song's harmonic
skeleton. Chords span whole bars and never overlap.

- **Add**: click empty space in the lane — a two-bar C major chord appears at
  that bar.
- **Edit**: click a chord; an editor with root and quality selectors (major,
  minor, dominant 7, maj 7, min 7, sus, dim) opens in the lane.
- **Move / resize**: drag the chord; drag its right edge.
- **Remove**: the ✕ button in the editor.
- **Detect**: the editor's detection uses the notes of the active pattern —
  `suggestChordFromPitches` scores every root and quality against the pattern's
  pitch classes (see the project-model chords module).

The chord track is not just decoration: with **CHORD** toggled in the piano
roll toolbar, inserted and dragged notes snap to the tones of the chord under
the playhead — write a progression, then improvise melodies that always fit.

## Chord track

The violet lane above the timeline is the **chord track** — the song's harmonic
skeleton. Chords span whole bars and never overlap.

- **Add**: click empty space in the lane — a two-bar C major chord appears at
  that bar.
- **Edit**: click a chord; an editor with root and quality selectors (major,
  minor, dominant 7, maj 7, min 7, sus, dim) opens in the lane.
- **Move / resize**: drag the chord; drag its right edge.
- **Remove**: the ✕ button in the editor.
- **Detect**: the editor scores every root and quality against the notes of
  the active pattern and picks the best match.

The chord track is not just decoration: with **CHORD** toggled in the piano
roll toolbar, inserted and dragged notes snap to the tones of the chord under
the playhead — write a progression, then improvise melodies that always fit.

## Automation

Scenes can drive track parameters over time: add a scene automation lane
(target = a track's gain/pan/FX parameter), draw points, and the curve plays
whenever a clip of that scene is active. The curve is anchored to the clip's
content — moving or trimming the clip keeps the automation aligned to the
music, never to bare timeline time.

For a curve that belongs to a song section instead of a repeating pattern or
scene, open **MOD**, choose or create an automation target, then press **ARR**
beside its lane. KYX copies the curve to the arrangement at the playhead, with
the active pattern's length as its starting duration. In **AUTOMATION CLIPS**,
use **+** to place another copy at the playhead, drag the body to move it, and
drag its edges to trim or extend it. Double-click a clip to add a point at that
time and value; drag a point to edit it or right-click the point to remove it.
Right-click the clip to duplicate, mute, lock or delete. In Song mode,
an unmuted arrangement clip takes priority over the MOD lane for that target;
Pattern mode continues to use the MOD lane. When two arrangement clips for
the same target overlap, the one that starts later controls the overlap; the
earlier curve resumes when it ends. If both start together, clip ID provides a
stable tie-break, so move one clip by a small snap amount to choose the winner
visibly.
