# Pulse Forge Browser Audio Lifecycle Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/02_BROWSER_AUDIO_LIFECYCLE_AUDIT.md`

## Pulse Forge mission

Audit AudioContext and browser lifecycle handling from first load to repeated long sessions.

Cover autoplay restrictions, suspended/resumed AudioContext, visibility changes, background throttling, page hide/show, browser sleep/wake, device changes, permission changes, tab reload, context recreation, user gesture requirements, and failed AudioWorklet initialization.

The project must recover without duplicated engines, zombie schedulers, broken transport state, or silent success states. Test repeated suspend/resume and engine recreation. Fix lifecycle inconsistencies and add guards/tests.
