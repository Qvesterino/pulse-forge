# ADR 0024: Live-editing audio sync — orphan cancel, playhead resume, owner-scoped voices

Date: 2026-10-07 · Status: Accepted · Scope: audio engine, scheduler boundary, transient players

## Context

ADR 0002 keeps the audio clock authoritative: the scheduler plans events in a
25 ms tick / 120 ms lookahead window and hands them to the WebAudio graph, and
`source.start(when)` is commit-only — a scheduled event cannot be unscheduled.
The scheduler re-plans from the fresh document at its next window and never
re-fires anything behind it, so editing while playing left two failure classes
documented by the 2026-10 editor audit as open risks:

1. **Ghost sound.** A deleted or moved multi-bar clip kept sounding: its
   one-shot sources were already committed to the clock and rang to their
   originally scheduled stop — seconds of audio from content that no longer
   exists.
2. **Silent present.** The scheduler triggers a clip only when its START tick
   enters a scheduling window. A clip whose body SPANS the playhead — after a
   seek into its middle, play-from-position, or an edit that moved/restored a
   clip over the playhead — has its start behind every future window and
   stayed silent forever.

A third class concerned transient players: `GhostPreviewPlayer.stop()` only
cleared its scheduling timer, so the last lookahead window's events (plus
every sustained note's full `durSec`) kept sounding after the user stopped the
preview.

## Decision

1. **Cancellation lives on the sources, never on the scheduler.** The
   scheduler stays commit-only. `AudioEngine.cancelOrphanedClipSources()`
   de-click-cancels every clip source whose clip vanished or whose timeline
   geometry changed since it was scheduled, and returns the ids that still
   legitimately sound.
2. **Resuming is an explicit pass, not a scheduler change.** `liveEditSync`
   (new module, 5f1dc2a3/2d349299) owns "doc changed while playing":
   `syncDocChangeWhilePlaying` = orphan cancel, then resume every clip that
   now spans the playhead with the correct source offset. Resume scope mirrors
   `triggerAudioClip`'s own gate — linear forward clips only; reverse, loop,
   warp-pinned and stretched clips stay silent until their next natural
   trigger rather than risk wrong audio from per-mode mid-body position math
   that does not exist yet. The same pipeline is wired for doc changes, seek
   and play in `services.ts`, and exercised by the browser live-editing pass —
   the verified path is the shipped path.
3. **Transient players claim their voices.** `TriggerEngine.withVoiceOwner(
owner, fn)` tags every voice created inside the scope (nesting-safe;
   `TriggerVoice.owner`); `TriggerEngine.stopVoicesForOwner(owner, now)`
   de-click-stops exactly those voices — pending starts and still-ringing
   tails — using the same ramp idiom as `panicVoices`. `GhostPreviewPlayer`
   scopes its scheduling windows with `ghost-preview` and kills them on
   `stop()`. Untagged voices (the live scheduler/transport) are never matched,
   so a preview stop can never punch a hole in real playback.
4. **A scoped tag, not another parameter.** The owner travels as a scope
   around the scheduling calls instead of a new trailing argument on
   `trigger`/`noteOn`: the delegation surface is pinned by
   `tests/trigger-engine.test.ts`, `noteOn` already carries nine parameters,
   and a scope expresses the actual contract ("everything this player
   schedules belongs to it") without touching either.

## Consequences

- Deleted or moved clips stop sounding within the ~50 ms de-click ramp instead
  of ringing to their original stop; seeking into, or editing a clip over, the
  playhead now sounds from the playhead instead of staying silent.
- A stopped preview is inaudible after its own kill ramp instead of the
  lookahead window plus every sustained note.
- Reverse/loop/warp/stretch clips remain silent after a mid-body structural
  edit until their next natural trigger — an honest, documented limitation
  (cancelling orphans still applies to them).
- `stopVoicesForOwner` is safe without an audio context (empty registry, no
  graph touch), and `withVoiceOwner` restores the previous tag on every exit,
  so scoped and untagged scheduling can interleave freely.
