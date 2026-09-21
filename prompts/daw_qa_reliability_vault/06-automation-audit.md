# DAW Audit 06 — Automation

Audit automation correctness.

Verify:

- create points
- move points
- delete points
- ramps
- step values
- curves where supported
- dense automation
- multiple simultaneous parameters
- automation across loops
- automation after seek
- automation after undo/redo
- automation after plugin/track deletion

Check UI value vs actual DSP value.

Look for:
- dropped automation
- stale automation targets
- excessive event storms
- incorrect interpolation
- automation tied to UI frame rate
- invalid references after plugin deletion


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
