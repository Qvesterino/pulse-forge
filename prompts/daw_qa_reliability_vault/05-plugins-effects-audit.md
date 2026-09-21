# DAW Audit 05 — Plugins & Effects

Audit the DAW's plugin/effect hosting layer.

Verify:

- insert
- remove
- reorder
- bypass
- enable/disable
- parameter changes
- preset load/save
- automation
- plugin state recall
- undo/redo plugin changes
- UI open/close
- repeated insertion/removal
- cleanup after deletion

Look for:
- leaked audio nodes
- duplicate processing
- stale automation
- plugin state not restoring
- removed plugins remaining audible
- UI owning DSP state
- bad lifecycle handling


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
