# DAW Audit 16 — UI Responsiveness

Audit interaction responsiveness.

Test:
- dragging clips
- trimming
- resizing panels
- scrolling
- zooming
- mixer interaction
- plugin parameter dragging
- opening/closing panels
- timeline auto-scroll
- browser resize
- high DPI
- narrow layouts

Look for:
- dropped input events
- laggy controls
- layout thrashing
- excessive main-thread work
- missed clicks
- delayed state commit
- UI freeze while audio remains active


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
