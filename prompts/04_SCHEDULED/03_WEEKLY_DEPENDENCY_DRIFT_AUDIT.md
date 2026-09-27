# Weekly Dependency Drift Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 04_SCHEDULED/03_WEEKLY_DEPENDENCY_DRIFT_AUDIT.md`

## Scheduled mission

Review dependency drift since the previous stable state.

Check security advisories available locally/tooling, lockfile changes, deprecated packages, peer mismatches, native build fragility, bundle/runtime duplication, and updates that are now low-risk and beneficial.

Do not mass-upgrade. Only change dependencies when the reason is concrete, compatibility is understood, and validation can prove the repository remains healthy. Otherwise produce a short deferred-upgrade list with exact rationale.
