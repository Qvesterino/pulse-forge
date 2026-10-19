# ADR 0055 — Live Pad performance capture

Date: 2026-10-19 · Status: Accepted (v1) · Scope: Live Sets, arrangement capture, Scheduler, AudioEngine

## Context

KYX has project-local 4×4 Live Sets. A pad launch currently adds a finite,
editable `AudioClip`; a second press does not stop it. The Scene Launcher has a
separate CAPTURE / FINISH / CANCEL workflow. `ArrangementCaptureController`
records quantized scene launches and commits them through one undoable command.
The scheduler also exposes audio-clock tick-boundary subscriptions that
reschedule when the active tempo map changes.

The missing performance behavior is an open-ended loop voice that starts and
stops on musical boundaries, then becomes an ordinary editable arrangement
clip. This must not add audio nodes or transient voice state to the persisted
project document.

## Decision

1. Preserve the existing finite one-tap pad launch when arrangement capture is
   inactive. During capture, loop pads control open-ended voices; one-shot pads
   remain one-shots and are captured as finite audio clips.
2. Use a one-bar launch and stop quantum for v1, independent of the Live Set's
   1/2/4/8/16-bar loop length. Pressing an inactive pad queues its start at the
   next bar. Pressing that active pad queues its stop at the next bar. Pressing
   it again before a queued start cancels that start; pressing it again before
   a queued stop cancels that stop. If capture is armed while stopped, the
   first pad press starts Song transport through the playback service and
   queues the voice at the next bar. Different pad slots may overlap; one slot
   cannot own two overlapping loop voices in the same set. A one-shot pad press
   starts one finite voice at the next bar; pressing it again launches another
   one-shot, which may overlap.
3. Reuse the source buffer, destination track, detected BPM and existing
   pitch-preserving stretch path. Resolve project tempo at the scheduled start
   tick. A sample without detected BPM remains playable at its native tempo;
   do not invent a tempo or silently claim it is fitted.
4. Keep ownership at the existing runtime boundaries: `Scheduler` owns musical
   boundary subscriptions, `AudioEngine` owns and stops live voice nodes, and
   `ArrangementCaptureController` owns pending pad intents and captured
   intervals. The React panel sends intent and displays queued/active state; it
   never schedules sources or holds voice nodes.
5. FINISH and a transport stop close active intervals at the stop tick, silence
   their voices with a short de-click ramp, and commit scene launches and pad
   intervals together in one command. Captured pad intervals become normal
   finite `AudioClip`s with their source reference, tempo-fit settings,
   `liveSetId` and `livePadSlot`. Existing undo/redo, autosave, editing and
   offline rendering then apply. The first captured launch boundary is the
   arrangement origin; audio clip start and end ticks retain sub-bar precision.
   Do not render the whole performance into a new audio file.
6. CANCEL, panic, project replacement/close and audio-device loss silence all
   live pad voices and discard the uncommitted pad intervals. No partial clips
   are written. A missing sample or destination track rejects the launch with
   an actionable message and leaves capture unchanged.
7. The capture session remains runtime-only. No project schema change is
   needed: only committed intervals enter the existing `AudioClip` model.

## Acceptance gates

- An inactive loop pad starts at the next bar; active same-pad stop is queued at
  the next bar; pressing again cancels a still-pending start or stop.
- One-shot pads start once at the next bar and are stored as finite clips.
  Different pads can layer; duplicate active loop voices from one slot are
  rejected. Scheduler tempo-map changes reschedule pending boundaries without
  duplicate or early audio events.
- AudioEngine starts and stops the voice on its track route, applies the
  existing tempo-fit renderer, de-clicks stops and releases every source on
  normal stop, cancel, panic, project switch and device loss.
- FINISH and transport stop commit scene and audio clips in one undoable
  command. Their clip boundaries match the recorded ticks and reopen through
  persistence for live and offline playback.
- Missing samples/tracks and cancelled subscriptions create neither ghost
  voices nor arrangement clips. React does not own any realtime audio state.
- Existing non-capture one-tap pad behavior and its tests remain unchanged.

## Consequences and scope limits

- v1 has a one-bar grid. A finer launch/stop grid can be added after measured
  use, without changing loop length or capture ownership.
- A tempo-less sample can be captured but cannot be automatically tempo-fitted.
- A live voice keeps the tempo fit selected at its launch. A later tempo-map
  change affects future launches; dynamic time-stretch retuning of an already
  active voice is a follow-up requirement.
- KYX still has no bundled licensed loop pack or ready-made Live Set catalog;
  this ADR does not add third-party audio content or authorize its licensing.
- Live pad playback is runtime state until FINISH. Saving, collaboration,
  undo/redo and offline render observe only committed `AudioClip`s.
