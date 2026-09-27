# Cross-Component Contract Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/05_CROSS_COMPONENT_CONTRACT_AUDIT.md`

## Audit-specific mission

Audit contracts across UI, commands, project model, audio engine, persistence, workers/native bridge, and plugin/effect systems.

Look for duplicated source of truth, undocumented nullable behavior, unit mismatches, stale caches, inconsistent IDs, ordering assumptions, ownership ambiguity, race-prone callbacks, implicit conversions, and call sites violating callee preconditions.

For every risky boundary:
- identify the producer and consumer contract;
- define the invariant in code/tests if it is currently implicit;
- enforce validation at the correct boundary;
- remove contradictory duplicate state only when doing so is a small, proven reliability fix.

Do not use this audit as an excuse for broad architecture rewrites. Prefer strengthening existing contracts.
