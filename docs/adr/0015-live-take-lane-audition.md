# ADR 0015 — Live take-lane audition

Date: 2026-09-26
Status: Accepted

## Context

Take lanes can currently be auditioned only by rendering an isolated offline
project while transport is stopped. A recording workflow also needs to hear a
selected pass immediately in the context of the live audio graph, without
changing which pass is active in the saved project.

The project model remains the sole persisted source of truth (ADR 0003), and
the transport/scheduler remain the event clock (ADR 0002). A live audition is
therefore a temporary playback intent, not a project edit or a React-owned
audio graph.

## Decision

- Keep the saved `ProjectDocument` unchanged. The arrangement service owns a
  host-local, runtime-only playback-project override derived from the current
  document and the selected `(takeGroupId, takeId)`.
- The derived playback view contains only the selected lane, clears pattern
  note content and markers, and mutes tracks outside the selected track's
  group ancestry. It retains the complete arrangement tempo map and loop
  context so the transport's musical clock does not change during audition.
- The same `AudioEngine` and track/group/master processing path are used. The
  scheduler continues to own timing and schedules only the selected lane.
  When audition begins mid-clip, linear forward clips resume from the
  playhead with their source offset advanced; future clips retain their
  original starts. No offline render is inserted into realtime playback.
- Entering or leaving the override stops already scheduled one-shots and
  voices, clears pending MIDI sends, resets scheduled automation, updates the
  engine projection, and re-aligns the scheduler at the current transport
  position. Frozen playback is re-anchored after the new projection is synced.
- Clear the override on transport pause/stop, project mutation/replacement,
  audition-panel dismissal, and project close. Saving, undo/redo, collaboration,
  bounce, and export always read the canonical store document, never the
  override.
- Keep stopped-transport audition on the existing isolated offline-render
  path. Live audition is available only in song mode with transport looping
  disabled; pattern mode does not schedule arrangement audio clips, and loop
  wraps need a dedicated source-offset reset before live take audition can be
  supported.

## Consequences

Live audition is non-destructive and cannot leak into a save or export. The
initial live path is limited to linear forward clips when joining partway
through an already-started clip; clips with reverse/loop/warp/stretch mapping
remain available through offline audition while stopped. Live audition is
also unavailable while transport looping is enabled. The lookahead
scheduler means the audible transition is bounded by one scheduler tick plus
its normal scheduling horizon, not sample-instantaneous hardware switching.

This is software-path behavior only. It does not establish physical device
latency, input monitoring latency, or native-backend support.
