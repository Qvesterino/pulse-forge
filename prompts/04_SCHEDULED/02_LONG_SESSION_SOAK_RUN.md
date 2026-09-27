# Scheduled Long-Session Soak Run

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/02_LONG_SESSION_SOAK_RUN.md`

## Scheduled mission

Run or construct a repeatable stress loop that approximates a long DAW session.

Cycle through realistic operations: open/create project, play/stop, edits, undo/redo, track/effect changes, save/reload, import/export, and product-specific recording or sequencing actions. Repeat enough times to expose lifecycle leaks and state drift.

Track failures, memory/resource growth where tooling permits, duplicated events, degraded timing, corrupted state, and cleanup errors. Repair reproducible issues, add regression coverage, and leave the soak harness reusable for future scheduled runs.
