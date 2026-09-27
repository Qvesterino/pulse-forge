# Dead / Suspicious / Legacy Code Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/11_DEAD_SUSPICIOUS_CODE_AUDIT.md`

## Audit-specific mission

Inspect code that increases reliability risk because ownership or intent is unclear.

Search for dead branches, unreachable code, duplicate implementations, abandoned feature flags, stale TODO/FIXME/HACK markers, commented-out production logic, obsolete migrations, legacy adapters, silent catches, disabled tests, broad any/unknown casts, fallback code that can never trigger, and duplicated state transformations.

Classify each finding as delete, repair, test, document, or leave untouched. Do not delete code merely because static analysis says it is unused when dynamic loading, native bindings, plugin registration, or reflection may be involved.

Make only high-confidence cleanups and add coverage around suspicious but active paths.
