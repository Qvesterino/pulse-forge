# Pulse Forge Browser Compatibility Hardening Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/06_BROWSER_COMPATIBILITY_HARDENING.md`

## Pulse Forge mission

Audit the browser DAW against its intended browser support matrix, at minimum Chromium-family, Edge, Firefox, and Safari where the codebase claims support.

Inspect AudioWorklet support and loading, codec decode/encode assumptions, file APIs, storage APIs, SharedArrayBuffer/cross-origin requirements if used, MIDI APIs, permission behavior, offline rendering, workers, module loading, and browser-specific autoplay/lifecycle differences.

Add feature detection and graceful degradation instead of user-agent hacks wherever possible. Do not claim support that cannot be tested or safely degraded. Fix portable compatibility defects and document unavoidable limitations.
