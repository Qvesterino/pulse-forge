# Recovery Path Audit

## Purpose
Perform production-grade hardening on a DAW codebase. Treat reliability, data integrity, audio correctness, recoverability, and intent preservation as higher priorities than architectural novelty.

## Operating mode
Work in the following loop until the scoped audit is complete:

1. Inspect the relevant architecture, tests, runtime paths, persistence model, and existing documentation.
2. Identify concrete defects, unsafe assumptions, broken invariants, missing guards, or high-confidence reliability risks.
3. Reproduce or prove each issue before changing code whenever practical.
4. Fix the issue with the smallest safe change that preserves existing product behavior.
5. Add or improve automated regression coverage.
6. Run the relevant test, typecheck, lint, build, and targeted runtime validation available in the repository.
7. Re-inspect the modified area for secondary regressions.
8. Continue until no safe, high-confidence issue remains inside the current audit scope.

## Non-negotiable rules
- Do not redesign a working subsystem merely because another architecture looks cleaner.
- Hardening is not permission for speculative refactoring.
- Do not rename public contracts, project fields, command names, plugin parameters, IPC channels, persisted identifiers, or user-visible behavior unless required to fix a proven defect.
- Preserve backwards compatibility unless the repository explicitly documents a breaking migration.
- Never silently discard user data.
- Never weaken validation to make tests pass.
- Never remove a failing test unless it is demonstrably obsolete and replaced with equivalent or stronger coverage.
- Prefer deterministic fixes over timing sleeps, retries, or broad catch-all error suppression.
- Avoid broad changes spanning unrelated systems.
- If a risky issue cannot be safely fixed, isolate it, document it, add a failing or quarantined regression test if appropriate, and explain the exact blocker.

## Required output at completion
Report:
- defects found and fixed;
- tests added or strengthened;
- commands executed and outcomes;
- remaining risks or unresolved items;
- files changed;
- whether the audited subsystem is safer than before and why.


---

## Audit-specific mission

Audit every path by which the DAW must recover from an interruption or failure.

Cover at minimum: crash/restart, reload, malformed or partially written state, interrupted save, failed import/export, missing media, invalid plugin/effect state, unavailable audio device, background/suspend/resume where applicable, and user cancellation mid-operation.

Verify that recovery is deterministic, does not silently discard valid user data, and cannot trap the app in a half-initialized state. Inspect temporary files, autosave strategy, fallback state, error boundaries, restart logic, cleanup, and idempotency of recovery operations.

Repair proven recovery defects with minimal safe changes and add regression coverage that explicitly simulates failure before successful recovery.
