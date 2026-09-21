# DAW Audit 25 — Real-User Chaos Test

Perform a combined end-to-end stress audit that simulates realistic messy user behavior.

The purpose is to expose failures that isolated subsystem tests miss.

## Scenario A — Editing Chain

Create/load project  
→ create tracks  
→ import clips  
→ play  
→ move  
→ trim  
→ fade  
→ split  
→ duplicate  
→ move duplicate  
→ delete fragment  
→ undo several steps  
→ redo  
→ save  
→ reload  
→ play  
→ export

Verify project state and audible behavior remain correct.

## Scenario B — Load Stress

Run simultaneously where supported:

- many tracks
- many clips
- playback
- scrolling
- waveform rendering
- plugin processing
- automation
- analyzers/meters
- autosave
- repeated edits

Observe:
- audio glitches
- UI freezes
- stale state
- memory growth
- duplicated scheduling
- broken undo/redo
- failed autosave
- resource leaks

## Scenario C — Failure Injection

During active use simulate:
- failed import
- failed plugin load
- unavailable device
- worker failure
- reload/recovery
- malformed project/state where safe

Verify failure remains contained and unrelated work survives.

## Rule

When a confirmed issue is found:

1. reproduce it minimally
2. identify root cause
3. add regression coverage
4. fix safely
5. rerun the combined scenario


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
