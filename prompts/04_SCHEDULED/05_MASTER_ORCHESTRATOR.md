# DAW Hardening Orchestrator

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/05_MASTER_ORCHESTRATOR.md`

## Scheduled mission

Execute hardening in controlled phases. Do not run all audits as one giant refactor.

Phase order:
1. Critical path
2. Project/data integrity
3. Recovery
4. Undo/redo
5. State/contracts
6. Audio-specific engine audit
7. Product-specific audits
8. Performance/resource leaks
9. Security/dependencies/dead code
10. Final reliability sweep

For each phase use:
AUDIT → REPRODUCE → FIX → VERIFY → REGRESSION TEST → STABLE CHECKPOINT → NEXT DOMAIN

Do not advance when the current phase has failing validation caused by your changes. Keep each phase independently reviewable. Respect repository-level AGENTS.md, contributing rules, test conventions, and documented product invariants.
