# Pulse Forge Sequencer Integrity Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 03_PULSE_FORGE/03_SEQUENCER_INTEGRITY_AUDIT.md`

## Pulse Forge mission

Audit note and pattern semantics under aggressive editing.

Cover note creation/deletion, duplicate notes, note-off ordering, zero/negative lengths, velocity, probability, ratchets/retriggers if present, swing, quantization, pattern copy/duplicate, pattern resize, loop boundaries, mute/solo, track deletion, note edits during playback, tempo changes, and automation-linked events.

Required properties: no stuck notes, no double-trigger caused by boundary overlap, no orphan note-offs, deterministic pattern replay from identical state, and save/load round-trip preservation.

Fix proven defects and create sequence-based regression tests.
