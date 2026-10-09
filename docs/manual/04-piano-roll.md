# Piano roll

The editor for melodic instrument tracks: pitches on the left, time steps
along the top. Click empty space to insert a note; drag to move it; drag its
right edge to resize.

## Editing

- **Move**: drag a note. **Resize**: drag its right edge.
- **Alt+drag** a note duplicates it while you drag (drag the copy anywhere).
- **Arrows** nudge selected notes: left/right by one step, up/down by one
  semitone; `Shift`+up/down moves an octave.
- **Velocity** is edited in the lane under the grid; drag across notes to
  spread velocities.
- **`Ctrl+A`** selects all notes of the track.
- **`Delete`** removes selected notes.

## Performance tools

| Key       | Tool                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `S`       | **Strum** selected notes — stagger their starts into a chord sweep      |
| `Alt+S`   | **Slide** toggle — portamento between consecutive notes                 |
| `L`       | **Legato** — extend each note to the start of the next                  |
| `Ctrl+B`  | **Duplicate** selected notes                                            |
| `Alt+Q`   | **Quantize 50 %** — pull starts halfway to the grid, keeping human feel |
| `Shift+C` | **Chord stamp** menu — insert a full chord shape at the cursor          |

## Scale and chord snapping

Toggle **scale snap** in the piano roll toolbar and every note you drag or
insert lands in the chosen scale. Chord snap constrains voices to the detected
or chosen chord — useful when the harmony comes from the intent engine or a
sample and you want every added note to fit.

## Step entry (FL-style)

Toggle the step-entry cursor and the piano roll becomes a QWERTY keyboard:
letter keys insert notes at the cursor row (keys = semitone offsets from the
cursor's pitch), arrows move the cursor, `Delete` removes the note under it,
and the cursor advances automatically — you can play in a melody without
touching the mouse.

## Groove and quantize

`Alt+Q` quantizes with 50 % strength by design: notes tighten toward the grid
but keep their original life. For harder alignment, run it twice. The groove
pool can also apply learned timing profiles to the whole pattern.
