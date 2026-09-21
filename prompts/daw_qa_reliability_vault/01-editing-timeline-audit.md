# DAW Audit 01 — Editing & Timeline

Perform a focused audit of all core timeline editing behavior.

Verify where implemented:

- select / multi-select / marquee select
- move / drag
- trim left / right
- resize
- cut / split
- copy / paste / duplicate
- delete
- insert / replace
- fade in / fade out
- crossfade
- loop / repeat
- crop
- slip edit
- ripple edit
- stretch / time-stretch
- grouping / locking
- snap / grid
- overlap behavior

Test each operation under normal use, rapid repeated interaction, undo/redo, zoomed-in/out states, and near timeline boundaries.

Pay special attention to:
- invalid durations
- negative positions
- wrong source offsets
- duplicated IDs
- shared mutable state after copy
- stale selection
- ghost clips
- visual state disagreeing with project state


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
