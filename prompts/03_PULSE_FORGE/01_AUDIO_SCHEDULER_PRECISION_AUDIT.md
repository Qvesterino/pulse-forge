# Pulse Forge Audio Scheduler Precision Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/01_AUDIO_SCHEDULER_PRECISION_AUDIT.md`

## Pulse Forge mission

Audit timing architecture with one overriding rule: audio scheduling must not depend on UI frame rate or setTimeout precision for sample-critical events.

Inspect transport clock, lookahead scheduler, Web Audio currentTime usage, AudioWorklet interaction, pattern scheduling, note-on/off, tempo changes, seek, loop boundaries, swing, quantization, metronome, automation, and pattern transitions.

Test main-thread stalls, rapid UI interaction, background tab behavior where observable, tempo jumps, seek during playback, loop resize during playback, dense notes near boundaries, and repeated start/stop.

Fix duplicate scheduling, missed events, drift, boundary races, and stale scheduled events. Add deterministic timing tests where possible.
