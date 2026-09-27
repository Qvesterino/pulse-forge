# Recovery Path Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/02_RECOVERY_PATH_AUDIT.md`

## Audit-specific mission

Audit every path by which the DAW must recover from an interruption or failure.

Cover at minimum: crash/restart, reload, malformed or partially written state, interrupted save, failed import/export, missing media, invalid plugin/effect state, unavailable audio device, background/suspend/resume where applicable, and user cancellation mid-operation.

Verify that recovery is deterministic, does not silently discard valid user data, and cannot trap the app in a half-initialized state. Inspect temporary files, autosave strategy, fallback state, error boundaries, restart logic, cleanup, and idempotency of recovery operations.

Repair proven recovery defects with minimal safe changes and add regression coverage that explicitly simulates failure before successful recovery.
