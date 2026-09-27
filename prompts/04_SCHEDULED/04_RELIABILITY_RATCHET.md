# Reliability Ratchet

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/04_RELIABILITY_RATCHET.md`

## Scheduled mission

Treat this run as a ratchet: the codebase must leave the run at least as reliable as it entered.

Choose a small reliability domain with weak coverage or recent churn. Inspect it, prove concrete defects or missing invariants, make only high-confidence fixes, add regression tests, and run validation.

Never trade a known working behavior for a cleaner-looking design. Never leave partial refactors. If a fix becomes uncertain, revert that fix and document the finding instead.

At completion, explicitly state the reliability gain achieved and the evidence supporting it.
