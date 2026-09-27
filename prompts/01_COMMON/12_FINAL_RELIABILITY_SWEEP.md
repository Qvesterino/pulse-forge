# Final Reliability Sweep

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/12_FINAL_RELIABILITY_SWEEP.md`

## Audit-specific mission

Perform a final whole-codebase reliability sweep after targeted hardening work has landed.

Do not repeat earlier audits mechanically. Instead search for interactions between previously modified systems and defects that escaped domain-specific review.

Prioritize:
- regressions introduced by hardening changes;
- inconsistent error handling;
- untested repaired paths;
- hidden lifecycle problems;
- data-loss risks;
- timing/race failures;
- broken cleanup;
- invalid assumptions crossing subsystem boundaries;
- flaky or nondeterministic tests;
- production build issues.

Run the broadest safe validation available. Fix only high-confidence issues. Produce a final residual-risk list sorted by severity and likelihood.
