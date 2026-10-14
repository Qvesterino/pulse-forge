# Step sequencer

The drum grid at the bottom of the studio. One row per pad, one column per
step (sixteenths by default). Click a cell to toggle a hit.

## The basics

- **Click** toggles a hit.
- **Drag vertically** on a hit changes its **velocity** (the small bar in the
  cell). Drags that travel horizontally become a **paint stroke** — sweep
  across steps to fill them at one level.
- **`Ctrl`+drag** on a hit sets its **probability** (0–100 %): how likely the
  step is to fire this cycle. Great for humanized hi-hats.
- **`Alt`+drag** sets **micro-timing**: push the hit off the grid tick by
  tick — early for urgency, late for groove.
- **Right-drag** opens a lasso to select a block of steps for bulk edits.
- **`Shift`+drag** selects a rectangular range; velocity edits then apply as a
  ramp across the selection (a build, not a wall).

## Per-step locks and per-pad options

Each hit can pin its own sample choice, velocity layer and round-robin state —
step locks — so a fill keeps exactly the samples you chose instead of the
rotate logic reshuffling it. Pad-level options (sample, tuning, synth voice,
choke, loop) live in the pad editor: click a pad's name.

## Pattern length and variations

Set the pattern length in the pattern bar: 16 steps is one 4/4 bar, and the
current safe maximum is 128 steps (8 bars). `Ctrl+D` duplicates the active
pattern so you can edit a variation while keeping the original. The dice tray
rolls seeded variations of the whole pattern (see
[AI assistants](07-ai-assistants.md)).

Pattern length is not song length. Use **SONG** mode and the **ARR** panel to
place and extend sections across a complete track. Song-mode playback and export
follow the arrangement timeline, even when it is much longer than any one
pattern. To lengthen an 808 note, select the 808 instrument and open its Piano
Roll, then drag the note's right edge. Increase the pattern to 32/64/128 steps
if the note needs more room. Today an individual note cannot extend past the
pattern's 8-bar limit; use longer/repeated arrangement clips for the song form.

## Timing tips

- Humanize by hand: a hat pattern sounds twice as alive with ±2 velocity and
  one or two late micro-timings.
- Probability is per-cycle: a 50 % open hat never sounds robotic, because it
  never repeats the same way twice.
- The ruler above the grid paints the **loop region** — the sequencer loops
  inside it while you edit.
