# Dependency Health & Supply Chain Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/09_DEPENDENCY_HEALTH_AUDIT.md`

## Audit-specific mission

Audit runtime and development dependencies with reliability and maintainability as the goal.

Identify vulnerable, abandoned, unmaintained, duplicated, unexpectedly bundled, overly broad, or unnecessary dependencies. Check lockfile consistency, native build risk, browser/runtime compatibility, peer dependency mismatches, and duplicate versions of foundational packages.

Do not perform mass upgrades. Upgrade only when the compatibility risk is understood and tests can validate the change. Remove a dependency only when its usage is clearly obsolete. Prefer low-risk remediation and document items that require a planned migration.
