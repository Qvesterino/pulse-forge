# Critical Path Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/01_CRITICAL_PATH_AUDIT.md`

## Audit-specific mission

Audit the DAW's highest-value user journeys end to end and harden every reliability weakness you can prove.

Focus on flows such as project creation/opening, editing, playback, save/autosave, import, export, undo/redo, track operations, plugin/effect changes, and app/session shutdown.

For each critical path:
- trace UI/event entry points through command/state/audio/persistence layers;
- identify illegal intermediate states, stale references, partial operations, race windows, and unhandled failures;
- verify cancellation and retry behavior;
- test rapid repeated actions and boundary timing;
- ensure failures are surfaced without corrupting project state;
- ensure a failed operation leaves the project usable.

Fix all high-confidence defects you find. Add regression tests around every repaired failure mode. Do not broaden into unrelated refactors.
