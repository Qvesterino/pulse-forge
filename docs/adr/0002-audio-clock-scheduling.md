# ADR 0002 — Audio-clock lookahead scheduling

Date: 2026-08-15
Status: Accepted

UI timers never decide when notes sound. Musical position is represented in ticks (PPQ 480) owned by the `Transport`; the `Scheduler` runs a 25 ms interval, projects a 120 ms horizon onto `AudioContext.currentTime`, and schedules Web Audio events ahead of time. The visual playhead is an observer of the transport, not the reverse.

Consequence: BPM changes during playback rebase the transport anchor rather than accumulating drift; stop always stops (`engine.panic()`). Verified by unit tests with a controlled clock.

## Amendment (2026-09-29, Wave 3 — audio-clock tick driver)

The 25 ms `setInterval` remains the scheduler's *fallback* tick source, but when a realtime AudioContext exists the tick cadence comes from the audio device: an `rt-ticker-processor` AudioWorklet (part of the core worklet bundle) posts one message every 8 render quanta (~21.3 ms @ 48 kHz) and `Scheduler.setDriver()` routes ticks through `AudioTickerSchedulerDriver` instead of the main-thread timer.

Why: a `setInterval` tick inherits every bit of main-thread jank (React render, GC, layout) and browser timer clamping; a late tick erodes the 120 ms lookahead window and events are scheduled late — audible during exactly the moments a DAW is busiest. The ticker's cadence and timestamps follow the audio clock; a stalled main thread turns into a burst of queued messages (absorbed by the scheduler's plan-from-transport-position tick) rather than a clamped timer.

Safety net: the driver also arms a 90 ms timer watchdog that only fires when ticker messages stop arriving (suspended context, dead audio thread, missing worklet module) — the union of both sources never goes silent. If the ticker node cannot be constructed at all the driver degrades to pure-timer mode; the scheduler must never lack a driver because of the driver. Driver health is mirrored into `Scheduler.stats` (`driverKind`, `driverTickerTicks`, `driverWatchdogTicks`, `driverMaxTickerGapMs`) for diagnostics.

Consequences: the 5 ms tempo-flip committer stays a timer (its cadence requirement is tighter than the ticker's; it self-disarms and only runs while a seam is pending). `dispose` semantics are unchanged — the driver's lifecycle is the scheduler's `start()`/`stop()`. Offline rendering is untouched (the scheduler never runs offline).
