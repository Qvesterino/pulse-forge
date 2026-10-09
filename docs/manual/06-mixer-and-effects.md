# Mixer and effects

`Alt+1` opens the mixer. Every track has a strip: fader, pan, mute (`M`) /
solo (`S`), and slots for effects. Audio flows track → effect rack → group or
master; return tracks hold shared effects (reverb, delay) fed by per-track
sends.

## The effect rack

Open a track's devices (`Alt+2` focuses the rack) and add effects from the
rack browser — the core rack covers filters, EQs, dynamics, modulation,
delay/reverb, distortion, lo-fi and utility; the **ZENIT** suite is a
dedicated mastering stack driven by macro knobs. Every parameter is
automatable and every change is undoable.

Practical order of attack for a mix:

1. Levels and pans first — the cheapest 80 % of a mix.
2. Group tracks (drums, harmonies, …) and mix the groups.
3. Sends to returns for shared space (one great reverb beats five mediocre).
4. Mastering chain last — see below.

## Mastering

The **MASTER** panel (`Alt+9`) hosts the mastering chain and workspace:
a macro-driven stack (the nine big knobs) with an auto-assisted starting
point, plus loudness-aware metering. For finishing, the mastering session
workflow (MASTERING panel) manages delivery variants and external-studio
hand-off.

## Metering

The master strip carries loudness-weighted metering (K-weighted, with peak
rings). Keep the master out of clipping; the status bar announces master
clipping as well.

## Track management

- Number keys select tracks 1–9; `Tab` cycles.
- Group tracks fold others into one strip; return tracks feed from sends.
- Track order is drag-and-drop; `M`/`S` mute/solo the selected track.
- Every structural change (add/remove/reorder) is undoable.
