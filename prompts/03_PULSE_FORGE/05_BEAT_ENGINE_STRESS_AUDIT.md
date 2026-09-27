# Pulse Forge Beat Engine Stress Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/05_BEAT_ENGINE_STRESS_AUDIT.md`

## Pulse Forge mission

Stress the beat engine with increasingly dense realistic projects.

Build scenarios with many tracks, dense step patterns, high polyphony, all major effects enabled, automation, repeated preset switching, frequent BPM changes, loop edits during playback, mute/solo storms, and rapid start/stop.

Observe CPU pressure, main-thread stalls, audio glitches, scheduler drift, GC pressure, memory growth, and degraded UI responsiveness. Identify pathological algorithms or unnecessary work in audio-critical paths.

Fix reproducible performance failures without trading away correctness. Prefer bounded work, preallocation, reuse, and audio-thread-safe design over arbitrary throttling.
