# State Consistency & Invariant Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/06_STATE_INVARIANT_AUDIT.md`

## Audit-specific mission

Search the project model and runtime stores for states that should be impossible but are currently representable.

Examples: orphan references, duplicate IDs, negative durations, invalid time ranges, track references to missing media, impossible selections, contradictory mute/solo flags, deleted entities still referenced by history, plugin states without owners, malformed automation points, and partially initialized engine objects.

Make invariants explicit with constructors, validators, assertions, command preconditions, schemas, or tests at the safest layer. Ensure validation does not reject previously valid projects without a migration path.

Fix every high-confidence invariant violation reachable through normal or corrupted inputs.
