# DAW Audit 08 — Project State

Audit project-state integrity.

Verify:

- new project
- open
- save
- save as
- autosave
- reload
- duplicate project
- project switching
- schema validation
- project version handling

Search for:
- duplicate IDs
- orphaned entities
- stale references
- partial updates
- impossible state combinations
- duplicated sources of truth
- derived state becoming stale

Define key project invariants and test them.


## Global Rules

- Preserve intended product behavior unless a defect is clearly demonstrated.
- Do not add unrelated features.
- Prefer small, local, reversible fixes.
- When a confirmed, well-understood issue is safely fixable, reproduce it, fix it, add regression coverage where practical, and verify the result.
- Do not weaken tests, types, validation, error handling, or assertions merely to make checks pass.
- Do not manufacture work. If the audited area is healthy, verify it, report that no high-value action was found, and stop.
- Avoid broad architectural rewrites unless the audit reveals a concrete defect that cannot be solved safely otherwise.
- After every meaningful change, run relevant tests/checks.



## Completion Report

At the end provide:

### Findings
Confirmed defects, risks, or inconsistencies.

### Fixes
What was changed and why.

### Tests Added
Regression, integration, or E2E coverage added.

### Verification
Exact commands/checks executed and their results.

### Remaining Risks
Anything intentionally left unchanged or requiring manual/human review.
