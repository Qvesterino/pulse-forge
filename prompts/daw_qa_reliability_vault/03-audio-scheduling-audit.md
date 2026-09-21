# DAW Audit 03 — Audio Scheduling

Audit audio-event scheduling and timing accuracy.

Inspect:

- lookahead scheduling
- scheduling horizon
- audio-clock usage
- clip start/end timing
- loop scheduling
- event cancellation
- seek behavior
- tempo conversion
- musical time ↔ seconds conversion
- long-session drift

Test temporary main-thread stalls and verify scheduling remains stable where architecture permits.

Look for:
- duplicate scheduling
- stale events
- drift
- incorrect loop wrap
- events firing after stop/seek
- UI timers being used as authoritative audio timing


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
