# DAW Audit 09 — Undo / Redo

Audit history integrity across the DAW.

Test:
- edit → undo → redo
- multiple edits → multiple undo/redo
- undo → new action
- clip edits
- track edits
- mixer changes
- plugin add/remove
- automation
- import
- destructive operations
- grouped edits

Verify exact restoration of:
- positions
- durations
- source offsets
- fades
- IDs/references
- track assignment
- plugin state
- automation state

Ensure undo/redo does not create duplicate clips, stale runtime objects, or invalid history branches.


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
