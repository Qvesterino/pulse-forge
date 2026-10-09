# Arrangement

The timeline where a song is built. Two layers share it: **scene clips** (the
musical structure — bars playing a scene each) and **audio clips** (sound on
audio tracks). Each has its own rules, both share one toolbox.

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

| Action             | How                                                                      |
| ------------------ | ------------------------------------------------------------------------ |
| Select             | click; `Ctrl`+click toggles; `Shift`+click ranges; marquee on empty lane |
| Copy / Cut / Paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` — paste lands at the playhead             |
| Duplicate          | the clip menu (or `Ctrl+D` for patterns/time ranges)                     |
| Delete             | `Delete`                                                                 |
| Group / Ungroup    | `Ctrl+G` / `Ctrl+Shift+G` — a plain press on one member moves the group  |
| Lock / Unlock      | `Shift+L` — locked clips refuse moves, trims, splits and deletes         |
| Nudge              | `←`/`→` (one bar), `Shift`+arrows (1/16)                                 |
| Ripple             | the ripple toggle shifts everything after the edit to preserve gaps      |
| Mute               | `M` on selected audio clips                                              |
| Locators / loop    | `P` — selection becomes the loop region                                  |

## Groups and locks

Groups (violet top bar) make a set of clips move as one: drag any member and
the whole group travels, relative spacing preserved. Locks (dashed, dimmed)
make clips immune to editing — a locked clip refuses moves, trims, splits and
deletes from every surface, keyboard included. Muting and duplication still
work on locked clips.

## Automation

Scenes can drive track parameters over time: add a scene automation lane
(target = a track's gain/pan/FX parameter), draw points, and the curve plays
whenever a clip of that scene is active. The curve is anchored to the clip's
content — moving or trimming the clip keeps the automation aligned to the
music, never to bare timeline time.
