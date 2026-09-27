# Performance & Resource Leak Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/08_PERFORMANCE_RESOURCE_LEAK_AUDIT.md`

## Audit-specific mission

Audit long-session stability rather than only short benchmark speed.

Track lifetime and cleanup of audio nodes/graphs, buffers, workers, threads, timers, listeners, subscriptions, object URLs, media handles, native resources, plugin instances, caches, background jobs, and render/export tasks.

Exercise repeated create/destroy, project open/close, play/stop, effect insertion/removal, undo/redo, import/export, recording/sequencing, and session reload cycles. Look for monotonic memory growth, duplicate callbacks, CPU growth, scheduler multiplication, leaked handles, and zombie audio processing.

Fix leaks and lifecycle defects with explicit ownership and disposal. Add stress/regression tests when feasible.
