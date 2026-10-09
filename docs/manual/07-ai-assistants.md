# AI assistants

KYX's AI features are all **local, seeded and undoable** — they generate
normal, editable content and never touch your project without a command.

## Intent engine — text to music

`Alt+7` opens the INTENT panel. Describe what you want — "melancholic lo-fi,
80 bpm, dusty piano, soft brushes" — and the engine plans drums, bass and
harmony, then generates a playable draft. Every generation offers variants;
you audition and keep what you like. The engine understands genre vocabulary,
energy, instrumentation and references; you can regenerate sections or the
whole draft.

## Dice — seeded variations

`Alt+6` opens the dice tray: roll a variation of the current pattern with a
seed, walk back through the roll history, and keep whichever roll you like.
Because rolls are seeded, the same seed reproduces the same variation — a
variation is a tool, not a gamble.

## AI Bandmate

The bandmate listens to what is already in the project and plays along —
complementary parts in the key, tempo and groove of your material rather than
fresh random content.

## Session theatre

Blind-audition different performance personas for a part: the theatre generates
several takes in different styles, you rate them blind, and the winner becomes
a normal take in your project.

## Stem separation

Split a mixed audio clip into stems (drums/bass/harmony/voice) right in the
browser — the model runs locally in a worker. Open it from an audio clip's
menu; the result lands as new audio clips you can mute, mix or delete. Requires
a modern browser with WebGPU for full speed (a slower CPU tier runs everywhere).

## Similarity advisory

When you ask for changes, the advisory tells you how close candidates are to
reference material you choose — useful when a variation drifts away from the
sound you had in mind.

## Capture

`A` after a stop or pause offers the **capture** of what you just played
(recorded into a ring buffer even when not recording) as a take — never lose
an accidental riff again.
