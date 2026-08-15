# ADR 0002 — Audio-clock lookahead scheduling

Date: 2026-08-15
Status: Accepted

UI timers never decide when notes sound. Musical position is represented in ticks (PPQ 480) owned by the `Transport`; the `Scheduler` runs a 25 ms interval, projects a 120 ms horizon onto `AudioContext.currentTime`, and schedules Web Audio events ahead of time. The visual playhead is an observer of the transport, not the reverse.

Consequence: BPM changes during playback rebase the transport anchor rather than accumulating drift; stop always stops (`engine.panic()`). Verified by unit tests with a controlled clock.
