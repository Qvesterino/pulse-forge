# Undo / Redo Integrity Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/04_UNDO_REDO_INTEGRITY_AUDIT.md`

## Audit-specific mission

Audit the command history and all destructive or state-changing operations for undo/redo correctness.

Verify command boundaries, grouping/coalescing, inverse operations, redo invalidation after divergent edits, nested commands, async operations, project reload, selection-only changes, automation edits, plugin/effect edits, track/clip/note operations, import actions, and archival/recovery actions.

Required properties:
- undo restores the exact prior semantic state;
- redo restores the exact post-command semantic state;
- repeated undo/redo cycles are stable;
- IDs and references remain valid;
- side effects outside project state are either reversible or intentionally excluded and documented;
- failed commands never enter history as successful operations.

Repair defects and add property-style or sequence tests for complex histories.
