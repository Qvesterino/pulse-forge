# Pulse Forge Offline Render / Export Accuracy Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/07_OFFLINE_RENDER_EXPORT_ACCURACY_AUDIT.md`

## Pulse Forge mission

Audit whether exported audio is semantically equivalent to intended live playback.

Compare tempo, event timing, swing, automation, synth state, effect parameters, master processing, mute/solo, loop handling, tails, delay/reverb decay, normalization/limiting if present, start/end boundaries, and deterministic random/probability behavior where required.

Create small golden or analytical render tests that compare known schedules and expected timing/levels. Test empty projects, one-shot tails, clipped ends, tempo changes, automation ramps, and long effect tails.

Fix any case where export silently differs from the product's documented live behavior.
