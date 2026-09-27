# DAW Hardening Orchestrator

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/05_MASTER_ORCHESTRATOR.md`

## Scheduled mission

Execute hardening in controlled phases. Do not run all audits as one giant refactor.

Phase order:
1. Critical path — `01_COMMON/01_CRITICAL_PATH_AUDIT.md`
2. Project/data integrity — `01_COMMON/03_PROJECT_DATA_INTEGRITY_AUDIT.md`
3. Recovery — `01_COMMON/02_RECOVERY_PATH_AUDIT.md`
4. Undo/redo — `01_COMMON/04_UNDO_REDO_INTEGRITY_AUDIT.md`
5. State/contracts — `01_COMMON/06_STATE_INVARIANT_AUDIT.md` then `01_COMMON/05_CROSS_COMPONENT_CONTRACT_AUDIT.md`
6. Audio-specific engine audit — all of `03_PULSE_FORGE/01`–`07`
7. Product-specific audits — `03_PULSE_FORGE/08_PRODUCT_FEATURE_AUDIT.md`
8. Performance/resource leaks — `01_COMMON/08_PERFORMANCE_RESOURCE_LEAK_AUDIT.md`
9. Security/dependencies/dead code — `01_COMMON/10_SECURITY_SURFACE_AUDIT.md`, `01_COMMON/09_DEPENDENCY_HEALTH_AUDIT.md`, `01_COMMON/11_DEAD_SUSPICIOUS_CODE_AUDIT.md`
10. Final reliability sweep — `01_COMMON/12_FINAL_RELIABILITY_SWEEP.md`

Every phase now names the prompt that drives it. If you add a prompt, add it to this
list in the same commit — an unlisted prompt will never run.

For each phase use:
AUDIT → REPRODUCE → FIX → VERIFY → REGRESSION TEST → STABLE CHECKPOINT → NEXT DOMAIN

Do not advance when the current phase has failing validation caused by your changes. Keep each phase independently reviewable. Respect repository-level AGENTS.md, contributing rules, test conventions, and documented product invariants.
