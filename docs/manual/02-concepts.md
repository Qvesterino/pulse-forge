# Concepts

Five words explain the whole studio: **tracks**, **patterns**, **scenes**,
**clips**, **transport**.

## Tracks

A track is one instrument or one audio lane, with its own mixer strip: gain,
pan, mute/solo, sends and an effect rack. There are drum tracks (pads + step
grid), instrument tracks (synths/samplers played from the piano roll), audio
tracks (recorded or imported audio clips), group tracks (fold several tracks
into one fader) and return tracks (shared effect sends).

## Patterns

A pattern is a short musical phrase — drum steps and/or notes — typically one
to four bars. Patterns don't have a fixed length in time; they loop. The step
sequencer edits the active pattern's drum rows; the piano roll edits its
notes. Duplicate a pattern (`Ctrl+D`) to make a variation without losing the
original.

## Scenes

A scene bundles one pattern per instrument — "verse", "drop", "breakdown" —
plus optional tempo, intensity and automation. Scenes are what you _arrange_:
the arrangement timeline is built from scene clips pointing at scenes.

## Clips — two kinds

- **Scene clips** (arrangement): "play scene X for N bars starting at bar M".
  They snap to whole bars, never overlap, and can be swapped (variant swap),
  split, trimmed from the left, grouped and locked.
- **Audio clips**: recorded or rendered audio on an audio track. They can
  overlap and layer, be split sample-precisely, trimmed from both edges,
  slipped (content moves inside the clip), time-stretched, crossfaded,
  grouped and locked.

Both kinds support: move, nudge (`←`/`→`), copy/cut/paste, duplicate, delete,
group (`Ctrl+G`) and lock (`Shift+L`). See [Arrangement](05-arrangement.md).

## Transport

Play/pause `Space`, stop `Escape`, return to start `Home`, loop region `L`
(drag on the ruler to set it), metronome in the transport bar, tempo in BPM.
`,` and `.` move the playhead by one bar.

## Where data lives

Everything is stored locally in your browser (IndexedDB), autosaved as you
work. Live collaboration and the gallery are opt-in network features — your
project never leaves the machine unless you share it on purpose.

## The two big modes

- **Pattern mode** loops the active pattern — writing music.
- **Song mode** plays the arrangement top to bottom — structuring music.

The mode switch is next to the transport. Scenes belong to song mode; in
pattern mode the scene launcher becomes a pattern launcher.
